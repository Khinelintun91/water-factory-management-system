-- 0037: pin search_path on the eight invoker trigger functions the
-- security advisor flagged. Bodies are the latest definitions
-- (0003 set_updated_at, 0005 force_insert_attribution, 0006
-- fill_agent_name, 0008 guard_same_day_edit and guard_month_lock,
-- 0009 guard_month_lock_text, 0018 guard_insert_today, 0026
-- guard_last_owner). CREATE OR REPLACE keeps the triggers and the
-- grants 0026/0028 already set. search_path = public matches every
-- other function in this repo. auth.uid() in force_insert_attribution
-- is schema-qualified, so it does not need auth on the path.
--
-- Does not depend on 0030 or 0031.

create or replace function public.set_updated_at() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end $$;

create or replace function public.force_insert_attribution() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new := jsonb_populate_record(new, jsonb_build_object(
    'created_at', now(),
    'created_by', auth.uid()
  ));
  return new;
end $$;

create or replace function public.fill_agent_name() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.agent_id is not null then
    select name into new.agent_name from agents where id = new.agent_id;
  end if;
  return new;
end $$;

create or replace function public.guard_same_day_edit() returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Agent hard-delete cascade: only agent_id was nulled -> allow.
  -- 0032 no longer deletes agents. The bypass stays so a replica
  -- restore or an old cascade shape is not rejected by this guard.
  if tg_op = 'UPDATE'
     and (to_jsonb(old) ? 'agent_id')
     and (to_jsonb(old) ->> 'agent_id') is not null
     and (to_jsonb(new) ->> 'agent_id') is null
     and (to_jsonb(old) - 'agent_id' - 'updated_at')
         = (to_jsonb(new) - 'agent_id' - 'updated_at') then
    return new;
  end if;
  if (old.created_at at time zone 'Asia/Yangon')::date
     <> (now() at time zone 'Asia/Yangon')::date then
    raise exception 'same_day_only: records can only be edited or deleted on the day they were created';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create or replace function public.guard_month_lock() returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_date_field text := tg_argv[0];
  v_old_month date;
  v_new_month date;
begin
  -- Agent hard-delete cascade: only agent_id was nulled -> allow.
  if tg_op = 'UPDATE'
     and (to_jsonb(old) ? 'agent_id')
     and (to_jsonb(old) ->> 'agent_id') is not null
     and (to_jsonb(new) ->> 'agent_id') is null
     and (to_jsonb(old) - 'agent_id' - 'updated_at')
         = (to_jsonb(new) - 'agent_id' - 'updated_at') then
    return new;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_old_month := date_trunc('month', (to_jsonb(old) ->> v_date_field)::date)::date;
    if exists (select 1 from month_locks where month = v_old_month) then
      raise exception 'month_locked: % is locked', v_old_month;
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new_month := date_trunc('month', (to_jsonb(new) ->> v_date_field)::date)::date;
    if exists (select 1 from month_locks where month = v_new_month) then
      raise exception 'month_locked: % is locked', v_new_month;
    end if;
    return new;
  end if;
  return old;
end $$;

create or replace function public.guard_month_lock_text() returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_field text := tg_argv[0];
  v_month date;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_month := ((to_jsonb(old) ->> v_field) || '-01')::date;
    if exists (select 1 from month_locks where month = v_month) then
      raise exception 'month_locked: % is locked', to_char(v_month, 'YYYY-MM');
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_month := ((to_jsonb(new) ->> v_field) || '-01')::date;
    if exists (select 1 from month_locks where month = v_month) then
      raise exception 'month_locked: % is locked', to_char(v_month, 'YYYY-MM');
    end if;
    return new;
  end if;
  return old;
end $$;

create or replace function public.guard_insert_today() returns trigger
language plpgsql
set search_path = public
as $$
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

create or replace function public.guard_last_owner() returns trigger
language plpgsql
set search_path = public
as $$
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
