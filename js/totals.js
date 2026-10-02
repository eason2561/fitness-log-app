// Client-side port of src/fitlog/normalize.py so a workout shows its totals
// immediately, before GitHub Actions rebuilds data/clean/bundle.json. Keep in sync.

const KG_TO_LB = 2.20462;
export const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const r1 = (x) => Math.round(x * 10) / 10;

export class Catalog {
  constructor(exercises = []) {
    this.byId = new Map(exercises.map((e) => [e.id, e]));
    this.lookup = new Map();
    for (const e of exercises) {
      for (const k of [e.id, e.name, ...(e.aliases || [])]) {
        if (!this.lookup.has(slug(k))) this.lookup.set(slug(k), e.id);
      }
    }
  }
  resolve(text) {
    return this.lookup.get(slug(text || "")) || null;
  }
  canonical(text) {
    return this.resolve(text) || slug(text || "");
  }
  name(id) {
    const e = this.byId.get(id);
    if (e) return e.name;
    const s = String(id || "").replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  isSwing(id) {
    return (this.byId.get(id)?.tags || []).includes("swing");
  }
}

const toLb = (w, unit) => (w == null || w === "" ? null : unit === "kg" ? r1(w * KG_TO_LB) : Number(w));

function rows(w, catalog) {
  const out = [];
  const push = (exercise, e, d = {}) => {
    const weight = e.weight ?? d.weight;
    const bells = e.bells || d.bells || 1;
    const perSide = e.per_side ?? Boolean(d.per_side);
    const weightLb = toLb(weight, w.unit || "lb");
    const total = (Number(e.reps) || 0) * (perSide ? 2 : 1);
    out.push({
      exercise: catalog.canonical(exercise),
      total_reps: total,
      seconds: Number(e.seconds) || 0,
      weight_lb: weightLb,
      volume_lb: r1(total * (weightLb || 0) * bells),
    });
  };
  for (const b of w.blocks || []) {
    if (b.kind === "interval") {
      const n = b.stations.length;
      const done = b.rounds_completed ?? b.rounds;
      for (let r = 0; r < done; r++) {
        const st = b.mode === "circuit" ? b.stations : [b.stations[r % n]];
        st.forEach((s) => push(s.exercise, s));
      }
    } else if (b.kind === "sets") {
      b.sets.forEach((s) => push(b.exercise, s, b));
    }
  }
  return out;
}

export function durationMin(w) {
  if (w.duration_min != null) return w.duration_min;
  let total = 0;
  let known = false;
  for (const b of w.blocks || []) {
    if (b.kind === "interval") {
      total += ((b.rounds_completed ?? b.rounds) * b.every_sec) / 60;
      known = true;
    } else if (b.kind === "cardio" && b.duration_min != null) {
      total += Number(b.duration_min);
      known = true;
    }
  }
  return known ? r1(total) : null;
}

// Same shape as a workout entry in bundle.json.
export function summarize(id, w, catalog) {
  const rs = rows(w, catalog);
  const exercises = {};
  for (const r of rs) {
    const d = (exercises[r.exercise] ??= { total_reps: 0, volume_lb: 0, max_weight_lb: null, seconds: 0 });
    d.total_reps += r.total_reps;
    d.volume_lb = r1(d.volume_lb + r.volume_lb);
    d.seconds += r.seconds;
    if (r.weight_lb != null && (d.max_weight_lb == null || r.weight_lb > d.max_weight_lb)) d.max_weight_lb = r.weight_lb;
  }
  return {
    id,
    date: w.date,
    start: w.start ?? null,
    type: w.type || "kettlebell",
    title: w.title || (w.blocks?.[0]?.kind ?? "Workout").replace(/^./, (c) => c.toUpperCase()),
    source: w.source || "manual",
    template: w.template ?? null,
    rpe: w.rpe ?? null,
    notes: w.notes ?? null,
    duration_min: durationMin(w),
    total_reps: rs.reduce((a, r) => a + r.total_reps, 0),
    swings: rs.filter((r) => catalog.isSwing(r.exercise)).reduce((a, r) => a + r.total_reps, 0),
    volume_lb: r1(rs.reduce((a, r) => a + r.volume_lb, 0)),
    exercises,
    cardio: (w.blocks || []).filter((b) => b.kind === "cardio").map(({ kind, ...c }) => c),
    links: w.links ?? null,
    pending: true,
  };
}

export function weekStart(isoDate) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localIsoDate(d);
}

export function localIsoDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function weekly(workouts) {
  const m = new Map();
  for (const w of workouts) {
    const k = weekStart(w.date);
    const e = m.get(k) || { week: k, sessions: 0, swings: 0, volume_lb: 0, minutes: 0 };
    e.sessions += 1;
    e.swings += w.swings;
    e.volume_lb = r1(e.volume_lb + w.volume_lb);
    e.minutes = r1(e.minutes + (w.duration_min || 0));
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => a.week.localeCompare(b.week));
}
