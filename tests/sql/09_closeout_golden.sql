-- 09_closeout_golden.sql — finalize_closeout (0006) golden case on
-- fixture agent C: 10 deposit bottles at 1,000 = 10,000 deposit held;
-- one entry 10 out / 0 back / 3,000 collected at price 300 →
-- outstanding 0. Returning all 10 bottles at today's price 1,000:
--   avg deposit price 1,000; returned-deposit value orig 10,000,
--   current 10,000 → refund 10,000, price_diff 0 (kind 'none'),
--   missing 0 → forfeit 0, net 10,000.
-- Run as the owner in begin/rollback; afterwards the agent is closed
-- and a second finalize is rejected (already_closed).

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

-- Precondition: outstanding is exactly 0 (also exercises the 0029
-- gate from the owner side).
select testkit.assert_true(
  agent_outstanding('cccccccc-cccc-4ccc-8ccc-cccccccccccc') = 0,
  'agent C outstanding = 0 before close-out');

select finalize_closeout('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 10, 1000, 'suite golden');

select testkit.assert_true(
  (select refund_amount from agent_settlements
    where agent_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') = 10000,
  'settlement refund = 10000');
select testkit.assert_true(
  (select price_diff from agent_settlements
    where agent_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') = 0,
  'settlement price_diff = 0');
select testkit.assert_true(
  (select price_diff_kind from agent_settlements
    where agent_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') = 'none',
  'settlement price_diff_kind = none');
select testkit.assert_true(
  (select closed_at is not null from agents
    where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'agent C is closed');

select testkit.assert_error('already_closed',
  $$select finalize_closeout('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 10, 1000, 'again')$$);

rollback;
reset role;
select '09_closeout_golden: all assertions passed';
