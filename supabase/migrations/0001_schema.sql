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
