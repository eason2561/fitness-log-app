// One GitHub token for Keep, Fitness Log and Money. The three apps are served from the same
// origin (eason2561.github.io), so they share this browser's localStorage: a token saved in any
// app's Settings is used by all three. Keep this file identical in the Keep, Fitness-Log and
// Money repos.

const KEY = "eason2561:github";
const WARN_DAYS = 14;

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
  for a reminder before it runs out.`;

export function loadShared() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { token: String(s.token || ""), expires: String(s.expires || "") };
  } catch {
    return { token: "", expires: "" };
  }
}

// An empty token removes it, which signs every app on this device out.
export function saveShared({ token = "", expires = "" }) {
  try {
    if (!token) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ token, expires: /^\d{4}-\d{2}-\d{2}$/.test(expires) ? expires : "" }));
  } catch { /* private window: lasts this visit only */ }
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
