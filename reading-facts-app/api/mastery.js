// ============================================================
// READING FACTS — /api/mastery
//
// Per-strand mastery rollup for the orchestration dashboard's
// "skill garden" view. Aggregates the reading_mastery table by
// atom-id prefix (matching the strand definitions in src/app.js).
//
//   GET /api/mastery?student=<vpa-student-uuid>
//   →  {
//        studentId,
//        strands: [
//          {
//            id: "phonics",
//            label: "Phonics",
//            symbol: "Aa",
//            mastered: 28,
//            attempted: 35,
//            // total:   pool size — added once we know the full atom catalog;
//            //          for now we count rows touched by this student
//            avgScore: 0.74,
//            recentlyImproved: 2  // atoms whose last attempt is < 7 days ago
//                                 // and whose score crossed 0.7 in that window
//          },
//          ...
//        ]
//      }
//
// CORS *: same as snapshot.
//
// Strand resolution by atom-id prefix (see questions.js helpers):
//   gpc.*  → phonics
//   sw.*   → sight words
//   pa*.*  → phonemic awareness  (pa9. / pa5. / pa14.)
//   bl.*   → blending
//   pic.*  → picture words
//   vocab.* → vocabulary
// ============================================================

import { createClient } from "@supabase/supabase-js";

// "Mastered" threshold — same value used by the in-app
// computeStrandStats / masteredAtomCount helpers in src/app.js.
const MASTERED_THRESHOLD = 0.7;

const STRAND_DEFS = [
  { id: "phonics",  label: "Phonics",        symbol: "Aa",  prefixes: ["gpc."] },
  { id: "sight",    label: "Sight Words",    symbol: "the", prefixes: ["sw."] },
  { id: "pa",       label: "Phoneme Sounds", symbol: "🔊",  prefixes: ["pa9.", "pa5.", "pa14."] },
  { id: "blending", label: "Blending",       symbol: "→",   prefixes: ["bl."] },
  { id: "vocab",    label: "Vocabulary",     symbol: "📖",  prefixes: ["vocab."] },
  { id: "pictures", label: "Picture Words",  symbol: "🐛",  prefixes: ["pic."] },
];

function strandFor(atomId) {
  for (const s of STRAND_DEFS) {
    if (s.prefixes.some((p) => atomId.startsWith(p))) return s.id;
  }
  return null; // unknown — exclude from rollup
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

    const { data: rows, error } = await supabase
      .from("reading_mastery")
      .select("atom_id, mastery_score, last_attempt_at")
      .eq("student_id", studentId);

    if (error) throw error;

    // Initialize per-strand accumulators.
    const acc = Object.create(null);
    for (const s of STRAND_DEFS) {
      acc[s.id] = { mastered: 0, attempted: 0, sumScore: 0, recentlyImproved: 0 };
    }

    const sevenDaysAgoMs = Date.now() - 7 * 86400000;

    for (const r of rows || []) {
      const sid = strandFor(r.atom_id);
      if (!sid) continue;
      const a = acc[sid];
      a.attempted += 1;
      const score = Number(r.mastery_score) || 0;
      a.sumScore += score;
      if (score >= MASTERED_THRESHOLD) a.mastered += 1;
      if (
        r.last_attempt_at &&
        Date.parse(r.last_attempt_at) > sevenDaysAgoMs &&
        score >= MASTERED_THRESHOLD
      ) {
        a.recentlyImproved += 1;
      }
    }

    const strands = STRAND_DEFS.map((s) => {
      const a = acc[s.id];
      return {
        id: s.id,
        label: s.label,
        symbol: s.symbol,
        mastered: a.mastered,
        attempted: a.attempted,
        avgScore: a.attempted > 0 ? Number((a.sumScore / a.attempted).toFixed(3)) : 0,
        recentlyImproved: a.recentlyImproved,
      };
    });

    return res.status(200).json({
      studentId,
      strands,
    });
  } catch (err) {
    return res.status(500).json({
      error: "mastery fetch failed",
      details: err.message,
    });
  }
}

export const __test__ = { strandFor, STRAND_DEFS, MASTERED_THRESHOLD };
