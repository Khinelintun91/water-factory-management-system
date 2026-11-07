-- tests/fixture.sql — deterministic fixture for the SQL test suite.
-- Fixed UUIDs so test files can hard-code identities. Loaded by the
-- runner as the database owner AFTER apply_all.sql + post-grants.sql,
-- and COMMITTED (each test file wraps its own work in begin/rollback).
--
-- Historical rows (yesterday / locked month) are loaded with
-- session_replication_role = 'replica', which disables triggers: the
-- date guards would (correctly) refuse backdated inserts, and the
-- audit trigger would pollute the very tables the tests inspect. This
-- is baseline-data construction, the same trick scripts/restore-
-- import.mjs uses; it never happens in the tests themselves.
--
-- Identities
--   owner     11111111-…  primary owner (the fixture's only owner)
--   manager   22222222-…  primary manager
--   staff     33333333-…  primary staff
--   agentA    44444444-…  agent login → agent A (aaaaaaaa-…)
--   agentB    55555555-…  agent login → agent B (bbbbbbbb-…)
--   paystaff  66666666-…  staff, payroll golden case 2 (salary 300,000)
--   paystaff2 77777777-…  staff, payroll golden case 1 (salary 320,000)
-- Agents
--   A aaaaaaaa-… price 300, no deposit/limits
--   B bbbbbbbb-… price 300, no deposit/limits
--   C cccccccc-… price 300, deposit 1,000/bottle, 10 deposit bottles,
--                one entry 10 out / 0 in / 3,000 collected → outstanding 0
--                (the finalize_closeout golden fixture)

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 't_owner@waterfactory.local'),
  ('22222222-2222-4222-8222-222222222222', 't_manager@waterfactory.local'),
  ('33333333-3333-4333-8333-333333333333', 't_staff@waterfactory.local'),
  ('44444444-4444-4444-8444-444444444444', 't_agenta@waterfactory.local'),
  ('55555555-5555-4555-8555-555555555555', 't_agentb@waterfactory.local'),
  ('66666666-6666-4666-8666-666666666666', 't_paystaff@waterfactory.local'),
  ('77777777-7777-4777-8777-777777777777', 't_paystaff2@waterfactory.local');

insert into agents (id, code, name, default_unit_price, deposit_per_bottle) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'T01', 'Test Agent A', 300, 0),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'T02', 'Test Agent B', 300, 0),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'T03', 'Test Agent C', 300, 1000);

insert into profiles (id, username, role, agent_id) values
  ('11111111-1111-4111-8111-111111111111', 't_owner',   'owner',   null),
  ('22222222-2222-4222-8222-222222222222', 't_manager', 'manager', null),
  ('33333333-3333-4333-8333-333333333333', 't_staff',   'staff',   null),
  ('44444444-4444-4444-8444-444444444444', 't_agenta',  'agent',   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('55555555-5555-4555-8555-555555555555', 't_agentb',  'agent',   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('66666666-6666-4666-8666-666666666666', 't_paystaff',  'staff', null),
  ('77777777-7777-4777-8777-777777777777', 't_paystaff2', 'staff', null);

insert into agent_contacts (agent_id, phone) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '09000000001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '09000000002');

insert into expense_categories (id, name) values
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Test category');

insert into salary_settings (user_id, monthly_salary) values
  ('66666666-6666-4666-8666-666666666666', 300000),
  ('77777777-7777-4777-8777-777777777777', 320000);

-- Payroll golden fixtures for the CURRENT Yangon month (dates today, so
-- the insert guards pass without bypassing anything).
insert into bonuses (user_id, month, amount) values
  ('66666666-6666-4666-8666-666666666666',
   to_char(now() at time zone 'Asia/Yangon', 'YYYY-MM'), 20000);
insert into advances (user_id, amount, installment) values
  ('66666666-6666-4666-8666-666666666666', 30000, 0);

-- Agent C close-out fixtures (deposit first: the entry guard checks
-- deposit coverage at insert time).
insert into agent_deposits (agent_id, bottles, price_per_bottle, amount) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 10, 1000, 10000);
insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 10, 0, 3000);

-- One entry today for A and for B (isolation tests).
insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 0, 0),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 3, 0, 0);

-- January 2020 is a locked month.
insert into month_locks (month, locked_by) values
  ('2020-01-01', '11111111-1111-4111-8111-111111111111');

-- Historical rows (triggers disabled — see header).
set session_replication_role = 'replica';

insert into daily_entries (id, entry_date, agent_id, delivered_qty, returned_qty, unit_price, amount, amount_collected, created_at) values
  ('e0000000-0000-4000-8000-000000000001',
   ((now() at time zone 'Asia/Yangon')::date - 1),
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 0, 300, 600, 0, now() - interval '1 day'),
  ('e0000000-0000-4000-8000-000000000002',
   date '2020-01-15',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 0, 300, 300, 0, timestamptz '2020-01-15 10:00:00+06:30');

insert into agent_payments (id, payment_date, agent_id, amount, created_at) values
  ('e0000000-0000-4000-8000-000000000003',
   ((now() at time zone 'Asia/Yangon')::date - 1),
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 100, now() - interval '1 day');

insert into expenses (id, expense_date, category_id, title, amount, created_at) values
  ('e0000000-0000-4000-8000-000000000004',
   ((now() at time zone 'Asia/Yangon')::date - 1),
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Old expense', 500, now() - interval '1 day');

insert into write_offs (id, writeoff_date, agent_id, amount, note, created_at) values
  ('e0000000-0000-4000-8000-000000000005',
   ((now() at time zone 'Asia/Yangon')::date - 1),
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 50, 'fixture write-off', now() - interval '1 day');

insert into agent_deposits (id, deposit_date, agent_id, bottles, price_per_bottle, amount, created_at) values
  ('e0000000-0000-4000-8000-000000000006',
   ((now() at time zone 'Asia/Yangon')::date - 1),
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, 1000, 5000, now() - interval '1 day');

-- (Owned by t_staff, deliberately NOT a payroll-fixture user: a stray
-- advance here would leak into the pay_month golden deduction.)
insert into advances (id, user_id, advance_date, amount, installment, created_at) values
  ('e0000000-0000-4000-8000-000000000007',
   '33333333-3333-4333-8333-333333333333',
   ((now() at time zone 'Asia/Yangon')::date - 1), 1000, 0, now() - interval '1 day');

insert into cash_handovers (id, handover_date, employee_id, expected, received, created_at) values
  ('e0000000-0000-4000-8000-000000000008',
   ((now() at time zone 'Asia/Yangon')::date - 1),
   '66666666-6666-4666-8666-666666666666', 100, 100, now() - interval '1 day');

set session_replication_role = 'origin';
