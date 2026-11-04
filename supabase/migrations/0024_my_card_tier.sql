-- 0024: an agent's own sales-card tier, for the wallet face on My Page.
-- The tier rule mirrors CollectionsPage exactly: rank all agents by
-- lifetime sales (sum of daily_entries.amount), split into thirds — top
-- gold, middle white, bottom black; zero sales is always black. Returns
-- ONLY the caller's tier, rank and the agent count — never another agent's
-- figures (agents cannot call collections_summary; that stays staff-plus).
create or replace function public.my_card_tier()
returns table(tier text, sales_rank int, agent_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent uuid;
  v_rank int;
  v_count int;
  v_sales bigint;
  v_tier text;
begin
  select agent_id into v_agent
  from profiles
  where id = auth.uid() and active;

  if v_agent is null then
    return;
  end if;

  with sales as (
    select a.id, a.created_at, coalesce(sum(e.amount), 0)::bigint as total
    from agents a
    left join daily_entries e on e.agent_id = a.id
    group by a.id, a.created_at
  ),
  ranked as (
    select id, total,
           row_number() over (order by total desc, created_at asc, id asc) as rn,
           count(*) over () as cnt
    from sales
  )
  select rn::int, cnt::int, total into v_rank, v_count, v_sales
  from ranked
  where id = v_agent;

  if v_rank is null then
    return;
  end if;

  v_tier := case
    when v_sales <= 0 then 'black'
    when v_rank <= ceil(v_count / 3.0) then 'gold'
    when v_rank <= ceil(2 * v_count / 3.0) then 'white'
    else 'black'
  end;

  return query select v_tier, v_rank, v_count;
end;
$$;

revoke execute on function public.my_card_tier() from public, anon;
grant execute on function public.my_card_tier() to authenticated;
