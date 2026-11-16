-- 10_api_gap_fixes.sql — regressions for migrations 0032–0038.
-- Each scenario is its own begin/rollback. Identities are the fixture's.

-- ---------------------------------------------------------------------------
-- Archive instead of delete (0032). Phone row, ledger agent_id, and an
-- audit update survive. A second call is a no-op. Direct DELETE is rejected.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
select testkit.assert_error('forbidden',
  $$select hard_delete_agent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$$);

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select testkit.assert_error('not_settled',
  $$select hard_delete_agent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$$);
select testkit.assert_true(
  (select archived_at is null from agents
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'unsettled agent is not archived');
select testkit.assert_error('agent_not_found',
  $$select hard_delete_agent('99999999-9999-4999-8999-999999999999')$$);

insert into agent_contacts (agent_id, phone)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '09000000003');
select finalize_closeout(
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 10, 1000, 'archive suite');
select hard_delete_agent('cccccccc-cccc-4ccc-8ccc-cccccccccccc');

select testkit.assert_true(
  (select archived_at is not null and active = false and closed_at is not null
     from agents where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'closed agent is archived, not removed');
select testkit.assert_true(
  (select archived_by = '11111111-1111-4111-8111-111111111111'
     from agents where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'archive records the owner');
select testkit.assert_true(
  (select phone = '09000000003' from agent_contacts
    where agent_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'phone row is kept');
select testkit.assert_true(
  (select count(*) from daily_entries
    where agent_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') >= 1,
  'ledger rows keep agent_id');
select testkit.assert_true(
  exists (
    select 1 from audit_log
     where table_name = 'agents'
       and action = 'update'
       and row_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
       and old_data ->> 'archived_at' is null
       and new_data ->> 'archived_at' is not null
  ),
  'archive is audited as an update');

select hard_delete_agent('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
select testkit.assert_true(
  (select count(*) from agents
    where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') = 1,
  'second archive keeps the one row');

select testkit.assert_error('archive_columns_locked',
  $$update agents set archived_at = null
     where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$);

set local role service_role;
select testkit.assert_error('business_data_kept',
  $$delete from agents where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$);
reset role;
select testkit.assert_error('business_data_kept',
  $$delete from agents where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$);
rollback;

-- ---------------------------------------------------------------------------
-- Direct settlement insert is closed (0034). finalize_closeout still inserts.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select testkit.assert_error('settlement_via_closeout_only',
  $$insert into agent_settlements (
      agent_id, held_bottles, returned_bottles, missing_bottles,
      current_price, deposit_original, refund_amount
    ) values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 0, 0, 1000, 0, 0
    )$$);
select testkit.assert_true(
  not exists (select 1 from agent_settlements
    where agent_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'owner insert did not land');

set local role service_role;
select testkit.assert_error('settlement_via_closeout_only',
  $$insert into agent_settlements (
      agent_id, held_bottles, returned_bottles, missing_bottles,
      current_price, deposit_original, refund_amount
    ) values (
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 0, 0, 0, 1000, 0, 0
    )$$);
rollback;

-- ---------------------------------------------------------------------------
-- Agent money settings (0033): audited, historical price untouched,
-- current-month lock blocks the four money columns only.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

select testkit.assert_true(
  (select count(*) from month_locks
    where month = date_trunc('month', (now() at time zone 'Asia/Yangon')::date)::date) = 0,
  'fixture leaves the current month unlocked');

update agents set default_unit_price = 450
 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select testkit.assert_true(
  (select unit_price from daily_entries
    where id = 'e0000000-0000-4000-8000-000000000001') = 300,
  'historical unit_price stays 300');
select testkit.assert_true(
  (select unit_price from daily_entries
    where id = 'e0000000-0000-4000-8000-000000000002') = 300,
  'locked-month unit_price stays 300');
select testkit.assert_true(
  exists (
    select 1 from audit_log
     where table_name = 'agents'
       and action = 'update'
       and row_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
       and old_data ->> 'default_unit_price' = '300'
       and new_data ->> 'default_unit_price' = '450'
  ),
  'price change is audited');

update agents
   set created_at = now() - interval '2 days'
 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
update agents set default_unit_price = 460
 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select testkit.assert_true(
  (select default_unit_price from agents
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 460,
  'a two-day-old agent row can still change price');

insert into month_locks (month, locked_by)
values (
  date_trunc('month', (now() at time zone 'Asia/Yangon')::date)::date,
  '11111111-1111-4111-8111-111111111111'
);

select testkit.assert_error('month_locked',
  $$update agents set default_unit_price = 470
     where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$);
select testkit.assert_error('month_locked',
  $$update agents set deposit_per_bottle = 5
     where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$);
select testkit.assert_error('month_locked',
  $$update agents set credit_limit = 9
     where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$);

update agents
   set active = false, name = 'Test Agent A locked'
 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select testkit.assert_true(
  (select active = false and name = 'Test Agent A locked'
     from agents where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'active and name still change in a locked month');

delete from month_locks
 where month = date_trunc('month', (now() at time zone 'Asia/Yangon')::date)::date;
update agents set default_unit_price = 480
 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select testkit.assert_true(
  (select default_unit_price from agents
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 480,
  'price change works after the current month is unlocked');
rollback;

-- ---------------------------------------------------------------------------
-- Owner-only PIN reset (0035). No self-service RPC. admin_reset_pin keeps
-- the digit rule. Non-owners are denied. A direct password update by
-- authenticated, or by a role standing in for GoTrue, is denied. The
-- audit row does not contain the PIN or the hash.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit;
  end if;
end $$;

begin;
update auth.users
   set encrypted_password = extensions.crypt('123456', extensions.gen_salt('bf'))
 where id in (
   '11111111-1111-4111-8111-111111111111',
   '22222222-2222-4222-8222-222222222222',
   '88888888-8888-4888-8888-888888888888'
 );
update auth.users
   set encrypted_password = extensions.crypt('1234', extensions.gen_salt('bf'))
 where id in (
   '33333333-3333-4333-8333-333333333333',
   '44444444-4444-4444-8444-444444444444'
 );
insert into auth.users (id, email) values
  ('88888888-8888-4888-8888-888888888888', 't_coowner@waterfactory.local');
update auth.users
   set encrypted_password = extensions.crypt('123456', extensions.gen_salt('bf'))
 where id = '88888888-8888-4888-8888-888888888888';
insert into profiles (id, username, role) values
  ('88888888-8888-4888-8888-888888888888', 't_coowner', 'co_owner');
insert into user_roles (profile_id, role) values
  ('22222222-2222-4222-8222-222222222222', 'owner');

select testkit.assert_true(
  to_regprocedure('public.change_own_pin(text,text)') is null,
  'no self-service PIN function');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select testkit.assert_error('pin_must_be_4_to_12_digits',
  $$select admin_reset_pin('33333333-3333-4333-8333-333333333333', '12')$$);
select testkit.assert_error('pin_must_be_4_to_12_digits',
  $$select admin_reset_pin('33333333-3333-4333-8333-333333333333', '12ab')$$);
select testkit.assert_error('pin_must_be_6_to_12_digits',
  $$select admin_reset_pin('11111111-1111-4111-8111-111111111111', '12345')$$);
select admin_reset_pin('33333333-3333-4333-8333-333333333333', '918273');
select admin_reset_pin('11111111-1111-4111-8111-111111111111', '91827364');

reset role;
select testkit.assert_true(
  (select extensions.crypt('918273', encrypted_password) = encrypted_password
     from auth.users where id = '33333333-3333-4333-8333-333333333333'),
  'owner reset a staff PIN');
select testkit.assert_true(
  (select extensions.crypt('91827364', encrypted_password) = encrypted_password
     from auth.users where id = '11111111-1111-4111-8111-111111111111'),
  'owner reset their own PIN');
select testkit.assert_true(
  exists (
    select 1 from audit_log
     where table_name = 'auth.users'
       and row_id = '33333333-3333-4333-8333-333333333333'
       and action = 'update'
       and actor = '11111111-1111-4111-8111-111111111111'
       and new_data ->> 'event' = 'pin_reset'
       and new_data ->> 'username' = 't_staff'
       and not (new_data ? 'encrypted_password')
       and not (old_data ? 'encrypted_password')
       and (coalesce(old_data::text, '') || coalesce(new_data::text, '')) not like '%918273%'
       and (coalesce(old_data::text, '') || coalesce(new_data::text, '')) not like '%$2%'
  ),
  'PIN reset is audited without the PIN or the hash');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
select testkit.assert_error('owner_only',
  $$select admin_reset_pin('22222222-2222-4222-8222-222222222222', '654321')$$);
select testkit.assert_error('owner_only',
  $$select admin_reset_pin('33333333-3333-4333-8333-333333333333', '654321')$$);
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_error('owner_only',
  $$select admin_reset_pin('33333333-3333-4333-8333-333333333333', '5678')$$);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-8444-444444444444"}', true);
select testkit.assert_error('owner_only',
  $$select admin_reset_pin('44444444-4444-4444-8444-444444444444', '5678')$$);
select set_config('request.jwt.claims', '{"sub":"88888888-8888-4888-8888-888888888888"}', true);
select testkit.assert_error('owner_only',
  $$select admin_reset_pin('88888888-8888-4888-8888-888888888888', '654321')$$);
select testkit.assert_error('owner_only',
  $$select admin_reset_pin('11111111-1111-4111-8111-111111111111', '65432199')$$);

reset role;
select testkit.assert_true(
  (select extensions.crypt('123456', encrypted_password) = encrypted_password
     from auth.users where id = '22222222-2222-4222-8222-222222222222'),
  'manager PIN unchanged, even with an extra owner grant');
select testkit.assert_true(
  (select extensions.crypt('918273', encrypted_password) = encrypted_password
     from auth.users where id = '33333333-3333-4333-8333-333333333333'),
  'staff could not replace the owner reset');
select testkit.assert_true(
  (select extensions.crypt('1234', encrypted_password) = encrypted_password
     from auth.users where id = '44444444-4444-4444-8444-444444444444'),
  'agent PIN unchanged');
select testkit.assert_true(
  (select extensions.crypt('123456', encrypted_password) = encrypted_password
     from auth.users where id = '88888888-8888-4888-8888-888888888888'),
  'co_owner PIN unchanged');
select testkit.assert_true(
  (select extensions.crypt('91827364', encrypted_password) = encrypted_password
     from auth.users where id = '11111111-1111-4111-8111-111111111111'),
  'co_owner did not change the owner PIN');

set local role anon;
select testkit.assert_error('permission denied',
  $$select admin_reset_pin('11111111-1111-4111-8111-111111111111', '65432199')$$);

reset role;
-- SELECT is required for the WHERE clause. These grants exist only inside
-- this rolled-back test, to prove a direct write is still rejected.
grant usage on schema auth to supabase_auth_admin;
grant select, update, insert on auth.users to authenticated, supabase_auth_admin;
grant usage on schema testkit to supabase_auth_admin;
grant execute on all functions in schema testkit to supabase_auth_admin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select testkit.assert_error('pin_change_owner_only',
  $$update auth.users set encrypted_password = 'plain'
     where id = '11111111-1111-4111-8111-111111111111'$$);
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
select testkit.assert_error('pin_change_owner_only',
  $$update auth.users set encrypted_password = 'plain'
     where id = '33333333-3333-4333-8333-333333333333'$$);
set local role supabase_auth_admin;
select testkit.assert_error('pin_change_owner_only',
  $$update auth.users set encrypted_password = 'plain'
     where id = '11111111-1111-4111-8111-111111111111'$$);
insert into auth.users (id, email, encrypted_password) values
  ('99999999-9999-4999-8999-999999999999', 't_newauth@waterfactory.local', 'not-a-login');
reset role;
select testkit.assert_true(
  exists (
    select 1 from auth.users
     where id = '99999999-9999-4999-8999-999999999999'
  ),
  'creating an Auth user is still an insert, not blocked by the PIN trigger');
rollback;

-- ---------------------------------------------------------------------------
-- Login lockout abuse (0036). Unknown names do not lock. Real accounts still
-- do. Success logs require the signed-in user. 30 counted failures per minute.
-- ---------------------------------------------------------------------------
begin;
set local role anon;
select testkit.assert_true(log_failed_login('ghost_name', 'suite') is null, 'ghost 1');
select testkit.assert_true(log_failed_login('ghost_name', 'suite') is null, 'ghost 2');
select testkit.assert_true(log_failed_login('ghost_name', 'suite') is null, 'ghost 3');
select testkit.assert_true(log_failed_login('ghost_name', 'suite') is null, 'ghost 4');
select testkit.assert_true(log_failed_login('ghost_name', 'suite') is null, 'ghost 5');
select testkit.assert_true(login_lock_status('ghost_name') is null, 'ghost is not locked');
reset role;
select testkit.assert_true(
  not exists (select 1 from pin_attempts where username = 'ghost_name'),
  'ghost has no pin_attempts row');
rollback;

begin;
set local role anon;
select testkit.assert_true(log_failed_login('t_staff', 'suite') is null, 'staff fail 1');
select testkit.assert_true(log_failed_login('t_staff', 'suite') is null, 'staff fail 2');
select testkit.assert_true(log_failed_login('t_staff', 'suite') is null, 'staff fail 3');
select testkit.assert_true(log_failed_login('t_staff', 'suite') is null, 'staff fail 4');
select testkit.assert_true(log_failed_login('t_staff', 'suite') > now(), 'staff fail 5 locks');
select testkit.assert_true(
  log_failed_login('t_staff', 'suite') = login_lock_status('t_staff'),
  'staff fail 6 does not extend the lock');
rollback;

begin;
set local role anon;
select log_login_attempt('t_owner', true, 'suite');
reset role;
select testkit.assert_true(
  (select count(*) from login_logs where username = 't_owner' and success) = 0,
  'anon cannot write a successful login');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select log_login_attempt('t_owner', true, 'suite');
select log_login_attempt('t_staff', true, 'suite');
select log_login_attempt('t_owner', false, 'suite');
reset role;
select testkit.assert_true(
  (select count(*) from login_logs where username = 't_owner' and success) = 1,
  'signed-in user logs their own success');
select testkit.assert_true(
  (select count(*) from login_logs where username = 't_staff' and success) = 0,
  'cannot log a success for another username');
select testkit.assert_true(
  (select count(*) from login_logs where username = 't_owner' and not success) = 1,
  'a failure log still writes');

set local role anon;
select log_login_attempt('ghost_name', false, 'suite');
reset role;
select testkit.assert_true(
  (select count(*) from login_logs where username = 'ghost_name' and not success) = 1,
  'anon failure log still writes');
rollback;

begin;
insert into auth.users (id, email)
select ('c0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
       'cap' || i || '@waterfactory.local'
  from generate_series(1, 7) as i;
insert into profiles (id, username, role)
select ('c0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
       'capuser' || i,
       'staff'
  from generate_series(1, 7) as i;

set local role anon;
do $$
declare
  i int;
  n int;
  v timestamptz;
begin
  for i in 1..6 loop
    for n in 1..4 loop
      v := log_failed_login('capuser' || i, 'suite');
      if v is not null then
        raise exception 'ASSERT FAILED: capuser% failure % locked early', i, n;
      end if;
    end loop;
    v := log_failed_login('capuser' || i, 'suite');
    if v is null or v <= now() then
      raise exception 'ASSERT FAILED: capuser% did not lock inside the ceiling', i;
    end if;
  end loop;
  for n in 1..5 loop
    v := log_failed_login('capuser7', 'suite');
    if v is not null then
      raise exception 'ASSERT FAILED: capuser7 locked past the ceiling (call %)', n;
    end if;
  end loop;
end $$;
reset role;
select testkit.assert_true(
  (select locked_until > now() from pin_attempts where username = 'capuser6'),
  'sixth account locked at the ceiling');
select testkit.assert_true(
  not exists (select 1 from pin_attempts where username = 'capuser7'),
  'seventh account was not counted');
rollback;

-- ---------------------------------------------------------------------------
-- search_path (0037) and the 25-function grant review (0038).
-- ---------------------------------------------------------------------------
begin;
select testkit.assert_true(
  (
    select bool_and(
      exists (
        select 1 from unnest(coalesce(p.proconfig, array[]::text[])) as c
         where c = 'search_path=public'
      )
    )
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'guard_last_owner', 'guard_same_day_edit', 'set_updated_at',
        'fill_agent_name', 'force_insert_attribution', 'guard_insert_today',
        'guard_month_lock', 'guard_month_lock_text'
      )
  ),
  'eight trigger functions pin search_path to public');

select testkit.assert_true(
  (
    select count(*) = 8
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'guard_last_owner', 'guard_same_day_edit', 'set_updated_at',
        'fill_agent_name', 'force_insert_attribution', 'guard_insert_today',
        'guard_month_lock', 'guard_month_lock_text'
      )
  ),
  'the eight functions are present once each');

select testkit.assert_true(
  (
    select bool_and(
      has_function_privilege('authenticated', s::regprocedure, 'EXECUTE')
      and not exists (
        select 1
          from pg_proc p
          join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a on true
         where p.oid = s::regprocedure
           and a.grantee = 0
           and a.privilege_type = 'EXECUTE'
      )
    )
    from unnest(array[
      'public.public_factory_name()',
      'public.login_lock_status(text)',
      'public.log_failed_login(text,text)',
      'public.log_login_attempt(text,boolean,text)',
      'public.clear_login_failures()',
      'public.app_role()',
      'public.app_agent_id()',
      'public.has_role(user_role)',
      'public.is_owner_manager()',
      'public.is_staff_plus()',
      'public.agent_outstanding(uuid)',
      'public.agent_held_totals()',
      'public.agent_detail_stats(uuid)',
      'public.collections_summary(date,date)',
      'public.inventory_totals()',
      'public.report_range(date,date)',
      'public.report_months(text,integer,date,date)',
      'public.report_aging(date)',
      'public.data_quality_scan()',
      'public.my_card_tier()',
      'public.finalize_closeout(uuid,integer,integer,text)',
      'public.hard_delete_agent(uuid)',
      'public.pay_month(uuid,text)',
      'public.admin_create_user(text,text,text,uuid,text)',
      'public.admin_reset_pin(uuid,text)'
    ]) as s
  ),
  '25 definer functions: authenticated kept, PUBLIC revoked');

select testkit.assert_true(
  has_function_privilege('anon', 'public.public_factory_name()', 'EXECUTE')
  and has_function_privilege('anon', 'public.login_lock_status(text)', 'EXECUTE')
  and has_function_privilege('anon', 'public.log_failed_login(text,text)', 'EXECUTE')
  and has_function_privilege('anon', 'public.log_login_attempt(text,boolean,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.clear_login_failures()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_create_user(text,text,text,uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_reset_pin(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.finalize_closeout(uuid,integer,integer,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.hard_delete_agent(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.pay_month(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.agent_outstanding(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.record_login_failure(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.guard_month_lock()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.guard_last_owner()', 'EXECUTE'),
  'anon stays on the four pre-login functions; internal functions stay closed');
rollback;

select '10_api_gap_fixes: all assertions passed';
