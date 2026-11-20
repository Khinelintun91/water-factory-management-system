-- 20_entry_payment_link.sql — migration 0047: an old-debt payment
-- spawned by a delivery entry carries source_entry_id -> the entry,
-- ON DELETE CASCADE. Deleting the entry deletes its spawned payment;
-- a standalone payment (NULL link) is never cascaded.
--
-- The incident this prevents (live, 2026-11-20): an entry saved with
-- a ကြွေးကောက် amount spawned an unlinked payment; the entry was
-- deleted the same day and the orphan payment kept counting as
-- received cash and drove agent_outstanding to -200,000 (phantom
-- overpaid).
--
-- Identities: staff A = t_staff 3333… plants and deletes (their own
-- rows, per Rule A 0045). Cross-user counts and agent_outstanding
-- are read AFTER reset role (the AGENTS.md lesson: side-effect rows
-- for other readers are invisible under the simulated role).
--
-- Money math for agent A (fixture baseline outstanding = 1350,
-- asserted in 07): planted entry …001 delivers 10 x 300 = 3,000
-- (+3,000), its linked payment …002 is 1,200 (-1,200), the
-- standalone payment …003 is 500 (-500), the second entry …004
-- delivers 1 x 300 (+300). While all four rows live: 2,950.
-- After …001 is deleted (…002 cascades): 1,150.
-- After …004 is deleted (…003 must survive): 850.

-- The column and its cascade FK exist.
select testkit.assert_true(
  exists (select 1 from information_schema.columns
           where table_schema = 'public'
             and table_name = 'agent_payments'
             and column_name = 'source_entry_id'),
  '0047: agent_payments.source_entry_id exists');
select testkit.assert_true(
  (select confdeltype from pg_constraint
    where conname = 'agent_payments_source_entry_fkey') = 'c',
  '0047: source_entry_id FK is ON DELETE CASCADE');
select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 1350,
  'baseline: agent A outstanding = 1350 (fixture)');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

-- Plant the pair exactly as EntriesPage saves it (entry first, then
-- its old-debt payment carrying the link), plus a standalone payment
-- and a second, payment-less entry.
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('e3000000-0000-4000-8000-000000000001',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 0, 0,
        '33333333-3333-4333-8333-333333333333');
insert into agent_payments (id, payment_date, agent_id, agent_name, amount, method, kind, notes, received_by, source_entry_id)
values ('e3000000-0000-4000-8000-000000000002',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Agent A', 1200,
        'cash', 'old_debt', 'ရေပို့မှတ်တမ်းနှင့်အတူ ပေးချေသည်',
        '33333333-3333-4333-8333-333333333333',
        'e3000000-0000-4000-8000-000000000001');
insert into agent_payments (id, payment_date, agent_id, amount, method, kind, received_by)
values ('e3000000-0000-4000-8000-000000000003',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 500, 'cash', 'old_debt',
        '33333333-3333-4333-8333-333333333333');
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('e3000000-0000-4000-8000-000000000004',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 0, 0);

-- Staff-plus may call agent_outstanding (0029 gate): all four rows
-- live -> 1350 + 3000 - 1200 - 500 + 300.
select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 2950,
  'outstanding with entry + linked + standalone + entry = 2950');

-- Staff A deletes their own entry …001 (Rule A + same-day allow).
do $$
declare n int;
begin
  delete from daily_entries
   where id = 'e3000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ASSERT FAILED: staff A could not delete own entry (% rows)', n; end if;
end $$;

reset role;
select testkit.assert_true(
  (select count(*) from agent_payments
    where id = 'e3000000-0000-4000-8000-000000000002') = 0,
  'cascade: linked old-debt payment deleted together with its entry');
select testkit.assert_true(
  (select count(*) from agent_payments
    where id = 'e3000000-0000-4000-8000-000000000003') = 1,
  'standalone payment (NULL link) survives the entry delete');
select testkit.assert_true(
  (select count(*) from daily_entries
    where id = 'e3000000-0000-4000-8000-000000000004') = 1,
  'second entry untouched by the first delete');
select testkit.assert_true(
  exists (select 1 from audit_log
           where table_name = 'agent_payments'
             and row_id = 'e3000000-0000-4000-8000-000000000002'
             and action = 'delete'),
  'audit: cascaded payment delete wrote its before-image to audit_log');
select testkit.assert_true(
  exists (select 1 from audit_log
           where table_name = 'daily_entries'
             and row_id = 'e3000000-0000-4000-8000-000000000001'
             and action = 'delete'),
  'audit: entry delete wrote its before-image to audit_log');
select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 1150,
  'outstanding after cascade = 1150 (entry and its payment both gone)');

-- Delete the second entry too: the standalone payment STILL survives
-- (the cascade follows source_entry_id, never agent/date proximity).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
do $$
declare n int;
begin
  delete from daily_entries
   where id = 'e3000000-0000-4000-8000-000000000004';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ASSERT FAILED: staff A could not delete second entry (% rows)', n; end if;
end $$;

reset role;
select testkit.assert_true(
  (select count(*) from agent_payments
    where id = 'e3000000-0000-4000-8000-000000000003') = 1,
  'standalone payment survives the second entry delete too');
select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 850,
  'outstanding at end = 850 (1350 - 500 standalone payment only)');
rollback;
reset role;

select '20_entry_payment_link: all assertions passed';
