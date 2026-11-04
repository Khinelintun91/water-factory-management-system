-- 0018_owner_backdate_exception.sql — Owner exception to the insert-date guard.
--
-- User decision 2026-11-04 (amends the 0004 rule): records must still be
-- dated today (Asia/Yangon) for staff, managers and agents, but the OWNER
-- may insert backdated records (e.g. re-entering a missed day). This
-- replaces guard_insert_today() only — the four BEFORE INSERT triggers
-- from 0004 are unchanged, and so are the month-lock triggers (a locked
-- month still rejects owner inserts) and the same-day edit/delete guard.
--
-- The check uses app_role() (0002, current version 0005): it reads the
-- PRIMARY profiles.role for auth.uid() and returns NULL when there is no
-- auth context (management-API inserts) or the profile is inactive, so
-- both of those stay guarded. has_role() is deliberately NOT used: it
-- also honours extra user_roles rows, while this exception belongs to
-- the primary owner alone — co_owner does NOT qualify.

create or replace function guard_insert_today() returns trigger
language plpgsql as $$
declare
  v_date date;
begin
  if app_role() = 'owner' then
    return new;
  end if;
  v_date := (to_jsonb(new) ->> tg_argv[0])::date;
  if v_date is distinct from (now() at time zone 'Asia/Yangon')::date then
    raise exception 'same_day_only: % must be today (Asia/Yangon)', tg_argv[0]
      using errcode = 'P0001';
  end if;
  return new;
end $$;
