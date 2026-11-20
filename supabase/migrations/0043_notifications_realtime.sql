-- 0043_notifications_realtime.sql — instant in-app notifications.
--
-- Notification ROWS have always been written instantly: the DB triggers
-- from 0011 (and the notify triggers added since) insert into
-- public.notifications in the same transaction as the delivery, payment,
-- dispute, or damage charge that caused them. What was missing is the
-- DELIVERY to an already-open app: the client polled every 30 seconds,
-- and phone browsers suspend background timers, so a signed-in user
-- often saw a new notification only after a manual refresh.
--
-- This migration adds public.notifications to the `supabase_realtime`
-- publication, which is what Supabase Realtime (postgres_changes)
-- streams. The client (NotificationBell) subscribes to INSERT/UPDATE
-- on its own rows and reloads on any event; the 30-second poll stays
-- as a fallback.
--
-- ACCESS: nothing widens. Realtime evaluates the table's RLS policies
-- for the subscriber's JWT before delivering an event, and the 0011
-- policies on notifications are own-rows-only (user_id = auth.uid()),
-- so a user can only ever receive events for their own notifications.
-- The client filter (user_id=eq.<own id>) is a second narrowing, not
-- the enforcement.
--
-- IDEMPOTENT, in the style of 0001/0012 creating platform objects they
-- rely on (`create extension if not exists pgcrypto` / `pg_cron`):
--   * A real Supabase project already has the `supabase_realtime`
--     publication; it is created here ONLY when missing, so this file
--     also runs clean on a plain PostgreSQL (the test-suite rig, the
--     restore drill) where the platform object does not exist.
--   * The table is added only when it is not already a member, so
--     re-running this file (or apply_all.sql) never fails.

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
