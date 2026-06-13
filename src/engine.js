// ---------- CONFIG ----------
import { STRANDS_BY_OP, strandIdFor, strandById, TWO_DIGIT_BUILDERS } from "./curriculum.js";

// Re-export so the rest of the app can stay on a single engine import.
export { strandIdFor, strandById, STRANDS_BY_OP };

export const OPERATIONS = {
  addition:       { key: "addition",       symbol: "+", label: "Addition" },
  subtraction:    { key: "subtraction",    symbol: "−", label: "Subtraction" },
  multiplication: { key: "multiplication", symbol: "×", label: "Multiplication" },
  division:       { key: "division",       symbol: "÷", label: "Division" },
  // "numbers" — Phase 3 concepts track. Percentages + fraction
  // ↔ decimal conversions. Facts have a custom displayText (not
  // a + b) and accept decimal answers.
  numbers:        { key: "numbers",        symbol: "%", label: "Numbers" },
};

// Strand-completion threshold: a strand is "done" (and the next one
// auto-unlocks) when >= this fraction of its facts are at `known` or
// `automatic`. 0.75 = 3/4 of the strand's facts.
export const STRAND_COMPLETE_RATIO = 0.75;

// How often selectNextFact pulls a retention rep from a previously-
// completed strand instead of the active strand. Spaced retention.
// (Legacy constant — since the 2026-06-12 SRS scheduler, retention
// pulls come from the due-queue instead; kept for back-compat.)
export const RETENTION_RATE = 0.18;

// ---------- SPACED-REPETITION SCHEDULER (2026-06-12) ----------
// Expanding-interval review for facts the student knows. Each
// `known`/`automatic` fact carries:
//   srsInterval — current review interval in days (0 = unscheduled)
//   dueDay      — YYYY-MM-DD the fact is next due for a retention rep
// A successful retrieval ON OR AFTER the due day expands the interval
// (1 → 2 → 4 → 8 → 16 → 32). A wrong answer resets it to due-now.
// Reviewing early (before due) does NOT expand — massed reps don't
// strengthen long-term retention (spacing effect: Cepeda et al. 2006).
export const SRS_INTERVALS = [1, 2, 4, 8, 16, 32];

export function nextSrsInterval(cur) {
  for (const i of SRS_INTERVALS) if (i > (cur || 0)) return i;
  return SRS_INTERVALS[SRS_INTERVALS.length - 1];
}

export function addDaysToKey(dayKey, n) {
  const d = new Date(dayKey + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Probability of pulling from the due-queue instead of the active
// strand. Scales with how much is due — a big backlog gets cleared
// faster — capped so new learning never stalls.
export function dueQueueRate(dueCount) {
  if (dueCount <= 0) return 0;
  return Math.min(0.5, 0.12 + dueCount * 0.03);
}

// Per-operation latency thresholds (ms) — GLOBAL PRIOR.
// Originally calibrated 2026-05-18 from Isaac's real session data. As
// of 2026-06-13 these are no longer the live thresholds: they're the
// cold-start *prior* that per-student calibration shrinks away from as
// each student accumulates their own latency history (see CALIBRATION
// below). They still apply verbatim to a brand-new student who has no
// samples yet, and they anchor the clamp band so a noisy early sample
// can't produce an absurd personal threshold.
//
// The design intent is unchanged: `fast` sits at roughly the student's
// p50 (a fluent fact CAN go automatic) and `slow` at roughly p75 (a
// genuinely slow attempt still gets "Correct, slow" coaching). The
// difference is that "the student's p50/p75" is now measured per
// student instead of borrowed from one 4th-grader.
export const THRESHOLDS = {
  addition:       { fast: 1500, slow: 2500 },
  subtraction:    { fast: 1500, slow: 2500 },
  multiplication: { fast: 2000, slow: 3200 },
  division:       { fast: 2300, slow: 3800 },
  // Numbers track answers are often decimals (4-5 chars to type) and
  // require mental conversion. Generous thresholds.
  numbers:        { fast: 3000, slow: 5000 },
};

// ---------- PER-STUDENT LATENCY CALIBRATION (2026-06-13) ----------
// A fixed fast/slow line mis-serves a 60-student cohort: a fast-typing
// kid clears `fast` on facts they barely know (false "automatic"),
// while a slow-handed kid who knows a fact cold can never beat the
// clock and is stuck at `known` forever — never earning the automatic
// credit or the "Automatic" feedback that motivates. Latency conflates
// two things: how fast a student *recalls* and how fast they *type*.
// Calibration removes the typing component by measuring each line
// relative to that student's own correct-answer distribution.
//
// Model: keep a rolling buffer of each student's most recent CORRECT
// answer latencies per operation. Personal fast = the buffer's p50,
// personal slow = its p75 (the documented targets, now measured per
// student). Until the buffer is large enough to trust, the personal
// percentile is shrunk toward the global prior with an empirical-Bayes
// weight w = n / (n + CALIB_PRIOR_STRENGTH): zero samples → 100% prior,
// n = CALIB_PRIOR_STRENGTH → a 50/50 blend, large n → mostly personal.
// The blend is then clamped to a band around the prior so a degenerate
// sample (all walk-aways, or a burst of lucky-fast guesses) can't push
// a kid's "fast" line to 300 ms or 7 s.
//
// The buffer is rolling, so the line tracks a student who genuinely
// speeds up over weeks — their bar tightens, sustaining the challenge.
// To stop that tightening from retroactively stripping earned mastery,
// load-time re-classification is promote-only (see storage.js); live
// play still moves states both ways on real performance.
export const CALIB_BUFFER = 60;          // correct-latency samples kept per op
export const CALIB_PRIOR_STRENGTH = 15;  // pseudo-count weight of the global prior
export const CALIB_MIN_SAMPLES = 8;      // below this, thresholds == prior (too noisy)
export const CALIB_CLAMP_LO = 0.5;       // personal threshold floor = prior * 0.5
export const CALIB_CLAMP_HI = 1.8;       // personal threshold ceiling = prior * 1.8

// Empty calibration for one op: an empty sample buffer.
function emptyOpCalibration() {
  return { samples: [], n: 0 };
}

// Empty calibration for every operation.
export function emptyCalibration() {
  const c = {};
  for (const op of Object.keys(THRESHOLDS)) c[op] = emptyOpCalibration();
  return c;
}

// Linear-interpolation percentile over an UNSORTED numeric array.
// p in [0,1]. Returns null for an empty array.
export function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = p * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// Fold new correct-answer latencies into an op's calibration buffer.
// Latencies are capped at LATENCY_CAP_MS first (a walk-away shouldn't
// drag the percentile). Returns a NEW op-calibration object (pure).
export function updateOpCalibration(opCalib, newLatencies) {
  const base = opCalib && Array.isArray(opCalib.samples) ? opCalib.samples : [];
  let samples = base.slice();
  for (const lat of newLatencies || []) {
    if (typeof lat !== "number" || !Number.isFinite(lat) || lat <= 0) continue;
    samples.push(Math.min(lat, LATENCY_CAP_MS));
  }
  if (samples.length > CALIB_BUFFER) samples = samples.slice(samples.length - CALIB_BUFFER);
  return { samples, n: samples.length };
}

// Resolve the live fast/slow thresholds for an op given a student's
// calibration. Falls back to the global prior when calibration is
// missing or too sparse to trust. Pure — safe to call every render.
export function thresholdsFor(calibration, op) {
  const prior = THRESHOLDS[op] || THRESHOLDS.addition;
  const opCalib = calibration && calibration[op];
  const n = opCalib?.samples?.length || 0;
  if (n < CALIB_MIN_SAMPLES) return { ...prior, calibrated: false, n };

  const w = n / (n + CALIB_PRIOR_STRENGTH);
  const blendClamp = (personal, priorVal) => {
    if (personal == null) return priorVal;
    const blended = w * personal + (1 - w) * priorVal;
    const lo = priorVal * CALIB_CLAMP_LO;
    const hi = priorVal * CALIB_CLAMP_HI;
    return Math.round(Math.min(Math.max(blended, lo), hi));
  };

  let fast = blendClamp(percentile(opCalib.samples, 0.5), prior.fast);
  let slow = blendClamp(percentile(opCalib.samples, 0.75), prior.slow);
  // Guarantee a non-degenerate ordering even after clamping.
  if (slow <= fast) slow = fast + 200;
  return { fast, slow, calibrated: true, n };
}

// Max latency we ever store on a fact. Beyond this the student has
// clearly walked away (we saw a 22-minute pause on Isaac's data
// poison a single multiplication fact's avgLatency for life). Capping
// it stops one walk-away from permanently barring a fact from
// "automatic."
export const LATENCY_CAP_MS = 8000;

// Cold-start: small starter pool per op. Expansion handles the rest.
export const STARTER_LEVELS = {
  addition:       3, // a,b in 0..3 → 16 facts
  subtraction:    4, // a in 0..4, b ≤ a → 15 facts
  multiplication: 5, // a,b in 2..5 → 16 facts
  division:       5, // b,q in 2..5 → 16 facts
  numbers:        1, // strand-only system; level mostly unused
};

export const SESSION_GOAL_XP   = 2;        // ~2 min focused work closes the in-session ring
export const SESSION_TIME_CAP  = 10 * 60;  // 10 min hard stop (seconds)
export const PROBLEM_TIME_CAP  = 8;        // sec max counted per problem (anti-idle)
export const DAILY_GOAL_XP     = 5;        // ~5 min total focused work per day across sessions
export const ACCURACY_GATE     = 0.85;
export const MIN_ATTEMPTS_FOR_FLUENCY = 4;
export const MAX_LEVEL         = 12;

// Cross-op prerequisite gating
export const DIVISION_UNLOCK_THRESHOLD = 5; // multiplication facts automatic before ÷ unlocks

// ---------- DATE HELPERS ----------
function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function daysBetween(dayKey1, dayKey2) {
  if (!dayKey1 || !dayKey2) return 0;
  const d1 = new Date(dayKey1 + "T00:00:00Z");
  const d2 = new Date(dayKey2 + "T00:00:00Z");
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

// ---------- FACT BUILDERS ----------
function emptyTracking() {
  return {
    attempts: 0, correct: 0, wrong: 0,
    avgLatency: null, lastLatency: null,
    lastSeenAt: null,
    lastSeenDay: null, // YYYY-MM-DD — for spaced-repetition decay
    streakFastCorrect: 0, streakWrong: 0,
    state: "unknown", // unknown | learning | accurate | effortful | automatic
    srsInterval: 0,   // days; 0 = not yet scheduled
    dueDay: null,     // YYYY-MM-DD next retention rep
  };
}

function buildAddition() {
  const facts = {};
  for (let a = 0; a <= 12; a++) {
    for (let b = 0; b <= 12; b++) {
      const id = `add-${a}+${b}`;
      facts[id] = { id, op: "addition", a, b, answer: a + b, difficulty: Math.max(a, b), ...emptyTracking() };
    }
  }
  return facts;
}

function buildSubtraction() {
  // a - b where a >= b, both 0..12
  const facts = {};
  for (let a = 0; a <= 12; a++) {
    for (let b = 0; b <= a; b++) {
      const id = `sub-${a}-${b}`;
      facts[id] = { id, op: "subtraction", a, b, answer: a - b, difficulty: a, ...emptyTracking() };
    }
  }
  return facts;
}

function buildMultiplication() {
  // Now includes a,b in 0..12 (was 2..12) so the ×0 and ×1 strands
  // have content. The old pool of 2..12 was a 121-fact subset; the
  // new pool is 169 facts.
  const facts = {};
  for (let a = 0; a <= 12; a++) {
    for (let b = 0; b <= 12; b++) {
      const id = `mul-${a}x${b}`;
      facts[id] = { id, op: "multiplication", a, b, answer: a * b, difficulty: Math.max(a, b), ...emptyTracking() };
    }
  }
  return facts;
}

function buildDivision() {
  // a / b = q where a = b*q.
  // Was: b,q in 2..12. Now: b in 1..12, q in 1..12 (excluding b=0
  // which is undefined). Gives us ÷1, ÷self, and ÷-by-larger
  // identity facts the strand curriculum expects.
  const facts = {};
  for (let q = 1; q <= 12; q++) {
    for (let b = 1; b <= 12; b++) {
      const a = b * q;
      const id = `div-${a}d${b}`;
      facts[id] = { id, op: "division", a, b, answer: q, difficulty: Math.max(b, q), ...emptyTracking() };
    }
  }
  return facts;
}

// Numbers track — percentages + fraction↔decimal conversions.
// Each fact has displayText (what the kid sees) and answer (the
// canonical numeric value to compare to). a/b are kept as
// "approximation hints" for difficulty sorting but aren't displayed.
function buildNumbers() {
  const facts = {};
  function add(id, displayText, answer, strandHint, a = 0, b = 0) {
    facts[id] = {
      id,
      op: "numbers",
      a, b, answer,
      displayText,
      difficulty: 1,
      strandHint,
      ...emptyTracking(),
    };
  }

  // === Percentages of 100 ===
  for (const p of [10, 20, 25, 50, 75, 100]) {
    add(`num-pct100-${p}`, `${p}% of 100`, p, "num-pct-of-100", p, 100);
  }
  // === Percentages of common bases (10%/25%/50%/75%) ===
  const bases = [20, 40, 60, 80, 200, 300, 1000];
  for (const base of bases) {
    add(`num-pct-10-${base}`, `10% of ${base}`, base * 0.1, "num-pct-common", 10, base);
    add(`num-pct-50-${base}`, `50% of ${base}`, base * 0.5, "num-pct-common", 50, base);
  }
  for (const base of [40, 80, 200]) {
    add(`num-pct-25-${base}`, `25% of ${base}`, base * 0.25, "num-pct-common", 25, base);
    add(`num-pct-75-${base}`, `75% of ${base}`, base * 0.75, "num-pct-common", 75, base);
  }

  // === Common fraction → decimal ===
  const fracs = [
    ["1/2", 0.5],
    ["1/4", 0.25],
    ["3/4", 0.75],
    ["1/5", 0.2],
    ["2/5", 0.4],
    ["3/5", 0.6],
    ["4/5", 0.8],
    ["1/10", 0.1],
    ["3/10", 0.3],
    ["7/10", 0.7],
    ["9/10", 0.9],
    ["1/8", 0.125],
    ["3/8", 0.375],
    ["5/8", 0.625],
  ];
  for (const [frac, dec] of fracs) {
    const safe = frac.replace("/", "-");
    add(`num-frac2dec-${safe}`, `${frac} as a decimal`, dec, "num-frac-to-dec", 0, 0);
  }

  // === Common percentage → decimal ===
  for (const p of [10, 20, 25, 50, 75, 90]) {
    add(`num-pct2dec-${p}`, `${p}% as a decimal`, p / 100, "num-pct-to-dec", p, 0);
  }

  // === Common fraction → percentage ===
  const fracsToPct = [
    ["1/2", 50],
    ["1/4", 25],
    ["3/4", 75],
    ["1/5", 20],
    ["2/5", 40],
    ["1/10", 10],
    ["3/10", 30],
    ["7/10", 70],
  ];
  for (const [frac, pct] of fracsToPct) {
    const safe = frac.replace("/", "-");
    add(`num-frac2pct-${safe}`, `${frac} as a percent`, pct, "num-frac-to-pct", pct, 0);
  }

  return facts;
}

function build1Digit(op) {
  switch (op) {
    case "addition":       return buildAddition();
    case "subtraction":    return buildSubtraction();
    case "multiplication": return buildMultiplication();
    case "division":       return buildDivision();
    case "numbers":        return buildNumbers();
    default: return {};
  }
}

// Merge curated 2-digit (and longer) fact pools into the base
// 1-digit pool. Every fact then gets tagged with its strand id.
export function buildFacts(op) {
  const facts = build1Digit(op);
  // Append curated multi-digit facts from curriculum.js
  for (const [, spec] of Object.entries(TWO_DIGIT_BUILDERS)) {
    if (spec.op !== op) continue;
    for (const { a, b, answer } of spec.build()) {
      const id = spec.makeId(a, b);
      if (facts[id]) continue; // don't clobber 1-digit version if any overlap
      facts[id] = {
        id, op, a, b, answer,
        difficulty: Math.max(a, b),
        ...emptyTracking(),
      };
    }
  }
  // Tag every fact with its sub-strand. First-match-wins (the
  // curriculum.js order is the unlock order).
  for (const f of Object.values(facts)) {
    f.strand = strandIdFor(op, f);
  }
  return facts;
}

export function initialProgress(op) {
  return { facts: buildFacts(op), currentLevel: STARTER_LEVELS[op] };
}

// ---------- LOGIC ----------
// `thr` is the resolved per-student {fast, slow} for this op (from
// thresholdsFor). Defaults to the global prior so legacy callers and
// tests that omit it keep working.
export function classify(correct, latency, op, thr = THRESHOLDS[op]) {
  if (!correct) return "wrong";
  if (latency <= thr.fast) return "fast";
  if (latency <= thr.slow) return "slow";
  return "tooSlow";
}

// Mastery rank of a state, low→high. Used by the load-time
// promote-only guard so a calibration/threshold change can upgrade a
// fact on reload but never retroactively strip earned mastery.
const STATE_RANK = {
  unknown: 0,
  learning: 1,
  effortful: 2,
  accurate: 3,
  known: 4,
  automatic: 5,
};
export function stateRank(state) {
  return STATE_RANK[state] ?? 0;
}
// Return whichever of two states carries the higher mastery rank.
export function higherState(a, b) {
  return stateRank(a) >= stateRank(b) ? a : b;
}

export function accuracyOf(fact) {
  if (fact.attempts === 0) return 1;
  return fact.correct / fact.attempts;
}

export function inFluencyMode(fact) {
  return fact.attempts >= MIN_ATTEMPTS_FOR_FLUENCY && accuracyOf(fact) >= ACCURACY_GATE;
}

export function isQualifying(result, fact) {
  if (inFluencyMode(fact)) return result === "fast";
  return result === "fast" || result === "slow" || result === "tooSlow";
}

export function determineState(fact, op, thr = THRESHOLDS[op]) {
  if (fact.attempts < 3) return "unknown";
  const acc = accuracyOf(fact);
  const fastT = thr.fast;
  // Clean four-rung ladder: learning < effortful < known < automatic.
  // (`accurate` is kept in masteryScore for backward compat with
  // pre-2026-05-18 persisted data, but new evaluations never produce
  // it — it was an artifact of latency-gated state classification
  // that left fast-typing kids stuck at `effortful` despite high
  // accuracy.)
  if (acc < 0.75) return "learning";
  // automatic — fast + reliable. lastLatency (not avgLatency) so a
  // recent fluent run can flip the fact even if early reps were slow.
  if (
    fact.streakFastCorrect >= 3 &&
    fact.lastLatency &&
    fact.lastLatency <= fastT
  ) return "automatic";
  // known — high accuracy, time-agnostic. Catches both fast-typers
  // who can't quite clear fastT and slow-typers who know it cold.
  // Counts 0.75 toward expansion (vs accurate=0.5, automatic=1.0).
  if (acc >= 0.85) return "known";
  // effortful — getting it sometimes, still making mistakes.
  return "effortful";
}

function recencyBoost(lastSeenAt) {
  if (!lastSeenAt) return 20;
  const secondsAgo = (Date.now() - lastSeenAt) / 1000;
  if (secondsAgo < 8)  return -50;
  if (secondsAgo < 20) return 0;
  if (secondsAgo < 60) return 10;
  return 20;
}

// Spaced-repetition boost — due-date based (2026-06-12).
// Facts past their dueDay bubble up with urgency proportional to how
// overdue they are; facts not yet due are actively deprioritized so
// the engine doesn't waste reps on cramming. Includes `known` facts
// (the old decayBoost skipped them — a retention hole, since most of
// a slow-typing kid's mastered facts live at `known`).
function decayBoost(fact, today) {
  const retained =
    fact.state === "automatic" || fact.state === "known" || fact.state === "accurate";
  if (!retained) return 0;
  if (!fact.dueDay) {
    // Un-scheduled legacy fact — fall back to lastSeenDay age.
    if (!fact.lastSeenDay) return 0;
    const days = daysBetween(fact.lastSeenDay, today);
    if (days <= 0) return 0;
    if (days <= 3) return 25;
    if (days <= 7) return 45;
    return 65;
  }
  const overdue = daysBetween(fact.dueDay, today); // >0 means past due
  if (overdue < 0)  return -15;  // not due yet — let it rest
  if (overdue === 0) return 18;  // due today
  if (overdue <= 3) return 35;
  if (overdue <= 7) return 50;
  return 65;                     // long overdue — urgent
}

function priorityFor(fact, op, today, thr = THRESHOLDS[op]) {
  let p = 0;
  if (fact.state === "learning")  p += 50;
  else if (fact.state === "effortful") p += 40;
  else if (fact.state === "accurate")  p += 35;
  else if (fact.state === "unknown")   p += 30;
  // `known` lands between accurate and automatic — the kid clearly
  // knows it, so it doesn't need as much practice as `accurate`, but
  // we still want to revisit occasionally to nudge toward automatic.
  else if (fact.state === "known")     p += 18;
  else if (fact.state === "automatic") p += 8;

  if (fact.streakWrong > 0) p += 25;
  if (fact.lastLatency && fact.lastLatency > thr.slow) p += 15;
  p += recencyBoost(fact.lastSeenAt);
  p += decayBoost(fact, today);
  return p;
}

// ============================================================
// Sub-strand helpers
// ============================================================

// Stats for one strand: counts + completion status.
//   total      — how many facts belong to this strand
//   attempted  — facts the student has seen at least once
//   masteredCount — facts at `known` or `automatic`
//   pct        — masteredCount / total (0..1)
//   complete   — pct >= STRAND_COMPLETE_RATIO
export function strandProgress(facts, strandId) {
  let total = 0, attempted = 0, masteredCount = 0;
  for (const f of Object.values(facts)) {
    if (f.strand !== strandId) continue;
    total += 1;
    if (f.attempts > 0) attempted += 1;
    if (f.state === "known" || f.state === "automatic") masteredCount += 1;
  }
  const pct = total === 0 ? 0 : masteredCount / total;
  return {
    total,
    attempted,
    masteredCount,
    pct,
    complete: pct >= STRAND_COMPLETE_RATIO,
  };
}

// Full strand-status array for an op, in unlock order:
//   [{ id, label, description, status, ...progress }]
// status ∈ {complete, active, locked}.
// Exactly one strand is `active` (the first non-complete strand).
// Strands after the active one are `locked`.
export function strandStatuses(facts, op) {
  const strands = STRANDS_BY_OP[op] || [];
  const out = [];
  let activeSeen = false;
  for (const s of strands) {
    const prog = strandProgress(facts, s.id);
    let status;
    if (prog.complete) status = "complete";
    else if (!activeSeen) {
      status = "active";
      activeSeen = true;
    } else status = "locked";
    out.push({
      id: s.id,
      label: s.label,
      description: s.description,
      status,
      ...prog,
    });
  }
  return out;
}

// The currently-active strand id (the one the student should
// practice right now). Returns null if every strand is complete.
export function activeStrandId(facts, op) {
  const statuses = strandStatuses(facts, op);
  const active = statuses.find((s) => s.status === "active");
  return active ? active.id : null;
}

// ============================================================

// Weighted pick among the 5 highest-priority facts in a pool.
function weightedPick(pool, op, today, thr = THRESHOLDS[op]) {
  const scored = pool.map((f) => ({ fact: f, p: priorityFor(f, op, today, thr) }));
  scored.sort((a, b) => b.p - a.p);
  const top = scored.slice(0, 5);
  const totalP = top.reduce((s, x) => s + Math.max(x.p, 1), 0);
  let r = Math.random() * totalP;
  for (const item of top) {
    r -= Math.max(item.p, 1);
    if (r <= 0) return item.fact;
  }
  return top[0].fact;
}

// All facts currently due for a retention rep (SRS due-queue).
export function dueFacts(facts, today = todayKey()) {
  return Object.values(facts).filter(
    (f) =>
      (f.state === "known" || f.state === "automatic" || f.state === "accurate") &&
      f.dueDay &&
      f.dueDay <= today,
  );
}

// Pick the next fact to drill. SRS- and strand-aware:
//   - With probability dueQueueRate(n), pull the highest-priority
//     fact from the due-queue (spaced retention across ALL strands,
//     replacing the old random completed-strand sprinkle).
//   - Otherwise pull from the active strand.
//   - Within the chosen pool, priority logic + 5-fact weighted pick.
//
// `op` is required; `currentLevel` no longer used and accepted as
// undefined for backward compat from any caller still passing it.
// `thr` is the student's resolved thresholds (for the slow-latency
// priority boost); defaults to the global prior.
export function selectNextFact(facts, lastId, op, thr = THRESHOLDS[op]) {
  const today = todayKey();

  // SRS due-queue first.
  const due = dueFacts(facts, today).filter((f) => f.id !== lastId);
  if (due.length > 0 && Math.random() < dueQueueRate(due.length)) {
    return weightedPick(due, op, today, thr);
  }

  const statuses = strandStatuses(facts, op);
  const activeId = statuses.find((s) => s.status === "active")?.id || null;
  const completeIds = statuses.filter((s) => s.status === "complete").map((s) => s.id);
  const strandPool = activeId || completeIds[completeIds.length - 1] || null;

  let pool;
  if (strandPool) {
    pool = Object.values(facts).filter(
      (f) => f.strand === strandPool && f.id !== lastId,
    );
  } else {
    pool = Object.values(facts).filter((f) => f.id !== lastId);
  }
  if (pool.length === 0) {
    return Object.values(facts).filter((f) => f.id !== lastId)[0]
        || Object.values(facts)[0];
  }
  return weightedPick(pool, op, today, thr);
}

export function applyAttempt(fact, result, latency, op, thr = THRESHOLDS[op]) {
  // Cap stored latency so a walk-away doesn't poison the EMA forever.
  const cappedLat = Math.min(latency, LATENCY_CAP_MS);
  const updated = { ...fact };
  updated.attempts += 1;
  updated.lastLatency = cappedLat;
  updated.lastSeenAt = Date.now();
  updated.lastSeenDay = todayKey();

  if (result !== "wrong") {
    updated.correct += 1;
    updated.streakWrong = 0;
    updated.avgLatency = updated.avgLatency
      ? Math.round(updated.avgLatency * 0.7 + cappedLat * 0.3)
      : cappedLat;
    updated.streakFastCorrect = result === "fast" ? updated.streakFastCorrect + 1 : 0;
  } else {
    updated.wrong += 1;
    updated.streakWrong += 1;
    updated.streakFastCorrect = 0;
  }
  updated.state = determineState(updated, op, thr);

  // ---- SRS scheduling ----
  const today = todayKey();
  if (result === "wrong") {
    // Missed — back to the front of the queue.
    updated.srsInterval = 0;
    updated.dueDay = today;
  } else if (updated.state === "known" || updated.state === "automatic") {
    const wasDue = !updated.dueDay || updated.dueDay <= today;
    if (wasDue) {
      updated.srsInterval = nextSrsInterval(updated.srsInterval);
      updated.dueDay = addDaysToKey(today, updated.srsInterval);
    }
    // Early (pre-due) correct reps don't expand the interval —
    // spacing, not massing, is what builds retention.
  }
  return updated;
}

export function masteryScore(facts, currentLevel) {
  let score = 0;
  for (const f of Object.values(facts)) {
    if (f.difficulty > currentLevel || f.attempts === 0) continue;
    if (f.state === "automatic") score += 1;
    else if (f.state === "known")    score += 0.75;
    else if (f.state === "accurate") score += 0.5;
  }
  return score;
}

export function shouldExpand(facts, currentLevel, op) {
  if (currentLevel >= MAX_LEVEL) return false;
  // Threshold scales relative to this op's starter level. Lowered
  // from *4 to *3 along with the new `known` state — combined effect
  // is roughly that 4 well-known facts (vs 8 accurate-only) unlock
  // the next tier on first expansion. Pace feels right for a kid
  // who's actually engaging.
  const starter = STARTER_LEVELS[op] ?? 5;
  const tiersUnlocked = Math.max(1, currentLevel - starter + 1);
  const threshold = tiersUnlocked * 3;
  return masteryScore(facts, currentLevel) >= threshold;
}

// XP = focused minutes (1 XP per minute of active engagement)
export function xpFromActiveSec(activeSec) {
  return activeSec / 60;
}

export function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- HINT GENERATOR ----------
// Returns a structured hint:
//   { strategy: string, steps: string[], instant: bool }
// "instant" hints (trivial cases) reveal all at once. Others animate step-by-step.
export function hintFor(fact) {
  switch (fact.op) {
    case "multiplication": return multHint(fact);
    case "division":       return divHint(fact);
    case "addition":       return addHint(fact);
    case "subtraction":    return subHint(fact);
    case "numbers":        return numbersHint(fact);
    default:
      return {
        strategy: `${fact.a} ${OPERATIONS[fact.op].symbol} ${fact.b}`,
        steps: [`= ${fact.answer}`],
        instant: true,
      };
  }
}

// Numbers-track hints. Reads the fact's strandHint to pick the right
// strategy. Designed to teach the conversion, not just give the answer.
function numbersHint(fact) {
  const sh = fact.strandHint;
  if (sh === "num-pct-of-100") {
    return {
      strategy: "Percent of 100 = the percent",
      steps: [`${fact.displayText} = ${fact.answer}`],
      instant: true,
    };
  }
  if (sh === "num-pct-common") {
    // Try to derive a strategy from a/b
    const pct = fact.a;
    const base = fact.b;
    if (pct === 10) return { strategy: "Move the decimal", steps: [`10% means ÷ 10`, `${base} ÷ 10 = ${fact.answer}`] };
    if (pct === 50) return { strategy: "50% = half", steps: [`${base} ÷ 2 = ${fact.answer}`] };
    if (pct === 25) return { strategy: "25% = quarter", steps: [`${base} ÷ 4 = ${fact.answer}`] };
    if (pct === 75) return { strategy: "75% = three quarters", steps: [`${base} ÷ 4 × 3 = ${fact.answer}`] };
    return { strategy: fact.displayText, steps: [`= ${fact.answer}`], instant: true };
  }
  if (sh === "num-frac-to-dec") {
    return {
      strategy: "Top divided by bottom",
      steps: [`${fact.displayText.replace(" as a decimal", "")} = top ÷ bottom`, `= ${fact.answer}`],
    };
  }
  if (sh === "num-pct-to-dec") {
    return {
      strategy: "% → divide by 100",
      steps: [`${fact.a}% ÷ 100`, `= ${fact.answer}`],
    };
  }
  if (sh === "num-frac-to-pct") {
    return {
      strategy: "Convert to /100",
      steps: [fact.displayText, `= ${fact.answer}%`],
    };
  }
  return {
    strategy: fact.displayText || "Answer",
    steps: [`= ${fact.answer}`],
    instant: true,
  };
}

function multHint({ a, b, answer }) {
  if (a === 0 || b === 0)
    return { strategy: "Anything × 0", steps: ["= 0"], instant: true };
  if (a === 1 || b === 1)
    return { strategy: "Anything × 1", steps: [`= ${answer}`], instant: true };
  if (a === b)
    return {
      strategy: `${a}² — worth memorizing`,
      steps: [`${a} × ${a} = ${answer}`],
      instant: true,
    };
  if (a === 9 || b === 9) {
    const x = a === 9 ? b : a;
    return {
      strategy: "Use ×10 − x",
      steps: [`(${x} × 10) − ${x}`, `${10 * x} − ${x}`, `${answer}`],
    };
  }
  if (a === 5 || b === 5) {
    const x = a === 5 ? b : a;
    return {
      strategy: "Half of ×10",
      steps: [`(${x} × 10) ÷ 2`, `${10 * x} ÷ 2`, `${answer}`],
    };
  }
  // Distributive split
  const small = Math.min(a, b);
  const large = Math.max(a, b);
  return {
    strategy: "Split it",
    steps: [
      `${small} × ${large - 1} + ${small}`,
      `${small * (large - 1)} + ${small}`,
      `${answer}`,
    ],
  };
}

function divHint({ a, b, answer }) {
  if (b === 1)
    return { strategy: "Anything ÷ 1", steps: [`= ${answer}`], instant: true };
  if (a === b)
    return { strategy: "Anything ÷ itself", steps: ["= 1"], instant: true };
  return {
    strategy: `Think: ? × ${b} = ${a}`,
    steps: [`${answer} × ${b} = ${a}`, `So ${a} ÷ ${b} = ${answer}`],
  };
}

function addHint({ a, b, answer }) {
  if (a === 0 || b === 0)
    return { strategy: "Anything + 0", steps: [`= ${answer}`], instant: true };
  if (a === b)
    return {
      strategy: `Doubles: ${a}+${a}`,
      steps: [`= ${answer}`],
      instant: true,
    };
  if (a === 9 || b === 9) {
    const x = a === 9 ? b : a;
    return {
      strategy: "Use +10 − 1",
      steps: [`(${x} + 10) − 1`, `${10 + x} − 1`, `${answer}`],
    };
  }
  // Make-10 for teen sums
  if (a + b > 10 && Math.max(a, b) >= 6) {
    const big = Math.max(a, b);
    const small = Math.min(a, b);
    const toTen = 10 - big;
    const remainder = small - toTen;
    if (remainder > 0) {
      return {
        strategy: "Make 10",
        steps: [
          `${big} + ${toTen} + ${remainder}`,
          `10 + ${remainder}`,
          `${answer}`,
        ],
      };
    }
  }
  return {
    strategy: "Count up",
    steps: [`Start at ${Math.max(a, b)}`, `Add ${Math.min(a, b)}`, `${answer}`],
  };
}

function subHint({ a, b, answer }) {
  if (b === 0)
    return { strategy: "Anything − 0", steps: [`= ${answer}`], instant: true };
  if (a === b)
    return { strategy: "Anything − itself", steps: ["= 0"], instant: true };
  if (b === 9) {
    return {
      strategy: "Use −10 + 1",
      steps: [`(${a} − 10) + 1`, `${a - 10} + 1`, `${answer}`],
    };
  }
  return {
    strategy: `Count up from ${b}`,
    steps: [`${b} → ${a}`, `Distance: ${answer}`],
  };
}

// ---------- FAST START PLACEMENT PROBE (2026-06-12) ----------
// A ~2-minute diagnostic for students starting an op they may already
// partially know. Samples a few facts per strand in unlock order; a
// strand "passes" if every probed fact is answered correctly within
// the op's `slow` threshold. The probe stops at the first failed
// strand (that's the placement point). All facts in passed strands
// are seeded as `known` with an SRS due date, so the strand system
// jumps the student straight to their actual frontier instead of
// grinding 3+2 for weeks. Seeded facts still have to EARN `automatic`
// through real timed reps — the probe only skips re-learning.
export const PROBE_FACTS_PER_STRAND = 2;
export const PROBE_MAX_STRANDS = 12;
export const PROBE_TIME_CAP = 3 * 60; // seconds

export function isFreshOp(persisted, op) {
  const prog = persisted.progress?.[op];
  if (!prog || !prog.facts) return true;
  return !Object.values(prog.facts).some((f) => f.attempts > 0);
}

// Ordered probe plan: [{ strandId, label, facts: [fact, ...] }]
export function buildProbePlan(facts, op) {
  const strands = STRANDS_BY_OP[op] || [];
  const plan = [];
  for (const s of strands.slice(0, PROBE_MAX_STRANDS)) {
    const members = Object.values(facts).filter((f) => f.strand === s.id);
    if (members.length === 0) continue;
    const shuffled = [...members].sort(() => Math.random() - 0.5);
    plan.push({
      strandId: s.id,
      label: s.label,
      facts: shuffled.slice(0, PROBE_FACTS_PER_STRAND),
    });
  }
  return plan;
}

// Seed every untouched fact in the passed strands as `known`.
// attempts=4/correct=4 makes determineState() stable across future
// refreshFactStates migrations (acc=1.0, attempts≥3 → known).
export function applyProbeResults(facts, passedStrandIds, today = todayKey()) {
  const passed = new Set(passedStrandIds);
  const out = { ...facts };
  for (const f of Object.values(out)) {
    if (!passed.has(f.strand)) continue;
    if (f.attempts > 0) continue; // real history wins over inference
    out[f.id] = {
      ...f,
      attempts: 4,
      correct: 4,
      wrong: 0,
      state: "known",
      lastSeenDay: today,
      srsInterval: 2,
      dueDay: addDaysToKey(today, 2),
    };
  }
  return out;
}

// ---------- CROSS-OP PREREQUISITES ----------
export function divisionUnlocked(persisted) {
  const mul = persisted.progress.multiplication;
  if (!mul) return false;
  const automatic = Object.values(mul.facts).filter(f => f.state === "automatic").length;
  return automatic >= DIVISION_UNLOCK_THRESHOLD;
}

export function divisionUnlockProgress(persisted) {
  const mul = persisted.progress.multiplication;
  if (!mul) return { current: 0, needed: DIVISION_UNLOCK_THRESHOLD };
  const automatic = Object.values(mul.facts).filter(f => f.state === "automatic").length;
  return { current: automatic, needed: DIVISION_UNLOCK_THRESHOLD };
}

// ---------- MASTERY VIEW HELPERS ----------
// Total fact count for each op — computed once at module load.
const FACT_COUNTS = {
  addition:       Object.keys(buildAddition()).length,        // 169
  subtraction:    Object.keys(buildSubtraction()).length,     // 91
  multiplication: Object.keys(buildMultiplication()).length,  // 121
  division:       Object.keys(buildDivision()).length,        // 121
};

export function totalFactCount(op) {
  return FACT_COUNTS[op] || 0;
}

// Returns { automatic, total, pct, gainedToday } for an op.
// gainedToday = unique facts that became automatic in any of today's sessions.
export function masterySummary(persisted, op) {
  const total = totalFactCount(op);
  const prog = persisted.progress[op];
  const automatic = prog
    ? Object.values(prog.facts).filter(f => f.state === "automatic").length
    : 0;

  const today = todayKey();
  const dayHistory = persisted.history && persisted.history[today];
  const ids = new Set();
  if (dayHistory && dayHistory.sessions) {
    for (const s of dayHistory.sessions) {
      if (s.op === op && Array.isArray(s.newlyAutomaticIds)) {
        s.newlyAutomaticIds.forEach((id) => ids.add(id));
      }
    }
  }

  return {
    automatic,
    total,
    pct: total > 0 ? automatic / total : 0,
    gainedToday: ids.size,
  };
}

export function isOpUnlocked(op, persisted) {
  if (op === "division") return divisionUnlocked(persisted);
  return true;
}

// ---------- DAILY RECOMMENDATION ----------
// Pick the operation most worth practicing today: largest weak-fact pool,
// excluding locked operations.
export function recommendedOp(persisted) {
  const order = ["multiplication", "division", "addition", "subtraction"];

  // Pass 1: largest weak (learning + effortful) pool
  let best = null;
  let bestWeak = 0;
  for (const op of order) {
    if (!isOpUnlocked(op, persisted)) continue;
    const prog = persisted.progress[op];
    if (!prog) continue;
    const weak = Object.values(prog.facts).filter(
      f => f.state === "learning" || f.state === "effortful"
    ).length;
    if (weak > bestWeak) {
      bestWeak = weak;
      best = op;
    }
  }
  if (best) return { op: best, reason: "your weakest" };

  // Pass 2: any unstarted unlocked op
  for (const op of order) {
    if (!isOpUnlocked(op, persisted)) continue;
    if (!persisted.progress[op]) return { op, reason: "fresh start" };
  }

  // Pass 3: any due-for-decay automatic facts
  let decayOp = null;
  let mostStale = 0;
  const today = todayKey();
  for (const op of order) {
    if (!isOpUnlocked(op, persisted)) continue;
    const prog = persisted.progress[op];
    if (!prog) continue;
    const stale = Object.values(prog.facts).filter(f => {
      if (f.state !== "automatic" || !f.lastSeenDay) return false;
      return daysBetween(f.lastSeenDay, today) >= 1;
    }).length;
    if (stale > mostStale) {
      mostStale = stale;
      decayOp = op;
    }
  }
  if (decayOp) return { op: decayOp, reason: "retention" };

  return { op: "multiplication", reason: "keep training" };
}

export function recommendationText(rec, persisted) {
  const label = OPERATIONS[rec.op].label;
  if (rec.reason === "fresh start") return `Start with ${label}`;
  if (rec.reason === "retention")   return `${label} retention`;
  if (rec.reason === "your weakest") return `${label} (your weakest)`;
  return label;
}
