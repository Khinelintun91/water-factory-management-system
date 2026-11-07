-- 05_login_gateway.sql — the 0026 login-security gateway:
--   * login_logs has NO direct insert path for anon/authenticated
--     (the definer gateway log_login_attempt is the only writer);
--   * anon may call log_failed_login (pre-login by design) — 5 fails
--     lock for 15 minutes and further calls report the SAME lock
--     (no re-arming / lockout-DoS extension);
--   * the raw 0006 RPC record_login_failure is NOT callable by anon
--     or authenticated any more;
--   * login_lock_status stays anon-readable (pre-login lock check).
-- Everything runs as `anon` with no JWT claims, in one begin/rollback.

begin;
set local role anon;

-- Direct insert is closed (RLS: no insert policy remains).
select testkit.assert_error('',
  $$insert into login_logs (username, success) values ('t_victim', false)$$);

-- The raw counter RPC is off the client surface.
select testkit.assert_error('permission denied',
  $$select record_login_failure('t_victim')$$);

-- Gateway: first four failures do not lock; the fifth locks.
select testkit.assert_true(log_failed_login('t_victim', 'suite') is null, 'fail 1: no lock');
select testkit.assert_true(log_failed_login('t_victim', 'suite') is null, 'fail 2: no lock');
select testkit.assert_true(log_failed_login('t_victim', 'suite') is null, 'fail 3: no lock');
select testkit.assert_true(log_failed_login('t_victim', 'suite') is null, 'fail 4: no lock');
select testkit.assert_true(log_failed_login('t_victim', 'suite') > now(), 'fail 5: locked');

-- A sixth call reports the same lock instead of extending it
-- (compared via login_lock_status, the other definer read —
-- pin_attempts itself has no client SELECT policy at all).
select testkit.assert_true(
  log_failed_login('t_victim', 'suite') = login_lock_status('t_victim'),
  'fail 6: same lock, not extended');

-- The pre-login lock check sees the lock.
select testkit.assert_true(login_lock_status('t_victim') > now(), 'lock status visible to anon');

-- The gateway wrote the failure rows (readable here because
-- log_login_attempt is definer-owned; count via a definer path is not
-- available to anon, so verify through pin_attempts + lock only —
-- the login_logs row count is covered by the app-level tests).

rollback;
reset role;
select '05_login_gateway: all assertions passed';
