-- ============================================================
-- Migration 003 — register Reading Academy in learning_apps
--
-- Background: migration 001 seeded a generic 'reading' row in
-- learning_apps for "Reading fluency and comprehension". Now that
-- we have two distinct reading apps:
--   - reading-facts-app   (atom-level phonics drills)
--   - reading-academy     (Math-Academy-style adaptive curriculum)
-- they should be separate rows so per-app analytics don't blur.
--
-- Plan:
--   1. Add a `reading_academy` row.
--   2. Rename the existing `reading` slug → `reading_facts` so it
--      lines up with the orchestration adapter's id (`reading-facts`).
--   3. Idempotent: re-running the migration is a no-op.
-- ============================================================

-- 1. Reading Academy.
insert into public.learning_apps (slug, name, description, icon, color)
values (
  'reading_academy',
  'Reading Academy',
  'Adaptive reading curriculum — phoneme awareness through fluency',
  '✦',
  '#bf5af2'
)
on conflict (slug) do nothing;

-- 2. Rename the legacy 'reading' slug to 'reading_facts' so the
--    orchestration adapter (and any other consumer) finds a slug
--    that matches its expectations. If the rename has already
--    happened, the second update is a no-op.
update public.learning_apps
   set slug = 'reading_facts',
       name = 'Reading Facts',
       description = 'Atom-level phonics, sight-word, and blending drills'
 where slug = 'reading';
