-- 0039: remove the agent bottle_limit and trip_qty settings entirely.
--
-- Owner decision 2026-11-16: the only cap on how many bottles an
-- agent can hold out is the deposit itself -- the agent states how
-- many bottles he deposits for, the per-bottle deposit rate is set
-- at the current bottle price, and that deposit bottle count caps
-- him. A second, separate bottle limit (and a per-trip quantity)
-- only confused the workflow. PR #14 removed both settings from
-- every screen; this migration removes them from the database too.
--
--   1. entries_before_write() (0006, replaced 0007): the explicit
--      bottle_limit check is removed. The deposit check below it is
--      unchanged and remains the only bottle cap.
--   2. data_quality_scan() (0022, replaced 0025): the "held bottles
--      exceed the bottle limit" issue check is removed.
--   3. guard_agent_money_settings() (0033): bottle_limit is no
--      longer one of the month-lock-frozen money fields.
--   4. agents.bottle_limit and agents.trip_qty are dropped.
--
-- Historical migrations are not edited; this file supersedes their
-- column references in order. Live apply is a separate owner
-- decision, after 0030-0038.

-- 1) entries_before_write: deposit cap only.
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

-- 2) data_quality_scan: no bottle-limit issue check.
create or replace function data_quality_scan() returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Yangon')::date;
  v_bk_json jsonb;
  v_bk text;
  v_result jsonb;
begin
  if not is_owner_manager() then
    raise exception 'data_quality_scan: owner/manager only'
      using errcode = '42501';
  end if;

  -- Backup stamp, mirroring getLastBackupAt() (src/lib/backup.ts): the
  -- app_settings value must be a JSON string; tolerate the legacy
  -- double-encoded shape (a string containing a quoted ISO string).
  select value into v_bk_json from app_settings where key = 'last_backup_at';
  if v_bk_json is not null and jsonb_typeof(v_bk_json) = 'string' then
    v_bk := v_bk_json #>> '{}';
    if v_bk is not null and left(v_bk, 1) = '"' then
      v_bk := v_bk::jsonb #>> '{}';
    end if;
  end if;

  with
  prof as (
    select p.id, coalesce(nullif(btrim(p.display_name), ''), p.username) as pname
    from profiles p
  ),
  entries_f as (
    select e.*, row_number() over (order by e.created_at, e.id) as frn
    from daily_entries e
  ),
  payments_f as (
    select p.*, row_number() over (order by p.created_at, p.id) as frn
    from agent_payments p
  ),
  writeoffs_f as (
    select w.*, row_number() over (order by w.created_at, w.id) as frn
    from write_offs w
  ),
  deposits_f as (
    select d.*, row_number() over (order by d.created_at, d.id) as frn
    from agent_deposits d
  ),
  payroll_f as (
    select p.*, row_number() over (order by p.created_at, p.id) as frn
    from payroll_runs p
  ),
  expenses_f as (
    select x.*, row_number() over (order by x.created_at, x.id) as frn
    from expenses x
  ),
  disputes_f as (
    select d.*, row_number() over (order by d.created_at, d.id) as frn
    from disputes d
  ),
  -- Per-entry iteration order: entry_date asc, stable over fetch order.
  ent_sorted as (
    select e.*, row_number() over (order by e.entry_date, e.created_at, e.id) as srn
    from daily_entries e
  ),
  -- Running bottle balance (see header note for the clamp identity).
  held1 as (
    select s.id, s.agent_id, s.agent_name, s.entry_date, s.created_at, s.srn,
           s.delivered_qty, s.returned_qty,
           sum(s.delivered_qty - s.returned_qty) over (
             partition by s.agent_id
             order by s.entry_date, s.created_at, s.id
             rows between unbounded preceding and current row
           ) as ssum
    from ent_sorted s
    where s.agent_id is not null
  ),
  held2 as (
    select h.*,
           h.ssum - least(0::bigint, min(h.ssum) over (
             partition by h.agent_id
             order by h.entry_date, h.created_at, h.id
             rows between unbounded preceding and current row
           )) as cval
    from held1 h
  ),
  held3 as (
    select h.*,
           lag(h.cval, 1, 0) over (
             partition by h.agent_id
             order by h.entry_date, h.created_at, h.id
           ) + h.delivered_qty - h.returned_qty as hval
    from held2 h
  ),
  final_held as (
    select distinct on (h.agent_id) h.agent_id, h.cval
    from held3 h
    order by h.agent_id, h.entry_date desc, h.created_at desc, h.id desc
  ),
  -- First fetch-order appearance per agent (the page's Map order).
  agent_first as (
    select e.agent_id, min(e.frn) as ffrn
    from entries_f e
    where e.agent_id is not null
    group by e.agent_id
  ),
  -- Debt FIFO: d = what a trip still owes before payments/write-offs.
  entd as (
    select e.*,
           e.delivered_qty::bigint * e.unit_price - e.amount_collected as d
    from daily_entries e
    where e.agent_id is not null
  ),
  pool as (
    select u.agent_id, sum(u.amount) as pool0
    from (
      select agent_id, amount from agent_payments where agent_id is not null
      union all
      select agent_id, amount from write_offs where agent_id is not null
    ) u
    group by u.agent_id
  ),
  fifo1 as (
    select t.*,
           coalesce(p.pool0, 0) + sum(case when t.d < 0 then -t.d else 0 end)
             over (partition by t.agent_id) as pool1
    from entd t
    left join pool p on p.agent_id = t.agent_id
  ),
  fifo2 as (
    select f.*,
           sum(case when f.d > 0 then f.d else 0 end) over (
             partition by f.agent_id
             order by f.entry_date, f.created_at, f.id
             rows between unbounded preceding and 1 preceding
           ) as cum_before
    from fifo1 f
  ),
  fifo3 as (
    select f.*,
           case when f.d > 0
                then greatest(0::bigint, f.d - greatest(0::bigint, f.pool1 - coalesce(f.cum_before, 0)))
                else 0::bigint end as left_amt
    from fifo2 f
  ),
  aging as (
    select a.agent_id, sum(a.left_amt) as owed
    from fifo3 a
    where a.left_amt > 0
    group by a.agent_id
  ),
  oldest as (
    select distinct on (o.agent_id) o.agent_id, o.entry_date, o.agent_name
    from fifo3 o
    where o.left_amt > 0
    order by o.agent_id, o.entry_date, o.created_at, o.id
  ),
  -- Negative total balance per agent (over-collected).
  bal as (
    select u.aid, sum(u.delta) as bal
    from (
      select agent_id as aid, (amount - amount_collected) as delta
      from daily_entries where agent_id is not null
      union all
      select agent_id, -amount from agent_payments where agent_id is not null
      union all
      select agent_id, -amount from write_offs where agent_id is not null
    ) u
    group by u.aid
  ),
  bal_ord as (
    select z.aid, min(z.ordv) as o
    from (
      select agent_id as aid, frn as ordv from entries_f where agent_id is not null
      union all
      select agent_id, 1000000 + frn from payments_f where agent_id is not null
      union all
      select agent_id, 2000000 + frn from writeoffs_f where agent_id is not null
    ) z
    group by z.aid
  ),
  dep_bottles as (
    select d.agent_id, sum(d.bottles)::bigint as db
    from agent_deposits d
    group by d.agent_id
  )
  select jsonb_build_object(
    'issues', coalesce((
      select jsonb_agg(s.iss order by s.rk, s.dt desc, s.sec, s.ord)
      from (
        select b.sec, b.ord, b.dt,
               case b.severity when 'high' then 0 when 'medium' then 1 else 2 end as rk,
               jsonb_build_object(
                 'kind', b.kind, 'severity', b.severity, 'table', b.tbl,
                 'recordId', b.rid, 'date', b.dt, 'name', b.nm,
                 'problem', b.problem, 'suggestion', b.suggestion,
                 -- When the flagged record was entered, and by whom
                 -- (owner request: settle questions with staff by day,
                 -- time and responsible person). Looked up by
                 -- (table, recordId) so the per-check branches stay
                 -- untouched; aggregate/system issues and the
                 -- per-collector anomaly rows (recordId = the collector)
                 -- find no row and keep null — date only, as before.
                 'ts', case b.tbl
                   when 'daily_entries' then (select e.created_at from daily_entries e where e.id = b.rid::uuid)
                   when 'agent_payments' then (select p.created_at from agent_payments p where p.id = b.rid::uuid)
                   when 'agent_deposits' then (select d.created_at from agent_deposits d where d.id = b.rid::uuid)
                   when 'expenses' then (select x.created_at from expenses x where x.id = b.rid::uuid)
                   when 'payroll_runs' then (select r.created_at from payroll_runs r where r.id = b.rid::uuid)
                   when 'disputes' then (select q.created_at from disputes q where q.id = b.rid::uuid)
                 end,
                 'by', case b.tbl
                   when 'daily_entries' then (select pr.pname from daily_entries e join prof pr on pr.id = e.created_by where e.id = b.rid::uuid)
                   when 'agent_payments' then (select pr.pname from agent_payments p join prof pr on pr.id = p.created_by where p.id = b.rid::uuid)
                   when 'agent_deposits' then (select pr.pname from agent_deposits d join prof pr on pr.id = d.created_by where d.id = b.rid::uuid)
                   when 'expenses' then (select pr.pname from expenses x join prof pr on pr.id = x.created_by where x.id = b.rid::uuid)
                   when 'payroll_runs' then (select pr.pname from payroll_runs r join prof pr on pr.id = r.created_by where r.id = b.rid::uuid)
                 end
               ) as iss
        from (
          -- sec 0: duplicates — same agent + day, identical numbers;
          -- one issue per row after the first (fetch order).
          select 0 as sec, r.frn as ord, 'duplicate' as kind, 'high' as severity,
                 'daily_entries' as tbl, r.id::text as rid,
                 r.entry_date::text as dt,
                 coalesce(r.agent_name, a.name, '—') as nm,
                 'တစ်ရက်တည်းတွင် မှတ်တမ်း ' || d.cnt || ' ခု (ဂဏန်းတူ)' as problem,
                 'ထပ်နေသော မှတ်တမ်းကို ဖျက်ပါ' as suggestion
          from (
            select e.*,
                   row_number() over (
                     partition by e.agent_id, e.entry_date
                     order by e.created_at, e.id
                   ) as grn
            from entries_f e
            where e.agent_id is not null
          ) r
          join (
            select agent_id, entry_date, count(*) as cnt
            from daily_entries
            where agent_id is not null
            group by agent_id, entry_date
            having count(*) >= 2
               and min(delivered_qty) = max(delivered_qty)
               and min(returned_qty) = max(returned_qty)
               and min(amount_collected) = max(amount_collected)
          ) d on d.agent_id = r.agent_id and d.entry_date = r.entry_date
          left join agents a on a.id = r.agent_id
          where r.grn > 1

          union all
          -- sec 1: per-entry checks (sub-order follows the page's
          -- check order inside its per-entry loop).
          select 1, e.srn * 16 + 1, 'impossible', 'high', 'daily_entries', e.id::text,
                 e.entry_date::text,
                 coalesce(e.agent_name, a.name, '—'),
                 'အနုတ်ဂဏန်း ပါနေသည်',
                 'ဂဏန်းကို 0 သို့မဟုတ် အမှန်ဖြင့် ပြင်ပါ'
          from ent_sorted e
          left join agents a on a.id = e.agent_id
          where e.delivered_qty < 0 or e.returned_qty < 0 or e.amount_collected < 0

          union all
          select 1, e.srn * 16 + 2, 'impossible', 'medium', 'daily_entries', e.id::text,
                 e.entry_date::text,
                 coalesce(e.agent_name, a.name, '—'),
                 'တစ်ရက် ' || to_char(e.delivered_qty::bigint, 'FM999,999,999,999,999') || ' ဘူး ပို့ — အလွန်များသည်',
                 'ဂဏန်း ထပ်ရိုက်မိခြင်း ရှိမရှိ စစ်ပါ'
          from ent_sorted e
          left join agents a on a.id = e.agent_id
          where e.delivered_qty > 2000

          union all
          select 1, e.srn * 16 + 3, 'impossible', 'medium', 'daily_entries', e.id::text,
                 e.entry_date::text,
                 coalesce(e.agent_name, a.name, '—'),
                 'အနာဂတ်ရက်စွဲ',
                 'ရက်စွဲကို မှန်အောင် ပြင်ပါ'
          from ent_sorted e
          left join agents a on a.id = e.agent_id
          where e.entry_date > v_today

          union all
          select 1, e.srn * 16 + 4, 'impossible', 'low', 'daily_entries', e.id::text,
                 e.entry_date::text,
                 coalesce(e.agent_name, a.name, '—'),
                 'ဂဏန်းအားလုံး 0 — အလွတ်မှတ်တမ်း',
                 'မလိုအပ်ပါက ဖျက်ပါ'
          from ent_sorted e
          left join agents a on a.id = e.agent_id
          where e.delivered_qty = 0 and e.returned_qty = 0 and e.amount_collected = 0
            and (e.notes is null or btrim(e.notes) = '')

          union all
          select 1, e.srn * 16 + 5, 'mismatch', 'high', 'daily_entries', e.id::text,
                 e.entry_date::text,
                 coalesce(e.agent_name, a.name, '—'),
                 'ရောင်းငွေ မကိုက် — ' || to_char(e.delivered_qty::bigint, 'FM999,999,999,999,999')
                   || ' × ' || to_char(e.unit_price::bigint, 'FM999,999,999,999,999')
                   || ' = ' || to_char(e.delivered_qty::bigint * e.unit_price, 'FM999,999,999,999,999')
                   || ' ဖြစ်ရမည် (မှတ်ထား ' || to_char(e.amount, 'FM999,999,999,999,999') || ')',
                 'မှတ်တမ်းကို စစ်ပြီး ပြင်ပါ'
          from ent_sorted e
          left join agents a on a.id = e.agent_id
          where e.amount <> e.delivered_qty::bigint * e.unit_price

          union all
          select 1, e.srn * 16 + 6, 'snapshot', 'medium', 'daily_entries', e.id::text,
                 e.entry_date::text,
                 coalesce(e.agent_name, a.name, '—'),
                 'ကိုယ်စားလှယ် အမည် မှတ်တမ်း (snapshot) ပျောက်နေသည်',
                 'မှတ်တမ်းကို တစ်ခါ ပြန်သိမ်းပါ (အမည် အလိုအလျောက် ပြန်ဝင်မည်)'
          from ent_sorted e
          left join agents a on a.id = e.agent_id
          where e.agent_id is not null
            and (e.agent_name is null or btrim(e.agent_name) = '')

          union all
          select 1, h.srn * 16 + 7, 'impossible', 'high', 'daily_entries', h.id::text,
                 h.entry_date::text,
                 coalesce(h.agent_name, a.name, '—'),
                 'ပို့ထားသည်ထက် ဗူးခွံ ပိုပြန်ယူ (လက်ကျန် ' || to_char(h.hval, 'FM999,999,999,999,999') || ')',
                 'ပြန်ယူဗူးခွံ အရေအတွက် သို့မဟုတ် ယခင်ပို့ဘူးကို စစ်ပြီး ပြင်ပါ'
          from held3 h
          left join agents a on a.id = h.agent_id
          where h.hval < 0

          union all
          select 1, e.srn * 16 + 9, 'mismatch', 'medium', 'daily_entries', e.id::text,
                 e.entry_date::text,
                 coalesce(e.agent_name, a.name, '—'),
                 'ယူနစ်ဈေး ' || to_char(e.unit_price::bigint, 'FM999,999,999,999,999')
                   || ' ≠ ကိုယ်စားလှယ်ဈေး ' || to_char(a.default_unit_price::bigint, 'FM999,999,999,999,999'),
                 'မှတ်တမ်းကို တစ်ခါ ပြန်သိမ်းပါ (ဈေး အလိုအလျောက် ညှိမည်)'
          from ent_sorted e
          join agents a on a.id = e.agent_id
          where e.unit_price <> a.default_unit_price

          union all
          -- sec 2: deposit amount mismatch.
          select 2, d.frn, 'mismatch', 'high', 'agent_deposits', d.id::text,
                 d.deposit_date::text,
                 coalesce(d.agent_name, a.name, '—'),
                 'အပေါင် ' || to_char(d.bottles::bigint, 'FM999,999,999,999,999')
                   || ' × ' || to_char(d.price_per_bottle::bigint, 'FM999,999,999,999,999')
                   || ' = ' || to_char(d.bottles::bigint * d.price_per_bottle, 'FM999,999,999,999,999')
                   || ' ဖြစ်ရမည် (မှတ်ထား ' || to_char(d.amount, 'FM999,999,999,999,999') || ')',
                 'ပမာဏကို ' || to_char(d.bottles::bigint * d.price_per_bottle, 'FM999,999,999,999,999') || ' ကျပ် သို့ ပြင်ပါ'
          from deposits_f d
          left join agents a on a.id = d.agent_id
          where d.amount <> d.bottles::bigint * d.price_per_bottle

          union all
          -- sec 3: payroll checks.
          select 3, p.frn * 4 + 1, 'mismatch', 'high', 'payroll_runs', p.id::text,
                 p.month,
                 coalesce(pr.pname, ''),
                 'လစာ ' || to_char(p.base, 'FM999,999,999,999,999')
                   || ' + ' || to_char(p.bonus, 'FM999,999,999,999,999')
                   || ' − ' || to_char(p.deduction, 'FM999,999,999,999,999')
                   || ' = ' || to_char(p.base + p.bonus - p.deduction, 'FM999,999,999,999,999')
                   || ' (မှတ်ထား ' || to_char(p.net, 'FM999,999,999,999,999') || ')',
                 'လစာကို ပြန်တွက်ပါ'
          from payroll_f p
          left join prof pr on pr.id = p.user_id
          where p.base + p.bonus - p.deduction <> p.net

          union all
          select 3, p.frn * 4 + 2, 'impossible', 'medium', 'payroll_runs', p.id::text,
                 p.month,
                 coalesce(pr.pname, ''),
                 'အသားတင်လစာ အနုတ်',
                 'advance အရစ်ကျ ပမာဏကို လျှော့ပါ'
          from payroll_f p
          left join prof pr on pr.id = p.user_id
          where p.net < 0

          union all
          -- sec 4: expense checks.
          select 4, x.frn * 4 + 1, 'impossible', 'medium', 'expenses', x.id::text,
                 x.expense_date::text,
                 x.title,
                 'ကုန်ကျငွေ 0 သို့မဟုတ် အနုတ်',
                 'ပမာဏကို ပြင်ပါ သို့မဟုတ် ဖျက်ပါ'
          from expenses_f x
          where x.amount <= 0

          union all
          select 4, x.frn * 4 + 2, 'impossible', 'medium', 'expenses', x.id::text,
                 x.expense_date::text,
                 x.title,
                 'အနာဂတ်ရက်စွဲ',
                 'ရက်စွဲကို ပြင်ပါ'
          from expenses_f x
          where x.expense_date > v_today

          union all
          -- sec 5: negative total balance per agent.
          select 5, o.o, 'debt', 'high', 'agents', b.aid::text,
                 v_today::text,
                 coalesce(a.name, '—'),
                 'ကိုယ်စားလှယ် လက်ကျန် အနုတ် ' || to_char(b.bal, 'FM999,999,999,999,999') || ' ကျပ် — ငွေ ပိုကောက်ခံထားသည်',
                 'ကောက်ခံမှု မှတ်တမ်းများကို စစ်ပါ'
          from bal b
          join bal_ord o on o.aid = b.aid
          left join agents a on a.id = b.aid
          where b.bal < 0

          union all
          -- sec 6: debt aging (oldest unpaid trip older than 30 days).
          select 6, f.ffrn * 2, 'debt',
                 case when (v_today - o.entry_date) > 60 then 'high' else 'medium' end,
                 'agents', g.agent_id::text,
                 o.entry_date::text,
                 coalesce(o.agent_name, a.name, '—'),
                 'ကြွေး ' || to_char(g.owed, 'FM999,999,999,999,999')
                   || ' ကျပ် — အဟောင်းဆုံး ' || (v_today - o.entry_date) || ' ရက် ကြာပြီ',
                 case when (v_today - o.entry_date) > 60
                      then 'ယနေ့ပဲ ဖုန်းဆက်ကောက်ပါ၊ ငွေမရမချင်း ထပ်မပို့ပါနှင့်'
                      else 'ကိုယ်စားလှယ်ကို သတိပေးပြီး ကောက်ခံရန် စီစဉ်ပါ' end
          from aging g
          join oldest o on o.agent_id = g.agent_id
          join agent_first f on f.agent_id = g.agent_id
          left join agents a on a.id = g.agent_id
          where (v_today - o.entry_date) > 30

          union all
          -- sec 6b: bottles held beyond deposit coverage.
          select 6, f.ffrn * 2 + 1, 'mismatch', 'medium', 'agents', fh.agent_id::text,
                 v_today::text,
                 a.name,
                 'လက်ကျန် ' || to_char(fh.cval, 'FM999,999,999,999,999')
                   || ' ဘူး > အပေါင်ယူထား ' || to_char(db.db, 'FM999,999,999,999,999') || ' ဘူး',
                 'ကျန် ' || to_char(fh.cval - db.db, 'FM999,999,999,999,999') || ' ဘူးအတွက် အပေါင် ထပ်ယူပါ သို့မဟုတ် ဘူးခွံ ပြန်သိမ်းပါ'
          from final_held fh
          join dep_bottles db on db.agent_id = fh.agent_id
          join agents a on a.id = fh.agent_id
          join agent_first f on f.agent_id = fh.agent_id
          where db.db > 0 and fh.cval > db.db

          union all
          -- sec 7: suspicious habits (>=20 bottles with 0 collected;
          -- records entered late at night, Yangon time).
          select 7, e.frn * 4 + 1, 'suspicious', 'low', 'daily_entries', e.id::text,
                 e.entry_date::text,
                 coalesce(e.agent_name, a.name, '—'),
                 to_char(e.delivered_qty::bigint, 'FM999,999,999,999,999') || ' ဘူး ပို့ပြီး ငွေ 0 လက်ခံ',
                 'အကြွေးသက်သက်ဟုတ်မဟုတ် ပို့သူဝန်ထမ်းကို မေးပါ'
          from entries_f e
          left join agents a on a.id = e.agent_id
          where e.delivered_qty >= 20 and e.amount_collected = 0

          union all
          select 7, e.frn * 4 + 2, 'suspicious', 'low', 'daily_entries', e.id::text,
                 e.entry_date::text,
                 coalesce(e.agent_name, a.name, '—'),
                 'ညနက် ' || lpad((extract(hour from (e.created_at at time zone 'Asia/Yangon'))::int)::text, 2, '0')
                   || ' နာရီတွင် ထည့်သွင်း'
                   || case when coalesce(pr.pname, '') <> '' then ' (' || pr.pname || ')' else '' end,
                 'အချိန်လွန်ထည့်ရသည့် အကြောင်းကို စစ်ပါ'
          from entries_f e
          left join agents a on a.id = e.agent_id
          left join prof pr on pr.id = e.created_by
          where extract(hour from (e.created_at at time zone 'Asia/Yangon'))::int >= 22
             or extract(hour from (e.created_at at time zone 'Asia/Yangon'))::int < 5

          union all
          -- sec 8: collection anomalies — per collector (payments
          -- created_by), per day, totals >= 100,000 only. Rule (a):
          -- day >= 3x the trailing-7-day daily average (only days
          -- present in the data form the baseline; missing days count
          -- as 0 in the average). Rule (b): day >= 1.5x previous day.
          select 8, an.cord * 1000000 + an.first_frn * 4 + 0, 'collection_anomaly', 'high',
                 'agent_payments', an.created_by::text,
                 an.day::text,
                 an.pname,
                 an.pname || ' သည် ပုံမှန်ထက် ၃ ဆပိုများသော ငွေကို ကောက်ခံခဲ့သည်',
                 'ကောက်ငွေ ' || to_char(an.total, 'FM999,999,999,999,999')
                   || ' ကျပ် · ပုံမှန်ငွေ ' || to_char(round(an.wsum / 7.0)::bigint, 'FM999,999,999,999,999')
                   || ' ကျပ် — ကောက်ခံမှု မှတ်တမ်းများကို စစ်ပါ'
          from (
            select d.created_by, d.day, d.total, d.first_frn, c.cord, pf.pname,
                   (select sum(x.total) from (
                      select created_by, payment_date as day, sum(amount) as total
                      from agent_payments where created_by is not null
                      group by created_by, payment_date
                    ) x where x.created_by = d.created_by and x.day >= d.day - 7 and x.day < d.day) as wsum,
                   (select count(*) from (
                      select created_by, payment_date as day, sum(amount) as total
                      from agent_payments where created_by is not null
                      group by created_by, payment_date
                    ) x where x.created_by = d.created_by and x.day >= d.day - 7 and x.day < d.day) as wcnt
            from (
              select created_by, payment_date as day, sum(amount) as total, min(frn) as first_frn
              from payments_f where created_by is not null
              group by created_by, payment_date
            ) d
            join (
              select created_by, min(first_frn) as cord
              from (
                select created_by, payment_date as day, min(frn) as first_frn
                from payments_f where created_by is not null
                group by created_by, payment_date
              ) dd
              group by created_by
            ) c on c.created_by = d.created_by
            join prof pf on pf.id = d.created_by
            where d.total >= 100000
          ) an
          where an.wcnt > 0 and an.wsum > 0 and an.total * 7 >= 3 * an.wsum

          union all
          select 8, an.cord * 1000000 + an.first_frn * 4 + 1, 'collection_anomaly', 'high',
                 'agent_payments', an.created_by::text,
                 an.day::text,
                 an.pname,
                 an.pname || ' ကောက်ခံသောငွေသည် ယမန်နေ့၏ ' || round(an.total * 100.0 / an.prev_total) || '% ရှိသည်',
                 'ကောက်ငွေ ' || to_char(an.total, 'FM999,999,999,999,999')
                   || ' ကျပ် · ယမန်နေ့ငွေ ' || to_char(an.prev_total, 'FM999,999,999,999,999')
                   || ' ကျပ် — ကောက်ခံမှု မှတ်တမ်းများကို စစ်ပါ'
          from (
            select d.created_by, d.day, d.total, d.first_frn, c.cord, pf.pname,
                   (select x.total from (
                      select created_by, payment_date as day, sum(amount) as total
                      from agent_payments where created_by is not null
                      group by created_by, payment_date
                    ) x where x.created_by = d.created_by and x.day = d.day - 1) as prev_total
            from (
              select created_by, payment_date as day, sum(amount) as total, min(frn) as first_frn
              from payments_f where created_by is not null
              group by created_by, payment_date
            ) d
            join (
              select created_by, min(first_frn) as cord
              from (
                select created_by, payment_date as day, min(frn) as first_frn
                from payments_f where created_by is not null
                group by created_by, payment_date
              ) dd
              group by created_by
            ) c on c.created_by = d.created_by
            join prof pf on pf.id = d.created_by
            where d.total >= 100000
          ) an
          where an.prev_total is not null and an.prev_total > 0 and an.total * 2 >= 3 * an.prev_total

          union all
          -- sec 9: disputes unresolved for more than 7 days.
          select 9, d.frn, 'dispute', 'medium', 'disputes', d.id::text,
                 ((d.created_at at time zone 'UTC')::date)::text,
                 coalesce(a.name, '—'),
                 'အငြင်းပွားမှု ' || (v_today - (d.created_at at time zone 'UTC')::date) || ' ရက် ကြာပြီ — မဖြေရှင်းရသေးပါ',
                 'အငြင်းပွားမှု စာမျက်နှာတွင် ပြန်ဖြေပြီး ပိတ်ပါ'
          from disputes_f d
          left join agents a on a.id = d.agent_id
          where d.status <> 'closed'
            and (v_today - (d.created_at at time zone 'UTC')::date) > 7

          union all
          -- sec 10: backup freshness.
          select 10, 0, 'system', 'medium', 'app_settings', 'last_backup_at',
                 v_today::text,
                 'Backup',
                 'Backup တစ်ခါမှ မလုပ်ရသေးပါ',
                 'ပင်မ စာမျက်နှာမှ Backup ဒေါင်းလုပ် လုပ်ပါ'
          where v_bk is null

          union all
          select 10, 0, 'system', 'medium', 'app_settings', 'last_backup_at',
                 left(v_bk, 10),
                 'Backup',
                 'နောက်ဆုံး Backup သည် ' || (v_today - left(v_bk, 10)::date) || ' ရက် ကြာပြီ',
                 'ပင်မ စာမျက်နှာမှ Backup အသစ် ဒေါင်းလုပ် လုပ်ပါ'
          where v_bk is not null
            and v_bk ~ '^\d{4}-\d{2}-\d{2}'
            and (v_today - left(v_bk, 10)::date) > 7
        ) b
      ) s
    ), '[]'::jsonb),
    'counts', jsonb_build_object(
      'entries', (select count(*) from daily_entries),
      'deposits', (select count(*) from agent_deposits),
      'payroll', (select count(*) from payroll_runs),
      'expenses', (select count(*) from expenses)
    )
  ) into v_result;

  return v_result;
end $$;

-- 3) guard_agent_money_settings: price / deposit / credit limit only.
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

-- 4) Drop the columns.
alter table agents drop column if exists bottle_limit;
alter table agents drop column if exists trip_qty;
