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
