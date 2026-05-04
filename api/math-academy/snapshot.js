// ============================================================
// MATH ACADEMY — /api/math-academy/snapshot
//
// Proxies Math Academy's official Beta 5 partner API into the
// orchestration dashboard contract. Read-only — uses just the
// Public-API-Key header. (HMAC is required only for postStudent;
// we don't need writes here.)
//
//   GET /api/math-academy/snapshot?student=<vpa-student-uuid>
//   →  {
//        studentId, date,
//        todayXp, weekXp, dailyGoalXp,
//        nextDrill: { label, path }
//      }
//
// The "studentId" query param is the VPA student UUID. The Math
// Academy student id is looked up server-side from
// student_app_accounts.external_id (existing table from
// 001_initial_schema.sql — its design comment explicitly says
// "external_id = MA student ID" for Math Academy).
//
// When no math_academy row is linked for a student, we return a
// calm zero-state with `_notLinked: true` so the dashboard can
// render a "Connect Math Academy" card instead of erroring.
//
// CORS: Access-Control-Allow-Origin: *, OPTIONS short-circuit —
// matches /api/snapshot and reading-facts-app/api/snapshot.
//
// Required Vercel env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   MA_PUBLIC_API_KEY                (partner public key)
// Optional:
//   MA_SECRET_KEY                    (only needed for HMAC writes)
// ============================================================

import { createClient } from "@supabase/supabase-js";

const MA_BASE_URL = "https://mathacademy.com/api/beta5";

// Math Academy stores per-weekday daily goals on the student
// schedule. We pick today's goal using Denver-local day-of-week,
// matching the dashboard's "today" semantics.
const SCHEDULE_KEYS = [
  "sunGoal", "monGoal", "tueGoal", "wedGoal",
  "thuGoal", "friGoal", "satGoal",
];

// Math Academy's daily-task screen for logged-in students. This is
// the canonical "do today's work" entry point. If MA changes their
// URL scheme, this is the only string to edit.
const MA_DAILY_TASK_PATH = "/learn";

// Build the nextDrill object that the dashboard uses for the launch
// button label. Three cases, in priority order:
//   1. Rest day (dailyGoalXp === 0) → friendly "Rest day" copy.
//   2. Goal hit (todayXp >= goal && goal > 0) → bonus-practice copy.
//   3. Has a current course → "<Course> — N% complete".
//   4. Fallback → generic "Continue Math Academy".
// All variants deep-link to /learn so the click actually starts work.
function buildNextDrill({ course, dailyGoalXp, todayXp }) {
  if (dailyGoalXp === 0) {
    return {
      label: "Rest day — bonus practice?",
      path: MA_DAILY_TASK_PATH,
    };
  }
  if (todayXp >= dailyGoalXp && dailyGoalXp > 0) {
    return {
      label: course
        ? `${course.name} — goal complete`
        : "Daily goal complete",
      path: MA_DAILY_TASK_PATH,
    };
  }
  if (course) {
    return {
      label: `${course.name} — ${Math.round((course.progress ?? 0) * 100)}% complete`,
      path: MA_DAILY_TASK_PATH,
    };
  }
  return { label: "Continue Math Academy", path: MA_DAILY_TASK_PATH };
}

// Denver-local "today" as YYYY-MM-DD. Identical helper to the
// math-facts and reading-facts snapshot endpoints.
function denverDateISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// Denver-local date N days ago, formatted YYYY-MM-DD. Used as the
// 7-day window's start when querying activity. Built off Denver's
// midnight at MDT (UTC-6); during the four-month MST window we err
// one hour earlier, which is harmless for a date-granularity API.
function denverDateNDaysAgo(days) {
  const today = denverDateISO();
  const [y, m, d] = today.split("-").map(Number);
  const utcMidnightDenver = Date.UTC(y, m - 1, d, 6, 0, 0);
  const past = new Date(utcMidnightDenver - days * 86400000);
  const yy = past.getUTCFullYear();
  const mm = String(past.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(past.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Day-of-week 0..6 (Sun..Sat) in America/Denver.
function denverDayOfWeek() {
  const w = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    weekday: "short",
  }).format(new Date());
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[w] ?? 0;
}

// Math Academy's schedule sub-object → today's XP goal (number).
function pickTodayGoal(schedule) {
  if (!schedule) return 0;
  const key = SCHEDULE_KEYS[denverDayOfWeek()];
  return Number(schedule[key]) || 0;
}

// Wrap fetch with the MA partner-API headers. Throws on non-2xx
// with the response body included so failures surface usefully.
async function maGet(path, extraHeaders = {}) {
  const publicKey = process.env.MA_PUBLIC_API_KEY;
  if (!publicKey) {
    throw new Error("MA_PUBLIC_API_KEY env var not configured");
  }
  const res = await fetch(`${MA_BASE_URL}${path}`, {
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Public-API-Key": publicKey,
      ...extraHeaders,
    },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(
      `MA ${path} → HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`
    );
  }
  return res.json();
}

async function safeText(res) {
  try {
    const t = await res.text();
    return t.length > 200 ? t.slice(0, 200) + "…" : t;
  } catch {
    return "";
  }
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

    // 1. Look up the Math Academy student id linked to this VPA student.
    //    The join filters student_app_accounts by app slug = math_academy.
    const { data: link, error: linkErr } = await supabase
      .from("student_app_accounts")
      .select("external_id, learning_apps!inner(slug)")
      .eq("student_id", studentId)
      .eq("learning_apps.slug", "math_academy")
      .eq("enabled", true)
      .maybeSingle();

    if (linkErr) throw linkErr;

    if (!link?.external_id) {
      // No link yet — render-friendly empty state.
      return res.status(200).json({
        studentId,
        date: denverDateISO(),
        todayXp: 0,
        weekXp: 0,
        dailyGoalXp: 0,
        nextDrill: {
          label: "Connect Math Academy account",
          path: "/",
        },
        league: null,
        _notLinked: true,
      });
    }

    const maId = link.external_id;
    const today = denverDateISO();
    const weekStart = denverDateNDaysAgo(6); // 7-day inclusive window

    // 2. Three parallel reads against the partner API.
    //    /students/{id}            → schedule + currentCourse
    //    /students/{id}/activity   → today's totals (Start/End headers)
    //    /students/{id}/activity   → 7-day totals
    const [studentResp, todayResp, weekResp] = await Promise.all([
      maGet(`/students/${encodeURIComponent(maId)}`),
      maGet(`/students/${encodeURIComponent(maId)}/activity`, {
        "Start-Date": today,
        "End-Date": today,
      }),
      maGet(`/students/${encodeURIComponent(maId)}/activity`, {
        "Start-Date": weekStart,
        "End-Date": today,
      }),
    ]);

    const studentObj = studentResp?.student || {};
    const todayXp = Number(todayResp?.activity?.totals?.xpAwarded) || 0;
    const weekXp  = Number(weekResp?.activity?.totals?.xpAwarded) || 0;
    const dailyGoalXp = pickTodayGoal(studentObj.schedule);

    const course = studentObj.currentCourse || null;
    const nextDrill = buildNextDrill({ course, dailyGoalXp, todayXp });

    // League is null on the MA student object when the student isn't
    // currently enrolled in one — pass through verbatim, including null.
    const league = studentObj.league || null;

    return res.status(200).json({
      studentId,
      date: today,
      todayXp,
      weekXp,
      dailyGoalXp,
      nextDrill,
      league,
    });
  } catch (err) {
    return res.status(500).json({
      error: "snapshot fetch failed",
      details: err.message,
    });
  }
}

// Exported for unit testing — not part of the HTTP surface.
export const __test__ = {
  denverDateISO,
  denverDateNDaysAgo,
  denverDayOfWeek,
  pickTodayGoal,
  buildNextDrill,
  SCHEDULE_KEYS,
  MA_BASE_URL,
  MA_DAILY_TASK_PATH,
};
