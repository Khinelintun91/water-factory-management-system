-- 0036: anonymous callers cannot lock a username that is not an account.
--
-- log_failed_login (0026) is anon-callable on purpose: the login screen
-- records a failure before a session exists, and 5 failures lock that
-- username for 15 minutes. The same grant let anyone lock ANY string
-- that matched ^[a-z0-9_.-]{1,64}$, including names that are not users,
-- and walk every real username.
--
-- This keeps the 5-failure / 15-minute lock for a username that exists
-- in profiles, including the "sixth call returns the same lock" rule.
-- A well-formed unknown username is logged (the 0026 rate limits still
-- apply) and returns null. It does not insert pin_attempts.
--
-- A second brake: at most 30 counted failures across all real accounts
-- in one minute. The count is login_logs failure rows for a username
-- that exists in profiles, not pin_attempts rows: a lock resets
-- pin_attempts.fails to 0, so a row count cannot see the 5 failures.
-- Already-locked calls return before this count, so one account still
-- locks at 5 and does not keep adding. Past the ceiling, further
-- counts are not started. Owner decision: 30 per minute.
-- tests/sql/10_api_gap_fixes.sql asserts that number.
--
-- log_login_attempt still accepts anon failure rows (the locked-before
-- sign-in path). A success row is written only when the caller is
-- signed in as that active username. The app calls it after sign-in.
--
-- Grants are unchanged: anon + authenticated, not PUBLIC (0026).
-- login_lock_status stays anon-callable so the screen can show a lock.
-- Does not depend on 0030 or 0031.

create or replace function public.log_login_attempt(
  p_username text, p_success boolean, p_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_username text := lower(trim(coalesce(p_username, '')));
  v_recent   integer;
begin
  if length(v_username) not between 1 and 64
     or v_username !~ '^[a-z0-9_.-]+$'
     or p_success is null then
    return;
  end if;

  -- Success is only the signed-in user's own username. Anon cannot
  -- write a fake successful login. Failures stay anon-callable.
  if p_success then
    if auth.uid() is null
       or not exists (
         select 1 from profiles
          where id = auth.uid()
            and lower(username) = v_username
            and active
       ) then
      return;
    end if;
  end if;

  select count(*) into v_recent from login_logs
   where username = v_username and created_at > now() - interval '1 minute';
  if v_recent >= 20 then return; end if;
  select count(*) into v_recent from login_logs
   where created_at > now() - interval '1 minute';
  if v_recent >= 300 then return; end if;

  insert into login_logs (username, success, user_agent)
  values (v_username, p_success, left(p_user_agent, 512));
end $$;

create or replace function public.log_failed_login(
  p_username text, p_user_agent text default null
) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_username text := lower(trim(coalesce(p_username, '')));
  v_lock     timestamptz;
  v_recent   integer;
begin
  if length(v_username) not between 1 and 64
     or v_username !~ '^[a-z0-9_.-]+$' then
    return null;
  end if;

  select locked_until into v_lock from pin_attempts
   where username = v_username and locked_until > now();
  if v_lock is not null then
    return v_lock;
  end if;

  -- Not an account: do not create a pin_attempts row and do not lock.
  if not exists (
    select 1 from profiles where lower(username) = v_username
  ) then
    perform public.log_login_attempt(v_username, false, p_user_agent);
    return null;
  end if;

  -- 30 counted failures per minute, all real accounts together.
  -- login_logs, not pin_attempts: locking a username sets fails back
  -- to 0, so the attempt row no longer shows how many failures it took.
  select count(*) into v_recent
    from login_logs
   where success = false
     and created_at > now() - interval '1 minute'
     and exists (
       select 1 from profiles
        where lower(username) = login_logs.username
     );
  if v_recent >= 30 then
    perform public.log_login_attempt(v_username, false, p_user_agent);
    return null;
  end if;

  v_lock := public.record_login_failure(v_username);
  perform public.log_login_attempt(v_username, false, p_user_agent);
  return v_lock;
end $$;
