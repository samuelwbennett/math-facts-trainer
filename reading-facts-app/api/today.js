// ============================================================
// READING FACTS — /api/today
//
// VPA Orchestration Contract v1.0 — top recommendation for today.
// Same shape as reading-academy/api/_handlers/today.js and
// math-facts-trainer-react/api/today.js. Aggregates the last 7 days
// of reading_sessions by strand and recommends the one most in
// need of practice (matching the snapshot endpoint's pickNextDrill).
// ============================================================

import { createClient } from "@supabase/supabase-js";

const CONTRACT_VERSION = "1.0";
const APP_SLUG = "reading_facts";
const DAILY_GOAL_XP = 5;

const STRAND_ORDER = ["phonics", "pa", "blending", "sight", "vocab", "pictures"];
const STRANDS = {
  phonics:  { label: "Phonics",         description: "Letter sounds & decoding" },
  sight:    { label: "Sight Words",     description: "Instant word recognition" },
  pa:       { label: "Phoneme Sounds",  description: "Listen, blend, swap" },
  blending: { label: "Blending",        description: "Sounds into words" },
  vocab:    { label: "Vocabulary",      description: "Word meanings" },
  pictures: { label: "Picture Words",   description: "See it, read it" },
};

function xpFromSec(sec) {
  return Math.round((sec / 60) * 10) / 10;
}

function todayInDenverISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function startOfDenverDayISO(daysAgo = 0) {
  const denverDate = todayInDenverISO();
  const [y, m, d] = denverDate.split("-").map(Number);
  const utcMs = Date.UTC(y, m - 1, d, 6, 0, 0);
  return new Date(utcMs - daysAgo * 86400000).toISOString();
}

function pickStrand(perStrand) {
  // Same logic as snapshot.js so the launcher is consistent.
  for (const id of STRAND_ORDER) {
    const s = perStrand[id];
    if (!s || s.sessions === 0) return id;
  }
  let worstId = STRAND_ORDER[0];
  let worstRate = Infinity;
  for (const id of STRAND_ORDER) {
    const s = perStrand[id];
    const rate = s.attempts > 0 ? s.mastered / s.attempts : 0;
    if (rate < worstRate) { worstRate = rate; worstId = id; }
  }
  return worstId;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-VPA-Contract-Version", CONTRACT_VERSION);
  res.setHeader("Cache-Control", "no-cache");
  if (req.method === "OPTIONS") return res.status(204).end();

  const studentId = req.query.student;
  if (!studentId) return res.status(400).json({ error: "missing ?student=<id>" });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "supabase env not configured" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    const startOfToday = startOfDenverDayISO(0);
    const startOfWeek  = startOfDenverDayISO(6);

    const { data: rows, error } = await supabase
      .from("reading_sessions")
      .select("duration_sec, total_attempts, mastered_count, strand, completed_at")
      .eq("student_id", studentId)
      .gte("completed_at", startOfWeek);
    if (error) throw error;

    let todaySec = 0;
    const perStrand = Object.create(null);
    for (const r of (rows || [])) {
      const dur = r.duration_sec || 0;
      if (r.completed_at >= startOfToday) todaySec += dur;
      const key = r.strand || "_unstranded";
      if (!perStrand[key]) perStrand[key] = { sessions: 0, attempts: 0, mastered: 0 };
      perStrand[key].sessions += 1;
      perStrand[key].attempts += r.total_attempts || 0;
      perStrand[key].mastered += r.mastered_count || 0;
    }

    const todayXp = xpFromSec(todaySec);

    if (todayXp >= DAILY_GOAL_XP) {
      return res.status(200).json({
        studentId, appId: APP_SLUG,
        recommendation: {
          kind: "none",
          headline: "All caught up today",
          subtitle: `${todayXp.toFixed(1)} XP earned — see you tomorrow.`,
          estimatedMinutes: 0, priority: "low",
          path: "/", reason: "goal_met",
        },
        blocksRemaining: 0,
      });
    }

    const strandId = pickStrand(perStrand);
    const meta = STRANDS[strandId] || { label: "Reading practice", description: "" };
    const xpToGoal = Math.max(0, DAILY_GOAL_XP - todayXp);

    return res.status(200).json({
      studentId, appId: APP_SLUG,
      recommendation: {
        kind: "drill",
        headline: `${meta.label} practice`,
        subtitle: meta.description
          ? `${meta.description} — ${xpToGoal.toFixed(1)} XP to your daily goal.`
          : `${xpToGoal.toFixed(1)} XP to your daily goal.`,
        estimatedMinutes: 5,
        priority: todayXp === 0 ? "high" : "medium",
        path: "/",
        reason: todayXp === 0 ? "no_xp_yet" : "below_goal",
        details: { strand: strandId },
      },
      blocksRemaining: 1,
    });
  } catch (err) {
    return res.status(500).json({ error: "today fetch failed", details: err.message });
  }
}
