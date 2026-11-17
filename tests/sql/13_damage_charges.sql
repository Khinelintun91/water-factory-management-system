-- 13_damage_charges.sql — migration 0042: owner-priced damage items +
-- per-agent damage charges that count into agent_outstanding().
--   * A charge SNAPSHOTS item name + unit price from the item row at
--     insert time (trigger-side; client-sent values are overwritten) and
--     stores total = qty × snapshot price. A later price change never
--     rewrites an existing charge.
--   * agent_outstanding() = entries due − collected − payments
--     − write-offs + Σ damage charges.
--   * Inactive items cannot be charged ('damage_item_inactive').
--   * Writes are owner-only: staff AND manager charge inserts fail RLS;
--     item insert/update is owner-only; items have no delete path.
--   * Reads: owner/manager see all items + all charges; an agent sees
--     ACTIVE items only and only their own charges.
--   * The agent's linked user gets a 'receipt' notification naming the
--     charge; an unlinked agent gets none. Side-effect counts are read
--     AFTER `reset role` (notifications RLS hides other users' rows
--     under a simulated role).
--
-- Fixture baseline for agent A (aaaaaaaa-…): outstanding 1350
-- (entries 600 + 600 + 300, one payment 100, one write-off 50 —
-- the same baseline tests/sql/07 asserts).

-- --------------------------------------------------------------------
-- Snapshots, totals, price-change isolation, outstanding math.
-- --------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
insert into damage_items (id, name, unit_price) values
  ('da110000-0000-4000-8000-000000000001', 'အဖုံး', 500),
  ('da110000-0000-4000-8000-000000000002', 'ရေတပ်ခေါင်း', 3500);
-- Client sends WRONG snapshots + total on purpose: the trigger must
-- overwrite all three from the item row.
insert into agent_damage_charges (agent_id, item_id, item_name, unit_price, qty, total)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'da110000-0000-4000-8000-000000000001', 'WRONG', 999, 2, 1);
reset role;
select testkit.assert_true(
  (select item_name from agent_damage_charges
    where agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 'အဖုံး',
  'snapshot: item_name comes from the item row, not the client');
select testkit.assert_true(
  (select unit_price from agent_damage_charges
    where agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 500,
  'snapshot: unit_price comes from the item row, not the client');
select testkit.assert_true(
  (select total from agent_damage_charges
    where agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 1000,
  'total stored as qty × snapshot price (2 × 500)');
select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 1350 + 1000,
  'outstanding includes the damage charge (fixture 1350 + charge 1000)');

-- Price change AFTER the charge: history is frozen; new charges use
-- the new price.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
update damage_items set unit_price = 900
 where id = 'da110000-0000-4000-8000-000000000001';
insert into agent_damage_charges (agent_id, item_id, item_name, unit_price, qty, total)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'da110000-0000-4000-8000-000000000001', 'x', 1, 1, 1);
reset role;
select testkit.assert_true(
  (select count(*) from agent_damage_charges
    where agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and unit_price = 500 and total = 1000) = 1,
  'price change does not rewrite the earlier charge snapshot/total');
select testkit.assert_true(
  (select count(*) from agent_damage_charges
    where agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and unit_price = 900 and total = 900) = 1,
  'a new charge snapshots the NEW price');
select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 1350 + 1000 + 900,
  'outstanding sums all charges');
rollback;
reset role;

-- --------------------------------------------------------------------
-- Inactive item cannot be charged; unknown item is rejected.
-- --------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
insert into damage_items (id, name, unit_price, active) values
  ('da110000-0000-4000-8000-000000000001', 'အဖုံး', 500, false);
select testkit.assert_error('damage_item_inactive',
  'insert into agent_damage_charges (agent_id, item_id, item_name, unit_price, qty, total)
   values (''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'',
           ''da110000-0000-4000-8000-000000000001'', ''x'', 1, 1, 1)');
select testkit.assert_error('damage_item_not_found',
  'insert into agent_damage_charges (agent_id, item_id, item_name, unit_price, qty, total)
   values (''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'',
           ''da110000-0000-4000-8000-000000000099'', ''x'', 1, 1, 1)');
rollback;
reset role;

-- --------------------------------------------------------------------
-- Writes are owner-only: staff and manager inserts fail (RLS); item
-- writes are owner-only too; the owner succeeds (control).
-- --------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
insert into damage_items (id, name, unit_price) values
  ('da110000-0000-4000-8000-000000000001', 'အဖုံး', 500);
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_error('',
  'insert into agent_damage_charges (agent_id, item_id, item_name, unit_price, qty, total)
   values (''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'',
           ''da110000-0000-4000-8000-000000000001'', ''x'', 1, 1, 1)');
select testkit.assert_error('',
  'insert into damage_items (name, unit_price) values (''ခိုးထည့်'', 1)');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
select testkit.assert_error('',
  'insert into agent_damage_charges (agent_id, item_id, item_name, unit_price, qty, total)
   values (''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'',
           ''da110000-0000-4000-8000-000000000001'', ''x'', 1, 1, 1)');
-- An UPDATE the role may not perform is not an error under RLS — the
-- row is simply invisible, so nothing changes. Assert the no-op.
update damage_items set unit_price = 1
 where id = 'da110000-0000-4000-8000-000000000001';
reset role;
select testkit.assert_true(
  (select unit_price from damage_items
    where id = 'da110000-0000-4000-8000-000000000001') = 500,
  'manager item update is a silent no-op under RLS (price unchanged)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
insert into agent_damage_charges (agent_id, item_id, item_name, unit_price, qty, total)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'da110000-0000-4000-8000-000000000001', 'x', 1, 1, 1);
reset role;
select testkit.assert_true(
  (select count(*) from agent_damage_charges
    where agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 1,
  'owner charge insert succeeds (control: exactly one row landed)');
rollback;
reset role;

-- --------------------------------------------------------------------
-- Reads: agent sees ACTIVE items only + only own charges; manager
-- sees everything.
-- --------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
insert into damage_items (id, name, unit_price, active) values
  ('da110000-0000-4000-8000-000000000001', 'အဖုံး', 500, true),
  ('da110000-0000-4000-8000-000000000002', 'ရေတပ်ခေါင်း', 3500, false);
insert into agent_damage_charges (agent_id, item_id, item_name, unit_price, qty, total) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'da110000-0000-4000-8000-000000000001', 'x', 1, 1, 1),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'da110000-0000-4000-8000-000000000001', 'x', 1, 1, 1);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_true(
  (select count(*) from damage_items) = 1
  and (select name from damage_items) = 'အဖုံး',
  'agent sees ACTIVE items only (the inactive tap is hidden by RLS)');
select testkit.assert_true(
  (select count(*) from agent_damage_charges) = 1
  and (select agent_id from agent_damage_charges)
      = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'agent sees only their own charges, never another agent''s');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
select testkit.assert_true(
  (select count(*) from damage_items) = 2,
  'manager sees all items including inactive');
select testkit.assert_true(
  (select count(*) from agent_damage_charges) = 2,
  'manager sees all agents'' charges');
rollback;
reset role;

-- --------------------------------------------------------------------
-- Notification: linked agent gets the receipt naming the charge;
-- unlinked agent C gets none.
-- --------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
insert into damage_items (id, name, unit_price) values
  ('da110000-0000-4000-8000-000000000001', 'အဖုံး', 500),
  ('da110000-0000-4000-8000-000000000002', 'အထူး ပစ္စည်း', 700);
insert into agent_damage_charges (agent_id, item_id, item_name, unit_price, qty, total)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'da110000-0000-4000-8000-000000000001', 'x', 1, 2, 1);
insert into agent_damage_charges (agent_id, item_id, item_name, unit_price, qty, total)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'da110000-0000-4000-8000-000000000002', 'x', 1, 1, 1);
reset role;
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '44444444-4444-4444-8444-444444444444'
             and kind = 'receipt'
             and body = 'ပျက်စီးမှု စရိတ် 1,000 ကျပ် မှတ်တမ်းတင်ထားပါတယ် — အဖုံး × 2'),
  'linked agent is notified with the charge total, item and qty');
select testkit.assert_true(
  (select count(*) from notifications
    where tag like 'damage:cccccccc-cccc-4ccc-8ccc-cccccccccccc:%') = 0,
  'unlinked agent (no login) produces no damage notification');
rollback;
reset role;

select '13_damage_charges: all assertions passed';
