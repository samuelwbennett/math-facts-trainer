// Storage layer — Supabase is the source of truth, localStorage is an offline cache.
// The in-memory `state` shape is preserved from the previous version so the rest of
// the app doesn't need to change:
//   { progress: { addition, subtraction, multiplication, division }, history: { [day]: { totalActiveSec, sessions[] } } }

import { supabase } from "./supabase";
import {
  determineState,
  LATENCY_CAP_MS,
  buildFacts,
  addDaysToKey,
  emptyCalibration,
  thresholdsFor,
  updateOpCalibration,
  higherState,
  CALIB_MIN_SAMPLES,
} from "./engine";
import { strandIdFor } from "./curriculum";

const APP_SLUG = "math_facts";
const HISTORY_DAYS = 30; // how many days of history to load up front
const cacheKeyFor = (studentId) => `vpa-mathfacts-cache:${studentId}`;

// ---------- DATE HELPERS (sync, used by UI) ----------
export function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function yesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return todayKey(d);
}

export function getTodayHistory(state) {
  return state.history[todayKey()] || { totalActiveSec: 0, sessions: [] };
}

// Day streak with protection (2026-06-12):
//   - Today not yet practiced doesn't zero the streak (it just
//     doesn't count yet) — the old version showed 0 every morning.
//   - Weekends are exempt: practicing Sat/Sun extends the streak,
//     skipping them never breaks it.
//   - One automatic "freeze": a single missed weekday is forgiven,
//     as long as no other miss was forgiven within the prior 7 days.
// Why: streaks motivate through loss aversion, but a streak that dies
// to one sick day teaches kids to stop caring about it entirely.
export function dayStreak(state) {
  const activeOn = (d) => {
    const day = state.history[todayKey(d)];
    return !!(day && day.totalActiveSec > 0);
  };
  const dayDiff = (k1, k2) =>
    Math.round((new Date(k2 + "T00:00:00Z") - new Date(k1 + "T00:00:00Z")) / 86400000);

  let streak = 0;
  const d = new Date();
  if (!activeOn(d)) d.setDate(d.getDate() - 1); // today pending, not a miss

  const forgiven = [];
  for (let guard = 0; guard < 1000; guard++) {
    const key = todayKey(d);
    const dow = d.getDay(); // 0 = Sun, 6 = Sat
    if (activeOn(d)) {
      streak += 1;
    } else if (dow === 0 || dow === 6) {
      // weekend pause — neither counts nor breaks
    } else {
      // weekday miss — forgive once per rolling 7 days, and only if
      // there's an actual streak behind it to protect
      const freezeAvailable =
        streak > 0 && !forgiven.some((fk) => Math.abs(dayDiff(key, fk)) < 7);
      if (!freezeAvailable) break;
      forgiven.push(key);
    }
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

export function defaultState() {
  return {
    progress: {
      addition: null,
      subtraction: null,
      multiplication: null,
      division: null,
    },
    // Per-student latency calibration (2026-06-13). Empty until the
    // student answers correctly a few times; thresholdsFor falls back
    // to the global prior in the meantime.
    calibration: emptyCalibration(),
    history: {},
  };
}

// ---------- APP ID CACHE ----------
// The math_facts row in learning_apps never changes its id, so cache it
// for the whole session to avoid an extra round-trip on every save.
let _appIdPromise = null;
function getAppId() {
  if (!_appIdPromise) {
    _appIdPromise = supabase
      .from("learning_apps")
      .select("id")
      .eq("slug", APP_SLUG)
      .single()
      .then(({ data, error }) => {
        if (error) throw error;
        return data.id;
      });
  }
  return _appIdPromise;
}

// ---------- LOAD ----------
// Async load student state from Supabase, with localStorage fallback for offline.
export async function loadStudentState(studentId) {
  if (!studentId) return defaultState();

  try {
    const appId = await getAppId();

    const [accountRes, sessionsRes] = await Promise.all([
      supabase
        .from("student_app_accounts")
        .select("state")
        .eq("student_id", studentId)
        .eq("app_id", appId)
        .maybeSingle(),
      (() => {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - HISTORY_DAYS);
        return supabase
          .from("practice_sessions")
          .select(
            "context, started_at, ended_at, active_seconds, duration_seconds, attempts, correct, xp_earned, metrics"
          )
          .eq("student_id", studentId)
          .eq("app_id", appId)
          .gte("started_at", cutoff.toISOString())
          .order("started_at", { ascending: true });
      })(),
    ]);

    if (accountRes.error && accountRes.error.code !== "PGRST116") {
      throw accountRes.error;
    }
    if (sessionsRes.error) throw sessionsRes.error;

    const progress = accountRes.data?.state?.progress || defaultState().progress;
    let calibration = accountRes.data?.state?.calibration || emptyCalibration();

    const history = {};
    for (const s of sessionsRes.data || []) {
      const day = s.started_at.slice(0, 10);
      if (!history[day]) history[day] = { totalActiveSec: 0, sessions: [] };
      history[day].totalActiveSec += s.active_seconds || 0;
      history[day].sessions.push({
        op: s.context,
        activeSec: s.active_seconds || 0,
        durationSec: s.duration_seconds || 0,
        attempts: s.attempts || 0,
        correct: s.correct || 0,
        xp: parseFloat(s.xp_earned) || 0,
        avgLatencyMs: s.metrics?.avgLatencyMs || 0,
        accuracy: s.metrics?.accuracy || 0,
        speed: s.metrics?.speed || 0,
        fastCount: s.metrics?.fastCount || 0,
        newlyAutomaticIds: s.metrics?.newlyAutomaticIds || [],
        newlyAutomaticCount: s.metrics?.newlyAutomaticCount || 0,
        when: new Date(s.started_at).getTime(),
      });
    }

    // Bootstrap calibration for students whose stored buffer is empty
    // or sparse (i.e. everyone, until they practice after this ships).
    // We don't keep raw per-attempt latencies in practice_sessions, but
    // each session row carries its mean correct latency — seeding those
    // session means gives an immediate, student-specific baseline that's
    // far better than Isaac's global numbers. Means under-disperse the
    // true distribution, so this is only a prior: thresholdsFor still
    // shrinks it toward the global default by sample count and clamps.
    calibration = seedCalibrationFromHistory(calibration, sessionsRes.data || []);

    // Migration pass — re-evaluate every existing fact's state with the
    // current engine logic AND the student's calibrated thresholds.
    // Promote-only (see refreshFactStates) so a tightened personal bar
    // never strips previously-earned mastery on reload. Also caps
    // over-stored latencies (old data may include 22-min walk-aways).
    refreshFactStates(progress, calibration);

    const state = { progress, calibration, history };
    cacheLocally(studentId, state);
    return state;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("Supabase load failed, using local cache:", e);
    return loadFromCache(studentId);
  }
}

// Walk the loaded progress and re-classify every fact with the
// current engine logic + tag with sub-strand. Idempotent — safe to
// call on every load. Three things it does:
//   1. Caps stored latencies so a pre-fix walk-away (22-min pause)
//      gets corrected.
//   2. Re-runs determineState so old `state` values written under
//      pre-2026-05-18 logic get upgraded to the new ladder.
//   3. Tags every fact with its sub-strand (from curriculum.js).
//      Old persisted facts didn't have this field — without it the
//      strand UI shows everything as "uncategorized" until each fact
//      is touched again.
// Seed per-op calibration buffers from historical session means.
// Only fills ops whose stored buffer is still below CALIB_MIN_SAMPLES,
// so once a student has accumulated real per-attempt samples this is a
// no-op and never overwrites the live buffer. Pure-ish: returns a new
// calibration object. Sessions are processed oldest→newest (caller
// orders them ascending) so the rolling buffer keeps the most recent.
function seedCalibrationFromHistory(calibration, sessionRows) {
  const calib = { ...(calibration || emptyCalibration()) };
  const byOp = {};
  for (const s of sessionRows) {
    const op = s.context;
    const lat = s.metrics?.avgLatencyMs;
    if (!op || !lat || lat <= 0) continue;
    (byOp[op] = byOp[op] || []).push(lat);
  }
  for (const op of Object.keys(byOp)) {
    const existing = calib[op]?.samples?.length || 0;
    if (existing >= CALIB_MIN_SAMPLES) continue; // real data already present
    calib[op] = updateOpCalibration(calib[op], byOp[op]);
  }
  return calib;
}

function refreshFactStates(progress, calibration) {
  if (!progress) return;
  for (const op of Object.keys(progress)) {
    // If the student has never started this op, progress[op] is
    // `null` (initial defaultState shape). Initialize it now so the
    // home screen's strand strip has something to show without
    // needing a session start. STARTER_LEVELS used to live in
    // engine.js — we don't import it here to avoid a circular dep,
    // since defaultStarterLevel() inlines the same values.
    if (!progress[op] || !progress[op].facts) {
      progress[op] = {
        facts: buildFacts(op),
        currentLevel: defaultStarterLevel(op),
      };
    }
    const facts = progress[op].facts;
    const thr = thresholdsFor(calibration, op);

    // 0. Merge in any new facts that aren't in the persisted dict
    //    (e.g., the 2-digit pools introduced in Phase 2). Existing
    //    facts keep their attempts/state/latency — we just ADD any
    //    new entries from the current buildFacts(op). Without this,
    //    a kid who built progress under the old 0-12 schema would
    //    never see the new 2-digit strands.
    const canonical = buildFacts(op);
    for (const id of Object.keys(canonical)) {
      if (!facts[id]) {
        facts[id] = canonical[id];
      }
    }

    for (const id of Object.keys(facts)) {
      const f = facts[id];
      if (!f) continue;
      if (f.avgLatency && f.avgLatency > LATENCY_CAP_MS) {
        f.avgLatency = LATENCY_CAP_MS;
      }
      if (f.lastLatency && f.lastLatency > LATENCY_CAP_MS) {
        f.lastLatency = LATENCY_CAP_MS;
      }
      if (f.attempts > 0) {
        // Promote-only on reload: re-classify with the student's
        // calibrated thresholds, but never drop below the persisted
        // mastery rank. This lets a loosened bar upgrade a fact (e.g.
        // a slow-typer's `known` fact finally reads as `automatic`)
        // while a tightened bar can't retroactively strip mastery a
        // student already earned — which would dent the reported
        // automatic %. Live play (applyAttempt) still moves both ways.
        const reclassified = determineState(f, op, thr);
        f.state = higherState(f.state || "unknown", reclassified);
      }
      // Tag (or re-tag) the strand. Cheap — pure function over (op, a, b).
      f.strand = strandIdFor(op, f);

      // Confusion-pair coach (2026-06-13): facts persisted before this
      // shipped have no wrongAnswers tally. Default it so the coach's
      // reads never hit undefined.
      if (!f.wrongAnswers) f.wrongAnswers = {};

      // 4. SRS seeding (2026-06-12) — facts persisted before the
      //    scheduler existed get an interval/due-day inferred from
      //    their state + last-seen day. One-time, idempotent.
      if (f.srsInterval === undefined || f.srsInterval === null) {
        if (f.state === "automatic") f.srsInterval = 4;
        else if (f.state === "known" || f.state === "accurate") f.srsInterval = 2;
        else f.srsInterval = 0;
        f.dueDay =
          f.srsInterval > 0
            ? addDaysToKey(f.lastSeenDay || todayKey(), f.srsInterval)
            : null;
      }
    }
  }
}

// Default starter level per op — mirrors STARTER_LEVELS in engine.js,
// inlined to avoid an import cycle. Used only when initializing an
// op that the student hasn't touched yet.
function defaultStarterLevel(op) {
  return { addition: 3, subtraction: 4, multiplication: 5, division: 5 }[op] || 5;
}

function cacheLocally(studentId, state) {
  try {
    localStorage.setItem(cacheKeyFor(studentId), JSON.stringify(state));
  } catch {
    // ignore quota / private mode errors
  }
}

function loadFromCache(studentId) {
  try {
    const raw = localStorage.getItem(cacheKeyFor(studentId));
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return defaultState();
}

// ---------- RECORD SESSION ----------
// Pure: builds the next in-memory state.
// Side effects: caches locally + fires off Supabase writes (non-blocking).
export function recordSession(studentId, state, sessionStats, factsAfter, levelAfter) {
  const op = sessionStats.op;
  const dayKey = todayKey();
  const day = state.history[dayKey] || { totalActiveSec: 0, sessions: [] };

  const updatedDay = {
    totalActiveSec: (day.totalActiveSec || 0) + sessionStats.activeSec,
    sessions: [...day.sessions, { ...sessionStats, when: Date.now() }],
  };

  // Fold this session's correct-answer latencies into the student's
  // calibration buffer for this op. These are real per-attempt samples
  // (not session means), so they progressively replace any bootstrap
  // seed and let the personal fast/slow line track the student.
  const prevCalib = state.calibration || emptyCalibration();
  const newCalibration = {
    ...prevCalib,
    [op]: updateOpCalibration(prevCalib[op], sessionStats.correctLatencies || []),
  };

  const newState = {
    ...state,
    progress: {
      ...state.progress,
      [op]: { facts: factsAfter, currentLevel: levelAfter },
    },
    calibration: newCalibration,
    history: { ...state.history, [dayKey]: updatedDay },
  };

  cacheLocally(studentId, newState);

  // Fire-and-forget server write. UI is already updated from the returned state.
  saveSessionToSupabase(studentId, sessionStats, newState.progress, newCalibration).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn("Supabase save failed (cached locally; will retry on next load):", e);
  });

  return newState;
}

async function saveSessionToSupabase(studentId, s, fullProgress, calibration) {
  const appId = await getAppId();

  // 1. Upsert per-app persistent state (progress + latency calibration).
  const accountWrite = supabase
    .from("student_app_accounts")
    .upsert(
      {
        student_id: studentId,
        app_id: appId,
        state: { progress: fullProgress, calibration },
      },
      { onConflict: "student_id,app_id" }
    );

  // 2. Insert the practice session row.
  const startedAt = new Date(Date.now() - s.durationSec * 1000).toISOString();
  const endedAt = new Date().toISOString();
  const sessionWrite = supabase.from("practice_sessions").insert({
    student_id: studentId,
    app_id: appId,
    context: s.op,
    started_at: startedAt,
    ended_at: endedAt,
    active_seconds: Math.round(s.activeSec || 0),
    duration_seconds: Math.round(s.durationSec || 0),
    attempts: s.attempts || 0,
    correct: s.correct || 0,
    xp_earned: s.xp || 0,
    metrics: {
      fastCount: s.fastCount || 0,
      avgLatencyMs: s.avgLatencyMs || 0,
      accuracy: s.accuracy || 0,
      speed: s.speed || 0,
      newlyAutomaticIds: s.newlyAutomaticIds || [],
      newlyAutomaticCount: s.newlyAutomaticCount || 0,
    },
  });

  await Promise.all([accountWrite, sessionWrite]);

  // 3. Update daily_progress (read-modify-write; tolerable here because
  //    one student rarely writes concurrently from multiple devices).
  const today = todayKey();
  const { data: existing } = await supabase
    .from("daily_progress")
    .select("total_xp, total_active_seconds, total_attempts, total_correct, per_app")
    .eq("student_id", studentId)
    .eq("day", today)
    .maybeSingle();

  const perApp = existing?.per_app || {};
  const cur = perApp[APP_SLUG] || {
    xp: 0,
    active_seconds: 0,
    attempts: 0,
    correct: 0,
    mastered: 0,
  };
  perApp[APP_SLUG] = {
    xp: (cur.xp || 0) + (s.xp || 0),
    active_seconds: (cur.active_seconds || 0) + Math.round(s.activeSec || 0),
    attempts: (cur.attempts || 0) + (s.attempts || 0),
    correct: (cur.correct || 0) + (s.correct || 0),
    mastered: (cur.mastered || 0) + (s.newlyAutomaticCount || 0),
  };

  await supabase.from("daily_progress").upsert(
    {
      student_id: studentId,
      day: today,
      total_xp: (parseFloat(existing?.total_xp) || 0) + (s.xp || 0),
      total_active_seconds:
        (existing?.total_active_seconds || 0) + Math.round(s.activeSec || 0),
      total_attempts: (existing?.total_attempts || 0) + (s.attempts || 0),
      total_correct: (existing?.total_correct || 0) + (s.correct || 0),
      per_app: perApp,
    },
    { onConflict: "student_id,day" }
  );
}
