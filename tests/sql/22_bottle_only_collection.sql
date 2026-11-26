-- 22_bottle_only_collection.sql — migration 0049:
--   * Bottle-only collection insert (delivered_qty = 0, returned_qty > 0,
--     amount = 0, amount_collected = 0) succeeds and reduces held bottles.
--   * Both-zero insert (delivered_qty = 0, returned_qty = 0) rejected.
--   * Bottle-only insert/edit with non-zero cash or linked agent_payments
--     row rejected at the database level.
--   * Same-day bottle-only edit of returned_qty / received_by / notes via
--     edit_daily_entry works; type-switch edits (bottle-only -> delivery and
--     delivery -> bottle-only) rejected both via edit_daily_entry and direct
--     UPDATE.
--   * Dedicated bottle-only notification wording for OM and agent (no money,
--     names returned bottles and receiver).
--   * No credit-limit / debt-limit red-flag alert (and no credit_limit or
--     deposit_limit write block) for bottle-only returns even when the agent
--     is already over limit.
--   * Function grants and pinned search_path = public.

-- 1) Triggers, grants, and pinned search_path.
select testkit.assert_true(
  exists (select 1 from pg_trigger
           where tgrelid = 'public.agent_payments'::regclass
             and tgname = 'payments_guard_source_entry'
             and not tgisinternal),
  '0049: payments_guard_source_entry trigger exists on agent_payments');

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
  and not has_function_privilege('authenticated', 'public.entries_before_write()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.entries_before_write()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.guard_payment_source_entry()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.guard_payment_source_entry()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.notify_on_entry()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.notify_on_entry()', 'EXECUTE'),
  '0049: edit_daily_entry granted only to authenticated; trigger fns closed');

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
     and p.proname in (
       'entries_before_write',
       'guard_payment_source_entry',
       'edit_daily_entry',
       'notify_on_entry'
     )),
  '0049: all four functions pin search_path = public');

-- 2) Insert invariants: bottle-only succeeds; both-zero rejected; cash rejected;
--    linked payment to a bottle-only row rejected.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

-- Both-zero insert rejected.
select testkit.assert_error('invalid_entry_qty',
  $$insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 0, 0)$$);

-- Bottle-only insert with non-zero cash rejected at DB level.
select testkit.assert_error('bottle_only_no_cash',
  $$insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 10, 500)$$);

-- Bottle-only insert with zero cash succeeds; amount = 0, amount_collected = 0.
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by, notes)
values ('e5000000-0000-4000-8000-000000000001',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 100, 0,
        '33333333-3333-4333-8333-333333333333', 'empty run');

select testkit.assert_true(
  exists (select 1 from daily_entries
           where id = 'e5000000-0000-4000-8000-000000000001'
             and delivered_qty = 0
             and returned_qty = 100
             and amount = 0
             and amount_collected = 0),
  'bottle-only insert succeeds with delivered=0, returned=100, amount=0, cash=0');

-- Attempting to link an agent_payments row to the bottle-only entry is rejected.
select testkit.assert_error('bottle_only_no_cash',
  $$insert into agent_payments (
      payment_date, agent_id, amount, method, kind, source_entry_id
    ) values (
      (now() at time zone 'Asia/Yangon')::date,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      1000, 'cash', 'old_debt',
      'e5000000-0000-4000-8000-000000000001'
    )$$);

rollback;
reset role;

-- 3) Edit rules: bottle-only edit of returned_qty / receiver / notes works;
--    bottle-only edit with money or returned=0 rejected; type-switch edits
--    rejected BOTH ways via edit_daily_entry AND via direct UPDATE.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

-- Create one bottle-only row and one normal delivery row.
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('e5000000-0000-4000-8000-000000000010',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 100, 0,
        '33333333-3333-4333-8333-333333333333');

insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('e5000000-0000-4000-8000-000000000011',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 5, 3000,
        '33333333-3333-4333-8333-333333333333');

-- Valid same-day edit of bottle-only row (returned_qty 100 -> 85, receiver -> Staff B, notes).
select testkit.assert_true(
  (select (r->>'amount')::bigint = 0
      and (r->>'to_today')::bigint = 0
      and (r->>'to_old')::bigint = 0
      and (r->>'advance')::bigint = 0
     from edit_daily_entry(
       'e5000000-0000-4000-8000-000000000010',
       0, 85, 0,
       '66666666-6666-4666-8666-666666666666',
       'recounted empties',
       'recount fix'
     ) as r),
  'bottle-only edit_daily_entry updates returned_qty with zero money');

select testkit.assert_true(
  exists (select 1 from daily_entries
           where id = 'e5000000-0000-4000-8000-000000000010'
             and delivered_qty = 0
             and returned_qty = 85
             and amount = 0
             and amount_collected = 0
             and received_by = '66666666-6666-4666-8666-666666666666'
             and notes = 'recounted empties'
             and change_reason = 'recount fix'),
  'bottle-only row reflects edited returned_qty, receiver, notes, reason');

-- Bottle-only edit with returned_qty = 0 rejected.
select testkit.assert_error('invalid_returned_qty',
  $$select edit_daily_entry(
      'e5000000-0000-4000-8000-000000000010', 0, 0, 0, null, null, 'zero returned')$$);

-- Bottle-only edit with non-zero cash rejected via RPC and via direct UPDATE.
select testkit.assert_error('bottle_only_no_cash',
  $$select edit_daily_entry(
      'e5000000-0000-4000-8000-000000000010', 0, 85, 500, null, null, 'add cash')$$);
select testkit.assert_error('bottle_only_no_cash',
  $$update daily_entries
       set amount_collected = 500
     where id = 'e5000000-0000-4000-8000-000000000010'$$);

-- Type-switch bottle-only -> delivery rejected via RPC and via direct UPDATE.
select testkit.assert_error('entry_type_immutable',
  $$select edit_daily_entry(
      'e5000000-0000-4000-8000-000000000010', 10, 85, 0, null, null, 'switch to delivery')$$);
select testkit.assert_error('entry_type_immutable',
  $$update daily_entries
       set delivered_qty = 10
     where id = 'e5000000-0000-4000-8000-000000000010'$$);

-- Type-switch delivery -> bottle-only rejected via RPC and via direct UPDATE.
select testkit.assert_error('entry_type_immutable',
  $$select edit_daily_entry(
      'e5000000-0000-4000-8000-000000000011', 0, 5, 0, null, null, 'switch to bottle-only')$$);
select testkit.assert_error('entry_type_immutable',
  $$update daily_entries
       set delivered_qty = 0, amount_collected = 0
     where id = 'e5000000-0000-4000-8000-000000000011'$$);

rollback;
reset role;

-- 4) Bottle-only notifications: dedicated OM & agent wording with returned
--    bottles and receiver, NO money, and NO credit-limit red-flag even when
--    the agent is ALREADY over credit_limit (and over deposit_limit).
begin;
update profiles set display_name = 'ဝန်ထမ်း ကိုထွန်း'
 where id = '33333333-3333-4333-8333-333333333333';
-- Force Agent A (baseline outstanding = 1350, baseline held = 5) over both
-- credit_limit (1000 < 1350) and deposit_limit (0 deposit bottles, deposit_per_bottle = 5000).
update agents
   set credit_limit = 1000,
       deposit_per_bottle = 5000
 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

-- Staff collecting empty bottles succeeds even when agent is already over
-- credit_limit and deposit_limit.
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('e5000000-0000-4000-8000-000000000020',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 100, 0,
        '33333333-3333-4333-8333-333333333333');

reset role;

-- OM gets the dedicated bottle-only notice (normal priority, no credit-limit alert, no MMK).
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '11111111-1111-4111-8111-111111111111'
             and kind = 'delivery'
             and priority = 'normal'
             and title = 'ဗူးခွံပြန်ယူ မှတ်တမ်း'
             and body = 'Test Agent A — 100 ဗူး ပြန်ယူ · လက်ခံသူ: ဝန်ထမ်း ကိုထွန်း'),
  'OM receives dedicated bottle-only notification at normal priority (no money)');

-- No high-priority / credit-limit red-flag notification was created.
select testkit.assert_true(
  not exists (select 1 from notifications
               where user_id = '11111111-1111-4111-8111-111111111111'
                 and (priority = 'high' or title like '%ကြွေးကန့်သတ်%')),
  'no credit-limit red-flag notification fires for a bottle-only row');

-- Agent gets the dedicated bottle-return receipt (mentions date, qty, receiver, no money).
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '44444444-4444-4444-8444-444444444444'
             and kind = 'receipt'
             and priority = 'normal'
             and title = 'ဗူးခွံပြန်အပ် မှတ်တမ်း'
             and body = ((now() at time zone 'Asia/Yangon')::date)::text
                        || ' — 100 ဗူး ပြန်အပ်ပြီး (ဝန်ထမ်း ကိုထွန်း လက်ခံ)'),
  'agent receives dedicated bottle-only receipt naming returned bottles and receiver');

rollback;
reset role;

-- 5) Held-bottles math via agent_held_totals() (and unchanged agent_outstanding()):
--    Agent A starts at fixture baseline held = 5 -> +245 delivery => held = 250
--    -> bottle-only return 100 => held = 150 (outstanding unchanged)
--    -> same-day edit returned 100 -> 85 => held = 165 (outstanding unchanged).
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

select testkit.assert_true(
  (select held from agent_held_totals()
    where agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 5,
  'baseline: agent A held bottles = 5');

insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('e5000000-0000-4000-8000-000000000029',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 245, 0, 0);

select testkit.assert_true(
  (select held from agent_held_totals()
    where agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 250,
  'after +245 delivery: agent A held bottles = 250');

-- Record agent_outstanding() before bottle-only return (1350 + 245 * 300 = 74850).
select set_config(
  'test.pre_return_outstanding',
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')::text,
  true
);

insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('e5000000-0000-4000-8000-000000000030',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 100, 0);

select testkit.assert_true(
  (select held from agent_held_totals()
    where agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 150,
  'after bottle-only return of 100: agent A held bottles = 150');

select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    = current_setting('test.pre_return_outstanding')::bigint,
  'after bottle-only return: agent A outstanding balance is unchanged');

select testkit.assert_true(
  (select (r->>'amount')::bigint = 0
     from edit_daily_entry(
       'e5000000-0000-4000-8000-000000000030',
       0, 85, 0, null, null, 'recount held check'
     ) as r),
  'same-day edit of bottle-only row 100 -> 85 succeeds');

select testkit.assert_true(
  (select held from agent_held_totals()
    where agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 165,
  'after editing bottle-only return 100 -> 85: agent A held bottles = 165');

select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    = current_setting('test.pre_return_outstanding')::bigint,
  'after editing bottle-only return: agent A outstanding balance stays unchanged');

rollback;
reset role;

select '22_bottle_only_collection: all assertions passed';
