// ---------- CONFIG ----------
export const OPERATIONS = {
  addition:       { key: "addition",       symbol: "+", label: "Addition" },
  subtraction:    { key: "subtraction",    symbol: "−", label: "Subtraction" },
  multiplication: { key: "multiplication", symbol: "×", label: "Multiplication" },
  division:       { key: "division",       symbol: "÷", label: "Division" },
};

// Per-operation latency thresholds (ms).
// Recalibrated 2026-05-18 from Isaac's real session data — old values
// were physically unreachable for a 4th-grader typing answers on a
// keyboard. Sample:
//   addition p25 = 1179 ms (old fast was 1100 → 0 facts ever automatic)
//   subtraction p25 = 1146 ms (old fast was 1100 → 0 facts ever automatic)
//   multiplication p25 = 1520 ms (old fast was 1500 → just barely)
// New `fast` lives at roughly the kid's p50 so a fluent fact CAN go
// automatic. `slow` lives at roughly p75 so genuinely slow attempts
// still get the "Correct, slow" coaching feedback.
export const THRESHOLDS = {
  addition:       { fast: 1500, slow: 2500 },
  subtraction:    { fast: 1500, slow: 2500 },
  multiplication: { fast: 2000, slow: 3200 },
  division:       { fast: 2300, slow: 3800 },
};

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
  const facts = {};
  for (let a = 2; a <= 12; a++) {
    for (let b = 2; b <= 12; b++) {
      const id = `mul-${a}x${b}`;
      facts[id] = { id, op: "multiplication", a, b, answer: a * b, difficulty: Math.max(a, b), ...emptyTracking() };
    }
  }
  return facts;
}

function buildDivision() {
  // a / b = q where a = b*q, b and q in 2..12
  const facts = {};
  for (let q = 2; q <= 12; q++) {
    for (let b = 2; b <= 12; b++) {
      const a = b * q;
      const id = `div-${a}d${b}`;
      facts[id] = { id, op: "division", a, b, answer: q, difficulty: Math.max(b, q), ...emptyTracking() };
    }
  }
  return facts;
}

export function buildFacts(op) {
  switch (op) {
    case "addition":       return buildAddition();
    case "subtraction":    return buildSubtraction();
    case "multiplication": return buildMultiplication();
    case "division":       return buildDivision();
    default: return {};
  }
}

export function initialProgress(op) {
  return { facts: buildFacts(op), currentLevel: STARTER_LEVELS[op] };
}

// ---------- LOGIC ----------
export function classify(correct, latency, op) {
  const t = THRESHOLDS[op];
  if (!correct) return "wrong";
  if (latency <= t.fast) return "fast";
  if (latency <= t.slow) return "slow";
  return "tooSlow";
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

export function determineState(fact, op) {
  if (fact.attempts < 3) return "unknown";
  const acc = accuracyOf(fact);
  const fastT = THRESHOLDS[op].fast;
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

// Spaced-repetition decay for mastered facts.
// Mastered facts that haven't been seen in days bubble back up for retention reps.
function decayBoost(fact, today) {
  if (!fact.lastSeenDay) return 0;
  if (fact.state !== "automatic" && fact.state !== "accurate") return 0;
  const days = daysBetween(fact.lastSeenDay, today);
  if (days <= 0) return 0;
  if (days === 1) return 12;   // next-day check
  if (days <= 3)  return 25;   // 2–3 days
  if (days <= 7)  return 45;   // within a week
  return 65;                   // ≥ 1 week — urgent retention
}

function priorityFor(fact, op, today) {
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
  if (fact.lastLatency && fact.lastLatency > THRESHOLDS[op].slow) p += 15;
  p += recencyBoost(fact.lastSeenAt);
  p += decayBoost(fact, today);
  return p;
}

export function selectNextFact(facts, lastId, currentLevel, op) {
  const today = todayKey();
  const pool = Object.values(facts).filter(f => f.difficulty <= currentLevel && f.id !== lastId);
  if (pool.length === 0) {
    return Object.values(facts).filter(f => f.id !== lastId)[0] || Object.values(facts)[0];
  }
  const scored = pool.map(f => ({ fact: f, p: priorityFor(f, op, today) }));
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

export function applyAttempt(fact, result, latency, op) {
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
  updated.state = determineState(updated, op);
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
    default:
      return {
        strategy: `${fact.a} ${OPERATIONS[fact.op].symbol} ${fact.b}`,
        steps: [`= ${fact.answer}`],
        instant: true,
      };
  }
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
