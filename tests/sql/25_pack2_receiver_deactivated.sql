-- 25_pack2_receiver_deactivated.sql — Migration 0052 (Pack 2):
--   Item 1 (M5):  guard_received_by() on daily_entries & agent_payments +
--                 edit_daily_entry() alignment + midday-deactivated receiver
--                 linked-payment rewrite edge case.
--   Item 3 (M5):  notify_on_entry() / notify_on_payment() typist + receiver
--                 wording when received_by <> created_by.
--   Item 4 (D3):  staff_directory() active-caller gate + pure-agent narrowing
--                 (coalesce(received_by, created_by)) + dual-role staff+agent.
--   Item 6 (D4b): active-profile RLS checks on app_settings, month_locks,
--                 damage_items, notifications, notify_prefs, push_tokens;
--                 profiles_select stays readable to own inactive row.
--   Item 7 (D4c): profiles_sync_auth_ban trigger (deactivate -> finite
--                 banned_until + auth.sessions deleted; reactivate -> NULL).
--   Item 8 (L1):  noti_delete dropped; client UPDATE on notifications locked
--                 to read_at only.
--   Item 9 (D5+L2): categories_select, expenses_update, expenses_delete OM-only.
--   Item 10 (M9): entries_before_write() inactive agent rejected on INSERT +
--                 credit_limit gate uses not is_owner_manager() (dual-role).

-- =========================================================================
-- 1. ITEM 1 (M5): received_by validation on daily_entries, agent_payments,
--    and edit_daily_entry(), incl. midday-deactivated receiver edge case
-- =========================================================================
begin;

-- Deactivate paystaff2 (7777…) to serve as an inactive staff target.
update profiles set active = false
 where id = '77777777-7777-4777-8777-777777777777';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

-- INSERT failures on daily_entries: inactive staff, agent profile, unknown UUID.
select testkit.assert_error('invalid_receiver',
  $$insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected, received_by)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 0, 600,
            '77777777-7777-4777-8777-777777777777')$$);
select testkit.assert_error('invalid_receiver',
  $$insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected, received_by)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 0, 600,
            '44444444-4444-4444-8444-444444444444')$$);
select testkit.assert_error('invalid_receiver',
  $$insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected, received_by)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 0, 600,
            '99999999-9999-4999-8999-999999999999')$$);

-- INSERT failures on agent_payments: inactive staff, agent profile, unknown UUID.
select testkit.assert_error('invalid_receiver',
  $$insert into agent_payments (payment_date, agent_id, amount, method, received_by)
    values ((now() at time zone 'Asia/Yangon')::date,
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 500, 'cash',
            '77777777-7777-4777-8777-777777777777')$$);
select testkit.assert_error('invalid_receiver',
  $$insert into agent_payments (payment_date, agent_id, amount, method, received_by)
    values ((now() at time zone 'Asia/Yangon')::date,
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 500, 'cash',
            '44444444-4444-4444-8444-444444444444')$$);
select testkit.assert_error('invalid_receiver',
  $$insert into agent_payments (payment_date, agent_id, amount, method, received_by)
    values ((now() at time zone 'Asia/Yangon')::date,
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 500, 'cash',
            '99999999-9999-4999-8999-999999999999')$$);

-- Valid inserts: active staff, Owner as receiver, and NULL (CloseoutPage / legacy offline).
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('e5200000-0000-4000-8000-000000000001',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 3, 0, 900,
        '11111111-1111-4111-8111-111111111111');
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected)
values ('e5200000-0000-4000-8000-000000000002',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 0, 600);
insert into agent_payments (id, payment_date, agent_id, amount, method, received_by)
values ('e5200000-0000-4000-8000-000000000003',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 400, 'cash',
        '11111111-1111-4111-8111-111111111111');
insert into agent_payments (id, payment_date, agent_id, amount, method)
values ('e5200000-0000-4000-8000-000000000004',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 300, 'cash');

-- UPDATE failures on daily_entries, agent_payments, and edit_daily_entry().
select testkit.assert_error('invalid_receiver',
  $$update daily_entries set received_by = '77777777-7777-4777-8777-777777777777'
     where id = 'e5200000-0000-4000-8000-000000000001'$$);
select testkit.assert_error('invalid_receiver',
  $$update agent_payments set received_by = '44444444-4444-4444-8444-444444444444'
     where id = 'e5200000-0000-4000-8000-000000000003'$$);
select testkit.assert_error('invalid_receiver',
  $$select edit_daily_entry(
      'e5200000-0000-4000-8000-000000000001',
      3, 0, 900,
      '77777777-7777-4777-8777-777777777777',
      'bad receiver', 'change to inactive')$$);
select testkit.assert_error('invalid_receiver',
  $$select edit_daily_entry(
      'e5200000-0000-4000-8000-000000000001',
      3, 0, 900,
      '44444444-4444-4444-8444-444444444444',
      'bad receiver', 'change to agent')$$);
select testkit.assert_error('invalid_receiver',
  $$select edit_daily_entry(
      'e5200000-0000-4000-8000-000000000001',
      3, 0, 900,
      '99999999-9999-4999-8999-999999999999',
      'bad receiver', 'change to unknown')$$);

-- CRITICAL EDGE CASE: Staff B (paystaff 6666…) receives cash + linked payment
-- in the morning, is deactivated at midday, then OM edits quantity/cash in
-- the evening with receiver UNCHANGED -> edit_daily_entry() rewrites linked
-- payments via DELETE + INSERT and MUST SUCCEED; changing receiver to another
-- inactive profile (7777…) MUST STILL FAIL.
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('e5200000-0000-4000-8000-000000000010',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, 0, 1500,
        '66666666-6666-4666-8666-666666666666');
insert into agent_payments (id, payment_date, agent_id, amount, method, kind, received_by, source_entry_id)
values ('e5200000-0000-4000-8000-000000000011',
        (now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 500, 'cash', 'old_debt',
        '66666666-6666-4666-8666-666666666666',
        'e5200000-0000-4000-8000-000000000010');

-- Midday: Owner deactivates Staff B (6666…).
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
update profiles set active = false
 where id = '66666666-6666-4666-8666-666666666666';

-- Evening: OM edits qty + cash (triggers DELETE + INSERT of linked payments)
-- keeping receiver = 6666… unchanged -> MUST SUCCEED!
do $$
declare v_res jsonb;
begin
  v_res := edit_daily_entry(
    'e5200000-0000-4000-8000-000000000010',
    6, 0, 2500,
    '66666666-6666-4666-8666-666666666666',
    'evening fix', 'qty recount'
  );
  if (v_res ->> 'to_old')::bigint <> 650 or (v_res ->> 'advance')::bigint <> 50 then
    raise exception 'ASSERT FAILED: expected to_old=650, advance=50, got %', v_res;
  end if;
end $$;

-- Still cannot switch that entry's receiver to a DIFFERENT inactive profile (7777…).
select testkit.assert_error('invalid_receiver',
  $$select edit_daily_entry(
      'e5200000-0000-4000-8000-000000000010',
      6, 0, 2500,
      '77777777-7777-4777-8777-777777777777',
      'switch', 'bad switch')$$);

-- Also verify multi-role user (primary agent 4444… + extra staff role in
-- user_roles) is accepted as received_by (matches staff_directory role logic).
reset role;
insert into user_roles (profile_id, role)
values ('44444444-4444-4444-8444-444444444444', 'staff');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into agent_payments (payment_date, agent_id, amount, method, received_by)
values ((now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 200, 'cash',
        '44444444-4444-4444-8444-444444444444');

rollback;
reset role;

-- =========================================================================
-- 2. ITEM 3 (M5 anti-framing): notifications name typist + receiver when
--    different, and keep single-name format when same person / NULL
-- =========================================================================
begin;
update profiles set display_name = 'ဦးပိုင်ရှင်'
 where id = '11111111-1111-4111-8111-111111111111';
update profiles set display_name = 'ဝန်ထမ်း ကိုထွန်း'
 where id = '33333333-3333-4333-8333-333333333333';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

-- Staff records delivery naming Owner as receiver -> BOTH OM and agent see typist + receiver.
insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 0, 3000,
        '11111111-1111-4111-8111-111111111111');
-- Staff records bottle-only naming Owner as receiver -> BOTH OM and agent see typist + receiver.
insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 4, 0,
        '11111111-1111-4111-8111-111111111111');
-- Staff records payment naming Owner as receiver -> BOTH OM and agent see typist + receiver.
insert into agent_payments (payment_date, agent_id, amount, method, received_by)
values ((now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2000, 'cash',
        '11111111-1111-4111-8111-111111111111');

reset role;
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '11111111-1111-4111-8111-111111111111'
             and kind = 'delivery'
             and body = 'Test Agent A — 10 ဗူး · 3,000 ကျပ် · မှတ်တမ်းတင်သူ ဝန်ထမ်း ကိုထွန်း · လက်ခံသူ ဦးပိုင်ရှင်'),
  'M5 anti-framing: OM delivery notice names both typist and receiver');
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '44444444-4444-4444-8444-444444444444'
             and kind = 'receipt'
             and body like '%မှတ်တမ်းတင်သူ ဝန်ထမ်း ကိုထွန်း · လက်ခံသူ ဦးပိုင်ရှင်%'),
  'M5 anti-framing: agent delivery receipt names both typist and receiver');
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '11111111-1111-4111-8111-111111111111'
             and kind = 'delivery'
             and body = 'Test Agent A — 4 ဗူး ပြန်ယူ · မှတ်တမ်းတင်သူ ဝန်ထမ်း ကိုထွန်း · လက်ခံသူ ဦးပိုင်ရှင်'),
  'M5 anti-framing: OM bottle-only notice names both typist and receiver');
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '44444444-4444-4444-8444-444444444444'
             and kind = 'receipt'
             and body like '%4 ဗူး ပြန်အပ်ပြီး (မှတ်တမ်းတင်သူ ဝန်ထမ်း ကိုထွန်း · လက်ခံသူ ဦးပိုင်ရှင်)%'),
  'M5 anti-framing: agent bottle-only receipt names both typist and receiver');
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '11111111-1111-4111-8111-111111111111'
             and kind = 'collection'
             and body = 'Test Agent A — 2,000 ကျပ် ရရှိ · မှတ်တမ်းတင်သူ ဝန်ထမ်း ကိုထွန်း · လက်ခံသူ ဦးပိုင်ရှင်'),
  'M5 anti-framing: OM payment notice names both typist and receiver');
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '44444444-4444-4444-8444-444444444444'
             and kind = 'receipt'
             and body = 'ပေးချေငွေ 2,000 ကျပ် · မှတ်တမ်းတင်သူ ဝန်ထမ်း ကိုထွန်း · လက်ခံသူ ဦးပိုင်ရှင်'),
  'M5 anti-framing: agent payment receipt names both typist and receiver');

rollback;
reset role;

-- =========================================================================
-- 3. ITEM 4 (D3): staff_directory() gate — deactivated denied, pure agent
--    narrowed to own referenced receivers, dual-role staff+agent keeps full
-- =========================================================================
begin;

-- Deactivate paystaff2 (7777…).
update profiles set active = false
 where id = '77777777-7777-4777-8777-777777777777';

-- Plant one entry for Agent A with received_by NULL (created_by = staff 3333…)
-- and one payment for Agent B with received_by = manager 2222….
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 0, 300);
insert into agent_payments (payment_date, agent_id, amount, method, received_by)
values ((now() at time zone 'Asia/Yangon')::date,
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 500, 'cash',
        '22222222-2222-4222-8222-222222222222');

-- Deactivated caller gets 42501 error (never the roster).
select set_config('request.jwt.claims', '{"sub":"77777777-7777-4777-8777-777777777777"}', true);
select testkit.assert_error('staff_directory: not allowed',
  $$select * from staff_directory()$$);

-- Pure agentA sees ONLY staff 3333… (resolved via created_by fallback), NOT manager/owner/others.
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_true(
  (select count(*) from staff_directory()) = 1
  and exists (select 1 from staff_directory() where id = '33333333-3333-4333-8333-333333333333'),
  'D3: pure agentA sees only receiver referenced via created_by fallback (1 row, not full roster)');

-- Grant dual-role staff to agentA -> dual-role staff+agent gets FULL roster (5 rows).
reset role;
insert into user_roles (profile_id, role)
values ('44444444-4444-4444-8444-444444444444', 'staff');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_true(
  (select count(*) from staff_directory()) = 6,
  'D3: dual-role staff+agent keeps full non-agent directory (5 fixture + self)');

rollback;
reset role;

-- =========================================================================
-- 4. ITEM 6 (D4b) + ITEM 8 (L1): RLS active checks + lock notifications
-- =========================================================================
begin;

-- Seed a damage item, notification, notify_pref, and push_token for t_staff (3333…).
insert into damage_items (id, name, unit_price, active)
values ('e5200000-0000-4000-8000-000000000050', 'အဖုံးကွဲ', 500, true);
insert into notifications (id, user_id, kind, title, body, link)
values ('e5200000-0000-4000-8000-000000000051',
        '33333333-3333-4333-8333-333333333333', 'delivery', 'Test', 'Original body', '/entries');
insert into notify_prefs (user_id, mode, quiet_night)
values ('33333333-3333-4333-8333-333333333333', 'all', true);
insert into push_tokens (id, profile_id, token, platform)
values ('e5200000-0000-4000-8000-000000000052',
        '33333333-3333-4333-8333-333333333333', 'tok-staff-test-52', 'android');

-- Active staff: can read app_settings, month_locks, active damage_items, own notifications;
-- CAN update read_at on own notification; CANNOT update body/title; CANNOT delete notification.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

select testkit.assert_true((select count(*) from app_settings) > 0, 'D4b: active staff reads app_settings');
select testkit.assert_true((select count(*) from month_locks) > 0, 'D4b: active staff reads month_locks');
select testkit.assert_true((select count(*) from damage_items) > 0, 'D4b: active staff reads active damage_items');
select testkit.assert_true((select count(*) from notifications) = 1, 'D4b: active staff reads own notifications');

-- Bell mark-as-read (read_at only) -> MUST SUCCEED.
update notifications set read_at = now()
 where id = 'e5200000-0000-4000-8000-000000000051';

-- L1: updating any other column on notifications -> MUST FAIL.
select testkit.assert_error('notification_read_at_only',
  $$update notifications set body = 'tampered'
     where id = 'e5200000-0000-4000-8000-000000000051'$$);
select testkit.assert_error('notification_read_at_only',
  $$update notifications set title = 'tampered'
     where id = 'e5200000-0000-4000-8000-000000000051'$$);

-- L1: noti_delete dropped -> DELETE affects 0 rows.
do $$
declare n int;
begin
  delete from notifications where id = 'e5200000-0000-4000-8000-000000000051';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ASSERT FAILED: client deleted % notifications', n; end if;
end $$;

-- Active agentA still reads active damage_items prices.
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_true((select count(*) from damage_items) >= 1, 'D4b: active agent reads active damage_items');

-- Now deactivate t_staff (3333…) -> loses SELECT/WRITE on settings, locks,
-- damage_items, notifications, notify_prefs, push_tokens — while profiles_select
-- STILL returns own inactive row so sign-in can display the disabled message!
reset role;
update profiles set active = false
 where id = '33333333-3333-4333-8333-333333333333';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

select testkit.assert_true((select count(*) from app_settings) = 0, 'D4b: deactivated staff sees 0 app_settings');
select testkit.assert_true((select count(*) from month_locks) = 0, 'D4b: deactivated staff sees 0 month_locks');
select testkit.assert_true((select count(*) from damage_items) = 0, 'D4b: deactivated staff sees 0 damage_items');
select testkit.assert_true((select count(*) from notifications) = 0, 'D4b: deactivated staff sees 0 notifications');
select testkit.assert_true((select count(*) from notify_prefs) = 0, 'D4b: deactivated staff sees 0 notify_prefs');
select testkit.assert_true((select count(*) from push_tokens) = 0, 'D4b: deactivated staff sees 0 push_tokens');

select testkit.assert_error('new row violates row-level security',
  $$insert into push_tokens (profile_id, token, platform)
    values ('33333333-3333-4333-8333-333333333333', 'tok-blocked', 'android')$$);

-- CRITICAL: profiles_select MUST still return own inactive row for signIn() error display.
select testkit.assert_true(
  exists (select 1 from profiles where id = '33333333-3333-4333-8333-333333333333' and active = false),
  'D4b: deactivated user can still read own profiles row so signIn shows disabled message');

rollback;
reset role;

-- =========================================================================
-- 5. ITEM 7 (D4c): profiles_sync_auth_ban trigger
-- =========================================================================
begin;

-- Seed an active auth.sessions row for t_staff (3333…).
insert into auth.sessions (id, user_id)
values ('e5200000-0000-4000-8000-000000000060', '33333333-3333-4333-8333-333333333333');

-- Owner deactivates t_staff via normal profiles.update({ active: false }).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
update profiles set active = false
 where id = '33333333-3333-4333-8333-333333333333';

reset role;
select testkit.assert_true(
  (select banned_until from auth.users where id = '33333333-3333-4333-8333-333333333333')
    = timestamptz '2999-12-31 00:00:00+00',
  'D4c: deactivation sets finite auth.users.banned_until = 2999-12-31');
select testkit.assert_true(
  (select count(*) from auth.sessions where user_id = '33333333-3333-4333-8333-333333333333') = 0,
  'D4c: deactivation deletes auth.sessions rows');

-- Owner reactivates t_staff -> banned_until cleared to NULL.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
update profiles set active = true
 where id = '33333333-3333-4333-8333-333333333333';

reset role;
select testkit.assert_true(
  (select banned_until from auth.users where id = '33333333-3333-4333-8333-333333333333') is null,
  'D4c: reactivation clears auth.users.banned_until to NULL');

rollback;
reset role;

-- =========================================================================
-- 6. ITEM 9 (D5 + L2): expense_categories & expenses OM-only
-- =========================================================================
begin;
set local role authenticated;

-- Staff sees 0 expense_categories rows.
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_true(
  (select count(*) from expense_categories) = 0,
  'D5: staff sees 0 expense_categories rows');

-- Owner & Manager still read expense_categories and manage expenses.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
select testkit.assert_true(
  (select count(*) from expense_categories) >= 1,
  'D5: manager reads expense_categories');
insert into expenses (id, category_id, title, amount)
values ('e5200000-0000-4000-8000-000000000070',
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Pack2 test exp', 1000);
update expenses set amount = 1200 where id = 'e5200000-0000-4000-8000-000000000070';
delete from expenses where id = 'e5200000-0000-4000-8000-000000000070';

rollback;
reset role;

-- =========================================================================
-- 7. ITEM 10 (M9): inactive-agent INSERT rejection & dual-role credit_limit
-- =========================================================================
begin;

-- Deactivate Agent B (active = false, closed_at NULL) and give Agent A
-- credit_limit = 2000 (baseline outstanding = 1350).
update agents set active = false where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
update agents set credit_limit = 2000 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
-- Grant extra role 'staff' to primary-agent account 4444… (dual-role agent+staff).
insert into user_roles (profile_id, role)
values ('44444444-4444-4444-8444-444444444444', 'staff');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

-- Staff inserting delivery for inactive Agent B -> MUST FAIL (agent_inactive).
select testkit.assert_error('agent_inactive',
  $$insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2, 0, 600)$$);

-- Dual-role agent+staff (4444…) trying to exceed credit_limit on Agent A
-- (1350 + 5*300 = 2850 > 2000) -> MUST FAIL (credit_limit)!
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_error('credit_limit',
  $$insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, 0, 0)$$);

-- OM (owner/manager) is still exempt from credit_limit on delivery insert.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, 0, 0);

rollback;
reset role;

-- =========================================================================
-- 8. GRANT HYGIENE: new trigger functions revoked from PUBLIC/anon/auth
-- =========================================================================
select testkit.assert_true(
  not has_function_privilege('authenticated', 'public.guard_received_by()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.guard_notification_update()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.sync_profile_active_to_auth()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.notify_on_entry()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.notify_on_payment()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.entries_before_write()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.staff_directory()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.staff_directory()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.edit_daily_entry(uuid,integer,integer,bigint,uuid,text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.edit_daily_entry(uuid,integer,integer,bigint,uuid,text,text)', 'EXECUTE'),
  '0052 grant hygiene: trigger functions revoked; RPCs authenticated-only');

select '25_pack2_receiver_deactivated: all assertions passed';
