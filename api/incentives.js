// ============================================================
// INCENTIVES — /api/incentives  (attendance-based v2)
//
// Computes a student's incentive earnings on demand:
//   - daily_progress.{total_xp, per_app}  → daily presence per student
//   - incentive_redemptions               → cash-out history
//
// The economy is ATTENDANCE-based, not XP-volume-based:
//   - Earn $2 for each WEEKDAY (Mon–Fri) the student shows up
//   - "Show up" = any cross-app XP earned that day (any app)
//   - Weekly cap: $10/week (= $2 × 5 weekdays)
//   - Weekends never earn — no Sat/Sun payouts
//
// Why attendance: simpler mental model for kids and parents. A kid
// who comes in 5 days/week gets a predictable $10. The previous
// $0.10-per-XP model rewarded grinding; this rewards consistency.
//
// Source of truth note: presence today is derived from
// `daily_progress.total_xp > 0 OR any per_app[slug].xp > 0`. Today,
// only Math Facts writes to daily_progress, so this is effectively
// "any Math Facts activity that day = present." As Reading Facts /
// Reading Academy / Math Academy start writing to daily_progress in
// future, this check picks them up automatically.
//
// Two routes:
//
//   GET  /api/incentives?student=<uuid>
//        →  { earnings, ledger[], redemptions[], rules }
//
//   POST /api/incentives?student=<uuid>
//        body: { totalDollars, storeAmount, scholarshipAmount, note? }
//        →  { ok: true, redemption }
//
// CORS: * with OPTIONS short-circuit. Auth: trust studentId (v0.2
// should require a Supabase access token).
// ============================================================

import { createClient } from "@supabase/supabase-js";

// VPA's hardcoded incentive rules — attendance model.
const RULES = {
  dollarsPerDay:    2.00,   // $2 per weekday present
  weekdayPayout:    true,   // earn Mon–Fri only
  weeklyDollarsCap: 10.00,  // $2 × 5 weekdays
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
  const target = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (target.getUTCDay() + 6) % 7; // 0 = Mon
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((target - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7
  );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// 0..6 (Sun..Sat). Day param is a YYYY-MM-DD string anchored in
// Denver. We instantiate as UTC noon so DST jitter can't roll us
// across day boundaries.
function dayOfWeek(dayStr) {
  const [y, m, d] = dayStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

function isWeekday(dayStr) {
  const dow = dayOfWeek(dayStr);
  return dow >= 1 && dow <= 5; // Mon=1 .. Fri=5
}

// A day "counts as present" if there's any XP across any app. We
// check total_xp first (cheap), then fall back to scanning per_app
// for any non-zero entry so we pick up apps that contribute to
// per_app but not total_xp (a possible future edge case).
function isPresent(row) {
  if (Number(row.total_xp) > 0) return true;
  const perApp = row.per_app;
  if (!perApp || typeof perApp !== "object") return false;
  for (const v of Object.values(perApp)) {
    if (Number(v?.xp) > 0) return true;
  }
  return false;
}

// Dollars earned for a given day. Attendance-based:
//   - Weekend → $0 (no earning days)
//   - Absent (no XP at all that day) → $0
//   - Present + weekday → $2 (capped by remaining weekly allowance,
//     which is naturally <= 5 weekdays, so this is a paranoia check)
function dollarsForDay({ present, weekday, weeklyEarnedSoFar }) {
  if (!weekday || !present) return 0;
  const remainingWeekly = Math.max(0, RULES.weeklyDollarsCap - weeklyEarnedSoFar);
  return Math.min(RULES.dollarsPerDay, remainingWeekly);
}

// Build the per-day ledger from daily_progress rows. Returns:
//   {
//     ledger: [{ day, xp, dollars, weekKey, present, weekday }],
//     totalEarned,
//   }
// Rows are processed chronologically so weekly accumulation is correct.
function buildLedger(progressRows) {
  const sorted = [...progressRows].sort((a, b) => a.day.localeCompare(b.day));
  const weeklySoFar = Object.create(null); // weekKey → $ earned that week
  const ledger = [];
  let total = 0;

  for (const row of sorted) {
    const xp = Number(row.total_xp) || 0;
    const present = isPresent(row);
    const weekday = isWeekday(row.day);
    const date = new Date(row.day + "T12:00:00Z");
    const weekKey = denverIsoWeek(date);
    const weeklyEarned = weeklySoFar[weekKey] || 0;

    const dollars = dollarsForDay({
      present, weekday, weeklyEarnedSoFar: weeklyEarned,
    });
    weeklySoFar[weekKey] = Math.round((weeklyEarned + dollars) * 100) / 100;
    total = Math.round((total + dollars) * 100) / 100;

    ledger.push({
      day: row.day,
      xp,
      dollars,
      weekKey,
      present,
      weekday,
    });
  }

  return { ledger, totalEarned: total };
}

// Days the student was actually paid this week (= weekdays with
// presence in the current ISO week).
function daysPresentThisWeek(ledger, todayWeekKey) {
  return ledger.filter(
    (e) => e.weekKey === todayWeekKey && e.weekday && e.present,
  ).length;
}

async function handleGet(req, res, supabase, studentId) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000)
    .toISOString().slice(0, 10);

  const [progressRes, redemptionsRes] = await Promise.all([
    supabase
      .from("daily_progress")
      .select("day, total_xp, per_app")
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

  const todayDenver = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const todayEntry = ledger.find((e) => e.day === todayDenver);
  const todayEarned = todayEntry ? todayEntry.dollars : 0;

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
      // Attendance-model addition: how many weekdays this week the
      // student was present (≤ 5). The UI surfaces this as a "3/5
      // days this week" indicator.
      daysPresentThisWeek: daysPresentThisWeek(ledger, todayWeek),
      maxDaysPerWeek: 5,
    },
    rules: {
      // Attendance model — new fields. Kept the old keys present
      // with derived values for any old client that hasn't been
      // updated yet.
      model: "attendance",
      dollarsPerDay: RULES.dollarsPerDay,
      weekdayPayout: RULES.weekdayPayout,
      weeklyDollarsCap: RULES.weeklyDollarsCap,
      defaultSplit: RULES.defaultSplit,
      // --- legacy compat (old client expectations) ---
      ratePerXp: 0,
      dailyDollarsCap: RULES.dollarsPerDay,
    },
    ledger: ledger.slice(-30),
    redemptions: redemptionsRes.data || [],
  });
}

async function handlePost(req, res, supabase, studentId) {
  let body = req.body;
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

  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000)
    .toISOString().slice(0, 10);
  const [progressRes, redemptionsRes] = await Promise.all([
    supabase
      .from("daily_progress")
      .select("day, total_xp, per_app")
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

export const __test__ = {
  dollarsForDay, buildLedger, denverIsoWeek,
  isWeekday, isPresent, daysPresentThisWeek, RULES,
};
