// ============================================================
// READING FACTS — /api/snapshot
//
// Serves the dashboard snapshot for the orchestration layer.
// Mirrors the math-facts contract exactly:
//
//   GET /api/snapshot?student=<id>
//   →  {
//        studentId, date,
//        todayXp, weekXp, dailyGoalXp,
//        nextDrill: { label, path }
//      }
//
//   CORS: Access-Control-Allow-Origin: *, OPTIONS short-circuit.
//
// Differences vs. math-facts/api/snapshot.js:
//   • Reads from reading_sessions (this app's own table) rather than
//     the orchestration daily_progress rollup. reading-facts-app does
//     not yet write to daily_progress; if that changes later we can
//     swap the source without changing the response contract.
//   • weekXp is a true 7-day rolling sum. (math-facts currently
//     returns todayXp for both fields — a known bug there, not a
//     contract change here.)
//   • nextDrill recommends the strand most in need of practice based
//     on a lightweight aggregation of session rows; path stays "/"
//     until the reading app adds hash-routes for strand deep links.
// ============================================================

import { createClient } from "@supabase/supabase-js";

// 1 minute of focused session time = 1 XP.
// Same convention as DAILY_GOAL_XP / xpFromSec in src/app.js, and the
// universal "1 XP = 1 minute focused" definition in the orchestration
// schema's practice_sessions.xp_earned column.
const DAILY_GOAL_XP = 5;

// Strand metadata, copied from STRANDS in src/app.js. Inlined here so
// the function has zero filesystem reads at runtime. If you change
// either copy, change both.
const STRAND_ORDER = ["phonics", "pa", "blending", "sight", "vocab", "pictures"];
const STRANDS = {
  phonics:  { label: "Phonics",         description: "Letter sounds & decoding" },
  sight:    { label: "Sight Words",     description: "Instant word recognition" },
  pa:       { label: "Phoneme Sounds",  description: "Listen, blend, swap" },
  blending: { label: "Blending",        description: "Sounds into words" },
  vocab:    { label: "Vocabulary",      description: "Word meanings" },
  pictures: { label: "Picture Words",   description: "See it, read it" },
};

// duration_sec → XP, rounded to one decimal (e.g. 90s → 1.5 XP).
// Mirrors xpFromSec in src/app.js exactly.
function xpFromSec(sec) {
  return Math.round((sec / 60) * 10) / 10;
}

// Denver-local "today" as YYYY-MM-DD. Identical helper to math-facts.
function todayInDenverISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Start-of-day in America/Denver as a UTC ISO timestamp, optionally
// offset by `daysAgo`. Used as the lower bound on completed_at.
//
// We use a fixed UTC-6 offset (MDT) which is correct from mid-March
// through early November and one hour early during MST. Erring early
// is safe — we'll include rows from the last hour of "yesterday" on
// the four-month MST window, which is acceptable for a dashboard
// rollup. If we need exact DST-aware boundaries later, swap this for
// a proper timezone library.
function startOfDenverDayISO(daysAgo = 0) {
  const denverDate = todayInDenverISO();          // e.g. "2026-05-03"
  const [y, m, d] = denverDate.split("-").map(Number);
  const utcMs = Date.UTC(y, m - 1, d, 6, 0, 0);   // 06:00 UTC ≈ Denver midnight (MDT)
  return new Date(utcMs - daysAgo * 86400000).toISOString();
}

// Recommend the strand most in need of practice, given an aggregation
// of session rows by strand. Two-tier logic:
//   1. Any strand with zero practice in the window → recommend it,
//      using STRAND_ORDER as tie-breaker (phonics first, etc.).
//   2. Otherwise pick the strand with the lowest mastered/attempts
//      ratio among practiced strands.
//   3. Empty input (no sessions at all) → start with phonics.
function pickNextDrill(perStrand) {
  for (const id of STRAND_ORDER) {
    const s = perStrand[id];
    if (!s || s.sessions === 0) return formatDrill(id);
  }
  let worstId = STRAND_ORDER[0];
  let worstRate = Infinity;
  for (const id of STRAND_ORDER) {
    const s = perStrand[id];
    const rate = s.attempts > 0 ? s.mastered / s.attempts : 0;
    if (rate < worstRate) {
      worstRate = rate;
      worstId = id;
    }
  }
  return formatDrill(worstId);
}

function formatDrill(strandId) {
  const meta = STRANDS[strandId];
  return {
    label: `${meta.label} — ${meta.description}`,
    path: "/",
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  const studentId = req.query.student;
  if (!studentId) {
    return res.status(400).json({ error: "missing ?student=<id>" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const startOfToday = startOfDenverDayISO(0);
    const startOfWeek  = startOfDenverDayISO(6); // 7-day window inclusive of today

    // Pull the last 7 days of sessions for this student in one query.
    // We need per-day duration_sec (today vs. week) plus per-strand
    // attempts/mastered for the recommendation.
    const { data: rows, error } = await supabase
      .from("reading_sessions")
      .select("duration_sec, total_attempts, mastered_count, strand, completed_at")
      .eq("student_id", studentId)
      .gte("completed_at", startOfWeek);

    if (error) throw error;

    let todaySec = 0;
    let weekSec  = 0;
    const perStrand = Object.create(null);

    for (const r of rows || []) {
      const dur = r.duration_sec || 0;
      weekSec += dur;
      // ISO strings sort lexically the same as chronologically, so a
      // direct string compare against startOfToday is correct.
      if (r.completed_at >= startOfToday) todaySec += dur;

      const key = r.strand || "_unstranded";
      if (!perStrand[key]) {
        perStrand[key] = { sessions: 0, attempts: 0, mastered: 0 };
      }
      perStrand[key].sessions += 1;
      perStrand[key].attempts += r.total_attempts || 0;
      perStrand[key].mastered += r.mastered_count || 0;
    }

    return res.status(200).json({
      studentId,
      date: todayInDenverISO(),
      todayXp: xpFromSec(todaySec),
      weekXp:  xpFromSec(weekSec),
      dailyGoalXp: DAILY_GOAL_XP,
      nextDrill: pickNextDrill(perStrand),
    });
  } catch (err) {
    return res.status(500).json({
      error: "snapshot fetch failed",
      details: err.message,
    });
  }
}

// Exported for unit testing — not part of the HTTP surface.
export const __test__ = {
  xpFromSec,
  todayInDenverISO,
  startOfDenverDayISO,
  pickNextDrill,
  STRAND_ORDER,
  STRANDS,
  DAILY_GOAL_XP,
};
