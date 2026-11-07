-- 0031: close columns change only inside finalize_closeout.
--
-- 0002 lets owner/manager UPDATE any agents column. That includes
-- closed_at and closed_by, so a direct update could stamp or clear a
-- close-out without finalize_closeout. This migration blocks that.
--
-- The legitimate writer is the single UPDATE inside finalize_closeout
-- (0006, replaced here only to set and clear a transaction-local GUC
-- around that statement). The caller gate, settlement math, and
-- already_closed check are unchanged.
--
-- The BEFORE UPDATE trigger allows a change to closed_at or closed_by
-- only when BOTH are true:
--   1. current_user is the owner of finalize_closeout. Inside that
--      SECURITY DEFINER function, current_user is the owner. A client
--      session's current_user stays authenticated (or whichever role
--      it SET). It cannot SET ROLE to the function owner.
--   2. the transaction-local GUC wf.agent_close_write equals
--      'finalize_closeout', which only this function sets, and which
--      it clears before returning.
-- A client can set the GUC (set_config is not a privileged call) and
-- still fail check 1. The function owner can set the GUC and pass;
-- that is the same privilege as owning the function and disabling
-- the trigger, not a client bypass.
--
-- Comparisons are IS DISTINCT FROM, so null to value, value to null,
-- and value to a different value are all guarded, while writing the
-- current value back is not a change.
--
-- AgentsPage updates that do not touch those columns stay allowed:
-- active, default_unit_price, deposit_per_bottle, bottle_limit,
-- credit_limit, trip_qty. Inserts are unchanged. RLS, the
-- finalize_closeout owner/manager gate, audit, month lock, and
-- same-day guards are unchanged. agents still has no same-day guard
-- (0027).
--
-- Numbering: 0030 is not in this branch. It is PR #4. When the owner
-- applies both, apply 0030 first, then 0031. 0031 does not read any
-- object created by 0030.

create or replace function public.guard_agent_close_columns()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_owner name;
begin
  if new.closed_at is not distinct from old.closed_at
     and new.closed_by is not distinct from old.closed_by then
    return new;
  end if;

  select pg_get_userbyid(p.proowner) into v_owner
    from pg_proc p
   where p.oid = 'public.finalize_closeout(uuid,integer,integer,text)'::regprocedure;

  if current_user is distinct from v_owner
     or current_setting('wf.agent_close_write', true) is distinct from 'finalize_closeout' then
    raise exception 'close_columns_locked: closed_at and closed_by change only inside finalize_closeout';
  end if;
  return new;
end $$;

revoke all on function public.guard_agent_close_columns() from public, anon;
grant execute on function public.guard_agent_close_columns() to authenticated;

create trigger agents_close_columns
  before update on agents
  for each row execute function public.guard_agent_close_columns();

create or replace function finalize_closeout(
  p_agent uuid, p_returned integer, p_current_price integer, p_note text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_agent     agents%rowtype;
  v_held      integer;
  v_dep_btls  integer;
  v_dep_amt   bigint;
  v_avg       numeric;
  v_missing   integer;
  v_missing_dep   integer;
  v_returned_dep  integer;
  v_orig_ret  numeric;
  v_curr_ret  numeric;
  v_rose      boolean;
  v_refund    bigint;
  v_diff      bigint;
  v_kind      text;
  v_forfeit   bigint;
  v_net       numeric;
  v_row       agent_settlements%rowtype;
  v_cat_id    uuid;
  v_today     date := (now() at time zone 'Asia/Yangon')::date;
begin
  if not is_owner_manager() then
    raise exception 'forbidden: owner/manager only';
  end if;
  select * into v_agent from agents where id = p_agent;
  if v_agent.id is null then raise exception 'agent_not_found'; end if;
  if v_agent.closed_at is not null
     or exists (select 1 from agent_settlements where agent_id = p_agent) then
    raise exception 'already_closed: စာရင်းပိတ်ပြီးသားပါ';
  end if;

  select coalesce(sum(delivered_qty - returned_qty), 0) into v_held
    from daily_entries where agent_id = p_agent;
  select coalesce(sum(bottles), 0), coalesce(sum(amount), 0)
    into v_dep_btls, v_dep_amt
    from agent_deposits where agent_id = p_agent;

  if p_returned is null or p_returned < 0 or p_returned > v_held then
    raise exception 'bad_returned: ပြန်အပ်ဘူး အရေအတွက် မမှန်ပါ';
  end if;
  if agent_outstanding(p_agent) > 0 then
    raise exception 'receivable_open: ရရန်ကျန်ငွေ မရှင်းရသေးပါ';
  end if;
  if p_current_price is null or p_current_price <= 0 then
    raise exception 'bad_price: ယနေ့ ပေါက်ဈေး ထည့်ပါ';
  end if;

  -- Settlement math — identical to the old app's settlement.ts.
  v_missing      := greatest(v_held - p_returned, 0);
  v_avg          := case when v_dep_btls > 0 then v_dep_amt::numeric / v_dep_btls else 0 end;
  v_missing_dep  := least(v_missing, v_dep_btls);
  v_returned_dep := greatest(v_dep_btls - v_missing_dep, 0);
  v_orig_ret     := v_avg * v_returned_dep;
  v_curr_ret     := p_current_price::numeric * v_returned_dep;
  v_rose         := v_curr_ret > v_orig_ret;
  v_refund       := round(case when v_rose then v_curr_ret else v_orig_ret end)::bigint;
  v_diff         := round(abs(v_curr_ret - v_orig_ret))::bigint;
  v_kind         := case when v_diff = 0 then 'none'
                         when v_rose then 'extra_pay' else 'price_drop' end;
  v_forfeit      := v_missing::bigint * p_current_price;
  v_net          := v_refund + v_avg * v_missing_dep - v_forfeit;

  insert into agent_settlements (
    agent_id, settle_date, held_bottles, returned_bottles, missing_bottles,
    current_price, deposit_original, refund_amount, price_diff, price_diff_kind,
    forfeiture_income, net_refund, agent_owes, note, created_by
  ) values (
    p_agent, v_today, v_held, p_returned, v_missing,
    p_current_price, v_dep_amt, v_refund, v_diff, v_kind,
    v_forfeit, greatest(round(v_net), 0)::bigint, greatest(round(-v_net), 0)::bigint,
    p_note, auth.uid()
  ) returning * into v_row;

  if v_diff > 0 then
    select id into v_cat_id from expense_categories where name = 'ဗူးအပေါင် ဈေးကွာ';
    insert into expenses (expense_date, category_id, title, amount, notes, created_by)
    values (
      v_today, v_cat_id,
      v_agent.name || ' — ' || case when v_kind = 'extra_pay'
                                    then 'ဈေးတက်၍ အပိုပြန်ပေး'
                                    else 'ဈေးကျ၍ မူလအပေါင်အပြည့်ပြန်အမ်း' end,
      v_diff,
      'Agent close-out price difference',
      auth.uid()
    );
  end if;

  -- Local flag only. Cleared before return so the caller's transaction
  -- cannot reuse it. The trigger also requires current_user to be this
  -- function's owner, which a client SET ROLE cannot become.
  perform set_config('wf.agent_close_write', 'finalize_closeout', true);
  update agents
    set closed_at = now(), closed_by = auth.uid(), active = false
    where id = p_agent;
  perform set_config('wf.agent_close_write', '', true);

  return to_jsonb(v_row);
end $$;
