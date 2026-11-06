-- 0026_login_security.sql — Login-path hardening (P0 audit Item 2, 2026-11-06).
--
-- Step-0 live verification found three login-abuse holes plus a set of
-- dangerous functions left executable by PUBLIC/anon (31 public functions
-- were anon-executable live):
--   (a) login_logs accepted DIRECT inserts from anon AND authenticated
--       under `with check (true)` (0002) — anyone holding the publishable
--       key could forge login history or flood the table until the Free
--       tier storage filled.
--   (b) record_login_failure(text) was anon-callable — anyone could lock
--       ANY username for 15 minutes at will, repeatedly (lockout-DoS),
--       without ever attempting a real login.
--   (c) insert_notification / om_recipients / send_daily_digest /
--       run_data_quality_alerts were PUBLIC-executable — anyone could
--       forge notifications to any user or fire the digest/DQ jobs at
--       will; agent_outstanding(uuid) was anon-executable, leaking any
--       agent's debt balance to anyone who knew (or guessed) a UUID.
--
-- WHAT THIS MIGRATION DOES
--   1. login_logs: the permissive INSERT policy is dropped. Direct table
--      inserts are then denied to every client role (RLS stays on; the
--      owner-only SELECT policy from 0002 is unchanged). All writes now
--      go through the new SECURITY DEFINER gateway log_login_attempt(),
--      which validates the username, truncates the user-agent, inserts
--      exactly ONE row per call, and silently drops excess volume
--      (rate shaping: max 20 rows per username per minute, max 300 rows
--      per minute overall — far above any human login pace, far below
--      a storage-flood pace).
--   2. Lockout: record_login_failure / clear_login_failures lose their
--      PUBLIC (and, for record_login_failure, all client) EXECUTE grants.
--      clear_login_failures() is different from the other two: it takes
--      no argument and acts only on the caller's OWN username
--      (auth.uid(), 0006), and the app calls it AFTER a successful
--      sign-in (AuthContext.tsx line ~141), so `authenticated` keeps it.
--      record_login_failure(text) is the hard case — see THE TENSION.
--   3. The five dangerous functions are locked down (table below).
--   4. A BEFORE UPDATE/DELETE trigger on profiles makes the final
--      ACTIVE owner undeletable, un-deactivatable and un-re-rolable at
--      the database level. Until now this guard existed only as a UI
--      check in UsersPage.toggleActive, and profiles_update (0002)
--      lets an owner rewrite any profile row — including their own —
--      through the API, locking the business out of its own system.
--
-- THE TENSION (lockout recording happens while logged OUT)
--   AuthContext.signIn() calls record_login_failure AFTER
--   signInWithPassword fails — i.e. as `anon`. Simply revoking anon
--   would silently kill the 5-fail/15-min lockout (0006). The safest
--   working design is the same gateway pattern as (1):
--   log_failed_login(p_username, p_user_agent) is the ONLY client path.
--   It (i) validates the username shape, (ii) returns the existing lock
--   untouched if the account is already locked (repeated attempts during
--   a lock no longer extend it, unlike the raw 0006 counter), (iii)
--   performs the unchanged 0006 counting logic by calling
--   record_login_failure() INTERNALLY, and (iv) writes the login_logs
--   row itself, so the failure is recorded exactly once.
--   The internal call is safe after the revoke: both functions are
--   SECURITY DEFINER owned by the migration role; a caller needs EXECUTE
--   on the gateway only, and the definer context supplies the inner
--   call. VERIFY after applying (SQL editor / PostgREST as anon):
--   rpc/record_login_failure must fail 42501, rpc/log_failed_login must
--   succeed and increment pin_attempts. If a future Postgres change ever
--   broke definer-chained calls, the fallback is to inline the 0006
--   counter body into log_failed_login — do not re-grant the raw RPC.
--
-- REQUIRED APP CHANGE (src/context/AuthContext.tsx — NOT in this file;
-- ship it WITH or BEFORE applying this migration):
--   1. logAttempt() (~lines 28-37): replace
--        supabase.from('login_logs').insert({ username, success,
--          user_agent: navigator.userAgent })
--      with
--        supabase.rpc('log_login_attempt', { p_username: username,
--          p_success: success, p_user_agent: navigator.userAgent })
--      (Keep the surrounding try/catch: logging stays best-effort.)
--   2. Failure path (~lines 109-115): replace
--        supabase.rpc('record_login_failure', { p_username: username })
--      with
--        supabase.rpc('log_failed_login', { p_username: username,
--          p_user_agent: navigator.userAgent })
--      It returns locked_until (timestamptz | null) exactly like the old
--      call. AND delete the `await logAttempt(username, false)` in this
--      branch — log_failed_login already writes that login_logs row;
--      keeping both would double-log every failed attempt.
--   3. Locked pre-check (~lines 98-103): no call change —
--      login_lock_status stays anon-callable (below); its logAttempt
--      now flows through change 1 automatically.
--   4. Success path (~lines 140-145): no change — clear_login_failures
--      keeps its `authenticated` grant and is called post-sign-in; the
--      success logAttempt flows through change 1.
--   Deploy order: if this migration lands BEFORE the app change, nothing
--   breaks hard — the old build's direct login_logs inserts are denied
--   (logAttempt swallows the error; history pauses) and its
--   record_login_failure call returns an error the code already treats
--   as "no lock" (login attempts still work; lockout counting pauses)
--   until the new build deploys.
--
-- FUNCTION GRANT TABLE (evidence = grep of src/ + migrations, 2026-11-06)
--   function                              before (live)   after            evidence
--   ------------------------------------  --------------  -----------------  --------------------------------
--   log_login_attempt(text,bool,text)     — (new)         anon+auth (only)  AuthContext.logAttempt is the
--                                                                           sole login_logs writer in src/
--   log_failed_login(text,text)           — (new)         anon+auth (only)  AuthContext failure path is the
--                                                                           sole record_login_failure caller
--   record_login_failure(text)            PUBLIC/anon/    nobody (gateway   internal: called only by
--                                         authenticated   calls it)         log_failed_login; 0006's grant
--                                                                           to anon/authenticated removed
--   clear_login_failures()                PUBLIC (+auth   authenticated     AuthContext calls it AFTER
--                                         grant, 0006)    only              sign-in; acts on own username
--   login_lock_status(text)               anon+auth       UNCHANGED         pre-login check must work as
--                                                                           anon; returns only a timestamp
--   insert_notification(uuid,text,text,   PUBLIC          nobody            DB-internal only: notify_*
--     text,text,text,text)                                                  triggers (0011/0015) and the
--                                                                           two job functions call it; no
--                                                                           src/ caller. Definer-internal
--                                                                           calls run as owner, unaffected
--   om_recipients(uuid)                   PUBLIC          nobody            DB-internal only (0011/0012/
--                                                                           0015/0017 function bodies)
--   send_daily_digest()                   PUBLIC          nobody            pg_cron only (0012 schedule);
--                                                                           cron runs as the job owner,
--                                                                           not via PUBLIC grants
--   run_data_quality_alerts()             PUBLIC          nobody            pg_cron only (0012 schedule)
--   agent_outstanding(uuid)               PUBLIC (+auth   authenticated     src/ RPC callers, all signed-in
--                                         grant, 0006)    only              pages: AgentsPage, AgentDetail-
--                                                                           Page, CloseoutPage, Collections
--   guard_last_owner()                    — (new)         nobody            trigger function; triggers do
--                                                                           not need caller EXECUTE
--
-- RESIDUAL, DELIBERATELY NOT FIXED HERE: agent_outstanding is SECURITY
-- DEFINER with no caller check, so after this migration any AUTHENTICATED
-- user (incl. an agent login) who knows another agent's UUID can still
-- read that agent's balance. The anon leak (the Step-0 finding) is
-- closed; the authenticated tightening needs a function-body change
-- (staff-plus OR own-agent check) and belongs with the Item-4 test suite
-- so entries_before_write's internal call is covered by a test first.
--
-- LEFT FOR THE LIVE-GRANT SWEEP (not touched here, by design): Step-0
-- counted 31 PUBLIC-executable functions. This migration only revokes
-- the ones classified above from traced call sites. The rest — RLS
-- helpers that MUST stay executable by authenticated because policies
-- evaluate them as the querying user (app_role, app_agent_id, has_role,
-- is_owner_manager, is_staff_plus), trigger functions not yet traced
-- (audit_row_change, notify_*, fill_agent_name, ...), and report/RPC
-- functions already revoked in 0014/0020-0025 — need one dedicated
-- sweep: dump information_schema.routine_privileges live, classify each
-- of the 31, revoke in a single follow-up migration. Blanket-revoking
-- unclassified functions from this file risks breaking policy helpers.
--
-- NOT SQL — DASHBOARD/API CONFIG THIS ITEM STILL NEEDS (follow-up step):
--   * Supabase Auth: disable_signup = true. Accounts are created only by
--     the owner via admin_create_user (0014), which inserts into
--     auth.users directly in SQL and is NOT affected by the public
--     sign-up switch; the synthetic <username>@waterfactory.local
--     addresses must never be self-registrable through the Auth API.
--   * Supabase Auth sessions (Step-0 found timebox = 0, inactivity = 0,
--     single-session = false, i.e. sessions effectively never expire):
--     proposed values for owner confirmation — inactivity timeout 7 days
--     (604800 s), session time-box 30 days (2592000 s). JWT expiry (1 h)
--     and refresh-token rotation are already on (Step-0) — leave them.
--     NOTE: whether these session controls are available on the Free
--     plan was not verifiable from the docs; check the dashboard when
--     applying, and if they are plan-gated, record that and rely on the
--     app-level re-login instead of pretending the setting exists.
--
-- ROLLBACK (comment only — do not run as part of this migration):
--   drop trigger profiles_last_owner on profiles;
--   drop function public.guard_last_owner();
--   drop function public.log_failed_login(text, text);
--   drop function public.log_login_attempt(text, boolean, text);
--   create policy login_logs_insert on login_logs for insert
--     to anon, authenticated with check (true);            -- restores hole (a)
--   grant execute on function public.record_login_failure(text)
--     to anon, authenticated;
--   grant execute on function public.clear_login_failures() to public;
--   grant execute on function public.insert_notification(uuid, text,
--     text, text, text, text, text) to public;
--   grant execute on function public.om_recipients(uuid) to public;
--   grant execute on function public.send_daily_digest() to public;
--   grant execute on function public.run_data_quality_alerts() to public;
--   grant execute on function public.agent_outstanding(uuid) to public;

-- ---------------------------------------------------------------------------
-- 1) login_logs gateway: validated, single-row, rate-shaped inserts
-- ---------------------------------------------------------------------------
create or replace function public.log_login_attempt(
  p_username text, p_success boolean, p_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_username text := lower(trim(coalesce(p_username, '')));
  v_recent   integer;
begin
  -- Shape: same alphabet as admin_create_user (0014) but length 1-64, so
  -- failed attempts against mistyped or legacy names still log, while
  -- junk (spaces, quotes, overlong strings) is dropped silently —
  -- logging must never break the login screen.
  if length(v_username) not between 1 and 64
     or v_username !~ '^[a-z0-9_.-]+$'
     or p_success is null then
    return;
  end if;
  -- Rate shaping (this function is the only insert path, and it inserts
  -- exactly one row per call, so these caps bound total volume).
  select count(*) into v_recent from login_logs
   where username = v_username and created_at > now() - interval '1 minute';
  if v_recent >= 20 then return; end if;
  select count(*) into v_recent from login_logs
   where created_at > now() - interval '1 minute';
  if v_recent >= 300 then return; end if;

  insert into login_logs (username, success, user_agent)
  values (v_username, p_success, left(p_user_agent, 512));
end $$;

-- The rate-shape counts scan login_logs by time; keep them cheap.
create index login_logs_created_idx on login_logs (created_at desc);
create index login_logs_username_created_idx
  on login_logs (username, created_at desc);

revoke all on function public.log_login_attempt(text, boolean, text) from public;
grant execute on function public.log_login_attempt(text, boolean, text)
  to anon, authenticated;

-- Direct inserts end here. RLS stays enabled; with no INSERT policy left,
-- anon and authenticated are both denied, and the definer gateway above
-- (running as owner) is the only writer. SELECT stays owner-only (0002).
drop policy login_logs_insert on login_logs;

-- ---------------------------------------------------------------------------
-- 2) Lockout gateway + grant lockdown
-- ---------------------------------------------------------------------------
create or replace function public.log_failed_login(
  p_username text, p_user_agent text default null
) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_username text := lower(trim(coalesce(p_username, '')));
  v_lock     timestamptz;
begin
  if length(v_username) not between 1 and 64
     or v_username !~ '^[a-z0-9_.-]+$' then
    return null;
  end if;
  -- Already locked: report the lock without feeding the counter again
  -- (the raw 0006 path let repeat attempts keep re-arming the lock).
  select locked_until into v_lock from pin_attempts
   where username = v_username and locked_until > now();
  if v_lock is not null then
    return v_lock;
  end if;
  -- Unchanged 0006 counting (5 fails -> 15-minute lock), invoked
  -- internally — clients can no longer call it directly (below).
  v_lock := public.record_login_failure(v_username);
  -- The failure's login_logs row is written here, once (the app's
  -- failure branch must not log it a second time — see header).
  perform public.log_login_attempt(v_username, false, p_user_agent);
  return v_lock;
end $$;

revoke all on function public.log_failed_login(text, text) from public;
grant execute on function public.log_failed_login(text, text)
  to anon, authenticated;

-- The raw lockout RPCs leave the client surface. record_login_failure
-- keeps working for its one remaining caller (the gateway above, in
-- definer context); clear_login_failures stays available to signed-in
-- users because it only ever clears the caller's own username.
revoke all on function public.record_login_failure(text)
  from public, anon, authenticated;
revoke all on function public.clear_login_failures() from public, anon;
grant execute on function public.clear_login_failures() to authenticated;
-- login_lock_status(text) grants are intentionally UNCHANGED
-- (anon + authenticated, 0006): the pre-login lock check requires it,
-- and it discloses nothing but a lock expiry timestamp.

-- ---------------------------------------------------------------------------
-- 3) Dangerous PUBLIC functions (see the header table for evidence)
-- ---------------------------------------------------------------------------
revoke all on function public.insert_notification(
  uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.om_recipients(uuid)
  from public, anon, authenticated;
revoke all on function public.send_daily_digest()
  from public, anon, authenticated;
revoke all on function public.run_data_quality_alerts()
  from public, anon, authenticated;
revoke all on function public.agent_outstanding(uuid) from public, anon;
grant execute on function public.agent_outstanding(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Last-owner guard: the final ACTIVE owner cannot be deactivated,
--    re-roled, or deleted — at the database level, for every caller
--    including the owner themself (closes the API bypass of the
--    UsersPage UI check). Insert paths (admin_create_user) are not
--    affected; deactivating one of two owners stays allowed.
-- ---------------------------------------------------------------------------
create or replace function public.guard_last_owner() returns trigger
language plpgsql as $$
begin
  if old.role = 'owner' and old.active then
    if tg_op = 'DELETE'
       or new.active is distinct from true
       or new.role is distinct from 'owner' then
      if not exists (
        select 1 from profiles
        where role = 'owner' and active and id <> old.id
      ) then
        raise exception
          'last_owner: the final active owner account cannot be deactivated, re-roled, or deleted'
          using errcode = 'P0001';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create trigger profiles_last_owner before update or delete on profiles
  for each row execute function guard_last_owner();

revoke all on function public.guard_last_owner() from public, anon, authenticated;
