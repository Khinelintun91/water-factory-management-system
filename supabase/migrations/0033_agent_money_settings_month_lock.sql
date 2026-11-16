-- 0033: month-lock the agent columns that feed new money, and keep
-- the audit that already records every change.
--
-- OWNER DECISION (conservative, because SPEC is ambiguous here):
--   SPEC rule 4 is same-day edit/delete of a record. An agent's price,
--   deposit, bottle limit and credit limit are the live settings for
--   the next delivery (SPEC rule 7). Freezing them on the creation day
--   would make a price change impossible after that day, so this
--   migration does NOT put guard_same_day_edit on agents.
--   SPEC rule 6 is a locked month on business tables, with no role
--   exemption. Historical money does not live on the agent row:
--   daily_entries.unit_price is snapshotted at insert (0006) and
--   agent_deposits stores price_per_bottle and amount. Those dated
--   rows already have month-lock triggers. Changing the agent settings
--   later does not rewrite them.
--   What this migration adds: while the CURRENT Asia/Yangon month is
--   locked, default_unit_price, deposit_per_bottle, bottle_limit and
--   credit_limit cannot change (any role, owner included). A lock on
--   a past month does not freeze them — one old lock would otherwise
--   freeze prices forever. active, name, notes, trip_qty and the
--   close/archive columns are not money snapshots and stay editable.
--   agents_audit (0003) already writes old_data and new_data for every
--   update. That trigger is unchanged.
--
-- The check reads month_locks. locks_select is true for every
-- authenticated user (0002), same as guard_month_lock. Invoker, not
-- definer, so current_user stays the caller.
--
-- Does not depend on 0030 or 0031. It does not touch closed_at or
-- closed_by, so 0031's trigger ignores these updates.

create or replace function public.guard_agent_money_settings()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_month date;
begin
  if new.default_unit_price is not distinct from old.default_unit_price
     and new.deposit_per_bottle is not distinct from old.deposit_per_bottle
     and new.bottle_limit is not distinct from old.bottle_limit
     and new.credit_limit is not distinct from old.credit_limit then
    return new;
  end if;

  v_month := date_trunc(
    'month', (now() at time zone 'Asia/Yangon')::date
  )::date;
  if exists (select 1 from month_locks where month = v_month) then
    raise exception 'month_locked: % is locked', v_month
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger agents_money_settings
  before update on public.agents
  for each row execute function public.guard_agent_money_settings();

revoke all on function public.guard_agent_money_settings() from public, anon, authenticated;
