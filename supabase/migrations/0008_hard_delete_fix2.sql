-- 0008_hard_delete_fix2.sql — Replace the 0007 approach.
--
-- session_replication_role cannot be set from a Supabase function
-- (permission denied), so instead the two guard functions learn to
-- recognise the ON DELETE SET NULL cascade: an UPDATE whose ONLY change
-- is agent_id -> null (the agent hard-delete detaching the row). Such
-- updates pass the same-day and month-lock guards untouched; the row
-- keeps its agent_name snapshot, exactly like the old app.

create or replace function guard_same_day_edit() returns trigger
language plpgsql as $$
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
  if (old.created_at at time zone 'Asia/Yangon')::date
     <> (now() at time zone 'Asia/Yangon')::date then
    raise exception 'same_day_only: records can only be edited or deleted on the day they were created';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create or replace function guard_month_lock() returns trigger
language plpgsql as $$
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

create or replace function hard_delete_agent(p_agent uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_role() <> 'owner' then
    raise exception 'forbidden: owner only';
  end if;
  if not exists (select 1 from agent_settlements where agent_id = p_agent) then
    raise exception 'not_settled: စာရင်းမပိတ်ရသေးပါ';
  end if;
  -- FKs are ON DELETE SET NULL; the guard bypasses above let the cascade
  -- updates through while the rows keep their agent_name snapshots.
  delete from agents where id = p_agent;
end $$;
