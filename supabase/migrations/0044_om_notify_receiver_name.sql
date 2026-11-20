-- 0044: OM notifications name the RECEIVER (owner's request, 2026-11-20).
--
-- 0041 made cash accountability follow the staff member who physically
-- received the money (received_by, read as coalesce(received_by,
-- created_by)) and named that person on the AGENT's receipt. But the
-- notices owner/manager/co_owner get for the same delivery or payment
-- still carried only the agent name + qty/amount — the owner reading a
-- "ရေပို့ မှတ်တမ်း အသစ်" notification could not tell WHICH staff member
-- took the delivery/cash without opening the entry.
--
-- This migration create-or-replaces notify_on_entry() and
-- notify_on_payment() with bodies identical to 0041 EXCEPT:
--   * each function resolves the receiver name ONCE before the OM loop,
--     exactly like the agent receipt already does (display_name when
--     set (trimmed, non-empty), else username, of
--     coalesce(new.received_by, new.created_by));
--   * the OM-recipient body gains the suffix
--       ' · လက်ခံသူ: <receiver name>'
--     when a name resolves. If none resolves (defensive only —
--     created_by is always stamped), the body stays byte-identical to
--     0041, and a notification can never fail over a missing name.
--
-- Nothing else changes: recipient sets (om_recipients excludes the
-- recorder), the credit-limit high-priority title logic, agent receipt
-- bodies (their own name lookup is kept verbatim), kinds, links,
-- priorities and tags are all exactly as in 0041.

-- Delivery entry -> OM notice (now naming the receiver) + agent receipt.
create or replace function notify_on_entry() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_agent_user uuid;
  v_recip      uuid;
  v_credit     bigint;
  v_balance    bigint;
  v_priority   text := 'normal';
  v_title      text := 'ရေပို့ မှတ်တမ်း အသစ်';
  v_receiver   text;
  v_body       text;
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

  -- 0044: receiver name for the OM notice, resolved exactly like the
  -- agent receipt below (the receipt block re-resolves it verbatim).
  select coalesce(nullif(trim(p.display_name), ''), p.username) into v_receiver
    from profiles p
   where p.id = coalesce(new.received_by, new.created_by);

  for v_recip in select om_recipients(new.created_by) loop
    perform insert_notification(
      v_recip, 'delivery', v_title,
      coalesce(new.agent_name, '') || ' — ' || new.delivered_qty || ' ဗူး · '
        || to_char(new.amount, 'FM999,999,999') || ' ကျပ်'
        || case when v_receiver is not null
                then ' · လက်ခံသူ: ' || v_receiver else '' end,
      '/entries', v_priority,
      'delivery:' || new.agent_id || ':' || new.entry_date);
  end loop;

  select id into v_agent_user from profiles
   where agent_id = new.agent_id and active and id is distinct from new.created_by
   limit 1;
  if v_agent_user is not null then
    select coalesce(nullif(trim(p.display_name), ''), p.username) into v_receiver
      from profiles p
     where p.id = coalesce(new.received_by, new.created_by);
    if new.amount_collected > 0 and v_receiver is not null then
      v_body := new.entry_date::text || ' — ' || new.delivered_qty || ' ဗူး ပို့ပြီး · ပေးချေငွေ '
        || to_char(new.amount_collected, 'FM999,999,999') || ' ကျပ်ကို ' || v_receiver
        || ' လက်ခံပြီး မှတ်တမ်းတင်ပြီးပါပြီ · ကြွေး '
        || to_char(greatest(new.amount - new.amount_collected, 0), 'FM999,999,999') || ' ကျပ်';
    else
      v_body := new.entry_date::text || ' — ' || new.delivered_qty || ' ဗူး ပို့ပြီး · ငွေလက်ခံ '
        || to_char(new.amount_collected, 'FM999,999,999') || ' ကျပ် · ကြွေး '
        || to_char(greatest(new.amount - new.amount_collected, 0), 'FM999,999,999') || ' ကျပ်';
    end if;
    perform insert_notification(
      v_agent_user, 'receipt', 'ရေပို့ မှတ်တမ်း', v_body,
      '/my', 'normal',
      'delivery:' || new.agent_id || ':' || new.entry_date);
  end if;
  return new;
end $$;

-- Payment -> OM notice (now naming the receiver) + agent receipt.
create or replace function notify_on_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_agent_user uuid;
  v_recip      uuid;
  v_receiver   text;
  v_body       text;
begin
  -- 0044: receiver name for the OM notice, resolved exactly like the
  -- agent receipt below (the receipt block re-resolves it verbatim).
  select coalesce(nullif(trim(p.display_name), ''), p.username) into v_receiver
    from profiles p
   where p.id = coalesce(new.received_by, new.created_by);

  for v_recip in select om_recipients(new.created_by) loop
    perform insert_notification(
      v_recip, 'collection', 'ငွေ ကောက်ခံမှု',
      coalesce(new.agent_name, '') || ' — ' || to_char(new.amount, 'FM999,999,999') || ' ကျပ် ရရှိ'
        || case when v_receiver is not null
                then ' · လက်ခံသူ: ' || v_receiver else '' end,
      '/payments', 'normal', 'collection:' || new.agent_id || ':' || new.payment_date);
  end loop;

  select id into v_agent_user from profiles
   where agent_id = new.agent_id and active and id is distinct from new.created_by
   limit 1;
  if v_agent_user is not null then
    select coalesce(nullif(trim(p.display_name), ''), p.username) into v_receiver
      from profiles p
     where p.id = coalesce(new.received_by, new.created_by);
    if v_receiver is not null then
      v_body := 'ပေးချေငွေ ' || to_char(new.amount, 'FM999,999,999') || ' ကျပ်ကို '
        || v_receiver || ' လက်ခံပြီး မှတ်တမ်းတင်ပြီးပါပြီ';
    else
      v_body := to_char(new.amount, 'FM999,999,999') || ' ကျပ် လက်ခံရရှိပါတယ်';
    end if;
    perform insert_notification(
      v_agent_user, 'receipt', 'ငွေ ပေးချေမှု မှတ်တမ်း', v_body,
      '/my', 'normal', 'collection:' || new.agent_id || ':' || new.payment_date);
  end if;
  return new;
end $$;
