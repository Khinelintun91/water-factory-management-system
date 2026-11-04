-- 0023_agent_stats_inventory_rpc.sql — Click-through audit fixes (wave 2,
-- 2026-11-04): per-agent and inventory aggregates move server-side.
--
-- Problem: AgentDetailPage and CloseoutPage computed bottles-held by
-- reducing over client-fetched daily_entries. PostgREST silently caps
-- every response at 1,000 rows, so for an agent with 1,312 entry rows the
-- detail page showed held 1,071 and the close-out wizard 1,065 while the
-- true figure (SQL over all rows, and the Agents list via
-- agent_held_totals) is 1,396. The wizard also PRE-FILLS "returned" with
-- that wrong held, which would overstate missing bottles at close-out and
-- overcharge the agent. InventoryPage likewise downloaded all 12,423
-- entry rows just to compute delivered/returned sums.
--
-- agent_detail_stats(p_agent): every aggregate the detail and close-out
-- pages need, computed over the FULL tables. Access: staff-plus (the
-- pages' own roles), OR the agent themself when p_agent is their linked
-- agent (so an agent-scoped caller can never read another agent's stats).
-- inventory_totals(): the movement/entry sums behind the stock formulas,
-- mirroring InventoryPage's client math exactly (movement kinds in/out
-- are legacy and were ignored by the page; entries supply out/in).
-- Gate style mirrors 0022: raise 42501 for unauthorized callers.

create or replace function public.agent_detail_stats(p_agent uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (
    public.is_staff_plus()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.active and p.agent_id = p_agent
    )
  ) then
    raise exception 'agent_detail_stats: not allowed'
      using errcode = '42501';
  end if;

  return (
    select jsonb_build_object(
      'held', coalesce(sum(delivered_qty - returned_qty), 0),
      'sales', coalesce(sum(amount), 0),
      'collectedEntries', coalesce(sum(amount_collected), 0)
    )
    from public.daily_entries
    where agent_id = p_agent
  ) || (
    select jsonb_build_object(
      'paymentsTotal', coalesce(sum(amount), 0)
    )
    from public.agent_payments
    where agent_id = p_agent
  ) || (
    select jsonb_build_object(
      'depBottles', coalesce(sum(bottles), 0),
      'depAmount', coalesce(sum(amount), 0)
    )
    from public.agent_deposits
    where agent_id = p_agent
  );
end;
$$;

revoke execute on function public.agent_detail_stats(uuid) from public, anon;
grant execute on function public.agent_detail_stats(uuid) to authenticated;

create or replace function public.inventory_totals()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_staff_plus() then
    raise exception 'inventory_totals: not allowed'
      using errcode = '42501';
  end if;

  return (
    select jsonb_build_object(
      'produced', coalesce(sum(bottles) filter (where kind = 'produce'), 0),
      'purchased', coalesce(sum(bottles) filter (where kind = 'purchase'), 0),
      'damaged', coalesce(sum(bottles) filter (where kind = 'damage'), 0),
      'adjustments', coalesce(sum(bottles) filter (where kind = 'adjust'), 0)
    )
    from public.inventory_movements
  ) || (
    select jsonb_build_object(
      'outQty', coalesce(sum(delivered_qty), 0),
      'inQty', coalesce(sum(returned_qty), 0)
    )
    from public.daily_entries
  );
end;
$$;

revoke execute on function public.inventory_totals() from public, anon;
grant execute on function public.inventory_totals() to authenticated;
