-- 0007_hard_delete_fix.sql — Fix hard_delete_agent (found in Phase A tests).
--
-- Problem: deleting an agent fires ON DELETE SET NULL on child tables,
-- which fires the child tables' BEFORE UPDATE triggers (entries_before_write
-- raised 'agent_not_found' on the nulled row; the same-day and month-lock
-- guards would also block the cascade for older rows).
--
-- Fix: the RPC detaches child rows itself with triggers temporarily
-- disabled (session_replication_role = replica, local to this transaction),
-- then deletes the agent normally so the agent's own DELETE is audited.
-- Child rows keep their agent_name snapshots (old-app behaviour).

create or replace function hard_delete_agent(p_agent uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_role() <> 'owner' then
    raise exception 'forbidden: owner only';
  end if;
  if not exists (select 1 from agent_settlements where agent_id = p_agent) then
    raise exception 'not_settled: စာရင်းမပိတ်ရသေးပါ';
  end if;

  perform set_config('session_replication_role', 'replica', true);
  update daily_entries     set agent_id = null where agent_id = p_agent;
  update agent_payments    set agent_id = null where agent_id = p_agent;
  update agent_deposits    set agent_id = null where agent_id = p_agent;
  update write_offs        set agent_id = null where agent_id = p_agent;
  update agent_settlements set agent_id = null where agent_id = p_agent;
  update profiles          set agent_id = null where agent_id = p_agent;
  perform set_config('session_replication_role', 'origin', true);

  delete from agents where id = p_agent;
end $$;

-- Robustness: the entry guard ignores rows whose agent has been detached.
create or replace function entries_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_agent       agents%rowtype;
  v_held        integer;
  v_dep_bottles integer;
  v_due         bigint;
  v_old_due     bigint := 0;
begin
  if new.agent_id is null then
    return new;
  end if;
  select * into v_agent from agents where id = new.agent_id;
  if v_agent.id is null then
    raise exception 'agent_not_found';
  end if;
  if v_agent.closed_at is not null then
    raise exception 'agent_closed: this agent has been closed out';
  end if;

  if tg_op = 'INSERT' then
    new.unit_price := v_agent.default_unit_price;
  end if;
  new.amount := new.delivered_qty::bigint * new.unit_price;

  select coalesce(sum(delivered_qty - returned_qty), 0) into v_held
    from daily_entries
    where agent_id = new.agent_id and (tg_op = 'INSERT' or id <> new.id);
  v_held := v_held + (new.delivered_qty - new.returned_qty);

  if v_agent.bottle_limit > 0 and v_held > v_agent.bottle_limit then
    raise exception 'bottle_limit: exceeds the bottle limit by % bottles',
      v_held - v_agent.bottle_limit;
  end if;

  if v_agent.deposit_per_bottle > 0 then
    select coalesce(sum(bottles), 0) into v_dep_bottles
      from agent_deposits where agent_id = new.agent_id;
    if v_held > v_dep_bottles then
      raise exception 'deposit_limit: exceeds deposit bottles by % — top-up % MMK needed',
        v_held - v_dep_bottles,
        (v_held - v_dep_bottles) * v_agent.deposit_per_bottle;
    end if;
  end if;

  if app_role() = 'staff' and v_agent.credit_limit > 0 then
    v_due := new.delivered_qty::bigint * new.unit_price - new.amount_collected;
    if tg_op = 'UPDATE' then
      v_old_due := old.delivered_qty::bigint * old.unit_price - old.amount_collected;
    end if;
    if agent_outstanding(new.agent_id) - v_old_due + v_due > v_agent.credit_limit then
      raise exception 'credit_limit: agent debt would exceed the credit limit';
    end if;
  end if;

  return new;
end $$;
