-- 0040: my_card_tier() — fixed lifetime-sales thresholds replace the
-- rank-thirds rule of 0024 (owner's rule, 2026-11-16):
--   lifetime sales >= 20,000,000 MMK  → 'gold'
--   lifetime sales >= 10,000,000 MMK  → 'white'
--   below that (including zero)       → 'black'
--
-- The tier now depends ONLY on the caller's own lifetime sales, so the
-- ranked CTE over every agent is gone entirely: the function reads the
-- caller's own agent id from profiles and sums only that agent's
-- daily_entries.amount. It returns ONLY the caller's tier and their
-- own lifetime sales total — never another agent's figures.
--
-- sales_rank / agent_count are dropped from the result: with fixed
-- thresholds there is no rank to report. Callers (MyPage, AgentHome)
-- are updated in the same change — My Page shows the lifetime-sales
-- caption instead of the rank caption. The client-side mirror is
-- cardTierForSales() in src/lib/cardFace.ts.
--
-- CREATE OR REPLACE cannot change a function's return type, so the
-- 0024 function is dropped and recreated; the grants from 0024 are
-- re-asserted below (authenticated only, as before).
drop function if exists public.my_card_tier();

create function public.my_card_tier()
returns table(tier text, lifetime_sales bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent uuid;
  v_sales bigint;
begin
  select agent_id into v_agent
  from profiles
  where id = auth.uid() and active;

  if v_agent is null then
    return;
  end if;

  select coalesce(sum(e.amount), 0)::bigint into v_sales
  from daily_entries e
  where e.agent_id = v_agent;

  return query select
    case
      when v_sales >= 20000000 then 'gold'
      when v_sales >= 10000000 then 'white'
      else 'black'
    end,
    v_sales;
end;
$$;

revoke execute on function public.my_card_tier() from public, anon;
grant execute on function public.my_card_tier() to authenticated;
