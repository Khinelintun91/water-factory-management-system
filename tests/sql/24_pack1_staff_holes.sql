-- 24_pack1_staff_holes.sql — Migration 0051 (Pack 1): close the 6 proven
-- staff money & data holes in Postgres, plus full regression coverage.
--
-- Fixture identities (tests/fixture.sql):
--   owner    11111111-1111-4111-8111-111111111111
--   manager  22222222-2222-4222-8222-222222222222
--   staff    33333333-3333-4333-8333-333333333333
--   agentA   44444444-4444-4444-8444-444444444444 -> Agent A (aaaaaaaa-…, price 300, baseline outstanding 1350)
--   agentB   55555555-5555-4555-8555-555555555555 -> Agent B (bbbbbbbb-…, price 300)
--   paystaff 66666666-6666-4666-8666-666666666666 (second staff)
--   Agent C  cccccccc-cccc-4ccc-8ccc-cccccccccccc (closeout fixture)

-- =========================================================================
-- 1. ITEM 1 (M2): agent_id detach bypass removed + agent_immutable triggers
-- =========================================================================
begin;

-- Plant historical payments owned by t_staff (yesterday + locked month 2020-01)
-- using replica role just like tests/fixture.sql.
set local session_replication_role = 'replica';
insert into agent_payments (id, payment_date, agent_id, agent_name, amount, created_by, received_by, created_at) values
  ('f1000000-0000-4000-8000-000000000001',
   (now() at time zone 'Asia/Yangon')::date - 1,
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Agent A', 500,
   '33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333',
   now() - interval '1 day'),
  ('f1000000-0000-4000-8000-000000000002',
   date '2020-01-15',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Agent A', 400,
   '33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333',
   timestamptz '2020-01-15 10:00:00+06:30');
set local session_replication_role = 'origin';

-- Staff attempts to null agent_id on yesterday's payment and locked-month payment -> FAIL.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

select testkit.assert_error('agent_immutable',
  $$update agent_payments set agent_id = null where id = 'f1000000-0000-4000-8000-000000000001'$$);
select testkit.assert_error('agent_immutable',
  $$update agent_payments set agent_id = null where id = 'f1000000-0000-4000-8000-000000000002'$$);

-- Staff attempts to switch agent_id on a same-day payment -> FAIL.
insert into agent_payments (id, payment_date, agent_id, amount, method, kind)
values ('f1000000-0000-4000-8000-000000000003',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 250, 'cash', 'regular');
select testkit.assert_error('agent_immutable',
  $$update agent_payments set agent_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
     where id = 'f1000000-0000-4000-8000-000000000003'$$);
select testkit.assert_error('agent_immutable',
  $$update agent_payments set agent_id = null
     where id = 'f1000000-0000-4000-8000-000000000003'$$);

-- Even Owner cannot null agent_id on old payment or change inventory_movements.agent_id.
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select testkit.assert_error('agent_immutable',
  $$update agent_payments set agent_id = null where id = 'f1000000-0000-4000-8000-000000000001'$$);

insert into inventory_movements (id, move_date, agent_id, kind, bottles, notes)
values ('f1000000-0000-4000-8000-000000000004',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'adjust', 5, 'test move');
select testkit.assert_error('agent_immutable',
  $$update inventory_movements set agent_id = null
     where id = 'f1000000-0000-4000-8000-000000000004'$$);
select testkit.assert_error('agent_immutable',
  $$update inventory_movements set agent_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
     where id = 'f1000000-0000-4000-8000-000000000004'$$);

-- Confirm guard_same_day_edit and guard_month_lock themselves reject
-- agent_id -> NULL (tested on write_offs, which has no agent_immutable
-- trigger, proving the cascade bypass is truly gone from both guards).
reset role;
set local session_replication_role = 'replica';
insert into write_offs (id, writeoff_date, agent_id, agent_name, amount, note, created_at)
values ('f1000000-0000-4000-8000-000000000005',
        date '2020-01-15',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Agent A', 50, 'locked wo',
        timestamptz '2020-01-15 10:00:00+06:30');
set local session_replication_role = 'origin';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
-- Fixture write_offs e000…005 was created yesterday -> guard_same_day_edit must fire.
select testkit.assert_error('same_day_only',
  $$update write_offs set agent_id = null where id = 'e0000000-0000-4000-8000-000000000005'$$);
-- Locked-month write_offs f100…005 (2020-01) -> guard_month_lock must fire.
select testkit.assert_error('month_locked',
  $$update write_offs set agent_id = null where id = 'f1000000-0000-4000-8000-000000000005'$$);

reset role;
select testkit.assert_true(
  pg_get_functiondef('public.guard_same_day_edit()'::regprocedure) not ilike '%agent_id%',
  'M2: guard_same_day_edit has no agent_id cascade bypass');
select testkit.assert_true(
  pg_get_functiondef('public.guard_month_lock()'::regprocedure) not ilike '%agent_id%',
  'M2: guard_month_lock has no agent_id cascade bypass');

rollback;
reset role;

-- =========================================================================
-- 2. ITEM 2 (M1+M4): immutable money/date columns, amount > 0,
--    linked-payment protection, credit-limit delete/shrink bypass blocked
-- =========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

-- Staff inserts a same-day delivery + linked payment + standalone payment.
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('f2000000-0000-4000-8000-000000000001',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 0, 3000);
insert into agent_payments (id, payment_date, agent_id, amount, method, kind, source_entry_id)
values ('f2000000-0000-4000-8000-000000000002',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 500, 'cash', 'old_debt',
        'f2000000-0000-4000-8000-000000000001');
insert into agent_payments (id, payment_date, agent_id, amount, method, kind)
values ('f2000000-0000-4000-8000-000000000003',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 300, 'cash', 'regular');

-- M1: daily_entries direct PATCH on unit_price, entry_date, created_at -> FAIL.
select testkit.assert_error('unit_price_immutable',
  $$update daily_entries set unit_price = 0, amount_collected = 0
     where id = 'f2000000-0000-4000-8000-000000000001'$$);
select testkit.assert_error('entry_date_immutable',
  $$update daily_entries set entry_date = (now() at time zone 'Asia/Yangon')::date - 2
     where id = 'f2000000-0000-4000-8000-000000000001'$$);
select testkit.assert_error('created_at_immutable',
  $$update daily_entries set created_at = now() + interval '1 day'
     where id = 'f2000000-0000-4000-8000-000000000001'$$);

-- M4: agent_payments amount <= 0 rejected on INSERT & UPDATE.
select testkit.assert_error('invalid_amount',
  $$insert into agent_payments (payment_date, agent_id, amount)
    values ((now() at time zone 'Asia/Yangon')::date,
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0)$$);
select testkit.assert_error('invalid_amount',
  $$insert into agent_payments (payment_date, agent_id, amount)
    values ((now() at time zone 'Asia/Yangon')::date,
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', -100)$$);
select testkit.assert_error('invalid_amount',
  $$update agent_payments set amount = 0
     where id = 'f2000000-0000-4000-8000-000000000003'$$);

-- M4: agent_payments payment_date, created_at, source_entry_id immutable on UPDATE.
select testkit.assert_error('payment_date_immutable',
  $$update agent_payments set payment_date = (now() at time zone 'Asia/Yangon')::date - 2
     where id = 'f2000000-0000-4000-8000-000000000003'$$);
select testkit.assert_error('created_at_immutable',
  $$update agent_payments set created_at = now() + interval '1 day'
     where id = 'f2000000-0000-4000-8000-000000000003'$$);
select testkit.assert_error('source_entry_immutable',
  $$update agent_payments set source_entry_id = 'f2000000-0000-4000-8000-000000000001'
     where id = 'f2000000-0000-4000-8000-000000000003'$$);

-- M4: direct client UPDATE or DELETE on entry-linked payment -> FAIL (staff AND owner).
select testkit.assert_error('linked_payment_immutable',
  $$update agent_payments set amount = 100
     where id = 'f2000000-0000-4000-8000-000000000002'$$);
select testkit.assert_error('linked_payment_immutable',
  $$update agent_payments set notes = 'tamper'
     where id = 'f2000000-0000-4000-8000-000000000002'$$);
select testkit.assert_error('linked_payment_immutable',
  $$delete from agent_payments
     where id = 'f2000000-0000-4000-8000-000000000002'$$);

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select testkit.assert_error('linked_payment_immutable',
  $$delete from agent_payments
     where id = 'f2000000-0000-4000-8000-000000000002'$$);
select testkit.assert_error('linked_payment_immutable',
  $$update agent_payments set amount = 100
     where id = 'f2000000-0000-4000-8000-000000000002'$$);

rollback;
reset role;

-- Credit-limit delete/shrink bypass sequence (temp payment -> big delivery -> delete/shrink).
begin;
-- Agent A baseline outstanding = 1350. Set credit_limit = 2000.
update agents set credit_limit = 2000
 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

-- Direct big delivery (5 x 300 = 1500, 0 cash) would make 1350 + 1500 = 2850 > 2000 -> blocked.
select testkit.assert_error('credit_limit',
  $$insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, 0, 0)$$);

-- Staff tries the bypass: insert temp payment 1000 (outstanding -> 350), then big delivery (1850 <= 2000).
insert into agent_payments (id, payment_date, agent_id, amount, method, kind)
values ('f2000000-0000-4000-8000-000000000010',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1000, 'cash', 'old_debt');
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('f2000000-0000-4000-8000-000000000011',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, 0, 0);

select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 1850,
  'credit-limit setup: outstanding = 1850 (<= 2000)');

-- Now staff tries to DELETE the temp payment (would jump to 2850 > 2000) -> FAIL!
select testkit.assert_error('credit_limit',
  $$delete from agent_payments where id = 'f2000000-0000-4000-8000-000000000010'$$);

-- Staff tries to SHRINK the temp payment to 100 (would jump to 2750 > 2000) -> FAIL!
select testkit.assert_error('credit_limit',
  $$update agent_payments set amount = 100 where id = 'f2000000-0000-4000-8000-000000000010'$$);

-- Legitimate delete that stays within limit (insert extra 100, delete it -> 1850 <= 2000) -> SUCCEEDS.
insert into agent_payments (id, payment_date, agent_id, amount, method, kind)
values ('f2000000-0000-4000-8000-000000000012',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 100, 'cash', 'old_debt');
delete from agent_payments where id = 'f2000000-0000-4000-8000-000000000012';

-- OM is exempt from credit_limit on payment delete.
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
delete from agent_payments where id = 'f2000000-0000-4000-8000-000000000010';
select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 2850,
  'OM exempt: owner can delete payment past credit_limit (outstanding = 2850)');

rollback;
reset role;

-- =========================================================================
-- 3. ITEM 3 (M6): NULL agent inserts rejected; closed/archived agent
--    payment inserts rejected; pre-existing NULL rows stay readable/updatable
-- =========================================================================
begin;

-- Plant pre-existing historical NULL-agent rows (simulating legacy pre-0032 rows).
set local session_replication_role = 'replica';
insert into daily_entries (id, entry_date, agent_id, agent_name, delivered_qty, returned_qty, unit_price, amount, amount_collected, created_by, received_by)
values ('f3000000-0000-4000-8000-000000000001',
        (now() at time zone 'Asia/Yangon')::date,
        null, 'Deleted Agent', 2, 0, 300, 600, 600,
        '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111');
insert into agent_payments (id, payment_date, agent_id, agent_name, amount, created_by, received_by)
values ('f3000000-0000-4000-8000-000000000002',
        (now() at time zone 'Asia/Yangon')::date,
        null, 'Deleted Agent', 500,
        '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111');
set local session_replication_role = 'origin';

-- Close Agent C via finalize_closeout (owner), and also create an archived-only agent.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select finalize_closeout('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 10, 1000, 'close test');

-- Pre-existing NULL-agent rows remain readable and allow unrelated same-day UPDATE.
select testkit.assert_true(
  exists (select 1 from daily_entries where id = 'f3000000-0000-4000-8000-000000000001')
  and exists (select 1 from agent_payments where id = 'f3000000-0000-4000-8000-000000000002'),
  'M6: pre-existing NULL-agent rows remain readable');
update daily_entries set notes = 'legacy note ok' where id = 'f3000000-0000-4000-8000-000000000001';
update agent_payments set notes = 'legacy note ok' where id = 'f3000000-0000-4000-8000-000000000002';

-- Plant a separate agent with archived_at set (and closed_at null) to test archived check directly.
reset role;
set local session_replication_role = 'replica';
insert into agents (id, code, name, default_unit_price, archived_at)
values ('f3000000-0000-4000-8000-000000000099', 'ARC1', 'Archived Test Agent', 300, now());
set local session_replication_role = 'origin';

-- As staff: NULL agent_id INSERT fails on both tables; closed & archived agent payment INSERT fails.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

select testkit.assert_error('agent_required',
  $$insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected)
    values (null, 5, 0, 0)$$);
select testkit.assert_error('agent_required',
  $$insert into agent_payments (payment_date, agent_id, amount)
    values ((now() at time zone 'Asia/Yangon')::date, null, 500)$$);
select testkit.assert_error('agent_closed',
  $$insert into agent_payments (payment_date, agent_id, amount)
    values ((now() at time zone 'Asia/Yangon')::date, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 500)$$);
select testkit.assert_error('agent_archived',
  $$insert into agent_payments (payment_date, agent_id, amount)
    values ((now() at time zone 'Asia/Yangon')::date, 'f3000000-0000-4000-8000-000000000099', 500)$$);

rollback;
reset role;

-- =========================================================================
-- 4. ITEM 4 (M3/D2): inventory_movements RLS & inventory_totals() lockdown
-- =========================================================================
begin;

-- Owner plants factory stock row + agentA row.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
insert into inventory_movements (id, move_date, agent_id, kind, bottles, notes) values
  ('f4000000-0000-4000-8000-000000000001', (now() at time zone 'Asia/Yangon')::date, null, 'produce', 100, 'factory run'),
  ('f4000000-0000-4000-8000-000000000002', (now() at time zone 'Asia/Yangon')::date, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'adjust', 5, 'agentA move');

-- Owner & Manager can read/write inventory_movements and call inventory_totals().
select testkit.assert_true(
  (inventory_totals() ->> 'produced')::bigint >= 100,
  'M3: owner can call inventory_totals()');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
select testkit.assert_true(
  (inventory_totals() ->> 'produced')::bigint >= 100,
  'M3: manager can call inventory_totals()');
update inventory_movements set notes = 'manager edit ok'
 where id = 'f4000000-0000-4000-8000-000000000001';

-- Staff loses ALL inventory access (SELECT=0, INSERT fails, UPDATE=0, DELETE=0, RPC fails).
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_true(
  (select count(*) from inventory_movements) = 0,
  'M3: staff sees 0 inventory_movements rows');
select testkit.assert_error('new row violates row-level security',
  $$insert into inventory_movements (move_date, kind, bottles, notes)
    values ((now() at time zone 'Asia/Yangon')::date, 'damage', 50, 'forged')$$);
do $$
declare n int;
begin
  update inventory_movements set bottles = 0
   where id = 'f4000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: staff updated % inventory rows', n; end if;

  delete from inventory_movements
   where id = 'f4000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: staff deleted % inventory rows', n; end if;
end $$;
select testkit.assert_error('inventory_totals: not allowed',
  $$select inventory_totals()$$);

-- Agent A still sees only their own agent_id inventory row (not factory row).
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_true(
  (select count(*) from inventory_movements) = 1
  and exists (select 1 from inventory_movements where id = 'f4000000-0000-4000-8000-000000000002'),
  'M3: agentA sees only own agent_id inventory row');

rollback;
reset role;

-- =========================================================================
-- 5. ITEM 5 (D1): agent_detail_stats(uuid) lockdown
-- =========================================================================
begin;
set local role authenticated;

-- Staff CANNOT call agent_detail_stats(uuid) (for any agent or NULL).
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_error('agent_detail_stats: not allowed',
  $$select agent_detail_stats('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$$);
select testkit.assert_error('agent_detail_stats: not allowed',
  $$select agent_detail_stats(null)$$);

-- Owner & Manager CAN call agent_detail_stats(uuid).
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select testkit.assert_true(
  (agent_detail_stats('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') ->> 'depBottles')::int = 5,
  'D1: owner can call agent_detail_stats');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
select testkit.assert_true(
  (agent_detail_stats('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') ->> 'depBottles')::int = 5,
  'D1: manager can call agent_detail_stats');

-- Agent A CAN call for own agent, CANNOT call for Agent B.
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_true(
  (agent_detail_stats('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') ->> 'depBottles')::int = 5,
  'D1: agentA can call agent_detail_stats for own agent');
select testkit.assert_error('agent_detail_stats: not allowed',
  $$select agent_detail_stats('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')$$);

rollback;
reset role;

-- =========================================================================
-- 6. MUST NOT BREAK REGRESSIONS
-- =========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

-- R1: edit_daily_entry() full flow as staff on own same-day entry
--     (both linked-payment rewrite DELETE+INSERT and in-place receiver UPDATE).
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('f6000000-0000-4000-8000-000000000001',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, 0, 1500,
        '33333333-3333-4333-8333-333333333333');
insert into agent_payments (id, payment_date, agent_id, amount, method, kind, received_by, source_entry_id)
values ('f6000000-0000-4000-8000-000000000002',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 500, 'cash', 'old_debt',
        '33333333-3333-4333-8333-333333333333',
        'f6000000-0000-4000-8000-000000000001');

-- 1a) Cash rewrite: total cash 2000 -> 2500 (deletes old linked payment, inserts new linked payment 1000).
do $$
declare v_res jsonb;
begin
  v_res := edit_daily_entry(
    'f6000000-0000-4000-8000-000000000001',
    5, 0, 2500,
    '33333333-3333-4333-8333-333333333333',
    'cash fix',
    'recounted cash'
  );
  if (v_res ->> 'to_old')::bigint <> 1000 then
    raise exception 'ASSERT FAILED: expected to_old=1000, got %', v_res;
  end if;
end $$;

-- 1b) Receiver-only edit: updates existing linked payment in-place (received_by -> paystaff 6666…).
do $$
declare v_res jsonb;
begin
  v_res := edit_daily_entry(
    'f6000000-0000-4000-8000-000000000001',
    5, 0, 2500,
    '66666666-6666-4666-8666-666666666666',
    'receiver fix',
    'wrong receiver'
  );
  if (v_res ->> 'to_old')::bigint <> 1000 then
    raise exception 'ASSERT FAILED: expected to_old=1000 on receiver edit, got %', v_res;
  end if;
end $$;

reset role;
select testkit.assert_true(
  exists (select 1 from agent_payments
           where source_entry_id = 'f6000000-0000-4000-8000-000000000001'
             and amount = 1000
             and received_by = '66666666-6666-4666-8666-666666666666'),
  'R1: edit_daily_entry rewrote and updated linked payment as staff');

-- R2a: UI delete flow as staff (stamp change_reason, then DELETE daily_entries -> cascades linked payment).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
update daily_entries set change_reason = 'duplicate visit'
 where id = 'f6000000-0000-4000-8000-000000000001';
delete from daily_entries
 where id = 'f6000000-0000-4000-8000-000000000001';

reset role;
select testkit.assert_true(
  not exists (select 1 from daily_entries where id = 'f6000000-0000-4000-8000-000000000001')
  and not exists (select 1 from agent_payments where source_entry_id = 'f6000000-0000-4000-8000-000000000001'),
  'R2a: staff delete of daily_entries stamped change_reason and cascaded linked payment');

-- R2b: OM deleting staff's daily_entries row also cascades linked payment.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('f6000000-0000-4000-8000-000000000003',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 4, 0, 1200);
insert into agent_payments (id, payment_date, agent_id, amount, method, kind, source_entry_id)
values ('f6000000-0000-4000-8000-000000000004',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 300, 'cash', 'old_debt',
        'f6000000-0000-4000-8000-000000000003');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
update daily_entries set change_reason = 'owner cleanup'
 where id = 'f6000000-0000-4000-8000-000000000003';
delete from daily_entries
 where id = 'f6000000-0000-4000-8000-000000000003';

reset role;
select testkit.assert_true(
  not exists (select 1 from agent_payments where id = 'f6000000-0000-4000-8000-000000000004'),
  'R2b: OM delete of daily_entries cascaded linked payment');

-- R3: Standalone payment insert, edit, and UI delete (change_reason stamp + delete) as staff.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into agent_payments (id, payment_date, agent_id, amount, method, kind, notes)
values ('f6000000-0000-4000-8000-000000000005',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 400, 'cash', 'old_debt', 'initial');
update agent_payments
   set amount = 450, method = 'kbzpay', notes = 'edited', change_reason = 'amount fix'
 where id = 'f6000000-0000-4000-8000-000000000005';
update agent_payments set change_reason = 'entered twice'
 where id = 'f6000000-0000-4000-8000-000000000005';
delete from agent_payments
 where id = 'f6000000-0000-4000-8000-000000000005';

-- R4: Bottle-only entry (0049) + offline-queue unsplit insert path as staff.
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('f6000000-0000-4000-8000-000000000006',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 2, 0);
select testkit.assert_true(
  (edit_daily_entry('f6000000-0000-4000-8000-000000000006', 0, 3, 0, null, 'bottle edit', 'recount') ->> 'amount')::bigint = 0,
  'R4a: bottle-only insert + edit_daily_entry still succeeds');

-- Offline-queue style unsplit insert (amount_collected 1000 > amount 600).
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, notes)
values ('f6000000-0000-4000-8000-000000000007',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 0, 1000, 'offline replay');

reset role;
select testkit.assert_true(
  exists (select 1 from daily_entries where id = 'f6000000-0000-4000-8000-000000000007' and amount = 600 and amount_collected = 1000),
  'R4b: offline-queue unsplit insert still succeeds');

-- R5: OM full capabilities (inventory write, standalone payment, entry insert/edit/delete).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
insert into inventory_movements (id, move_date, kind, bottles, notes)
values ('f6000000-0000-4000-8000-000000000008', (now() at time zone 'Asia/Yangon')::date, 'produce', 200, 'om ok');
update inventory_movements set bottles = 210 where id = 'f6000000-0000-4000-8000-000000000008';
delete from inventory_movements where id = 'f6000000-0000-4000-8000-000000000008';

rollback;
reset role;

select '24_pack1_staff_holes: all assertions passed';
