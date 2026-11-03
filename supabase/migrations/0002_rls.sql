-- 0002_rls.sql — Row Level Security. Every SPEC access rule lives here,
-- in the database, not only in the UI (SPEC: server-side enforcement mandatory).

-- ---------------------------------------------------------------------------
-- Helpers: the single source every policy uses.
-- ---------------------------------------------------------------------------
create or replace function app_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

create or replace function app_agent_id() returns uuid
language sql stable security definer set search_path = public as $$
  select agent_id from profiles where id = auth.uid()
$$;

create or replace function is_owner_manager() returns boolean
language sql stable as $$
  select coalesce(app_role() in ('owner', 'manager'), false)
$$;

create or replace function is_staff_plus() returns boolean
language sql stable as $$
  select coalesce(app_role() in ('owner', 'manager', 'staff'), false)
$$;

-- ---------------------------------------------------------------------------
-- profiles: owner manages accounts; everyone sees their own row;
-- owner/manager see all rows (names + roles, no secrets stored here).
-- ---------------------------------------------------------------------------
alter table profiles enable row level security;

create policy profiles_select on profiles for select to authenticated
  using (is_owner_manager() or id = auth.uid());
create policy profiles_insert on profiles for insert to authenticated
  with check (app_role() = 'owner');
create policy profiles_update on profiles for update to authenticated
  using (app_role() = 'owner') with check (app_role() = 'owner');
-- No delete policy: accounts are deactivated (active=false), never deleted.

-- ---------------------------------------------------------------------------
-- agents: readable by staff+ (no phone data in this table, so this is safe)
-- and by an agent for their own row only. Writes: owner/manager.
-- ---------------------------------------------------------------------------
alter table agents enable row level security;

create policy agents_select on agents for select to authenticated
  using (is_staff_plus() or id = app_agent_id());
create policy agents_insert on agents for insert to authenticated
  with check (is_owner_manager());
create policy agents_update on agents for update to authenticated
  using (is_owner_manager()) with check (is_owner_manager());
-- No delete policy: agents are deactivated, never deleted (business history).

-- ---------------------------------------------------------------------------
-- agent_contacts: THE phone-number fix (SPEC rule 2).
-- owner/manager: all rows. agent: own row only. staff: NO policy = no access.
-- ---------------------------------------------------------------------------
alter table agent_contacts enable row level security;

create policy contacts_select on agent_contacts for select to authenticated
  using (is_owner_manager() or agent_id = app_agent_id());
create policy contacts_insert on agent_contacts for insert to authenticated
  with check (is_owner_manager());
create policy contacts_update on agent_contacts for update to authenticated
  using (is_owner_manager() or agent_id = app_agent_id())
  with check (is_owner_manager() or agent_id = app_agent_id());
-- No delete policy.

-- ---------------------------------------------------------------------------
-- daily_entries: staff+ read all; agent reads own. Writes staff+ only
-- (delivery entry is done by staff — SPEC rule 3). Same-day + month-lock
-- are enforced by triggers in 0003 for ALL roles.
-- ---------------------------------------------------------------------------
alter table daily_entries enable row level security;

create policy entries_select on daily_entries for select to authenticated
  using (is_staff_plus() or agent_id = app_agent_id());
create policy entries_insert on daily_entries for insert to authenticated
  with check (is_staff_plus());
create policy entries_update on daily_entries for update to authenticated
  using (is_staff_plus()) with check (is_staff_plus());
create policy entries_delete on daily_entries for delete to authenticated
  using (is_staff_plus());

-- ---------------------------------------------------------------------------
-- agent_payments (collections): same shape as daily_entries.
-- ---------------------------------------------------------------------------
alter table agent_payments enable row level security;

create policy payments_select on agent_payments for select to authenticated
  using (is_staff_plus() or agent_id = app_agent_id());
create policy payments_insert on agent_payments for insert to authenticated
  with check (is_staff_plus());
create policy payments_update on agent_payments for update to authenticated
  using (is_staff_plus()) with check (is_staff_plus());
create policy payments_delete on agent_payments for delete to authenticated
  using (is_staff_plus());

-- ---------------------------------------------------------------------------
-- expenses: owner/manager only (management data). Categories readable by
-- staff+ so entry forms can list them; managed by owner/manager.
-- ---------------------------------------------------------------------------
alter table expenses enable row level security;

create policy expenses_select on expenses for select to authenticated
  using (is_owner_manager());
create policy expenses_insert on expenses for insert to authenticated
  with check (is_owner_manager());
create policy expenses_update on expenses for update to authenticated
  using (is_owner_manager()) with check (is_owner_manager());
create policy expenses_delete on expenses for delete to authenticated
  using (is_owner_manager());

alter table expense_categories enable row level security;

create policy categories_select on expense_categories for select to authenticated
  using (is_staff_plus());
create policy categories_insert on expense_categories for insert to authenticated
  with check (is_owner_manager());
create policy categories_update on expense_categories for update to authenticated
  using (is_owner_manager()) with check (is_owner_manager());

-- ---------------------------------------------------------------------------
-- inventory_movements: staff+ read all; agent reads rows tied to them.
-- Writes staff+ (triggers enforce same-day + month lock).
-- ---------------------------------------------------------------------------
alter table inventory_movements enable row level security;

create policy inventory_select on inventory_movements for select to authenticated
  using (is_staff_plus() or agent_id = app_agent_id());
create policy inventory_insert on inventory_movements for insert to authenticated
  with check (is_staff_plus());
create policy inventory_update on inventory_movements for update to authenticated
  using (is_staff_plus()) with check (is_staff_plus());
create policy inventory_delete on inventory_movements for delete to authenticated
  using (is_staff_plus());

-- ---------------------------------------------------------------------------
-- disputes: agent raises and reads own; owner/manager read/reply to all.
-- staff have no access.
-- ---------------------------------------------------------------------------
alter table disputes enable row level security;

create policy disputes_select on disputes for select to authenticated
  using (is_owner_manager() or agent_id = app_agent_id());
create policy disputes_insert on disputes for insert to authenticated
  with check (is_owner_manager() or agent_id = app_agent_id());
create policy disputes_update on disputes for update to authenticated
  using (is_owner_manager() or agent_id = app_agent_id())
  with check (is_owner_manager() or agent_id = app_agent_id());

-- ---------------------------------------------------------------------------
-- month_locks: readable by all authenticated users (the app shows lock state).
-- Interim default (SPEC TBD): owner+manager may lock; only owner may unlock
-- (delete the row). Both actions are audited by trigger.
-- ---------------------------------------------------------------------------
alter table month_locks enable row level security;

create policy locks_select on month_locks for select to authenticated using (true);
create policy locks_insert on month_locks for insert to authenticated
  with check (is_owner_manager());
create policy locks_delete on month_locks for delete to authenticated
  using (app_role() = 'owner');

-- ---------------------------------------------------------------------------
-- audit_log: SELECT owner/manager only. NO insert/update/delete policies for
-- any client role — rows are written by the security-definer trigger only,
-- and can never be edited or deleted through the API (SPEC rule 5).
-- ---------------------------------------------------------------------------
alter table audit_log enable row level security;

create policy audit_select on audit_log for select to authenticated
  using (is_owner_manager());

-- ---------------------------------------------------------------------------
-- login_logs: anyone may append an attempt (login happens pre-auth);
-- only the owner may read the history.
-- ---------------------------------------------------------------------------
alter table login_logs enable row level security;

create policy login_logs_insert on login_logs for insert to anon, authenticated
  with check (true);
create policy login_logs_select on login_logs for select to authenticated
  using (app_role() = 'owner');

-- ---------------------------------------------------------------------------
-- app_settings: readable by all authenticated users (factory name, backup
-- state); writable by the owner only.
-- ---------------------------------------------------------------------------
alter table app_settings enable row level security;

create policy settings_select on app_settings for select to authenticated using (true);
create policy settings_update on app_settings for update to authenticated
  using (app_role() = 'owner') with check (app_role() = 'owner');
create policy settings_insert on app_settings for insert to authenticated
  with check (app_role() = 'owner');

-- ---------------------------------------------------------------------------
-- push_tokens (Phase 2): a user manages their own device tokens;
-- owner/manager may read all (needed to send notifications).
-- ---------------------------------------------------------------------------
alter table push_tokens enable row level security;

create policy tokens_select on push_tokens for select to authenticated
  using (is_owner_manager() or profile_id = auth.uid());
create policy tokens_insert on push_tokens for insert to authenticated
  with check (profile_id = auth.uid());
create policy tokens_update on push_tokens for update to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
create policy tokens_delete on push_tokens for delete to authenticated
  using (profile_id = auth.uid());
