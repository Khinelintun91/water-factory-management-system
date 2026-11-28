-- 0050_same_day_detection.sql — Package A: same-day error detection.
--
--   1. send_daily_digest() (replaces 0017):
--        * Today's cash now equals daily_entries.amount_collected +
--          agent_payments.amount for today (includes both entry-linked and
--          standalone payments).
--        * Total outstanding equals the sum of agent_outstanding() across
--          all agents (includes - write_offs + agent_damage_charges).
--        * Terminology fixed: uses ကျသင့်ငွေ (never ရောင်းရငွေ) and ဗူး.
--        * Delivered to all OM recipients unless alert_digest = false;
--          notify_prefs.mode = 'important' no longer skips the digest.
--          Existing dedupe tag ('digest-' || v_today) preserved.
--        * Adds a compact reconciliation section:
--            - per-receiver cash totals today (received_by, fallback created_by)
--            - standalone payments count + sum today
--            - same-day edits and deletes count today (audit_log on
--              daily_entries / agent_payments / expenses)
--            - handover mismatches / unrecorded handovers today (omitted
--              when none).
--   2. run_data_quality_alerts() (replaces 0017) + 18:30 Yangon cron job:
--        * Keeps all existing checks (backup_stale, disputes_open_old,
--          amount_mismatch, collection_anomaly) and existing 08:30 Yangon
--          cron job ('wfms-data-quality', '0 2 * * *' UTC).
--        * Adds same-day anomaly checks (covering today and yesterday,
--          deduped via dq_seen + per-issue notification tags so the 18:30
--          and 08:30 runs never double-alert):
--            - duplicate entries (same agent, delivered, returned, cash
--              within 15 minutes)
--            - negative held bottles (agents active today/yesterday whose
--              cumulative delivered - returned < 0)
--            - delivered_qty > 2000
--        * Schedules a second daily pg_cron job 'wfms-data-quality-evening'
--          at 18:30 Yangon ('0 12 * * *' UTC) so anomalies are flagged
--          before the midnight same-day edit cutoff.

-- 1) Fixed + reconciliation-enabled 19:00 Yangon daily digest
create or replace function public.send_daily_digest() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today          date := (now() at time zone 'Asia/Yangon')::date;
  v_bottles        int;
  v_charges        bigint;
  v_entry_cash     bigint;
  v_pay_cash       bigint;
  v_cash           bigint;
  v_exp            bigint;
  v_outstanding    bigint;
  v_rec_line       text;
  v_standalone_cnt int;
  v_standalone_sum bigint;
  v_edit_cnt       int;
  v_del_cnt        int;
  v_mismatch_line  text;
  v_body           text;
  v_recip          uuid;
begin
  select coalesce(sum(delivered_qty), 0),
         coalesce(sum(amount), 0),
         coalesce(sum(amount_collected), 0)
    into v_bottles, v_charges, v_entry_cash
    from daily_entries
   where entry_date = v_today;

  select coalesce(sum(amount), 0)
    into v_pay_cash
    from agent_payments
   where payment_date = v_today;

  v_cash := v_entry_cash + v_pay_cash;

  select coalesce(sum(amount), 0)
    into v_exp
    from expenses
   where expense_date = v_today;

  -- Exact sum of agent_outstanding() over all agents (includes - write_offs
  -- and + agent_damage_charges, matching migration 0042).
  select
    coalesce((select sum(e.delivered_qty::bigint * e.unit_price - e.amount_collected)
                from daily_entries e
                join agents a on a.id = e.agent_id), 0)
    - coalesce((select sum(p.amount)
                  from agent_payments p
                  join agents a on a.id = p.agent_id), 0)
    - coalesce((select sum(w.amount)
                  from write_offs w
                  join agents a on a.id = w.agent_id), 0)
    + coalesce((select sum(d.total)
                  from agent_damage_charges d
                  join agents a on a.id = d.agent_id), 0)
    into v_outstanding;

  -- Per-receiver cash totals today (received_by, fallback created_by).
  with rec_cash as (
    select holder_id, sum(amt)::bigint as total_cash
      from (
        select coalesce(received_by, created_by) as holder_id,
               amount_collected as amt
          from daily_entries
         where entry_date = v_today
           and amount_collected > 0
        union all
        select coalesce(received_by, created_by) as holder_id,
               amount as amt
          from agent_payments
         where payment_date = v_today
           and amount > 0
      ) x
     where holder_id is not null
     group by holder_id
  )
  select string_agg(
           coalesce(nullif(trim(pr.display_name), ''), pr.username)
           || ' ' || to_char(rc.total_cash, 'FM999,999,999,999'),
           ', '
           order by rc.total_cash desc,
                    coalesce(nullif(trim(pr.display_name), ''), pr.username)
         )
    into v_rec_line
    from rec_cash rc
    join profiles pr on pr.id = rc.holder_id;

  -- Standalone payments today (not spawned from a delivery entry).
  select count(*), coalesce(sum(amount), 0)
    into v_standalone_cnt, v_standalone_sum
    from agent_payments
   where payment_date = v_today
     and source_entry_id is null;

  -- Same-day edits and deletes today on core money tables (audit_log).
  select count(*) filter (where action = 'update'),
         count(*) filter (where action = 'delete')
    into v_edit_cnt, v_del_cnt
    from audit_log
   where (created_at at time zone 'Asia/Yangon')::date = v_today
     and table_name in ('daily_entries', 'agent_payments', 'expenses')
     and action in ('update', 'delete');

  -- Handover mismatches today:
  --  * staff/manager/co_owner with expected cash > 0 and no cash_handovers row
  --  * any employee with a cash_handovers row where received <> expected cash
  with rec_cash as (
    select holder_id, sum(amt)::bigint as exp_cash
      from (
        select coalesce(received_by, created_by) as holder_id,
               amount_collected as amt
          from daily_entries
         where entry_date = v_today
           and amount_collected > 0
        union all
        select coalesce(received_by, created_by) as holder_id,
               amount as amt
          from agent_payments
         where payment_date = v_today
           and amount > 0
      ) x
     where holder_id is not null
     group by holder_id
  ),
  ho as (
    select employee_id, received
      from cash_handovers
     where handover_date = v_today
  ),
  joined as (
    select coalesce(rc.holder_id, ho.employee_id) as emp_id,
           coalesce(rc.exp_cash, 0) as exp_cash,
           ho.received as rec_cash
      from rec_cash rc
      full outer join ho on ho.employee_id = rc.holder_id
  )
  select string_agg(
           coalesce(nullif(trim(pr.display_name), ''), pr.username)
           || ' ('
           || to_char(j.exp_cash, 'FM999,999,999,999')
           || '/'
           || case when j.rec_cash is null
                   then 'မအပ်ရသေး'
                   else to_char(j.rec_cash, 'FM999,999,999,999')
              end
           || ')',
           ', '
           order by coalesce(nullif(trim(pr.display_name), ''), pr.username)
         )
    into v_mismatch_line
    from joined j
    join profiles pr on pr.id = j.emp_id
   where (
           j.rec_cash is null
           and j.exp_cash > 0
           and (
             pr.role in ('staff', 'manager')
             or exists (
               select 1 from user_roles ur
                where ur.profile_id = pr.id
                  and ur.role in ('staff', 'manager', 'co_owner')
             )
           )
         )
      or (j.rec_cash is not null and j.rec_cash <> j.exp_cash);

  v_body :=
    'ဒီနေ့ ရေ ' || v_bottles || ' ဗူး ပို့ပြီး, ကျသင့်ငွေ '
    || to_char(v_charges, 'FM999,999,999,999') || ' ကျပ်, လက်ခံရငွေ '
    || to_char(v_cash, 'FM999,999,999,999') || ' ကျပ်, ကုန်ကျစရိတ် '
    || to_char(v_exp, 'FM999,999,999,999') || ' ကျပ်, ကြွေးကျန် စုစုပေါင်း '
    || to_char(v_outstanding, 'FM999,999,999,999') || ' ကျပ်';

  if v_rec_line is not null then
    v_body := v_body || ' | လက်ခံသူအလိုက်: ' || v_rec_line;
  end if;

  v_body := v_body
    || ' | သီးသန့်ငွေကောက်: ' || v_standalone_cnt || ' ခု ('
    || to_char(v_standalone_sum, 'FM999,999,999,999') || ' ကျပ်)'
    || ' | ပြင်/ဖျက်: ပြင် ' || v_edit_cnt || ' · ဖျက် ' || v_del_cnt;

  if v_mismatch_line is not null then
    v_body := v_body || ' | ငွေအပ်ကွာဟ: ' || v_mismatch_line;
  end if;

  -- Send to every OM recipient unless alert_digest = false explicitly;
  -- mode = 'important' does NOT skip the evening reconciliation digest.
  for v_recip in select om_recipients(null) loop
    if exists (select 1 from notify_prefs
               where user_id = v_recip and alert_digest = false) then
      continue;
    end if;
    if exists (select 1 from notifications
               where user_id = v_recip and tag = 'digest-' || v_today) then
      continue;
    end if;
    perform insert_notification(v_recip, 'digest', 'နေ့စဉ် အကျဉ်းချုပ်',
      v_body, '/', 'normal', 'digest-' || v_today);
  end loop;
end $$;

revoke all on function public.send_daily_digest() from public, anon, authenticated;

-- 2) Extended data-quality alerts with same-day anomaly checks (duplicates,
--    negative held bottles, delivered_qty > 2000) + 18:30 Yangon schedule.
create or replace function public.run_data_quality_alerts() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today          date := (now() at time zone 'Asia/Yangon')::date;
  v_keys           text[] := '{}';
  v_texts          text[] := '{}';
  v_classes        text[] := '{}';
  v_new_keys       text[] := '{}';
  v_new_texts      text[] := '{}';
  v_new_classes    text[] := '{}';
  v_anom_keys      text[] := '{}';
  v_anom_bodies    text[] := '{}';
  v_sd_keys        text[] := '{}';
  v_sd_tags        text[] := '{}';
  v_sd_bodies      text[] := '{}';
  v_all_keys       text[] := '{}';
  v_last_backup    text;
  v_n              int;
  v_body           text;
  v_recip          uuid;
  i                int;
begin
  -- Existing aggregate checks (0012 / 0015 / 0017).
  select value #>> '{}' into v_last_backup
    from app_settings where key = 'last_backup_at';
  if v_last_backup is null
     or v_last_backup::timestamptz < now() - interval '7 days' then
    v_keys := array_append(v_keys, 'backup_stale');
    v_texts := array_append(v_texts, 'Backup နောက်ကျနေပါသည် (နောက်ဆုံး backup: '
      || coalesce(v_last_backup, 'မရှိသေး') || ')');
    v_classes := array_append(v_classes, 'general');
  end if;

  select count(*) into v_n from disputes
    where status = 'open' and created_at < now() - interval '7 days';
  if v_n > 0 then
    v_keys := array_append(v_keys, 'disputes_open_old');
    v_texts := array_append(v_texts, 'ရက် ၇ ရက်ကျော် ဖွင့်ထားဆဲ အငြင်းပွားမှု ' || v_n || ' ခု ရှိပါသည်');
    v_classes := array_append(v_classes, 'general');
  end if;

  select count(*) into v_n from daily_entries
    where unit_price is not null and amount <> delivered_qty * unit_price;
  if v_n > 0 then
    v_keys := array_append(v_keys, 'amount_mismatch');
    v_texts := array_append(v_texts, 'ပမာဏ မကိုက်ညီသော ရေပို့စာရင်း ' || v_n || ' ခု ရှိပါသည်');
    v_classes := array_append(v_classes, 'general');
  end if;

  -- Collection anomalies (per collector, yesterday + today, Yangon — 0017).
  select coalesce(array_agg(k order by k), '{}'),
         coalesce(array_agg(b order by k), '{}')
    into v_anom_keys, v_anom_bodies
    from (
      select 'collection_anomaly:' || e.collector || ':' || e.d as k,
             case when e.flag = 'a'
                  then e.who || ' သည် ပုံမှန်ထက် ၃ ဆပိုများသော ငွေကို ကောက်ခံခဲ့သည်'
                  else e.who || ' ကောက်ခံသောငွေသည် ယမန်နေ့၏ '
                       || round(e.day_total * 100.0 / e.prev_total)::int
                       || '% ရှိသည်'
             end as b
        from (
          select t.collector, t.d, t.day_total,
                 coalesce((select sum(p2.amount) / 7.0 from agent_payments p2
                            where p2.created_by = t.collector
                              and p2.payment_date >= t.d - 7
                              and p2.payment_date <  t.d), 0) as avg7,
                 coalesce((select sum(p3.amount) from agent_payments p3
                            where p3.created_by = t.collector
                              and p3.payment_date = t.d - 1), 0) as prev_total,
                 coalesce(nullif(pr.display_name, ''), pr.username) as who,
                 case
                   when t.day_total >= 100000
                        and t.day_total >= 3 * coalesce(
                              (select sum(p2.amount) / 7.0 from agent_payments p2
                                where p2.created_by = t.collector
                                  and p2.payment_date >= t.d - 7
                                  and p2.payment_date <  t.d), 0)
                     then 'a'
                   when t.day_total >= 100000
                        and coalesce((select sum(p3.amount) from agent_payments p3
                                       where p3.created_by = t.collector
                                         and p3.payment_date = t.d - 1), 0) > 0
                        and t.day_total >= 1.5 * (select sum(p3.amount) from agent_payments p3
                                                    where p3.created_by = t.collector
                                                      and p3.payment_date = t.d - 1)
                     then 'b'
                 end as flag
            from (
              select p.created_by as collector, p.payment_date as d,
                     sum(p.amount) as day_total
                from agent_payments p
               where p.created_by is not null
                 and p.payment_date in (v_today, v_today - 1)
               group by p.created_by, p.payment_date
            ) t
            join profiles pr on pr.id = t.collector
        ) e
       where e.flag is not null
    ) s;

  -- Same-day anomaly checks (0050):
  --   1) Duplicate entries within 15 minutes (same agent, delivered, returned, cash)
  --   2) Negative held bottles (agents with activity today/yesterday and held < 0)
  --   3) Extreme delivered quantity (delivered_qty > 2000)
  -- Keyed per-issue so 18:30 Yangon catches today's mistakes immediately and
  -- the next morning's 08:30 run never double-alerts them.
  select coalesce(array_agg(k order by k), '{}'),
         coalesce(array_agg(tg order by k), '{}'),
         coalesce(array_agg(b order by k), '{}')
    into v_sd_keys, v_sd_tags, v_sd_bodies
    from (
      -- (a) Duplicate entries within 15 minutes (today / yesterday)
      select 'dup_entry:' || d.id as k,
             'dqdup-' || d.id as tg,
             'ထပ်တူမှတ်တမ်း သံသယ — ' || d.aname
               || ' (' || d.entry_date::text
               || ' · ပို့ ' || d.delivered_qty || ' ဗူး'
               || ' · ပြန် ' || d.returned_qty || ' ဗူး'
               || ' · ' || to_char(d.amount_collected, 'FM999,999,999,999') || ' ကျပ်)' as b
        from (
          select distinct on (e2.id)
                 e2.id,
                 e2.entry_date,
                 e2.delivered_qty,
                 e2.returned_qty,
                 e2.amount_collected,
                 coalesce(e2.agent_name, a.name, '—') as aname
            from daily_entries e2
            join daily_entries e1
              on e1.agent_id = e2.agent_id
             and e1.delivered_qty = e2.delivered_qty
             and e1.returned_qty = e2.returned_qty
             and e1.amount_collected = e2.amount_collected
             and (e1.created_at < e2.created_at
                  or (e1.created_at = e2.created_at and e1.id < e2.id))
             and e2.created_at - e1.created_at <= interval '15 minutes'
            left join agents a on a.id = e2.agent_id
           where e2.agent_id is not null
             and e2.entry_date in (v_today, v_today - 1)
           order by e2.id, e1.created_at desc
        ) d

      union all

      -- (b) Negative held bottles for agents with entries today / yesterday
      select 'neg_held:' || nh.agent_id || ':' || nh.last_date as k,
             'dqheld-' || nh.agent_id || '-' || nh.last_date as tg,
             'ကိုင်ထားဗူး အနုတ်ဖြစ်နေသည် — ' || nh.aname
               || ' (လက်ကျန် ' || nh.held || ' ဗူး)' as b
        from (
          select e.agent_id,
                 coalesce(a.name, max(e.agent_name), '—') as aname,
                 sum(e.delivered_qty - e.returned_qty)::bigint as held,
                 max(e.entry_date) as last_date
            from daily_entries e
            left join agents a on a.id = e.agent_id
           where e.agent_id is not null
           group by e.agent_id, a.name
          having sum(e.delivered_qty - e.returned_qty) < 0
             and max(e.entry_date) in (v_today, v_today - 1)
        ) nh

      union all

      -- (c) Extreme delivered quantity (> 2000 bottles, today / yesterday)
      select 'high_qty:' || e.id as k,
             'dqqty-' || e.id as tg,
             'ပို့သည့်ဗူး အလွန်များနေသည် — ' || coalesce(e.agent_name, a.name, '—')
               || ' (' || e.entry_date::text || ' · '
               || to_char(e.delivered_qty::bigint, 'FM999,999,999') || ' ဗူး)' as b
        from daily_entries e
        left join agents a on a.id = e.agent_id
       where e.delivered_qty > 2000
         and e.entry_date in (v_today, v_today - 1)
    ) sd;

  v_all_keys := v_keys || v_anom_keys || v_sd_keys;

  -- Forget issues that have cleared, so a recurrence alerts afresh.
  delete from dq_seen where not (issue_key = any (v_all_keys));

  -- Collection-anomaly notifications: first appearance only (dq_seen),
  -- one per flag, skipped for users with alert_collection = false.
  for i in 1 .. coalesce(array_length(v_anom_keys, 1), 0) loop
    if exists (select 1 from dq_seen where issue_key = v_anom_keys[i]) then
      continue;
    end if;
    insert into dq_seen (issue_key) values (v_anom_keys[i])
    on conflict (issue_key) do nothing;
    for v_recip in select om_recipients(null) loop
      if exists (select 1 from notify_prefs
                  where user_id = v_recip and alert_collection = false) then
        continue;
      end if;
      if exists (select 1 from notifications
                  where user_id = v_recip
                    and tag = 'dqcoll-'
                      || split_part(v_anom_keys[i], ':', 2) || '-'
                      || split_part(v_anom_keys[i], ':', 3)) then
        continue;
      end if;
      perform insert_notification(v_recip, 'data_quality',
        'Data စစ်ဆေးမှု သတိပေးချက်', v_anom_bodies[i], '/data-quality', 'high',
        'dqcoll-' || split_part(v_anom_keys[i], ':', 2) || '-'
          || split_part(v_anom_keys[i], ':', 3));
    end loop;
  end loop;

  -- Same-day anomaly notifications (duplicates, negative held, qty > 2000):
  -- first appearance only (dq_seen + per-issue notification tag).
  for i in 1 .. coalesce(array_length(v_sd_keys, 1), 0) loop
    if exists (select 1 from dq_seen where issue_key = v_sd_keys[i]) then
      continue;
    end if;
    insert into dq_seen (issue_key) values (v_sd_keys[i])
    on conflict (issue_key) do nothing;
    for v_recip in select om_recipients(null) loop
      if exists (select 1 from notifications
                  where user_id = v_recip and tag = v_sd_tags[i]) then
        continue;
      end if;
      perform insert_notification(v_recip, 'data_quality',
        'Data စစ်ဆေးမှု သတိပေးချက်', v_sd_bodies[i], '/data-quality', 'high',
        v_sd_tags[i]);
    end loop;
  end loop;

  -- Keep only aggregate issues never alerted before.
  for i in 1 .. coalesce(array_length(v_keys, 1), 0) loop
    if not exists (select 1 from dq_seen where issue_key = v_keys[i]) then
      v_new_keys := array_append(v_new_keys, v_keys[i]);
      v_new_texts := array_append(v_new_texts, v_texts[i]);
      v_new_classes := array_append(v_new_classes, v_classes[i]);
    end if;
  end loop;

  if array_length(v_new_keys, 1) is null then
    return;
  end if;

  insert into dq_seen (issue_key)
  select unnest(v_new_keys)
  on conflict (issue_key) do nothing;

  for v_recip in select om_recipients(null) loop
    if exists (select 1 from notifications
               where user_id = v_recip and tag = 'dq-' || v_today) then
      continue;
    end if;
    v_body := null;
    for i in 1 .. coalesce(array_length(v_new_keys, 1), 0) loop
      if v_new_classes[i] = 'old_debt'
         and exists (select 1 from notify_prefs
                      where user_id = v_recip and alert_old_debt = false) then
        continue;
      end if;
      v_body := concat_ws(' ', v_body, v_new_texts[i]);
    end loop;
    if v_body is null then
      continue;
    end if;
    perform insert_notification(v_recip, 'data_quality',
      'Data စစ်ဆေးမှု သတိပေးချက်', v_body, '/data-quality', 'high',
      'dq-' || v_today);
  end loop;
end $$;

revoke all on function public.run_data_quality_alerts() from public, anon, authenticated;

-- 3) Add 18:30 Yangon (12:00 UTC) same-day anomaly run alongside existing
--    08:30 Yangon ('wfms-data-quality', '0 2 * * *' UTC) job.
do $$ begin perform cron.unschedule('wfms-data-quality-evening'); exception when others then null; end $$;
select cron.schedule('wfms-data-quality-evening', '0 12 * * *', $$select public.run_data_quality_alerts()$$);
