// ============================================================
// MASTERY — per-student, per-atom learning state.
//
// Owns the atom-level mastery probability that the Phase 1 framework
// requires (Pattern 1 from Phase 2: "mastery is a checkpoint, not a
// probability" — we fix that here).
//
// In-memory cache for fast reads during a quiz; writes back to
// Supabase asynchronously after every attempt so state survives
// across sessions and devices.
//
// Guest mode skips persistence entirely (no studentId to attach to).
// ============================================================

import { supabase } from "./supabase.js";

// {atomId → row} for the currently loaded student.
let cache = new Map();
let currentStudentId = null;

// EMA factors for updating the mastery score.
const MASTERED_BUMP = 0.40; // correct + fast → strong move toward 1
const KNOWN_BUMP    = 0.28; // correct + slow + high prior accuracy → mid move
const ACCURATE_BUMP = 0.15; // correct + slow + learning phase → small move
const WRONG_DECAY   = 0.50; // incorrect → halve

// A score this high counts the atom as "mastered" for aggregate stats.
const MASTERY_THRESHOLD = 0.7;

// Latency cap (ms). Diagnosed in Math Facts Phase 1: walk-aways
// poisoned avg_latency forever (saw a 22-min pause). Cap stored
// values so a single bathroom break can't permanently bar an atom
// from mastery.
const LATENCY_CAP_MS = 8000;

// "Known" bump-eligibility: an atom counts as "known" — i.e. the
// kid demonstrably knows the answer, just doesn't tap quickly —
// when they have ≥ 3 attempts at ≥ 85% accuracy. Below either
// threshold, correct-slow attempts use the smaller ACCURATE_BUMP
// (learning-phase pace).
function isInKnownPhase(row) {
  if (!row || row.attempts < 3) return false;
  const acc = row.correct / row.attempts;
  return acc >= 0.85;
}

// Load all mastery rows for one student into the in-memory cache.
// Call this once when the student is selected (in routeAfterAuth /
// pickStudent / enterGuestMode). Does nothing for guest mode.
export async function loadMastery(studentId) {
  cache = new Map();
  currentStudentId = studentId || null;

  if (!studentId || studentId === "guest" || String(studentId).startsWith("local-")) {
    return; // no persistence for guests / local-only ids
  }

  const { data, error } = await supabase
    .from("reading_mastery")
    .select("*")
    .eq("student_id", studentId);

  if (error) {
    console.warn("Failed to load reading mastery:", error.message);
    return;
  }

  for (const row of data || []) {
    cache.set(row.atom_id, row);
  }
  // One-time legacy-data hygiene: cap any historical over-cap
  // latencies so future avg calculations don't drag the kid down.
  // Doesn't write back — the next recordAttempt naturally persists
  // corrected values; this just keeps the in-memory cache honest.
  capLatenciesInCache();
}

function capLatenciesInCache() {
  for (const row of cache.values()) {
    if (row.avg_latency_ms && row.avg_latency_ms > LATENCY_CAP_MS) {
      row.avg_latency_ms = LATENCY_CAP_MS;
    }
    if (row.last_latency_ms && row.last_latency_ms > LATENCY_CAP_MS) {
      row.last_latency_ms = LATENCY_CAP_MS;
    }
  }
}

// Mastery score (0..1) for an atom. 0 if never seen.
export function getMasteryScore(atomId) {
  return cache.get(atomId)?.mastery_score ?? 0;
}

// Has this student ever attempted any atom? Used to decide whether to
// run the diagnostic placement quiz on first session.
export function hasAnyMastery() {
  return cache.size > 0;
}

// How many atoms has this student mastered overall (score ≥ threshold)?
export function masteredAtomCount() {
  let n = 0;
  for (const row of cache.values()) {
    if (row.mastery_score >= MASTERY_THRESHOLD) n++;
  }
  return n;
}

// Record one attempt for an atom. Updates the cache immediately so the
// next pickNextQuestion call sees fresh state, then writes to Supabase
// in the background. Returns the (possibly updated) row.
export async function recordAttempt(atomId, verdict, latencyMs) {
  if (!currentStudentId || currentStudentId === "guest"
      || String(currentStudentId).startsWith("local-")) {
    return null;
  }

  const existing = cache.get(atomId) || {
    student_id: currentStudentId,
    atom_id: atomId,
    attempts: 0,
    correct: 0,
    mastered: 0,
    last_latency_ms: 0,
    avg_latency_ms: 0,
    mastery_score: 0,
  };

  // Cap stored latency so a walk-away (e.g. 22-min pause) doesn't
  // poison avg_latency_ms permanently. The classifyAnswer caller
  // already saw the real latency for its verdict; we only cap what
  // we persist.
  const cappedLat = Math.min(latencyMs, LATENCY_CAP_MS);

  const next = { ...existing };
  next.attempts        = (existing.attempts || 0) + 1;
  next.last_latency_ms = cappedLat;
  next.last_attempt_at = new Date().toISOString();
  next.avg_latency_ms  = Math.round(
    ((existing.avg_latency_ms || 0) * (existing.attempts || 0) + cappedLat) /
    next.attempts
  );

  if (verdict === "mastered") {
    next.correct  = (existing.correct || 0) + 1;
    next.mastered = (existing.mastered || 0) + 1;
    next.mastery_score =
      existing.mastery_score + (1 - existing.mastery_score) * MASTERED_BUMP;
  } else if (verdict === "accurate") {
    next.correct = (existing.correct || 0) + 1;
    // Pick the bump based on prior phase. A kid in the "known" phase
    // (≥3 attempts at ≥85% acc) gets a meaningful move toward mastery
    // even when slow — they know it cold, the keyboard/screen is just
    // a tax. Kids still learning get the smaller bump.
    const bump = isInKnownPhase(existing) ? KNOWN_BUMP : ACCURATE_BUMP;
    next.mastery_score =
      existing.mastery_score + (1 - existing.mastery_score) * bump;
  } else {
    next.mastery_score = existing.mastery_score * WRONG_DECAY;
  }
  next.mastery_score = clamp01(next.mastery_score);

  cache.set(atomId, next);

  // Persist asynchronously. Don't block the UI on the write.
  supabase
    .from("reading_mastery")
    .upsert(next, { onConflict: "student_id,atom_id" })
    .then(({ error }) => {
      if (error) console.warn("Failed to save reading mastery:", error.message);
    });

  return next;
}

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
