-- 02_month_lock.sql — SPEC rule 6: a locked month cannot be edited by
-- ANY role, Owner included (trigger-enforced). The fixture locks
-- 2020-01 and holds one entry inside it (e000…002). Scenarios run as
-- the OWNER inside begin/rollback.

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

-- Insert into the locked month: rejected even for the owner (the
-- owner backdate exception of 0018 does NOT override a month lock).
select testkit.assert_error('month_locked',
  $$insert into daily_entries (entry_date, agent_id, delivered_qty, returned_qty, amount_collected)
    values (date '2020-01-20', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 0, 0)$$);
select testkit.assert_error('month_locked',
  $$insert into expenses (expense_date, category_id, title, amount)
    values (date '2020-01-20', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Locked', 100)$$);

-- Update / delete of the row that lives in the locked month.
select testkit.assert_error('month_locked',
  $$update daily_entries set notes = 'x' where id = 'e0000000-0000-4000-8000-000000000002'$$);
select testkit.assert_error('month_locked',
  $$delete from daily_entries where id = 'e0000000-0000-4000-8000-000000000002'$$);

rollback;
reset role;
select '02_month_lock: all assertions passed';
