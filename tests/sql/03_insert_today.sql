-- 03_insert_today.sql — insert-date guard (0004 + the 0018 owner
-- exception + the 0027 extension to write_offs / advances /
-- cash_handovers): a record must be dated TODAY (Asia/Yangon) unless
-- the caller is the PRIMARY owner. Co-owner/manager/staff backdating
-- is rejected. All scenarios inside begin/rollback.

-- Staff: backdated entry rejected.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_error('same_day_only',
  $$insert into daily_entries (entry_date, agent_id, delivered_qty, returned_qty, amount_collected)
    values (((now() at time zone 'Asia/Yangon')::date - 1),
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 1, 300)$$);
rollback;
reset role;

-- Manager: backdated entry rejected (the exception is owner-only).
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
select testkit.assert_error('same_day_only',
  $$insert into daily_entries (entry_date, agent_id, delivered_qty, returned_qty, amount_collected)
    values (((now() at time zone 'Asia/Yangon')::date - 1),
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 1, 300)$$);
-- 0027 tables as manager: backdated write-off / advance / handover.
select testkit.assert_error('same_day_only',
  $$insert into write_offs (writeoff_date, agent_id, amount, note)
    values (((now() at time zone 'Asia/Yangon')::date - 1),
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, 'backdated')$$);
select testkit.assert_error('same_day_only',
  $$insert into cash_handovers (handover_date, employee_id, expected, received)
    values (((now() at time zone 'Asia/Yangon')::date - 1),
            '66666666-6666-4666-8666-666666666666', 1, 1)$$);
rollback;
reset role;

-- Owner: the SAME backdated entry is allowed (0018 exception; the
-- month is not locked). Rolled back like everything else.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
insert into daily_entries (entry_date, agent_id, delivered_qty, returned_qty, amount_collected)
values (((now() at time zone 'Asia/Yangon')::date - 1),
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 1, 300);
rollback;
reset role;

select '03_insert_today: all assertions passed';
