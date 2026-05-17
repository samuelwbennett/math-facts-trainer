-- ============================================================
-- 004_redemption_fulfillment.sql
--
-- Adds an admin fulfillment workflow on top of incentive_redemptions:
--   - status  ∈ {pending, fulfilled, cancelled}
--   - fulfilled_at  (when the admin marked it paid)
--   - fulfilled_by  (which admin marked it paid)
--
-- Lifecycle:
--   1. Student clicks "Redeem $10" → insert row with status='pending'.
--      Balance immediately drops (totalRedeemed counts pending).
--   2. Admin sees row in their "Pending redemptions" panel.
--   3. Admin distributes cash + clicks "Mark as paid" →
--      status='fulfilled', fulfilled_at=now(), fulfilled_by=<admin uid>.
--   4. (Optional) Admin can mark a pending redemption 'cancelled'
--      if the student backs out; that refunds the balance because
--      our totalRedeemed sum excludes cancelled rows.
--
-- Idempotent — safe to re-run.
-- ============================================================

alter table public.incentive_redemptions
  add column if not exists status        text        default 'pending' not null,
  add column if not exists fulfilled_at  timestamptz,
  add column if not exists fulfilled_by  uuid        references auth.users(id) on delete set null;

-- Status check constraint (drop-and-recreate so re-runs are safe).
alter table public.incentive_redemptions
  drop constraint if exists incentive_redemptions_status_check;
alter table public.incentive_redemptions
  add constraint incentive_redemptions_status_check
    check (status in ('pending', 'fulfilled', 'cancelled'));

-- Useful for the admin's pending queue — index hot path.
create index if not exists incentive_redemptions_pending_idx
  on public.incentive_redemptions (status, redeemed_at desc)
  where status = 'pending';

-- Allow admins to read + update redemption rows in their org. The
-- existing student-scoped policies stay; this is an additive admin
-- escalation that mirrors 0009_admin_org_visibility.sql in the
-- orchestration layer (which gates admin reads on is_admin() +
-- current_org_id()). Math-facts-trainer doesn't have those helpers
-- yet, so we use an inline check against user_profiles.
--
-- Read policy: admins see every redemption for students in their org.
drop policy if exists incentive_redemptions_admin_select
  on public.incentive_redemptions;
create policy incentive_redemptions_admin_select
  on public.incentive_redemptions
  for select
  using (
    exists (
      select 1
        from public.user_profiles up
       where up.auth_user_id = auth.uid()
         and up.role = 'admin'
    )
  );

-- Update policy: admins can change status/fulfilled_* on any row.
drop policy if exists incentive_redemptions_admin_update
  on public.incentive_redemptions;
create policy incentive_redemptions_admin_update
  on public.incentive_redemptions
  for update
  using (
    exists (
      select 1
        from public.user_profiles up
       where up.auth_user_id = auth.uid()
         and up.role = 'admin'
    )
  )
  with check (
    exists (
      select 1
        from public.user_profiles up
       where up.auth_user_id = auth.uid()
         and up.role = 'admin'
    )
  );

-- Sanity check.
select column_name, data_type, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'incentive_redemptions'
   and column_name in ('status', 'fulfilled_at', 'fulfilled_by')
 order by column_name;
