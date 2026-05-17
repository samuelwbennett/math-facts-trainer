// ============================================================
// READING FACTS — /api/xp
//
// VPA Orchestration Contract v1.0 — multi-window XP rollups.
// Same shape as reading-academy/api/_handlers/xp.js and
// math-facts-trainer-react/api/xp.js. Source: reading_sessions
// (this app's own table); XP = duration_sec / 60 rounded to 0.1.
// ============================================================

import { createClient } from "@supabase/supabase-js";

const CONTRACT_VERSION = "1.0";
const APP_SLUG = "reading_facts";
const TZ = "America/Denver";

function startOfDenverDayISO(daysAgo = 0) {
  const todayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const [y, m, d] = todayStr.split("-").map(Number);
  const utcMs = Date.UTC(y, m - 1, d, 6, 0, 0);
  return new Date(utcMs - daysAgo * 86400000).toISOString();
}

function xpFromSec(sec) {
  return Math.round((sec / 60) * 10) / 10;
}

function sumXpInRange(rows, fromISO, toISO) {
  let total = 0;
  for (const r of rows) {
    const ts = r.completed_at;
    if (!ts) continue;
    if (ts < fromISO || (toISO && ts >= toISO)) continue;
    total += r.duration_sec || 0;
  }
  return xpFromSec(total);
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

    const startToday     = startOfDenverDayISO(0);
    const startYesterday = startOfDenverDayISO(1);
    const startThisWeek  = startOfDenverDayISO(6);
    const startLastWeek  = startOfDenverDayISO(13);
    const startThisMonth = startOfDenverDayISO(29);

    // Pull the last 30 days for the in-window math…
    const { data: monthRows, error: monthErr } = await supabase
      .from("reading_sessions")
      .select("duration_sec, completed_at")
      .eq("student_id", studentId)
      .gte("completed_at", startThisMonth);
    if (monthErr) throw monthErr;

    // …and a separate cheap query for allTime.
    const { data: lifetimeRows } = await supabase
      .from("reading_sessions")
      .select("duration_sec, completed_at")
      .eq("student_id", studentId);

    const todayXp     = sumXpInRange(monthRows || [], startToday);
    const yesterdayXp = sumXpInRange(monthRows || [], startYesterday, startToday);
    const thisWeekXp  = sumXpInRange(monthRows || [], startThisWeek);
    const lastWeekXp  = sumXpInRange(monthRows || [], startLastWeek, startThisWeek);
    const thisMonthXp = sumXpInRange(monthRows || [], startThisMonth);

    let lifetimeSec = 0;
    let latestTs = null;
    for (const r of (lifetimeRows || [])) {
      lifetimeSec += r.duration_sec || 0;
      if (r.completed_at && (!latestTs || r.completed_at > latestTs)) {
        latestTs = r.completed_at;
      }
    }

    return res.status(200).json({
      studentId, appId: APP_SLUG,
      today: todayXp,
      yesterday: yesterdayXp,
      thisWeek: thisWeekXp,
      lastWeek: lastWeekXp,
      thisMonth: thisMonthXp,
      allTime: xpFromSec(lifetimeSec),
      lastEarnedAt: latestTs,
    });
  } catch (err) {
    return res.status(500).json({ error: "xp fetch failed", details: err.message });
  }
}
