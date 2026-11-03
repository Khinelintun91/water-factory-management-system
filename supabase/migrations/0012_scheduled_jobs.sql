-- 0012: Scheduled in-app jobs via pg_cron (Phase C).
--  * Daily digest: every evening 19:00 Yangon (12:30 UTC) each active
--    Owner/Manager gets a 'digest' notification with the day's figures,
--    computed from the ledger (never estimated). Users whose notify_prefs
--    mode is 'important' are skipped (digest is normal priority).
--  * Data-quality alerts: every morning 08:30 Yangon (02:00 UTC), if any
--    check fails, OM users get one 'data_quality' notification listing the
--    issues. Sent regardless of prefs mode (it is an alert, not a digest).
-- Both functions are idempotent per day (tag = kind + Yangon date).

create extension if not exists pg_cron;

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
  v_issues text[] := '{}';
  v_last_backup text;
  v_n int;
  v_body text;
  v_recip uuid;
begin
  select value #>> '{}' into v_last_backup
    from app_settings where key = 'last_backup_at';
  if v_last_backup is null
     or v_last_backup::timestamptz < now() - interval '7 days' then
    v_issues := v_issues || ('Backup နောက်ကျနေပါသည် (နောက်ဆုံး backup: '
      || coalesce(v_last_backup, 'မရှိသေး') || ')');
  end if;

  select count(*) into v_n from disputes
    where status = 'open' and created_at < now() - interval '7 days';
  if v_n > 0 then
    v_issues := v_issues || ('ရက် ၇ ရက်ကျော် ဖွင့်ထားဆဲ အငြင်းပွားမှု ' || v_n || ' ခု ရှိပါသည်');
  end if;

  select count(*) into v_n from daily_entries
    where unit_price is not null and amount <> delivered_qty * unit_price;
  if v_n > 0 then
    v_issues := v_issues || ('ပမာဏ မကိုက်ညီသော ရေပို့စာရင်း ' || v_n || ' ခု ရှိပါသည်');
  end if;

  if array_length(v_issues, 1) is null then
    return;
  end if;
  v_body := array_to_string(v_issues, ' ');

  for v_recip in select om_recipients(null) loop
    if exists (select 1 from notifications
               where user_id = v_recip and tag = 'dq-' || v_today) then
      continue;
    end if;
    perform insert_notification(v_recip, 'data_quality',
      'Data စစ်ဆေးမှု သတိပေးချက်', v_body, '/data-quality', 'high',
      'dq-' || v_today);
  end loop;
end $$;

-- Schedules (cron expressions are UTC). Replace any prior schedule of the
-- same name so re-applying this migration is safe.
do $$ begin perform cron.unschedule('wfms-daily-digest'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('wfms-data-quality'); exception when others then null; end $$;
select cron.schedule('wfms-daily-digest', '30 12 * * *', $$select public.send_daily_digest()$$);
select cron.schedule('wfms-data-quality', '0 2 * * *', $$select public.run_data_quality_alerts()$$);
