// Minimal GitHub contents-API client. All data stays in the private repo;
// this page only talks to api.github.com with the token saved in Settings.

const API = "https://api.github.com";

export class NetworkError extends Error {}
export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function loadSettings() {
  try {
    return {
      owner: "eason2561",
      repo: "Fitness-Log",
      branch: "",
      token: "",
      ...JSON.parse(localStorage.getItem("fitlog:settings") || "{}"),
    };
  } catch {
    return { owner: "eason2561", repo: "Fitness-Log", branch: "", token: "" };
  }
}

export function saveSettings(s) {
  localStorage.setItem("fitlog:settings", JSON.stringify(s));
}

export function isConfigured(s = loadSettings()) {
  return Boolean(s.token && s.owner && s.repo);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
export const textToBase64 = (text) => bytesToBase64(enc.encode(text));
export const base64ToText = (b64) =>
  dec.decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

async function call(method, path, { body, raw = false, query = "" } = {}) {
  const s = loadSettings();
  if (!isConfigured(s)) throw new GitHubError(0, "Add your GitHub token in Settings first.");
  const url = `${API}/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}${path}${query}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${s.token}`,
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new NetworkError("Can't reach GitHub (offline?)");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).message || msg;
    } catch {}
    if (res.status === 401) msg = "GitHub rejected the token. Check Settings.";
    if (res.status === 404) msg = `Not found (${path}). Check the repo name and token access.`;
    throw new GitHubError(res.status, msg);
  }
  if (res.status === 204) return null;
  return raw ? res.text() : res.json();
}

const refQuery = () => {
  const b = loadSettings().branch;
  return b ? `?ref=${encodeURIComponent(b)}` : "";
};
const contentPath = (p) => `/contents/${p.split("/").map(encodeURIComponent).join("/")}`;

export const repoInfo = () => call("GET", "");

export async function getText(path) {
  const j = await call("GET", contentPath(path), { query: refQuery() });
  return { text: base64ToText(j.content), sha: j.sha };
}

export const getRaw = (path) => call("GET", contentPath(path), { raw: true, query: refQuery() });

export async function putFile(path, base64, message, sha) {
  const branch = loadSettings().branch;
  const body = { message, content: base64, ...(sha ? { sha } : {}), ...(branch ? { branch } : {}) };
  const j = await call("PUT", contentPath(path), { body });
  return j.content.sha;
}

export async function deleteFile(path, sha, message) {
  const branch = loadSettings().branch;
  await call("DELETE", contentPath(path), { body: { message, sha, ...(branch ? { branch } : {}) } });
}

// Start a GitHub Actions workflow (needs the token to have Actions: Read and write).
let defaultBranch = null;
export async function dispatchWorkflow(file, inputs = {}) {
  const s = loadSettings();
  if (!s.branch && !defaultBranch) defaultBranch = (await repoInfo()).default_branch;
  await call("POST", `/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
    body: { ref: s.branch || defaultBranch, inputs },
  });
}

export async function listDir(path) {
  try {
    return await call("GET", contentPath(path), { query: refQuery() });
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return [];
    throw e;
  }
}
