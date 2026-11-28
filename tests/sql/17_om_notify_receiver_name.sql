-- 17_om_notify_receiver_name.sql — migration 0044: the OM (owner /
-- manager / co_owner) notifications for a delivery or payment now NAME
-- the receiver — the staff member who physically took the delivery /
-- cash — resolved exactly like the agent receipt does (display_name,
-- else username, of coalesce(received_by, created_by)).
--   * received_by set        -> that person is named, even when a
--                               different staff member typed the record.
--   * received_by NULL       -> falls back to created_by (the typist).
--   * Agent receipts         -> byte-identical to 0041 (unchanged).
-- Side-effect counts are read AFTER `reset role` (the AGENTS.md lesson:
-- notifications RLS hides other users' rows under a simulated role).

-- --------------------------------------------------------------------
-- Delivery WITH received_by = the staff member: the OWNER's delivery
-- notice names the staff receiver (display_name); the agent's receipt
-- keeps its exact 0041 wording.
-- --------------------------------------------------------------------
begin;
update profiles set display_name = 'ဝန်ထမ်း ကိုထွန်း'
 where id = '33333333-3333-4333-8333-333333333333';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 25, 0, 7500,
        '33333333-3333-4333-8333-333333333333');
reset role;
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '11111111-1111-4111-8111-111111111111'
             and kind = 'delivery'
             and body = 'Test Agent A — 25 ဗူး · 7,500 ကျပ် · လက်ခံသူ: ဝန်ထမ်း ကိုထွန်း'),
  'delivery OM notice names the receiver (display_name) when received_by is set');
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '44444444-4444-4444-8444-444444444444'
             and kind = 'receipt'
             and body like '%ပေးချေငွေ 7,500 ကျပ်ကို ဝန်ထမ်း ကိုထွန်း လက်ခံပြီး မှတ်တမ်းတင်ပြီးပါပြီ%'),
  'agent delivery receipt is unchanged from 0041');
rollback;
reset role;

-- --------------------------------------------------------------------
-- Delivery with received_by NULL: the OM notice falls back to
-- created_by — the staff member who typed the record is named.
-- --------------------------------------------------------------------
begin;
update profiles set display_name = 'ဝန်ထမ်း ကိုထွန်း'
 where id = '33333333-3333-4333-8333-333333333333';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 0, 0);
reset role;
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '11111111-1111-4111-8111-111111111111'
             and kind = 'delivery'
             and body = 'Test Agent A — 10 ဗူး · 3,000 ကျပ် · လက်ခံသူ: ဝန်ထမ်း ကိုထွန်း'),
  'delivery OM notice falls back to created_by when received_by is NULL');
rollback;
reset role;

-- --------------------------------------------------------------------
-- received_by <> created_by: since 0052 (M5 anti-framing), the OM
-- notice names BOTH typist and receiver (staff types, manager received).
-- --------------------------------------------------------------------
begin;
update profiles set display_name = 'မန်နေဂျာ ဒေါ်မေ'
 where id = '22222222-2222-4222-8222-222222222222';
update profiles set display_name = 'ဝန်ထမ်း ကိုထွန်း'
 where id = '33333333-3333-4333-8333-333333333333';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 5, 0, 1500,
        '22222222-2222-4222-8222-222222222222');
reset role;
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '11111111-1111-4111-8111-111111111111'
             and kind = 'delivery'
             and body = 'Test Agent B — 5 ဗူး · 1,500 ကျပ် · မှတ်တမ်းတင်သူ ဝန်ထမ်း ကိုထွန်း · လက်ခံသူ မန်နေဂျာ ဒေါ်မေ'),
  '0052 M5: delivery OM notice names both typist and receiver when they differ');
rollback;
reset role;

-- --------------------------------------------------------------------
-- Payment: the OWNER's collection notice names the receiver; the
-- agent's receipt keeps its exact 0041 wording.
-- --------------------------------------------------------------------
begin;
update profiles set display_name = 'ဝန်ထမ်း ကိုထွန်း'
 where id = '33333333-3333-4333-8333-333333333333';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into agent_payments (payment_date, agent_id, amount, method, received_by)
values ((now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5000, 'cash',
        '33333333-3333-4333-8333-333333333333');
reset role;
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '11111111-1111-4111-8111-111111111111'
             and kind = 'collection'
             and body = 'Test Agent A — 5,000 ကျပ် ရရှိ · လက်ခံသူ: ဝန်ထမ်း ကိုထွန်း'),
  'payment OM notice names the receiver (display_name) when received_by is set');
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '44444444-4444-4444-8444-444444444444'
             and kind = 'receipt'
             and body = 'ပေးချေငွေ 5,000 ကျပ်ကို ဝန်ထမ်း ကိုထွန်း လက်ခံပြီး မှတ်တမ်းတင်ပြီးပါပြီ'),
  'agent payment receipt is unchanged from 0041');
rollback;
reset role;

-- --------------------------------------------------------------------
-- Payment with received_by NULL: the OM notice falls back to
-- created_by — the staff member who typed the record is named.
-- --------------------------------------------------------------------
begin;
update profiles set display_name = 'ဝန်ထမ်း ကိုထွန်း'
 where id = '33333333-3333-4333-8333-333333333333';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into agent_payments (payment_date, agent_id, amount, method)
values ((now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 7000, 'cash');
reset role;
select testkit.assert_true(
  exists (select 1 from notifications
           where user_id = '11111111-1111-4111-8111-111111111111'
             and kind = 'collection'
             and body = 'Test Agent A — 7,000 ကျပ် ရရှိ · လက်ခံသူ: ဝန်ထမ်း ကိုထွန်း'),
  'payment OM notice falls back to created_by when received_by is NULL');
rollback;
reset role;

select '17_om_notify_receiver_name: all assertions passed';
