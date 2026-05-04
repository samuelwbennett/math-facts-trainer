// api/snapshot.js

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  // Allow dashboard to call this API
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
    // Connect to Supabase (server-side safe)
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Get today's date (matches your DB format)
    const today = new Date().toISOString().slice(0, 10);

    // Pull today's XP from daily_progress
    const { data, error } = await supabase
      .from("daily_progress")
      .select("total_xp")
      .eq("student_id", studentId)
      .eq("day", today)
      .maybeSingle();

    if (error) throw error;

    const todayXp = parseFloat(data?.total_xp) || 0;

    return res.status(200).json({
      todayXp,
      weekXp: todayXp, // temporary (we’ll improve later)
      dailyGoalXp: 30,
      nextDrill: {
        label: "Continue Practice",
        path: "/"
      }
    });

  } catch (err) {
    console.error("[/api/snapshot] failed:", err);
    return res.status(500).json({ error: "snapshot fetch failed" });
  }
}