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
//          mastery,                     // 0..100 integer | null
//          masteryRaw,                  // provider value, untouched
//          state,                       // mastered|learning|review|not_started|unknown
//          providerState,               // provider's raw state string | null
//          lastPracticedAt,             // ISO string | null
//          metadata                     // unrecognized provider fields
//        }],
//        summary: { mastered, learning, review, notStarted, unknown, total }
//      }
//
// Route resolution (in order):
//   1. MA_KNOWLEDGE_ROUTE env — the confirmed Beta 9 path, e.g.
//        MA_KNOWLEDGE_ROUTE=/students/{id}/knowledge
//        MA_KNOWLEDGE_METHOD=GET            (or POST; body {studentId})
//      Set these once Math Academy confirms the contract.
//   2. If unset AND MA_KNOWLEDGE_DISCOVERY=true — probe candidate
//      routes (GET spellings + RPC-style POST), cache the winner for
//      the lambda's lifetime. Off by default: auto-discovery in
//      steady-state risks silently adopting a semantically different
//      future route (e.g. a beta10 /knowledge that means something else).
//   3. Neither → 503 KNOWLEDGE_PROFILE_UNAVAILABLE.
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

    const [studentResp, knowledgeResp] = await Promise.all([
      maRequest(MA_BASE_URL_BETA5, `/students/${encodeURIComponent(maId)}`).catch(
        () => null
      ),
      fetchKnowledge(maId),
    ]);

    const courseRaw = studentResp?.student?.currentCourse || null;
    const course = courseRaw
      ? {
          id: String(courseRaw.id ?? ""),
          name: courseRaw.name || "Current Course",
          percentComplete: Math.round((Number(courseRaw.progress) || 0) * 100),
        }
      : null;

    const raw =
      knowledgeResp?.knowledge ??
      knowledgeResp?.student?.knowledge ??
      knowledgeResp;
    const rawTopics = Array.isArray(raw) ? raw : raw?.topics || raw?.items || [];
    const topics = rawTopics.map(normalizeTopic);

    return res.status(200).json({
      studentId,
      asOf: raw?.asOf || raw?.timestamp || new Date().toISOString(),
      course,
      topics,
      summary: summarize(topics),
    });
  } catch (err) {
    // Full diagnostics server-side only.
    console.error("[math-academy/knowledge]", err.message);
    return res.status(err.code === "UNCONFIGURED" ? 503 : 502).json({
      error: "KNOWLEDGE_PROFILE_UNAVAILABLE",
      retryable: err.code !== "UNCONFIGURED",
    });
  }
}

// ---- Route resolution ----

// RPC-style POST is a real possibility: the announcement says "the
// getStudentKnowledge endpoint", and an Express "Cannot GET /x" only
// proves there's no GET handler — a POST route may still exist.
const GET_CANDIDATES = [
  (id) => `/students/${id}/knowledge`,
  (id) => `/students/${id}/knowledge-profile`,
  (id) => `/students/${id}/knowledgeProfile`,
  (id) => `/getStudentKnowledge?studentId=${id}`,
];
const POST_CANDIDATES = [
  () => `/getStudentKnowledge`,
  () => `/students/getStudentKnowledge`,
];

let cachedRoute = null; // { method, build } for this lambda's lifetime

async function fetchKnowledge(maId) {
  const id = encodeURIComponent(maId);

  // 1. Explicitly configured route wins, always.
  const configured = process.env.MA_KNOWLEDGE_ROUTE;
  if (configured) {
    const method = (process.env.MA_KNOWLEDGE_METHOD || "GET").toUpperCase();
    const path = configured.replace("{id}", id);
    return maRequest(MA_BASE_URL_BETA9, path, {
      method,
      ...(method === "POST" ? { body: { studentId: maId } } : {}),
    });
  }

  // 2. Discovery only when explicitly enabled.
  if (process.env.MA_KNOWLEDGE_DISCOVERY !== "true") {
    const err = new Error(
      "MA_KNOWLEDGE_ROUTE not set and MA_KNOWLEDGE_DISCOVERY!=true — set the confirmed Beta 9 route to enable this endpoint"
    );
    err.code = "UNCONFIGURED";
    throw err;
  }

  if (cachedRoute) {
    return maRequest(MA_BASE_URL_BETA9, cachedRoute.build(id), {
      method: cachedRoute.method,
      ...(cachedRoute.method === "POST" ? { body: { studentId: maId } } : {}),
    });
  }

  const attempts = [];
  for (const build of GET_CANDIDATES) {
    try {
      const data = await maRequest(MA_BASE_URL_BETA9, build(id));
      cachedRoute = { method: "GET", build };
      return data;
    } catch (err) {
      attempts.push(`GET ${build(id)} [${err.status || "ERR"}]`);
    }
  }
  for (const build of POST_CANDIDATES) {
    try {
      const data = await maRequest(MA_BASE_URL_BETA9, build(id), {
        method: "POST",
        body: { studentId: maId },
      });
      cachedRoute = { method: "POST", build };
      return data;
    } catch (err) {
      attempts.push(`POST ${build(id)} [${err.status || "ERR"}]`);
    }
  }

  // Version-liveness check enriches the server-side log only.
  let versionCheck;
  try {
    await maRequest(MA_BASE_URL_BETA9, `/students/${id}`);
    versionCheck = "beta9 /students/{id} OK — route name wrong";
  } catch (err) {
    versionCheck = `beta9 /students/{id} → ${err.status || "ERR"}`;
  }
  throw new Error(
    `Beta 9 knowledge route not found. ${versionCheck}. Tried: ${attempts.join(", ")}`
  );
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
  "unit", "unitName", "unitId", "module",
  "mastery", "knowledgeLevel", "score", "progress", "strength", "proficiency",
  "state", "status",
  "lastPracticedAt", "lastActivityAt", "lastSeen",
]);

function normalizeTopic(t) {
  const rawMastery =
    t.mastery ?? t.knowledgeLevel ?? t.score ?? t.progress ?? t.strength ?? null;
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
    unitName: t.unitName ?? t.unit ?? t.module ?? null,
    mastery,
    masteryRaw: rawMastery,
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
