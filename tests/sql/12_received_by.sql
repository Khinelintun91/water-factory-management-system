-- 12_received_by.sql — migration 0041: cash accountability follows the
-- staff member who physically RECEIVED the money.
--   * daily_entries / agent_payments carry received_by, backfilled from
--     created_by; NULL still allowed and read as "same as created_by".
--   * Agent receipt notifications NAME the receiver when cash moved:
--     payments always; entries only when amount_collected > 0.
--   * staff_directory() is the narrow name bridge for roles that cannot
--     read other profiles (agents, staff): non-agent effective roles
--     only, authenticated-only execute.
-- Side-effect counts are read AFTER `reset role` (the AGENTS.md lesson:
-- notifications RLS hides other users' rows under a simulated role).

-- --------------------------------------------------------------------
-- Columns + backfill semantics (the two UPDATEs below are 0041's,
-- verbatim — the migration itself ran before the fixture loaded, so
-- its backfill is exercised here against planted "legacy" rows).
-- --------------------------------------------------------------------
begin;
select testkit.assert_true(
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'daily_entries'
             and column_name = 'received_by')
  and exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'agent_payments'
             and column_name = 'received_by'),
  'received_by exists on daily_entries and agent_payments');

set session_replication_role = 'replica';
insert into daily_entries (id, entry_date, agent_id, delivered_qty, returned_qty, unit_price, amount, amount_collected, created_by, received_by, created_at) values
  ('e2000000-0000-4000-8000-000000000001', date '2025-06-15', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 0, 300, 300, 300,
   '33333333-3333-4333-8333-333333333333', null, timestamptz '2025-06-15 10:00:00+06:30'),
  ('e2000000-0000-4000-8000-000000000002', date '2025-06-15', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, 0, 300, 300, 300,
   '33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', timestamptz '2025-06-15 10:00:00+06:30');
insert into agent_payments (id, payment_date, agent_id, amount, created_by, received_by, created_at) values
  ('e2000000-0000-4000-8000-000000000003', date '2025-06-15', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 900,
   '22222222-2222-4222-8222-222222222222', null, timestamptz '2025-06-15 10:00:00+06:30'),
  ('e2000000-0000-4000-8000-000000000004', date '2025-06-15', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 800,
   null, null, timestamptz '2025-06-15 10:00:00+06:30');
set session_replication_role = 'origin';

-- 0041's backfill, verbatim (replica mode included: the same-day and
-- month-lock guards reject updates to historical rows by design).
set session_replication_role = 'replica';
update daily_entries  set received_by = created_by
 where received_by is null and created_by is not null;
update agent_payments set received_by = created_by
 where received_by is null and created_by is not null;
set session_replication_role = 'origin';

select testkit.assert_true(
  (select received_by from daily_entries where id = 'e2000000-0000-4000-8000-000000000001')
    = '33333333-3333-4333-8333-333333333333',
  'backfill: entry with NULL received_by takes created_by');
select testkit.assert_true(
  (select received_by from daily_entries where id = 'e2000000-0000-4000-8000-000000000002')
    = '22222222-2222-4222-8222-222222222222',
  'backfill: an explicitly different receiver is never overwritten');
select testkit.assert_true(
  (select received_by from agent_payments where id = 'e2000000-0000-4000-8000-000000000003')
    = '22222222-2222-4222-8222-222222222222',
  'backfill: payment with NULL received_by takes created_by');
select testkit.assert_true(
  (select received_by from agent_payments where id = 'e2000000-0000-4000-8000-000000000004') is null,
  'backfill: a row with neither name keeps received_by NULL (read as created_by)');
rollback;

-- --------------------------------------------------------------------
-- Payment insert -> the agent's receipt names BOTH typist and receiver
-- when received_by differs from created_by (0052 M5 anti-framing).
-- (force_insert_attribution stamps created_by = the staff caller; the
-- explicit received_by = manager must survive and be the named person.)
-- --------------------------------------------------------------------
begin;
update profiles set display_name = 'မန်နေဂျာ ဒေါ်မေ'
 where id = '22222222-2222-4222-8222-222222222222';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into agent_payments (payment_date, agent_id, amount, method, received_by)
values ((now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5000, 'cash',
        '22222222-2222-4222-8222-222222222222');
reset role;
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '44444444-4444-4444-8444-444444444444'
             and kind = 'receipt'
             and body = 'ပေးချေငွေ 5,000 ကျပ် · မှတ်တမ်းတင်သူ t_staff · လက်ခံသူ မန်နေဂျာ ဒေါ်မေ'),
  'payment receipt names typist + receiver when received_by <> created_by (0052)');
select testkit.assert_true(
  (select received_by from agent_payments
    where agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and amount = 5000)
    = '22222222-2222-4222-8222-222222222222',
  'the stored payment row keeps the chosen receiver');
rollback;
reset role;

-- --------------------------------------------------------------------
-- Entry WITH cash -> the delivery receipt names the receiver (username
-- fallback: the staff profile has no display_name). Entry with NO cash
-- -> the receipt must not claim a payment/receiver at all.
-- --------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 25, 0, 7500,
        '33333333-3333-4333-8333-333333333333');
insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 0, 0);
reset role;
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '44444444-4444-4444-8444-444444444444'
             and kind = 'receipt'
             and body like '%ပေးချေငွေ 7,500 ကျပ်ကို t_staff လက်ခံပြီး မှတ်တမ်းတင်ပြီးပါပြီ%'),
  'entry-with-cash receipt names the receiver (username fallback)');
select testkit.assert_true(
  (select count(*) from notifications
    where user_id = '44444444-4444-4444-8444-444444444444'
      and kind = 'receipt' and body like '%ပေးချေငွေ%') = 1,
  'the zero-cash entry produced no payment wording (only the cash entry did)');
rollback;
reset role;

-- --------------------------------------------------------------------
-- Unlinked agent (agent C has no login): a payment insert creates the
-- OM notices but NO agent receipt — there is nobody to notify.
-- --------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into agent_payments (payment_date, agent_id, amount, method)
values ((now() at time zone 'Asia/Yangon')::date,
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 6000, 'cash');
reset role;
select testkit.assert_true(
  (select count(*) from notifications where body like '%6,000%') = 2,
  'unlinked agent payment: exactly the two OM notices mention the amount');
select testkit.assert_true(
  (select count(*) from notifications
    where kind = 'receipt' and body like '%6,000%') = 0,
  'unlinked agent payment: no agent receipt is created');
rollback;
reset role;

-- --------------------------------------------------------------------
-- staff_directory() (updated for 0052 D3):
--   * Active staff+ callers get all 5 non-agent fixture users.
--   * Pure agents see ONLY receivers referenced by their own entries/
--     payments via coalesce(received_by, created_by), never the full
--     roster or agent accounts.
--   * Execute stays authenticated-only with no PUBLIC/anon grant.
-- --------------------------------------------------------------------
begin;
update profiles set display_name = 'မန်နေဂျာ ဒေါ်မေ'
 where id = '22222222-2222-4222-8222-222222222222';
set local role authenticated;
-- Active staff sees all 5 non-agent fixture users.
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_true(
  (select count(*) from staff_directory()) = 5,
  'directory lists all five non-agent fixture users for active staff');
select testkit.assert_true(
  not exists (select 1 from staff_directory()
               where id in ('44444444-4444-4444-8444-444444444444',
                            '55555555-5555-4555-8555-555555555555')),
  'directory never lists agent accounts');

-- Plant one entry (received_by NULL -> falls back to created_by = t_staff)
-- and one payment (received_by = manager) for Agent A, then check pure agentA.
insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 0, 600);
insert into agent_payments (payment_date, agent_id, amount, method, received_by)
values ((now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1000, 'cash',
        '22222222-2222-4222-8222-222222222222');

select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_true(
  (select count(*) from staff_directory()) = 2,
  '0052 D3: pure agentA sees only the 2 receivers referenced by own rows');
select testkit.assert_true(
  (select name from staff_directory() where id = '22222222-2222-4222-8222-222222222222')
    = 'မန်နေဂျာ ဒေါ်မေ',
  'directory resolves display_name when set');
select testkit.assert_true(
  (select name from staff_directory() where id = '33333333-3333-4333-8333-333333333333')
    = 't_staff',
  'directory falls back to username (via created_by when received_by is NULL)');
select testkit.assert_true(
  not exists (select 1 from staff_directory()
               where id in ('44444444-4444-4444-8444-444444444444',
                            '55555555-5555-4555-8555-555555555555',
                            '11111111-1111-4111-8111-111111111111')),
  'pure agentA never sees agent accounts or unreferenced staff');
reset role;
select testkit.assert_true(
  has_function_privilege('authenticated', 'public.staff_directory()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.staff_directory()', 'EXECUTE')
  and not exists (
        select 1 from pg_proc p
          join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a on true
         where p.oid = 'public.staff_directory()'::regprocedure
           and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'staff_directory: authenticated kept, PUBLIC and anon revoked');
rollback;
reset role;

select '12_received_by: all assertions passed';
