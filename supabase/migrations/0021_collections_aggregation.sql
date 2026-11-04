-- 0021_collections_aggregation.sql — Performance wave P2: server-side
-- aggregation for the Collections page and the Agents page.
--
-- Problem: CollectionsPage downloaded EVERY daily_entries row (12,423 at
-- seed volume), every agent_payments row and every write_offs row and
-- aggregated them in the browser (~90 s); AgentsPage downloaded every
-- daily_entries row just to compute bottles-held per agent. Both pages
-- now call one RPC each and receive one small result set.
--
-- collections_summary(p_from, p_to):
--   Per-agent sales / cash / payments / write-offs / outstanding in ONE
--   call, for every agent (agents with no activity return zeros, exactly
--   like the client-side defaults the page used before).
--   - Date bounds are optional; NULL/NULL means all time, which is what
--     the Collections page shows. A bounded range filters entries by
--     entry_date, payments by payment_date, write-offs by writeoff_date.
--   - The all-time outstanding column IS agent_outstanding(agent_id) —
--     the existing single source of truth (0006) also used by the
--     credit-limit guards — so this summary can never drift from the
--     per-agent balance. For a bounded range, outstanding is the
--     range-filtered components' difference (agent_outstanding itself
--     is all-time only).
--   - Component definitions match the old client aggregation exactly:
--     sales = sum(daily_entries.amount), cash = sum(amount_collected),
--     payments = sum(agent_payments.amount), write_offs = sum(amount);
--     rows with agent_id NULL (hard-deleted agents) are excluded, as
--     before.
--   - Access mirrors the /collections route guard (App.tsx): effective
--     owner/manager only, via is_owner_manager() (has_role honours
--     user_roles extras and co_owner = manager; inactive profiles fail).
--
-- agent_held_totals():
--   (agent_id, held) for every agent, held = sum(delivered_qty -
--   returned_qty) over daily_entries — the exact formula AgentsPage
--   computed client-side. Access mirrors the /agents route guard:
--   effective owner/manager/staff, via is_staff_plus().
--
-- Both functions are security definer with an internal role check (the
-- 0014 pattern): execute is granted to `authenticated`, and the check
-- inside is the real gate (anon callers have auth.uid() NULL, so
-- has_role is false and the call is rejected).

create or replace function collections_summary(
  p_from date default null,
  p_to date default null
)
returns table(
  agent_id uuid,
  sales bigint,
  cash bigint,
  payments bigint,
  write_offs bigint,
  outstanding bigint
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_owner_manager() then
    raise exception 'forbidden';
  end if;
  return query
  select
    a.id,
    coalesce(e.sales, 0)::bigint,
    coalesce(e.cash, 0)::bigint,
    coalesce(p.pay, 0)::bigint,
    coalesce(w.wo, 0)::bigint,
    case
      when p_from is null and p_to is null then agent_outstanding(a.id)
      else coalesce(e.sales, 0)::bigint - coalesce(e.cash, 0)::bigint
         - coalesce(p.pay, 0)::bigint - coalesce(w.wo, 0)::bigint
    end
  from agents a
  left join (
    select en.agent_id,
           sum(en.amount) as sales,
           sum(en.amount_collected) as cash
    from daily_entries en
    where en.agent_id is not null
      and (p_from is null or en.entry_date >= p_from)
      and (p_to is null or en.entry_date <= p_to)
    group by en.agent_id
  ) e on e.agent_id = a.id
  left join (
    select pm.agent_id, sum(pm.amount) as pay
    from agent_payments pm
    where pm.agent_id is not null
      and (p_from is null or pm.payment_date >= p_from)
      and (p_to is null or pm.payment_date <= p_to)
    group by pm.agent_id
  ) p on p.agent_id = a.id
  left join (
    select wo.agent_id, sum(wo.amount) as wo
    from write_offs wo
    where wo.agent_id is not null
      and (p_from is null or wo.writeoff_date >= p_from)
      and (p_to is null or wo.writeoff_date <= p_to)
    group by wo.agent_id
  ) w on w.agent_id = a.id;
end $$;

grant execute on function collections_summary(date, date) to authenticated;

create or replace function agent_held_totals()
returns table(agent_id uuid, held bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff_plus() then
    raise exception 'forbidden';
  end if;
  return query
  select a.id, coalesce(sum(e.delivered_qty - e.returned_qty), 0)::bigint
  from agents a
  left join daily_entries e on e.agent_id = a.id
  group by a.id;
end $$;

grant execute on function agent_held_totals() to authenticated;
