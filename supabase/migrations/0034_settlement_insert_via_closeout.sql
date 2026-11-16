-- 0034: a direct insert into agent_settlements cannot skip
-- finalize_closeout's checks.
--
-- 0006's settlements_insert policy let any owner/manager insert a
-- settlement row. That row did not run the receivable, bottle, or
-- price checks, and it did not set closed_at. finalize_closeout is
-- SECURITY DEFINER, so it bypasses RLS and is the intended writer.
--
-- The trigger allows the insert only when current_user is the owner
-- of finalize_closeout. Inside that function, current_user is the
-- owner, so its INSERT still works. A client session stays
-- `authenticated` and is rejected even if it sets a GUC. This does
-- not replace finalize_closeout, so it stays valid whether or not
-- 0031 has replaced that function (0031's body is still the same
-- owner, and still inserts one settlement row). service_role is not
-- the function owner, so it cannot insert either.
--
-- The client insert policy is dropped as well. Select stays.
-- No update or delete policy is added.
--
-- Does not depend on 0030 or 0031.

create or replace function public.guard_settlement_insert()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_owner name;
begin
  select pg_get_userbyid(p.proowner) into v_owner
    from pg_proc p
   where p.oid = 'public.finalize_closeout(uuid,integer,integer,text)'::regprocedure;

  if current_user is distinct from v_owner then
    raise exception 'settlement_via_closeout_only: agent_settlements are inserted only by finalize_closeout'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger settlements_via_closeout
  before insert on public.agent_settlements
  for each row execute function public.guard_settlement_insert();

revoke all on function public.guard_settlement_insert() from public, anon, authenticated;

drop policy if exists settlements_insert on public.agent_settlements;
