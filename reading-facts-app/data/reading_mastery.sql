-- ============================================================
-- READING MASTERY — per-student, per-atom mastery state
--
-- Run this ONCE in your Supabase SQL editor:
--   https://supabase.com/dashboard/project/dtkrnyberbpfdmikpdnw/sql
--
-- After creating, the reading-facts app will read/write rows here
-- to persist mastery across sessions. Each row tracks one student's
-- progress on one atom (e.g. "gpc.cons.m" = the letter m sound).
--
-- The mastery_score is a 0..1 exponential moving average updated by
-- the app after every attempt:
--   mastered → score moves toward 1   (large bump, factor 0.4)
--   accurate → score moves toward 1   (small bump, factor 0.15)
--   wrong    → score halves
--
-- IMPORTANT: this schema uses permissive RLS for development. Before
-- production, tighten so a guardian can only read/write rows for
-- THEIR students. Easiest path is to add a policy that joins to your
-- existing students table:
--   USING (student_id IN (SELECT id FROM students WHERE guardian_user_id = auth.uid()))
-- ============================================================

create table if not exists public.reading_mastery (
  id              uuid         primary key default gen_random_uuid(),
  student_id      uuid         not null,
  atom_id         text         not null,
  attempts        int          not null default 0,
  correct         int          not null default 0,
  mastered        int          not null default 0,
  last_latency_ms int          not null default 0,
  avg_latency_ms  int          not null default 0,
  mastery_score   real         not null default 0,
  last_attempt_at timestamptz,
  created_at      timestamptz  not null default now(),
  updated_at      timestamptz  not null default now(),
  unique (student_id, atom_id)
);

-- Lookups by student are the hot path (load all of one student's atoms).
create index if not exists reading_mastery_student_idx
  on public.reading_mastery (student_id);

-- Auto-update updated_at on every row change.
create or replace function public.touch_reading_mastery_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_reading_mastery_updated_at on public.reading_mastery;
create trigger trg_reading_mastery_updated_at
  before update on public.reading_mastery
  for each row execute function public.touch_reading_mastery_updated_at();

-- Row-level security: enabled, but currently permissive (any
-- authenticated user can do anything). Replace these policies before
-- you have real users.
alter table public.reading_mastery enable row level security;

drop policy if exists "reading_mastery_dev_all" on public.reading_mastery;
create policy "reading_mastery_dev_all" on public.reading_mastery
  for all
  to authenticated
  using (true)
  with check (true);
