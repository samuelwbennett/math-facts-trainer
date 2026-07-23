// ============================================================
// MATH ACADEMY — /api/math-academy/knowledge
//
// Per-topic knowledge profile for the orchestration dashboard's
// Knowledge Graph section, from the Beta 9 partner API's
// getStudentKnowledge endpoint.
//
//   GET /api/math-academy/knowledge?student=<vpa-student-uuid>
//   →  {
//        studentId,
//        asOf:    string|null,
//        course:  { id, name, percentComplete } | null,
//        topics:  [{
//          id, name,
//          unitId, unitName,            // may be null
//          moduleId, moduleName,        // may be null
//          mastery,                     // 0..100 integer | null (from completion)
//          masteryRaw,                  // provider value, untouched
//          stability,                   // 0..100 | null — long-term retention
//          state,                       // mastered|learning|review|not_started|unknown
//          providerState,               // provider's raw state string | null
//          lastPracticedAt,             // ISO string | null
//          metadata                     // unrecognized provider fields
//        }],
//        summary: { mastered, learning, review, notStarted, unknown, total }
//      }
//
// Beta 9 contract (per MA's API doc, shared 2026-07-23):
//
//   GET {beta9}/students/:studentIdentifier/courses/:courseId/knowledge
//   Auth: Public-API-Key header only (GETs need no HMAC signature).
//   Response: course → units → modules → topics, each carrying a
//   completion metric on a 0..1 scale plus a "stability" property
//   ("how stable the knowledge is in terms of long-term retention"),
//   aggregating upward through the hierarchy.
//
// The courseId comes from the student's currentCourse (Beta 5
// /students/{id}, same as mastery.js). No current course → empty
// topics with _noCourse, mirroring mastery.js.
//
// MA_KNOWLEDGE_ROUTE env still overrides the documented path
// ({id} and {courseId} placeholders) as an escape hatch.
//
// Browser responses on failure are generic (no route topology);
// full attempt diagnostics go to Vercel logs via console.error.
//
// When the student isn't linked: topics [] and _notLinked: true.
// CORS *: same as snapshot.
// ============================================================

import { createClient } from "@supabase/supabase-js";

const MA_BASE_URL_BETA5 = "https://mathacademy.com/api/beta5";
const MA_BASE_URL_BETA9 =
  process.env.MA_KNOWLEDGE_API_BASE || "https://mathacademy.com/api/beta9";

async function maRequest(base, path, { method = "GET", body, headers = {} } = {}) {
  const publicKey = process.env.MA_PUBLIC_API_KEY;
  if (!publicKey) throw new Error("MA_PUBLIC_API_KEY env var not configured");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Public-API-Key": publicKey,
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(
      `MA ${method} ${path} → HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
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

    const maId = String(link.external_id);

    // Step 1: current course (Beta 5 student endpoint, known-good) —
    // the documented knowledge route requires a courseId.
    const studentResp = await maRequest(
      MA_BASE_URL_BETA5,
      `/students/${encodeURIComponent(maId)}`
    );
    const courseRaw = studentResp?.student?.currentCourse || null;
    if (!courseRaw?.id) {
      return res.status(200).json({
        studentId,
        asOf: null,
        course: null,
        topics: [],
        summary: emptySummary(),
        _noCourse: true,
      });
    }
    const course = {
      id: String(courseRaw.id),
      name: courseRaw.name || "Current Course",
      percentComplete: Math.round((Number(courseRaw.progress) || 0) * 100),
    };

    // Step 2: the knowledge profile itself.
    const knowledgeResp = await fetchKnowledge(maId, course.id);

    const raw =
      knowledgeResp?.knowledge ??
      knowledgeResp?.course ??
      knowledgeResp?.student?.knowledge ??
      knowledgeResp;
    const topics = flattenHierarchy(raw).map(normalizeTopic);

    return res.status(200).json({
      studentId,
      asOf: raw?.asOf || raw?.timestamp || new Date().toISOString(),
      course: {
        ...course,
        // Prefer the knowledge payload's own aggregates when present.
        percentComplete: toPct(raw?.completion) ?? course.percentComplete,
        stability: toPct(raw?.stability),
      },
      topics,
      summary: summarize(topics),
    });
  } catch (err) {
    // Full diagnostics server-side; ?debug=1 echoes them for
    // integration troubleshooting (route names + upstream status
    // only — no credentials ever appear in err.message).
    console.error("[math-academy/knowledge]", err.message);
    return res.status(err.code === "UNCONFIGURED" ? 503 : 502).json({
      error: "KNOWLEDGE_PROFILE_UNAVAILABLE",
      retryable: err.code !== "UNCONFIGURED",
      ...(req.query.debug === "1" ? { details: err.message } : {}),
    });
  }
}

// ---- Documented route (env-overridable) ----

const DEFAULT_ROUTE = "/students/{id}/courses/{courseId}/knowledge";

async function fetchKnowledge(maId, courseId) {
  const template = process.env.MA_KNOWLEDGE_ROUTE || DEFAULT_ROUTE;
  const path = template
    .replace("{id}", encodeURIComponent(maId))
    .replace("{courseId}", encodeURIComponent(courseId));
  const method = (process.env.MA_KNOWLEDGE_METHOD || "GET").toUpperCase();
  return maRequest(MA_BASE_URL_BETA9, path, {
    method,
    ...(method === "POST" ? { body: { studentId: maId, courseId } } : {}),
  });
}

// ---- Hierarchy flattening ----
// Documented shape: course → units → modules → topics, completion
// 0..1 at every level plus "stability". Flattened defensively so a
// missing level (topics directly on units, or a flat topics array)
// still works. Each topic row carries its unit for dashboard
// grouping and its module for finer context.
function flattenHierarchy(raw) {
  if (!raw || typeof raw !== "object") return [];

  // Flat shapes first (topics/items directly on the payload).
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.topics)) return raw.topics;
  if (Array.isArray(raw.items)) return raw.items;

  const units = Array.isArray(raw.units) ? raw.units : [];
  const out = [];
  for (const unit of units) {
    const unitCtx = {
      unitId: unit?.id != null ? String(unit.id) : null,
      unitName: unit?.name ?? unit?.unitName ?? null,
    };
    const modules = Array.isArray(unit?.modules) ? unit.modules : [];
    for (const mod of modules) {
      const topics = Array.isArray(mod?.topics) ? mod.topics : [];
      for (const t of topics) {
        out.push({
          ...t,
          ...unitCtx,
          moduleId: mod?.id != null ? String(mod.id) : null,
          moduleName: mod?.name ?? null,
        });
      }
    }
    // Topics directly on the unit (no module level).
    if (Array.isArray(unit?.topics)) {
      for (const t of unit.topics) out.push({ ...t, ...unitCtx });
    }
  }
  return out;
}

// ---- Normalization ----
// Deliberately loose until a real Beta 9 payload is in hand:
// unfamiliar provider states map to "unknown" (with providerState
// preserved) rather than being forced into a bucket, and mastery is
// null when the provider gives no usable number — the UI renders the
// state instead of a manufactured 0%.

const KNOWN_STATES = ["mastered", "learning", "review", "not_started"];
const RECOGNIZED_KEYS = new Set([
  "id", "topicId", "name", "topicName", "topic",
  "unit", "unitName", "unitId", "module", "moduleId", "moduleName",
  "completion", "stability",
  "mastery", "knowledgeLevel", "score", "progress", "strength", "proficiency",
  "state", "status",
  "lastPracticedAt", "lastActivityAt", "lastSeen",
]);

function normalizeTopic(t) {
  // Beta 9 documents `completion` (0..1); older guesses kept as
  // fallbacks so the adapter tolerates drift.
  const rawMastery =
    t.completion ?? t.mastery ?? t.knowledgeLevel ?? t.score ?? t.progress ??
    t.strength ?? null;
  const mastery = toPct(rawMastery);
  const providerState = t.state ?? t.status ?? null;

  const metadata = {};
  for (const k of Object.keys(t)) {
    if (!RECOGNIZED_KEYS.has(k)) metadata[k] = t[k];
  }

  return {
    id: String(t.id ?? t.topicId ?? ""),
    name: String(t.name ?? t.topicName ?? t.topic ?? ""),
    unitId: t.unitId != null ? String(t.unitId) : null,
    unitName: t.unitName ?? t.unit ?? null,
    moduleId: t.moduleId ?? null,
    moduleName: t.moduleName ?? t.module ?? null,
    mastery,
    masteryRaw: rawMastery,
    // Long-term retention strength, 0..100 (documented "stability").
    stability: toPct(t.stability),
    state: deriveState(providerState, mastery),
    providerState: providerState != null ? String(providerState) : null,
    lastPracticedAt: t.lastPracticedAt ?? t.lastActivityAt ?? t.lastSeen ?? null,
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}

function deriveState(rawState, mastery) {
  if (rawState != null) {
    const s = String(rawState).toLowerCase().replace(/[\s-]+/g, "_");
    if (KNOWN_STATES.includes(s)) return s;
    // Unfamiliar provider state (e.g. "conditionally_completed"):
    // don't guess — surface as unknown, keep providerState.
    return "unknown";
  }
  if (mastery == null) return "unknown";
  if (mastery >= 100) return "mastered";
  if (mastery > 0) return "learning";
  return "not_started";
}

function toPct(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
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
    else if (t.state === "not_started") summary.notStarted++;
    else summary.unknown++;
  }
  return summary;
}

function emptySummary() {
  return { mastered: 0, learning: 0, review: 0, notStarted: 0, unknown: 0, total: 0 };
}
