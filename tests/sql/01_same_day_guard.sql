-- 01_same_day_guard.sql — SPEC rule 4: a record may be edited or
-- deleted ONLY on the Yangon calendar day it was created, for EVERY
-- role including the Owner (0003; extended to the Phase A/B money
-- tables by 0027). Fixture rows e000…001–008 were all created
-- "yesterday". Every scenario runs as the OWNER — the strongest
-- account — inside begin/rollback.

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

-- The original 0003 tables.
select testkit.assert_error('same_day_only',
  $$update daily_entries set notes = 'x' where id = 'e0000000-0000-4000-8000-000000000001'$$);
select testkit.assert_error('same_day_only',
  $$delete from daily_entries where id = 'e0000000-0000-4000-8000-000000000001'$$);
select testkit.assert_error('same_day_only',
  $$update agent_payments set amount = 200 where id = 'e0000000-0000-4000-8000-000000000003'$$);
select testkit.assert_error('same_day_only',
  $$delete from agent_payments where id = 'e0000000-0000-4000-8000-000000000003'$$);
select testkit.assert_error('same_day_only',
  $$update expenses set amount = 600 where id = 'e0000000-0000-4000-8000-000000000004'$$);
select testkit.assert_error('same_day_only',
  $$delete from expenses where id = 'e0000000-0000-4000-8000-000000000004'$$);

-- The 0027 symmetry tables (write-offs move agent debt directly).
select testkit.assert_error('same_day_only',
  $$update write_offs set amount = 60 where id = 'e0000000-0000-4000-8000-000000000005'$$);
select testkit.assert_error('same_day_only',
  $$delete from write_offs where id = 'e0000000-0000-4000-8000-000000000005'$$);
select testkit.assert_error('same_day_only',
  $$update agent_deposits set amount = 6000 where id = 'e0000000-0000-4000-8000-000000000006'$$);
select testkit.assert_error('same_day_only',
  $$delete from agent_deposits where id = 'e0000000-0000-4000-8000-000000000006'$$);
select testkit.assert_error('same_day_only',
  $$update advances set amount = 2000 where id = 'e0000000-0000-4000-8000-000000000007'$$);
select testkit.assert_error('same_day_only',
  $$delete from advances where id = 'e0000000-0000-4000-8000-000000000007'$$);
select testkit.assert_error('same_day_only',
  $$update cash_handovers set received = 90 where id = 'e0000000-0000-4000-8000-000000000008'$$);
select testkit.assert_error('same_day_only',
  $$delete from cash_handovers where id = 'e0000000-0000-4000-8000-000000000008'$$);

-- Positive control: a row created TODAY can still be edited and
-- deleted by the owner (the guard is a date rule, not a freeze).
insert into expenses (id, category_id, title, amount)
values ('e0000000-0000-4000-8000-000000000101',
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Today expense', 700);
update expenses set amount = 800 where id = 'e0000000-0000-4000-8000-000000000101';
delete from expenses where id = 'e0000000-0000-4000-8000-000000000101';

rollback;
reset role;
select '01_same_day_guard: all assertions passed';
