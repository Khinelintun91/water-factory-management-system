-- 0017_collection_anomaly_prefs.sql — Live-parity gap wave (alerts).
-- 1) run_data_quality_alerts(): everything from 0015 preserved (same three
--    aggregate checks, same dq_seen issue-level dedupe, same per-day tag),
--    plus a collection-anomaly check: per collector (agent_payments
--    .created_by), for yesterday and today (Yangon), flag when the day's
--    collection total is (a) >= 3x their trailing-7-day daily average and
--    >= 100,000 MMK, or (b) >= 1.5x their previous-day total and
--    >= 100,000 MMK. Each flag notifies OM users as its own data_quality
--    notification (tag 'dqcoll-<collector>-<date>'), deduped via dq_seen
--    key 'collection_anomaly:<collector>:<date>'.
-- 2) notify_prefs honoured conservatively: alert_digest=false skips the
--    evening digest; alert_collection=false skips collection-anomaly
--    alerts; alert_old_debt=false skips old-debt/aging-class data-quality
--    issues (issue classes are tracked from this migration on; all three
--    existing aggregate checks are class 'general'). mode / quiet_night
--    semantics are untouched.

create or replace function send_daily_digest() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Yangon')::date;
  v_bottles int;
  v_sales bigint;
  v_cash bigint;
  v_exp bigint;
  v_outstanding bigint;
  v_body text;
  v_recip uuid;
begin
  select coalesce(sum(delivered_qty), 0), coalesce(sum(amount), 0),
         coalesce(sum(amount_collected), 0)
    into v_bottles, v_sales, v_cash
    from daily_entries where entry_date = v_today;
  select coalesce(sum(amount), 0) into v_exp
    from expenses where expense_date = v_today;
  select coalesce((select sum(amount - amount_collected) from daily_entries), 0)
         - coalesce((select sum(amount) from agent_payments), 0)
    into v_outstanding;

  v_body :=
    'ဒီနေ့ ရေ ' || v_bottles || ' ဘူး ပို့ပြီး, ရောင်းရငွေ '
    || to_char(v_sales, 'FM999,999,999,999') || ' ကျပ်, လက်ခံရငွေ '
    || to_char(v_cash, 'FM999,999,999,999') || ' ကျပ်, ဒီနေ့ ကြွေးတိုး '
    || to_char(v_sales - v_cash, 'FM999,999,999,999') || ' ကျပ်, ကုန်ကျစရိတ် '
    || to_char(v_exp, 'FM999,999,999,999') || ' ကျပ်. ကြွေးကျန် စုစုပေါင်း '
    || to_char(v_outstanding, 'FM999,999,999,999') || ' ကျပ်';

  for v_recip in select om_recipients(null) loop
    if exists (select 1 from notify_prefs
               where user_id = v_recip and mode = 'important') then
      continue;
    end if;
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

create or replace function run_data_quality_alerts() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Yangon')::date;
  v_keys text[] := '{}';
  v_texts text[] := '{}';
  v_classes text[] := '{}';
  v_new_keys text[] := '{}';
  v_new_texts text[] := '{}';
  v_new_classes text[] := '{}';
  v_anom_keys text[] := '{}';
  v_anom_bodies text[] := '{}';
  v_all_keys text[] := '{}';
  v_last_backup text;
  v_n int;
  v_body text;
  v_recip uuid;
  i int;
begin
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

  -- Collection anomalies (per collector, yesterday + today, Yangon).
  -- Rule (a) wins when both fire; one flag per collector + day.
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

  v_all_keys := v_keys || v_anom_keys;

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
    -- Compose this recipient's body from the issue classes they accept.
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
