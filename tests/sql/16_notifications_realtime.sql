-- 16_notifications_realtime.sql — 0043: public.notifications is a member
-- of the supabase_realtime publication, so Supabase Realtime can stream
-- INSERT/UPDATE events for it to the signed-in owner of each row (RLS
-- still applies to delivery; see 0011 policies). The plain-PostgreSQL
-- rig has no platform publication until 0043 creates it, so a green
-- run here also proves the migration's create-if-missing path.
-- The 0043 DO block is re-run below to prove idempotency: re-applying
-- the migration must neither fail nor duplicate the membership.

begin;

select testkit.assert_true(
  exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'notifications'
  ),
  'notifications is a member of supabase_realtime after apply_all');

-- Re-run the exact 0043 statements: no error, no duplicate membership.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

select testkit.assert_true(
  (select count(*)
     from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications') = 1,
  're-running 0043 leaves exactly one membership row');

rollback;
