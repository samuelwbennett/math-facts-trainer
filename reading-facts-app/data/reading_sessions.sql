-- ============================================================
-- READING SESSIONS — per-quiz log (one row per completed quiz)
--
-- Run this ONCE in your Supabase SQL editor:
--   https://supabase.com/dashboard/project/dtkrnyberbpfdmikpdnw/sql
--
-- Used to fill in the "today's plan" rings on the home screen and to
-- power streak/history features later. Each row = one completed quiz.
--
-- Same dev-mode RLS caveat as reading_mastery: tighten before prod.
-- ============================================================

create table if not exists public.reading_sessions (
  id              uuid         primary key default gen_random_uuid(),
  student_id      uuid         not null,
  duration_sec    int          not null default 0,
  total_attempts  int          not null default 0,
  correct_count   int          not null default 0,
  mastered_count  int          not null default 0,
  avg_latency_ms  int          not null default 0,
  was_diagnostic  boolean      not null default false,
  strand          text,        -- the strand filter ("phonics", etc.) or null for mixed
  completed_at    timestamptz  not null default now(),
  created_at      timestamptz  not null default now()
);

-- Hot path: "give me this student's sessions today".
create index if not exists reading_sessions_student_completed_idx
  on public.reading_sessions (student_id, completed_at desc);

alter table public.reading_sessions enable row level security;

drop policy if exists "reading_sessions_dev_all" on public.reading_sessions;
create policy "reading_sessions_dev_all" on public.reading_sessions
  for all
  to authenticated
  using (true)
  with check (true);
