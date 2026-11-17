-- 0032: archive a closed agent instead of deleting the row.
--
-- SPEC (Backups and data safety): business data is never deleted.
-- hard_delete_agent (0006, current body 0008) DELETE FROM agents, and
-- agent_contacts is ON DELETE CASCADE, so the phone row disappeared
-- with the agent. Ledger rows survived only because 0006 used
-- ON DELETE SET NULL. This migration keeps the RPC name the Agents
-- detail button already calls, and changes the body to an archive:
-- the agents row, the phone row, and every ledger row stay, with
-- agent_id still set. agents_audit already records the update
-- (old_data / new_data). There is no purge.
--
-- archived_at / archived_by change only inside this function. A client
-- can set the transaction-local GUC and still fail, because the
-- trigger also requires current_user to be the function owner.
-- current_user inside this SECURITY DEFINER function is that owner.
-- A direct DELETE is rejected for every role, including the table
-- owner (session_replication_role = replica still skips triggers;
-- that path is maintenance and restore, not the app).
--
-- Does not read or replace anything from 0030 or 0031. The update
-- below does not touch closed_at or closed_by, so 0031's close-column
-- trigger (if already applied) lets it through. Apply 0030 then 0031
-- first when those PRs are merged; this file does not require them.

alter table public.agents
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.profiles (id) on delete set null;

comment on column public.agents.archived_at is
  'Set by hard_delete_agent. The row stays; the working list hides it.';

create or replace function public.hard_delete_agent(p_agent uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if app_role() <> 'owner' then
    raise exception 'forbidden: owner only';
  end if;
  if not exists (select 1 from agents where id = p_agent) then
    raise exception 'agent_not_found';
  end if;
  -- Second press of the same button is a no-op. The row is already kept.
  if exists (select 1 from agents where id = p_agent and archived_at is not null) then
    return;
  end if;
  if not exists (select 1 from agent_settlements where agent_id = p_agent) then
    raise exception 'not_settled: စာရင်းမပိတ်ရသေးပါ';
  end if;

  perform set_config('wf.agent_archive', 'hard_delete_agent', true);
  update agents
     set archived_at = now(),
         archived_by = auth.uid(),
         active = false
   where id = p_agent;
  perform set_config('wf.agent_archive', '', true);
end $$;

create or replace function public.guard_agent_archive_columns()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_owner name;
begin
  if new.archived_at is not distinct from old.archived_at
     and new.archived_by is not distinct from old.archived_by then
    return new;
  end if;

  select pg_get_userbyid(p.proowner) into v_owner
    from pg_proc p
   where p.oid = 'public.hard_delete_agent(uuid)'::regprocedure;

  if current_user is distinct from v_owner
     or current_setting('wf.agent_archive', true) is distinct from 'hard_delete_agent' then
    raise exception 'archive_columns_locked: archived_at and archived_by change only inside hard_delete_agent';
  end if;
  return new;
end $$;

create trigger agents_archive_columns
  before update on public.agents
  for each row execute function public.guard_agent_archive_columns();

create or replace function public.guard_agent_not_deleted()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'business_data_kept: agents are archived, never deleted'
    using errcode = 'P0001';
end $$;

create trigger agents_never_delete
  before delete on public.agents
  for each row execute function public.guard_agent_not_deleted();

revoke all on function public.guard_agent_archive_columns() from public, anon, authenticated;
revoke all on function public.guard_agent_not_deleted() from public, anon, authenticated;
