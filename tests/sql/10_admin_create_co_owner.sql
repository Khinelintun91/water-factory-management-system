-- 10_admin_create_co_owner.sql — 0030 admin_create_user / admin_reset_pin.
-- co_owner is an accepted primary role with the manager PIN minimum
-- (6 digits, max 12). Unknown roles stay rejected. The caller must be
-- an active primary owner. Staff/agent stay at 4 digits; owner and
-- manager stay at 6. Run as the fixture owner inside begin/rollback.

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

-- Six-digit boundary: 6 succeeds. An agent id argument is ignored
-- because co_owner is not an agent login.
select testkit.assert_true(
  (admin_create_user(
     't_co6', '123456', 'co_owner',
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Test Co'
   ) ->> 'role') = 'co_owner',
  'owner can create a co_owner with a 6-digit PIN');

select testkit.assert_true(
  (select role = 'co_owner' and agent_id is null and active and display_name = 'Test Co'
     from profiles where username = 't_co6'),
  'co_owner profile is primary co_owner, active, no agent link');

-- auth.users is not granted to authenticated. Read it as the session
-- owner, then return to the simulated owner.
reset role;
select testkit.assert_true(
  (select email = 't_co6@waterfactory.local'
     from auth.users where id = (select id from profiles where username = 't_co6')),
  'co_owner auth email is the synthetic username address');
select testkit.assert_true(
  (select count(*) from auth.identities i
     join profiles p on p.id = i.user_id
    where p.username = 't_co6' and i.provider = 'email') = 1,
  'co_owner has one email identity');
set local role authenticated;

-- Manager-equivalence helpers already treat primary co_owner as manager.
-- The account-creation gate does not: co_owner is not an owner.
select set_config(
  'request.jwt.claims',
  (select json_build_object('sub', id)::text from profiles where username = 't_co6'),
  true);
select testkit.assert_true(app_role() = 'co_owner', 'app_role() stays co_owner');
select testkit.assert_true(has_role('co_owner'), 'has_role(co_owner)');
select testkit.assert_true(has_role('manager'), 'has_role(manager) via co_owner');
select testkit.assert_true(not has_role('owner'), 'co_owner is not an owner');
select testkit.assert_true(is_owner_manager(), 'is_owner_manager() counts co_owner');
select testkit.assert_error('owner_only',
  $$select admin_create_user('t_nope', '123456', 'staff', null, null)$$);

-- Back to the fixture owner for the rejection and boundary cases.
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

select testkit.assert_error('pin_must_be_6_to_12_digits',
  $$select admin_create_user('t_co5', '12345', 'co_owner', null, null)$$);
select testkit.assert_error('pin_must_be_6_to_12_digits',
  $$select admin_create_user('t_co4', '1234', 'co_owner', null, null)$$);
select testkit.assert_error('pin_must_be_6_to_12_digits',
  $$select admin_create_user('t_co13', '1234567890123', 'co_owner', null, null)$$);
select testkit.assert_error('invalid_role',
  $$select admin_create_user('t_bad', '123456', 'employee', null, null)$$);
select testkit.assert_error('invalid_role',
  $$select admin_create_user('t_bad2', '123456', 'primary_agent', null, null)$$);

-- Unrelated PIN rules stay put.
select testkit.assert_error('pin_must_be_6_to_12_digits',
  $$select admin_create_user('t_own5', '12345', 'owner', null, null)$$);
select testkit.assert_error('pin_must_be_6_to_12_digits',
  $$select admin_create_user('t_mg5', '12345', 'manager', null, null)$$);
select testkit.assert_true(
  (admin_create_user('t_st4', '1234', 'staff', null, null) ->> 'role') = 'staff',
  'staff still accepts a 4-digit PIN');

-- Reset uses the same minimum for a co_owner profile, and still 4 for staff.
select testkit.assert_error('pin_must_be_6_to_12_digits',
  $$select admin_reset_pin((select id from profiles where username = 't_co6'), '12345')$$);
select admin_reset_pin((select id from profiles where username = 't_co6'), '654321');
select admin_reset_pin((select id from profiles where username = 't_st4'), '9876');

-- Manager and staff callers cannot create accounts.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
select testkit.assert_error('owner_only',
  $$select admin_create_user('t_mgr', '123456', 'co_owner', null, null)$$);
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_error('owner_only',
  $$select admin_create_user('t_stf', '123456', 'staff', null, null)$$);

set local role anon;
select testkit.assert_error('permission denied',
  $$select admin_create_user('t_anon', '123456', 'co_owner', null, null)$$);

rollback;
reset role;
select '10_admin_create_co_owner: all assertions passed';
