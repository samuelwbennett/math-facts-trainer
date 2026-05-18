-- ============================================================
-- 005_student_self_write.sql
--
-- The original RLS policies on student-owned tables (daily_progress,
-- student_app_accounts, practice_sessions, etc.) only allow
-- GUARDIANS to read/write. That assumes every student has a
-- guardian acting on their behalf.
--
-- The orchestration layer now supports direct student sign-in
-- (a student's `auth_user_id` is set on their `students` row, and
-- they sign in to the orchestration layer / Math Facts / Reading
-- Facts / Reading Academy with their own credentials).
--
-- Without these complementary policies, a self-signed-in student
-- gets blocked from writing their own activity — exactly what
-- happened to the +student.test account: it could read fine via
-- `students_select_self` (added implicitly when auth_user_id was
-- set), but its dailyProgress upsert failed with
--   "new row violates row-level security policy for table
--    daily_progress".
--
-- This migration adds policies that say: "you can also read/write
-- if the student row's auth_user_id matches auth.uid()."
--
-- Idempotent — safe to re-run.
-- ============================================================

-- Helper: is the calling auth user the student themselves?
create or replace function public.is_self_student(target_student uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.students
    where id = target_student
      and auth_user_id = auth.uid()
  );
$$;

-- daily_progress
drop policy if exists "daily_progress_self_student" on public.daily_progress;
create policy "daily_progress_self_student"
  on public.daily_progress
  for all
  to authenticated
  using (public.is_self_student(student_id))
  with check (public.is_self_student(student_id));

-- student_app_accounts (Reading Academy writes state here)
drop policy if exists "student_app_accounts_self_student" on public.student_app_accounts;
create policy "student_app_accounts_self_student"
  on public.student_app_accounts
  for all
  to authenticated
  using (public.is_self_student(student_id))
  with check (public.is_self_student(student_id));

-- practice_sessions (Math Facts writes per-session here)
drop policy if exists "practice_sessions_self_student" on public.practice_sessions;
create policy "practice_sessions_self_student"
  on public.practice_sessions
  for all
  to authenticated
  using (public.is_self_student(student_id))
  with check (public.is_self_student(student_id));

-- reading_sessions (Reading Facts writes per-quiz here). This table
-- was added by the reading-facts-app migration outside the math-facts
-- migrations tree; the policy here is harmless if the table doesn't
-- exist (the DO block catches the missing-relation error).
do $$
begin
  perform 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'reading_sessions';
  if found then
    execute 'drop policy if exists "reading_sessions_self_student" on public.reading_sessions';
    execute $POL$
      create policy "reading_sessions_self_student"
        on public.reading_sessions
        for all
        to authenticated
        using (public.is_self_student(student_id))
        with check (public.is_self_student(student_id))
    $POL$;
  end if;
end $$;

-- students: a student should be able to read their own row.
-- (Many client code paths look up the student by auth_user_id.)
drop policy if exists "students_select_self" on public.students;
create policy "students_select_self"
  on public.students
  for select
  to authenticated
  using (auth_user_id = auth.uid());

-- Sanity check.
select
  policyname,
  cmd,
  qual
from pg_policies
where schemaname = 'public'
  and policyname like '%self_student%'
order by tablename, policyname;
