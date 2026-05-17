// ============================================================
// MATH FACTS — /api/today
//
// Implements the VPA Orchestration Contract v1.0 /api/today endpoint.
// Returns Math Facts' top recommendation for the given student.
//
// Logic:
//   - If today's XP >= daily goal → kind:"none", "All caught up today"
//   - Else → kind:"drill", suggesting the operation least-mastered
//     among unlocked operations, with XP-to-goal in the subtitle.
//
// The contract shape is intentionally identical to reading-academy's
// /api/today so the orchestrator can fan out uniformly. See
// reading-academy/api/_handlers/today.js for the reference impl.
// ============================================================

import { createClient } from "@supabase/supabase-js";

const APP_SLUG = "math_facts";
const CONTRACT_VERSION = "1.0";
const DAILY_GOAL_XP = 5;
const DIVISION_UNLOCK_THRESHOLD = 5;

const OPS = [
  { id: "addition",       label: "Addition",       symbol: "+" },
  { id: "subtraction",    label: "Subtraction",    symbol: "−" },
  { id: "multiplication", label: "Multiplication", symbol: "×" },
  { id: "division",       label: "Division",       symbol: "÷" },
];

const FACT_TOTALS = {
  addition: 169, subtraction: 91, multiplication: 121, division: 121,
};

function todayInDenver() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function summarizeOp(progress, op) {
  const total = FACT_TOTALS[op] || 0;
  const facts = progress?.[op]?.facts;
  if (!facts || typeof facts !== "object") return { mastered: 0, total };
  let mastered = 0;
  for (const fact of Object.values(facts)) {
    if (fact?.state === "automatic") mastered += 1;
  }
  return { mastered, total };
}

// Pick the operation most in need of practice. We use lowest
// mastery%; ties broken by the canonical order in OPS.
function pickPracticeOp(progress) {
  const mulSummary = summarizeOp(progress, "multiplication");
  const divisionUnlocked = mulSummary.mastered >= DIVISION_UNLOCK_THRESHOLD;

  const candidates = OPS
    .filter((o) => o.id !== "division" || divisionUnlocked)
    .map((o) => {
      const s = summarizeOp(progress, o.id);
      const pct = s.total > 0 ? s.mastered / s.total : 0;
      return { ...o, pct, ...s };
    })
    .sort((a, b) => a.pct - b.pct);

  return candidates[0] || OPS[0];
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

    // App row check (graceful no-op if Math Facts isn't provisioned).
    const { data: app } = await supabase
      .from("learning_apps")
      .select("id")
      .eq("slug", APP_SLUG)
      .maybeSingle();
    if (!app?.id) {
      return res.status(200).json({
        studentId, appId: APP_SLUG,
        recommendation: {
          kind: "none",
          headline: "Math Facts not provisioned yet",
          subtitle: "Ask the admin to enable this app for your account.",
          estimatedMinutes: 0, priority: "low",
          path: "/", reason: "not_provisioned",
        },
        blocksRemaining: 0,
        _notProvisioned: true,
      });
    }

    // Today's XP for the goal check.
    const [progressRow, accountRow] = await Promise.all([
      supabase
        .from("daily_progress")
        .select("total_xp, per_app")
        .eq("student_id", studentId)
        .eq("day", todayInDenver())
        .maybeSingle(),
      supabase
        .from("student_app_accounts")
        .select("state")
        .eq("student_id", studentId)
        .eq("app_id", app.id)
        .maybeSingle(),
    ]);

    const todayXp =
      parseFloat(progressRow?.data?.per_app?.math_facts?.xp) || 0;
    const progress = accountRow?.data?.state?.progress || {};

    if (todayXp >= DAILY_GOAL_XP) {
      return res.status(200).json({
        studentId, appId: APP_SLUG,
        recommendation: {
          kind: "none",
          headline: "All caught up today",
          subtitle: `${Math.round(todayXp)} XP earned — come back tomorrow.`,
          estimatedMinutes: 0, priority: "low",
          path: "/", reason: "goal_met",
        },
        blocksRemaining: 0,
      });
    }

    const op = pickPracticeOp(progress);
    const xpToGoal = Math.max(0, DAILY_GOAL_XP - todayXp);

    return res.status(200).json({
      studentId, appId: APP_SLUG,
      recommendation: {
        kind: "drill",
        headline: `Practice ${op.label.toLowerCase()}`,
        subtitle: `${xpToGoal.toFixed(1)} XP to your ${DAILY_GOAL_XP} XP daily goal.`,
        estimatedMinutes: 5,
        priority: todayXp === 0 ? "high" : "medium",
        path: `/?op=${op.id}`,
        reason: todayXp === 0 ? "no_xp_yet" : "below_goal",
        details: { op: op.id, masteryPct: Number(op.pct.toFixed(3)) },
      },
      blocksRemaining: 1,
    });
  } catch (err) {
    return res.status(500).json({ error: "today fetch failed", details: err.message });
  }
}
