// ============================================================
// MATH ACADEMY — /api/math-academy/mastery
//
// Course-level "mastery" rollup for the orchestration dashboard's
// skill garden. Math Academy's Beta 5 partner API doesn't expose
// per-topic mastery, so the best we can do today is the current
// course and its overall progress.
//
//   GET /api/math-academy/mastery?student=<vpa-student-uuid>
//   →  {
//        studentId,
//        strands: [
//          {
//            id: "current",
//            label: "<course name>",       // e.g. "Algebra I"
//            symbol: "∑",                  // matches learning_apps.icon
//            mastered: number,             // % completed (0..100, integer)
//            attempted: number,            // 100 (we don't know task counts)
//            total: 100,
//            avgScore: 0..1,               // course progress
//            grade: number?,               // 0..1 letter-grade percentage
//            letterGrade: string?,         // "A" | "B" | …
//            xpRemaining: number?
//          }
//        ]
//      }
//
// When the student isn't linked to a Math Academy account, returns
// strands: [] and _notLinked: true.
//
// CORS *: same as snapshot.
// ============================================================

import { createClient } from "@supabase/supabase-js";

const MA_BASE_URL = "https://mathacademy.com/api/beta5";

async function maGet(path) {
  const publicKey = process.env.MA_PUBLIC_API_KEY;
  if (!publicKey) throw new Error("MA_PUBLIC_API_KEY env var not configured");
  const res = await fetch(`${MA_BASE_URL}${path}`, {
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Public-API-Key": publicKey,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`MA ${path} → HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  return res.json();
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

    const { data: link, error } = await supabase
      .from("student_app_accounts")
      .select("external_id, learning_apps!inner(slug)")
      .eq("student_id", studentId)
      .eq("learning_apps.slug", "math_academy")
      .eq("enabled", true)
      .maybeSingle();
    if (error) throw error;

    if (!link?.external_id) {
      return res.status(200).json({
        studentId,
        strands: [],
        _notLinked: true,
      });
    }

    const studentResp = await maGet(`/students/${encodeURIComponent(link.external_id)}`);
    const course = studentResp?.student?.currentCourse || null;

    if (!course) {
      return res.status(200).json({
        studentId,
        strands: [],
        _noCourse: true,
      });
    }

    const progress01 = Number(course.progress) || 0;
    const pct = Math.round(progress01 * 100);

    return res.status(200).json({
      studentId,
      strands: [
        {
          id: "current",
          label: course.name || "Current Course",
          symbol: "∑",
          mastered: pct,
          attempted: 100,
          total: 100,
          avgScore: progress01,
          grade: typeof course.grade === "number" ? course.grade : null,
          letterGrade: course.letterGrade || null,
          xpRemaining: typeof course.xpRemaining === "number" ? course.xpRemaining : null,
        },
      ],
    });
  } catch (err) {
    return res.status(500).json({
      error: "mastery fetch failed",
      details: err.message,
    });
  }
}
