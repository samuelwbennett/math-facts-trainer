-- ============================================================
-- Migration 002 — student-direct auth + incentive ledger
--
-- Two related additions:
--
-- 1. students.auth_user_id — lets a student own a Supabase auth
--    account directly. The orchestration dashboard reads
--    `auth.uid()` and looks up the student row by this column,
--    so K-5 students can log in to their own dashboard without
--    going through a guardian.
--
-- 2. incentive_redemptions — records when a student "cashes out"
--    accumulated dollars. The current available balance is
--    computed on the fly as
--       sum(daily $ earned, capped per day) − sum(redemptions).
--    No second copy of the daily ledger is needed; daily_progress
--    already holds total_xp per student per day.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Direct student auth
-- ------------------------------------------------------------

alter table public.students
  add column if not exists auth_user_id uuid
  references auth.users(id) on delete set null;

-- One auth user can be at most one student. The partial index lets
-- existing students stay null without violating uniqueness.
create unique index if not exists students_auth_user_id_uidx
  on public.students (auth_user_id)
  where auth_user_id is not null;

-- A student can read/update their own row when signed in.
create policy if not exists "students_select_self"
  on public.students for select
  to authenticated using (auth_user_id = auth.uid());

create policy if not exists "students_update_self"
  on public.students for update
  to authenticated using (auth_user_id = auth.uid());

-- A student can read their own app accounts, sessions, daily progress.
-- (We keep the existing guardian-of-student policies in place; these
-- add a self-access path for student-owned auth.)
create policy if not exists "student_app_accounts_self"
  on public.student_app_accounts for select
  to authenticated using (
    student_id in (
      select id from public.students where auth_user_id = auth.uid()
    )
  );

create policy if not exists "practice_sessions_self"
  on public.practice_sessions for select
  to authenticated using (
    student_id in (
      select id from public.students where auth_user_id = auth.uid()
    )
  );

create policy if not exists "daily_progress_self"
  on public.daily_progress for select
  to authenticated using (
    student_id in (
      select id from public.students where auth_user_id = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- 2. Incentive redemption ledger
-- ------------------------------------------------------------

create table if not exists public.incentive_redemptions (
  id                   uuid          primary key default gen_random_uuid(),
  student_id           uuid          not null references public.students(id) on delete cascade,
  total_dollars        numeric(8,2)  not null check (total_dollars > 0),
  store_amount         numeric(8,2)  not null default 0 check (store_amount >= 0),
  scholarship_amount   numeric(8,2)  not null default 0 check (scholarship_amount >= 0),
  note                 text,
  redeemed_at          timestamptz   not null default now(),
  -- Sanity: store + scholarship must equal total within a cent.
  constraint redemption_split_balanced
    check (abs(store_amount + scholarship_amount - total_dollars) < 0.01)
);

create index if not exists incentive_redemptions_student_idx
  on public.incentive_redemptions (student_id, redeemed_at desc);

alter table public.incentive_redemptions enable row level security;

-- Students can read their own redemption history.
create policy if not exists "incentive_redemptions_self_read"
  on public.incentive_redemptions for select
  to authenticated using (
    student_id in (
      select id from public.students where auth_user_id = auth.uid()
    )
  );

-- Inserts and updates flow through the service-role proxy in v1, not
-- direct from the browser, so no insert/update policy for now. Add
-- one if/when redemption shifts to client-side writes.

-- ------------------------------------------------------------
-- HELPER: link a test student to a Supabase auth user.
--
-- Usage from the SQL editor:
--   1. Create the auth user via Supabase Auth UI (or
--      auth.admin.create_user) with whatever email/password you want.
--   2. Run:
--        select public.link_student_auth(
--          '<student-uuid>'::uuid,
--          '<student-email-or-username>'
--        );
--      The helper resolves the auth user by email and writes the
--      auth_user_id back to the students row.
-- ------------------------------------------------------------
create or replace function public.link_student_auth(
  p_student_id  uuid,
  p_email       text
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_auth_uid uuid;
begin
  select id into v_auth_uid from auth.users where email = p_email limit 1;
  if v_auth_uid is null then
    raise exception 'no auth.users row found with email=%', p_email;
  end if;

  update public.students
     set auth_user_id = v_auth_uid
   where id = p_student_id;

  if not found then
    raise exception 'no students row found with id=%', p_student_id;
  end if;
end;
$$;
