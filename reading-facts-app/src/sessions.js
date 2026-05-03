// ============================================================
// SESSIONS — per-quiz history.
//
// Writes one row to `reading_sessions` after every completed quiz so
// we can power "today's plan" rings, streaks, and (later) progress
// reports. In-memory cache of today's stats so the home screen
// renders without a round-trip on every open.
//
// Guest mode skips persistence (no studentId attached).
// ============================================================

import { supabase } from "./supabase.js";

let todayCache = null;
let todayCacheStudentId = null;
let todayCacheDate = null;

// Insert a session record. Called from the dashboard after every quiz.
export async function recordSession({
  studentId,
  durationSec,
  totalAttempts,
  correctCount,
  masteredCount,
  avgLatencyMs,
  wasDiagnostic,
  strand,
}) {
  if (!studentId || studentId === "guest"
      || String(studentId).startsWith("local-")) {
    return;
  }

  const row = {
    student_id: studentId,
    duration_sec: durationSec || 0,
    total_attempts: totalAttempts || 0,
    correct_count: correctCount || 0,
    mastered_count: masteredCount || 0,
    avg_latency_ms: avgLatencyMs || 0,
    was_diagnostic: !!wasDiagnostic,
    strand: strand || null,
  };

  const { error } = await supabase.from("reading_sessions").insert(row);
  if (error) {
    console.warn("Failed to record reading session:", error.message);
    return;
  }

  // Invalidate today cache so the next getTodayStats() refetches.
  todayCache = null;
}

// Fetch today's stats for a student. Cached in-memory until day rolls
// over (so refreshing the home screen many times doesn't hit Supabase
// each time). Returns zeros if no rows or guest.
export async function getTodayStats(studentId) {
  const empty = { sessions: 0, total_attempts: 0, correct_count: 0, mastered_count: 0 };
  if (!studentId || studentId === "guest"
      || String(studentId).startsWith("local-")) {
    return empty;
  }

  const today = new Date().toDateString();
  if (todayCache && todayCacheStudentId === studentId && todayCacheDate === today) {
    return todayCache;
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("reading_sessions")
    .select("*")
    .eq("student_id", studentId)
    .gte("completed_at", startOfDay.toISOString());

  if (error) {
    console.warn("Failed to load today's sessions:", error.message);
    return empty;
  }

  const stats = (data || []).reduce(
    (acc, r) => ({
      sessions:       acc.sessions + 1,
      total_attempts: acc.total_attempts + (r.total_attempts || 0),
      correct_count:  acc.correct_count  + (r.correct_count  || 0),
      mastered_count: acc.mastered_count + (r.mastered_count || 0),
    }),
    empty
  );

  todayCache = stats;
  todayCacheStudentId = studentId;
  todayCacheDate = today;
  return stats;
}
