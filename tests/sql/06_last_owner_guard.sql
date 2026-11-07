-- 06_last_owner_guard.sql — 0026 guard_last_owner: the final active
-- owner cannot be deactivated, re-roled, or deleted AT THE DATABASE
-- LEVEL, including by the owner themself (the UsersPage UI check alone
-- was bypassable through the API). The fixture has exactly one owner.

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

select testkit.assert_error('last_owner',
  $$update profiles set active = false
    where id = '11111111-1111-4111-8111-111111111111'$$);
select testkit.assert_error('last_owner',
  $$update profiles set role = 'manager'
    where id = '11111111-1111-4111-8111-111111111111'$$);
-- DELETE through the API is a silent no-op (profiles has no DELETE
-- policy at all, so RLS filters every row out): the protection
-- outcome is that the owner row survives untouched.
delete from profiles
 where id = '11111111-1111-4111-8111-111111111111';
select testkit.assert_true(
  (select count(*) from profiles
    where id = '11111111-1111-4111-8111-111111111111' and active) = 1,
  'owner row survives an API delete attempt');

-- Control: deactivating a NON-owner stays allowed.
update profiles set active = false
 where id = '33333333-3333-4333-8333-333333333333';

rollback;
reset role;

-- The trigger's DELETE branch itself, exercised on a privileged path
-- (no role simulation: the session user bypasses RLS, so the BEFORE
-- DELETE trigger is what stands between the caller and the row).
begin;
select testkit.assert_error('last_owner',
  $$delete from profiles
    where id = '11111111-1111-4111-8111-111111111111'$$);
rollback;

select '06_last_owner_guard: all assertions passed';
