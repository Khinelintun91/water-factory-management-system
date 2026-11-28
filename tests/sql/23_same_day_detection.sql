-- 23_same_day_detection.sql — migration 0050 (Package A):
--   * send_daily_digest():
--       - today's cash includes daily_entries.amount_collected + linked &
--         standalone agent_payments for today
--       - total outstanding matches sum(agent_outstanding(a.id)) across all
--         agents, including - write_offs and + agent_damage_charges
--       - uses ကျသင့်ငွေ (never ရောင်းရငွေ/ရောင်းအား) and ဗူး (never ပုလင်း)
--       - delivered to OM recipients with notify_prefs.mode = 'important'
--         (only alert_digest = false skips); deduped by 'digest-' || today
--       - includes per-receiver cash totals, standalone payment count/sum,
--         same-day edit/delete counts, and handover mismatches (omitted when none)
--   * run_data_quality_alerts() + 18:30 Yangon cron job:
--       - both 'wfms-data-quality' (0 2 * * *) and 'wfms-data-quality-evening'
--         (0 12 * * *) are registered in cron.job
--       - flags duplicate entries within 15 minutes, negative held bottles,
--         and delivered_qty > 2000
--       - re-running does not double-alert (dq_seen + per-issue tags).

-- 1) Grants, search_path, and pg_cron schedules.
select testkit.assert_true(
  not has_function_privilege('authenticated', 'public.send_daily_digest()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.send_daily_digest()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.run_data_quality_alerts()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.run_data_quality_alerts()', 'EXECUTE'),
  '0050: send_daily_digest and run_data_quality_alerts remain closed to clients');

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
     and p.proname in ('send_daily_digest', 'run_data_quality_alerts')),
  '0050: both functions pin search_path = public');

select testkit.assert_true(
  exists (select 1 from cron.job where jobname = 'wfms-data-quality' and schedule = '0 2 * * *')
  and exists (select 1 from cron.job where jobname = 'wfms-data-quality-evening' and schedule = '0 12 * * *'),
  '0050: both 08:30 Yangon (0 2 * * *) and 18:30 Yangon (0 12 * * *) cron jobs are scheduled');

-- 2) send_daily_digest(): cash (entry + linked + standalone), outstanding
--    (including damage charge + write-off), mode='important' recipient still
--    receives, alert_digest=false skipped, reconciliation lines + mismatches,
--    and idempotent dedupe.
begin;
update profiles set display_name = 'ဝန်ထမ်း အေ'
 where id = '33333333-3333-4333-8333-333333333333';
update profiles set display_name = 'မန်နေဂျာ ဘီ'
 where id = '22222222-2222-4222-8222-222222222222';

-- Owner sets mode = 'important' (alert_digest remains true) -> MUST receive.
-- Manager sets alert_digest = false -> MUST be skipped.
insert into notify_prefs (user_id, mode, alert_digest)
values
  ('11111111-1111-4111-8111-111111111111', 'important', true),
  ('22222222-2222-4222-8222-222222222222', 'all', false)
on conflict (user_id) do update
  set mode = excluded.mode,
      alert_digest = excluded.alert_digest;

-- Add a damage item + damage charge (+15,000) and a write-off (-5,000) as Owner.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

insert into damage_items (id, name, unit_price, active)
values ('d5000000-0000-4000-8000-000000000001', 'ဗူးကွဲ', 5000, true);

insert into agent_damage_charges (agent_id, item_id, qty, charge_date)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'd5000000-0000-4000-8000-000000000001', 3,
        (now() at time zone 'Asia/Yangon')::date);

insert into write_offs (agent_id, writeoff_date, amount, note)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        (now() at time zone 'Asia/Yangon')::date, 5000, 'test writeoff');

-- Staff A creates a delivery entry (cash 20,000) + linked payment (80,000)
-- + edits it once, and Manager takes a standalone payment (50,000).
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('e6000000-0000-4000-8000-000000000001',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 100, 0, 20000,
        '33333333-3333-4333-8333-333333333333');

insert into agent_payments (payment_date, agent_id, amount, method, kind, received_by, source_entry_id)
values ((now() at time zone 'Asia/Yangon')::date,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 80000, 'cash', 'old_debt',
        '33333333-3333-4333-8333-333333333333',
        'e6000000-0000-4000-8000-000000000001');

-- Create and delete a temporary entry today so audit_log has a same-day delete,
-- and edit the first entry's notes so audit_log has a same-day update.
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('e6000000-0000-4000-8000-000000000002',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, 0, 0,
        '33333333-3333-4333-8333-333333333333');
delete from daily_entries where id = 'e6000000-0000-4000-8000-000000000002';

update daily_entries
   set notes = 'checked', change_reason = 'note fix'
 where id = 'e6000000-0000-4000-8000-000000000001';

-- Standalone payment (50,000) received by Manager B.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
insert into agent_payments (payment_date, agent_id, amount, method, kind, received_by)
values ((now() at time zone 'Asia/Yangon')::date,
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 50000, 'cash', 'regular',
        '22222222-2222-4222-8222-222222222222');

-- Manager B records a mismatched handover (received 40,000 vs expected 50,000);
-- Staff A has NO handover row yet (expected 100,000).
insert into cash_handovers (handover_date, employee_id, expected, received, received_by)
values ((now() at time zone 'Asia/Yangon')::date,
        '22222222-2222-4222-8222-222222222222', 50000, 40000,
        '11111111-1111-4111-8111-111111111111');

reset role;

-- Compute expected total outstanding across all agents via agent_outstanding().
select set_config(
  'test.expected_outstanding',
  (select coalesce(sum(agent_outstanding(a.id)), 0)::text from agents a),
  true
);

-- Also compute today's fixture entry cash + our 20k + 80k + 50k (fixture has
-- Agent C today entry with amount_collected = 3000 -> total today cash = 153,000).
select set_config(
  'test.expected_today_cash',
  (
    coalesce((select sum(amount_collected) from daily_entries
               where entry_date = (now() at time zone 'Asia/Yangon')::date), 0)
    + coalesce((select sum(amount) from agent_payments
                 where payment_date = (now() at time zone 'Asia/Yangon')::date), 0)
  )::text,
  true
);

select public.send_daily_digest();
-- Second call on same day must be deduped by 'digest-' || today.
select public.send_daily_digest();

-- Owner (mode='important') receives exactly 1 digest; Manager (alert_digest=false) receives 0.
select testkit.assert_true(
  (select count(*) from notifications
    where user_id = '11111111-1111-4111-8111-111111111111'
      and kind = 'digest'
      and tag = 'digest-' || (now() at time zone 'Asia/Yangon')::date) = 1,
  'owner with mode=important receives exactly one digest (deduped)');

select testkit.assert_true(
  not exists (select 1 from notifications
               where user_id = '22222222-2222-4222-8222-222222222222'
                 and kind = 'digest'
                 and tag = 'digest-' || (now() at time zone 'Asia/Yangon')::date),
  'manager with alert_digest=false is skipped');

-- Verify digest body content: terminology, today cash (incl. linked + standalone),
-- total outstanding (= sum of agent_outstanding incl. damage + write-off),
-- per-receiver breakdown, standalone payment line, edits/deletes, handover mismatches.
select testkit.assert_true(
  exists (
    select 1 from notifications
     where user_id = '11111111-1111-4111-8111-111111111111'
       and kind = 'digest'
       and tag = 'digest-' || (now() at time zone 'Asia/Yangon')::date
       and body like '%ကျသင့်ငွေ%'
       and body not like '%ရောင်းရငွေ%'
       and body not like '%ရောင်းအား%'
       and body not like '%ပုလင်း%'
       and body like '%လက်ခံရငွေ '
           || to_char(current_setting('test.expected_today_cash')::bigint, 'FM999,999,999,999')
           || ' ကျပ်%'
       and body like '%ကြွေးကျန် စုစုပေါင်း '
           || to_char(current_setting('test.expected_outstanding')::bigint, 'FM999,999,999,999')
           || ' ကျပ်%'
       and body like '%လက်ခံသူအလိုက်:%ဝန်ထမ်း အေ 100,000%'
       and body like '%မန်နေဂျာ ဘီ 50,000%'
       and body like '%သီးသန့်ငွေကောက်: 1 ခု (50,000 ကျပ်)%'
       and body like '%ပြင်/ဖျက်: ပြင် 1 · ဖျက် 1%'
       and body like '%ငွေအပ်ကွာဟ:%ဝန်ထမ်း အေ (100,000/မအပ်ရသေး)%'
       and body like '%မန်နေဂျာ ဘီ (50,000/40,000)%'
  ),
  'digest body includes exact cash, outstanding, terminology, and reconciliation lines');

rollback;
reset role;

-- 3) send_daily_digest(): omits handover-mismatch section when all handovers match.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
insert into daily_entries (agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 0, 3000,
        '33333333-3333-4333-8333-333333333333');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
insert into cash_handovers (handover_date, employee_id, expected, received, received_by)
values ((now() at time zone 'Asia/Yangon')::date,
        '33333333-3333-4333-8333-333333333333', 3000, 3000,
        '11111111-1111-4111-8111-111111111111');
reset role;

select public.send_daily_digest();

select testkit.assert_true(
  exists (
    select 1 from notifications
     where user_id = '11111111-1111-4111-8111-111111111111'
       and kind = 'digest'
       and tag = 'digest-' || (now() at time zone 'Asia/Yangon')::date
       and body not like '%ငွေအပ်ကွာဟ%'
  ),
  'digest omits handover mismatch section when all handovers match');

rollback;
reset role;

-- 4) run_data_quality_alerts(): same-day duplicate pair (within 15 min),
--    negative held bottles, delivered_qty > 2000, and no double-alert on rerun.
begin;
-- Silence unrelated backup_stale check by recording a fresh backup timestamp.
insert into app_settings (key, value)
values ('last_backup_at', to_jsonb(now()::text))
on conflict (key) do update set value = excluded.value;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);

-- (a) Duplicate pair within 15 minutes for Agent B (same delivered/returned/cash).
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values
  ('e6000000-0000-4000-8000-000000000010',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 15, 5, 4500,
   '33333333-3333-4333-8333-333333333333'),
  ('e6000000-0000-4000-8000-000000000011',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 15, 5, 4500,
   '33333333-3333-4333-8333-333333333333');

-- (b) Negative held bottles for Agent A (baseline held = 5 -> bottle-only return 100 => -95).
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('e6000000-0000-4000-8000-000000000012',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 100, 0,
        '33333333-3333-4333-8333-333333333333');

-- (c) Extreme delivered qty (> 2000) for Agent B.
insert into daily_entries (id, agent_id, delivered_qty, returned_qty, amount_collected, received_by)
values ('e6000000-0000-4000-8000-000000000013',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2500, 0, 0,
        '33333333-3333-4333-8333-333333333333');

reset role;

-- First run (simulates 18:30 Yangon evening check).
select public.run_data_quality_alerts();
-- Second run (simulates 08:30 Yangon next check -> must NOT double-alert).
select public.run_data_quality_alerts();

-- Duplicate pair flagged exactly once for Owner.
select testkit.assert_true(
  (select count(*) from notifications
    where user_id = '11111111-1111-4111-8111-111111111111'
      and kind = 'data_quality'
      and tag = 'dqdup-e6000000-0000-4000-8000-000000000011'
      and body like '%ထပ်တူမှတ်တမ်း သံသယ%Test Agent B%') = 1,
  'same-day duplicate entry pair flagged once without double-alert');

-- Negative held bottles flagged exactly once for Owner.
select testkit.assert_true(
  (select count(*) from notifications
    where user_id = '11111111-1111-4111-8111-111111111111'
      and kind = 'data_quality'
      and tag = 'dqheld-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-' || (now() at time zone 'Asia/Yangon')::date
      and body like '%ကိုင်ထားဗူး အနုတ်ဖြစ်နေသည်%Test Agent A%-95 ဗူး%') = 1,
  'negative held bottles flagged once without double-alert');

-- delivered_qty > 2000 flagged exactly once for Owner.
select testkit.assert_true(
  (select count(*) from notifications
    where user_id = '11111111-1111-4111-8111-111111111111'
      and kind = 'data_quality'
      and tag = 'dqqty-e6000000-0000-4000-8000-000000000013'
      and body like '%ပို့သည့်ဗူး အလွန်များနေသည်%Test Agent B%2,500 ဗူး%') = 1,
  'delivered_qty > 2000 flagged once without double-alert');

rollback;
reset role;

select '23_same_day_detection: all assertions passed';
