-- 0015: three parity refinements.
-- 1) public_factory_name(): the login card shows the owner's factory name
--    before sign-in (app_settings itself is authenticated-only).
-- 2) notify_on_entry(): delivery notifications escalate to high priority
--    with a warning title when the save leaves the agent over their credit
--    limit (old-app behaviour; staff saves are blocked by the guard, so
--    this fires on owner/manager saves).
-- 3) run_data_quality_alerts(): issue-level dedupe via dq_seen — an issue
--    alerts once when it first appears, not every morning; if it clears
--    and later recurs, it alerts again.

create or replace function public.public_factory_name() returns text
language sql security definer set search_path = public as $$
  select coalesce(
    (select value #>> '{}' from app_settings where key = 'factory_name'),
    'ရေသန့်စက်ရုံ')
$$;
revoke all on function public.public_factory_name() from public;
grant execute on function public.public_factory_name() to anon, authenticated;

create or replace function notify_on_entry() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_agent_user uuid;
  v_recip      uuid;
  v_credit     bigint;
  v_balance    bigint;
  v_priority   text := 'normal';
  v_title      text := 'ရေပို့ မှတ်တမ်း အသစ်';
begin
  select credit_limit into v_credit from agents where id = new.agent_id;
  if coalesce(v_credit, 0) > 0 then
    select coalesce(sum(amount - amount_collected), 0) into v_balance
      from daily_entries where agent_id = new.agent_id;
    v_balance := v_balance - coalesce(
      (select sum(amount) from agent_payments where agent_id = new.agent_id), 0);
    if v_balance > v_credit then
      v_priority := 'high';
      v_title := '⚠ ကြွေးကန့်သတ် ကျော်လွန်နေသော ရေပို့ မှတ်တမ်း';
    end if;
  end if;

  for v_recip in select om_recipients(new.created_by) loop
    perform insert_notification(
      v_recip, 'delivery', v_title,
      coalesce(new.agent_name, '') || ' — ' || new.delivered_qty || ' ဗူး · '
        || to_char(new.amount, 'FM999,999,999') || ' ကျပ်',
      '/entries', v_priority,
      'delivery:' || new.agent_id || ':' || new.entry_date);
  end loop;

  select id into v_agent_user from profiles
   where agent_id = new.agent_id and active and id is distinct from new.created_by
   limit 1;
  if v_agent_user is not null then
    perform insert_notification(
      v_agent_user, 'receipt', 'ရေပို့ မှတ်တမ်း',
      new.entry_date::text || ' — ' || new.delivered_qty || ' ဗူး ပို့ပြီး · ငွေလက်ခံ '
        || to_char(new.amount_collected, 'FM999,999,999') || ' ကျပ် · ကြွေး '
        || to_char(greatest(new.amount - new.amount_collected, 0), 'FM999,999,999') || ' ကျပ်',
      '/my', 'normal',
      'delivery:' || new.agent_id || ':' || new.entry_date);
  end if;
  return new;
end $$;

create table if not exists public.dq_seen (
  issue_key text primary key,
  first_seen_at timestamptz not null default now()
);
alter table public.dq_seen enable row level security;
-- No client policies: only the security-definer job function touches it.

create or replace function run_data_quality_alerts() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Yangon')::date;
  v_keys text[] := '{}';
  v_texts text[] := '{}';
  v_new_keys text[] := '{}';
  v_new_texts text[] := '{}';
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
  end if;

  select count(*) into v_n from disputes
    where status = 'open' and created_at < now() - interval '7 days';
  if v_n > 0 then
    v_keys := array_append(v_keys, 'disputes_open_old');
    v_texts := array_append(v_texts, 'ရက် ၇ ရက်ကျော် ဖွင့်ထားဆဲ အငြင်းပွားမှု ' || v_n || ' ခု ရှိပါသည်');
  end if;

  select count(*) into v_n from daily_entries
    where unit_price is not null and amount <> delivered_qty * unit_price;
  if v_n > 0 then
    v_keys := array_append(v_keys, 'amount_mismatch');
    v_texts := array_append(v_texts, 'ပမာဏ မကိုက်ညီသော ရေပို့စာရင်း ' || v_n || ' ခု ရှိပါသည်');
  end if;

  -- Forget issues that have cleared, so a recurrence alerts afresh.
  delete from dq_seen where not (issue_key = any (v_keys));

  -- Keep only issues never alerted before.
  for i in 1 .. coalesce(array_length(v_keys, 1), 0) loop
    if not exists (select 1 from dq_seen where issue_key = v_keys[i]) then
      v_new_keys := array_append(v_new_keys, v_keys[i]);
      v_new_texts := array_append(v_new_texts, v_texts[i]);
    end if;
  end loop;

  if array_length(v_new_keys, 1) is null then
    return;
  end if;

  insert into dq_seen (issue_key)
  select unnest(v_new_keys)
  on conflict (issue_key) do nothing;

  v_body := array_to_string(v_new_texts, ' ');

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
