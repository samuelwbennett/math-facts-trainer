// ============================================================
// MATH ACADEMY — /api/math-academy/knowledge
//
// Per-topic knowledge profile for the orchestration dashboard's
// Knowledge Graph section. Uses the Beta 9 partner API's
// getStudentKnowledge endpoint (Beta 5, which the other handlers
// use, doesn't expose per-topic knowledge).
//
//   GET /api/math-academy/knowledge?student=<vpa-student-uuid>
//   →  {
//        studentId,
//        asOf:    string|null,          // ISO timestamp
//        course:  { id, name, percentComplete } | null,
//        topics:  [{
//          id, name, unit,              // unit may be null
//          mastery,                     // 0..100 integer
//          state,                       // mastered|learning|review|not_started
//          lastPracticedAt              // ISO string | null
//        }],
//        summary: { mastered, learning, review, notStarted, total }
//      }
//
// When the student isn't linked: topics [] and _notLinked: true
// (mirrors mastery.js). When Beta 9 rejects the call (endpoint
// still rolling out, unexpected shape): 502 with details, so the
// dashboard adapter degrades honestly instead of showing zeros.
//
// NOTE on the Beta 9 path: MA's partner docs aren't public and
// /students/{id}/knowledge returned 404, so this handler PROBES a
// list of candidate routes (REST + operation-name conventions) on
// first use, locks onto whichever answers, and caches it for the
// lifetime of the lambda. On total failure the 502 details include
// every attempt's status so the next fix is one constant.
//
// CORS *: same as snapshot.
// ============================================================

import { createClient } from "@supabase/supabase-js";

const MA_BASE_URL_BETA5 = "https://mathacademy.com/api/beta5";
const MA_BASE_URL_BETA9 = "https://mathacademy.com/api/beta9";

async function maGet(base, path, extraHeaders = {}) {
  const publicKey = process.env.MA_PUBLIC_API_KEY;
  if (!publicKey) throw new Error("MA_PUBLIC_API_KEY env var not configured");
  const res = await fetch(`${base}${path}`, {
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Public-API-Key": publicKey,
      ...extraHeaders,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(
      `MA ${path} → HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`
    );
    err.status = res.status;
    throw err;
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
        asOf: null,
        course: null,
        topics: [],
        summary: emptySummary(),
        _notLinked: true,
      });
    }

    const maId = encodeURIComponent(link.external_id);

    // Course context from the known-good Beta 5 student endpoint;
    // knowledge profile from Beta 9. Parallel, independent failures:
    // course context is nice-to-have, knowledge is the payload.
    const [studentResp, knowledgeResp] = await Promise.all([
      maGet(MA_BASE_URL_BETA5, `/students/${maId}`).catch(() => null),
      fetchKnowledgeProbing(maId),
    ]);

    const courseRaw = studentResp?.student?.currentCourse || null;
    const course = courseRaw
      ? {
          id: String(courseRaw.id ?? ""),
          name: courseRaw.name || "Current Course",
          percentComplete: Math.round((Number(courseRaw.progress) || 0) * 100),
        }
      : null;

    // Beta 9 response shape is normalized defensively: accept the
    // topics list wherever MA puts it, and map best-guess field
    // names. Adjust normalizeTopic() as the real payload dictates.
    const raw =
      knowledgeResp?.knowledge ??
      knowledgeResp?.student?.knowledge ??
      knowledgeResp;
    const rawTopics = Array.isArray(raw)
      ? raw
      : raw?.topics || raw?.items || [];
    const topics = rawTopics.map(normalizeTopic);

    return res.status(200).json({
      studentId,
      asOf: raw?.asOf || raw?.timestamp || new Date().toISOString(),
      course,
      topics,
      summary: summarize(topics),
    });
  } catch (err) {
    return res.status(502).json({
      error: "knowledge fetch failed",
      details: err.message,
    });
  }
}

// ---- Beta 9 route discovery ----
// Ordered by likelihood: REST-style resources first (matches
// /students/{id}/activity), then RPC-style operation names.
const CANDIDATE_PATHS = [
  (id) => `/students/${id}/knowledge`,
  (id) => `/students/${id}/knowledge-profile`,
  (id) => `/students/${id}/knowledgeProfile`,
  (id) => `/students/${id}/knowledge-graph`,
  (id) => `/students/${id}/topics`,
  (id) => `/getStudentKnowledge?studentId=${id}`,
  (id) => `/getStudentKnowledge?student=${id}`,
  (id) => `/students/${id}/getStudentKnowledge`,
  (id) => `/knowledge?studentId=${id}`,
];

// Module-level cache: warm lambdas skip re-probing.
let knownGoodPath = null;

async function fetchKnowledgeProbing(maId) {
  if (knownGoodPath) {
    return maGet(MA_BASE_URL_BETA9, knownGoodPath(maId));
  }
  const attempts = [];
  for (const build of CANDIDATE_PATHS) {
    const path = build(maId);
    try {
      const data = await maGet(MA_BASE_URL_BETA9, path);
      knownGoodPath = build;
      return data;
    } catch (err) {
      attempts.push(`${path} [${err.status || "ERR"}]`);
      // 404 → route doesn't exist, keep probing. Anything else
      // (401/403/400/5xx) is still worth continuing past, but the
      // status lands in the attempt log either way.
    }
  }
  // Distinguish "wrong route name" from "beta9 not live at all":
  // /students/{id} works on beta5, so its beta9 status tells us
  // whether the version exists on this host.
  let versionCheck = "unknown";
  try {
    await maGet(MA_BASE_URL_BETA9, `/students/${maId}`);
    versionCheck = "beta9 alive (/students/{id} OK) — knowledge route name is wrong";
  } catch (err) {
    versionCheck = `beta9 /students/{id} → ${err.status || "ERR"}${
      err.status === 404 ? " — beta9 may not be live on this host yet" : ""
    }`;
  }
  throw new Error(
    `Beta 9 knowledge route not found. ${versionCheck}. Tried: ${attempts.join(", ")}`
  );
}

function normalizeTopic(t) {
  const mastery = pct(t.mastery ?? t.knowledgeLevel ?? t.score ?? t.progress);
  return {
    id: String(t.id ?? t.topicId ?? ""),
    name: String(t.name ?? t.topicName ?? t.topic ?? ""),
    unit: t.unit ?? t.unitName ?? t.module ?? null,
    mastery,
    state: deriveState(t.state ?? t.status, mastery),
    lastPracticedAt: t.lastPracticedAt ?? t.lastActivityAt ?? t.lastSeen ?? null,
  };
}

function deriveState(rawState, mastery) {
  const s = String(rawState || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (["mastered", "learning", "review", "not_started"].includes(s)) return s;
  if (mastery >= 100) return "mastered";
  if (mastery > 0) return "learning";
  return "not_started";
}

function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  // Accept 0..1 fractions or 0..100 percentages.
  const scaled = n > 0 && n <= 1 ? n * 100 : n;
  return Math.min(100, Math.max(0, Math.round(scaled)));
}

function summarize(topics) {
  const summary = emptySummary();
  summary.total = topics.length;
  for (const t of topics) {
    if (t.state === "mastered") summary.mastered++;
    else if (t.state === "learning") summary.learning++;
    else if (t.state === "review") summary.review++;
    else summary.notStarted++;
  }
  return summary;
}

function emptySummary() {
  return { mastered: 0, learning: 0, review: 0, notStarted: 0, total: 0 };
}
