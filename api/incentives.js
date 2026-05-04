// ============================================================
// INCENTIVES — /api/incentives
//
// Computes a student's incentive earnings on demand from data we
// already have:
//   - daily_progress.total_xp         → daily XP per student
//   - incentive_redemptions           → cash-out history
// Plus the global rate / caps configured below.
//
// Two routes (decided by req.query.action):
//
//   GET  /api/incentives?student=<uuid>
//        →  { earnings, ledger[], redemptions[], rules }
//
//   POST /api/incentives?student=<uuid>
//        body: { totalDollars, storeAmount, scholarshipAmount, note? }
//        →  { ok: true, redemption }
//
// CORS: * with OPTIONS short-circuit (matches the other endpoints).
// Auth: not yet — the proxy trusts the studentId param. v0.2 should
// require a Supabase access token and verify it server-side.
// ============================================================

import { createClient } from "@supabase/supabase-js";

// VPA's hardcoded incentive rules for v1. Tunable in one place.
const RULES = {
  ratePerXp:       0.10,    // $0.10 per XP earned
  dailyDollarsCap: 5.00,    // ≤ $5 per day, regardless of XP volume
  weeklyDollarsCap: 25.00,  // ≤ $25 per ISO week (Mon–Sun)
  // Default redemption split shown in the UI; students can change at
  // redemption time.
  defaultSplit:    { store: 0.5, scholarship: 0.5 },
};

// ISO week key in Denver time, e.g. "2026-W18". Used for the rolling
// weekly cap.
function denverIsoWeek(date) {
  const denverDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
  const [y, m, d] = denverDateStr.split("-").map(Number);
  // Use UTC math against Denver's calendar date, which is fine for
  // ISO-week computation (errors at most one hour at DST boundary).
  const target = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (target.getUTCDay() + 6) % 7; // 0 = Mon
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((target - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7
  );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// dollars earned for a given XP figure on a given day, given:
//   - the per-day cap
//   - the running weekly total earned so far
// Returns the actual $ awarded for THIS day (0..min(dailyCap,
// remaining-of-weekly-cap)).
function dollarsForDay(xp, weeklyEarnedSoFar) {
  const raw = Math.max(0, xp) * RULES.ratePerXp;
  const dailyCapped = Math.min(raw, RULES.dailyDollarsCap);
  const remainingWeekly = Math.max(0, RULES.weeklyDollarsCap - weeklyEarnedSoFar);
  const finalDollars = Math.min(dailyCapped, remainingWeekly);
  // Round to cents.
  return Math.round(finalDollars * 100) / 100;
}

// Build the per-day ledger from daily_progress rows. Returns:
//   {
//     ledger: [{ day, xp, dollars, weekKey, dailyCapHit, weeklyCapHit }],
//     totalEarned,
//   }
// Rows are processed chronologically so weekly accumulation is
// correct.
function buildLedger(progressRows) {
  const sorted = [...progressRows].sort((a, b) => a.day.localeCompare(b.day));
  const weeklySoFar = Object.create(null); // weekKey → $ earned that week
  const ledger = [];
  let total = 0;

  for (const row of sorted) {
    const xp = Number(row.total_xp) || 0;
    const date = new Date(row.day + "T12:00:00Z"); // noon UTC for stability
    const weekKey = denverIsoWeek(date);
    const weeklyEarned = weeklySoFar[weekKey] || 0;
    const dollars = dollarsForDay(xp, weeklyEarned);
    weeklySoFar[weekKey] = Math.round((weeklyEarned + dollars) * 100) / 100;
    total = Math.round((total + dollars) * 100) / 100;

    const rawForDay = Math.min(xp * RULES.ratePerXp, RULES.dailyDollarsCap);
    ledger.push({
      day: row.day,
      xp,
      dollars,
      weekKey,
      dailyCapHit: xp * RULES.ratePerXp > RULES.dailyDollarsCap + 0.001,
      weeklyCapHit: dollars < rawForDay - 0.001,
    });
  }

  return { ledger, totalEarned: total };
}

async function handleGet(req, res, supabase, studentId) {
  // Pull the last 90 days of daily_progress + all redemptions.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000)
    .toISOString().slice(0, 10);

  const [progressRes, redemptionsRes] = await Promise.all([
    supabase
      .from("daily_progress")
      .select("day, total_xp")
      .eq("student_id", studentId)
      .gte("day", ninetyDaysAgo)
      .order("day", { ascending: true }),
    supabase
      .from("incentive_redemptions")
      .select("id, total_dollars, store_amount, scholarship_amount, note, redeemed_at")
      .eq("student_id", studentId)
      .order("redeemed_at", { ascending: false }),
  ]);

  if (progressRes.error) throw progressRes.error;
  if (redemptionsRes.error) throw redemptionsRes.error;

  const { ledger, totalEarned } = buildLedger(progressRes.data || []);
  const totalRedeemed = (redemptionsRes.data || [])
    .reduce((s, r) => s + Number(r.total_dollars), 0);
  const available = Math.max(0, Math.round((totalEarned - totalRedeemed) * 100) / 100);

  // Today's earned (Denver date) is the last ledger entry for today.
  const todayDenver = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const todayEntry = ledger.find((e) => e.day === todayDenver);
  const todayEarned = todayEntry ? todayEntry.dollars : 0;

  // This week's earned: sum of ledger entries whose weekKey matches
  // today's week.
  const todayWeek = denverIsoWeek(new Date());
  const weekEarned = ledger
    .filter((e) => e.weekKey === todayWeek)
    .reduce((s, e) => s + e.dollars, 0);

  return res.status(200).json({
    studentId,
    earnings: {
      totalEarned,
      totalRedeemed,
      available,
      today: todayEarned,
      thisWeek: Math.round(weekEarned * 100) / 100,
    },
    rules: {
      ratePerXp: RULES.ratePerXp,
      dailyDollarsCap: RULES.dailyDollarsCap,
      weeklyDollarsCap: RULES.weeklyDollarsCap,
      defaultSplit: RULES.defaultSplit,
    },
    // Last 30 ledger entries — enough for charts/lists without sending
    // 90 days of rows over the wire.
    ledger: ledger.slice(-30),
    redemptions: redemptionsRes.data || [],
  });
}

async function handlePost(req, res, supabase, studentId) {
  let body = req.body;
  // Some Vercel runtimes hand us a string body; parse if so.
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const total = Number(body?.totalDollars);
  const store = Number(body?.storeAmount) || 0;
  const scholarship = Number(body?.scholarshipAmount) || 0;
  const note = typeof body?.note === "string" ? body.note.slice(0, 500) : null;

  if (!Number.isFinite(total) || total <= 0) {
    return res.status(400).json({ error: "totalDollars must be > 0" });
  }
  if (Math.abs(store + scholarship - total) > 0.01) {
    return res.status(400).json({
      error: "storeAmount + scholarshipAmount must equal totalDollars",
    });
  }

  // Validate available balance server-side (never trust the client).
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000)
    .toISOString().slice(0, 10);
  const [progressRes, redemptionsRes] = await Promise.all([
    supabase
      .from("daily_progress")
      .select("day, total_xp")
      .eq("student_id", studentId)
      .gte("day", ninetyDaysAgo)
      .order("day", { ascending: true }),
    supabase
      .from("incentive_redemptions")
      .select("total_dollars")
      .eq("student_id", studentId),
  ]);
  if (progressRes.error) throw progressRes.error;
  if (redemptionsRes.error) throw redemptionsRes.error;

  const { totalEarned } = buildLedger(progressRes.data || []);
  const totalRedeemed = (redemptionsRes.data || [])
    .reduce((s, r) => s + Number(r.total_dollars), 0);
  const available = Math.max(0, totalEarned - totalRedeemed);

  if (total > available + 0.001) {
    return res.status(400).json({
      error: `requested $${total.toFixed(2)} exceeds available $${available.toFixed(2)}`,
    });
  }

  const { data: inserted, error } = await supabase
    .from("incentive_redemptions")
    .insert({
      student_id: studentId,
      total_dollars: total,
      store_amount: store,
      scholarship_amount: scholarship,
      note,
    })
    .select()
    .maybeSingle();
  if (error) throw error;

  return res.status(200).json({ ok: true, redemption: inserted });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

    if (req.method === "GET")  return handleGet(req, res, supabase, studentId);
    if (req.method === "POST") return handlePost(req, res, supabase, studentId);
    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    return res.status(500).json({
      error: "incentives endpoint failed",
      details: err.message,
    });
  }
}

// Exposed for unit testing.
export const __test__ = { dollarsForDay, buildLedger, denverIsoWeek, RULES };
