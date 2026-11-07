-- 07_agent_outstanding_gate.sql — 0029: agent_outstanding(uuid)
-- rejects a JWT caller who is neither staff-plus nor the agent
-- themself ('forbidden'), preserving SPEC rule 1 through the RPC
-- door. Legitimate callers keep the pre-0029 values:
--   agent A outstanding = entries(600 yesterday + 600 today + 300
--     locked-month) − payments 100 − write-offs 50 = 1350
--   agent B outstanding = 900 (today's 3 × 300, nothing collected)

-- Agent A asking for agent B: forbidden.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_error('forbidden',
  $$select agent_outstanding('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')$$);
-- Agent A asking for their OWN balance: works, exact value.
select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 1350,
  'agent A own outstanding = 1350');
rollback;
reset role;

-- Staff / manager / owner: any agent, exact values.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_true(
  agent_outstanding('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') = 900,
  'staff reads agent B outstanding = 900');
rollback;
reset role;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select testkit.assert_true(
  agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 1350,
  'owner reads agent A outstanding = 1350');
rollback;
reset role;

-- Anon: no EXECUTE grant at all (0026/0028/0029).
begin;
set local role anon;
select testkit.assert_error('permission denied',
  $$select agent_outstanding('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$$);
rollback;
reset role;

select '07_agent_outstanding_gate: all assertions passed';
