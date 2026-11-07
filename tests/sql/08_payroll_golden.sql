-- 08_payroll_golden.sql — pay_month (0009) golden cases, run as the
-- owner in begin/rollback:
--   Case 1 (paystaff2): base 320,000 + bonus 0 − deduction 0
--     → net 320,000.
--   Case 2 (paystaff — the 2026-11-03 live-QA figures): base 300,000
--     + bonus 20,000 − one-shot advance deduction 30,000
--     → net 290,000, with exactly one advance_repayments row of
--     30,000 written for the month.
--   Case 3: paying the same user+month twice → already_paid.
-- The month is the current Yangon month (the fixture seeds salary /
-- bonus / advance against it).

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

-- Case 1
select pay_month('77777777-7777-4777-8777-777777777777',
                 to_char(now() at time zone 'Asia/Yangon', 'YYYY-MM'));
select testkit.assert_true(
  (select net from payroll_runs
    where user_id = '77777777-7777-4777-8777-777777777777'
      and month = to_char(now() at time zone 'Asia/Yangon', 'YYYY-MM')) = 320000,
  'case 1: net = 320000');

-- Case 2
select pay_month('66666666-6666-4666-8666-666666666666',
                 to_char(now() at time zone 'Asia/Yangon', 'YYYY-MM'));
select testkit.assert_true(
  (select base from payroll_runs
    where user_id = '66666666-6666-4666-8666-666666666666'
      and month = to_char(now() at time zone 'Asia/Yangon', 'YYYY-MM')) = 300000,
  'case 2: base = 300000');
select testkit.assert_true(
  (select bonus from payroll_runs
    where user_id = '66666666-6666-4666-8666-666666666666'
      and month = to_char(now() at time zone 'Asia/Yangon', 'YYYY-MM')) = 20000,
  'case 2: bonus = 20000');
select testkit.assert_true(
  (select deduction from payroll_runs
    where user_id = '66666666-6666-4666-8666-666666666666'
      and month = to_char(now() at time zone 'Asia/Yangon', 'YYYY-MM')) = 30000,
  'case 2: deduction = 30000');
select testkit.assert_true(
  (select net from payroll_runs
    where user_id = '66666666-6666-4666-8666-666666666666'
      and month = to_char(now() at time zone 'Asia/Yangon', 'YYYY-MM')) = 290000,
  'case 2: net = 290000');
select testkit.assert_true(
  (select coalesce(sum(ar.amount), 0) from advance_repayments ar
    join advances a on a.id = ar.advance_id
    where a.user_id = '66666666-6666-4666-8666-666666666666'
      and a.amount = 30000
      and ar.month = to_char(now() at time zone 'Asia/Yangon', 'YYYY-MM')) = 30000,
  'case 2: repayment rows total 30000 for the 30000 advance');

-- Case 3: double-pay is rejected.
select testkit.assert_error('already_paid',
  $$select pay_month('66666666-6666-4666-8666-666666666666',
                     to_char(now() at time zone 'Asia/Yangon', 'YYYY-MM'))$$);

rollback;
reset role;
select '08_payroll_golden: all assertions passed';
