-- 19_staff_own_visibility.sql — migration 0046 (owner decision
-- 2026-11-20, variant 2): a staff user SELECTs only their own records
-- on daily_entries and agent_payments — rows they created OR rows
-- where they are the named receiver (received_by, 0041). Before 0046
-- both SELECT policies were `is_staff_plus() or agent_id =
-- app_agent_id()` (0002): every staff account could read every other
-- staff member's records.
--
-- Identities: staff A = t_staff 3333…, staff B = t_paystaff 6666…
-- (both primary-role staff), manager 2222…, agent A login 4444…
-- (→ agent aaaaaaaa…), agent B login 5555… (→ agent bbbbbbbb…).
-- Counts are read INSIDE the simulated role (visibility is the thing
-- being tested), with reset role before the rollback.
--
-- Planted rows (all for agent A, all today):
--   entry  …001  created by A, received_by NULL   → A only
--   entry  …002  created by A, received_by = B    → A and B
--   entry  …005  created by B, received_by NULL   → B only
--   payment…003  created by A, received_by NULL   → A only
--   payment…004  created by A, received_by = B    → A and B
--   payment…006  created by B, received_by NULL   → B only
-- The committed fixture rows (5 entries, 1 payment) all carry
-- created_by/received_by NULL — under 0046 they are OM-only, so each
-- staff member's TOTAL visible count below is exactly their planted
-- rows. That is asserted deliberately: unattributed rows must not
-- leak into a staff list.

-- The two SELECT policies carry the new branches.
select testkit.assert_true(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and policyname in ('entries_select', 'payments_select')
      and qual like '%created_by%' and qual like '%received_by%'
      and qual like '%app_agent_id%') = 2,
  '0046: both select policies carry created_by/received_by + agent branch');

begin;
set local role authenticated;

-- Staff A plants two entries + two payments (one naming B receiver).
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('e2000000-0000-4000-8000-000000000001',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, 0, 0, null),
       ('e2000000-0000-4000-8000-000000000002',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, 0, 0,
        '66666666-6666-4666-8666-666666666666');
insert into agent_payments (id, payment_date, agent_id, amount, method, received_by)
values ('e2000000-0000-4000-8000-000000000003',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 4000, 'cash', null),
       ('e2000000-0000-4000-8000-000000000004',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5000, 'cash',
        '66666666-6666-4666-8666-666666666666');

-- Staff B plants one entry + one payment of their own.
select set_config('request.jwt.claims', '{"sub":"66666666-6666-4666-8666-666666666666"}', true);
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('e2000000-0000-4000-8000-000000000005',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 0, 0, null);
insert into agent_payments (id, payment_date, agent_id, amount, method, received_by)
values ('e2000000-0000-4000-8000-000000000006',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1000, 'cash', null);

-- Staff B's view: own rows + the two rows naming B as receiver;
-- staff A's plain rows and every unattributed fixture row invisible.
select testkit.assert_true(
  (select count(*) from daily_entries) = 2,
  'staff B sees exactly 2 entries (own + received)');
select testkit.assert_true(
  (select count(*) from daily_entries
    where id in ('e2000000-0000-4000-8000-000000000002',
                 'e2000000-0000-4000-8000-000000000005')) = 2,
  'staff B sees the received_by entry and their own entry');
select testkit.assert_true(
  (select count(*) from daily_entries
    where id = 'e2000000-0000-4000-8000-000000000001') = 0,
  'staff B sees 0 of staff A plain entries');
select testkit.assert_true(
  (select count(*) from agent_payments) = 2,
  'staff B sees exactly 2 payments (own + received)');
select testkit.assert_true(
  (select count(*) from agent_payments
    where id in ('e2000000-0000-4000-8000-000000000004',
                 'e2000000-0000-4000-8000-000000000006')) = 2,
  'staff B sees the received_by payment and their own payment');
select testkit.assert_true(
  (select count(*) from agent_payments
    where id = 'e2000000-0000-4000-8000-000000000003') = 0,
  'staff B sees 0 of staff A plain payments');

-- Staff A's view: everything A created (incl. the rows naming B as
-- receiver — the typist keeps sight of their own record); B's own
-- rows invisible.
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_true(
  (select count(*) from daily_entries) = 2,
  'staff A sees exactly their 2 created entries');
select testkit.assert_true(
  (select count(*) from daily_entries
    where id = 'e2000000-0000-4000-8000-000000000005') = 0,
  'staff A sees 0 of staff B entries');
select testkit.assert_true(
  (select count(*) from agent_payments) = 2,
  'staff A sees exactly their 2 created payments');
select testkit.assert_true(
  (select count(*) from agent_payments
    where id = 'e2000000-0000-4000-8000-000000000006') = 0,
  'staff A sees 0 of staff B payments');

-- Manager (OM): everything — 5 fixture + 3 planted entries,
-- 1 fixture + 3 planted payments.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
select testkit.assert_true(
  (select count(*) from daily_entries) = 8,
  'manager sees all 8 entries');
select testkit.assert_true(
  (select count(*) from agent_payments) = 4,
  'manager sees all 4 payments');

-- Agent equivalence: under the OLD policy a pure agent's visible set
-- was exactly `agent_id = app_agent_id()` (is_staff_plus() is false
-- for them). Agent A must still see precisely agent A's rows: the 3
-- fixture entries (today, yesterday, locked month) + the 3 planted
-- ones = 6, and 0 rows of any other agent; payments 1 fixture + 3
-- planted = 4.
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_true(
  (select count(*) from daily_entries) = 6,
  'agent A sees exactly agent A entries (old-policy set, unchanged)');
select testkit.assert_true(
  (select count(*) from daily_entries
    where agent_id <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 0,
  'agent A sees 0 entries of other agents');
select testkit.assert_true(
  (select count(*) from agent_payments) = 4,
  'agent A sees exactly agent A payments (old-policy set, unchanged)');
select testkit.assert_true(
  (select count(*) from agent_payments
    where agent_id <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 0,
  'agent A sees 0 payments of other agents');

-- Agent B: only their own fixture entry, no payments — unchanged.
select set_config('request.jwt.claims', '{"sub":"55555555-5555-4555-8555-555555555555"}', true);
select testkit.assert_true(
  (select count(*) from daily_entries) = 1,
  'agent B sees exactly their 1 fixture entry');
select testkit.assert_true(
  (select count(*) from agent_payments) = 0,
  'agent B sees 0 payments');

rollback;
reset role;

select '19_staff_own_visibility: all assertions passed';
