-- 0020_report_aggregation.sql — Server-side aggregation for the Reports page.
--
-- The Reports page used to fetchAll-scan the full daily_entries /
-- agent_payments / write_offs / agent_deposits / agent_settlements history
-- and aggregate in the browser (~30 s at 12k entries). These RPCs reproduce
-- the page's math EXACTLY in SQL (a port of the old app's getReport /
-- buildMonthlyTrend semantics, as already implemented client-side):
--
--   * per-agent receivable = max(0, sales - entry cash - payments
--     - write-offs) over ALL rows <= p_to; range figures use [p_from, p_to].
--   * aging allocates each agent's receivable to their NEWEST entries
--     first, bucketed by whole days between entry_date and p_to
--     (<=30 / 31-60 / >60).
--   * an agent with a settlement (<= p_to) shows deposit 0 and bottles 0;
--     its forfeiture_income / net_refund count only when settle_date is
--     inside the range.
--   * deleted agents (agent_id null after hard delete) group by the
--     agent_name snapshot under a 'deleted:<name>' key, exactly like the
--     client code.
--   * profit = sales + forfeiture - expenses - payroll(base+bonus)
--     - write-offs.
--
-- On top of the page-exact floored total, report_range also returns
-- `receivableRaw`: the UNfloored sum of per-agent balances. The two differ
-- when some agents are in credit (overpaid): the report card (old app
-- parity) floors each agent at 0, while the raw total matches the
-- Collections / agent_outstanding ledger total.
--
-- Access: every public function here raises unless the caller is an
-- effective owner/manager (is_owner_manager(): primary role + user_roles,
-- co_owner counts as manager — the same rule as the /reports route guard).

-- ---------------------------------------------------------------------------
-- Internal helper: aging allocation rows as of a date. NOT granted to
-- anon/authenticated; only the security-definer RPCs below call it.
-- ---------------------------------------------------------------------------
create or replace function _report_aging_rows(p_as_of date)
returns table (
  agent_key text,
  entry_date date,
  days integer,
  amount bigint,
  bucket text
)
language sql stable security definer set search_path = public as $$
  with bal as (
    select k.agent_key,
           greatest(0, sum(k.sales) - sum(k.coll) - sum(k.paid) - sum(k.wo)) as recv
    from (
      select coalesce(e.agent_id::text, 'deleted:' || coalesce(e.agent_name, 'null')) as agent_key,
             e.amount as sales, e.amount_collected as coll, 0::bigint as paid, 0::bigint as wo
      from daily_entries e
      where e.entry_date <= p_as_of
      union all
      select coalesce(p.agent_id::text, 'deleted:' || coalesce(p.agent_name, 'null')),
             0, 0, p.amount, 0
      from agent_payments p
      where p.payment_date <= p_as_of
      union all
      select coalesce(w.agent_id::text, 'deleted:' || coalesce(w.agent_name, 'null')),
             0, 0, 0, w.amount
      from write_offs w
      where w.writeoff_date <= p_as_of
    ) k
    group by k.agent_key
  ),
  walk as (
    select b.agent_key,
           e.entry_date,
           e.amount,
           coalesce(
             sum(greatest(e.amount, 0)) over (
               partition by b.agent_key
               order by e.entry_date desc, e.created_at desc, e.id desc
               rows between unbounded preceding and 1 preceding
             ), 0) as before_pos,
           b.recv
    from bal b
    join daily_entries e
      on coalesce(e.agent_id::text, 'deleted:' || coalesce(e.agent_name, 'null')) = b.agent_key
     and e.entry_date <= p_as_of
    where b.recv > 0
  )
  select w.agent_key,
         w.entry_date,
         (p_as_of - w.entry_date) as days,
         least(w.amount, w.recv - w.before_pos) as amount,
         case
           when (p_as_of - w.entry_date) <= 30 then 'd30'
           when (p_as_of - w.entry_date) <= 60 then 'd60'
           else 'd60p'
         end as bucket
  from walk w
  where w.amount > 0
    and w.before_pos < w.recv;
$$;

revoke execute on function _report_aging_rows(date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- report_range(p_from, p_to): the main range report in one round trip.
-- ---------------------------------------------------------------------------
create or replace function report_range(p_from date, p_to date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if not is_owner_manager() then
    raise exception 'owner_manager_only';
  end if;

  with groups as (
    select a.id::text as gkey,
           a.name as gname,
           (a.closed_at is not null) as closed,
           false as deleted,
           a.name as sort_name
    from agents a
    union all
    select d.gkey,
           coalesce(d.agent_name, '—') || ' (ဖျက်ပြီး)' as gname,
           true as closed,
           true as deleted,
           coalesce(d.agent_name, '—') as sort_name
    from (
      select distinct
             'deleted:' || coalesce(r.agent_name, 'null') as gkey,
             r.agent_name
      from (
        select agent_name from daily_entries
          where agent_id is null and entry_date <= p_to
        union all
        select agent_name from write_offs
          where agent_id is null and writeoff_date <= p_to
        union all
        select agent_name from agent_payments
          where agent_id is null and payment_date <= p_to
        union all
        select agent_name from agent_deposits
          where agent_id is null and deposit_date <= p_to
        union all
        select agent_name from agent_settlements
          where agent_id is null and settle_date <= p_to
      ) r
    ) d
  ),
  e_agg as (
    select coalesce(e.agent_id::text, 'deleted:' || coalesce(e.agent_name, 'null')) as gkey,
           sum(e.amount) as all_sales,
           sum(e.amount_collected) as all_coll,
           sum(e.delivered_qty - e.returned_qty) as bottles,
           coalesce(sum(e.amount) filter (where e.entry_date between p_from and p_to), 0) as r_sales,
           coalesce(sum(e.amount_collected) filter (where e.entry_date between p_from and p_to), 0) as r_coll
    from daily_entries e
    where e.entry_date <= p_to
    group by 1
  ),
  w_agg as (
    select coalesce(w.agent_id::text, 'deleted:' || coalesce(w.agent_name, 'null')) as gkey,
           sum(w.amount) as all_wo,
           coalesce(sum(w.amount) filter (where w.writeoff_date between p_from and p_to), 0) as r_wo
    from write_offs w
    where w.writeoff_date <= p_to
    group by 1
  ),
  p_agg as (
    select coalesce(p.agent_id::text, 'deleted:' || coalesce(p.agent_name, 'null')) as gkey,
           sum(p.amount) as all_paid,
           coalesce(sum(p.amount) filter (where p.payment_date between p_from and p_to), 0) as r_paid
    from agent_payments p
    where p.payment_date <= p_to
    group by 1
  ),
  d_agg as (
    select coalesce(d.agent_id::text, 'deleted:' || coalesce(d.agent_name, 'null')) as gkey,
           sum(d.amount) as dep_total
    from agent_deposits d
    where d.deposit_date <= p_to
    group by 1
  ),
  s_one as (
    select distinct on (s.gkey) s.gkey, s.settle_date, s.forfeiture_income, s.net_refund
    from (
      select coalesce(st.agent_id::text, 'deleted:' || coalesce(st.agent_name, 'null')) as gkey,
             st.settle_date, st.forfeiture_income, st.net_refund, st.created_at
      from agent_settlements st
      where st.settle_date <= p_to
    ) s
    order by s.gkey, s.settle_date asc, s.created_at asc
  ),
  per_agent as (
    select g.gkey,
           g.gname,
           g.closed,
           g.deleted,
           coalesce(e.r_sales, 0) as sales,
           coalesce(e.r_coll, 0) + coalesce(p.r_paid, 0) as collected,
           coalesce(w.r_wo, 0) as write_off,
           greatest(0,
             coalesce(e.all_sales, 0) - coalesce(e.all_coll, 0)
             - coalesce(p.all_paid, 0) - coalesce(w.all_wo, 0)) as receivable,
           (coalesce(e.all_sales, 0) - coalesce(e.all_coll, 0)
             - coalesce(p.all_paid, 0) - coalesce(w.all_wo, 0)) as receivable_raw,
           case when s.gkey is not null then 0 else coalesce(e.bottles, 0) end as bottles,
           case when s.gkey is not null then 0 else coalesce(d.dep_total, 0) end as deposit,
           case when s.gkey is not null and s.settle_date between p_from and p_to
                then s.forfeiture_income else 0 end as forfeiture_r,
           case when s.gkey is not null and s.settle_date between p_from and p_to
                then s.net_refund else 0 end as refund_r
    from groups g
    left join e_agg e on e.gkey = g.gkey
    left join w_agg w on w.gkey = g.gkey
    left join p_agg p on p.gkey = g.gkey
    left join d_agg d on d.gkey = g.gkey
    left join s_one s on s.gkey = g.gkey
  ),
  totals as (
    select coalesce(sum(sales), 0) as sales,
           coalesce(sum(collected), 0) as collected,
           coalesce(sum(write_off), 0) as write_offs,
           coalesce(sum(receivable), 0) as receivable,
           coalesce(sum(receivable_raw), 0) as receivable_raw,
           coalesce(sum(deposit), 0) as deposit_liability,
           coalesce(sum(forfeiture_r), 0) as forfeiture_income,
           coalesce(sum(refund_r), 0) as refunds
    from per_agent
  ),
  cat as (
    select coalesce(c.name, 'အမျိုးအစား မသတ်မှတ်') as name,
           sum(x.amount) as total,
           min(x.expense_date) as first_date,
           min(x.created_at) as first_created
    from expenses x
    left join expense_categories c on c.id = x.category_id
    where x.expense_date between p_from and p_to
    group by 1
  ),
  cat_json as (
    select coalesce(
             jsonb_agg(jsonb_build_object('name', name, 'total', total)
                       order by total desc, first_date asc, first_created asc),
             '[]'::jsonb) as by_category,
           coalesce(sum(total), 0) as expense_total
    from cat
  ),
  payroll as (
    select coalesce(sum(base + bonus), 0) as total
    from payroll_runs
    where month between to_char(p_from, 'YYYY-MM') and to_char(p_to, 'YYYY-MM')
  ),
  aging_rows as (
    select r.agent_key, r.entry_date, r.days, r.amount, r.bucket,
           g.gname
    from _report_aging_rows(p_to) r
    join groups g on g.gkey = r.agent_key
  ),
  aging_json as (
    select coalesce(sum(amount) filter (where bucket = 'd30'), 0) as d30,
           coalesce(sum(amount) filter (where bucket = 'd60'), 0) as d60,
           coalesce(sum(amount) filter (where bucket = 'd60p'), 0) as d60p,
           coalesce(
             jsonb_agg(jsonb_build_object(
                         'bucket', bucket,
                         'agent', gname,
                         'date', to_char(entry_date, 'YYYY-MM-DD'),
                         'days', greatest(0, days),
                         'amount', amount)
                       order by days desc, amount desc, gname asc, entry_date desc),
             '[]'::jsonb) as rows
    from aging_rows
  ),
  per_agent_json as (
    select coalesce(
             jsonb_agg(jsonb_build_object(
                         'id', gkey,
                         'name', gname,
                         'closed', closed,
                         'deleted', deleted,
                         'sales', sales,
                         'collected', collected,
                         'writeOff', write_off,
                         'receivable', receivable,
                         'bottles', bottles,
                         'deposit', deposit)
                       order by receivable desc, gname asc),
             '[]'::jsonb) as per_agent
    from per_agent
  ),
  emp as (
    select e.created_by as uid, 0 as src, e.entry_date as d, e.created_at as ca,
           e.delivered_qty::bigint as bottles, e.amount_collected as cash, 0::bigint as debt
    from daily_entries e
    where e.created_by is not null and e.entry_date between p_from and p_to
    union all
    select p.created_by, 1, p.payment_date, p.created_at,
           0, 0, p.amount
    from agent_payments p
    where p.created_by is not null and p.payment_date between p_from and p_to
  ),
  emp_first as (
    select distinct on (uid) uid, src, d, ca
    from emp
    order by uid, src, d, ca
  ),
  emp_agg as (
    select e.uid,
           sum(e.bottles) as bottles,
           sum(e.cash) as cash,
           sum(e.debt) as debt_collected,
           sum(e.cash + e.debt) as total,
           f.src as f_src, f.d as f_d, f.ca as f_ca
    from emp e
    join emp_first f on f.uid = e.uid
    group by e.uid, f.src, f.d, f.ca
  ),
  emp_json as (
    select coalesce(
             jsonb_agg(jsonb_build_object(
                         'id', uid,
                         'bottles', bottles,
                         'cash', cash,
                         'debtCollected', debt_collected,
                         'total', total)
                       order by f_src asc, f_d asc, f_ca asc),
             '[]'::jsonb) as employee_perf
    from emp_agg
  ),
  wo_json as (
    select coalesce(
             jsonb_agg(jsonb_build_object(
                         'id', w.id,
                         'agent_id', w.agent_id,
                         'agent_name', w.agent_name,
                         'writeoff_date', to_char(w.writeoff_date, 'YYYY-MM-DD'),
                         'amount', w.amount,
                         'note', w.note,
                         'created_by', w.created_by,
                         'created_at', w.created_at)
                       order by w.writeoff_date desc, w.created_at desc),
             '[]'::jsonb) as range_write_offs
    from write_offs w
    where w.writeoff_date between p_from and p_to
  )
  select jsonb_build_object(
    'sales', t.sales,
    'collected', t.collected,
    'writeOffs', t.write_offs,
    'expenseTotal', cj.expense_total,
    'byCategory', cj.by_category,
    'payroll', pr.total,
    'profit', t.sales + t.forfeiture_income - cj.expense_total - pr.total - t.write_offs,
    'forfeitureIncome', t.forfeiture_income,
    'refunds', t.refunds,
    'depositLiability', t.deposit_liability,
    'receivable', t.receivable,
    'receivableRaw', t.receivable_raw,
    'aging', jsonb_build_object('d30', aj.d30, 'd60', aj.d60, 'd60p', aj.d60p),
    'agingRows', aj.rows,
    'perAgent', pj.per_agent,
    'employeePerf', ej.employee_perf,
    'rangeWriteOffs', wj.range_write_offs,
    'hasData', (
      exists (select 1 from daily_entries where entry_date <= p_to)
      or exists (select 1 from expenses where expense_date between p_from and p_to)
      or exists (select 1 from agent_payments where payment_date <= p_to)
      or exists (select 1 from write_offs where writeoff_date <= p_to)
      or exists (select 1 from payroll_runs
                 where month between to_char(p_from, 'YYYY-MM') and to_char(p_to, 'YYYY-MM'))
      or exists (select 1 from agent_deposits where deposit_date <= p_to)
      or exists (select 1 from agent_settlements where settle_date <= p_to)
    ),
    'earliestYear', (
      select extract(year from min(entry_date))::int
      from daily_entries
      where entry_date <= p_to
    )
  ) into v_result
  from totals t, cat_json cj, payroll pr, aging_json aj, per_agent_json pj,
       emp_json ej, wo_json wj;

  return v_result;
end $$;

revoke execute on function report_range(date, date) from public, anon;
grant execute on function report_range(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- report_months(p_from_month, p_months, p_cap, p_exp_cap): monthly trend.
-- One series of consecutive months starting at p_from_month ('YYYY-MM').
-- Entries / write-offs / settlements are capped at p_cap (in the page,
-- the applied range's `to`); expenses are capped at p_exp_cap (rolling
-- mode passes the same `to`; per-year mode passes the year's Dec 31 —
-- mirroring the page's separate per-year expense fetch). Payroll is
-- matched by month text, as in the client code.
-- ---------------------------------------------------------------------------
create or replace function report_months(
  p_from_month text,
  p_months integer,
  p_cap date,
  p_exp_cap date
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if not is_owner_manager() then
    raise exception 'owner_manager_only';
  end if;
  if p_months is null or p_months < 1 or p_months > 60 then
    raise exception 'invalid_months';
  end if;

  with months as (
    select to_char((p_from_month || '-01')::date + make_interval(months => i), 'YYYY-MM') as m,
           i
    from generate_series(0, p_months - 1) as i
  ),
  sales_m as (
    select to_char(e.entry_date, 'YYYY-MM') as m, sum(e.amount) as total
    from daily_entries e
    where e.entry_date <= p_cap
      and to_char(e.entry_date, 'YYYY-MM') in (select m from months)
    group by 1
  ),
  exp_m as (
    select to_char(x.expense_date, 'YYYY-MM') as m, sum(x.amount) as total
    from expenses x
    where x.expense_date <= p_exp_cap
      and to_char(x.expense_date, 'YYYY-MM') in (select m from months)
    group by 1
  ),
  pay_m as (
    select r.month as m, sum(r.base + r.bonus) as total
    from payroll_runs r
    where r.month in (select m from months)
    group by 1
  ),
  wo_m as (
    select to_char(w.writeoff_date, 'YYYY-MM') as m, sum(w.amount) as total
    from write_offs w
    where w.writeoff_date <= p_cap
      and to_char(w.writeoff_date, 'YYYY-MM') in (select m from months)
    group by 1
  ),
  forf_m as (
    select to_char(s.settle_date, 'YYYY-MM') as m, sum(s.forfeiture_income) as total
    from agent_settlements s
    where s.settle_date <= p_cap
      and to_char(s.settle_date, 'YYYY-MM') in (select m from months)
    group by 1
  )
  select coalesce(
           jsonb_agg(jsonb_build_object(
                       'month', mo.m,
                       'sales', coalesce(sm.total, 0),
                       'costs', coalesce(em.total, 0) + coalesce(pm.total, 0)
                                + coalesce(wm.total, 0),
                       'profit', coalesce(sm.total, 0) + coalesce(fm.total, 0)
                                 - (coalesce(em.total, 0) + coalesce(pm.total, 0)
                                    + coalesce(wm.total, 0)))
                     order by mo.i),
           '[]'::jsonb)
  into v_result
  from months mo
  left join sales_m sm on sm.m = mo.m
  left join exp_m em on em.m = mo.m
  left join pay_m pm on pm.m = mo.m
  left join wo_m wm on wm.m = mo.m
  left join forf_m fm on fm.m = mo.m;

  return v_result;
end $$;

revoke execute on function report_months(text, integer, date, date) from public, anon;
grant execute on function report_months(text, integer, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- report_aging(p_as_of): aging bucket totals only (Daily Brief).
-- ---------------------------------------------------------------------------
create or replace function report_aging(p_as_of date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if not is_owner_manager() then
    raise exception 'owner_manager_only';
  end if;

  select jsonb_build_object(
    'd30', coalesce(sum(amount) filter (where bucket = 'd30'), 0),
    'd60', coalesce(sum(amount) filter (where bucket = 'd60'), 0),
    'd60p', coalesce(sum(amount) filter (where bucket = 'd60p'), 0)
  ) into v_result
  from _report_aging_rows(p_as_of);

  return v_result;
end $$;

revoke execute on function report_aging(date) from public, anon;
grant execute on function report_aging(date) to authenticated;
