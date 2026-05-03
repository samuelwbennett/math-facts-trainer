-- ============================================================
-- VPA Learning OS — initial schema
-- Multi-app foundation for student orchestration
--
-- Math Facts is the first tenant. Math Academy, Reading, etc.
-- plug in by inserting a row into learning_apps and storing
-- their state in student_app_accounts.state (JSONB).
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- HELPERS
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- LEARNING APPS REGISTRY
-- A row per learning module that plugs into the system.
-- ------------------------------------------------------------
create table public.learning_apps (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  description text,
  enabled     boolean not null default true,
  icon        text,
  color       text,
  config      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

insert into public.learning_apps (slug, name, description, icon, color) values
  ('math_facts',   'Math Facts',   'Automaticity training for arithmetic facts', '×', '#1d1d1f'),
  ('math_academy', 'Math Academy', 'Adaptive curriculum from Math Academy',      '∑', '#3bc1f3'),
  ('reading',      'Reading',      'Reading fluency and comprehension',          '✦', '#9aff00');

-- ------------------------------------------------------------
-- IDENTITIES
-- guardian = auth principal (Supabase auth user)
-- student  = the actual learner; many-to-many with guardians
-- ------------------------------------------------------------
create table public.guardians (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  display_name  text,
  created_at    timestamptz not null default now()
);

create table public.students (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null,
  date_of_birth date,
  grade_level   int,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz
);
create trigger students_set_updated_at
  before update on public.students
  for each row execute function public.set_updated_at();

create table public.guardian_students (
  guardian_id      uuid not null references public.guardians(id) on delete cascade,
  student_id       uuid not null references public.students(id)  on delete cascade,
  relationship     text,                          -- 'parent' | 'teacher' | 'tutor'
  primary_guardian boolean not null default false,
  created_at       timestamptz not null default now(),
  primary key (guardian_id, student_id)
);
create index guardian_students_student_idx on public.guardian_students (student_id);

-- ------------------------------------------------------------
-- STUDENT APP ACCOUNTS
-- One row per (student, app). Holds app-specific persistent state.
-- For Math Facts: state = { multiplication: {...}, addition: {...}, ... }
-- For Math Academy: external_id = MA student ID; state = cached mastery snapshot
-- ------------------------------------------------------------
create table public.student_app_accounts (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.students(id)     on delete cascade,
  app_id      uuid not null references public.learning_apps(id),
  external_id text,
  state       jsonb not null default '{}'::jsonb,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (student_id, app_id)
);
create trigger student_app_accounts_set_updated_at
  before update on public.student_app_accounts
  for each row execute function public.set_updated_at();
create index student_app_accounts_student_idx on public.student_app_accounts (student_id);

-- ------------------------------------------------------------
-- PRACTICE SESSIONS — universal across apps
-- One row per session, regardless of which app produced it.
-- ------------------------------------------------------------
create table public.practice_sessions (
  id               uuid primary key default gen_random_uuid(),
  student_id       uuid not null references public.students(id)     on delete cascade,
  app_id           uuid not null references public.learning_apps(id),
  context          text,                                   -- 'multiplication', topic id, etc.
  started_at       timestamptz not null,
  ended_at         timestamptz,
  active_seconds   int not null default 0,                 -- focused time on task
  duration_seconds int not null default 0,                 -- wall clock
  attempts         int not null default 0,
  correct          int not null default 0,
  xp_earned        numeric(8,2) not null default 0,        -- 1 XP = 1 minute focused (universal)
  metrics          jsonb not null default '{}'::jsonb,     -- app-specific summary
  created_at       timestamptz not null default now()
);
create index practice_sessions_student_started_idx
  on public.practice_sessions (student_id, started_at desc);
create index practice_sessions_student_app_started_idx
  on public.practice_sessions (student_id, app_id, started_at desc);

-- ------------------------------------------------------------
-- SKILL ATTEMPTS — granular per-problem data
-- Optional to populate; great for analytics and adaptive engines.
-- ------------------------------------------------------------
create table public.skill_attempts (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.practice_sessions(id) on delete cascade,
  student_id   uuid not null references public.students(id)          on delete cascade,
  app_id       uuid not null references public.learning_apps(id),
  skill_id     text not null,                                        -- 'mul-7x8', topic id, etc.
  skill_meta   jsonb,                                                -- { a:7, b:8, op:'multiplication' }
  result       text not null,                                        -- 'fast'|'slow'|'tooSlow'|'wrong'|...
  latency_ms   int,
  attempted_at timestamptz not null default now()
);
create index skill_attempts_student_skill_idx on public.skill_attempts (student_id, skill_id);
create index skill_attempts_session_idx       on public.skill_attempts (session_id);

-- ------------------------------------------------------------
-- DAILY PROGRESS — denormalized rollup for fast dashboard reads
-- Written on each session-complete; can be regenerated from sessions.
-- ------------------------------------------------------------
create table public.daily_progress (
  id                   uuid primary key default gen_random_uuid(),
  student_id           uuid not null references public.students(id) on delete cascade,
  day                  date not null,
  total_xp             numeric(8,2) not null default 0,
  total_active_seconds int not null default 0,
  total_attempts       int not null default 0,
  total_correct        int not null default 0,
  per_app              jsonb not null default '{}'::jsonb,           -- { math_facts: {xp, active_seconds, ...}, ... }
  updated_at           timestamptz not null default now(),
  unique (student_id, day)
);
create trigger daily_progress_set_updated_at
  before update on public.daily_progress
  for each row execute function public.set_updated_at();
create index daily_progress_student_day_idx on public.daily_progress (student_id, day desc);

-- ------------------------------------------------------------
-- GOALS — daily XP, streaks, mastery targets, weekly sessions, etc.
-- app_id nullable so goals can be cross-app.
-- ------------------------------------------------------------
create table public.goals (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.students(id) on delete cascade,
  app_id       uuid references public.learning_apps(id),
  goal_type    text not null,                                -- 'daily_xp'|'streak'|'mastery'|'sessions_per_week'
  target       jsonb not null,                               -- { xp: 5 } | { days: 7 } | { skill_ids: [...], state: 'automatic' }
  starts_on    date not null default current_date,
  ends_on      date,
  achieved_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index goals_student_idx on public.goals (student_id);

-- ------------------------------------------------------------
-- REWARDS — badges, unlocks, point redemptions
-- ------------------------------------------------------------
create table public.rewards (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.students(id) on delete cascade,
  reward_type text not null,                                 -- 'badge'|'unlock'|'points_redemption'
  source      text,                                          -- 'goal_completion'|'streak'|'manual'
  source_ref  uuid,                                          -- ref to goal_id or session_id
  metadata    jsonb not null default '{}'::jsonb,
  awarded_at  timestamptz not null default now()
);
create index rewards_student_awarded_idx on public.rewards (student_id, awarded_at desc);

-- ============================================================
-- ROW-LEVEL SECURITY
-- Default deny. Guardians can read/write only their wards' data.
-- The service role key bypasses RLS for admin/sync work.
-- ============================================================

alter table public.learning_apps        enable row level security;
alter table public.guardians            enable row level security;
alter table public.students             enable row level security;
alter table public.guardian_students    enable row level security;
alter table public.student_app_accounts enable row level security;
alter table public.practice_sessions    enable row level security;
alter table public.skill_attempts       enable row level security;
alter table public.daily_progress       enable row level security;
alter table public.goals                enable row level security;
alter table public.rewards              enable row level security;

-- learning_apps: any signed-in user can read the registry
create policy "learning_apps_read_authenticated"
  on public.learning_apps for select
  to authenticated using (true);

-- guardians: read/update own row only
create policy "guardians_read_own"
  on public.guardians for select
  to authenticated using (id = auth.uid());
create policy "guardians_update_own"
  on public.guardians for update
  to authenticated using (id = auth.uid());

-- Helper used in policies. SECURITY DEFINER so it can read
-- guardian_students without recursing into RLS.
create or replace function public.is_guardian_of(target_student uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.guardian_students
    where guardian_id = auth.uid()
      and student_id  = target_student
  );
$$;

-- students: visible/editable by their guardians
create policy "students_select_via_guardian"
  on public.students for select
  to authenticated using (public.is_guardian_of(id));
create policy "students_insert_by_guardian"
  on public.students for insert
  to authenticated with check (true);  -- creator must immediately link via guardian_students
create policy "students_update_via_guardian"
  on public.students for update
  to authenticated using (public.is_guardian_of(id));

-- guardian_students: a guardian sees and manages their own links
create policy "guardian_students_select_own"
  on public.guardian_students for select
  to authenticated using (guardian_id = auth.uid());
create policy "guardian_students_insert_own"
  on public.guardian_students for insert
  to authenticated with check (guardian_id = auth.uid());
create policy "guardian_students_delete_own"
  on public.guardian_students for delete
  to authenticated using (guardian_id = auth.uid());

-- Generic guardian-of-student access for all student-owned tables
create policy "student_app_accounts_all" on public.student_app_accounts
  for all to authenticated
  using (public.is_guardian_of(student_id))
  with check (public.is_guardian_of(student_id));

create policy "practice_sessions_all" on public.practice_sessions
  for all to authenticated
  using (public.is_guardian_of(student_id))
  with check (public.is_guardian_of(student_id));

create policy "skill_attempts_all" on public.skill_attempts
  for all to authenticated
  using (public.is_guardian_of(student_id))
  with check (public.is_guardian_of(student_id));

create policy "daily_progress_all" on public.daily_progress
  for all to authenticated
  using (public.is_guardian_of(student_id))
  with check (public.is_guardian_of(student_id));

create policy "goals_all" on public.goals
  for all to authenticated
  using (public.is_guardian_of(student_id))
  with check (public.is_guardian_of(student_id));

create policy "rewards_all" on public.rewards
  for all to authenticated
  using (public.is_guardian_of(student_id))
  with check (public.is_guardian_of(student_id));

-- ============================================================
-- AUTO-PROVISION GUARDIAN ON SIGN-UP
-- Whenever Supabase Auth creates a user (e.g. magic-link sign-in
-- for a new email), insert a matching row in guardians.
-- ============================================================
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.guardians (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
