// ============================================================
// MATH ACADEMY — /api/math-academy/xp
//
// VPA Orchestration Contract v1.0 — multi-window XP rollups.
// Same shape as reading-academy/api/_handlers/xp.js and the in-house
// /api/xp endpoints.
//
// Reads from Math Academy's Beta 5 partner API. Each window is one
// partner-API call (six in parallel for the six windows). Math
// Academy's activity endpoint accepts Start-Date + End-Date headers
// and returns activity.totals.xpAwarded for that range.
//
// lastEarnedAt is approximated by checking today → yesterday →
// (most recent day with non-zero XP in the past 30) since the
// partner API doesn't expose a per-day breakdown without iterating.
// ============================================================

const MA_BASE_URL = "https://mathacademy.com/api/beta5";
const CONTRACT_VERSION = "1.0";
const APP_SLUG = "math_academy";
const ALL_TIME_FLOOR = "2010-01-01"; // Math Academy launched 2014; this is a safe floor.

import { createClient } from "@supabase/supabase-js";

function denverDateISO(daysAgo = 0) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  if (daysAgo === 0) return today;
  const [y, m, d] = today.split("-").map(Number);
  const utcMs = Date.UTC(y, m - 1, d, 6, 0, 0);
  const past = new Date(utcMs - daysAgo * 86400000);
  const yy = past.getUTCFullYear();
  const mm = String(past.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(past.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

async function maActivityXp(maId, startDate, endDate) {
  const publicKey = process.env.MA_PUBLIC_API_KEY;
  if (!publicKey) throw new Error("MA_PUBLIC_API_KEY env var not configured");
  const res = await fetch(
    `${MA_BASE_URL}/students/${encodeURIComponent(maId)}/activity`,
    {
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Public-API-Key": publicKey,
        "Start-Date": startDate,
        "End-Date": endDate,
      },
    },
  );
  if (!res.ok) {
    // Don't blow up a 6-call fan-out on a single bad window; return 0.
    return 0;
  }
  const json = await res.json();
  return Number(json?.activity?.totals?.xpAwarded) || 0;
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

    const { data: link, error: linkErr } = await supabase
      .from("student_app_accounts")
      .select("external_id, learning_apps!inner(slug)")
      .eq("student_id", studentId)
      .eq("learning_apps.slug", APP_SLUG)
      .eq("enabled", true)
      .maybeSingle();
    if (linkErr) throw linkErr;

    if (!link?.external_id) {
      return res.status(200).json({
        studentId, appId: APP_SLUG,
        today: 0, yesterday: 0, thisWeek: 0, lastWeek: 0,
        thisMonth: 0, allTime: 0, lastEarnedAt: null,
        _notLinked: true,
      });
    }

    const maId = link.external_id;
    const today        = denverDateISO(0);
    const yesterday    = denverDateISO(1);
    const startThisWk  = denverDateISO(6);
    const startLastWk  = denverDateISO(13);
    const endLastWk    = denverDateISO(7);
    const startThisMo  = denverDateISO(29);

    // Six windows, parallel.
    const [
      todayXp, yesterdayXp, thisWeekXp, lastWeekXp, thisMonthXp, allTimeXp,
    ] = await Promise.all([
      maActivityXp(maId, today, today),
      maActivityXp(maId, yesterday, yesterday),
      maActivityXp(maId, startThisWk, today),
      maActivityXp(maId, startLastWk, endLastWk),
      maActivityXp(maId, startThisMo, today),
      maActivityXp(maId, ALL_TIME_FLOOR, today),
    ]);

    // Approximate lastEarnedAt: highest day with non-zero XP we know about.
    let lastEarnedAt = null;
    if (todayXp > 0) lastEarnedAt = `${today}T12:00:00.000Z`;
    else if (yesterdayXp > 0) lastEarnedAt = `${yesterday}T12:00:00.000Z`;
    else if (thisWeekXp > 0 || lastWeekXp > 0 || thisMonthXp > 0) {
      // We only know it was within the last 30 days — point at the
      // start-of-thisWeek as a conservative "recent" marker.
      lastEarnedAt = `${startThisWk}T12:00:00.000Z`;
    }

    return res.status(200).json({
      studentId, appId: APP_SLUG,
      today: todayXp,
      yesterday: yesterdayXp,
      thisWeek: thisWeekXp,
      lastWeek: lastWeekXp,
      thisMonth: thisMonthXp,
      allTime: allTimeXp,
      lastEarnedAt,
    });
  } catch (err) {
    return res.status(500).json({ error: "xp fetch failed", details: err.message });
  }
}
