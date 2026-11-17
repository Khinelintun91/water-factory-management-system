-- 0041: received_by — cash accountability follows the staff member who
-- physically RECEIVED the money, not necessarily the one who typed the
-- record (owner's rule, 2026-11-17).
--
-- daily_entries.amount_collected and every agent_payments row are cash
-- an agent handed to a person. Until now the only name on those rows
-- was created_by (the typist). This migration adds received_by to both
-- tables:
--   * existing rows are backfilled received_by = created_by (the best
--     available record of who took the cash at the time);
--   * new rows may leave it NULL in the database — every reader
--     (notification triggers, client display, the cash-handover
--     expectation) derives the receiver as
--     coalesce(received_by, created_by). The entry/payment forms send
--     it explicitly (defaulting to the current user), so NULL remains
--     only for rows written by older clients or direct SQL.
--
-- Agent receipts (the notifications an agent gets for their own
-- deliveries and payments) now NAME the receiver when cash moved, so
-- the agent can say exactly who they paid:
--   "ပေးချေငွေ {amount} ကျပ်ကို {receiver name} လက်ခံပြီး မှတ်တမ်းတင်ပြီးပါပြီ"
-- The receiver's display name resolves exactly like the UI's
-- personName(): profiles.display_name when set (trimmed, non-empty),
-- else the login username.
--
-- staff_directory(): agents and staff cannot read other users'
-- profiles (profiles_select is owner/manager-or-self), yet the
-- received-by form select (writers) and the agent-side "လက်ခံသူ:" lines
-- both need staff names. This definer RPC is the narrow bridge: it
-- returns ONLY id + display name + active flag for users holding a
-- non-agent effective role (primary role or a user_roles grant) —
-- no usernames beyond the display-name fallback, no agent accounts,
-- no contact data.

alter table daily_entries  add column if not exists received_by uuid references profiles (id);
alter table agent_payments add column if not exists received_by uuid references profiles (id);

-- The backfill runs under session_replication_role = 'replica' (the
-- fixture's own pattern for system-level data surgery): the same-day
-- edit guard and the month-lock guard would otherwise reject every
-- historical row, and the audit trigger would log one pseudo-edit per
-- row. The backfill changes no business fact — it materialises exactly
-- what every reader already assumed (coalesce(received_by,
-- created_by)) — so it is a system attribution, not a user edit.
set session_replication_role = 'replica';
update daily_entries  set received_by = created_by
 where received_by is null and created_by is not null;
update agent_payments set received_by = created_by
 where received_by is null and created_by is not null;
set session_replication_role = 'origin';

create or replace function public.staff_directory()
returns table(id uuid, name text, active boolean)
language sql security definer set search_path = public as $$
  select p.id,
         coalesce(nullif(trim(p.display_name), ''), p.username),
         p.active
    from profiles p
   where exists (
           select 1
             from (select p.role as r
                   union all
                   select ur.role from user_roles ur where ur.profile_id = p.id) roles
            where roles.r in ('owner', 'manager', 'co_owner', 'staff')
         )
   order by p.active desc, 2
$$;
revoke all on function public.staff_directory() from public;
grant execute on function public.staff_directory() to authenticated;

-- Delivery entry -> OM notice + agent receipt (0015 body, with the
-- receiver named on the agent receipt when cash was collected).
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

-- Payment -> OM notice + agent receipt (0011 body, with the receiver
-- named on the agent receipt).
create or replace function notify_on_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_agent_user uuid;
  v_recip      uuid;
  v_receiver   text;
  v_body       text;
begin
  for v_recip in select om_recipients(new.created_by) loop
    perform insert_notification(
      v_recip, 'collection', 'ငွေ ကောက်ခံမှု',
      coalesce(new.agent_name, '') || ' — ' || to_char(new.amount, 'FM999,999,999') || ' ကျပ် ရရှိ',
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
