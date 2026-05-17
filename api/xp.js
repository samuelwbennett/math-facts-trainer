// ============================================================
// MATH FACTS — /api/xp
//
// Implements the VPA Orchestration Contract v1.0 /api/xp endpoint.
// Returns Math Facts XP across multiple time windows so the launcher
// can roll up unified totals.
//
// Source: daily_progress.per_app.math_facts.xp (rolled up by the
// recordSession write in src/storage.js). One row per student per
// day, so the windowed sums are cheap.
// ============================================================

import { createClient } from "@supabase/supabase-js";

const APP_SLUG = "math_facts";
const CONTRACT_VERSION = "1.0";
const TZ = "America/Denver";

function denverDayISO(daysAgo = 0) {
  const todayStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  if (daysAgo === 0) return todayStr;
  const [y, m, d] = todayStr.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d) - daysAgo * 86400000;
  const dt = new Date(ms);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function sumXpInRange(rows, fromISO, toISO) {
  let total = 0;
  for (const r of rows) {
    if (r.day < fromISO || r.day > toISO) continue;
    const xp = parseFloat(r?.per_app?.math_facts?.xp) || 0;
    total += xp;
  }
  return total;
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

    const { data: app } = await supabase
      .from("learning_apps")
      .select("id")
      .eq("slug", APP_SLUG)
      .maybeSingle();
    if (!app?.id) {
      return res.status(200).json({
        studentId, appId: APP_SLUG,
        today: 0, yesterday: 0, thisWeek: 0, lastWeek: 0,
        thisMonth: 0, allTime: 0, lastEarnedAt: null,
        _notProvisioned: true,
      });
    }

    // 31 days of daily_progress covers every window we need (today
    // through thisMonth). allTime is a separate sum.
    const startThisMonth = denverDayISO(29);
    const { data: monthRows, error: monthErr } = await supabase
      .from("daily_progress")
      .select("day, per_app")
      .eq("student_id", studentId)
      .gte("day", startThisMonth)
      .order("day", { ascending: false });
    if (monthErr) throw monthErr;

    const { data: lifetimeRow } = await supabase
      .from("daily_progress")
      .select("per_app")
      .eq("student_id", studentId);

    const today = denverDayISO(0);
    const yesterday = denverDayISO(1);
    const startThisWeek = denverDayISO(6);
    const startLastWeek = denverDayISO(13);

    const todayXp     = sumXpInRange(monthRows || [], today, today);
    const yesterdayXp = sumXpInRange(monthRows || [], yesterday, yesterday);
    const thisWeekXp  = sumXpInRange(monthRows || [], startThisWeek, today);
    const lastWeekXp  = sumXpInRange(monthRows || [], startLastWeek, denverDayISO(7));
    const thisMonthXp = sumXpInRange(monthRows || [], startThisMonth, today);

    let allTime = 0;
    for (const r of (lifetimeRow || [])) {
      allTime += parseFloat(r?.per_app?.math_facts?.xp) || 0;
    }

    // Last earned: highest non-zero day. Approximation — we don't
    // store per-attempt timestamps in daily_progress.
    let lastEarnedAt = null;
    for (const r of (monthRows || [])) {
      const xp = parseFloat(r?.per_app?.math_facts?.xp) || 0;
      if (xp > 0) {
        lastEarnedAt = `${r.day}T12:00:00.000Z`;
        break;
      }
    }

    return res.status(200).json({
      studentId, appId: APP_SLUG,
      today: todayXp,
      yesterday: yesterdayXp,
      thisWeek: thisWeekXp,
      lastWeek: lastWeekXp,
      thisMonth: thisMonthXp,
      allTime,
      lastEarnedAt,
    });
  } catch (err) {
    return res.status(500).json({ error: "xp fetch failed", details: err.message });
  }
}
