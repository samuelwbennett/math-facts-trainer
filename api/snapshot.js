// api/snapshot.js

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const studentId = req.query.student;

  if (!studentId) {
    return res.status(400).json({ error: "missing ?student=<id>" });
  }

  try {
    // Create Supabase client
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Today's date
    const today = new Date().toISOString().slice(0, 10);

    // Query daily_progress table
    const { data, error } = await supabase
      .from("daily_progress")
      .select("total_xp")
      .eq("student_id", studentId)
      .eq("day", today)
      .maybeSingle();

    if (error) {
      throw error;
    }

    const todayXp = parseFloat(data?.total_xp) || 0;

    return res.status(200).json({
      studentId,
      todayXp,
      weekXp: todayXp, // simple for now
      dailyGoalXp: 30,
      nextDrill: {
        label: "Continue Practice",
        path: "/"
      }
    });

  } catch (err) {
    console.error("[/api/snapshot] failed:", err);

    return res.status(500).json({
      error: "snapshot fetch failed",
      details: err.message,
      hint: "Check SUPABASE_URL, SERVICE_ROLE_KEY, table names, and student_id"
    });
  }
}