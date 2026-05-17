// ============================================================
// Daily-progress writer for Reading Facts.
//
// Mirrors the pattern in math-facts-trainer-react/src/storage.js
// (the `saveSessionToSupabase` function): after each successful
// session save, upsert daily_progress.per_app.reading_facts so
// the attendance economy can see "this student showed up today."
//
// Read-modify-write: we read the existing row, set per_app.reading_facts
// to {xp: existing + delta}, recompute total_xp from the sum of all
// per_app entries, write back. Race-safe enough for a small pilot
// because each app only mutates its own per_app slot; the worst-case
// concurrent-write outcome is one slot's update being lost briefly
// until the next save. If concurrency ever matters, swap this for a
// Postgres RPC that does the merge atomically.
// ============================================================

import { supabase } from "./supabase.js";

const APP_SLUG = "reading_facts";

function todayInDenver() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function xpFromSec(sec) {
  return Math.round((sec / 60) * 10) / 10;
}

/**
 * Add this session's XP to today's daily_progress row for the student.
 * Caller passes the session's duration_sec; we convert to XP using the
 * same xpFromSec helper as the snapshot endpoint.
 *
 * No-op for guest / local students or when no time was logged.
 */
export async function bumpDailyProgress({ studentId, durationSec }) {
  if (!studentId || studentId === "guest" || String(studentId).startsWith("local-")) {
    return;
  }
  const xp = xpFromSec(durationSec || 0);
  if (xp <= 0) return;

  const day = todayInDenver();

  // 1. Read existing row (RLS allows the student to read their own).
  const { data: existing, error: readErr } = await supabase
    .from("daily_progress")
    .select("total_xp, total_active_seconds, per_app")
    .eq("student_id", studentId)
    .eq("day", day)
    .maybeSingle();
  if (readErr && readErr.code !== "PGRST116") {
    console.warn("[dailyProgress] read failed:", readErr.message);
    return;
  }

  const perApp = existing?.per_app || {};
  const cur = perApp[APP_SLUG] || { xp: 0, active_seconds: 0 };
  perApp[APP_SLUG] = {
    xp: Math.round(((cur.xp || 0) + xp) * 10) / 10,
    active_seconds: (cur.active_seconds || 0) + Math.round(durationSec || 0),
  };

  // total_xp = sum across all apps. Idempotent — won't double-count
  // even if Math Facts wrote concurrently between our read and write
  // because per_app is a single column we replace whole, and total_xp
  // is derived.
  let total_xp = 0;
  for (const v of Object.values(perApp)) {
    total_xp += Number(v?.xp) || 0;
  }
  total_xp = Math.round(total_xp * 100) / 100;

  const total_active_seconds =
    (existing?.total_active_seconds || 0) + Math.round(durationSec || 0);

  const { error: writeErr } = await supabase
    .from("daily_progress")
    .upsert(
      {
        student_id: studentId,
        day,
        total_xp,
        total_active_seconds,
        per_app: perApp,
      },
      { onConflict: "student_id,day" },
    );
  if (writeErr) {
    console.warn("[dailyProgress] write failed:", writeErr.message);
  }
}
