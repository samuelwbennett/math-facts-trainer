// ============================================================
// MATH FACTS — /api/math-facts/mastery
//
// Per-operation mastery rollup for the orchestration dashboard's
// skill garden. Reads the persisted Math Facts state from
// student_app_accounts.state.progress and counts how many facts in
// each operation have reached "automatic".
//
//   GET /api/math-facts/mastery?student=<vpa-student-uuid>
//   →  {
//        studentId,
//        strands: [
//          {
//            id: "addition" | "subtraction" | "multiplication" | "division",
//            label: "Addition" | ...,
//            symbol: "+" | "−" | "×" | "÷",
//            mastered: number,    // facts with state === "automatic"
//            attempted: number,   // facts with any non-default state
//            total: number,       // size of the fact pool for the op
//            avgScore: 0..1,      // mastered / total
//            unlocked: boolean    // division unlocks at 5 multiplication automatic
//          },
//          ...
//        ]
//      }
//
// CORS *: same as the snapshot endpoint.
// ============================================================

import { createClient } from "@supabase/supabase-js";

// Stable fact pool sizes from src/engine.js (computed at module load
// from buildAddition/buildSubtraction/etc.). Kept in sync by hand;
// if you add or remove facts, update these too.
const FACT_TOTALS = {
  addition:       169,
  subtraction:    91,
  multiplication: 121,
  division:       121,
};

// Division unlocks once the student has 5 multiplication facts at
// automatic. Mirrors DIVISION_UNLOCK_THRESHOLD in src/engine.js.
const DIVISION_UNLOCK_THRESHOLD = 5;

const STRAND_DEFS = [
  { id: "addition",       label: "Addition",       symbol: "+" },
  { id: "subtraction",    label: "Subtraction",    symbol: "−" },
  { id: "multiplication", label: "Multiplication", symbol: "×" },
  { id: "division",       label: "Division",       symbol: "÷" },
];

function summarizeOp(progress, op) {
  const total = FACT_TOTALS[op] || 0;
  const facts = progress?.[op]?.facts;
  if (!facts || typeof facts !== "object") {
    return { mastered: 0, attempted: 0, total };
  }
  let mastered = 0;
  let attempted = 0;
  for (const fact of Object.values(facts)) {
    const state = fact?.state;
    if (state && state !== "unknown") attempted += 1;
    if (state === "automatic") mastered += 1;
  }
  return { mastered, attempted, total };
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

    // Resolve learning_apps.id for the math_facts slug, then fetch
    // the student_app_accounts row for this student.
    const { data: app, error: appErr } = await supabase
      .from("learning_apps")
      .select("id")
      .eq("slug", "math_facts")
      .maybeSingle();
    if (appErr) throw appErr;
    if (!app?.id) throw new Error("math_facts row missing in learning_apps");

    const { data: account, error: accErr } = await supabase
      .from("student_app_accounts")
      .select("state")
      .eq("student_id", studentId)
      .eq("app_id", app.id)
      .maybeSingle();
    if (accErr) throw accErr;

    const progress = account?.state?.progress || {};

    // Multiplication-automatic count drives division unlock.
    const mulSummary = summarizeOp(progress, "multiplication");
    const divisionUnlocked = mulSummary.mastered >= DIVISION_UNLOCK_THRESHOLD;

    const strands = STRAND_DEFS.map((s) => {
      const sum = summarizeOp(progress, s.id);
      return {
        id: s.id,
        label: s.label,
        symbol: s.symbol,
        mastered: sum.mastered,
        attempted: sum.attempted,
        total: sum.total,
        avgScore: sum.total > 0 ? Number((sum.mastered / sum.total).toFixed(3)) : 0,
        unlocked: s.id === "division" ? divisionUnlocked : true,
      };
    });

    return res.status(200).json({
      studentId,
      strands,
    });
  } catch (err) {
    return res.status(500).json({
      error: "mastery fetch failed",
      details: err.message,
    });
  }
}

export const __test__ = { summarizeOp, FACT_TOTALS, STRAND_DEFS, DIVISION_UNLOCK_THRESHOLD };
