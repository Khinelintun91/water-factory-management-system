-- tests/helpers.sql — assertion helpers for the SQL suite, applied by
-- the runner AFTER the fixture, into a dedicated `testkit` schema.
-- (Not pg_temp: the runner sends each test file as one query string,
-- and temp functions created at the top of such a file are rolled
-- back together with the first scenario's transaction block. A real
-- schema in the throwaway test database has no such trap.)
-- Test scaffolding only — never apply to a real Supabase project.

create schema if not exists testkit;
-- The simulated roles must be able to call the helpers while
-- `set local role` is active.
grant usage on schema testkit to anon, authenticated, service_role;

create or replace function testkit.assert_true(p_cond boolean, p_label text)
returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'ASSERT FAILED: %', p_label;
  end if;
end $$;

-- assert_error(marker, sql): the statement MUST fail, and the error
-- message must start with the marker ('' accepts any error).
create or replace function testkit.assert_error(p_marker text, p_sql text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if p_marker = '' or sqlerrm like p_marker || '%' then return; end if;
    raise exception 'ASSERT FAILED: expected error "%" but got "%"', p_marker, sqlerrm;
  end;
  raise exception 'ASSERT FAILED: expected error "%" but the statement succeeded', p_marker;
end $$;
