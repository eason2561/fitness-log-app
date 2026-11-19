// One GitHub token for Keep, Fitness Log and Money. The three apps are served from the same
// origin (eason2561.github.io), so they share this browser's localStorage: a token saved in any
// app's Settings is used by all three. The token's expiry date (never the token) is also kept in
// the Keep repo, meta/github-token.json, so a date entered on one device reaches every device.
// Keep this file identical in the Keep, Fitness-Log and Money repos.

const KEY = "eason2561:github";
const SET_KEY = "eason2561:github-expiry-set"; // when this device's date was last set (ISO time)
const WARN_DAYS = 14;
export const EXPIRY_URL = "https://api.github.com/repos/eason2561/Keep/contents/meta/github-token.json";
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");

export const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new?" + new URLSearchParams({
  name: "Keep, Fitness Log and Money apps",
  description: "Shared token for the Keep, Fitness Log and Money web apps",
  expires_in: "366", contents: "write", actions: "write",
});

// Settings text, the same in every app.
export const TOKEN_HELP = `One token works for all three apps (Keep, Fitness Log and Money) on this device.
  <a href="${NEW_TOKEN_URL}" target="_blank" rel="noopener">Create a fine-grained token</a>:
  <strong>Only select repositories</strong> → Keep, Fitness-Log and Money;
  <strong>Contents: Read and write</strong> and <strong>Actions: Read and write</strong>
  (for Fitness Log's sync buttons); the longest expiry GitHub allows. Save it in your password manager
  with username <strong>eason2561</strong> so it can fill this form, and enter its expiry date below
  for a reminder before it runs out: entered once, it reaches every device.`;

export function loadShared() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { token: String(s.token || ""), expires: String(s.expires || "") };
  } catch {
    return { token: "", expires: "" };
  }
}

// An empty token removes it, which signs every app on this device out. A changed expiry date is
// stamped with the time, so syncExpiry() shares it with the other devices.
export function saveShared({ token = "", expires = "" }) {
  try {
    if (!token) { localStorage.removeItem(KEY); return; }
    const date = isDate(expires) ? expires : "";
    const before = loadShared().expires;
    localStorage.setItem(KEY, JSON.stringify({ token, expires: date }));
    if (date !== before) localStorage.setItem(SET_KEY, new Date().toISOString());
  } catch { /* private window: lasts this visit only */ }
}

function readFile(content) {
  try {
    const j = JSON.parse(atob(String(content || "").replace(/\s/g, "")));
    return { expires: isDate(j.expires) ? j.expires : "", set: String(j.set || "") };
  } catch {
    return { expires: "", set: "" };
  }
}

// Share the expiry date between devices through meta/github-token.json in the Keep repo: the most
// recently set date wins. A device that has a date but finds no file uploads its own. Resolves to
// true when this device's date changed (redraw the banner); network trouble is ignored.
let pending = null;
export function syncExpiry(fetchImpl = globalThis.fetch) {
  pending ??= doSync(fetchImpl).catch(() => false).finally(() => { pending = null; });
  return pending;
}

async function doSync(f) {
  const s = loadShared();
  if (!s.token || typeof f !== "function") return false;
  const headers = { Authorization: `Bearer ${s.token}`, Accept: "application/vnd.github+json" };
  let localSet = "";
  try { localSet = localStorage.getItem(SET_KEY) || ""; } catch { /* no storage */ }
  const res = await f(EXPIRY_URL, { headers, cache: "no-store" });
  if (!res.ok && res.status !== 404) return false;
  const j = res.ok ? await res.json() : {};
  const remote = res.ok ? readFile(j.content) : { expires: "", set: "" };
  if (remote.set && remote.set > localSet) {
    localStorage.setItem(KEY, JSON.stringify({ token: s.token, expires: remote.expires }));
    localStorage.setItem(SET_KEY, remote.set);
    return remote.expires !== s.expires;
  }
  const upload = localSet ? localSet > remote.set : !res.ok && Boolean(s.expires);
  if (!upload) return false;
  const set = localSet || new Date().toISOString();
  const body = JSON.stringify({ expires: s.expires, set }, null, 2) + "\n";
  const put = await f(EXPIRY_URL, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Shared GitHub token expires ${s.expires || "(no date)"} (saved from an app's Settings)`,
      content: btoa(body),
      ...(j.sha ? { sha: j.sha } : {}),
    }),
  });
  if (put.ok) localStorage.setItem(SET_KEY, set);
  return false;
}

// The shared token wins; a token saved by one app before it existed is used until then.
export const resolveToken = (legacy = "") => loadShared().token || legacy || "";

// Whole days from today (local time) until the expiry date; null when there is no date.
export function daysLeft(expires = loadShared().expires, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expires || "");
  if (!m) return null;
  const end = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((end - today) / 86400000);
}

// One line for a banner, or "" when the token isn't close to expiring.
export function expiryNotice(s = loadShared(), now = new Date()) {
  if (!s.token) return "";
  const d = daysLeft(s.expires, now);
  if (d === null || d > WARN_DAYS) return "";
  const what = d < 0 ? `expired on ${s.expires}` : d === 0 ? "expires today" : d === 1 ? "expires tomorrow" : `expires in ${d} days`;
  return `Your GitHub token for Keep, Fitness Log and Money ${what}. Create a new one and save it in Settings (once, for all three apps).`;
}

export const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Banner HTML for the top of a view ("" when not needed). Style .token-banner in the app's CSS.
export function expiryBanner(settingsHref = "#/settings") {
  const text = expiryNotice();
  return text ? `<div class="token-banner" role="alert">${escapeHtml(text)} <a href="${escapeHtml(settingsHref)}">Settings</a></div>` : "";
}
