-- 18_edit_own_rows_only.sql — migration 0045, Rule A (owner decision
-- 2026-11-20): on daily_entries, agent_payments and expenses a staff
-- user may UPDATE/DELETE only rows they created; owner / manager /
-- co_owner (is_owner_manager) may edit anyone's. Before 0045 the
-- entries/payments policies were is_staff_plus() alone — any staff
-- account could edit any other staff member's same-day record — and
-- expenses were is_owner_manager() alone.
--
-- Identities: staff A = t_staff 3333…, staff B = t_paystaff 6666…
-- (both primary-role staff), manager 2222…, owner 1111…, agent A's
-- login 4444…. "Blocked" by an RLS policy means the statement affects
-- 0 rows (no error); row counts are captured with GET DIAGNOSTICS
-- while the simulated role is active.

-- The four staff-writable update/delete policies carry the own-row clause;
-- expenses_update / expenses_delete were tightened back to is_owner_manager()
-- only in 0052 (L2).
select testkit.assert_true(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and policyname in ('entries_update', 'entries_delete',
                         'payments_update', 'payments_delete')
      and qual like '%created_by%') = 4
  and (select count(*) from pg_policies
    where schemaname = 'public'
      and policyname in ('expenses_update', 'expenses_delete')
      and qual = 'is_owner_manager()') = 2,
  '0045+0052: entries/payments reference created_by; expenses update/delete are OM-only');

-- --------------------------------------------------------------------
-- Entries + payments: staff B cannot touch staff A's rows; staff B
-- and staff A can edit their OWN rows; the manager can edit A's.
-- --------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('e1000000-0000-4000-8000-000000000001',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, 0, 0);
insert into agent_payments (id, payment_date, agent_id, amount, method)
values ('e1000000-0000-4000-8000-000000000002',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 4000, 'cash');

-- Staff B: every write against A's rows is a silent no-op.
select set_config('request.jwt.claims', '{"sub":"66666666-6666-4666-8666-666666666666"}', true);
do $$
declare n int;
begin
  update daily_entries set notes = 'hijack'
   where id = 'e1000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: staff B updated staff A entry (% rows)', n; end if;
  delete from daily_entries
   where id = 'e1000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: staff B deleted staff A entry (% rows)', n; end if;
  update agent_payments set amount = 1
   where id = 'e1000000-0000-4000-8000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: staff B updated staff A payment (% rows)', n; end if;
  delete from agent_payments
   where id = 'e1000000-0000-4000-8000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: staff B deleted staff A payment (% rows)', n; end if;
end $$;

-- Staff B's OWN rows still work (Rule A is not a staff freeze-out).
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('e1000000-0000-4000-8000-000000000003',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 0, 0);
insert into agent_payments (id, payment_date, agent_id, amount, method)
values ('e1000000-0000-4000-8000-000000000004',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1000, 'cash');
do $$
declare n int;
begin
  update daily_entries set notes = 'mine'
   where id = 'e1000000-0000-4000-8000-000000000003';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ASSERT FAILED: staff B could not update own entry (% rows)', n; end if;
  delete from agent_payments
   where id = 'e1000000-0000-4000-8000-000000000004';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ASSERT FAILED: staff B could not delete own payment (% rows)', n; end if;
end $$;

-- Manager edits A's entry and deletes A's payment.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
do $$
declare n int;
begin
  update daily_entries set notes = 'manager fix'
   where id = 'e1000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ASSERT FAILED: manager could not update staff A entry (% rows)', n; end if;
  delete from agent_payments
   where id = 'e1000000-0000-4000-8000-000000000002';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ASSERT FAILED: manager could not delete staff A payment (% rows)', n; end if;
end $$;

-- Staff A edits and deletes their own entry.
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
do $$
declare n int;
begin
  update daily_entries set notes = 'own fix'
   where id = 'e1000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ASSERT FAILED: staff A could not update own entry (% rows)', n; end if;
  delete from daily_entries
   where id = 'e1000000-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ASSERT FAILED: staff A could not delete own entry (% rows)', n; end if;
end $$;

reset role;
select testkit.assert_true(
  exists (select 1 from daily_entries
           where id = 'e1000000-0000-4000-8000-000000000003'
             and notes = 'mine'),
  'staff B own entry survived with its edit applied');
rollback;
reset role;

-- --------------------------------------------------------------------
-- Expenses: staff-created rows planted in replica mode (staff cannot
-- INSERT expenses — the insert policy stays OM-only — so a staff
-- created_by can only exist from a prior-role or legacy row; Rule A
-- is applied to expenses for exactly that consistency). Staff B is
-- blocked; staff A is ALSO still blocked today — deliberately:
-- expenses_select stays is_owner_manager() (SPEC management data, no
-- read widening in 0045) and an UPDATE must read its target row, so
-- the own-row clause in the update/delete policies is in place but
-- inert until expense visibility is ever widened. The manager (OM)
-- edits and deletes anyone's, exactly as before.
-- --------------------------------------------------------------------
begin;
set session_replication_role = 'replica';
insert into expenses (id, expense_date, category_id, title, amount, created_by, created_at) values
  ('e1000000-0000-4000-8000-000000000011',
   (now() at time zone 'Asia/Yangon')::date,
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Staff A expense 1', 1000,
   '33333333-3333-4333-8333-333333333333', now()),
  ('e1000000-0000-4000-8000-000000000012',
   (now() at time zone 'Asia/Yangon')::date,
   'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Staff A expense 2', 2000,
   '33333333-3333-4333-8333-333333333333', now());
set session_replication_role = 'origin';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"66666666-6666-4666-8666-666666666666"}', true);
do $$
declare n int;
begin
  update expenses set amount = 1
   where id = 'e1000000-0000-4000-8000-000000000011';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: staff B updated staff A expense (% rows)', n; end if;
  delete from expenses
   where id = 'e1000000-0000-4000-8000-000000000011';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: staff B deleted staff A expense (% rows)', n; end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
do $$
declare n int;
begin
  update expenses set amount = 1500
   where id = 'e1000000-0000-4000-8000-000000000011';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: staff A updated an expense despite OM-only select (% rows)', n; end if;
  delete from expenses
   where id = 'e1000000-0000-4000-8000-000000000011';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: staff A deleted an expense despite OM-only select (% rows)', n; end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
do $$
declare n int;
begin
  update expenses set amount = 2500
   where id = 'e1000000-0000-4000-8000-000000000012';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ASSERT FAILED: manager could not update staff A expense (% rows)', n; end if;
  delete from expenses
   where id = 'e1000000-0000-4000-8000-000000000012';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ASSERT FAILED: manager could not delete staff A expense (% rows)', n; end if;
end $$;

-- The staff attempts left the row untouched, and the owner can
-- delete it (OM branch, as before).
reset role;
select testkit.assert_true(
  (select amount from expenses
    where id = 'e1000000-0000-4000-8000-000000000011') = 1000,
  'staff attempts left the planted expense amount untouched');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
do $$
declare n int;
begin
  delete from expenses
   where id = 'e1000000-0000-4000-8000-000000000011';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ASSERT FAILED: owner could not delete the expense (% rows)', n; end if;
end $$;
rollback;
reset role;

-- --------------------------------------------------------------------
-- The same-day guard still binds AFTER the policy change: the owner
-- passes the new policy (OM branch) and the trigger still refuses a
-- yesterday row. If the policy had accidentally shut the owner out,
-- the update would silently affect 0 rows and assert_error would
-- fail — so this proves the guard chain, not just the policy.
-- --------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select testkit.assert_error('same_day_only',
  $$update daily_entries set notes = 'x' where id = 'e0000000-0000-4000-8000-000000000001'$$);
select testkit.assert_error('same_day_only',
  $$delete from daily_entries where id = 'e0000000-0000-4000-8000-000000000001'$$);
rollback;
reset role;

-- --------------------------------------------------------------------
-- Agent rights unchanged: an agent still cannot update or delete any
-- entry, including their own agent's rows (fixture rows for today).
-- --------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
do $$
declare n int;
begin
  update daily_entries set notes = 'agent hijack'
   where entry_date = (now() at time zone 'Asia/Yangon')::date;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: agent updated entries (% rows)', n; end if;
  delete from daily_entries
   where entry_date = (now() at time zone 'Asia/Yangon')::date;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: agent deleted entries (% rows)', n; end if;
  delete from agent_payments
   where payment_date = (now() at time zone 'Asia/Yangon')::date;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: agent deleted payments (% rows)', n; end if;
end $$;
rollback;
reset role;

select '18_edit_own_rows_only: all assertions passed';
