-- 21_edit_entries_expenses.sql — migration 0048:
--   * expenses.change_reason column + same-day / month-lock / audit checks
--   * daily_entries.agent_id immutability trigger (entries_agent_immutable)
--   * atomic edit_daily_entry(...) RPC enforcing Rule A (0045), same-day
--     guard (SPEC rule 4), month-lock (SPEC rule 6), cash reallocation,
--     received_by sync, credit_limit atomicity, and audit_log directly in DB.

-- 1) Schema, trigger, search_path, and execute grants.
select testkit.assert_true(
  exists (select 1 from information_schema.columns
           where table_schema = 'public'
             and table_name = 'expenses'
             and column_name = 'change_reason'),
  '0048: expenses.change_reason column exists');

select testkit.assert_true(
  exists (select 1 from pg_trigger
           where tgrelid = 'public.daily_entries'::regclass
             and tgname = 'entries_agent_immutable'
             and not tgisinternal),
  '0048: entries_agent_immutable trigger exists on daily_entries');

select testkit.assert_true(
  has_function_privilege(
    'authenticated',
    'public.edit_daily_entry(uuid,integer,integer,bigint,uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.edit_daily_entry(uuid,integer,integer,bigint,uuid,text,text)',
    'EXECUTE'
  )
  and not exists (
    select 1
      from pg_proc p
      join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a on true
     where p.oid = 'public.edit_daily_entry(uuid,integer,integer,bigint,uuid,text,text)'::regprocedure
       and a.grantee = 0
       and a.privilege_type = 'EXECUTE'
  )
  and not has_function_privilege('authenticated', 'public.guard_entry_agent_immutable()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.guard_entry_agent_immutable()', 'EXECUTE'),
  '0048: edit_daily_entry granted only to authenticated; trigger fn closed');

select testkit.assert_true(
  (select bool_and(
     exists (
       select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c
        where c = 'search_path=public'
     )
   )
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('edit_daily_entry', 'guard_entry_agent_immutable')),
  '0048: both new functions pin search_path = public');

-- 2) Direct UPDATE changing daily_entries.agent_id is rejected even for Owner.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('e4000000-0000-4000-8000-000000000001',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, 0, 1500);

select testkit.assert_error('agent_immutable',
  $$update daily_entries
       set agent_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
     where id = 'e4000000-0000-4000-8000-000000000001'$$);

rollback;
reset role;

-- 3) edit_daily_entry: Rule A (0045), agent/inactive block, cross-role OM+staff
--    linked-payment reconciliation, exact allocation math, received_by sync,
--    and audit_log trail.
begin;
-- Baseline Agent A outstanding = 1350 (fixture).
select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 1350,
  'baseline: agent A outstanding = 1350');

set local role authenticated;
-- Staff A (3333…) creates today's entry naming Staff B (6666…) as receiver.
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('e4000000-0000-4000-8000-000000000010',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 0, 0,
        '66666666-6666-4666-8666-666666666666');

-- Staff B can SEE the row via 0046 (received_by = B), but Rule A MUST block
-- Staff B from editing it via edit_daily_entry.
select set_config('request.jwt.claims', '{"sub":"66666666-6666-4666-8666-666666666666"}', true);
select testkit.assert_error('forbidden',
  $$select edit_daily_entry(
      'e4000000-0000-4000-8000-000000000010', 10, 0, 1000,
      '66666666-6666-4666-8666-666666666666', 'hijack', 'staff B hijack')$$);

-- Pure Agent A (4444…) is blocked by is_staff_plus().
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_error('forbidden',
  $$select edit_daily_entry(
      'e4000000-0000-4000-8000-000000000010', 10, 0, 1000,
      null, 'agent hijack', 'agent edit')$$);

-- Input validation checks (as Staff A, owner of the row).
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_error('change_reason_required',
  $$select edit_daily_entry(
      'e4000000-0000-4000-8000-000000000010', 10, 0, 1000, null, null, 'a')$$);
select testkit.assert_error('invalid_delivered_qty',
  $$select edit_daily_entry(
      'e4000000-0000-4000-8000-000000000010', 0, 0, 1000, null, null, 'valid reason')$$);
select testkit.assert_error('invalid_returned_qty',
  $$select edit_daily_entry(
      'e4000000-0000-4000-8000-000000000010', 10, -1, 1000, null, null, 'valid reason')$$);
select testkit.assert_error('invalid_cash',
  $$select edit_daily_entry(
      'e4000000-0000-4000-8000-000000000010', 10, 0, -50, null, null, 'valid reason')$$);
select testkit.assert_error('entry_not_found',
  $$select edit_daily_entry(
      'e4000000-0000-4000-8000-000000009999', 10, 0, 1000, null, null, 'valid reason')$$);

-- Staff A edits their own entry: 10 x 300 = 3,000, cash 5,000, receiver = Staff B.
-- Split against base 1,350: to_today = 3,000, to_old = 1,350, advance = 650, bal = -650.
select testkit.assert_true(
  (select (res->>'to_today')::bigint = 3000
      and (res->>'to_old')::bigint = 1350
      and (res->>'advance')::bigint = 650
      and (res->>'resulting_balance')::bigint = -650
     from edit_daily_entry(
       'e4000000-0000-4000-8000-000000000010', 10, 2, 5000,
       '66666666-6666-4666-8666-666666666666', 'edited note', 'ငွေပမာဏ ပြင်'
     ) as res),
  'staff A edit_daily_entry returns exact split (3000 / 1350 / 650, bal -650)');

reset role;
select testkit.assert_true(
  exists (select 1 from daily_entries
           where id = 'e4000000-0000-4000-8000-000000000010'
             and agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
             and delivered_qty = 10
             and returned_qty = 2
             and unit_price = 300
             and amount = 3000
             and amount_collected = 3000
             and received_by = '66666666-6666-4666-8666-666666666666'
             and notes = 'edited note'
             and change_reason = 'ငွေပမာဏ ပြင်'),
  'daily_entries updated with preserved agent_id + unit_price + new receiver');

select testkit.assert_true(
  (select count(*) from agent_payments
    where source_entry_id = 'e4000000-0000-4000-8000-000000000010') = 2
  and exists (select 1 from agent_payments
               where source_entry_id = 'e4000000-0000-4000-8000-000000000010'
                 and kind = 'old_debt' and amount = 1350
                 and received_by = '66666666-6666-4666-8666-666666666666')
  and exists (select 1 from agent_payments
               where source_entry_id = 'e4000000-0000-4000-8000-000000000010'
                 and kind = 'regular' and amount = 650
                 and received_by = '66666666-6666-4666-8666-666666666666'),
  'linked payments created with exact split and synced received_by');

select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = -650,
  'agent_outstanding matches resulting_balance (-650)');

select testkit.assert_true(
  exists (select 1 from audit_log
           where table_name = 'daily_entries'
             and row_id = 'e4000000-0000-4000-8000-000000000010'
             and action = 'update'
             and actor = '33333333-3333-4333-8333-333333333333'
             and new_data->>'change_reason' = 'ငွေပမာဏ ပြင်'),
  'audit_log recorded daily_entries update with actor and change_reason');

-- Receiver-only edit (same qty & cash) updates linked payments in place
-- without deleting/re-inserting them (preserving row IDs and avoiding bogus
-- new-payment notifications).
do $$
declare
  before_ids uuid[];
  after_ids  uuid[];
begin
  select array_agg(id order by id) into before_ids
    from agent_payments
   where source_entry_id = 'e4000000-0000-4000-8000-000000000010';

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
  perform edit_daily_entry(
    'e4000000-0000-4000-8000-000000000010', 10, 2, 5000,
    '33333333-3333-4333-8333-333333333333', 'receiver only fix', 'လက်ခံသူ ပြင်'
  );
  reset role;

  select array_agg(id order by id) into after_ids
    from agent_payments
   where source_entry_id = 'e4000000-0000-4000-8000-000000000010';

  if before_ids is distinct from after_ids then
    raise exception 'ASSERT FAILED: receiver-only edit rewrote linked payment IDs (% vs %)', before_ids, after_ids;
  end if;
  if exists (
    select 1 from agent_payments
     where source_entry_id = 'e4000000-0000-4000-8000-000000000010'
       and received_by <> '33333333-3333-4333-8333-333333333333'
  ) then
    raise exception 'ASSERT FAILED: linked payment received_by was not synced in place';
  end if;
end $$;

-- Manager (2222…) edits Staff A's entry (OM branch of Rule A), rewriting the
-- linked payments (which now have created_by = Manager).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
select testkit.assert_true(
  (select (res->>'to_today')::bigint = 3000
      and (res->>'to_old')::bigint = 1000
      and (res->>'advance')::bigint = 0
      and (res->>'resulting_balance')::bigint = 350
     from edit_daily_entry(
       'e4000000-0000-4000-8000-000000000010', 10, 2, 4000,
       '33333333-3333-4333-8333-333333333333', 'manager fix', 'မန်နေဂျာ ပြင်'
     ) as res),
  'manager edit_daily_entry succeeds on staff A entry (split 3000 / 1000 / 0)');

-- Staff A edits their OWN entry AGAIN after Manager's edit: even though the
-- linked payment row was inserted by Manager, edit_daily_entry cleanly replaces
-- it atomically (no RLS orphan/duplicate).
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_true(
  (select (res->>'to_today')::bigint = 1000
      and (res->>'to_old')::bigint = 0
      and (res->>'advance')::bigint = 0
      and (res->>'resulting_balance')::bigint = 3350
     from edit_daily_entry(
       'e4000000-0000-4000-8000-000000000010', 10, 2, 1000,
       '33333333-3333-4333-8333-333333333333', 'staff re-edit', 'ဝန်ထမ်း ပြန်ပြင်'
     ) as res),
  'staff A re-edits own entry after OM edit; old linked payments cleanly removed');

reset role;
select testkit.assert_true(
  (select count(*) from agent_payments
    where source_entry_id = 'e4000000-0000-4000-8000-000000000010') = 0
  and agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 3350,
  'zero orphan linked payments and exact balance 3350 (1350 + 3000 - 1000)');

rollback;
reset role;

-- 4) Same-day guard inside edit_daily_entry: rejects Owner on yesterday's row.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select testkit.assert_error('same_day_only',
  $$select edit_daily_entry(
      'e0000000-0000-4000-8000-000000000001', 3, 0, 900,
      null, 'owner late edit', 'နောက်နေ့ ပြင်')$$);
rollback;
reset role;

-- 5) Month lock inside edit_daily_entry: rejects Owner AND Staff on today's
--    entry when the current month is locked (proves month_locked independently
--    of same_day_only).
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('e4000000-0000-4000-8000-000000000020',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 4, 0, 1200);

reset role;
insert into month_locks (month, locked_by)
values (date_trunc('month', (now() at time zone 'Asia/Yangon')::date)::date,
        '11111111-1111-4111-8111-111111111111');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select testkit.assert_error('month_locked',
  $$select edit_daily_entry(
      'e4000000-0000-4000-8000-000000000020', 5, 0, 1500,
      null, 'locked month edit', 'လပိတ်ထားစဉ် ပြင်')$$);
rollback;
reset role;

-- 6) Atomicity on credit_limit failure: if staff edit would exceed agent's
--    credit_limit, edit_daily_entry raises credit_limit AND existing linked
--    payments stay intact (whole transaction rolls back).
begin;
update agents set credit_limit = 2000
 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('e4000000-0000-4000-8000-000000000030',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 0, 3000);
insert into agent_payments (id, payment_date, agent_id, amount, method, kind, source_entry_id)
values ('e4000000-0000-4000-8000-000000000031',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 500, 'cash', 'old_debt',
        'e4000000-0000-4000-8000-000000000030');

-- Attempting to drop total cash to 0 would raise balance to 1350 + 3000 = 4350 > 2000.
select testkit.assert_error('credit_limit',
  $$select edit_daily_entry(
      'e4000000-0000-4000-8000-000000000030', 10, 0, 0,
      null, 'drop cash', 'credit limit test')$$);

reset role;
select testkit.assert_true(
  exists (select 1 from agent_payments
           where id = 'e4000000-0000-4000-8000-000000000031'
             and amount = 500)
  and (select amount_collected from daily_entries
        where id = 'e4000000-0000-4000-8000-000000000030') = 3000,
  'atomic rollback: linked payment and entry untouched when credit_limit rejects');
rollback;
reset role;

-- 7) Inactive profile cannot call edit_daily_entry even on their own row.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('e4000000-0000-4000-8000-000000000040',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 0, 600);

reset role;
update profiles set active = false
 where id = '33333333-3333-4333-8333-333333333333';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_error('forbidden',
  $$select edit_daily_entry(
      'e4000000-0000-4000-8000-000000000040', 3, 0, 900,
      null, 'inactive edit', 'deactivated user')$$);
rollback;
reset role;

-- 8) Expenses edit: change_reason + audit_log + same-day + month-lock.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

insert into expenses (id, expense_date, category_id, title, amount, notes)
values ('e4000000-0000-4000-8000-000000000050',
        (now() at time zone 'Asia/Yangon')::date,
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'ဒီဇယ်', 25000, 'မူလမှတ်ချက်');

update expenses
   set title = 'ဒီဇယ် (ပြင်ပြီး)',
       amount = 30000,
       notes = 'မှတ်ချက်အသစ်',
       change_reason = 'ပမာဏ မှားရိုက်မိ၍ ပြင်'
 where id = 'e4000000-0000-4000-8000-000000000050';

-- Yesterday's expense still rejected by same-day guard (Owner included).
select testkit.assert_error('same_day_only',
  $$update expenses
       set amount = 999, change_reason = 'late edit'
     where id = 'e0000000-0000-4000-8000-000000000004'$$);

reset role;
select testkit.assert_true(
  exists (select 1 from audit_log
           where table_name = 'expenses'
             and row_id = 'e4000000-0000-4000-8000-000000000050'
             and action = 'update'
             and actor = '11111111-1111-4111-8111-111111111111'
             and (old_data->>'amount')::bigint = 25000
             and (new_data->>'amount')::bigint = 30000
             and new_data->>'change_reason' = 'ပမာဏ မှားရိုက်မိ၍ ပြင်'),
  'expenses update logged in audit_log with before/after amounts and change_reason');

-- Locking the current month blocks editing today's expense even for Owner.
insert into month_locks (month, locked_by)
values (date_trunc('month', (now() at time zone 'Asia/Yangon')::date)::date,
        '11111111-1111-4111-8111-111111111111');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select testkit.assert_error('month_locked',
  $$update expenses
       set amount = 31000, change_reason = 'locked month edit'
     where id = 'e4000000-0000-4000-8000-000000000050'$$);

rollback;
reset role;

select '21_edit_entries_expenses: all assertions passed';
