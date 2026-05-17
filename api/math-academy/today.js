// ============================================================
// MATH ACADEMY — /api/math-academy/today
//
// VPA Orchestration Contract v1.0 — top recommendation for today.
// Same shape as reading-academy/api/_handlers/today.js and the
// in-house /api/today endpoints.
//
// Reads from Math Academy's Beta 5 partner API (read-only, public
// key only). Logic:
//   - Not linked → kind:"none", "Connect Math Academy account"
//   - Daily goal = 0 (rest day) → kind:"none", "Rest day"
//   - todayXp >= dailyGoalXp → kind:"none", "Goal met"
//   - Otherwise → kind:"drill" with course + XP-to-goal subtitle
//
// CORS: Access-Control-Allow-Origin: *.
// ============================================================

import { createClient } from "@supabase/supabase-js";

const MA_BASE_URL = "https://mathacademy.com/api/beta5";
const CONTRACT_VERSION = "1.0";
const APP_SLUG = "math_academy";

const SCHEDULE_KEYS = [
  "sunGoal", "monGoal", "tueGoal", "wedGoal",
  "thuGoal", "friGoal", "satGoal",
];

function denverDateISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function denverDayOfWeek() {
  const w = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    weekday: "short",
  }).format(new Date());
  return { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }[w] ?? 0;
}

function pickTodayGoal(schedule) {
  if (!schedule) return 0;
  return Number(schedule[SCHEDULE_KEYS[denverDayOfWeek()]]) || 0;
}

function dailyTaskPath(numericId) {
  if (numericId == null) return "/";
  return `/students/${encodeURIComponent(numericId)}/activity`;
}

async function maGet(path, extraHeaders = {}) {
  const publicKey = process.env.MA_PUBLIC_API_KEY;
  if (!publicKey) throw new Error("MA_PUBLIC_API_KEY env var not configured");
  const res = await fetch(`${MA_BASE_URL}${path}`, {
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Public-API-Key": publicKey,
      ...extraHeaders,
    },
  });
  if (!res.ok) {
    let body = "";
    try { body = (await res.text()).slice(0, 200); } catch {}
    throw new Error(`MA ${path} → HTTP ${res.status}${body ? ` — ${body}` : ""}`);
  }
  return res.json();
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

    const { data: link, error: linkErr } = await supabase
      .from("student_app_accounts")
      .select("external_id, learning_apps!inner(slug)")
      .eq("student_id", studentId)
      .eq("learning_apps.slug", APP_SLUG)
      .eq("enabled", true)
      .maybeSingle();
    if (linkErr) throw linkErr;

    if (!link?.external_id) {
      return res.status(200).json({
        studentId, appId: APP_SLUG,
        recommendation: {
          kind: "none",
          headline: "Connect Math Academy account",
          subtitle: "Ask the admin to link this account.",
          estimatedMinutes: 0, priority: "low",
          path: "/", reason: "not_linked",
        },
        blocksRemaining: 0,
        _notLinked: true,
      });
    }

    const maId = link.external_id;
    const today = denverDateISO();

    const [studentResp, todayResp] = await Promise.all([
      maGet(`/students/${encodeURIComponent(maId)}`),
      maGet(`/students/${encodeURIComponent(maId)}/activity`, {
        "Start-Date": today, "End-Date": today,
      }),
    ]);

    const studentObj = studentResp?.student || {};
    const todayXp = Number(todayResp?.activity?.totals?.xpAwarded) || 0;
    const dailyGoalXp = pickTodayGoal(studentObj.schedule);
    const course = studentObj.currentCourse || null;
    const maNumericId = studentObj.id ?? null;
    const path = dailyTaskPath(maNumericId);

    // Rest day
    if (dailyGoalXp === 0) {
      return res.status(200).json({
        studentId, appId: APP_SLUG,
        recommendation: {
          kind: "none",
          headline: "Rest day",
          subtitle: course
            ? `${course.name} — no goal scheduled today.`
            : "No goal scheduled today.",
          estimatedMinutes: 0, priority: "low",
          path, reason: "rest_day",
        },
        blocksRemaining: 0,
      });
    }

    // Goal met
    if (todayXp >= dailyGoalXp) {
      return res.status(200).json({
        studentId, appId: APP_SLUG,
        recommendation: {
          kind: "none",
          headline: course ? `${course.name} — goal complete` : "Daily goal complete",
          subtitle: `${todayXp} XP earned — bonus practice optional.`,
          estimatedMinutes: 0, priority: "low",
          path, reason: "goal_met",
        },
        blocksRemaining: 0,
      });
    }

    // Below goal → drill
    const xpToGoal = Math.max(0, dailyGoalXp - todayXp);
    return res.status(200).json({
      studentId, appId: APP_SLUG,
      recommendation: {
        kind: "drill",
        headline: course
          ? `Continue ${course.name}`
          : "Continue Math Academy",
        subtitle: course
          ? `${Math.round((course.progress ?? 0) * 100)}% complete · ${xpToGoal} XP to today's goal of ${dailyGoalXp}.`
          : `${xpToGoal} XP to today's goal of ${dailyGoalXp}.`,
        estimatedMinutes: Math.max(5, Math.ceil(xpToGoal * 1.5)),
        priority: todayXp === 0 ? "high" : "medium",
        path,
        reason: todayXp === 0 ? "no_xp_yet" : "below_goal",
        details: {
          courseId: course?.id ?? null,
          courseName: course?.name ?? null,
          courseProgress: course?.progress ?? null,
        },
      },
      blocksRemaining: 1,
    });
  } catch (err) {
    return res.status(500).json({ error: "today fetch failed", details: err.message });
  }
}
