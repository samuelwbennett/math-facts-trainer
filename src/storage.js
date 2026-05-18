// Storage layer — Supabase is the source of truth, localStorage is an offline cache.
// The in-memory `state` shape is preserved from the previous version so the rest of
// the app doesn't need to change:
//   { progress: { addition, subtraction, multiplication, division }, history: { [day]: { totalActiveSec, sessions[] } } }

import { supabase } from "./supabase";
import { determineState, LATENCY_CAP_MS, buildFacts } from "./engine";
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

export function dayStreak(state) {
  let streak = 0;
  const d = new Date();
  while (true) {
    const key = todayKey(d);
    const day = state.history[key];
    if (day && day.totalActiveSec > 0) {
      streak += 1;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
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

    // Migration pass — re-evaluate every existing fact's state with
    // the current engine logic. Without this, students who built
    // progress under old thresholds (or before the new `known`
    // state was introduced) keep stale `state` values until they
    // happen to answer each fact again. Also caps over-stored
    // latencies (old data may include 22-min walk-aways).
    refreshFactStates(progress);

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

    const state = { progress, history };
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
function refreshFactStates(progress) {
  if (!progress) return;
  for (const op of Object.keys(progress)) {
    const facts = progress[op]?.facts;
    if (!facts) continue;

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
        f.state = determineState(f, op);
      }
      // Tag (or re-tag) the strand. Cheap — pure function over (op, a, b).
      f.strand = strandIdFor(op, f);
    }
  }
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

  const newState = {
    ...state,
    progress: {
      ...state.progress,
      [op]: { facts: factsAfter, currentLevel: levelAfter },
    },
    history: { ...state.history, [dayKey]: updatedDay },
  };

  cacheLocally(studentId, newState);

  // Fire-and-forget server write. UI is already updated from the returned state.
  saveSessionToSupabase(studentId, sessionStats, newState.progress).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn("Supabase save failed (cached locally; will retry on next load):", e);
  });

  return newState;
}

async function saveSessionToSupabase(studentId, s, fullProgress) {
  const appId = await getAppId();

  // 1. Upsert per-app persistent state (the math facts progress object).
  const accountWrite = supabase
    .from("student_app_accounts")
    .upsert(
      {
        student_id: studentId,
        app_id: appId,
        state: { progress: fullProgress },
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
