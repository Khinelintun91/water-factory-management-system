-- 10_agent_close_columns.sql — 0031 guard on agents.closed_at / closed_by.
-- Direct SET, CLEAR, and CHANGE are rejected for the client roles that
-- RLS allows to update agents (owner, manager), for a client who forges
-- the GUC, and for the session owner when the GUC is unset. The
-- authenticated role in these tests is reached with SET ROLE, so
-- session_user stays the login role; denial is not a superuser no-op.
-- finalize_closeout still closes agent C once and rejects a repeat.
-- AgentsPage fields stay writable. Each scenario rolls back.

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);

-- Writing the current null back is not a change. AgentsPage fields save.
update agents
   set closed_at = closed_at,
       closed_by = closed_by,
       default_unit_price = 350,
       deposit_per_bottle = 500,
       bottle_limit = 20,
       credit_limit = 1000,
       trip_qty = 12,
       active = false
 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select testkit.assert_true(
  (select default_unit_price = 350
      and deposit_per_bottle = 500
      and bottle_limit = 20
      and credit_limit = 1000
      and trip_qty = 12
      and active = false
      and closed_at is null
      and closed_by is null
     from agents where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'owner can edit AgentsPage fields while close columns stay null');
update agents
   set active = true
 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select testkit.assert_true(
  (select count(*) from audit_log
    where table_name = 'agents' and action = 'update'
      and row_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') >= 1,
  'a normal agent update is still audited');

-- SET on an open agent.
select testkit.assert_error('close_columns_locked',
  $$update agents set closed_at = now()
     where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$);
select testkit.assert_error('close_columns_locked',
  $$update agents set closed_by = '11111111-1111-4111-8111-111111111111'
     where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$);
select testkit.assert_error('close_columns_locked',
  $$update agents
       set default_unit_price = 1,
           closed_at = now(),
           closed_by = '11111111-1111-4111-8111-111111111111'
     where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$);
select testkit.assert_true(
  (select default_unit_price = 350 and closed_at is null and closed_by is null
     from agents where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'rejected close write did not change the price');

-- The GUC alone is not a bypass for a client session.
select set_config('wf.agent_close_write', 'finalize_closeout', true);
select testkit.assert_error('close_columns_locked',
  $$update agents set closed_at = now()
     where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$);
select set_config('wf.agent_close_write', '', true);

-- Manager passes RLS and still cannot stamp the columns.
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222"}', true);
update agents
   set trip_qty = 7
 where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select testkit.assert_true(
  (select trip_qty = 7 and closed_at is null
     from agents where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  'manager can edit trip_qty');
select testkit.assert_error('close_columns_locked',
  $$update agents set closed_at = now(), closed_by = '22222222-2222-4222-8222-222222222222'
     where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'$$);

-- Staff update is filtered by RLS (no error, no write).
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333"}', true);
update agents set closed_at = now()
 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
select testkit.assert_true(
  (select closed_at is null from agents
    where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'staff update did not set closed_at');

-- Session owner, GUC unset. SET ROLE is not in effect, so this is the
-- login role itself. It must still be rejected.
reset role;
select testkit.assert_error('close_columns_locked',
  $$update agents set closed_at = now()
     where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$);

-- Legitimate finalize, then CLEAR / CHANGE / repeat.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111"}', true);
select finalize_closeout('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 10, 1000, 'guard');
select testkit.assert_true(
  (select closed_at is not null
      and closed_by = '11111111-1111-4111-8111-111111111111'
      and active = false
     from agents where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'finalize sets closed_at, closed_by, and active');
select testkit.assert_true(
  coalesce(current_setting('wf.agent_close_write', true), '') <> 'finalize_closeout',
  'finalize cleared the close-write flag before returning');
select testkit.assert_error('already_closed',
  $$select finalize_closeout('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 10, 1000, 'again')$$);

select testkit.assert_error('close_columns_locked',
  $$update agents set closed_at = null
     where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$);
select testkit.assert_error('close_columns_locked',
  $$update agents set closed_at = now() - interval '1 day'
     where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$);
select testkit.assert_error('close_columns_locked',
  $$update agents set closed_by = null
     where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$);
select testkit.assert_error('close_columns_locked',
  $$update agents set closed_by = '22222222-2222-4222-8222-222222222222'
     where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$);
select testkit.assert_true(
  (select closed_by = '11111111-1111-4111-8111-111111111111'
      and closed_at is not null
     from agents where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'close columns unchanged after rejected clear and change');

-- Same closed values written back, plus an AgentsPage field, on a closed row.
update agents
   set closed_at = closed_at,
       closed_by = closed_by,
       default_unit_price = 360
 where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
select testkit.assert_true(
  (select default_unit_price = 360
      and closed_by = '11111111-1111-4111-8111-111111111111'
     from agents where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  'closed agent price edit does not disturb close columns');

-- Flag must not survive to a later direct update in this transaction.
select testkit.assert_error('close_columns_locked',
  $$update agents set closed_at = null
     where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'$$);

rollback;
reset role;
select '10_agent_close_columns: all assertions passed';
