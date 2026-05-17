// ============================================================
// CRON — /api/cron-math-academy-sync
//
// Pulls each MA-linked student's per-day XP from the Math Academy
// partner API and writes it into our `daily_progress.per_app
// .math_academy.xp`. Without this, MA activity is invisible to the
// attendance economy + cross-app XP rollup (because MA sessions
// happen on mathacademy.com, not in our app — they never touch
// daily_progress directly the way Math Facts / Reading Facts /
// Reading Academy do).
//
// Schedule: see math-facts-trainer-react/vercel.json `crons`.
// Vercel hits this endpoint with no body, no auth — it relies on
// the cron infrastructure being the only caller. We add a header
// check (CRON_SECRET) for defense in depth.
//
// What gets written per student per day:
//   - Today + yesterday (covers the case where the cron runs after
//     midnight Denver but before midnight UTC, or where a kid did
//     a late-night session that crossed the date boundary)
//
// Idempotent: SET pattern on per_app.math_academy, recomputes
// total_xp from per_app sum. Safe to re-run as often as needed.
// ============================================================

import { createClient } from "@supabase/supabase-js";

const MA_BASE_URL = "https://mathacademy.com/api/beta5";
const APP_SLUG = "math_academy";

function denverDateISO(daysAgo = 0) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  if (daysAgo === 0) return today;
  const [y, m, d] = today.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d, 6, 0, 0) - daysAgo * 86400000;
  const dt = new Date(ms);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
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
  if (!res.ok) return 0; // tolerate one student's failure
  const json = await res.json();
  return Number(json?.activity?.totals?.xpAwarded) || 0;
}

/**
 * Upsert today's MA XP into daily_progress.per_app.math_academy.xp
 * for one student. Same read-modify-write pattern as the in-app
 * dailyProgress writers; idempotent.
 */
async function syncStudentDay(supabase, studentId, day, maId) {
  const xp = await maActivityXp(maId, day, day);
  if (xp <= 0) return { studentId, day, xp: 0, skipped: true };

  const { data: existing } = await supabase
    .from("daily_progress")
    .select("total_active_seconds, per_app")
    .eq("student_id", studentId)
    .eq("day", day)
    .maybeSingle();

  const perApp = existing?.per_app || {};
  perApp[APP_SLUG] = {
    ...(perApp[APP_SLUG] || {}),
    xp,
  };

  let total_xp = 0;
  for (const v of Object.values(perApp)) {
    total_xp += Number(v?.xp) || 0;
  }
  total_xp = Math.round(total_xp * 100) / 100;

  const { error } = await supabase
    .from("daily_progress")
    .upsert(
      {
        student_id: studentId,
        day,
        total_xp,
        total_active_seconds: existing?.total_active_seconds || 0,
        per_app: perApp,
      },
      { onConflict: "student_id,day" },
    );
  if (error) return { studentId, day, xp, error: error.message };
  return { studentId, day, xp };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // Defense-in-depth header check (Vercel Crons doesn't set a unique
  // header by default; this is a manual shared-secret check). If
  // CRON_SECRET isn't set in env, the check is a no-op.
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const got = req.headers?.["x-cron-secret"] || req.query?.secret;
    if (got !== expected) {
      return res.status(401).json({ error: "bad cron secret" });
    }
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "supabase env not configured" });
  }
  if (!process.env.MA_PUBLIC_API_KEY) {
    return res.status(500).json({ error: "MA_PUBLIC_API_KEY not configured" });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    // 1. Resolve the math_academy app id.
    const { data: app, error: appErr } = await supabase
      .from("learning_apps")
      .select("id")
      .eq("slug", APP_SLUG)
      .maybeSingle();
    if (appErr) throw appErr;
    if (!app?.id) {
      return res.status(200).json({
        ok: true,
        message: "math_academy app row missing from learning_apps; nothing to sync",
      });
    }

    // 2. List every MA-linked student.
    const { data: links, error: linksErr } = await supabase
      .from("student_app_accounts")
      .select("student_id, external_id")
      .eq("app_id", app.id)
      .eq("enabled", true)
      .not("external_id", "is", null);
    if (linksErr) throw linksErr;
    const allLinks = links || [];

    if (allLinks.length === 0) {
      return res.status(200).json({ ok: true, synced: 0, students: 0 });
    }

    // 3. For each student, sync today + yesterday. Serialize to be
    //    gentle on the partner API (no rate limit info published).
    const today = denverDateISO(0);
    const yesterday = denverDateISO(1);
    const results = [];
    for (const link of allLinks) {
      try {
        const [a, b] = await Promise.all([
          syncStudentDay(supabase, link.student_id, today, link.external_id),
          syncStudentDay(supabase, link.student_id, yesterday, link.external_id),
        ]);
        results.push(a, b);
      } catch (err) {
        results.push({
          studentId: link.student_id,
          maId: link.external_id,
          error: err?.message || String(err),
        });
      }
    }

    const synced = results.filter((r) => !r.skipped && !r.error).length;
    const failed = results.filter((r) => r.error).length;
    return res.status(200).json({
      ok: true,
      students: allLinks.length,
      results_count: results.length,
      synced,
      failed,
      sample: results.slice(0, 10),
    });
  } catch (err) {
    return res.status(500).json({
      error: "cron-math-academy-sync failed",
      details: err?.message || String(err),
    });
  }
}
