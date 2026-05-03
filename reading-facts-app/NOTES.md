# Reading Facts App — Deferred Work / Roadmap

Living notes for things we agreed to defer but want to come back to.
Most-important items are at the top.

---

## 🔊 Audio quality upgrade (do this soon)

**Why:** Browser TTS is fundamentally limited for isolated phonemes — the
`pickVoice` improvement we made (Samantha / Google US English / Aria)
helped but it's still robotic for `/m/`, `/sh/`, `/th/`, etc. Real
human-quality audio would dramatically improve the phonics experience.

**The plan:**

1. **Pre-generate MP3 files** for every atom's `sound` and `audioPrompt`
   using a high-quality TTS API. Recommended: OpenAI's `tts-1` model
   (~$0.015 per 1K chars). Estimated one-time cost for current ~238
   atom pool: **~$2**.
2. **Bundle the MP3s** in the Vercel deploy under `public/audio/`.
3. **Add an optional `audioFile` field to atoms.** When present, the
   app plays the file via `<audio>` (or `new Audio(url).play()`)
   instead of calling `playSound()` for TTS.
4. **Fall back to TTS** for any atom without an `audioFile` (so we can
   add new atoms without immediately needing to regenerate audio).

**Implementation sketch:**

```
scripts/generate-audio.js   ← reads atoms, calls OpenAI tts-1, writes mp3s
public/audio/m.mp3          ← per-atom audio files
public/audio/sun.mp3
public/audio/cat-blend.mp3  ← for PA-9 blending puzzles
…
```

In `data/questions.js`, helpers gain `audioFile` derivation:
```js
audioFile: `/audio/${id}.mp3`
```

In `src/app.js` `playSound`, prefer file:
```js
function playSound(text, category, atomId) {
  if (atomId && audioCache[atomId]) {
    new Audio(audioCache[atomId]).play();
    return;
  }
  // …existing TTS fallback…
}
```

**When to do this:** Before you put the app in front of a real kid for
extended testing. The TTS quirks compound over a 10-question quiz and
will frustrate a 6-year-old.

---

## Other deferred items (lower priority)

### Supabase Pro tier (~$25/mo)
Removes email rate limits, adds daily backups, no project-pause-when-idle.
Cancel custom-SMTP / Resend at the same time and let Supabase handle email
natively. Worth doing before you have real users.

### Tighten RLS before production
Current `reading_mastery` and `reading_sessions` tables have permissive
dev-mode RLS (any authenticated user can read/write any row). Before
real students use the system, add ownership policies that join through
the `students` table:
```sql
USING (student_id IN (
  SELECT id FROM students WHERE guardian_user_id = auth.uid()
))
```

### Custom Resend domain
Currently sending from `onboarding@resend.dev` (test sender, restricted
to your own email). Verify `send.vailperformanceacademy.com` in Resend
to send to anyone. Requires Squarespace DNS records — you have the steps.

### Forgetting-curve time decay on mastery
Mastery scores currently move via EMA but don't decay over time. Real
spaced retrieval needs:
```js
score *= Math.exp(-daysSinceLastAttempt / halfLifeDays)
```
Apply this on `loadMastery` before caching. Tunable per atom type
(GPC half-life ~14d, vocab half-life ~30d).

### Expand atom pool
- Tier-2 vocab: 30 → 50-100 (Beck/McKeown lists)
- PA atoms: more PA-9 blending words (especially CCVCC), PA-11 segmentation
- Morphology atoms (MO-1..MO-6) — completely missing today, was on Phase A roadmap

### Real student testing
The hardest-to-predict UX issues only show up with an actual K-2 child.
Watch one kid through 3 sessions and you'll learn 10 things you can't
see from the code.

### Orchestration layer integration
When the orchestration layer comes online, this app becomes a thin
consumer of identity + mastery state. The existing `reading_mastery`
schema is already aligned with what the orchestrator would expect, so
integration should be a small swap (replace `loadMastery` and
`recordAttempt` with calls to the orchestrator's API), not a rewrite.

### Dashboard for teachers/parents
The orchestration layer probably owns this, but worth noting: a "view
my student's reading progress" dashboard with per-strand mastery
breakdown, time-on-task, and atoms-needing-work is the natural next
parent-facing surface.

---

*Updated: 2026-05-03 — created during the Phase A pedagogy work*
