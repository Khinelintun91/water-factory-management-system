-- 11_card_tier_thresholds.sql — my_card_tier() after migration 0040:
-- the wallet-face tier is a pure function of the CALLER's own lifetime
-- sales (sum of daily_entries.amount) with fixed thresholds —
--   >= 20,000,000 → gold, >= 10,000,000 → white, below → black —
-- and the function returns ONLY the caller's tier + own total, never
-- another agent's figures (no rank/count any more).
--
-- Everything runs in ONE begin/rollback block: the seeded threshold
-- agents must be visible to every caller scenario, so the seeds and
-- the role switches share a transaction (roles are re-set per caller;
-- counts are read while the simulated role is active).
begin;

-- Seed: four agent logins whose lifetime sales sit exactly on the
-- rule's boundaries. Entries are loaded with triggers disabled (the
-- fixture's replica trick) so the amounts are exact.
insert into auth.users (id, email) values
  ('f1000000-0000-4000-8000-000000000001', 't_tier1@waterfactory.local'),
  ('f1000000-0000-4000-8000-000000000002', 't_tier2@waterfactory.local'),
  ('f1000000-0000-4000-8000-000000000003', 't_tier3@waterfactory.local'),
  ('f1000000-0000-4000-8000-000000000004', 't_tier4@waterfactory.local');

insert into agents (id, code, name, default_unit_price, deposit_per_bottle) values
  ('f0000000-0000-4000-8000-000000000001', 'T11', 'Tier Under', 300, 0),
  ('f0000000-0000-4000-8000-000000000002', 'T12', 'Tier White Min', 300, 0),
  ('f0000000-0000-4000-8000-000000000003', 'T13', 'Tier White Max', 300, 0),
  ('f0000000-0000-4000-8000-000000000004', 'T14', 'Tier Gold Min', 300, 0);

insert into profiles (id, username, role, agent_id) values
  ('f1000000-0000-4000-8000-000000000001', 't_tier1', 'agent', 'f0000000-0000-4000-8000-000000000001'),
  ('f1000000-0000-4000-8000-000000000002', 't_tier2', 'agent', 'f0000000-0000-4000-8000-000000000002'),
  ('f1000000-0000-4000-8000-000000000003', 't_tier3', 'agent', 'f0000000-0000-4000-8000-000000000003'),
  ('f1000000-0000-4000-8000-000000000004', 't_tier4', 'agent', 'f0000000-0000-4000-8000-000000000004');

set session_replication_role = 'replica';
insert into daily_entries (id, entry_date, agent_id, delivered_qty, returned_qty, unit_price, amount, amount_collected, created_at) values
  ('e1000000-0000-4000-8000-000000000001', date '2025-06-15', 'f0000000-0000-4000-8000-000000000001', 1, 0, 9999999, 9999999, 0, timestamptz '2025-06-15 10:00:00+06:30'),
  ('e1000000-0000-4000-8000-000000000002', date '2025-06-15', 'f0000000-0000-4000-8000-000000000002', 1, 0, 10000000, 10000000, 0, timestamptz '2025-06-15 10:00:00+06:30'),
  ('e1000000-0000-4000-8000-000000000003', date '2025-06-15', 'f0000000-0000-4000-8000-000000000003', 1, 0, 19999999, 19999999, 0, timestamptz '2025-06-15 10:00:00+06:30'),
  ('e1000000-0000-4000-8000-000000000004', date '2025-06-15', 'f0000000-0000-4000-8000-000000000004', 1, 0, 20000000, 20000000, 0, timestamptz '2025-06-15 10:00:00+06:30');
set session_replication_role = 'origin';

-- 9,999,999 (just under the white threshold) → black, own total only.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001"}', true);
select testkit.assert_true(
  (select count(*) from my_card_tier()) = 1, 'tier caller gets exactly one row');
select testkit.assert_true(
  (select tier from my_card_tier()) = 'black', 'sales 9,999,999 is black');
select testkit.assert_true(
  (select lifetime_sales from my_card_tier()) = 9999999, 'lifetime_sales is the caller own total');
reset role;

-- Exactly 10,000,000 → white (lower bound is inclusive).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000002"}', true);
select testkit.assert_true(
  (select tier from my_card_tier()) = 'white', 'sales 10,000,000 is white');
select testkit.assert_true(
  (select lifetime_sales from my_card_tier()) = 10000000, 'white-min caller total');
reset role;

-- 19,999,999 (just under the gold threshold) → still white.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000003"}', true);
select testkit.assert_true(
  (select tier from my_card_tier()) = 'white', 'sales 19,999,999 is white');
select testkit.assert_true(
  (select lifetime_sales from my_card_tier()) = 19999999, 'white-max caller total');
reset role;

-- Exactly 20,000,000 → gold. The other seeded agents hold ~50,000,000
-- combined, so an exact 20,000,000 here also proves the result carries
-- ONLY the caller's own figures.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000004"}', true);
select testkit.assert_true(
  (select tier from my_card_tier()) = 'gold', 'sales 20,000,000 is gold');
select testkit.assert_true(
  (select lifetime_sales from my_card_tier()) = 20000000, 'gold caller sees only their own total');
reset role;

-- Fixture agent A (small real sales) → black, and the reported total
-- equals A's own entries sum as A sees it through RLS.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_true(
  (select tier from my_card_tier()) = 'black', 'fixture agent A is black');
select testkit.assert_true(
  (select lifetime_sales from my_card_tier()) =
    (select coalesce(sum(amount), 0) from daily_entries
      where agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'agent A total matches their own entries');
select testkit.assert_true(
  (select lifetime_sales from my_card_tier()) > 0, 'agent A total is their real sales, not a zero fallback');
reset role;

-- Callers with no linked agent (staff, owner) get no row at all.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_true(
  (select count(*) from my_card_tier()) = 0, 'staff caller gets no tier row');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select testkit.assert_true(
  (select count(*) from my_card_tier()) = 0, 'owner caller gets no tier row');
reset role;

rollback;

select '11_card_tier_thresholds: all assertions passed';
