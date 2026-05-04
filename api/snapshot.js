import { createClient } from "@supabase/supabase-js";

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

    const today = new Date().toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from("daily_progress")
      .select("total_xp, per_app")
      .eq("student_id", studentId)
      .eq("day", today)
      .maybeSingle();

    if (error) throw error;

    const todayXp =
      parseFloat(data?.per_app?.math_facts?.xp) ||
      parseFloat(data?.total_xp) ||
      0;

    return res.status(200).json({
      studentId,
      todayXp,
      weekXp: todayXp,
      dailyGoalXp: 5,
      nextDrill: {
        label: "Continue Math Facts",
        path: "/"
      }
    });
  } catch (err) {
    return res.status(500).json({
      error: "snapshot fetch failed",
      details: err.message
    });
  }
}