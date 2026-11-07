-- 04_agent_isolation.sql — SPEC rules 1 + 2, enforced by RLS:
-- an agent sees ONLY their own data; staff see agent names/codes but
-- NEVER phone numbers (agent_contacts has no staff policy at all).
-- Counts are read INSIDE the simulated role, in begin/rollback blocks
-- (the AGENTS.md lesson: side-effect/visibility counts must be read
-- while the role is active, and owner-side comparisons after
-- reset role).

-- Agent A: sees exactly their own entries (3 fixture rows: yesterday,
-- today, and the locked-month one) and nothing of agent B's; exactly
-- 1 contact row (their own).
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_true(
  (select count(*) from daily_entries) = 3, 'agent A sees exactly 3 entries');
select testkit.assert_true(
  (select count(*) from daily_entries
    where agent_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') = 0,
  'agent A sees 0 of agent B entries');
select testkit.assert_true(
  (select count(*) from agent_contacts) = 1, 'agent A sees exactly 1 contact row');
select testkit.assert_true(
  (select phone from agent_contacts) = '09000000001', 'agent A contact is their own');
rollback;
reset role;

-- Staff: entries visible (their job), contacts INVISIBLE (SPEC rule 2).
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_true(
  (select count(*) from agent_contacts) = 0, 'staff sees 0 contact rows');
select testkit.assert_true(
  (select count(*) from daily_entries) >= 2, 'staff can read entries');
rollback;
reset role;

-- Manager: contacts visible (owner/manager may see all numbers).
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
select testkit.assert_true(
  (select count(*) from agent_contacts) = 2, 'manager sees both contact rows');
rollback;
reset role;

select '04_agent_isolation: all assertions passed';
