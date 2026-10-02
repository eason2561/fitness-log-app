// Offline outbox: writes that couldn't reach GitHub (gym Wi-Fi...) are kept in
// IndexedDB and retried in order when the app opens, comes back online, or on "Sync now".

import { NetworkError, putFile, deleteFile } from "./github.js";

const DB = "fitlog";
const STORE = "outbox";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export const list = () => tx("readonly", (s) => s.getAll());
export const remove = (id) => tx("readwrite", (s) => s.delete(id));
const add = (item) => tx("readwrite", (s) => s.add({ ...item, createdAt: new Date().toISOString() }));
const update = (item) => tx("readwrite", (s) => s.put(item));

async function run(op) {
  if (op.op === "put") return putFile(op.path, op.content, op.message, op.sha);
  if (op.op === "delete") return deleteFile(op.path, op.sha, op.message);
}

// Perform ops now; if GitHub is unreachable, queue them (in order) instead.
// Returns {queued: boolean}. Other GitHub errors are thrown to the caller.
export async function perform(ops) {
  if ((await list()).some((o) => !o.error)) {
    // Keep ordering: if something is already waiting, queue behind it.
    for (const op of ops) await add(op);
    flush().catch(() => {});
    return { queued: true };
  }
  for (let i = 0; i < ops.length; i++) {
    try {
      await run(ops[i]);
    } catch (e) {
      if (e instanceof NetworkError) {
        for (const op of ops.slice(i)) await add(op);
        return { queued: true };
      }
      throw e;
    }
  }
  return { queued: false };
}

let flushing = null;
export function flush() {
  flushing ??= (async () => {
    let sent = 0;
    try {
      for (const op of await list()) {
        if (op.error) continue;
        try {
          await run(op);
          await remove(op.id);
          sent++;
        } catch (e) {
          if (e instanceof NetworkError) break;
          await update({ ...op, error: e.message });
        }
      }
    } finally {
      flushing = null;
    }
    return sent;
  })();
  return flushing;
}
