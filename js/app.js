// Fitness Log web app: view and enter data stored in the private GitHub repo.
// No build step; plain ES modules. js-yaml and Chart.js are vendored globals.

import * as gh from "./github.js";
import * as outbox from "./outbox.js";
import { Catalog, summarize, weekly, weekStart, localIsoDate, slug } from "./totals.js";

// Bump with sw.js VERSION on every app change; shown in Settings so you can tell which version is running.
const APP_VERSION = "2026.10.02-7 (heart-rate charts)";
const yaml = window.jsyaml;
const view = document.getElementById("view");

// ------------------------------------------------------------------ state

const EMPTY_BUNDLE = { workouts: [], measurements: [], weekly: [], exercises: [], templates: [], pending_photos: [] };

function readJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const state = {
  bundle: readJSON("fitlog:bundle", EMPTY_BUNDLE),
  // Saved from this device but not yet in bundle.json (the GitHub Action rebuilds it in ~1 min).
  local: readJSON("fitlog:local", { workouts: {}, deleted: {}, measurements: {}, yaml: {} }),
  loading: false,
  loadError: null,
  charts: [],
  editor: null,
};
let catalog = new Catalog(state.bundle.exercises);

const saveLocal = () => writeJSON("fitlog:local", state.local);

function allWorkouts() {
  const byId = new Map();
  for (const w of state.bundle.workouts) if (!state.local.deleted[w.id]) byId.set(w.id, w);
  for (const [id, w] of Object.entries(state.local.workouts)) {
    byId.set(id, w);
    if (w.links?.polar_exercise_id) byId.delete(`polar-${w.links.polar_exercise_id}`);
  }
  return [...byId.values()].sort((a, b) =>
    (b.date + (b.start || "")).localeCompare(a.date + (a.start || "")));
}

function allMeasurements() {
  const byId = new Map(state.bundle.measurements.map((m) => [m.id, m]));
  for (const [id, m] of Object.entries(state.local.measurements)) byId.set(id, m);
  return [...byId.values()].sort((a, b) => a.taken_at.localeCompare(b.taken_at));
}

// Drop local copies once the rebuilt bundle has caught up (or after a day).
function reconcile() {
  const day = 24 * 3600 * 1000;
  const now = Date.now();
  const inBundle = new Map(state.bundle.workouts.map((w) => [w.id, w]));
  const same = (a, b) => ["date", "start", "title", "total_reps", "volume_lb", "duration_min", "notes", "rpe"]
    .every((k) => (a[k] ?? null) === (b[k] ?? null));
  for (const [id, w] of Object.entries(state.local.workouts)) {
    if ((inBundle.has(id) && same(inBundle.get(id), w)) || now - w.savedAt > day) delete state.local.workouts[id];
  }
  for (const [id, t] of Object.entries(state.local.deleted)) {
    if (!inBundle.has(id) || now - t > day) delete state.local.deleted[id];
  }
  const mIds = new Set(state.bundle.measurements.map((m) => m.id));
  for (const [id, m] of Object.entries(state.local.measurements)) {
    if (mIds.has(id) || now - m.savedAt > day) delete state.local.measurements[id];
  }
  saveLocal();
}

async function loadFallbackConfig() {
  // Before the first GitHub Action build there is no bundle.json yet; read config directly.
  const bundle = { ...EMPTY_BUNDLE };
  const ex = yaml.load(await gh.getRaw("config/exercises.yaml")) || {};
  bundle.exercises = Object.entries(ex).map(([id, e]) => ({ id, ...e }));
  const files = (await gh.listDir("config/templates")).filter((f) => /\.ya?ml$/.test(f.name));
  for (const f of files) {
    const t = yaml.load(await gh.getRaw(f.path));
    bundle.templates.push({ id: f.name.replace(/\.ya?ml$/, ""), name: t.name, description: t.description, workout: t.workout });
  }
  bundle.templates.sort((a, b) => a.name.localeCompare(b.name));
  return bundle;
}

async function refresh({ quiet = false } = {}) {
  if (!gh.isConfigured() || state.loading) return;
  state.loading = true;
  try {
    let bundle;
    try {
      bundle = JSON.parse(await gh.getRaw("data/clean/bundle.json"));
    } catch (e) {
      if (!(e instanceof gh.GitHubError && e.status === 404)) throw e;
      bundle = await loadFallbackConfig();
    }
    state.bundle = { ...EMPTY_BUNDLE, ...bundle };
    state.loadError = null;
    writeJSON("fitlog:bundle", state.bundle);
    writeJSON("fitlog:refreshedAt", Date.now());
    catalog = new Catalog(state.bundle.exercises);
    reconcile();
  } catch (e) {
    state.loadError = e.message;
    if (!quiet) toast(e.message);
  } finally {
    state.loading = false;
  }
  if (!state.editor && !state.hold) route();
}

// ------------------------------------------------------------------ helpers

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, d = 0) => (n == null || n === "" ? "–" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
const pad = (n) => String(n).padStart(2, "0");
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const nowLocal = () => `${localIsoDate()}T${nowTime()}`;
const shortDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const workoutPath = (id) => `data/manual/workouts/${id.slice(0, 4)}/${id}.yaml`;
const repoUrl = (path) => {
  const s = gh.loadSettings();
  return `https://github.com/${s.owner}/${s.repo}/blob/${s.branch || "HEAD"}/${path}`;
};
const toIsoDate = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const randomTag = () => Math.random().toString(36).slice(2, 5);

let toastTimer;
function toast(msg, ms = 3500) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function statLine(w) {
  const parts = [];
  if (w.duration_min) parts.push(`${fmt(w.duration_min, 1)} min`);
  if (w.swings) parts.push(`${fmt(w.swings)} swings`);
  if (w.total_reps && w.total_reps !== w.swings) parts.push(`${fmt(w.total_reps)} reps`);
  if (w.volume_lb) parts.push(`${fmt(w.volume_lb)} lb`);
  for (const c of w.cardio || []) {
    if (c.distance_mi) parts.push(`${fmt(c.distance_mi, 2)} mi`);
    if (c.calories) parts.push(`${fmt(c.calories)} cal`);
  }
  if (w.polar?.avg_hr) parts.push(`avg HR ${w.polar.avg_hr}`);
  if (w.polar?.calories && !(w.cardio || []).some((c) => c.calories)) parts.push(`${fmt(w.polar.calories)} cal`);
  return parts.join(" · ");
}

function workoutItem(w) {
  return `<li><a href="#/workout/${encodeURIComponent(w.id)}">
    <span><strong>${esc(w.title)}</strong> ${w.pending ? '<span class="badge">syncing</span>' : ""}${w.polar ? '<span class="badge">Polar</span>' : ""}<br>
    <span class="meta">${esc(statLine(w))}</span></span>
    <span class="meta num">${shortDate(w.date)}${w.start ? `<br>${esc(w.start)}` : ""}</span></a></li>`;
}

function setupNotice() {
  return gh.isConfigured() ? "" :
    `<div class="notice">Connect this app to your GitHub repo to load and save data. <a href="#/settings">Open Settings</a></div>`;
}

async function updateSyncButton() {
  const btn = document.getElementById("sync-btn");
  let ops = [];
  try { ops = await outbox.list(); } catch {}
  const failed = ops.filter((o) => o.error).length;
  btn.hidden = ops.length === 0;
  btn.textContent = failed ? `${failed} failed — review` : `${ops.length} waiting · Sync`;
  btn.onclick = failed ? () => (location.hash = "#/settings") : () => syncNow();
}

async function syncNow() {
  try {
    const sent = await outbox.flush();
    if (sent) toast(`Synced ${sent} change${sent === 1 ? "" : "s"} to GitHub`);
  } catch (e) {
    toast(e.message);
  }
  updateSyncButton();
}

// ------------------------------------------------------------------ router

const routes = {
  "": renderHome,
  new: renderNew,
  edit: renderEditor,
  workout: renderWorkout,
  history: renderHistory,
  progress: renderProgress,
  measure: renderMeasure,
  photo: renderPhoto,
  settings: renderSettings,
};

function route() {
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const [name, ...rest] = path.split("/");
  const params = Object.fromEntries(new URLSearchParams(query || ""));
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
  if (name !== "edit") state.editor = null;
  const tab = { "": "home", workout: "history", measure: "home", photo: "home", edit: "new" }[name] ?? name;
  document.querySelectorAll(".tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  (routes[name] || renderHome)(params, rest.map(decodeURIComponent));
  updateSyncButton();
}

window.addEventListener("hashchange", () => {
  state.hold = false;
  route();
  window.scrollTo(0, 0);
});

// ------------------------------------------------------------------ home

function renderHome() {
  const ws = allWorkouts();
  const thisWeek = weekStart(localIsoDate());
  const lastWeekDate = new Date(`${thisWeek}T12:00:00`);
  lastWeekDate.setDate(lastWeekDate.getDate() - 7);
  const lastWeek = localIsoDate(lastWeekDate);
  const weeks = weekly(ws);
  const cur = weeks.find((w) => w.week === thisWeek) || { sessions: 0, swings: 0, volume_lb: 0, minutes: 0 };
  const prev = weeks.find((w) => w.week === lastWeek) || { sessions: 0, swings: 0, volume_lb: 0, minutes: 0 };
  const tile = (label, v, p, d = 0) =>
    `<div class="tile"><div class="label">${label}</div><div class="value">${fmt(v, d)}</div><div class="delta">Last week ${fmt(p, d)}</div></div>`;
  const bp = allMeasurements().filter((m) => m.kind === "blood_pressure").at(-1);
  const photos = state.bundle.pending_photos || [];

  view.innerHTML = `
    ${setupNotice()}
    ${state.loadError ? `<div class="notice error">${esc(state.loadError)}</div>` : ""}
    <h1>This week</h1>
    <div class="grid-tiles">
      ${tile("Sessions", cur.sessions, prev.sessions)}
      ${tile("Minutes", cur.minutes, prev.minutes)}
      ${tile("Swings", cur.swings, prev.swings)}
      ${tile("Volume (lb)", cur.volume_lb, prev.volume_lb)}
    </div>
    <div class="big-actions">
      <a class="btn primary" href="#/new">Log workout</a>
      <a class="btn" href="#/photo">Life Fitness photo</a>
      <a class="btn" href="#/measure">BP / weight / fasting</a>
    </div>
    ${bp ? `<div class="card spread"><span><span class="secondary small">Latest blood pressure</span><br>
      <strong class="num">${bp.systolic}/${bp.diastolic}</strong>${bp.pulse ? ` <span class="muted">· pulse ${bp.pulse}</span>` : ""}</span>
      <span class="meta">${esc(bp.taken_at.replace("T", " "))}</span></div>` : ""}
    ${photos.length ? `<div class="notice">${photos.length} Life Fitness photo${photos.length === 1 ? "" : "s"} waiting to be read.</div>` : ""}
    <h2>Recent workouts</h2>
    <div class="card">${ws.length ? `<ul class="list">${ws.slice(0, 6).map(workoutItem).join("")}</ul>` :
      `<p class="muted">No workouts yet. Tap <strong>Log workout</strong> to add one.</p>`}</div>`;
}

// ------------------------------------------------------------------ new workout (template picker)

function renderNew() {
  const ws = allWorkouts();
  const seen = new Set();
  const recent = ws.filter((w) => w.type !== "cardio" && w.source !== "polar" && !seen.has(w.title) && seen.add(w.title)).slice(0, 3);
  view.innerHTML = `
    ${setupNotice()}
    <h1>Log a workout</h1>
    ${recent.length ? `<h2>Repeat a recent workout</h2><div class="template-list">
      ${recent.map((w) => `<button data-go="#/edit?repeat=${encodeURIComponent(w.id)}">
        <span><strong>${esc(w.title)}</strong><span class="desc">${shortDate(w.date)} · ${esc(statLine(w))}</span></span><span>›</span></button>`).join("")}
      </div>` : ""}
    <h2>Start from a template</h2>
    <div class="template-list">
      ${state.bundle.templates.map((t) => `<button data-go="#/edit?tpl=${encodeURIComponent(t.id)}">
        <span><strong>${esc(t.name)}</strong><span class="desc">${esc(t.description || "")}</span></span><span>›</span></button>`).join("") ||
        `<p class="muted">Templates load from config/templates once Settings are filled in.</p>`}
      <button data-go="#/edit"><span><strong>Blank workout</strong><span class="desc">Build it from scratch</span></span><span>›</span></button>
    </div>`;
}

view.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]");
  if (go) location.hash = go.dataset.go;
});

// ------------------------------------------------------------------ workout editor

const DRAFT_KEY = "fitlog:draft";
const EVERY_OPTIONS = [30, 45, 60, 90, 120, 150, 180, 240, 300];
const MACHINES = ["treadmill", "elliptical", "upright_bike", "recumbent_bike", "stair_climber", "rower", "outdoor_walk", "other"];
const CARDIO_FIELDS = [
  ["duration_min", "Duration (min)", "float"], ["distance_mi", "Distance (mi)", "float"],
  ["calories", "Calories", "float"], ["avg_hr", "Avg heart rate", "int"], ["max_hr", "Max heart rate", "int"],
  ["avg_speed_mph", "Avg speed (mph)", "float"], ["incline_pct", "Incline (%)", "float"], ["level", "Level", "float"],
  ["floors", "Floors", "float"], ["avg_watts", "Avg watts", "float"],
];

function lastWeightFor(exId) {
  for (const w of allWorkouts()) {
    const e = w.exercises?.[exId];
    if (e?.max_weight_lb) return e.max_weight_lb;
  }
  return null;
}

function newBlock(kind) {
  if (kind === "interval") {
    return { kind, every_sec: 60, rounds: 20, mode: "rotate",
      stations: [{ exercise: "kb_swing", reps: 15, weight: lastWeightFor("kb_swing") }] };
  }
  if (kind === "sets") return { kind, exercise: "", sets: [{ reps: null, weight: null }] };
  return { kind: "cardio", machine: "treadmill" };
}

function normalizeLoaded(w) {
  w.date = toIsoDate(w.date);
  if (typeof w.start === "number") w.start = `${pad(Math.floor(w.start / 60))}:${pad(w.start % 60)}`;
  w.blocks ||= [];
  return w;
}

async function renderEditor(params) {
  view.innerHTML = `<p class="muted">Loading…</p>`;
  const key = JSON.stringify(params);
  const saved = readJSON(DRAFT_KEY, null);
  let draft;
  let origin = { path: null, sha: null };
  let restored = false;
  try {
    if (params.id) {
      const path = workoutPath(params.id);
      const { text, sha } = await gh.getText(path);
      draft = normalizeLoaded(yaml.load(text));
      origin = { path, sha };
    } else if (params.repeat) {
      const text = state.local.yaml[params.repeat] ?? (await gh.getText(workoutPath(params.repeat))).text;
      const src = normalizeLoaded(yaml.load(text));
      draft = { ...src, date: localIsoDate(), start: nowTime(), rpe: null, notes: null, links: null };
      for (const b of draft.blocks) if (b.kind === "interval") delete b.rounds_completed;
    } else if (params.tpl) {
      const t = state.bundle.templates.find((x) => x.id === params.tpl);
      if (!t) throw new Error(`Template ${params.tpl} not found`);
      draft = { date: localIsoDate(), start: nowTime(), ...structuredClone(t.workout), template: t.id };
    } else if (params.polar) {
      const p = allWorkouts().find((x) => x.polar?.polar_id === params.polar);
      if (!p) throw new Error("That Polar session isn't loaded yet. Reload data and try again.");
      draft = { date: p.date, start: p.start, type: p.type === "cardio" ? "cardio" : "kettlebell", title: "",
        links: { polar_exercise_id: params.polar },
        blocks: [newBlock(p.type === "cardio" ? "cardio" : "interval")] };
      if (/WALK|HIK/.test(p.polar.sport || "")) draft.blocks[0].machine = "outdoor_walk";
    } else if (params.photo) {
      draft = { date: params.date || localIsoDate(), start: params.start || nowTime(), type: "cardio", title: "Cardio",
        source: "life_fitness_photo", links: { photo: params.photo }, blocks: [newBlock("cardio")] };
    } else {
      draft = { date: localIsoDate(), start: nowTime(), type: "kettlebell", blocks: [newBlock("interval")] };
    }
  } catch (e) {
    view.innerHTML = `<div class="notice error">${esc(e.message)}</div><a href="#/new">Back</a>`;
    return;
  }
  if (saved && saved.key === key) {
    draft = saved.draft;
    restored = true;
  }
  draft.unit ||= "lb";
  state.editor = { key, draft, origin, restored };
  drawEditor();
}

function drawEditor() {
  const { draft: d, origin, restored } = state.editor;
  const unit = d.unit || "lb";
  const opt = (v, cur, label = v) => `<option value="${esc(v)}" ${String(cur ?? "") === String(v) ? "selected" : ""}>${esc(label)}</option>`;
  const exOptions = catalog.byId.size
    ? [...catalog.byId.values()].map((e) => `<option value="${esc(e.name)}"></option>`).join("") : "";
  const exValue = (v) => esc(catalog.resolve(v) ? catalog.name(catalog.resolve(v)) : v || "");
  const num = (path, v, type = "int", attrs = "") =>
    `<input type="number" ${type === "int" ? 'inputmode="numeric" step="1"' : 'inputmode="decimal" step="any"'} min="0" data-path="${path}" data-type="${type}" value="${v ?? ""}" ${attrs}>`;

  const effortOpts = (p, s) => `<div class="opts">
      <label class="check"><input type="checkbox" data-path="${p}.per_side" data-type="bool" ${s.per_side ? "checked" : ""}> Per side</label>
      <label class="check"><input type="checkbox" data-path="${p}.bells" data-type="bells" ${s.bells === 2 ? "checked" : ""}> 2 bells</label></div>`;

  const blockHTML = (b, i) => {
    const head = (title) => `<div class="block-head"><span class="block-kind">${title}</span>
      <button class="icon" data-action="remove-block" data-i="${i}" aria-label="Remove block">✕</button></div>`;
    if (b.kind === "interval") {
      const everyOpts = [...new Set([...EVERY_OPTIONS, b.every_sec])].sort((x, y) => x - y)
        .map((s) => opt(s, b.every_sec, s % 60 === 0 ? `${s / 60} min` : s > 60 ? `${Math.floor(s / 60)}:${pad(s % 60)} min` : `${s} sec`)).join("");
      return `<div class="card block">${head("Intervals (EMOM)")}
        <div class="grid-3">
          <label>Every<select data-path="blocks.${i}.every_sec" data-type="int">${everyOpts}</select></label>
          <label>Rounds${num(`blocks.${i}.rounds`, b.rounds, "int", 'min="1"')}</label>
          <label>Completed${num(`blocks.${i}.rounds_completed`, b.rounds_completed, "int", 'placeholder="all"')}</label>
        </div>
        <p class="field-hint" data-hint="${i}"></p>
        <div class="segmented" role="group" aria-label="Interval mode">
          <button type="button" data-action="mode" data-i="${i}" data-mode="rotate" aria-pressed="${b.mode !== "circuit"}">Alternate</button>
          <button type="button" data-action="mode" data-i="${i}" data-mode="circuit" aria-pressed="${b.mode === "circuit"}">All each round</button>
        </div>
        <p class="field-hint">${b.mode === "circuit" ? "Every exercise below is done in each interval, then rest." : "One exercise per interval, cycling through the list in order."}</p>
        ${b.stations.map((s, j) => `<div class="station"><div class="idx">${j + 1}</div><div class="fields">
            <label class="wide">Exercise<input list="exercise-list" data-path="blocks.${i}.stations.${j}.exercise" value="${exValue(s.exercise)}" autocomplete="off"></label>
            <label>Reps${num(`blocks.${i}.stations.${j}.reps`, s.reps)}</label>
            <label>Weight (${unit})${num(`blocks.${i}.stations.${j}.weight`, s.weight, "float")}</label>
            ${effortOpts(`blocks.${i}.stations.${j}`, s)}</div>
            <button class="icon" data-action="remove-station" data-i="${i}" data-j="${j}" aria-label="Remove exercise" ${b.stations.length < 2 ? "disabled" : ""}>✕</button></div>`).join("")}
        <button class="ghost" data-action="add-station" data-i="${i}">+ Add exercise</button></div>`;
    }
    if (b.kind === "sets") {
      return `<div class="card block">${head("Sets")}
        <label>Exercise<input list="exercise-list" data-path="blocks.${i}.exercise" value="${exValue(b.exercise)}" autocomplete="off"></label>
        <div class="row">${effortOpts(`blocks.${i}`, b).replace('class="opts"', 'class="opts row"')}</div>
        <div class="set-row small secondary"><span></span><span>Reps</span><span>Weight (${unit})</span><span></span></div>
        ${b.sets.map((s, j) => `<div class="set-row"><span class="muted">${j + 1}</span>
          ${num(`blocks.${i}.sets.${j}.reps`, s.reps)}${num(`blocks.${i}.sets.${j}.weight`, s.weight ?? "", "float", `placeholder="${b.weight ?? ""}"`)}
          <button class="icon" data-action="remove-set" data-i="${i}" data-j="${j}" aria-label="Remove set" ${b.sets.length < 2 ? "disabled" : ""}>✕</button></div>`).join("")}
        <button class="ghost" data-action="add-set" data-i="${i}">+ Add set</button></div>`;
    }
    return `<div class="card block">${head("Cardio")}
      <label>Machine<select data-path="blocks.${i}.machine">${[...new Set([...MACHINES, b.machine])].map((m) => opt(m, b.machine, m.replace(/_/g, " "))).join("")}</select></label>
      <div class="grid-2">${CARDIO_FIELDS.map(([k, label, t]) => `<label>${label}${num(`blocks.${i}.${k}`, b[k], t)}</label>`).join("")}</div></div>`;
  };

  view.innerHTML = `
    <h1>${origin.path ? "Edit workout" : "Log workout"}</h1>
    ${restored ? `<div class="notice spread"><span>Restored your unsaved changes.</span><button class="ghost" data-action="discard">Discard</button></div>` : ""}
    <div class="card stack">
      <div class="grid-2">
        <label>Date<input type="date" data-path="date" value="${esc(d.date)}" required></label>
        <label>Start<input type="time" data-path="start" value="${esc(d.start || "")}"></label>
      </div>
      <label>Title<input data-path="title" value="${esc(d.title || "")}" placeholder="e.g. KB EMOM swings / squats"></label>
      <div class="grid-3">
        <label>Type<select data-path="type">${["kettlebell", "strength", "cardio", "mixed", "other"].map((t) => opt(t, d.type)).join("")}</select></label>
        <label>Units<select data-path="unit" data-rerender>${opt("lb", unit)}${opt("kg", unit)}</select></label>
        <label>Effort (RPE)<select data-path="rpe" data-type="float">${opt("", d.rpe, "–")}${[...Array(10)].map((_, k) => opt(k + 1, d.rpe)).join("")}</select></label>
      </div>
    </div>
    ${d.blocks.map(blockHTML).join("")}
    <div class="row">
      <button data-action="add-block" data-kind="interval">+ Intervals</button>
      <button data-action="add-block" data-kind="sets">+ Sets</button>
      <button data-action="add-block" data-kind="cardio">+ Cardio</button>
    </div>
    <div class="card"><label>Notes<textarea data-path="notes" placeholder="How did it feel?">${esc(d.notes || "")}</textarea></label></div>
    ${d.links?.photo ? `<p class="small muted">Linked photo: ${esc(d.links.photo)}</p>` : ""}
    ${d.links?.polar_exercise_id ? `<p class="small muted">Linked to Polar session ${esc(d.links.polar_exercise_id)}: its heart rate and calories will show with this workout.</p>` : ""}
    <div class="summary-bar"><div class="stats" id="live-summary"></div>
      <div class="row">${origin.path ? `<a class="btn" href="#/workout/${encodeURIComponent(origin.path.split("/").pop().replace(".yaml", ""))}">Cancel</a>` : ""}
      <button class="primary" data-action="save">Save</button></div></div>
    <datalist id="exercise-list">${exOptions}</datalist>`;
  updateLive();
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  const last = keys.at(-1);
  if (value === null || value === undefined) delete o[last];
  else o[last] = value;
}

function readInput(el) {
  const t = el.dataset.type;
  if (t === "bool") return el.checked ? true : null;
  if (t === "bells") return el.checked ? 2 : null;
  if (el.value === "") return null;
  if (t === "int") return Number.isFinite(parseInt(el.value, 10)) ? parseInt(el.value, 10) : null;
  if (t === "float") return Number.isFinite(parseFloat(el.value)) ? parseFloat(el.value) : null;
  return el.value;
}

function persistDraft() {
  const { key, draft } = state.editor;
  writeJSON(DRAFT_KEY, { key, draft });
}

function updateLive() {
  const ed = state.editor;
  if (!ed) return;
  let s;
  try {
    s = summarize("draft", toWorkout(ed.draft), catalog);
  } catch {
    return;
  }
  const el = document.getElementById("live-summary");
  if (el) el.textContent = statLine(s) || "Fill in the details";
  ed.draft.blocks.forEach((b, i) => {
    const hint = view.querySelector(`[data-hint="${i}"]`);
    if (!hint || b.kind !== "interval") return;
    const done = b.rounds_completed ?? b.rounds ?? 0;
    const mins = (done * (b.every_sec || 60)) / 60;
    const n = b.stations.length;
    const per = b.mode === "circuit" ? `each exercise ${done}×` : n > 1 ? `each exercise ~${fmt(done / n, 1)}×` : "";
    hint.textContent = `${fmt(mins, 1)} min${per ? ` · ${per}` : ""}`;
  });
}

view.addEventListener("input", (e) => {
  const el = e.target.closest("[data-path]");
  if (!el || !state.editor) return;
  setPath(state.editor.draft, el.dataset.path, readInput(el));
  persistDraft();
  updateLive();
});

view.addEventListener("change", (e) => {
  const el = e.target.closest("[data-path]");
  if (!el || !state.editor) return;
  setPath(state.editor.draft, el.dataset.path, readInput(el));
  persistDraft();
  if (el.hasAttribute("data-rerender")) drawEditor();
  else updateLive();
});

view.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || !state.editor) return;
  const d = state.editor.draft;
  const i = Number(btn.dataset.i);
  const j = Number(btn.dataset.j);
  switch (btn.dataset.action) {
    case "add-block": d.blocks.push(newBlock(btn.dataset.kind)); break;
    case "remove-block":
      if (!confirm("Remove this block?")) return;
      d.blocks.splice(i, 1);
      break;
    case "mode": d.blocks[i].mode = btn.dataset.mode; break;
    case "add-station": {
      const prev = d.blocks[i].stations.at(-1) || {};
      d.blocks[i].stations.push({ exercise: "", reps: prev.reps ?? null, weight: prev.weight ?? null });
      break;
    }
    case "remove-station": d.blocks[i].stations.splice(j, 1); break;
    case "add-set": d.blocks[i].sets.push({ ...(d.blocks[i].sets.at(-1) || {}) }); break;
    case "remove-set": d.blocks[i].sets.splice(j, 1); break;
    case "discard":
      localStorage.removeItem(DRAFT_KEY);
      route();
      return;
    case "save":
      await saveWorkout(btn);
      return;
    default: return;
  }
  persistDraft();
  drawEditor();
});

// Clean the draft into the YAML document that gets committed (same schema as models.py).
function toWorkout(d) {
  const clean = (o) => {
    if (Array.isArray(o)) return o.map(clean);
    if (o && typeof o === "object") {
      const out = {};
      for (const [k, v] of Object.entries(o)) {
        if (v === null || v === undefined || v === "" || v === false) continue;
        const c = clean(v);
        if (c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length === 0) continue;
        out[k] = c;
      }
      return out;
    }
    return typeof o === "string" ? o.trim() : o;
  };
  const exId = (x) => catalog.resolve(x || "") || (x || "").trim();
  const blocks = (d.blocks || []).map((b) => {
    if (b.kind === "interval") {
      return { kind: "interval", name: b.name, every_sec: b.every_sec || 60, rounds: b.rounds,
        rounds_completed: b.rounds_completed, mode: b.mode === "circuit" ? "circuit" : undefined,
        stations: b.stations.map((s) => ({ ...s, exercise: exId(s.exercise) })) };
    }
    if (b.kind === "sets") return { ...b, exercise: exId(b.exercise) };
    return b;
  });
  return clean({
    date: d.date, start: d.start, type: d.type, title: d.title, unit: d.unit === "kg" ? "kg" : undefined,
    template: d.template, duration_min: d.duration_min, rpe: d.rpe, notes: d.notes,
    source: d.source && d.source !== "manual" ? d.source : undefined, links: d.links, blocks,
  });
}

function validateWorkout(w) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w.date || "")) return "Pick a date.";
  if (!w.blocks?.length) return "Add at least one block.";
  for (const [i, b] of w.blocks.entries()) {
    const n = `Block ${i + 1}`;
    if (b.kind === "interval") {
      if (!(b.rounds > 0)) return `${n}: enter the number of rounds.`;
      if (b.rounds_completed > b.rounds) return `${n}: completed rounds can't exceed planned rounds.`;
      if (b.stations.some((s) => !s.exercise)) return `${n}: every station needs an exercise.`;
    }
    if (b.kind === "sets" && !b.exercise) return `${n}: choose an exercise.`;
    if (b.kind === "cardio" && !b.machine) return `${n}: choose a machine.`;
  }
  return null;
}

async function saveWorkout(btn) {
  const ed = state.editor;
  const w = toWorkout(ed.draft);
  const problem = validateWorkout(w);
  if (problem) return toast(problem);
  const label = (slug(w.title || w.template || w.type || "workout").replace(/_/g, "-").slice(0, 40) || "workout").replace(/-+$/, "");
  const hhmm = (w.start || "0000").replace(":", "");
  const id = `${w.date}-${hhmm}-${label}`;
  const path = workoutPath(id);
  const text = yaml.dump(w, { flowLevel: 4, lineWidth: 120 });
  const verb = ed.origin.path ? "Update" : "Log";
  const message = `${verb} workout ${w.date} ${w.title || ""} (app)`.trim();
  const ops = [];
  if (ed.origin.path === path) {
    ops.push({ op: "put", path, content: gh.textToBase64(text), sha: ed.origin.sha, message });
  } else {
    ops.push({ op: "put", path, content: gh.textToBase64(text), message });
    if (ed.origin.path) ops.push({ op: "delete", path: ed.origin.path, sha: ed.origin.sha, message: `Move workout to ${id} (app)` });
  }
  btn.disabled = true;
  try {
    const { queued } = await outbox.perform(ops);
    if (ed.origin.path && ed.origin.path !== path) {
      const oldId = ed.origin.path.split("/").pop().replace(/\.ya?ml$/, "");
      state.local.deleted[oldId] = Date.now();
      delete state.local.workouts[oldId];
    }
    state.local.workouts[id] = { ...summarize(id, w, catalog), savedAt: Date.now() };
    state.local.yaml[id] = text;
    const keep = Object.keys(state.local.yaml).slice(-20);
    state.local.yaml = Object.fromEntries(keep.map((k) => [k, state.local.yaml[k]]));
    saveLocal();
    localStorage.removeItem(DRAFT_KEY);
    state.editor = null;
    toast(queued ? "Saved on this device; will sync when online." : "Saved to GitHub.");
    location.hash = `#/workout/${encodeURIComponent(id)}`;
  } catch (e) {
    btn.disabled = false;
    toast(e.status === 422 ? "A workout with this date, time and title already exists. Change the start time or title." : e.message, 6000);
  }
}

// ------------------------------------------------------------------ workout detail

// Heart rate over time for a Polar session (data/clean/hr/<id>.json, 5-second averages).
const hrCache = new Map();

function hrCardHTML() {
  return `<h2>Heart rate</h2><div class="card" id="hr-card"><p class="small muted">Loading heart rate…</p></div>`;
}

async function drawHr(pl) {
  const card = document.getElementById("hr-card");
  let d = hrCache.get(pl.hr_file);
  try {
    if (!d) {
      d = JSON.parse(await gh.getRaw(pl.hr_file));
      hrCache.set(pl.hr_file, d);
    }
  } catch (e) {
    if (card) card.innerHTML = `<p class="small muted">${e instanceof gh.NetworkError ? "The heart-rate chart needs a connection." : esc(e.message)}</p>`;
    return;
  }
  if (!card || !card.isConnected) return; // navigated away while loading
  const c = themeColors();
  const pts = d.bpm.map((v, i) => ({ x: (i * d.step_s) / 60, y: v }));
  const vals = d.bpm.filter((v) => v != null);
  const clock = (min) => { const t = Math.round(min * 60); return `${Math.floor(t / 60)}:${pad(t % 60)}`; };
  const counted = d.zone_seconds.reduce((a, b) => a + b, 0) + (d.below_zones_s || 0);
  const mm = (sec) => `${Math.floor(sec / 60)}:${pad(Math.round(sec % 60))}`;
  const pct = (sec) => (counted ? `${Math.round((100 * sec) / counted)}%` : "–");
  const zoneRows = d.zones.map(([lo, hi], i) => [`Zone ${i + 1}`, `${lo}–${hi}`, mm(d.zone_seconds[i]), pct(d.zone_seconds[i])]);
  if (d.below_zones_s) zoneRows.unshift(["Below zone 1", `< ${d.zones[0][0]}`, mm(d.below_zones_s), pct(d.below_zones_s)]);
  const perMinute = [];
  pts.forEach((p) => {
    const m = Math.floor(p.x);
    if (p.y == null) return;
    (perMinute[m] ??= []).push(p.y);
  });
  card.innerHTML = `<p class="small muted">Avg ${esc(pl.avg_hr ?? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length))} ·
      max ${esc(pl.max_hr ?? Math.max(...vals))} bpm</p>
    <div class="chart-box"><canvas id="c-hr" role="img" aria-label="Heart rate over time"></canvas></div>
    ${d.zones.length ? `<h3 class="hr-zones-title">Time in heart-rate zones</h3><div class="table-wrap"><table><thead><tr><th>Zone</th>
      <th class="r">bpm</th><th class="r">Time</th><th class="r">Share</th></tr></thead><tbody>${zoneRows.map((r) =>
      `<tr><td>${esc(r[0])}</td><td class="r">${esc(r[1])}</td><td class="r">${esc(r[2])}</td><td class="r">${esc(r[3])}</td></tr>`).join("")}</tbody></table></div>` : ""}
    <details><summary>Show minute-by-minute table</summary><div class="table-wrap"><table><thead><tr><th>Minute</th><th class="r">Avg bpm</th></tr></thead>
      <tbody>${perMinute.map((v, m) => v ? `<tr><td>${m}–${m + 1}</td><td class="r">${Math.round(v.reduce((a, b) => a + b, 0) / v.length)}</td></tr>` : "").join("")}</tbody></table></div></details>`;
  const o = baseOptions(c);
  o.scales.x = { ...o.scales.x, type: "linear", min: 0, max: pts.length ? pts.at(-1).x : 1,
    ticks: { ...o.scales.x.ticks, callback: (v) => `${Math.round(v)} min` } };
  o.scales.y.beginAtZero = false;
  o.plugins.tooltip.callbacks = { title: (items) => clock(items[0].parsed.x), label: (ctx) => `${ctx.parsed.y} bpm` };
  const line = { ...lineDataset(c, "Heart rate (bpm)", pts, c.s1), pointRadius: 0, pointHoverRadius: 4, spanGaps: false };
  addChart("c-hr", { type: "line", data: { datasets: [line] }, options: o });
}

function renderWorkout(_params, [id]) {
  const w = allWorkouts().find((x) => x.id === id);
  if (!w) {
    view.innerHTML = `<div class="notice">Workout not found. It may have been deleted.</div><a href="#/history">Back to history</a>`;
    return;
  }
  const exRows = Object.entries(w.exercises || {}).map(([ex, d]) => `<tr><td>${esc(catalog.name(ex))}</td>
      <td class="r">${fmt(d.total_reps)}</td><td class="r">${d.max_weight_lb == null ? "–" : fmt(d.max_weight_lb, 1)}</td>
      <td class="r">${fmt(d.volume_lb)}</td></tr>`).join("");
  const cardio = (w.cardio || []).map((c) => `<div class="card"><h3>${esc((c.machine || "cardio").replace(/_/g, " "))}</h3>
      <table>${Object.entries(c).filter(([k]) => k !== "machine" && k !== "metrics").map(([k, v]) =>
        `<tr><th>${esc(k.replace(/_/g, " "))}</th><td class="r">${esc(v)}</td></tr>`).join("")}</table></div>`).join("");
  const pl = w.polar;
  const polarRows = pl ? [["Sport", (pl.detailed_sport || pl.sport || "").replace(/_/g, " ").toLowerCase()],
    ["Duration", pl.duration_min != null ? `${fmt(pl.duration_min, 1)} min` : null],
    ["Avg heart rate", pl.avg_hr], ["Max heart rate", pl.max_hr], ["Calories", pl.calories != null ? fmt(pl.calories) : null],
    ["Training load", pl.training_load != null ? fmt(pl.training_load, 1) : null],
    ["Distance", pl.distance_mi != null ? `${fmt(pl.distance_mi, 2)} mi` : null], ["Note", pl.note], ["Device", pl.device]]
    .filter(([, v]) => v != null && v !== "") : [];
  const polarCard = pl ? `<h2>Polar</h2><div class="card"><table>${polarRows.map(([k, v]) =>
    `<tr><th>${esc(k)}</th><td class="r">${esc(v)}</td></tr>`).join("")}</table></div>` : "";
  if (w.source === "polar") {
    view.innerHTML = `
      <h1>${esc(w.title)} <span class="badge">Polar</span></h1>
      <p class="secondary">${longDate(w.date)}${w.start ? ` · ${esc(w.start)}` : ""}</p>
      ${polarCard}
      ${pl.hr_file ? hrCardHTML() : ""}
      <p class="small muted">Recorded with Polar. Add the sets or machine numbers and they'll be saved together with this session.</p>
      <div class="row"><a class="btn primary" href="#/edit?polar=${encodeURIComponent(pl.polar_id)}">Add workout details</a></div>`;
    if (pl.hr_file) drawHr(pl);
    return;
  }
  view.innerHTML = `
    <h1>${esc(w.title)} ${w.pending ? '<span class="badge">syncing</span>' : ""}</h1>
    <p class="secondary">${longDate(w.date)}${w.start ? ` · ${esc(w.start)}` : ""}${w.rpe ? ` · RPE ${esc(w.rpe)}` : ""}</p>
    <div class="grid-tiles">
      <div class="tile"><div class="label">Minutes</div><div class="value">${fmt(w.duration_min, 1)}</div></div>
      <div class="tile"><div class="label">Swings</div><div class="value">${fmt(w.swings)}</div></div>
      <div class="tile"><div class="label">Total reps</div><div class="value">${fmt(w.total_reps)}</div></div>
      <div class="tile"><div class="label">Volume (lb)</div><div class="value">${fmt(w.volume_lb)}</div></div>
    </div>
    ${exRows ? `<h2>Exercises</h2><div class="card table-wrap"><table><thead><tr><th>Exercise</th><th class="r">Reps</th>
      <th class="r">Heaviest (lb)</th><th class="r">Volume (lb)</th></tr></thead><tbody>${exRows}</tbody></table></div>` : ""}
    ${cardio}
    ${polarCard}
    ${pl?.hr_file ? hrCardHTML() : ""}
    ${w.notes ? `<h2>Notes</h2><div class="card">${esc(w.notes)}</div>` : ""}
    <div class="row">
      <a class="btn" href="#/edit?id=${encodeURIComponent(w.id)}">Edit</a>
      <a class="btn" href="#/edit?repeat=${encodeURIComponent(w.id)}">Repeat today</a>
      <button class="danger" id="del-btn">Delete</button>
      <a class="btn" href="${esc(repoUrl(workoutPath(w.id)))}" target="_blank" rel="noopener">View file on GitHub</a>
    </div>`;
  if (pl?.hr_file) drawHr(pl);
  document.getElementById("del-btn").onclick = async (e) => {
    if (!confirm(`Delete "${w.title}" on ${w.date}? This removes the file from the repo (git history keeps a copy).`)) return;
    e.target.disabled = true;
    try {
      const path = workoutPath(w.id);
      const { sha } = await gh.getText(path);
      await outbox.perform([{ op: "delete", path, sha, message: `Delete workout ${w.id} (app)` }]);
      state.local.deleted[w.id] = Date.now();
      delete state.local.workouts[w.id];
      saveLocal();
      toast("Deleted.");
      location.hash = "#/history";
    } catch (err) {
      e.target.disabled = false;
      toast(err instanceof gh.NetworkError ? "Deleting needs a connection." : err.message);
    }
  };
}

// ------------------------------------------------------------------ history

function renderHistory(params) {
  const tab = params.tab || "workouts";
  const seg = (t, label) => `<button data-go="#/history?tab=${t}" aria-pressed="${tab === t}">${label}</button>`;
  let body = "";
  if (tab === "workouts") {
    const ws = allWorkouts();
    const months = new Map();
    for (const w of ws) {
      const k = w.date.slice(0, 7);
      if (!months.has(k)) months.set(k, []);
      months.get(k).push(w);
    }
    body = [...months.entries()].map(([m, list]) => `<h2>${new Date(`${m}-15T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}
      <span class="muted small">· ${list.length} workout${list.length === 1 ? "" : "s"}</span></h2>
      <div class="card"><ul class="list">${list.map(workoutItem).join("")}</ul></div>`).join("") ||
      `<div class="card muted">No workouts yet.</div>`;
  } else if (tab === "measurements") {
    const ms = allMeasurements().slice().reverse();
    const desc = (m) => m.kind === "blood_pressure" ? `${m.systolic}/${m.diastolic}${m.pulse ? ` · pulse ${m.pulse}` : ""}`
      : m.kind === "weight" ? `${fmt(m.weight_lb, 1)} lb${m.body_fat_pct ? ` · ${m.body_fat_pct}% fat` : ""}`
      : m.kind === "fasting" ? `Fasted${m.hours ? ` ${fmt(m.hours, 1)} h` : ""}` : `${m.bpm} bpm`;
    const kindName = { blood_pressure: "Blood pressure", weight: "Weight", resting_hr: "Resting HR", fasting: "Fasting day" };
    body = `<div class="card">${ms.length ? `<ul class="list">${ms.map((m) => `<li><div class="item">
      <span><strong class="num">${esc(desc(m))}</strong><br><span class="meta">${kindName[m.kind] || esc(m.kind)}${m.notes ? ` · ${esc(m.notes)}` : ""}</span></span>
      <span class="meta num">${esc(m.kind === "fasting" ? m.taken_at.slice(0, 10) : m.taken_at.replace("T", " "))}</span></div></li>`).join("")}</ul>` : `<p class="muted">No measurements yet.</p>`}</div>
      <a class="btn" href="#/measure">Add a reading</a>`;
  } else {
    const ps = state.bundle.pending_photos || [];
    body = `<div class="card">${ps.length ? `<ul class="list">${ps.map((p) => `<li><div class="item">
      <span>${esc((p.machine || "photo").replace(/_/g, " "))}${p.note ? ` · ${esc(p.note)}` : ""}<br><span class="meta">${esc(p.path)}</span></span>
      <span class="meta">${esc(String(p.captured_at || "").replace("T", " "))}</span></div></li>`).join("")}</ul>` :
      `<p class="muted">No photos waiting. Photos you take are read into workouts automatically once photo reading is set up.</p>`}</div>`;
  }
  view.innerHTML = `<h1>History</h1>
    <div class="segmented" role="group" aria-label="History type">${seg("workouts", "Workouts")}${seg("measurements", "Measurements")}${seg("photos", "Photos")}</div>
    ${body}`;
}

// ------------------------------------------------------------------ progress (charts)

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { s1: v("--series-1"), s2: v("--series-2"), grid: v("--grid"), axis: v("--axis"), muted: v("--muted"),
    ink2: v("--ink-2"), surface: v("--surface"), ink: v("--ink") };
}

function baseOptions(c, { legend = false, yTitle } = {}) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: legend, position: "top", align: "start",
        labels: { color: c.ink2, usePointStyle: true, boxWidth: 8, boxHeight: 8 } },
      tooltip: { backgroundColor: c.ink, titleColor: c.surface, bodyColor: c.surface, padding: 10, cornerRadius: 8,
        boxPadding: 4, usePointStyle: true },
    },
    scales: {
      x: { grid: { display: false }, border: { color: c.axis }, ticks: { color: c.muted, maxRotation: 0, autoSkipPadding: 12 } },
      y: { beginAtZero: true, grid: { color: c.grid }, border: { display: false },
        ticks: { color: c.muted, precision: 0, callback: (v) => Number(v).toLocaleString() },
        title: yTitle ? { display: true, text: yTitle, color: c.muted } : undefined },
    },
  };
}

function chartCard(id, title, subtitle, tableHead, tableRows) {
  return `<div class="card"><h3>${esc(title)}</h3>${subtitle ? `<p class="small muted">${esc(subtitle)}</p>` : ""}
    <div class="chart-box"><canvas id="${id}" role="img" aria-label="${esc(title)}"></canvas></div>
    <details><summary>Show table</summary><div class="table-wrap"><table><thead><tr>${tableHead.map((h, k) =>
      `<th class="${k ? "r" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${tableRows.map((r) =>
      `<tr>${r.map((v, k) => `<td class="${k ? "r" : ""}">${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details></div>`;
}

function addChart(id, config) {
  const el = document.getElementById(id);
  if (el) state.charts.push(new window.Chart(el, config));
}

function barConfig(c, labels, data, label) {
  return { type: "bar", data: { labels, datasets: [{ label, data, backgroundColor: c.s1, hoverBackgroundColor: c.s1,
    borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", maxBarThickness: 24 }] }, options: baseOptions(c) };
}

function lineDataset(c, label, data, color) {
  return { label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6,
    pointBorderColor: c.surface, pointBorderWidth: 2, borderJoinStyle: "round", borderCapStyle: "round", tension: 0, spanGaps: true };
}

// Weight over time on a true day axis, with fasting days as a row of markers below the line.
const dayNum = (iso) => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86400000);
const dayLabel = (n) => new Date(n * 86400000).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

function weightChartConfig(c, wt, fasts) {
  const pts = wt.map((m) => ({ x: dayNum(m.taken_at), y: m.weight_lb }));
  // Markers sit in their own band under the lowest reading so the line never covers them.
  const ys = pts.map((p) => p.y);
  const lo = Math.min(...ys);
  const pad = Math.max(1.5, (Math.max(...ys) - lo) * 0.12);
  const markerY = lo - pad;
  const fastPts = fasts.map((m) => {
    const x = dayNum(m.taken_at);
    return { x, y: markerY, hours: m.hours, fasting: true };
  });
  const line = lineDataset(c, "Weight (lb)", pts, c.s1);
  if (pts.length > 60) Object.assign(line, { pointRadius: 0, pointHoverRadius: 5 });
  const datasets = [line];
  if (fastPts.length) {
    datasets.push({ type: "scatter", label: "Fasting day", data: fastPts, showLine: false, pointStyle: "triangle",
      pointRadius: 7, pointHoverRadius: 9, backgroundColor: c.s2, hoverBackgroundColor: c.s2,
      borderColor: c.surface, hoverBorderColor: c.surface, borderWidth: 2 });
  }
  const o = baseOptions(c, { legend: fastPts.length > 0 });
  o.interaction = { mode: "nearest", axis: "x", intersect: false };
  // One day of space on each side so markers on the first/last day aren't cut in half.
  const xs = [...pts, ...fastPts].map((p) => p.x);
  o.scales.x = { ...o.scales.x, type: "linear", min: Math.min(...xs) - 1, max: Math.max(...xs) + 1,
    ticks: { ...o.scales.x.ticks, callback: (v) => dayLabel(Math.round(v)) } };
  o.scales.y.beginAtZero = false;
  if (fastPts.length) o.scales.y.min = Math.floor(markerY - pad * 0.7);
  o.plugins.tooltip.callbacks = {
    title: (items) => dayLabel(items[0].parsed.x),
    label: (ctx) => ctx.raw.fasting
      ? `Fasting day${ctx.raw.hours ? ` (${fmt(ctx.raw.hours, 1)} h)` : ""}`
      : `Weight ${fmt(ctx.parsed.y, 1)} lb`,
  };
  return { type: "line", data: { datasets }, options: o };
}

function weightTableRows(wt, fasts) {
  const rows = new Map();
  for (const m of wt) rows.set(m.taken_at.slice(0, 10), { w: fmt(m.weight_lb, 1), f: "" });
  for (const m of fasts) {
    const d = m.taken_at.slice(0, 10);
    rows.set(d, { w: rows.get(d)?.w ?? "–", f: m.hours ? `Yes (${fmt(m.hours, 1)} h)` : "Yes" });
  }
  return [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, r]) => [d, r.w, r.f]);
}

function renderProgress(params) {
  const range = params.range || "12";
  const ws = allWorkouts();
  const c = themeColors();

  // Continuous week axis (empty weeks show as zero).
  const byWeek = new Map(weekly(ws).map((w) => [w.week, w]));
  const end = new Date(`${weekStart(localIsoDate())}T12:00:00`);
  let start;
  if (range === "all") {
    // Earliest workout or reading, whichever comes first.
    const firsts = [weekly(ws)[0]?.week, allMeasurements()[0]?.taken_at.slice(0, 10)].filter(Boolean).sort();
    start = new Date(`${firsts.length ? weekStart(firsts[0]) : localIsoDate(end)}T12:00:00`);
  }
  else { start = new Date(end); start.setDate(start.getDate() - 7 * (Number(range) - 1)); }
  const weeks = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 7)) {
    const k = localIsoDate(d);
    weeks.push(byWeek.get(k) || { week: k, sessions: 0, swings: 0, volume_lb: 0, minutes: 0 });
  }
  const labels = weeks.map((w) => shortDate(w.week));

  // Exercise progression.
  const freq = new Map();
  ws.forEach((w) => Object.keys(w.exercises || {}).forEach((ex) => freq.set(ex, (freq.get(ex) || 0) + 1)));
  const exList = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([ex]) => ex);
  const ex = params.ex && freq.has(params.ex) ? params.ex : exList[0];
  const sinceIso = localIsoDate(start);
  const exSessions = ex ? ws.filter((w) => w.exercises?.[ex] && w.date >= sinceIso).slice().reverse() : [];

  const bp = allMeasurements().filter((m) => m.kind === "blood_pressure" && m.taken_at.slice(0, 10) >= sinceIso);
  const wt = allMeasurements().filter((m) => m.kind === "weight" && m.taken_at.slice(0, 10) >= sinceIso);
  const fasts = allMeasurements().filter((m) => m.kind === "fasting" && m.taken_at.slice(0, 10) >= sinceIso);

  const rangeBtn = (r, label) => `<button data-go="#/progress?range=${r}${ex ? `&ex=${encodeURIComponent(ex)}` : ""}" aria-pressed="${range === r}">${label}</button>`;
  const wkRows = (key, d = 0) => weeks.map((w) => [`Week of ${w.week}`, fmt(w[key], d)]);

  view.innerHTML = `<h1>Progress</h1>
    <div class="spread"><div class="segmented" role="group" aria-label="Time range">
      ${rangeBtn("12", "12 wk")}${rangeBtn("26", "26 wk")}${rangeBtn("52", "1 yr")}${rangeBtn("all", "All")}</div></div>
    <h2>Weekly training</h2>
    <div class="charts">
      ${chartCard("c-swings", "Swings per week", null, ["Week", "Swings"], wkRows("swings"))}
      ${chartCard("c-minutes", "Training minutes per week", null, ["Week", "Minutes"], wkRows("minutes", 1))}
      ${chartCard("c-volume", "Volume per week (lb)", "Reps × weight × bells", ["Week", "Volume (lb)"], wkRows("volume_lb"))}
      ${chartCard("c-sessions", "Sessions per week", null, ["Week", "Sessions"], wkRows("sessions"))}
    </div>
    <h2>Exercise progress</h2>
    ${exList.length ? `<label>Exercise<select id="ex-pick">${exList.map((x) => `<option value="${esc(x)}" ${x === ex ? "selected" : ""}>${esc(catalog.name(x))}</option>`).join("")}</select></label>
      <div class="charts">
      ${chartCard("c-ex-weight", `${catalog.name(ex)}: heaviest weight per session (lb)`, null, ["Date", "Heaviest (lb)", "Reps"],
        exSessions.map((w) => [w.date, fmt(w.exercises[ex].max_weight_lb, 1), fmt(w.exercises[ex].total_reps)]))}
      ${chartCard("c-ex-reps", `${catalog.name(ex)}: reps per session`, null, ["Date", "Reps"],
        exSessions.map((w) => [w.date, fmt(w.exercises[ex].total_reps)]))}
      </div>` : `<div class="card muted">Log a few workouts to see exercise trends.</div>`}
    <h2>Health</h2>
    <div class="charts">
      ${bp.length ? chartCard("c-bp", "Blood pressure (mmHg)", null, ["Taken", "Systolic", "Diastolic", "Pulse"],
        bp.map((m) => [m.taken_at.replace("T", " "), m.systolic, m.diastolic, m.pulse ?? "–"])) :
        `<div class="card muted">No blood pressure readings in this range.</div>`}
      ${wt.length ? chartCard("c-weight", "Body weight (lb)", fasts.length ? "Triangles along the bottom mark fasting days" : null,
        ["Date", "Weight (lb)", "Fasting"], weightTableRows(wt, fasts)) : ""}
    </div>`;

  const pick = document.getElementById("ex-pick");
  if (pick) pick.onchange = () => (location.hash = `#/progress?range=${range}&ex=${encodeURIComponent(pick.value)}`);

  addChart("c-swings", barConfig(c, labels, weeks.map((w) => w.swings), "Swings"));
  addChart("c-minutes", barConfig(c, labels, weeks.map((w) => w.minutes), "Minutes"));
  addChart("c-volume", barConfig(c, labels, weeks.map((w) => w.volume_lb), "Volume (lb)"));
  addChart("c-sessions", barConfig(c, labels, weeks.map((w) => w.sessions), "Sessions"));
  if (ex) {
    const exLabels = exSessions.map((w) => shortDate(w.date));
    addChart("c-ex-weight", { type: "line", data: { labels: exLabels,
      datasets: [lineDataset(c, "Heaviest (lb)", exSessions.map((w) => w.exercises[ex].max_weight_lb), c.s1)] },
      options: { ...baseOptions(c), scales: { ...baseOptions(c).scales, y: { ...baseOptions(c).scales.y, beginAtZero: false } } } });
    addChart("c-ex-reps", barConfig(c, exLabels, exSessions.map((w) => w.exercises[ex].total_reps), "Reps"));
  }
  if (bp.length) {
    const o = baseOptions(c, { legend: true });
    o.scales.y.beginAtZero = false;
    addChart("c-bp", { type: "line", data: { labels: bp.map((m) => shortDate(m.taken_at.slice(0, 10))),
      datasets: [lineDataset(c, "Systolic", bp.map((m) => m.systolic), c.s1), lineDataset(c, "Diastolic", bp.map((m) => m.diastolic), c.s2)] },
      options: o });
  }
  if (wt.length) addChart("c-weight", weightChartConfig(c, wt, fasts));
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (location.hash.startsWith("#/progress")) route();
});

// ------------------------------------------------------------------ measurements (BP / weight / resting HR / fasting)

function renderMeasure(params) {
  const kind = params.kind || "blood_pressure";
  const seg = (k, label) => `<button data-go="#/measure?kind=${k}" aria-pressed="${kind === k}">${label}</button>`;
  const n = (name, label, attrs = "") => `<label>${label}<input type="number" name="${name}" ${attrs}></label>`;
  const fields = {
    blood_pressure: `<div class="grid-3">${n("systolic", "Systolic", 'inputmode="numeric" required min="50" max="260"')}
        ${n("diastolic", "Diastolic", 'inputmode="numeric" required min="30" max="180"')}${n("pulse", "Pulse", 'inputmode="numeric" min="20" max="250"')}</div>
      <div class="grid-2"><label>Arm<select name="arm"><option value="">–</option><option>left</option><option>right</option></select></label>
        <label>Position<select name="position"><option value="">–</option><option selected>seated</option><option>standing</option><option>lying</option></select></label></div>
      <label class="check"><input type="checkbox" name="irregular_heartbeat"> Irregular heartbeat shown</label>`,
    weight: `<div class="grid-2">${n("weight", "Weight (lb)", 'inputmode="decimal" step="any" required min="1"')}
        ${n("body_fat_pct", "Body fat %", 'inputmode="decimal" step="any" min="1" max="75"')}</div>`,
    resting_hr: n("bpm", "Resting heart rate (bpm)", 'inputmode="numeric" required min="20" max="200"'),
    fasting: n("hours", "Hours fasted (optional)", 'inputmode="decimal" step="any" min="1" max="168"'),
  }[kind];
  const when = kind === "fasting"
    ? `<label>Day<input type="date" name="day" value="${localIsoDate()}" required></label>`
    : `<label>Taken<input type="datetime-local" name="taken_at" value="${nowLocal()}" required></label>`;
  view.innerHTML = `${setupNotice()}<h1>Add a reading</h1>
    <div class="segmented" role="group" aria-label="Reading type">${seg("blood_pressure", "Blood pressure")}${seg("weight", "Weight")}${seg("resting_hr", "Resting HR")}${seg("fasting", "Fasting")}</div>
    <form id="m-form" class="card stack">
      ${when}
      ${fields}
      <label>Notes<input name="notes" placeholder="optional"></label>
      <button class="primary" type="submit">Save reading</button>
    </form>
    ${kind === "blood_pressure" ? `<p class="small muted">Taking 2–3 readings? Save each one; they're kept separately.</p>` : ""}
    ${kind === "fasting" ? `<p class="small muted">Fasting days show as markers on the body weight chart in Progress.</p>` : ""}`;

  document.getElementById("m-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const m = { kind, taken_at: kind === "fasting" ? `${f.get("day")}T00:00` : f.get("taken_at") };
    const ints = ["systolic", "diastolic", "pulse", "bpm"];
    const floats = ["weight", "body_fat_pct", "hours"];
    for (const [k, v] of f.entries()) {
      if (k === "taken_at" || k === "day" || v === "") continue;
      if (ints.includes(k)) m[k] = parseInt(v, 10);
      else if (floats.includes(k)) m[k] = parseFloat(v);
      else if (k === "irregular_heartbeat") m[k] = true;
      else m[k] = String(v).trim();
    }
    if (kind === "blood_pressure" && m.systolic <= m.diastolic) return toast("Systolic should be higher than diastolic.");
    if (kind === "weight") m.unit = "lb";
    const label = { blood_pressure: "bp", weight: "weight", resting_hr: "rhr", fasting: "fast" }[kind];
    const id = `${m.taken_at.slice(0, 10)}-${m.taken_at.slice(11, 16).replace(":", "")}-${label}-${randomTag()}`;
    const path = `data/manual/measurements/${id.slice(0, 4)}/${id}.yaml`;
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const { queued } = await outbox.perform([{ op: "put", path, content: gh.textToBase64(yaml.dump(m)), message: `Add ${label} reading ${m.taken_at} (app)` }]);
      state.local.measurements[id] = { id, ...m, weight_lb: m.weight, savedAt: Date.now() };
      saveLocal();
      toast(queued ? "Saved on this device; will sync when online." : "Saved to GitHub.");
      location.hash = "#/history?tab=measurements";
    } catch (err) {
      btn.disabled = false;
      toast(err.message);
    }
  };
}

// ------------------------------------------------------------------ Life Fitness photo

async function resizeImage(file, maxSide = 2000, quality = 0.85) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

function renderPhoto() {
  let blob = null;
  view.innerHTML = `${setupNotice()}<h1>Life Fitness photo</h1>
    <p class="secondary">Take a photo of the workout summary screen when you finish. It's saved to the repo and read into a cardio workout,
      then matched to your Polar session by time.</p>
    <form id="p-form" class="card stack">
      <label class="btn primary" for="p-file">Take photo</label>
      <input id="p-file" type="file" accept="image/*" capture="environment" hidden>
      <img id="p-preview" class="photo-preview" alt="Photo preview" hidden>
      <div class="grid-2">
        <label>Machine<select name="machine">${MACHINES.map((m) => `<option value="${m}">${m.replace(/_/g, " ")}</option>`).join("")}</select></label>
        <label>Finished at<input type="datetime-local" name="captured_at" value="${nowLocal()}" required></label>
      </div>
      <label>Note<input name="note" placeholder="optional, e.g. hill program"></label>
      <button class="primary" type="submit" id="p-save" disabled>Save photo</button>
    </form>`;
  const fileInput = document.getElementById("p-file");
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      blob = await resizeImage(file);
      const img = document.getElementById("p-preview");
      img.src = URL.createObjectURL(blob);
      img.hidden = false;
      document.getElementById("p-save").disabled = false;
    } catch (e) {
      toast(`Couldn't read that image: ${e.message}`);
    }
  };
  document.getElementById("p-form").onsubmit = async (e) => {
    e.preventDefault();
    if (!blob) return;
    const f = new FormData(e.target);
    const at = f.get("captured_at");
    const stem = `${at.slice(0, 10)}-${at.slice(11, 16).replace(":", "")}-lifefitness-${randomTag()}`;
    const dir = `data/inbox/photos/${stem.slice(0, 4)}`;
    const meta = { captured_at: at, source: "life_fitness", machine: f.get("machine"), status: "pending" };
    if (f.get("note")) meta.note = String(f.get("note")).trim();
    const btn = document.getElementById("p-save");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const b64 = gh.bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
      const { queued } = await outbox.perform([
        { op: "put", path: `${dir}/${stem}.jpg`, content: b64, message: `Add Life Fitness photo ${at} (app)` },
        { op: "put", path: `${dir}/${stem}.yaml`, content: gh.textToBase64(yaml.dump(meta)), message: `Add photo details ${at} (app)` },
      ]);
      toast(queued ? "Photo saved on this device; will upload when online." : "Photo saved to GitHub.");
      location.hash = "#/";
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Save photo";
      toast(err.message);
    }
  };
}

// ------------------------------------------------------------------ settings

async function renderSettings() {
  const s = gh.loadSettings();
  let ops = [];
  try { ops = await outbox.list(); } catch {}
  view.innerHTML = `<h1>Settings</h1>
    <form id="s-form" class="card stack">
      <div class="grid-2">
        <label>GitHub owner<input name="owner" value="${esc(s.owner)}" required autocapitalize="off"></label>
        <label>Repository<input name="repo" value="${esc(s.repo)}" required autocapitalize="off"></label>
      </div>
      <label>Branch<input name="branch" value="${esc(s.branch)}" placeholder="default branch" autocapitalize="off"></label>
      <label>Access token<input name="token" type="password" value="${esc(s.token)}" autocomplete="off" placeholder="github_pat_…"></label>
      <p class="field-hint">Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>
        with access to <strong>only this repository</strong> and <strong>Contents: Read and write</strong>. It's stored only in this browser.</p>
      <div class="row"><button class="primary" type="submit">Save &amp; test</button>
        <button type="button" id="s-refresh">Reload data</button></div>
      <p id="s-status" class="small"></p>
    </form>
    <h2>Polar Flow</h2>
    <div class="card stack">
      ${polarStatus()}
      <label>Polar client ID<input id="polar-client" value="${esc(s.polarClientId || "")}" autocapitalize="off" placeholder="from admin.polaraccesslink.com"></label>
      <div class="row">
        <button type="button" id="polar-connect">${polarSessions().length ? "Reconnect Polar" : "Connect Polar"}</button>
        <button type="button" id="polar-sync">Sync Polar now</button>
      </div>
      <p class="field-hint">Syncs run automatically every day. The buttons need your access token to also have
        <strong>Actions: Read and write</strong>.</p>
      <p id="polar-status" class="small"></p>
    </div>
    <h2>Waiting to sync</h2>
    <div class="card">${ops.length ? `<ul class="list">${ops.map((o) => `<li><div class="item"><span>${esc(o.message)}<br>
        <span class="meta">${esc(o.path)}</span>${o.error ? `<br><span class="small notice error">${esc(o.error)}</span>` : ""}</span>
        <button class="ghost" data-discard="${o.id}">Discard</button></div></li>`).join("")}</ul>
        <button id="s-sync">Sync now</button>` : `<p class="muted">Nothing waiting. Everything is on GitHub.</p>`}</div>
    <h2>This device</h2>
    <div class="card stack">
      <p class="small secondary">Install on your phone: open this page in Chrome, tap ⋮ then <strong>Add to Home screen</strong>.</p>
      <p class="small muted">App version ${esc(APP_VERSION)}</p>
      <button type="button" id="s-clear" class="danger">Clear cached data on this device</button>
    </div>`;

  const status = document.getElementById("s-status");
  document.getElementById("s-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    gh.saveSettings({ ...gh.loadSettings(), owner: f.get("owner").trim(), repo: f.get("repo").trim(),
      branch: f.get("branch").trim(), token: f.get("token").trim() });
    status.textContent = "Testing…";
    try {
      const info = await gh.repoInfo();
      status.textContent = info.private
        ? `Connected to ${info.full_name} (private).`
        : `Connected to ${info.full_name}, but this repository is PUBLIC. Make it private before storing health data.`;
      status.className = info.private ? "small" : "small notice error";
      await refresh();
    } catch (err) {
      status.textContent = err.message;
      status.className = "small notice error";
    }
  };
  const pStatus = document.getElementById("polar-status");
  document.getElementById("polar-connect").onclick = () => {
    const clientId = document.getElementById("polar-client").value.trim();
    if (!clientId) return toast("Enter your Polar client ID first.");
    gh.saveSettings({ ...gh.loadSettings(), polarClientId: clientId });
    const stateTag = `polar-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem("fitlog:polarState", stateTag);
    try { localStorage.setItem("fitlog:polarState", stateTag); } catch {}
    location.href = `https://flow.polar.com/oauth2/authorization?response_type=code&client_id=${encodeURIComponent(clientId)}&state=${stateTag}`;
  };
  document.getElementById("polar-sync").onclick = async (e) => {
    e.target.disabled = true;
    pStatus.textContent = "Starting sync…";
    try {
      await gh.dispatchWorkflow("polar-sync.yml");
      pStatus.textContent = "Sync started. New sessions appear in about a minute (use Reload data).";
    } catch (err) {
      pStatus.innerHTML = workflowHelp(err, "polar-sync.yml", "Sync Polar");
    } finally {
      e.target.disabled = false;
    }
  };
  document.getElementById("s-refresh").onclick = () => refresh().then(() => toast("Data reloaded."));
  document.getElementById("s-sync")?.addEventListener("click", () => syncNow().then(renderSettings));
  view.querySelectorAll("[data-discard]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Discard this unsynced change? It will be lost.")) return;
    await outbox.remove(Number(b.dataset.discard));
    renderSettings();
    updateSyncButton();
  }));
  document.getElementById("s-clear").onclick = () => {
    if (!confirm("Clear cached data? Your token and unsynced changes are kept.")) return;
    localStorage.removeItem("fitlog:bundle");
    localStorage.removeItem("fitlog:local");
    localStorage.removeItem(DRAFT_KEY);
    location.reload();
  };
}

// ------------------------------------------------------------------ Polar connection

function polarSessions() {
  return state.bundle.workouts.filter((w) => w.polar);
}

function polarStatus() {
  const ps = polarSessions();
  if (!ps.length) return `<p class="small secondary">Not connected yet, or no sessions synced.</p>`;
  const last = ps.map((w) => w.date).sort().at(-1);
  return `<p class="small secondary">${ps.length} Polar session${ps.length === 1 ? "" : "s"} synced · latest ${esc(shortDate(last))}</p>`;
}

function workflowHelp(err, file, name) {
  const s = gh.loadSettings();
  const url = `https://github.com/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}/actions/workflows/${file}`;
  const why = err.status === 403 || err.status === 404
    ? "Your access token can't start workflows (it needs Actions: Read and write)."
    : esc(err.message);
  return `${why} You can run it on GitHub instead: <a href="${esc(url)}" target="_blank" rel="noopener">Actions → ${esc(name)} → Run workflow</a>.`;
}

// Polar sends you back here as ?code=…&state=… after you approve access.
async function handlePolarReturn() {
  const q = new URLSearchParams(location.search);
  const code = q.get("code");
  if (!code) return;
  const expected = sessionStorage.getItem("fitlog:polarState") ||
    (() => { try { return localStorage.getItem("fitlog:polarState"); } catch { return null; } })();
  history.replaceState(null, "", location.pathname + "#/settings");
  if (q.get("state") && expected && q.get("state") !== expected) {
    toast("Ignored a Polar sign-in that this device didn't start.", 6000);
    return;
  }
  sessionStorage.removeItem("fitlog:polarState");
  try { localStorage.removeItem("fitlog:polarState"); } catch {}
  state.hold = true; // keep this message up even if a data refresh finishes meanwhile
  view.innerHTML = `<h1>Connecting Polar…</h1><div class="card"><p id="pc-msg">Starting the Connect Polar workflow…</p></div>`;
  const msg = document.getElementById("pc-msg");
  try {
    await gh.dispatchWorkflow("polar-connect.yml", { code });
    msg.innerHTML = `Polar access approved. GitHub is finishing the connection and pulling your recent sessions; this takes about a minute.
      Then tap <strong>Reload data</strong> in Settings.<br><br><a class="btn" href="#/settings">Back to Settings</a>`;
  } catch (err) {
    msg.innerHTML = `${workflowHelp(err, "polar-connect.yml", "Connect Polar")}<br><br>
      Paste this code as the <strong>code</strong> input within 10 minutes:<br>
      <input readonly value="${esc(code)}" aria-label="Polar authorization code"><br><br><a class="btn" href="#/settings">Back to Settings</a>`;
  }
}

// ------------------------------------------------------------------ startup

if (new URLSearchParams(location.search).has("code")) handlePolarReturn();
else route();
refresh({ quiet: true });
syncNow();
window.addEventListener("online", () => syncNow().then(() => refresh({ quiet: true })));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - readJSON("fitlog:refreshedAt", 0) > 120000) refresh({ quiet: true });
});
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  // When a new version's service worker takes over, reload once so the new code is what's running.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloaded && !state.editor) {
      reloaded = true;
      location.reload();
    }
  });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
}
