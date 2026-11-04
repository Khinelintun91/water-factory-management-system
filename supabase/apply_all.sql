-- ============================================================
-- apply_all.sql — GENERATED convenience file: 0001 + 0002 + 0003
-- Paste this whole file ONCE into the Supabase SQL Editor and Run.
-- (The individual files in migrations/ remain the source of truth.)
-- ============================================================

-- 0001_schema.sql — Water Factory Management System, Phase 1 schema
-- Apply in filename order in the Supabase SQL Editor (owner's own project).
-- Business timezone for all day logic: Asia/Yangon.

create extension if not exists pgcrypto;

create type user_role as enum ('owner', 'manager', 'staff', 'agent');

-- ---------------------------------------------------------------------------
-- Identity: one row per login, linked to Supabase Auth.
-- Login is username + PIN; the client maps username -> <username>@waterfactory.local
-- ---------------------------------------------------------------------------
create table profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null unique,
  role       user_role not null,
  agent_id   uuid,                       -- set only when role = 'agent'
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Agents (delivery agents). NOTE: no phone column here on purpose (SPEC rule 2).
-- ---------------------------------------------------------------------------
create table agents (
  id                  uuid primary key default gen_random_uuid(),
  code                text unique,
  name                text not null,
  address             text,
  deposit_per_bottle  integer not null default 0,   -- MMK per bottle, per-agent setting (SPEC rule 7)
  default_unit_price  integer not null default 0,   -- MMK, optional default delivery price
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table profiles
  add constraint profiles_agent_fk foreign key (agent_id) references agents (id);

-- Phone numbers live here, under strict RLS (SPEC rule 2 fix).
create table agent_contacts (
  agent_id   uuid primary key references agents (id) on delete cascade,
  phone      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Business records. created_at drives the same-day rule, so it is never
-- client-settable in practice (default now(), and the guard uses it as-is).
-- ---------------------------------------------------------------------------
create table daily_entries (              -- staff delivery entries
  id           uuid primary key default gen_random_uuid(),
  entry_date   date not null default (now() at time zone 'Asia/Yangon')::date,
  agent_id     uuid not null references agents (id),
  delivered_qty integer not null default 0 check (delivered_qty >= 0),
  returned_qty  integer not null default 0 check (returned_qty >= 0),
  unit_price   integer not null default 0 check (unit_price >= 0),   -- MMK
  amount       bigint  not null default 0 check (amount >= 0),       -- MMK
  notes        text,
  created_by   uuid references profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table agent_payments (             -- collections from agents
  id           uuid primary key default gen_random_uuid(),
  payment_date date not null default (now() at time zone 'Asia/Yangon')::date,
  agent_id     uuid not null references agents (id),
  amount       bigint not null check (amount >= 0),                  -- MMK
  method       text not null default 'cash',
  notes        text,
  created_by   uuid references profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table expense_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table expenses (
  id           uuid primary key default gen_random_uuid(),
  expense_date date not null default (now() at time zone 'Asia/Yangon')::date,
  category_id  uuid references expense_categories (id),
  title        text not null,
  amount       bigint not null check (amount >= 0),                  -- MMK
  notes        text,
  created_by   uuid references profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table inventory_movements (        -- bottle stock movements
  id         uuid primary key default gen_random_uuid(),
  move_date  date not null default (now() at time zone 'Asia/Yangon')::date,
  agent_id   uuid references agents (id),          -- null = factory stock
  kind       text not null check (kind in ('in', 'out', 'adjust')),
  bottles    integer not null,
  notes      text,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table disputes (
  id         uuid primary key default gen_random_uuid(),
  agent_id   uuid not null references agents (id),
  message    text not null,
  status     text not null default 'open' check (status in ('open', 'replied', 'closed')),
  reply      text,
  replied_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Month locks: one row per locked month (first day of month, Yangon).
-- ---------------------------------------------------------------------------
create table month_locks (
  month     date primary key,
  locked_by uuid references profiles (id),
  locked_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Audit log: insert-only for everyone (SPEC rule 5). Written by trigger only.
-- row_id is text so non-uuid keys (e.g. month_locks.month) fit too.
-- ---------------------------------------------------------------------------
create table audit_log (
  id         bigint generated always as identity primary key,
  table_name text not null,
  row_id     text not null,
  action     text not null check (action in ('insert', 'update', 'delete')),
  old_data   jsonb,
  new_data   jsonb,
  actor      uuid,
  created_at timestamptz not null default now()
);

create table login_logs (
  id         bigint generated always as identity primary key,
  username   text not null,
  success    boolean not null,
  created_at timestamptz not null default now()
);

-- Key/value settings: factory_name, last_backup_at, ...
create table app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into app_settings (key, value) values
  ('factory_name', '"ရေသန့်စက်ရုံ"'::jsonb),
  ('last_backup_at', 'null'::jsonb)
on conflict (key) do nothing;

-- Push tokens (Phase 2 FCM wiring; table created now so the shape is stable).
create table push_tokens (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  token      text not null unique,
  platform   text,
  updated_at timestamptz not null default now()
);

create index daily_entries_agent_date_idx on daily_entries (agent_id, entry_date desc);
create index agent_payments_agent_date_idx on agent_payments (agent_id, payment_date desc);
create index expenses_date_idx on expenses (expense_date desc);
create index audit_log_table_row_idx on audit_log (table_name, row_id);
create index audit_log_created_idx on audit_log (created_at desc);

-- ===================== 0002_rls.sql =====================

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

-- ===================== 0003_triggers.sql =====================

-- 0003_triggers.sql — Rule triggers: audit, same-day, month lock, updated_at.
-- These fire for EVERY role, Owner included (SPEC rules 4, 5, 6 — the old
-- app's silent Owner exemptions are deliberately NOT reproduced here).

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger agents_updated before update on agents
  for each row execute function set_updated_at();
create trigger contacts_updated before update on agent_contacts
  for each row execute function set_updated_at();
create trigger entries_updated before update on daily_entries
  for each row execute function set_updated_at();
create trigger payments_updated before update on agent_payments
  for each row execute function set_updated_at();
create trigger expenses_updated before update on expenses
  for each row execute function set_updated_at();
create trigger inventory_updated before update on inventory_movements
  for each row execute function set_updated_at();
create trigger disputes_updated before update on disputes
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit: full before/after images, written as definer so the insert succeeds
-- despite audit_log having no client INSERT policy (SPEC rule 5).
-- ---------------------------------------------------------------------------
create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row_id text;
begin
  v_row_id := coalesce((to_jsonb(coalesce(new, old)) ->> 'id'),
                       (to_jsonb(coalesce(new, old)) ->> 'month'),
                       (to_jsonb(coalesce(new, old)) ->> 'agent_id'));
  if tg_op = 'INSERT' then
    insert into audit_log (table_name, row_id, action, old_data, new_data, actor)
    values (tg_table_name, v_row_id, 'insert', null, to_jsonb(new), auth.uid());
    return new;
  elsif tg_op = 'UPDATE' then
    insert into audit_log (table_name, row_id, action, old_data, new_data, actor)
    values (tg_table_name, v_row_id, 'update', to_jsonb(old), to_jsonb(new), auth.uid());
    return new;
  else
    insert into audit_log (table_name, row_id, action, old_data, new_data, actor)
    values (tg_table_name, v_row_id, 'delete', to_jsonb(old), null, auth.uid());
    return old;
  end if;
end $$;

create trigger agents_audit after insert or update or delete on agents
  for each row execute function audit_row_change();
create trigger contacts_audit after insert or update or delete on agent_contacts
  for each row execute function audit_row_change();
create trigger entries_audit after insert or update or delete on daily_entries
  for each row execute function audit_row_change();
create trigger payments_audit after insert or update or delete on agent_payments
  for each row execute function audit_row_change();
create trigger expenses_audit after insert or update or delete on expenses
  for each row execute function audit_row_change();
create trigger categories_audit after insert or update or delete on expense_categories
  for each row execute function audit_row_change();
create trigger inventory_audit after insert or update or delete on inventory_movements
  for each row execute function audit_row_change();
create trigger disputes_audit after insert or update or delete on disputes
  for each row execute function audit_row_change();
create trigger locks_audit after insert or update or delete on month_locks
  for each row execute function audit_row_change();

-- ---------------------------------------------------------------------------
-- Same-day rule (SPEC rule 4): UPDATE/DELETE allowed only when the row was
-- created on the current Asia/Yangon calendar day. Applies to ALL roles.
-- ---------------------------------------------------------------------------
create or replace function guard_same_day_edit() returns trigger
language plpgsql as $$
begin
  if (old.created_at at time zone 'Asia/Yangon')::date
     <> (now() at time zone 'Asia/Yangon')::date then
    raise exception 'same_day_only: records can only be edited or deleted on the day they were created';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create trigger entries_same_day before update or delete on daily_entries
  for each row execute function guard_same_day_edit();
create trigger payments_same_day before update or delete on agent_payments
  for each row execute function guard_same_day_edit();
create trigger expenses_same_day before update or delete on expenses
  for each row execute function guard_same_day_edit();
create trigger inventory_same_day before update or delete on inventory_movements
  for each row execute function guard_same_day_edit();

-- ---------------------------------------------------------------------------
-- Month lock (SPEC rule 6): no INSERT/UPDATE/DELETE into a locked month,
-- for ANY role. The business month comes from the row's business date.
-- ---------------------------------------------------------------------------
create or replace function guard_month_lock() returns trigger
language plpgsql as $$
declare
  v_date_field text := tg_argv[0];
  v_old_month date;
  v_new_month date;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old_month := date_trunc('month', (to_jsonb(old) ->> v_date_field)::date)::date;
    if exists (select 1 from month_locks where month = v_old_month) then
      raise exception 'month_locked: % is locked', v_old_month;
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new_month := date_trunc('month', (to_jsonb(new) ->> v_date_field)::date)::date;
    if exists (select 1 from month_locks where month = v_new_month) then
      raise exception 'month_locked: % is locked', v_new_month;
    end if;
    return new;
  end if;
  return old;
end $$;

create trigger entries_month_lock before insert or update or delete on daily_entries
  for each row execute function guard_month_lock('entry_date');
create trigger payments_month_lock before insert or update or delete on agent_payments
  for each row execute function guard_month_lock('payment_date');
create trigger expenses_month_lock before insert or update or delete on expenses
  for each row execute function guard_month_lock('expense_date');
create trigger inventory_month_lock before insert or update or delete on inventory_movements
  for each row execute function guard_month_lock('move_date');

-- ===================== 0004_insert_date_guard.sql =====================

-- 0004_insert_date_guard.sql — New records must be dated today.
--
-- QA finding 2026-11-03: the same-day guard (0003) covered UPDATE/DELETE
-- only, so a client could INSERT a record backdated to any unlocked past
-- day — silently rewriting history that was never visible on its own day.
-- This guard closes that hole for every role, Owner included: the date
-- column of a newly inserted record must equal the current Asia/Yangon
-- calendar day. (Reversible by dropping these four triggers if the
-- business ever wants next-morning backfill instead.)

create or replace function guard_insert_today() returns trigger
language plpgsql as $$
declare
  v_date date;
begin
  v_date := (to_jsonb(new) ->> tg_argv[0])::date;
  if v_date is distinct from (now() at time zone 'Asia/Yangon')::date then
    raise exception 'same_day_only: % must be today (Asia/Yangon)', tg_argv[0]
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger entries_insert_today before insert on daily_entries
  for each row execute function guard_insert_today('entry_date');
create trigger payments_insert_today before insert on agent_payments
  for each row execute function guard_insert_today('payment_date');
create trigger expenses_insert_today before insert on expenses
  for each row execute function guard_insert_today('expense_date');
create trigger inventory_insert_today before insert on inventory_movements
  for each row execute function guard_insert_today('move_date');

-- ===================== 0005_access_hardening.sql =====================

-- 0005_access_hardening.sql — Fixes from the 2026-11-03 code review.
--
-- C1: deactivated accounts (profiles.active = false) kept full data access
--     because the RLS helpers never looked at `active`. The helpers now
--     return NULL for inactive profiles, so every policy fails closed.
-- H3: created_at / created_by were client-settable on INSERT, which made
--     the same-day rule forgeable. A BEFORE INSERT trigger now forces
--     both columns to server values on the money-bearing tables.
-- M1: agents could UPDATE their own disputes without column limits and
--     forge status/reply/replied_by. Dispute updates are now
--     owner/manager only (agents raise and read; management responds).
-- M3: profiles and app_settings changes were not audited. They now are,
--     and the audit row_id also understands app_settings' `key` column.

-- C1 ---------------------------------------------------------------------
create or replace function app_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
$$;

create or replace function app_agent_id() returns uuid
language sql stable security definer set search_path = public as $$
  select agent_id from profiles where id = auth.uid() and active
$$;

-- H3 ---------------------------------------------------------------------
create or replace function force_insert_attribution() returns trigger
language plpgsql as $$
begin
  new := jsonb_populate_record(new, jsonb_build_object(
    'created_at', now(),
    'created_by', auth.uid()
  ));
  return new;
end $$;

create trigger entries_attribution before insert on daily_entries
  for each row execute function force_insert_attribution();
create trigger payments_attribution before insert on agent_payments
  for each row execute function force_insert_attribution();
create trigger expenses_attribution before insert on expenses
  for each row execute function force_insert_attribution();
create trigger inventory_attribution before insert on inventory_movements
  for each row execute function force_insert_attribution();

-- M1 ---------------------------------------------------------------------
drop policy disputes_update on disputes;
create policy disputes_update on disputes for update to authenticated
  using (is_owner_manager()) with check (is_owner_manager());

-- M3 ---------------------------------------------------------------------
create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row_id text;
begin
  v_row_id := coalesce((to_jsonb(coalesce(new, old)) ->> 'id'),
                       (to_jsonb(coalesce(new, old)) ->> 'month'),
                       (to_jsonb(coalesce(new, old)) ->> 'agent_id'),
                       (to_jsonb(coalesce(new, old)) ->> 'key'));
  if tg_op = 'INSERT' then
    insert into audit_log (table_name, row_id, action, old_data, new_data, actor)
    values (tg_table_name, v_row_id, 'insert', null, to_jsonb(new), auth.uid());
    return new;
  elsif tg_op = 'UPDATE' then
    insert into audit_log (table_name, row_id, action, old_data, new_data, actor)
    values (tg_table_name, v_row_id, 'update', to_jsonb(old), to_jsonb(new), auth.uid());
    return new;
  else
    insert into audit_log (table_name, row_id, action, old_data, new_data, actor)
    values (tg_table_name, v_row_id, 'delete', to_jsonb(old), null, auth.uid());
    return old;
  end if;
end $$;

create trigger profiles_audit after insert or update or delete on profiles
  for each row execute function audit_row_change();
create trigger settings_audit after insert or update or delete on app_settings
  for each row execute function audit_row_change();

-- ===================== 0006_phase_a_parity.sql =====================

-- 0006_phase_a_parity.sql — Phase A: old-app feature parity (data layer).
--
-- Adds: co_owner + multi-role (user_roles), login lockout (pin_attempts +
-- RPCs), agent bottle/credit limits + close-out state, agent_name snapshots,
-- per-entry cash collected + change_reason, deposits ledger (agent_deposits),
-- write-offs, settlements + finalize_closeout / hard_delete_agent RPCs,
-- entry price snapshot + bottle/credit limit guards, dispute record links,
-- fixed expense categories + new settings keys, stock-move kinds.
--
-- Deliberate deviations from the old app (rebuild SPEC safeguards, kept):
-- month lock binds EVERYONE incl. Owner; edit/delete stays same-day for all
-- roles; new entries/payments/expenses must be dated today (0004).

-- ---------------------------------------------------------------------------
-- 1) Roles: co_owner + multi-role assignments
-- ---------------------------------------------------------------------------
alter type user_role add value if not exists 'co_owner';

create table if not exists user_roles (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  role       user_role not null,
  created_at timestamptz not null default now(),
  unique (profile_id, role)
);
alter table user_roles enable row level security;
create policy user_roles_select on user_roles for select to authenticated
  using (profile_id = auth.uid() or is_owner_manager());
create policy user_roles_insert on user_roles for insert to authenticated
  with check (app_role() = 'owner');
create policy user_roles_delete on user_roles for delete to authenticated
  using (app_role() = 'owner');

-- Effective-role check: primary role (profiles.role) OR an extra assigned
-- role; co_owner counts as manager everywhere (old-app rule).
create or replace function has_role(p_role user_role) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.active
      and (p.role = p_role
           or (p_role = 'manager' and p.role = 'co_owner')
           or exists (
             select 1 from user_roles ur
             where ur.profile_id = p.id
               and (ur.role = p_role or (p_role = 'manager' and ur.role = 'co_owner'))
           ))
  );
$$;

-- Rewire the shared helpers onto has_role so co_owner / extra roles apply
-- to every existing policy too.
create or replace function is_owner_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select has_role('owner') or has_role('manager');
$$;
create or replace function is_staff_plus() returns boolean
language sql stable security definer set search_path = public as $$
  select has_role('owner') or has_role('manager') or has_role('staff');
$$;

-- ---------------------------------------------------------------------------
-- 2) Login lockout: 5 consecutive failures -> 15-minute lock (old-app rule)
-- ---------------------------------------------------------------------------
create table if not exists pin_attempts (
  username     text primary key,
  fails        integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table pin_attempts enable row level security;
-- No client policies: access only through the definer RPCs below.

create or replace function login_lock_status(p_username text) returns timestamptz
language sql security definer set search_path = public as $$
  select locked_until from pin_attempts
  where username = lower(p_username) and locked_until > now();
$$;

create or replace function record_login_failure(p_username text) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_fails int;
  v_lock  timestamptz;
begin
  insert into pin_attempts (username, fails, updated_at)
  values (lower(p_username), 1, now())
  on conflict (username) do update
    set fails = case
                  when pin_attempts.locked_until is not null
                       and pin_attempts.locked_until <= now() then 1
                  else pin_attempts.fails + 1
                end,
        locked_until = case
                         when pin_attempts.locked_until is not null
                              and pin_attempts.locked_until <= now() then null
                         else pin_attempts.locked_until
                       end,
        updated_at = now()
  returning fails into v_fails;
  if v_fails >= 5 then
    update pin_attempts
      set locked_until = now() + interval '15 minutes', fails = 0, updated_at = now()
      where username = lower(p_username)
      returning locked_until into v_lock;
  end if;
  return v_lock;
end $$;

create or replace function clear_login_failures() returns void
language plpgsql security definer set search_path = public as $$
declare v_username text;
begin
  select username into v_username from profiles where id = auth.uid();
  if v_username is not null then
    delete from pin_attempts where username = lower(v_username);
  end if;
end $$;

grant execute on function login_lock_status(text) to anon, authenticated;
grant execute on function record_login_failure(text) to anon, authenticated;
grant execute on function clear_login_failures() to authenticated;

alter table login_logs add column if not exists user_agent text;

-- ---------------------------------------------------------------------------
-- 3) Agents: limits + close-out state
-- ---------------------------------------------------------------------------
alter table agents add column if not exists bottle_limit integer not null default 0;
alter table agents add column if not exists credit_limit bigint  not null default 0;
alter table agents add column if not exists closed_at  timestamptz;
alter table agents add column if not exists closed_by  uuid references profiles (id);

-- ---------------------------------------------------------------------------
-- 4) New tables: deposits ledger, write-offs, settlements
-- ---------------------------------------------------------------------------
create table agent_deposits (
  id               uuid primary key default gen_random_uuid(),
  agent_id         uuid not null references agents (id),
  agent_name       text,
  deposit_date     date not null default (now() at time zone 'Asia/Yangon')::date,
  bottles          integer not null check (bottles > 0),
  price_per_bottle integer not null check (price_per_bottle >= 0),
  amount           bigint  not null check (amount >= 0),
  note             text,
  created_by       uuid references profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table write_offs (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references agents (id),
  agent_name    text,
  writeoff_date date not null default (now() at time zone 'Asia/Yangon')::date,
  amount        bigint not null check (amount > 0),
  note          text not null,
  created_by    uuid references profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table agent_settlements (
  id                uuid primary key default gen_random_uuid(),
  agent_id          uuid not null unique references agents (id),
  agent_name        text,
  settle_date       date not null default (now() at time zone 'Asia/Yangon')::date,
  held_bottles      integer not null,
  returned_bottles  integer not null,
  missing_bottles   integer not null,
  current_price     integer not null,
  deposit_original  bigint not null,
  refund_amount     bigint not null,
  price_diff        bigint not null default 0,
  price_diff_kind   text not null default 'none'
                    check (price_diff_kind in ('none', 'extra_pay', 'price_drop')),
  forfeiture_income bigint not null default 0,
  net_refund        bigint not null default 0,
  agent_owes        bigint not null default 0,
  note              text,
  created_by        uuid references profiles (id),
  created_at        timestamptz not null default now()
);

alter table agent_deposits    enable row level security;
alter table write_offs        enable row level security;
alter table agent_settlements enable row level security;

create policy deposits_select on agent_deposits for select to authenticated
  using (is_owner_manager() or agent_id = app_agent_id());
create policy deposits_insert on agent_deposits for insert to authenticated
  with check (is_owner_manager());
create policy deposits_update on agent_deposits for update to authenticated
  using (is_owner_manager()) with check (is_owner_manager());
create policy deposits_delete on agent_deposits for delete to authenticated
  using (is_owner_manager());

create policy writeoffs_select on write_offs for select to authenticated
  using (is_owner_manager() or agent_id = app_agent_id());
create policy writeoffs_insert on write_offs for insert to authenticated
  with check (is_owner_manager());
create policy writeoffs_update on write_offs for update to authenticated
  using (is_owner_manager()) with check (is_owner_manager());
create policy writeoffs_delete on write_offs for delete to authenticated
  using (is_owner_manager());

create policy settlements_select on agent_settlements for select to authenticated
  using (is_owner_manager());
create policy settlements_insert on agent_settlements for insert to authenticated
  with check (is_owner_manager());
-- Settlements are immutable: no update/delete policies on purpose.

create index deposits_agent_idx     on agent_deposits (agent_id, deposit_date desc);
create index writeoffs_agent_idx    on write_offs (agent_id, writeoff_date desc);
create index settlements_agent_idx  on agent_settlements (agent_id);

-- ---------------------------------------------------------------------------
-- 5) Entries/payments upgrades: cash collected, change reason, name snapshot
-- ---------------------------------------------------------------------------
alter table daily_entries add column if not exists agent_name      text;
alter table daily_entries add column if not exists amount_collected bigint not null default 0
  check (amount_collected >= 0);
alter table daily_entries add column if not exists change_reason   text;
alter table agent_payments add column if not exists agent_name     text;
alter table agent_payments add column if not exists change_reason  text;

create or replace function fill_agent_name() returns trigger
language plpgsql as $$
begin
  if new.agent_id is not null then
    select name into new.agent_name from agents where id = new.agent_id;
  end if;
  return new;
end $$;

create trigger entries_fill_name before insert on daily_entries
  for each row execute function fill_agent_name();
create trigger payments_fill_name before insert on agent_payments
  for each row execute function fill_agent_name();
create trigger deposits_fill_name before insert on agent_deposits
  for each row execute function fill_agent_name();
create trigger writeoffs_fill_name before insert on write_offs
  for each row execute function fill_agent_name();
create trigger settlements_fill_name before insert on agent_settlements
  for each row execute function fill_agent_name();

update daily_entries e set agent_name = a.name
  from agents a where e.agent_id = a.id and e.agent_name is null;
update agent_payments p set agent_name = a.name
  from agents a where p.agent_id = a.id and p.agent_name is null;

-- ---------------------------------------------------------------------------
-- 6) Outstanding balance + entry guards (price snapshot, limits)
-- ---------------------------------------------------------------------------
create or replace function agent_outstanding(p_agent uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce((
           select sum(delivered_qty::bigint * unit_price - amount_collected)
           from daily_entries where agent_id = p_agent), 0)
       - coalesce((select sum(amount) from agent_payments where agent_id = p_agent), 0)
       - coalesce((select sum(amount) from write_offs    where agent_id = p_agent), 0);
$$;
grant execute on function agent_outstanding(uuid) to authenticated;

create or replace function entries_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_agent       agents%rowtype;
  v_held        integer;
  v_dep_bottles integer;
  v_due         bigint;
  v_old_due     bigint := 0;
begin
  select * into v_agent from agents where id = new.agent_id;
  if v_agent.id is null then
    raise exception 'agent_not_found';
  end if;
  if v_agent.closed_at is not null then
    raise exception 'agent_closed: this agent has been closed out';
  end if;

  -- Unit price is a snapshot of the agent's price at entry time (insert
  -- only; history is never rewritten by later price changes).
  if tg_op = 'INSERT' then
    new.unit_price := v_agent.default_unit_price;
  end if;
  new.amount := new.delivered_qty::bigint * new.unit_price;

  -- Bottle caps: explicit bottle_limit, and deposit coverage when the
  -- agent pays a per-bottle deposit.
  select coalesce(sum(delivered_qty - returned_qty), 0) into v_held
    from daily_entries
    where agent_id = new.agent_id and (tg_op = 'INSERT' or id <> new.id);
  v_held := v_held + (new.delivered_qty - new.returned_qty);

  if v_agent.bottle_limit > 0 and v_held > v_agent.bottle_limit then
    raise exception 'bottle_limit: exceeds the bottle limit by % bottles',
      v_held - v_agent.bottle_limit;
  end if;

  if v_agent.deposit_per_bottle > 0 then
    select coalesce(sum(bottles), 0) into v_dep_bottles
      from agent_deposits where agent_id = new.agent_id;
    if v_held > v_dep_bottles then
      raise exception 'deposit_limit: exceeds deposit bottles by % — top-up % MMK needed',
        v_held - v_dep_bottles,
        (v_held - v_dep_bottles) * v_agent.deposit_per_bottle;
    end if;
  end if;

  -- Credit limit binds staff saves only; an Owner/Manager save is the
  -- approval (old-app rule).
  if app_role() = 'staff' and v_agent.credit_limit > 0 then
    v_due := new.delivered_qty::bigint * new.unit_price - new.amount_collected;
    if tg_op = 'UPDATE' then
      v_old_due := old.delivered_qty::bigint * old.unit_price - old.amount_collected;
    end if;
    if agent_outstanding(new.agent_id) - v_old_due + v_due > v_agent.credit_limit then
      raise exception 'credit_limit: agent debt would exceed the credit limit';
    end if;
  end if;

  return new;
end $$;

create trigger entries_before_write before insert or update on daily_entries
  for each row execute function entries_before_write();

-- ---------------------------------------------------------------------------
-- 7) Close-out: finalize + hard delete (old-app settlement math, exact)
-- ---------------------------------------------------------------------------
create or replace function finalize_closeout(
  p_agent uuid, p_returned integer, p_current_price integer, p_note text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_agent     agents%rowtype;
  v_held      integer;
  v_dep_btls  integer;
  v_dep_amt   bigint;
  v_avg       numeric;
  v_missing   integer;
  v_missing_dep   integer;
  v_returned_dep  integer;
  v_orig_ret  numeric;
  v_curr_ret  numeric;
  v_rose      boolean;
  v_refund    bigint;
  v_diff      bigint;
  v_kind      text;
  v_forfeit   bigint;
  v_net       numeric;
  v_row       agent_settlements%rowtype;
  v_cat_id    uuid;
  v_today     date := (now() at time zone 'Asia/Yangon')::date;
begin
  if not is_owner_manager() then
    raise exception 'forbidden: owner/manager only';
  end if;
  select * into v_agent from agents where id = p_agent;
  if v_agent.id is null then raise exception 'agent_not_found'; end if;
  if v_agent.closed_at is not null
     or exists (select 1 from agent_settlements where agent_id = p_agent) then
    raise exception 'already_closed: စာရင်းပိတ်ပြီးသားပါ';
  end if;

  select coalesce(sum(delivered_qty - returned_qty), 0) into v_held
    from daily_entries where agent_id = p_agent;
  select coalesce(sum(bottles), 0), coalesce(sum(amount), 0)
    into v_dep_btls, v_dep_amt
    from agent_deposits where agent_id = p_agent;

  if p_returned is null or p_returned < 0 or p_returned > v_held then
    raise exception 'bad_returned: ပြန်အပ်ဘူး အရေအတွက် မမှန်ပါ';
  end if;
  if agent_outstanding(p_agent) > 0 then
    raise exception 'receivable_open: ရရန်ကျန်ငွေ မရှင်းရသေးပါ';
  end if;
  if p_current_price is null or p_current_price <= 0 then
    raise exception 'bad_price: ယနေ့ ပေါက်ဈေး ထည့်ပါ';
  end if;

  -- Settlement math — identical to the old app's settlement.ts.
  v_missing      := greatest(v_held - p_returned, 0);
  v_avg          := case when v_dep_btls > 0 then v_dep_amt::numeric / v_dep_btls else 0 end;
  v_missing_dep  := least(v_missing, v_dep_btls);
  v_returned_dep := greatest(v_dep_btls - v_missing_dep, 0);
  v_orig_ret     := v_avg * v_returned_dep;
  v_curr_ret     := p_current_price::numeric * v_returned_dep;
  v_rose         := v_curr_ret > v_orig_ret;
  v_refund       := round(case when v_rose then v_curr_ret else v_orig_ret end)::bigint;
  v_diff         := round(abs(v_curr_ret - v_orig_ret))::bigint;
  v_kind         := case when v_diff = 0 then 'none'
                         when v_rose then 'extra_pay' else 'price_drop' end;
  v_forfeit      := v_missing::bigint * p_current_price;
  v_net          := v_refund + v_avg * v_missing_dep - v_forfeit;

  insert into agent_settlements (
    agent_id, settle_date, held_bottles, returned_bottles, missing_bottles,
    current_price, deposit_original, refund_amount, price_diff, price_diff_kind,
    forfeiture_income, net_refund, agent_owes, note, created_by
  ) values (
    p_agent, v_today, v_held, p_returned, v_missing,
    p_current_price, v_dep_amt, v_refund, v_diff, v_kind,
    v_forfeit, greatest(round(v_net), 0)::bigint, greatest(round(-v_net), 0)::bigint,
    p_note, auth.uid()
  ) returning * into v_row;

  if v_diff > 0 then
    select id into v_cat_id from expense_categories where name = 'ဗူးအပေါင် ဈေးကွာ';
    insert into expenses (expense_date, category_id, title, amount, notes, created_by)
    values (
      v_today, v_cat_id,
      v_agent.name || ' — ' || case when v_kind = 'extra_pay'
                                    then 'ဈေးတက်၍ အပိုပြန်ပေး'
                                    else 'ဈေးကျ၍ မူလအပေါင်အပြည့်ပြန်အမ်း' end,
      v_diff,
      'Agent close-out price difference',
      auth.uid()
    );
  end if;

  update agents
    set closed_at = now(), closed_by = auth.uid(), active = false
    where id = p_agent;

  return to_jsonb(v_row);
end $$;
grant execute on function finalize_closeout(uuid, integer, integer, text) to authenticated;

-- Owner-only permanent delete of a CLOSED agent. Child rows keep their
-- agent_name snapshot; their agent_id is set null by the FKs below.
create or replace function hard_delete_agent(p_agent uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_role() <> 'owner' then
    raise exception 'forbidden: owner only';
  end if;
  if not exists (select 1 from agent_settlements where agent_id = p_agent) then
    raise exception 'not_settled: စာရင်းမပိတ်ရသေးပါ';
  end if;
  delete from agents where id = p_agent;
end $$;
grant execute on function hard_delete_agent(uuid) to authenticated;

-- FK behaviour: child rows survive an agent hard-delete via SET NULL.
alter table daily_entries   drop constraint daily_entries_agent_id_fkey;
alter table daily_entries   add constraint daily_entries_agent_id_fkey
  foreign key (agent_id) references agents (id) on delete set null;
alter table daily_entries   alter column agent_id drop not null;
alter table agent_payments  drop constraint agent_payments_agent_id_fkey;
alter table agent_payments  add constraint agent_payments_agent_id_fkey
  foreign key (agent_id) references agents (id) on delete set null;
alter table agent_payments  alter column agent_id drop not null;
alter table agent_deposits  drop constraint agent_deposits_agent_id_fkey;
alter table agent_deposits  add constraint agent_deposits_agent_id_fkey
  foreign key (agent_id) references agents (id) on delete set null;
alter table agent_deposits  alter column agent_id drop not null;
alter table write_offs      drop constraint write_offs_agent_id_fkey;
alter table write_offs      add constraint write_offs_agent_id_fkey
  foreign key (agent_id) references agents (id) on delete set null;
alter table write_offs      alter column agent_id drop not null;
alter table agent_settlements drop constraint agent_settlements_agent_id_fkey;
alter table agent_settlements add constraint agent_settlements_agent_id_fkey
  foreign key (agent_id) references agents (id) on delete set null;
alter table agent_settlements alter column agent_id drop not null;
alter table profiles        drop constraint profiles_agent_fk;
alter table profiles        add constraint profiles_agent_fk
  foreign key (agent_id) references agents (id) on delete set null;

-- ---------------------------------------------------------------------------
-- 8) Shared triggers on the new tables (attribution, updated_at, audit,
--    month lock)
-- ---------------------------------------------------------------------------
create trigger deposits_attribution before insert on agent_deposits
  for each row execute function force_insert_attribution();
create trigger writeoffs_attribution before insert on write_offs
  for each row execute function force_insert_attribution();
create trigger settlements_attribution before insert on agent_settlements
  for each row execute function force_insert_attribution();

create trigger deposits_updated before update on agent_deposits
  for each row execute function set_updated_at();
create trigger writeoffs_updated before update on write_offs
  for each row execute function set_updated_at();

create trigger deposits_audit after insert or update or delete on agent_deposits
  for each row execute function audit_row_change();
create trigger writeoffs_audit after insert or update or delete on write_offs
  for each row execute function audit_row_change();
create trigger settlements_audit after insert or update or delete on agent_settlements
  for each row execute function audit_row_change();
create trigger user_roles_audit after insert or update or delete on user_roles
  for each row execute function audit_row_change();

create trigger deposits_month_lock before insert or update or delete on agent_deposits
  for each row execute function guard_month_lock('deposit_date');
create trigger writeoffs_month_lock before insert or update or delete on write_offs
  for each row execute function guard_month_lock('writeoff_date');
create trigger settlements_month_lock before insert or update or delete on agent_settlements
  for each row execute function guard_month_lock('settle_date');

-- ---------------------------------------------------------------------------
-- 9) Disputes: link to the disputed record (one open dispute per record)
-- ---------------------------------------------------------------------------
alter table disputes add column if not exists kind           text
  check (kind in ('entry', 'payment'));
alter table disputes add column if not exists record_id      uuid;
alter table disputes add column if not exists record_date    date;
alter table disputes add column if not exists record_summary text;
create unique index if not exists disputes_one_open_per_record
  on disputes (record_id) where status = 'open' and record_id is not null;

-- ---------------------------------------------------------------------------
-- 10) Stock-move kinds (old app: produce / purchase / damage) + seeds
-- ---------------------------------------------------------------------------
alter table inventory_movements drop constraint if exists inventory_movements_kind_check;
alter table inventory_movements add constraint inventory_movements_kind_check
  check (kind in ('produce', 'purchase', 'damage', 'in', 'out', 'adjust'));

insert into expense_categories (name) values
  ('ကားဆီဖိုး'), ('ကား'), ('ရေသန့်စက်'), ('စက်ရုံ'),
  ('ဆက်သွယ်ရေး'), ('ပြုပြင်ထိန်းသိမ်းမှု'), ('အခြား'),
  ('ဗူးအပေါင် ဈေးကွာ')
on conflict (name) do nothing;

insert into app_settings (key, value) values
  ('factory_phone', '""'::jsonb),
  ('factory_address', '""'::jsonb),
  ('default_price_per_bottle', '0'::jsonb),
  ('default_deposit_per_bottle', '0'::jsonb),
  ('refresh_seconds', '30'::jsonb)
on conflict (key) do nothing;

-- ===================== 0007_hard_delete_fix.sql =====================

-- 0007_hard_delete_fix.sql — Fix hard_delete_agent (found in Phase A tests).
--
-- Problem: deleting an agent fires ON DELETE SET NULL on child tables,
-- which fires the child tables' BEFORE UPDATE triggers (entries_before_write
-- raised 'agent_not_found' on the nulled row; the same-day and month-lock
-- guards would also block the cascade for older rows).
--
-- Fix: the RPC detaches child rows itself with triggers temporarily
-- disabled (session_replication_role = replica, local to this transaction),
-- then deletes the agent normally so the agent's own DELETE is audited.
-- Child rows keep their agent_name snapshots (old-app behaviour).

create or replace function hard_delete_agent(p_agent uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_role() <> 'owner' then
    raise exception 'forbidden: owner only';
  end if;
  if not exists (select 1 from agent_settlements where agent_id = p_agent) then
    raise exception 'not_settled: စာရင်းမပိတ်ရသေးပါ';
  end if;

  perform set_config('session_replication_role', 'replica', true);
  update daily_entries     set agent_id = null where agent_id = p_agent;
  update agent_payments    set agent_id = null where agent_id = p_agent;
  update agent_deposits    set agent_id = null where agent_id = p_agent;
  update write_offs        set agent_id = null where agent_id = p_agent;
  update agent_settlements set agent_id = null where agent_id = p_agent;
  update profiles          set agent_id = null where agent_id = p_agent;
  perform set_config('session_replication_role', 'origin', true);

  delete from agents where id = p_agent;
end $$;

-- Robustness: the entry guard ignores rows whose agent has been detached.
create or replace function entries_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_agent       agents%rowtype;
  v_held        integer;
  v_dep_bottles integer;
  v_due         bigint;
  v_old_due     bigint := 0;
begin
  if new.agent_id is null then
    return new;
  end if;
  select * into v_agent from agents where id = new.agent_id;
  if v_agent.id is null then
    raise exception 'agent_not_found';
  end if;
  if v_agent.closed_at is not null then
    raise exception 'agent_closed: this agent has been closed out';
  end if;

  if tg_op = 'INSERT' then
    new.unit_price := v_agent.default_unit_price;
  end if;
  new.amount := new.delivered_qty::bigint * new.unit_price;

  select coalesce(sum(delivered_qty - returned_qty), 0) into v_held
    from daily_entries
    where agent_id = new.agent_id and (tg_op = 'INSERT' or id <> new.id);
  v_held := v_held + (new.delivered_qty - new.returned_qty);

  if v_agent.bottle_limit > 0 and v_held > v_agent.bottle_limit then
    raise exception 'bottle_limit: exceeds the bottle limit by % bottles',
      v_held - v_agent.bottle_limit;
  end if;

  if v_agent.deposit_per_bottle > 0 then
    select coalesce(sum(bottles), 0) into v_dep_bottles
      from agent_deposits where agent_id = new.agent_id;
    if v_held > v_dep_bottles then
      raise exception 'deposit_limit: exceeds deposit bottles by % — top-up % MMK needed',
        v_held - v_dep_bottles,
        (v_held - v_dep_bottles) * v_agent.deposit_per_bottle;
    end if;
  end if;

  if app_role() = 'staff' and v_agent.credit_limit > 0 then
    v_due := new.delivered_qty::bigint * new.unit_price - new.amount_collected;
    if tg_op = 'UPDATE' then
      v_old_due := old.delivered_qty::bigint * old.unit_price - old.amount_collected;
    end if;
    if agent_outstanding(new.agent_id) - v_old_due + v_due > v_agent.credit_limit then
      raise exception 'credit_limit: agent debt would exceed the credit limit';
    end if;
  end if;

  return new;
end $$;

-- ===================== 0008_hard_delete_fix2.sql =====================

-- 0008_hard_delete_fix2.sql — Replace the 0007 approach.
--
-- session_replication_role cannot be set from a Supabase function
-- (permission denied), so instead the two guard functions learn to
-- recognise the ON DELETE SET NULL cascade: an UPDATE whose ONLY change
-- is agent_id -> null (the agent hard-delete detaching the row). Such
-- updates pass the same-day and month-lock guards untouched; the row
-- keeps its agent_name snapshot, exactly like the old app.

create or replace function guard_same_day_edit() returns trigger
language plpgsql as $$
begin
  -- Agent hard-delete cascade: only agent_id was nulled -> allow.
  if tg_op = 'UPDATE'
     and (to_jsonb(old) ? 'agent_id')
     and (to_jsonb(old) ->> 'agent_id') is not null
     and (to_jsonb(new) ->> 'agent_id') is null
     and (to_jsonb(old) - 'agent_id' - 'updated_at')
         = (to_jsonb(new) - 'agent_id' - 'updated_at') then
    return new;
  end if;
  if (old.created_at at time zone 'Asia/Yangon')::date
     <> (now() at time zone 'Asia/Yangon')::date then
    raise exception 'same_day_only: records can only be edited or deleted on the day they were created';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create or replace function guard_month_lock() returns trigger
language plpgsql as $$
declare
  v_date_field text := tg_argv[0];
  v_old_month date;
  v_new_month date;
begin
  -- Agent hard-delete cascade: only agent_id was nulled -> allow.
  if tg_op = 'UPDATE'
     and (to_jsonb(old) ? 'agent_id')
     and (to_jsonb(old) ->> 'agent_id') is not null
     and (to_jsonb(new) ->> 'agent_id') is null
     and (to_jsonb(old) - 'agent_id' - 'updated_at')
         = (to_jsonb(new) - 'agent_id' - 'updated_at') then
    return new;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_old_month := date_trunc('month', (to_jsonb(old) ->> v_date_field)::date)::date;
    if exists (select 1 from month_locks where month = v_old_month) then
      raise exception 'month_locked: % is locked', v_old_month;
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new_month := date_trunc('month', (to_jsonb(new) ->> v_date_field)::date)::date;
    if exists (select 1 from month_locks where month = v_new_month) then
      raise exception 'month_locked: % is locked', v_new_month;
    end if;
    return new;
  end if;
  return old;
end $$;

create or replace function hard_delete_agent(p_agent uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_role() <> 'owner' then
    raise exception 'forbidden: owner only';
  end if;
  if not exists (select 1 from agent_settlements where agent_id = p_agent) then
    raise exception 'not_settled: စာရင်းမပိတ်ရသေးပါ';
  end if;
  -- FKs are ON DELETE SET NULL; the guard bypasses above let the cascade
  -- updates through while the rows keep their agent_name snapshots.
  delete from agents where id = p_agent;
end $$;

-- 0009_phase_b_payroll_handover.sql — Phase B data layer: payroll + handover.
--
-- Payroll model (exact old-app rules, phase2.functions.ts computePayroll):
-- population = active users whose effective roles include staff/manager/
-- co_owner; base = salary_settings.monthly_salary; bonus = sum of the
-- month's bonuses; each advance deducts from the first payroll month >= its
-- advance month: installment amount per month when installment > 0, else the
-- whole remaining balance; paying writes one immutable payroll_runs row plus
-- advance_repayments rows, atomically, via the pay_month RPC.
-- Month columns are 'YYYY-MM' text (old-app shape); a dedicated guard keeps
-- locked months closed for bonuses / payroll_runs / advance_repayments.

create table salary_settings (
  user_id        uuid primary key references profiles (id) on delete cascade,
  monthly_salary bigint not null default 0 check (monthly_salary >= 0),
  updated_at     timestamptz not null default now()
);

create table advances (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles (id) on delete cascade,
  advance_date date not null default (now() at time zone 'Asia/Yangon')::date,
  amount       bigint not null check (amount > 0),
  installment  bigint not null default 0 check (installment >= 0),  -- 0 = one-shot
  note         text,
  created_by   uuid references profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table bonuses (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles (id) on delete cascade,
  month      text not null check (month ~ '^\d{4}-\d{2}$'),
  amount     bigint not null check (amount > 0),
  note       text,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table payroll_runs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles (id) on delete cascade,
  month      text not null check (month ~ '^\d{4}-\d{2}$'),
  base       bigint not null,
  bonus      bigint not null,
  deduction  bigint not null,
  net        bigint not null,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  unique (user_id, month)
);

create table advance_repayments (
  id         uuid primary key default gen_random_uuid(),
  advance_id uuid not null references advances (id) on delete cascade,
  month      text not null check (month ~ '^\d{4}-\d{2}$'),
  amount     bigint not null check (amount > 0),
  created_at timestamptz not null default now()
);

create table cash_handovers (
  id            uuid primary key default gen_random_uuid(),
  handover_date date not null default (now() at time zone 'Asia/Yangon')::date,
  employee_id   uuid not null references profiles (id) on delete cascade,
  expected      bigint not null,
  received      bigint not null,
  note          text,
  received_by   uuid references profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (handover_date, employee_id)
);

alter table salary_settings    enable row level security;
alter table advances           enable row level security;
alter table bonuses            enable row level security;
alter table payroll_runs       enable row level security;
alter table advance_repayments enable row level security;
alter table cash_handovers     enable row level security;

create policy salary_select on salary_settings for select to authenticated using (is_owner_manager());
create policy salary_write  on salary_settings for insert to authenticated with check (is_owner_manager());
create policy salary_update on salary_settings for update to authenticated using (is_owner_manager()) with check (is_owner_manager());

create policy advances_select on advances for select to authenticated using (is_owner_manager());
create policy advances_write  on advances for insert to authenticated with check (is_owner_manager());
create policy advances_update on advances for update to authenticated using (is_owner_manager()) with check (is_owner_manager());
create policy advances_delete on advances for delete to authenticated using (is_owner_manager());

create policy bonuses_select on bonuses for select to authenticated using (is_owner_manager());
create policy bonuses_write  on bonuses for insert to authenticated with check (is_owner_manager());
create policy bonuses_update on bonuses for update to authenticated using (is_owner_manager()) with check (is_owner_manager());
create policy bonuses_delete on bonuses for delete to authenticated using (is_owner_manager());

create policy runs_select on payroll_runs for select to authenticated using (is_owner_manager());
-- payroll_runs rows are written by the pay_month RPC only (definer bypasses
-- RLS); no client insert/update/delete policies on purpose (immutable).

create policy repayments_select on advance_repayments for select to authenticated using (is_owner_manager());
-- advance_repayments likewise: RPC-written only.

create policy handover_select on cash_handovers for select to authenticated using (is_owner_manager());
create policy handover_write  on cash_handovers for insert to authenticated with check (is_owner_manager());
create policy handover_update on cash_handovers for update to authenticated using (is_owner_manager()) with check (is_owner_manager());
create policy handover_delete on cash_handovers for delete to authenticated using (is_owner_manager());

create index advances_user_idx   on advances (user_id, advance_date);
create index bonuses_user_month  on bonuses (user_id, month);
create index runs_user_month     on payroll_runs (user_id, month);
create index repayments_adv_idx  on advance_repayments (advance_id);
create index handover_date_idx   on cash_handovers (handover_date desc);

-- Month lock for 'YYYY-MM' text-month tables.
create or replace function guard_month_lock_text() returns trigger
language plpgsql as $$
declare
  v_field text := tg_argv[0];
  v_month date;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_month := ((to_jsonb(old) ->> v_field) || '-01')::date;
    if exists (select 1 from month_locks where month = v_month) then
      raise exception 'month_locked: % is locked', to_char(v_month, 'YYYY-MM');
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_month := ((to_jsonb(new) ->> v_field) || '-01')::date;
    if exists (select 1 from month_locks where month = v_month) then
      raise exception 'month_locked: % is locked', to_char(v_month, 'YYYY-MM');
    end if;
    return new;
  end if;
  return old;
end $$;

create trigger bonuses_month_lock before insert or update or delete on bonuses
  for each row execute function guard_month_lock_text('month');
create trigger runs_month_lock before insert or update or delete on payroll_runs
  for each row execute function guard_month_lock_text('month');
create trigger repayments_month_lock before insert or update or delete on advance_repayments
  for each row execute function guard_month_lock_text('month');
create trigger advances_month_lock before insert or update or delete on advances
  for each row execute function guard_month_lock('advance_date');
create trigger handovers_month_lock before insert or update or delete on cash_handovers
  for each row execute function guard_month_lock('handover_date');

-- Attribution / updated_at / audit.
create trigger advances_attribution before insert on advances
  for each row execute function force_insert_attribution();
create trigger bonuses_attribution before insert on bonuses
  for each row execute function force_insert_attribution();
create trigger handovers_attribution before insert on cash_handovers
  for each row execute function force_insert_attribution();

create trigger advances_updated before update on advances
  for each row execute function set_updated_at();
create trigger bonuses_updated before update on bonuses
  for each row execute function set_updated_at();
create trigger salary_updated before update on salary_settings
  for each row execute function set_updated_at();
create trigger handovers_updated before update on cash_handovers
  for each row execute function set_updated_at();

create trigger salary_audit after insert or update or delete on salary_settings
  for each row execute function audit_row_change();
create trigger advances_audit after insert or update or delete on advances
  for each row execute function audit_row_change();
create trigger bonuses_audit after insert or update or delete on bonuses
  for each row execute function audit_row_change();
create trigger runs_audit after insert or update or delete on payroll_runs
  for each row execute function audit_row_change();
create trigger repayments_audit after insert or update or delete on advance_repayments
  for each row execute function audit_row_change();
create trigger handovers_audit after insert or update or delete on cash_handovers
  for each row execute function audit_row_change();

-- Pay a month's salary for one user (atomic: run + repayments).
create or replace function pay_month(p_user uuid, p_month text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_base      bigint := 0;
  v_bonus     bigint := 0;
  v_deduction bigint := 0;
  v_run       payroll_runs%rowtype;
  r           record;
  v_paid      bigint;
  v_remaining bigint;
begin
  if not is_owner_manager() then
    raise exception 'forbidden: owner/manager only';
  end if;
  if exists (select 1 from month_locks where month = (p_month || '-01')::date) then
    raise exception 'month_locked: % is locked', p_month;
  end if;
  if exists (select 1 from payroll_runs where user_id = p_user and month = p_month) then
    raise exception 'already_paid: ဒီလအတွက် ပေးပြီးသားပါ';
  end if;

  select coalesce(monthly_salary, 0) into v_base
    from salary_settings where user_id = p_user;
  v_base := coalesce(v_base, 0);
  select coalesce(sum(amount), 0) into v_bonus
    from bonuses where user_id = p_user and month = p_month;

  -- Pass 1: compute the deduction (old-app plan rules).
  for r in select * from advances where user_id = p_user order by advance_date, created_at loop
    select coalesce(sum(amount), 0) into v_paid
      from advance_repayments where advance_id = r.id and month <> p_month;
    v_remaining := r.amount - v_paid;
    if v_remaining <= 0 then continue; end if;
    if to_char(r.advance_date, 'YYYY-MM') > p_month then continue; end if;
    v_deduction := v_deduction
      + case when r.installment > 0 then least(r.installment, v_remaining)
             else v_remaining end;
  end loop;

  insert into payroll_runs (user_id, month, base, bonus, deduction, net, created_by)
  values (p_user, p_month, v_base, v_bonus, v_deduction,
          v_base + v_bonus - v_deduction, auth.uid())
  returning * into v_run;

  -- Pass 2: write the repayment rows with the same deterministic plan.
  for r in select * from advances where user_id = p_user order by advance_date, created_at loop
    select coalesce(sum(amount), 0) into v_paid
      from advance_repayments where advance_id = r.id and month <> p_month;
    v_remaining := r.amount - v_paid;
    if v_remaining <= 0 then continue; end if;
    if to_char(r.advance_date, 'YYYY-MM') > p_month then continue; end if;
    insert into advance_repayments (advance_id, month, amount)
    values (r.id, p_month,
            case when r.installment > 0 then least(r.installment, v_remaining)
                 else v_remaining end);
  end loop;

  return to_jsonb(v_run);
end $$;
grant execute on function pay_month(uuid, text) to authenticated;

-- 0010_audit_row_id_user_id.sql — audit_row_change() row_id fallback.
--
-- salary_settings (PK = user_id, no id/month/agent_id/key column) produced a
-- NULL audit row_id, which violated audit_log's NOT NULL and blocked the
-- insert entirely. Add user_id to the fallback chain.

create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row_id text;
begin
  v_row_id := coalesce((to_jsonb(coalesce(new, old)) ->> 'id'),
                       (to_jsonb(coalesce(new, old)) ->> 'month'),
                       (to_jsonb(coalesce(new, old)) ->> 'agent_id'),
                       (to_jsonb(coalesce(new, old)) ->> 'user_id'),
                       (to_jsonb(coalesce(new, old)) ->> 'key'));
  if tg_op = 'INSERT' then
    insert into audit_log (table_name, row_id, action, old_data, new_data, actor)
    values (tg_table_name, v_row_id, 'insert', null, to_jsonb(new), auth.uid());
    return new;
  elsif tg_op = 'UPDATE' then
    insert into audit_log (table_name, row_id, action, old_data, new_data, actor)
    values (tg_table_name, v_row_id, 'update', to_jsonb(old), to_jsonb(new), auth.uid());
    return new;
  else
    insert into audit_log (table_name, row_id, action, old_data, new_data, actor)
    values (tg_table_name, v_row_id, 'delete', to_jsonb(old), null, auth.uid());
    return old;
  end if;
end $$;

-- 0011_phase_c_notifications.sql — Phase C data layer: in-app notifications.
--
-- Port of the old app's notification model (OLD-APP-INVENTORY §10):
-- notifications(id, user_id, kind, title, body, link, priority, tag, read_at),
-- notify_prefs(user_id, mode all/important, quiet_night), push_tokens.
-- Rows are generated by DB triggers on entries / payments / disputes so no
-- client can forge or skip them. Recipients: owner/manager/co_owner users
-- ("OM") for business events, and the agent's own linked user gets a receipt
-- for their deliveries and payments. The acting user is NOT notified about
-- their own action (deliberate: the old SQL lived in Lovable Cloud and is
-- not recoverable; self-notification is pure noise in the bell).
-- FCM sending is a separate later step (needs the Firebase service-account
-- secret); this migration only stores tokens + prefs for it.
-- digest / data_quality kinds are produced by scheduled jobs (later step);
-- the table already supports them.

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles (id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text not null default '',
  link       text not null default '/',
  priority   text not null default 'normal' check (priority in ('normal', 'high')),
  tag        text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, created_at desc);
create index notifications_unread_idx on notifications (user_id) where read_at is null;

create table notify_prefs (
  user_id     uuid primary key references profiles (id) on delete cascade,
  mode        text not null default 'all' check (mode in ('all', 'important')),
  quiet_night boolean not null default true,
  updated_at  timestamptz not null default now()
);

-- push_tokens already exists from 0001 (id, profile_id, token unique,
-- platform, updated_at) with own-row policies from 0002 — reused as-is.

alter table notifications enable row level security;
alter table notify_prefs  enable row level security;

-- Users see and mark only their own notifications. No client INSERT: rows
-- come from the SECURITY DEFINER generator triggers below.
create policy noti_select on notifications for select to authenticated
  using (user_id = auth.uid());
create policy noti_update on notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy noti_delete on notifications for delete to authenticated
  using (user_id = auth.uid());

create policy prefs_select on notify_prefs for select to authenticated
  using (user_id = auth.uid());
create policy prefs_write on notify_prefs for insert to authenticated
  with check (user_id = auth.uid());
create policy prefs_update on notify_prefs for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create trigger prefs_updated before update on notify_prefs
  for each row execute function set_updated_at();

-- Recipients: active OM users (effective roles incl. co_owner as manager),
-- excluding the actor.
create or replace function om_recipients(p_actor uuid) returns setof uuid
language sql security definer set search_path = public as $$
  select p.id from profiles p
  where p.active
    and p.id is distinct from p_actor
    and (p.role in ('owner', 'manager', 'co_owner')
         or exists (select 1 from user_roles ur
                    where ur.profile_id = p.id
                      and ur.role in ('owner', 'manager', 'co_owner')))
$$;

create or replace function insert_notification(
  p_user uuid, p_kind text, p_title text, p_body text,
  p_link text, p_priority text, p_tag text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (user_id, kind, title, body, link, priority, tag)
  values (p_user, p_kind, p_title, p_body, p_link, p_priority, p_tag);
end $$;

-- Delivery entry -> OM notice + agent receipt.
create or replace function notify_on_entry() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_agent_user uuid;
  v_recip      uuid;
begin
  for v_recip in select om_recipients(new.created_by) loop
    perform insert_notification(
      v_recip, 'delivery', 'ရေပို့ မှတ်တမ်း အသစ်',
      coalesce(new.agent_name, '') || ' — ' || new.delivered_qty || ' ဗူး · '
        || to_char(new.amount, 'FM999,999,999') || ' ကျပ်',
      '/entries', 'normal',
      'delivery:' || new.agent_id || ':' || new.entry_date);
  end loop;

  select id into v_agent_user from profiles
   where agent_id = new.agent_id and active and id is distinct from new.created_by
   limit 1;
  if v_agent_user is not null then
    perform insert_notification(
      v_agent_user, 'receipt', 'ရေပို့ မှတ်တမ်း',
      new.entry_date::text || ' — ' || new.delivered_qty || ' ဗူး ပို့ပြီး · ငွေလက်ခံ '
        || to_char(new.amount_collected, 'FM999,999,999') || ' ကျပ် · ကြွေး '
        || to_char(greatest(new.amount - new.amount_collected, 0), 'FM999,999,999') || ' ကျပ်',
      '/my', 'normal',
      'delivery:' || new.agent_id || ':' || new.entry_date);
  end if;
  return new;
end $$;
create trigger entries_notify after insert on daily_entries
  for each row execute function notify_on_entry();

-- Payment -> OM notice + agent receipt.
create or replace function notify_on_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_agent_user uuid;
  v_recip      uuid;
begin
  for v_recip in select om_recipients(new.created_by) loop
    perform insert_notification(
      v_recip, 'collection', 'ငွေ ကောက်ခံမှု',
      coalesce(new.agent_name, '') || ' — ' || to_char(new.amount, 'FM999,999,999') || ' ကျပ် ရရှိ',
      '/payments', 'normal', 'collection:' || new.agent_id || ':' || new.payment_date);
  end loop;

  select id into v_agent_user from profiles
   where agent_id = new.agent_id and active and id is distinct from new.created_by
   limit 1;
  if v_agent_user is not null then
    perform insert_notification(
      v_agent_user, 'receipt', 'ငွေ ပေးချေမှု မှတ်တမ်း',
      to_char(new.amount, 'FM999,999,999') || ' ကျပ် လက်ခံရရှိပါတယ်',
      '/my', 'normal', 'collection:' || new.agent_id || ':' || new.payment_date);
  end if;
  return new;
end $$;
create trigger payments_notify after insert on agent_payments
  for each row execute function notify_on_payment();

-- New dispute -> OM notice (high priority). The disputes table has no
-- created_by: the raiser is the profile linked to the dispute's agent.
create or replace function notify_on_dispute() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_recip uuid;
  v_actor uuid;
  v_name  text;
begin
  select id into v_actor from profiles where agent_id = new.agent_id limit 1;
  select name into v_name from agents where id = new.agent_id;
  for v_recip in select om_recipients(v_actor) loop
    perform insert_notification(
      v_recip, 'dispute', '⚠ အငြင်းပွားမှု အသစ်',
      coalesce(v_name, '') || ' — ' || left(coalesce(new.message, ''), 80),
      '/disputes', 'high', 'dispute:' || new.id);
  end loop;
  return new;
end $$;
create trigger disputes_notify after insert on disputes
  for each row execute function notify_on_dispute();

-- OM replies or closes -> tell the agent who raised it.
create or replace function notify_on_dispute_reply() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_agent_user uuid;
begin
  if (new.status in ('replied', 'closed') and old.status is distinct from new.status) then
    select id into v_agent_user from profiles
     where agent_id = new.agent_id and active limit 1;
    if v_agent_user is not null then
      perform insert_notification(
        v_agent_user, 'dispute_reply',
        case when new.status = 'replied' then 'အငြင်းပွားမှု ပြန်ဖြေရပါပြီ'
             else 'အငြင်းပွားမှု ပိတ်လိုက်ပါပြီ' end,
        coalesce(nullif(new.reply, ''),
                 'သင့် အငြင်းပွားမှုကို စစ်ဆေး ကိုင်တွယ်ပြီးပါပြီ'),
        '/disputes', 'normal', 'dispute:' || new.id);
    end if;
  end if;
  return new;
end $$;
create trigger disputes_reply_notify after update on disputes
  for each row execute function notify_on_dispute_reply();
-- 0012: Scheduled in-app jobs via pg_cron (Phase C).
--  * Daily digest: every evening 19:00 Yangon (12:30 UTC) each active
--    Owner/Manager gets a 'digest' notification with the day's figures,
--    computed from the ledger (never estimated). Users whose notify_prefs
--    mode is 'important' are skipped (digest is normal priority).
--  * Data-quality alerts: every morning 08:30 Yangon (02:00 UTC), if any
--    check fails, OM users get one 'data_quality' notification listing the
--    issues. Sent regardless of prefs mode (it is an alert, not a digest).
-- Both functions are idempotent per day (tag = kind + Yangon date).

create extension if not exists pg_cron;

create or replace function send_daily_digest() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Yangon')::date;
  v_bottles int;
  v_sales bigint;
  v_cash bigint;
  v_exp bigint;
  v_outstanding bigint;
  v_body text;
  v_recip uuid;
begin
  select coalesce(sum(delivered_qty), 0), coalesce(sum(amount), 0),
         coalesce(sum(amount_collected), 0)
    into v_bottles, v_sales, v_cash
    from daily_entries where entry_date = v_today;
  select coalesce(sum(amount), 0) into v_exp
    from expenses where expense_date = v_today;
  select coalesce((select sum(amount - amount_collected) from daily_entries), 0)
         - coalesce((select sum(amount) from agent_payments), 0)
    into v_outstanding;

  v_body :=
    'ဒီနေ့ ရေ ' || v_bottles || ' ဘူး ပို့ပြီး, ရောင်းရငွေ '
    || to_char(v_sales, 'FM999,999,999,999') || ' ကျပ်, လက်ခံရငွေ '
    || to_char(v_cash, 'FM999,999,999,999') || ' ကျပ်, ဒီနေ့ ကြွေးတိုး '
    || to_char(v_sales - v_cash, 'FM999,999,999,999') || ' ကျပ်, ကုန်ကျစရိတ် '
    || to_char(v_exp, 'FM999,999,999,999') || ' ကျပ်. ကြွေးကျန် စုစုပေါင်း '
    || to_char(v_outstanding, 'FM999,999,999,999') || ' ကျပ်';

  for v_recip in select om_recipients(null) loop
    if exists (select 1 from notify_prefs
               where user_id = v_recip and mode = 'important') then
      continue;
    end if;
    if exists (select 1 from notifications
               where user_id = v_recip and tag = 'digest-' || v_today) then
      continue;
    end if;
    perform insert_notification(v_recip, 'digest', 'နေ့စဉ် အကျဉ်းချုပ်',
      v_body, '/', 'normal', 'digest-' || v_today);
  end loop;
end $$;

create or replace function run_data_quality_alerts() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Yangon')::date;
  v_issues text[] := '{}';
  v_last_backup text;
  v_n int;
  v_body text;
  v_recip uuid;
begin
  select value #>> '{}' into v_last_backup
    from app_settings where key = 'last_backup_at';
  if v_last_backup is null
     or v_last_backup::timestamptz < now() - interval '7 days' then
    v_issues := v_issues || ('Backup နောက်ကျနေပါသည် (နောက်ဆုံး backup: '
      || coalesce(v_last_backup, 'မရှိသေး') || ')');
  end if;

  select count(*) into v_n from disputes
    where status = 'open' and created_at < now() - interval '7 days';
  if v_n > 0 then
    v_issues := v_issues || ('ရက် ၇ ရက်ကျော် ဖွင့်ထားဆဲ အငြင်းပွားမှု ' || v_n || ' ခု ရှိပါသည်');
  end if;

  select count(*) into v_n from daily_entries
    where unit_price is not null and amount <> delivered_qty * unit_price;
  if v_n > 0 then
    v_issues := v_issues || ('ပမာဏ မကိုက်ညီသော ရေပို့စာရင်း ' || v_n || ' ခု ရှိပါသည်');
  end if;

  if array_length(v_issues, 1) is null then
    return;
  end if;
  v_body := array_to_string(v_issues, ' ');

  for v_recip in select om_recipients(null) loop
    if exists (select 1 from notifications
               where user_id = v_recip and tag = 'dq-' || v_today) then
      continue;
    end if;
    perform insert_notification(v_recip, 'data_quality',
      'Data စစ်ဆေးမှု သတိပေးချက်', v_body, '/data-quality', 'high',
      'dq-' || v_today);
  end loop;
end $$;

-- Schedules (cron expressions are UTC). Replace any prior schedule of the
-- same name so re-applying this migration is safe.
do $$ begin perform cron.unschedule('wfms-daily-digest'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('wfms-data-quality'); exception when others then null; end $$;
select cron.schedule('wfms-daily-digest', '30 12 * * *', $$select public.send_daily_digest()$$);
select cron.schedule('wfms-data-quality', '0 2 * * *', $$select public.run_data_quality_alerts()$$);

-- 0013 --
-- 0013: Optional Burmese display name for user accounts.
-- Login usernames stay Latin (they double as the internal auth email
-- <username>@waterfactory.local, which cannot contain Burmese script).
-- display_name is free text (Burmese welcome) and is what the UI shows
-- wherever a person's name appears; it falls back to the username.
alter table public.profiles add column if not exists display_name text;

-- 0014 --
-- 0014: Owner-only account administration via security-definer RPCs.
--
-- Why RPCs instead of an Edge Function: creating a Supabase Auth user needs
-- privileged access. The Edge Function route (supabase/functions/
-- admin-create-user) could not be deployed from the build environment, so
-- the same logic lives here as database functions — versioned with the
-- schema, covered by the backup/recovery contract, and callable from the
-- app through PostgREST. Both functions re-check the caller is an active
-- Owner inside the function body; execute is granted to `authenticated`
-- only, and the internal check is the real gate.
--
-- The auth.users insert follows the verified recipe for SQL-created users:
-- bcrypt password via pgcrypto crypt(), ALL token columns as empty strings
-- (NULLs make GoTrue fail with "Database error querying schema"), plus a
-- matching auth.identities row (provider 'email').

create or replace function public.admin_create_user(
  p_username text,
  p_pin text,
  p_role text,
  p_agent_id uuid default null,
  p_display_name text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_caller uuid := auth.uid();
  v_username text := lower(trim(p_username));
  v_id uuid := gen_random_uuid();
  v_email text;
  v_min_pin int;
  v_display text := nullif(trim(coalesce(p_display_name, '')), '');
begin
  if v_caller is null or not exists (
    select 1 from public.profiles
    where id = v_caller and role = 'owner' and active
  ) then
    raise exception 'owner_only';
  end if;

  if v_username !~ '^[a-z0-9_.-]{3,32}$' then
    raise exception 'invalid_username';
  end if;
  if p_role not in ('owner', 'manager', 'staff', 'agent') then
    raise exception 'invalid_role';
  end if;
  v_min_pin := case when p_role in ('owner', 'manager') then 6 else 4 end;
  if p_pin !~ '^\d+$' or length(p_pin) < v_min_pin or length(p_pin) > 12 then
    raise exception 'pin_must_be_%_to_12_digits', v_min_pin;
  end if;
  if p_role = 'agent' then
    if p_agent_id is null then
      raise exception 'agent_id_required';
    end if;
    if not exists (select 1 from public.agents where id = p_agent_id) then
      raise exception 'agent_not_found';
    end if;
  end if;
  if exists (select 1 from public.profiles where username = v_username)
     or exists (select 1 from auth.users where email = v_username || '@waterfactory.local') then
    raise exception 'username_taken';
  end if;

  v_email := v_username || '@waterfactory.local';

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, is_super_admin,
    confirmation_token, recovery_token, email_change, email_change_token_new,
    email_change_token_current, phone_change, phone_change_token,
    reauthentication_token, created_at, updated_at
  ) values (
    v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    v_email, extensions.crypt(p_pin, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('username', v_username, 'role', p_role),
    false, '', '', '', '', '', '', '', '', now(), now()
  );

  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  values (
    gen_random_uuid(), v_id,
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
    'email', v_id::text, now(), now(), now()
  );

  insert into public.profiles (id, username, role, agent_id, display_name, active)
  values (v_id, v_username, p_role::public.user_role,
          case when p_role = 'agent' then p_agent_id else null end,
          v_display, true);

  return (select to_jsonb(p) from public.profiles p where p.id = v_id);
end;
$$;

create or replace function public.admin_reset_pin(
  p_user_id uuid,
  p_new_pin text
) returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_caller uuid := auth.uid();
  v_role text;
  v_username text;
  v_min_pin int;
begin
  if v_caller is null or not exists (
    select 1 from public.profiles
    where id = v_caller and role = 'owner' and active
  ) then
    raise exception 'owner_only';
  end if;

  select role, username into v_role, v_username
  from public.profiles where id = p_user_id;
  if v_role is null then
    raise exception 'user_not_found';
  end if;

  v_min_pin := case when v_role in ('owner', 'manager') then 6 else 4 end;
  if p_new_pin !~ '^\d+$' or length(p_new_pin) < v_min_pin or length(p_new_pin) > 12 then
    raise exception 'pin_must_be_%_to_12_digits', v_min_pin;
  end if;

  update auth.users
  set encrypted_password = extensions.crypt(p_new_pin, extensions.gen_salt('bf')),
      updated_at = now()
  where id = p_user_id;

  -- A reset also frees the account from a login lockout.
  delete from public.pin_attempts where username = v_username;
end;
$$;

revoke all on function public.admin_create_user(text, text, text, uuid, text) from public, anon;
revoke all on function public.admin_reset_pin(uuid, text) from public, anon;
grant execute on function public.admin_create_user(text, text, text, uuid, text) to authenticated;
grant execute on function public.admin_reset_pin(uuid, text) to authenticated;

-- 0015 --
-- 0015: three parity refinements.
-- 1) public_factory_name(): the login card shows the owner's factory name
--    before sign-in (app_settings itself is authenticated-only).
-- 2) notify_on_entry(): delivery notifications escalate to high priority
--    with a warning title when the save leaves the agent over their credit
--    limit (old-app behaviour; staff saves are blocked by the guard, so
--    this fires on owner/manager saves).
-- 3) run_data_quality_alerts(): issue-level dedupe via dq_seen — an issue
--    alerts once when it first appears, not every morning; if it clears
--    and later recurs, it alerts again.

create or replace function public.public_factory_name() returns text
language sql security definer set search_path = public as $$
  select coalesce(
    (select value #>> '{}' from app_settings where key = 'factory_name'),
    'ရေသန့်စက်ရုံ')
$$;
revoke all on function public.public_factory_name() from public;
grant execute on function public.public_factory_name() to anon, authenticated;

create or replace function notify_on_entry() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_agent_user uuid;
  v_recip      uuid;
  v_credit     bigint;
  v_balance    bigint;
  v_priority   text := 'normal';
  v_title      text := 'ရေပို့ မှတ်တမ်း အသစ်';
begin
  select credit_limit into v_credit from agents where id = new.agent_id;
  if coalesce(v_credit, 0) > 0 then
    select coalesce(sum(amount - amount_collected), 0) into v_balance
      from daily_entries where agent_id = new.agent_id;
    v_balance := v_balance - coalesce(
      (select sum(amount) from agent_payments where agent_id = new.agent_id), 0);
    if v_balance > v_credit then
      v_priority := 'high';
      v_title := '⚠ ကြွေးကန့်သတ် ကျော်လွန်နေသော ရေပို့ မှတ်တမ်း';
    end if;
  end if;

  for v_recip in select om_recipients(new.created_by) loop
    perform insert_notification(
      v_recip, 'delivery', v_title,
      coalesce(new.agent_name, '') || ' — ' || new.delivered_qty || ' ဗူး · '
        || to_char(new.amount, 'FM999,999,999') || ' ကျပ်',
      '/entries', v_priority,
      'delivery:' || new.agent_id || ':' || new.entry_date);
  end loop;

  select id into v_agent_user from profiles
   where agent_id = new.agent_id and active and id is distinct from new.created_by
   limit 1;
  if v_agent_user is not null then
    perform insert_notification(
      v_agent_user, 'receipt', 'ရေပို့ မှတ်တမ်း',
      new.entry_date::text || ' — ' || new.delivered_qty || ' ဗူး ပို့ပြီး · ငွေလက်ခံ '
        || to_char(new.amount_collected, 'FM999,999,999') || ' ကျပ် · ကြွေး '
        || to_char(greatest(new.amount - new.amount_collected, 0), 'FM999,999,999') || ' ကျပ်',
      '/my', 'normal',
      'delivery:' || new.agent_id || ':' || new.entry_date);
  end if;
  return new;
end $$;

create table if not exists public.dq_seen (
  issue_key text primary key,
  first_seen_at timestamptz not null default now()
);
alter table public.dq_seen enable row level security;
-- No client policies: only the security-definer job function touches it.

create or replace function run_data_quality_alerts() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Yangon')::date;
  v_keys text[] := '{}';
  v_texts text[] := '{}';
  v_new_keys text[] := '{}';
  v_new_texts text[] := '{}';
  v_last_backup text;
  v_n int;
  v_body text;
  v_recip uuid;
  i int;
begin
  select value #>> '{}' into v_last_backup
    from app_settings where key = 'last_backup_at';
  if v_last_backup is null
     or v_last_backup::timestamptz < now() - interval '7 days' then
    v_keys := array_append(v_keys, 'backup_stale');
    v_texts := array_append(v_texts, 'Backup နောက်ကျနေပါသည် (နောက်ဆုံး backup: '
      || coalesce(v_last_backup, 'မရှိသေး') || ')');
  end if;

  select count(*) into v_n from disputes
    where status = 'open' and created_at < now() - interval '7 days';
  if v_n > 0 then
    v_keys := array_append(v_keys, 'disputes_open_old');
    v_texts := array_append(v_texts, 'ရက် ၇ ရက်ကျော် ဖွင့်ထားဆဲ အငြင်းပွားမှု ' || v_n || ' ခု ရှိပါသည်');
  end if;

  select count(*) into v_n from daily_entries
    where unit_price is not null and amount <> delivered_qty * unit_price;
  if v_n > 0 then
    v_keys := array_append(v_keys, 'amount_mismatch');
    v_texts := array_append(v_texts, 'ပမာဏ မကိုက်ညီသော ရေပို့စာရင်း ' || v_n || ' ခု ရှိပါသည်');
  end if;

  -- Forget issues that have cleared, so a recurrence alerts afresh.
  delete from dq_seen where not (issue_key = any (v_keys));

  -- Keep only issues never alerted before.
  for i in 1 .. coalesce(array_length(v_keys, 1), 0) loop
    if not exists (select 1 from dq_seen where issue_key = v_keys[i]) then
      v_new_keys := array_append(v_new_keys, v_keys[i]);
      v_new_texts := array_append(v_new_texts, v_texts[i]);
    end if;
  end loop;

  if array_length(v_new_keys, 1) is null then
    return;
  end if;

  insert into dq_seen (issue_key)
  select unnest(v_new_keys)
  on conflict (issue_key) do nothing;

  v_body := array_to_string(v_new_texts, ' ');

  for v_recip in select om_recipients(null) loop
    if exists (select 1 from notifications
               where user_id = v_recip and tag = 'dq-' || v_today) then
      continue;
    end if;
    perform insert_notification(v_recip, 'data_quality',
      'Data စစ်ဆေးမှု သတိပေးချက်', v_body, '/data-quality', 'high',
      'dq-' || v_today);
  end loop;
end $$;
-- 0016 --
-- 0016_live_parity_schema.sql — Live-parity gap wave (schema only).
-- * agents.trip_qty (တစ်ခါပို့ ဘူးအရေအတွက် — bottles per trip) + agents.notes.
-- * agent_payments.kind: 'regular' vs 'old_debt' (ကြွေးဟောင်းကောက်ငွေ entries
--   are a separate form in the old app; the rebuild tags them instead).
-- * notify_prefs: per-topic alert toggles (old app settings had 4 toggles).
-- * app_settings is key/value (0001), so debt_alert_days is a new KEY,
--   not a column: the debt-age threshold (days) for aging alerts.
-- * inventory_movements: 'adjust' must be an allowed kind — 0006 already
--   extended the check, so the block below only rebuilds it if missing.

alter table public.agents
  add column if not exists trip_qty integer not null default 0;
alter table public.agents
  add column if not exists notes text;

alter table public.agent_payments
  add column if not exists kind text not null default 'regular';
do $$ begin
  alter table public.agent_payments
    add constraint agent_payments_kind_check
    check (kind in ('regular', 'old_debt'));
exception when duplicate_object then null; end $$;

alter table public.notify_prefs
  add column if not exists alert_old_debt   boolean not null default true;
alter table public.notify_prefs
  add column if not exists alert_digest     boolean not null default true;
alter table public.notify_prefs
  add column if not exists alert_stock      boolean not null default true;
alter table public.notify_prefs
  add column if not exists alert_collection boolean not null default true;

insert into public.app_settings (key, value)
values ('debt_alert_days', '30'::jsonb)
on conflict (key) do nothing;

do $$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.inventory_movements'::regclass
     and conname = 'inventory_movements_kind_check';
  if v_def is null or position('adjust' in v_def) = 0 then
    alter table public.inventory_movements
      drop constraint if exists inventory_movements_kind_check;
    alter table public.inventory_movements
      add constraint inventory_movements_kind_check
      check (kind in ('produce', 'purchase', 'damage', 'in', 'out', 'adjust'));
  end if;
end $$;

-- 0017 --
-- 0017_collection_anomaly_prefs.sql — Live-parity gap wave (alerts).
-- 1) run_data_quality_alerts(): everything from 0015 preserved (same three
--    aggregate checks, same dq_seen issue-level dedupe, same per-day tag),
--    plus a collection-anomaly check: per collector (agent_payments
--    .created_by), for yesterday and today (Yangon), flag when the day's
--    collection total is (a) >= 3x their trailing-7-day daily average and
--    >= 100,000 MMK, or (b) >= 1.5x their previous-day total and
--    >= 100,000 MMK. Each flag notifies OM users as its own data_quality
--    notification (tag 'dqcoll-<collector>-<date>'), deduped via dq_seen
--    key 'collection_anomaly:<collector>:<date>'.
-- 2) notify_prefs honoured conservatively: alert_digest=false skips the
--    evening digest; alert_collection=false skips collection-anomaly
--    alerts; alert_old_debt=false skips old-debt/aging-class data-quality
--    issues (issue classes are tracked from this migration on; all three
--    existing aggregate checks are class 'general'). mode / quiet_night
--    semantics are untouched.

create or replace function send_daily_digest() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Yangon')::date;
  v_bottles int;
  v_sales bigint;
  v_cash bigint;
  v_exp bigint;
  v_outstanding bigint;
  v_body text;
  v_recip uuid;
begin
  select coalesce(sum(delivered_qty), 0), coalesce(sum(amount), 0),
         coalesce(sum(amount_collected), 0)
    into v_bottles, v_sales, v_cash
    from daily_entries where entry_date = v_today;
  select coalesce(sum(amount), 0) into v_exp
    from expenses where expense_date = v_today;
  select coalesce((select sum(amount - amount_collected) from daily_entries), 0)
         - coalesce((select sum(amount) from agent_payments), 0)
    into v_outstanding;

  v_body :=
    'ဒီနေ့ ရေ ' || v_bottles || ' ဘူး ပို့ပြီး, ရောင်းရငွေ '
    || to_char(v_sales, 'FM999,999,999,999') || ' ကျပ်, လက်ခံရငွေ '
    || to_char(v_cash, 'FM999,999,999,999') || ' ကျပ်, ဒီနေ့ ကြွေးတိုး '
    || to_char(v_sales - v_cash, 'FM999,999,999,999') || ' ကျပ်, ကုန်ကျစရိတ် '
    || to_char(v_exp, 'FM999,999,999,999') || ' ကျပ်. ကြွေးကျန် စုစုပေါင်း '
    || to_char(v_outstanding, 'FM999,999,999,999') || ' ကျပ်';

  for v_recip in select om_recipients(null) loop
    if exists (select 1 from notify_prefs
               where user_id = v_recip and mode = 'important') then
      continue;
    end if;
    if exists (select 1 from notify_prefs
               where user_id = v_recip and alert_digest = false) then
      continue;
    end if;
    if exists (select 1 from notifications
               where user_id = v_recip and tag = 'digest-' || v_today) then
      continue;
    end if;
    perform insert_notification(v_recip, 'digest', 'နေ့စဉ် အကျဉ်းချုပ်',
      v_body, '/', 'normal', 'digest-' || v_today);
  end loop;
end $$;

create or replace function run_data_quality_alerts() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Yangon')::date;
  v_keys text[] := '{}';
  v_texts text[] := '{}';
  v_classes text[] := '{}';
  v_new_keys text[] := '{}';
  v_new_texts text[] := '{}';
  v_new_classes text[] := '{}';
  v_anom_keys text[] := '{}';
  v_anom_bodies text[] := '{}';
  v_all_keys text[] := '{}';
  v_last_backup text;
  v_n int;
  v_body text;
  v_recip uuid;
  i int;
begin
  select value #>> '{}' into v_last_backup
    from app_settings where key = 'last_backup_at';
  if v_last_backup is null
     or v_last_backup::timestamptz < now() - interval '7 days' then
    v_keys := array_append(v_keys, 'backup_stale');
    v_texts := array_append(v_texts, 'Backup နောက်ကျနေပါသည် (နောက်ဆုံး backup: '
      || coalesce(v_last_backup, 'မရှိသေး') || ')');
    v_classes := array_append(v_classes, 'general');
  end if;

  select count(*) into v_n from disputes
    where status = 'open' and created_at < now() - interval '7 days';
  if v_n > 0 then
    v_keys := array_append(v_keys, 'disputes_open_old');
    v_texts := array_append(v_texts, 'ရက် ၇ ရက်ကျော် ဖွင့်ထားဆဲ အငြင်းပွားမှု ' || v_n || ' ခု ရှိပါသည်');
    v_classes := array_append(v_classes, 'general');
  end if;

  select count(*) into v_n from daily_entries
    where unit_price is not null and amount <> delivered_qty * unit_price;
  if v_n > 0 then
    v_keys := array_append(v_keys, 'amount_mismatch');
    v_texts := array_append(v_texts, 'ပမာဏ မကိုက်ညီသော ရေပို့စာရင်း ' || v_n || ' ခု ရှိပါသည်');
    v_classes := array_append(v_classes, 'general');
  end if;

  -- Collection anomalies (per collector, yesterday + today, Yangon).
  -- Rule (a) wins when both fire; one flag per collector + day.
  select coalesce(array_agg(k order by k), '{}'),
         coalesce(array_agg(b order by k), '{}')
    into v_anom_keys, v_anom_bodies
    from (
      select 'collection_anomaly:' || e.collector || ':' || e.d as k,
             case when e.flag = 'a'
                  then e.who || ' သည် ပုံမှန်ထက် ၃ ဆပိုများသော ငွေကို ကောက်ခံခဲ့သည်'
                  else e.who || ' ကောက်ခံသောငွေသည် ယမန်နေ့၏ '
                       || round(e.day_total * 100.0 / e.prev_total)::int
                       || '% ရှိသည်'
             end as b
        from (
          select t.collector, t.d, t.day_total,
                 coalesce((select sum(p2.amount) / 7.0 from agent_payments p2
                            where p2.created_by = t.collector
                              and p2.payment_date >= t.d - 7
                              and p2.payment_date <  t.d), 0) as avg7,
                 coalesce((select sum(p3.amount) from agent_payments p3
                            where p3.created_by = t.collector
                              and p3.payment_date = t.d - 1), 0) as prev_total,
                 coalesce(nullif(pr.display_name, ''), pr.username) as who,
                 case
                   when t.day_total >= 100000
                        and t.day_total >= 3 * coalesce(
                              (select sum(p2.amount) / 7.0 from agent_payments p2
                                where p2.created_by = t.collector
                                  and p2.payment_date >= t.d - 7
                                  and p2.payment_date <  t.d), 0)
                     then 'a'
                   when t.day_total >= 100000
                        and coalesce((select sum(p3.amount) from agent_payments p3
                                       where p3.created_by = t.collector
                                         and p3.payment_date = t.d - 1), 0) > 0
                        and t.day_total >= 1.5 * (select sum(p3.amount) from agent_payments p3
                                                    where p3.created_by = t.collector
                                                      and p3.payment_date = t.d - 1)
                     then 'b'
                 end as flag
            from (
              select p.created_by as collector, p.payment_date as d,
                     sum(p.amount) as day_total
                from agent_payments p
               where p.created_by is not null
                 and p.payment_date in (v_today, v_today - 1)
               group by p.created_by, p.payment_date
            ) t
            join profiles pr on pr.id = t.collector
        ) e
       where e.flag is not null
    ) s;

  v_all_keys := v_keys || v_anom_keys;

  -- Forget issues that have cleared, so a recurrence alerts afresh.
  delete from dq_seen where not (issue_key = any (v_all_keys));

  -- Collection-anomaly notifications: first appearance only (dq_seen),
  -- one per flag, skipped for users with alert_collection = false.
  for i in 1 .. coalesce(array_length(v_anom_keys, 1), 0) loop
    if exists (select 1 from dq_seen where issue_key = v_anom_keys[i]) then
      continue;
    end if;
    insert into dq_seen (issue_key) values (v_anom_keys[i])
    on conflict (issue_key) do nothing;
    for v_recip in select om_recipients(null) loop
      if exists (select 1 from notify_prefs
                  where user_id = v_recip and alert_collection = false) then
        continue;
      end if;
      if exists (select 1 from notifications
                  where user_id = v_recip
                    and tag = 'dqcoll-'
                      || split_part(v_anom_keys[i], ':', 2) || '-'
                      || split_part(v_anom_keys[i], ':', 3)) then
        continue;
      end if;
      perform insert_notification(v_recip, 'data_quality',
        'Data စစ်ဆေးမှု သတိပေးချက်', v_anom_bodies[i], '/data-quality', 'high',
        'dqcoll-' || split_part(v_anom_keys[i], ':', 2) || '-'
          || split_part(v_anom_keys[i], ':', 3));
    end loop;
  end loop;

  -- Keep only aggregate issues never alerted before.
  for i in 1 .. coalesce(array_length(v_keys, 1), 0) loop
    if not exists (select 1 from dq_seen where issue_key = v_keys[i]) then
      v_new_keys := array_append(v_new_keys, v_keys[i]);
      v_new_texts := array_append(v_new_texts, v_texts[i]);
      v_new_classes := array_append(v_new_classes, v_classes[i]);
    end if;
  end loop;

  if array_length(v_new_keys, 1) is null then
    return;
  end if;

  insert into dq_seen (issue_key)
  select unnest(v_new_keys)
  on conflict (issue_key) do nothing;

  for v_recip in select om_recipients(null) loop
    if exists (select 1 from notifications
               where user_id = v_recip and tag = 'dq-' || v_today) then
      continue;
    end if;
    -- Compose this recipient's body from the issue classes they accept.
    v_body := null;
    for i in 1 .. coalesce(array_length(v_new_keys, 1), 0) loop
      if v_new_classes[i] = 'old_debt'
         and exists (select 1 from notify_prefs
                      where user_id = v_recip and alert_old_debt = false) then
        continue;
      end if;
      v_body := concat_ws(' ', v_body, v_new_texts[i]);
    end loop;
    if v_body is null then
      continue;
    end if;
    perform insert_notification(v_recip, 'data_quality',
      'Data စစ်ဆေးမှု သတိပေးချက်', v_body, '/data-quality', 'high',
      'dq-' || v_today);
  end loop;
end $$;
