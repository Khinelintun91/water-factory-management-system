-- 0052_pack2_receiver_deactivated.sql — Pack 2: close remaining staff-account
-- holes in Postgres (design basis: docs/reports/pack2-opinion-2026-11-28.md).
--
--   Item 1 (M5)     — Shared BEFORE INSERT OR UPDATE trigger guard_received_by()
--                     on daily_entries and agent_payments validating non-null
--                     new/changed received_by against active profiles holding
--                     an eligible role (owner/manager/co_owner/staff across
--                     profiles.role + user_roles.role). NULL stays allowed;
--                     Owner stays allowed; edit_daily_entry() aligned to the
--                     same error code and preserves unchanged deactivated-today
--                     receivers during same-day linked-payment rewrites.
--   Item 3 (M5)     — notify_on_entry() & notify_on_payment(): when
--                     received_by <> created_by (both non-null), OM and agent
--                     notifications show BOTH မှတ်တမ်းတင်သူ <typist> ·
--                     လက်ခံသူ <receiver>; same-person / NULL keeps exact
--                     0044/0049 single-name format.
--   Item 4 (D3)     — staff_directory(): requires active profile caller;
--                     is_staff_plus() (incl. dual-role staff+agent) gets full
--                     roster; pure agents see only receivers referenced via
--                     coalesce(received_by, created_by) on their own
--                     daily_entries & agent_payments.
--   Item 6 (D4b)    — Active-profile RLS checks on settings_select,
--                     locks_select, damage_items_select, noti_select/update,
--                     prefs_*, tokens_*. profiles_select intentionally kept
--                     accessible to own inactive row so sign-in can show the
--                     deactivated message.
--   Item 7 (D4c)    — AFTER UPDATE OF active ON public.profiles trigger
--                     sync_profile_active_to_auth(): deactivation sets finite
--                     auth.users.banned_until = '2999-12-31 00:00:00+00' and
--                     deletes auth.sessions; reactivation clears banned_until.
--   Item 8 (L1)     — Drop noti_delete policy; BEFORE UPDATE trigger restricts
--                     client (authenticated/anon) updates on notifications to
--                     read_at only.
--   Item 9 (D5+L2)  — categories_select, expenses_update, expenses_delete
--                     locked to is_owner_manager().
--   Item 10 (M9)    — entries_before_write(): reject INSERT for inactive
--                     agents (active = false) and align credit_limit gate from
--                     app_role() = 'staff' to not is_owner_manager().

-- =========================================================================
-- Item 1 (M5): validate received_by on daily_entries & agent_payments
--              + align edit_daily_entry()
-- =========================================================================

create or replace function public.guard_received_by() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_entry_id uuid;
begin
  -- NULL stays allowed everywhere (CloseoutPage, legacy offlineQueue,
  -- fallback coalesce(received_by, created_by)).
  if new.received_by is null then
    return new;
  end if;

  -- On UPDATE, an unchanged receiver is never re-rejected so edits to
  -- quantity/notes remain possible if that receiver was deactivated later.
  if tg_op = 'UPDATE' and new.received_by is not distinct from old.received_by then
    return new;
  end if;

  -- Critical edge case: edit_daily_entry() rewrites linked agent_payments
  -- via DELETE + INSERT when cash changes. If the parent entry's stored
  -- receiver was deactivated midday and is NOT being changed, allow the
  -- rewritten linked payment to keep that same receiver.
  if tg_table_name = 'agent_payments' and tg_op = 'INSERT' then
    v_source_entry_id := nullif(to_jsonb(new) ->> 'source_entry_id', '')::uuid;
    if v_source_entry_id is not null
       and exists (
         select 1
           from public.daily_entries de
          where de.id = v_source_entry_id
            and coalesce(de.received_by, de.created_by) is not distinct from new.received_by
       ) then
      return new;
    end if;
  end if;

  if not exists (
    select 1
      from public.profiles p
     where p.id = new.received_by
       and p.active
       and (
         p.role in ('owner', 'manager', 'co_owner', 'staff')
         or exists (
           select 1
             from public.user_roles ur
            where ur.profile_id = p.id
              and ur.role in ('owner', 'manager', 'co_owner', 'staff')
         )
       )
  ) then
    raise exception 'invalid_receiver: receiver must be an active staff, manager, or owner profile'
      using errcode = 'P0001';
  end if;

  return new;
end $$;

revoke all on function public.guard_received_by() from public, anon, authenticated;

drop trigger if exists entries_guard_received_by on public.daily_entries;
create trigger entries_guard_received_by
  before insert or update on public.daily_entries
  for each row execute function public.guard_received_by();

drop trigger if exists payments_guard_received_by on public.agent_payments;
create trigger payments_guard_received_by
  before insert or update on public.agent_payments
  for each row execute function public.guard_received_by();

-- Align edit_daily_entry() (0049) receiver check with guard_received_by():
--   * Changing received_by to an inactive/agent/unknown profile fails with
--     the exact same 'invalid_receiver' error.
--   * Leaving an unchanged receiver (even if deactivated midday) keeps
--     working on both daily_entries UPDATE and linked agent_payments rewrite.
create or replace function public.edit_daily_entry(
  p_entry_id      uuid,
  p_delivered_qty integer,
  p_returned_qty  integer,
  p_total_cash    bigint,
  p_received_by   uuid default null,
  p_notes         text default null,
  p_change_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid               uuid := auth.uid();
  v_entry             daily_entries%rowtype;
  v_entry_month       date;
  v_reason            text := btrim(coalesce(p_change_reason, ''));
  v_receiver          uuid;
  v_stored_receiver   uuid;
  v_receiver_changed  boolean := false;
  v_new_amount        bigint;
  v_to_today          bigint;
  v_to_old            bigint := 0;
  v_advance           bigint := 0;
  v_outstanding_now   bigint := 0;
  v_linked_sum        bigint := 0;
  v_base              bigint := 0;
  v_resulting_bal     bigint := 0;
  v_old_debt_sum      bigint := 0;
  v_old_reg_sum       bigint := 0;
  v_old_linked_cnt    integer := 0;
  v_need_rewrite      boolean := false;
begin
  -- Active staff-plus only (owner / manager / co_owner / staff).
  if v_uid is null or not is_staff_plus() then
    raise exception 'forbidden: staff or management role required'
      using errcode = '42501';
  end if;

  select * into v_entry
    from daily_entries
   where id = p_entry_id
     for update;
  if v_entry.id is null then
    raise exception 'entry_not_found'
      using errcode = 'P0001';
  end if;

  -- Rule A (0045): OM may edit any row; staff only their own created_by row.
  if not (is_owner_manager() or v_entry.created_by = v_uid) then
    raise exception 'forbidden: staff may edit only their own entries'
      using errcode = '42501';
  end if;

  -- Same-day guard (SPEC rule 4): ALL roles, Owner included.
  if (v_entry.created_at at time zone 'Asia/Yangon')::date
     <> (now() at time zone 'Asia/Yangon')::date then
    raise exception 'same_day_only: records can only be edited or deleted on the day they were created'
      using errcode = 'P0001';
  end if;

  -- Month lock (SPEC rule 6): ALL roles, Owner included.
  v_entry_month := date_trunc('month', v_entry.entry_date)::date;
  if exists (select 1 from month_locks where month = v_entry_month) then
    raise exception 'month_locked: % is locked', v_entry_month
      using errcode = 'P0001';
  end if;

  if char_length(v_reason) < 2 then
    raise exception 'change_reason_required: change reason must be at least 2 characters'
      using errcode = 'P0001';
  end if;

  -- Preserve NULL received_by when caller omitted p_received_by and the row
  -- stored NULL (so guard_received_by sees an unchanged receiver even if
  -- created_by was deactivated midday); for linked payments use effective
  -- receiver coalesce(v_stored_receiver, v_entry.created_by).
  if p_received_by is null then
    v_stored_receiver := v_entry.received_by;
    v_receiver := coalesce(v_entry.received_by, v_entry.created_by);
    v_receiver_changed := false;
  else
    v_stored_receiver := p_received_by;
    v_receiver := p_received_by;
    v_receiver_changed := (p_received_by is distinct from coalesce(v_entry.received_by, v_entry.created_by));
  end if;

  if v_receiver_changed and not exists (
    select 1
      from public.profiles p
     where p.id = v_receiver
       and p.active
       and (
         p.role in ('owner', 'manager', 'co_owner', 'staff')
         or exists (
           select 1
             from public.user_roles ur
            where ur.profile_id = p.id
              and ur.role in ('owner', 'manager', 'co_owner', 'staff')
         )
       )
  ) then
    raise exception 'invalid_receiver: receiver must be an active staff, manager, or owner profile'
      using errcode = 'P0001';
  end if;

  -- Branch by fixed entry type (bottle-only vs delivery).
  if v_entry.delivered_qty = 0 then
    if p_delivered_qty is null or p_delivered_qty <> 0 then
      raise exception 'entry_type_immutable: bottle-only entry cannot be changed to a delivery'
        using errcode = 'P0001';
    end if;
    if p_returned_qty is null or p_returned_qty <= 0 then
      raise exception 'invalid_returned_qty: returned_qty must be positive for bottle-only entries'
        using errcode = 'P0001';
    end if;
    if p_total_cash is null or p_total_cash <> 0 then
      raise exception 'bottle_only_no_cash: bottle-only entries cannot carry cash'
        using errcode = 'P0001';
    end if;

    update daily_entries
       set delivered_qty    = 0,
           returned_qty     = p_returned_qty,
           amount_collected = 0,
           received_by      = v_stored_receiver,
           notes            = nullif(btrim(coalesce(p_notes, '')), ''),
           change_reason    = v_reason
     where id = v_entry.id;

    if v_entry.agent_id is not null then
      v_resulting_bal := agent_outstanding(v_entry.agent_id);
    else
      v_resulting_bal := 0;
    end if;

    return jsonb_build_object(
      'entry_id', v_entry.id,
      'amount', 0::bigint,
      'to_today', 0::bigint,
      'to_old', 0::bigint,
      'advance', 0::bigint,
      'resulting_balance', v_resulting_bal
    );
  end if;

  -- Delivery row validation: type cannot switch to bottle-only.
  if p_delivered_qty = 0 and coalesce(p_returned_qty, 0) > 0 then
    raise exception 'entry_type_immutable: delivery entry cannot be changed to bottle-only'
      using errcode = 'P0001';
  end if;
  if p_delivered_qty is null or p_delivered_qty <= 0 then
    raise exception 'invalid_delivered_qty: delivered_qty must be positive'
      using errcode = 'P0001';
  end if;
  if p_returned_qty is null or p_returned_qty < 0 then
    raise exception 'invalid_returned_qty: returned_qty cannot be negative'
      using errcode = 'P0001';
  end if;
  if p_total_cash is null or p_total_cash < 0 then
    raise exception 'invalid_cash: total cash cannot be negative'
      using errcode = 'P0001';
  end if;

  -- Preserve the row's snapshot unit_price (and never change agent_id).
  v_new_amount := p_delivered_qty::bigint * v_entry.unit_price;

  if v_entry.agent_id is null then
    v_to_today := p_total_cash;
    v_resulting_bal := v_new_amount - p_total_cash;
  else
    select coalesce(sum(amount), 0),
           coalesce(sum(case when kind = 'old_debt' then amount else 0 end), 0),
           coalesce(sum(case when kind = 'regular' then amount else 0 end), 0),
           count(*)
      into v_linked_sum, v_old_debt_sum, v_old_reg_sum, v_old_linked_cnt
      from agent_payments
     where source_entry_id = v_entry.id;

    v_outstanding_now := agent_outstanding(v_entry.agent_id);
    -- Mirror editBaseOutstanding + allocateCash (src/lib/cashAllocation.ts).
    v_base := v_outstanding_now - (v_entry.amount - v_entry.amount_collected) + v_linked_sum;
    v_to_today := least(p_total_cash, greatest(v_new_amount, 0::bigint));
    v_to_old   := least(p_total_cash - v_to_today, greatest(v_base, 0::bigint));
    v_advance  := p_total_cash - v_to_today - v_to_old;
    v_resulting_bal := v_base + v_new_amount - p_total_cash;

    v_need_rewrite :=
         v_old_debt_sum <> v_to_old
      or v_old_reg_sum  <> v_advance
      or v_old_linked_cnt <> (
           (case when v_to_old > 0 then 1 else 0 end)
           + (case when v_advance > 0 then 1 else 0 end)
         );

    if v_need_rewrite then
      delete from agent_payments
       where source_entry_id = v_entry.id;

      if v_to_old > 0 then
        insert into agent_payments (
          payment_date, agent_id, agent_name, amount, method, kind,
          notes, created_by, received_by, source_entry_id
        ) values (
          v_entry.entry_date, v_entry.agent_id, v_entry.agent_name,
          v_to_old, 'cash', 'old_debt',
          'ရေပို့မှတ်တမ်းနှင့်အတူ ပေးချေသည်',
          v_uid, v_receiver, v_entry.id
        );
      end if;

      if v_advance > 0 then
        insert into agent_payments (
          payment_date, agent_id, agent_name, amount, method, kind,
          notes, created_by, received_by, source_entry_id
        ) values (
          v_entry.entry_date, v_entry.agent_id, v_entry.agent_name,
          v_advance, 'cash', 'regular',
          'ရေပို့မှတ်တမ်းနှင့်အတူ ပိုပေးငွေ',
          v_uid, v_receiver, v_entry.id
        );
      end if;
    elsif v_old_linked_cnt > 0 and exists (
      select 1 from agent_payments
       where source_entry_id = v_entry.id
         and received_by is distinct from v_receiver
    ) then
      update agent_payments
         set received_by   = v_receiver,
             change_reason = v_reason
       where source_entry_id = v_entry.id;
    end if;
  end if;

  update daily_entries
     set delivered_qty    = p_delivered_qty,
         returned_qty     = p_returned_qty,
         amount_collected = v_to_today,
         received_by      = v_stored_receiver,
         notes            = nullif(btrim(coalesce(p_notes, '')), ''),
         change_reason    = v_reason
   where id = v_entry.id;

  return jsonb_build_object(
    'entry_id', v_entry.id,
    'amount', v_new_amount,
    'to_today', v_to_today,
    'to_old', v_to_old,
    'advance', v_advance,
    'resulting_balance', v_resulting_bal
  );
end $$;

revoke all on function public.edit_daily_entry(uuid, integer, integer, bigint, uuid, text, text) from public, anon;
grant execute on function public.edit_daily_entry(uuid, integer, integer, bigint, uuid, text, text) to authenticated;

-- =========================================================================
-- Item 3 (M5 anti-framing): notify_on_entry() & notify_on_payment()
--   When received_by IS DISTINCT FROM created_by (both non-null), show BOTH
--   မှတ်တမ်းတင်သူ <typist> · လက်ခံသူ <receiver> in OM and agent notices.
--   When they are the same person (or received_by IS NULL), keep the exact
--   0044/0049 single-name format.
-- =========================================================================

create or replace function public.notify_on_entry() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent_user uuid;
  v_recip      uuid;
  v_credit     bigint;
  v_balance    bigint;
  v_priority   text := 'normal';
  v_title      text := 'ရေပို့ မှတ်တမ်း အသစ်';
  v_receiver   text;
  v_typist     text;
  v_diff_actor boolean := false;
  v_actor_tag  text := '';
  v_body       text;
begin
  select coalesce(nullif(trim(p.display_name), ''), p.username) into v_receiver
    from profiles p
   where p.id = coalesce(new.received_by, new.created_by);

  if new.received_by is not null
     and new.created_by is not null
     and new.received_by <> new.created_by then
    select coalesce(nullif(trim(p.display_name), ''), p.username) into v_typist
      from profiles p
     where p.id = new.created_by;
    if v_typist is not null and v_receiver is not null then
      v_diff_actor := true;
    end if;
  end if;

  if v_diff_actor then
    v_actor_tag := ' · မှတ်တမ်းတင်သူ ' || v_typist || ' · လက်ခံသူ ' || v_receiver;
  elsif v_receiver is not null then
    v_actor_tag := ' · လက်ခံသူ: ' || v_receiver;
  end if;

  -- Bottle-only collection (delivered_qty = 0): dedicated notice naming
  -- returned bottles and receiver, no money, no credit-limit red-flag.
  if new.delivered_qty = 0 then
    for v_recip in select om_recipients(new.created_by) loop
      perform insert_notification(
        v_recip, 'delivery', 'ဗူးခွံပြန်ယူ မှတ်တမ်း',
        coalesce(new.agent_name, '') || ' — ' || new.returned_qty || ' ဗူး ပြန်ယူ'
          || v_actor_tag,
        '/entries', 'normal',
        'bottle_return:' || new.agent_id || ':' || new.entry_date);
    end loop;

    select id into v_agent_user from profiles
     where agent_id = new.agent_id and active and id is distinct from new.created_by
     limit 1;
    if v_agent_user is not null then
      if v_diff_actor then
        v_body := new.entry_date::text || ' — ' || new.returned_qty
          || ' ဗူး ပြန်အပ်ပြီး (မှတ်တမ်းတင်သူ ' || v_typist
          || ' · လက်ခံသူ ' || v_receiver || ')';
      else
        v_body := new.entry_date::text || ' — ' || new.returned_qty || ' ဗူး ပြန်အပ်ပြီး'
          || case when v_receiver is not null
                  then ' (' || v_receiver || ' လက်ခံ)' else '' end;
      end if;
      perform insert_notification(
        v_agent_user, 'receipt', 'ဗူးခွံပြန်အပ် မှတ်တမ်း', v_body,
        '/my', 'normal',
        'bottle_return:' || new.agent_id || ':' || new.entry_date);
    end if;
    return new;
  end if;

  -- Delivery row (delivered_qty > 0).
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
        || to_char(new.amount, 'FM999,999,999') || ' ကျပ်'
        || v_actor_tag,
      '/entries', v_priority,
      'delivery:' || new.agent_id || ':' || new.entry_date);
  end loop;

  select id into v_agent_user from profiles
   where agent_id = new.agent_id and active and id is distinct from new.created_by
   limit 1;
  if v_agent_user is not null then
    if new.amount_collected > 0 and v_diff_actor then
      v_body := new.entry_date::text || ' — ' || new.delivered_qty || ' ဗူး ပို့ပြီး · ပေးချေငွေ '
        || to_char(new.amount_collected, 'FM999,999,999') || ' ကျပ် (မှတ်တမ်းတင်သူ '
        || v_typist || ' · လက်ခံသူ ' || v_receiver || ') · ကြွေး '
        || to_char(greatest(new.amount - new.amount_collected, 0), 'FM999,999,999') || ' ကျပ်';
    elsif new.amount_collected > 0 and v_receiver is not null then
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

revoke all on function public.notify_on_entry() from public, anon, authenticated;

create or replace function public.notify_on_payment() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent_user uuid;
  v_recip      uuid;
  v_receiver   text;
  v_typist     text;
  v_diff_actor boolean := false;
  v_actor_tag  text := '';
  v_body       text;
begin
  select coalesce(nullif(trim(p.display_name), ''), p.username) into v_receiver
    from profiles p
   where p.id = coalesce(new.received_by, new.created_by);

  if new.received_by is not null
     and new.created_by is not null
     and new.received_by <> new.created_by then
    select coalesce(nullif(trim(p.display_name), ''), p.username) into v_typist
      from profiles p
     where p.id = new.created_by;
    if v_typist is not null and v_receiver is not null then
      v_diff_actor := true;
    end if;
  end if;

  if v_diff_actor then
    v_actor_tag := ' · မှတ်တမ်းတင်သူ ' || v_typist || ' · လက်ခံသူ ' || v_receiver;
  elsif v_receiver is not null then
    v_actor_tag := ' · လက်ခံသူ: ' || v_receiver;
  end if;

  for v_recip in select om_recipients(new.created_by) loop
    perform insert_notification(
      v_recip, 'collection', 'ငွေ ကောက်ခံမှု',
      coalesce(new.agent_name, '') || ' — ' || to_char(new.amount, 'FM999,999,999') || ' ကျပ် ရရှိ'
        || v_actor_tag,
      '/payments', 'normal', 'collection:' || new.agent_id || ':' || new.payment_date);
  end loop;

  select id into v_agent_user from profiles
   where agent_id = new.agent_id and active and id is distinct from new.created_by
   limit 1;
  if v_agent_user is not null then
    if v_diff_actor then
      v_body := 'ပေးချေငွေ ' || to_char(new.amount, 'FM999,999,999')
        || ' ကျပ် · မှတ်တမ်းတင်သူ ' || v_typist || ' · လက်ခံသူ ' || v_receiver;
    elsif v_receiver is not null then
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

revoke all on function public.notify_on_payment() from public, anon, authenticated;

-- =========================================================================
-- Item 4 (D3): gate staff_directory()
--   - Caller must be an active profile (42501 otherwise).
--   - is_staff_plus() (incl. dual-role staff+agent) gets full roster.
--   - Pure agents see only receivers referenced via coalesce(received_by,
--     created_by) across their own daily_entries & agent_payments.
-- =========================================================================

create or replace function public.staff_directory()
returns table(id uuid, name text, active boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_agent uuid;
begin
  if v_uid is null or not exists (
    select 1 from public.profiles p where p.id = v_uid and p.active
  ) then
    raise exception 'staff_directory: not allowed'
      using errcode = '42501';
  end if;

  if public.is_staff_plus() then
    return query
    select p.id,
           coalesce(nullif(trim(p.display_name), ''), p.username),
           p.active
      from public.profiles p
     where exists (
             select 1
               from (select p.role as r
                     union all
                     select ur.role from public.user_roles ur where ur.profile_id = p.id) roles
              where roles.r in ('owner', 'manager', 'co_owner', 'staff')
           )
     order by p.active desc, 2;
    return;
  end if;

  v_agent := public.app_agent_id();
  if v_agent is null then
    return;
  end if;

  return query
  with referenced as (
    select distinct coalesce(e.received_by, e.created_by) as pid
      from public.daily_entries e
     where e.agent_id = v_agent
       and coalesce(e.received_by, e.created_by) is not null
    union
    select distinct coalesce(ap.received_by, ap.created_by) as pid
      from public.agent_payments ap
     where ap.agent_id = v_agent
       and coalesce(ap.received_by, ap.created_by) is not null
  )
  select p.id,
         coalesce(nullif(trim(p.display_name), ''), p.username),
         p.active
    from public.profiles p
    join referenced r on r.pid = p.id
   where exists (
           select 1
             from (select p.role as r
                   union all
                   select ur.role from public.user_roles ur where ur.profile_id = p.id) roles
            where roles.r in ('owner', 'manager', 'co_owner', 'staff')
         )
   order by p.active desc, 2;
end $$;

revoke all on function public.staff_directory() from public, anon;
grant execute on function public.staff_directory() to authenticated;

-- =========================================================================
-- Item 6 (D4b) + Item 8 (L1): RLS active checks + lock notifications
--   NOTE: profiles_select is intentionally NOT gated on active so signIn()
--   can read active = false and show the disabled-account message.
-- =========================================================================

drop policy if exists settings_select on public.app_settings;
create policy settings_select on public.app_settings for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.active));

drop policy if exists locks_select on public.month_locks;
create policy locks_select on public.month_locks for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.active));

drop policy if exists damage_items_select on public.damage_items;
create policy damage_items_select on public.damage_items for select to authenticated
  using (
    is_owner_manager()
    or (active and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active))
  );

drop policy if exists noti_select on public.notifications;
create policy noti_select on public.notifications for select to authenticated
  using (
    user_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
  );

drop policy if exists noti_update on public.notifications;
create policy noti_update on public.notifications for update to authenticated
  using (
    user_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
  )
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
  );

-- Item 8 (L1): drop noti_delete completely (the app never deletes notifications).
drop policy if exists noti_delete on public.notifications;

-- Item 8 (L1): client (authenticated/anon) updates on notifications may
-- change read_at ONLY; any other column change raises. SECURITY INVOKER so
-- current_user distinguishes client updates from SECURITY DEFINER code.
create or replace function public.guard_notification_update() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if (to_jsonb(new) - 'read_at') is distinct from (to_jsonb(old) - 'read_at') then
      raise exception 'notification_read_at_only: only read_at may be updated on notifications'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

revoke all on function public.guard_notification_update() from public, anon, authenticated;

drop trigger if exists notifications_read_at_only on public.notifications;
create trigger notifications_read_at_only
  before update on public.notifications
  for each row execute function public.guard_notification_update();

drop policy if exists prefs_select on public.notify_prefs;
create policy prefs_select on public.notify_prefs for select to authenticated
  using (
    user_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
  );

drop policy if exists prefs_write on public.notify_prefs;
create policy prefs_write on public.notify_prefs for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
  );

drop policy if exists prefs_update on public.notify_prefs;
create policy prefs_update on public.notify_prefs for update to authenticated
  using (
    user_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
  )
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
  );

drop policy if exists tokens_select on public.push_tokens;
create policy tokens_select on public.push_tokens for select to authenticated
  using (
    is_owner_manager()
    or (profile_id = auth.uid()
        and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active))
  );

drop policy if exists tokens_insert on public.push_tokens;
create policy tokens_insert on public.push_tokens for insert to authenticated
  with check (
    profile_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
  );

drop policy if exists tokens_update on public.push_tokens;
create policy tokens_update on public.push_tokens for update to authenticated
  using (
    profile_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
  )
  with check (
    profile_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
  );

drop policy if exists tokens_delete on public.push_tokens;
create policy tokens_delete on public.push_tokens for delete to authenticated
  using (
    profile_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
  );

-- =========================================================================
-- Item 7 (D4c): sync profiles.active -> auth.users.banned_until + auth.sessions
--   Finite far-future timestamp (never 'infinity' — GoTrue cannot scan it).
-- =========================================================================

create or replace function public.sync_profile_active_to_auth() returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if new.active is not distinct from old.active then
    return new;
  end if;

  if not new.active then
    update auth.users
       set banned_until = timestamptz '2999-12-31 00:00:00+00',
           updated_at   = now()
     where id = new.id;
    delete from auth.sessions
     where user_id = new.id;
  else
    update auth.users
       set banned_until = null,
           updated_at   = now()
     where id = new.id;
  end if;

  return new;
end $$;

revoke all on function public.sync_profile_active_to_auth() from public, anon, authenticated;

drop trigger if exists profiles_sync_auth_ban on public.profiles;
create trigger profiles_sync_auth_ban
  after update of active on public.profiles
  for each row execute function public.sync_profile_active_to_auth();

-- =========================================================================
-- Item 9 (D5 + L2): lock expense_categories SELECT & expenses UPDATE/DELETE
--                   to is_owner_manager()
-- =========================================================================

drop policy if exists categories_select on public.expense_categories;
create policy categories_select on public.expense_categories for select to authenticated
  using (is_owner_manager());

drop policy if exists expenses_update on public.expenses;
create policy expenses_update on public.expenses for update to authenticated
  using (is_owner_manager())
  with check (is_owner_manager());

drop policy if exists expenses_delete on public.expenses;
create policy expenses_delete on public.expenses for delete to authenticated
  using (is_owner_manager());

-- =========================================================================
-- Item 10 (M9): entries_before_write() consistency
--   - Reject INSERT for inactive agents (agents.active = false).
--   - Align credit_limit gate from app_role() = 'staff' to
--     not is_owner_manager() (matching payments_before_write/delete in 0051).
--   - Preserve all 0049/0051 invariants otherwise.
-- =========================================================================

create or replace function public.entries_before_write() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent       agents%rowtype;
  v_held        integer;
  v_dep_bottles integer;
  v_due         bigint;
  v_old_due     bigint := 0;
begin
  -- Row invariant (0049): a visit must record either delivered bottles or
  -- returned empties (both zero is invalid).
  if coalesce(new.delivered_qty, 0) <= 0 and coalesce(new.returned_qty, 0) <= 0 then
    raise exception 'invalid_entry_qty: delivered_qty or returned_qty must be positive'
      using errcode = 'P0001';
  end if;

  -- UPDATE immutability guards (0049 entry type + 0051 money/date columns).
  if tg_op = 'UPDATE' then
    if old.delivered_qty = 0 and new.delivered_qty > 0 then
      raise exception 'entry_type_immutable: bottle-only entry cannot be changed to a delivery'
        using errcode = 'P0001';
    end if;
    if old.delivered_qty > 0 and new.delivered_qty = 0 then
      raise exception 'entry_type_immutable: delivery entry cannot be changed to bottle-only'
        using errcode = 'P0001';
    end if;
    if new.unit_price is distinct from old.unit_price then
      raise exception 'unit_price_immutable: unit_price cannot be changed on update'
        using errcode = 'P0001';
    end if;
    if new.entry_date is distinct from old.entry_date then
      raise exception 'entry_date_immutable: entry_date cannot be changed on update'
        using errcode = 'P0001';
    end if;
    if new.created_at is distinct from old.created_at then
      raise exception 'created_at_immutable: created_at cannot be changed on update'
        using errcode = 'P0001';
    end if;
  end if;

  -- Bottle-only rows must never carry money.
  if new.delivered_qty = 0 then
    new.amount := 0;
    if coalesce(new.amount_collected, 0) <> 0 then
      raise exception 'bottle_only_no_cash: bottle-only entries cannot carry cash'
        using errcode = 'P0001';
    end if;
  end if;

  -- Item 3 (0051 M6): new entries must always reference an agent.
  if new.agent_id is null then
    if tg_op = 'INSERT' then
      raise exception 'agent_required: agent_id cannot be null on insert'
        using errcode = 'P0001';
    end if;
    new.amount := new.delivered_qty::bigint * new.unit_price;
    return new;
  end if;

  select * into v_agent from agents where id = new.agent_id;
  if v_agent.id is null then
    raise exception 'agent_not_found';
  end if;
  if v_agent.closed_at is not null then
    raise exception 'agent_closed: this agent has been closed out';
  end if;
  if tg_op = 'INSERT' and not v_agent.active then
    raise exception 'agent_inactive: cannot record entry for an inactive agent'
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    new.unit_price := v_agent.default_unit_price;
  end if;
  new.amount := new.delivered_qty::bigint * new.unit_price;

  -- Bottle-only returns only decrease held bottles and add zero debt, so
  -- deposit_limit and credit_limit apply strictly to delivery rows.
  if new.delivered_qty > 0 then
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

    -- Item 10 (M9): use not is_owner_manager() so dual-role agent+staff
    -- accounts cannot bypass credit_limit (matches 0051 payment guards).
    if auth.uid() is not null and not is_owner_manager() and v_agent.credit_limit > 0 then
      v_due := new.delivered_qty::bigint * new.unit_price - new.amount_collected;
      if tg_op = 'UPDATE' then
        v_old_due := old.delivered_qty::bigint * old.unit_price - old.amount_collected;
      end if;
      if agent_outstanding(new.agent_id) - v_old_due + v_due > v_agent.credit_limit then
        raise exception 'credit_limit: agent debt would exceed the credit limit';
      end if;
    end if;
  end if;

  return new;
end $$;

revoke all on function public.entries_before_write() from public, anon, authenticated;
