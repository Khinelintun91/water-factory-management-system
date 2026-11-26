-- 0049_bottle_only_collection.sql — Support bottle-only collection trips
-- (delivered_qty = 0, returned_qty > 0, zero money) enforced in Postgres.
--
--   1. entries_before_write():
--        * Enforces the row invariant: delivered_qty > 0 OR returned_qty > 0
--          (both zero is rejected on INSERT and UPDATE).
--        * Enforces entry-type immutability on UPDATE: a bottle-only row
--          (delivered_qty = 0) cannot be turned into a delivery row
--          (delivered_qty > 0), and a delivery row cannot be turned into a
--          bottle-only row (wrong type = delete and re-enter, matching
--          0048's agent-immutable spirit).
--        * Enforces zero money on bottle-only rows: amount = 0 and
--          amount_collected = 0 (any non-zero amount_collected is rejected).
--        * Bottle-only rows only reduce held bottles and add zero debt, so
--          deposit_limit and credit_limit checks apply only to delivery rows
--          (staff must never be blocked from collecting empties from an
--          already-over-limit agent).
--   2. payments_guard_source_entry (BEFORE INSERT OR UPDATE on agent_payments):
--        * Rejects linking any agent_payments row (source_entry_id) to a
--          bottle-only daily_entries row (delivered_qty = 0).
--   3. edit_daily_entry(...):
--        * Bottle-only rows may be edited for returned_qty (> 0), receiver,
--          and notes only; delivered_qty must stay 0 and total cash must
--          stay 0. Delivery rows keep 0048's exact behaviour and reject
--          switching to delivered_qty = 0.
--   4. notify_on_entry():
--        * Bottle-only rows (delivered_qty = 0) emit dedicated Burmese
--          notices naming the returned bottle count and receiver with NO
--          money, and skip the credit-limit red-flag check entirely.
--        * Delivery rows (delivered_qty > 0) stay byte-identical to 0044.

-- 1) entries_before_write: invariant, type immutability, zero-money guard,
--    and delivery-only deposit/credit cap enforcement.
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
  -- Row invariant: a visit must record either delivered bottles or returned
  -- empties (both zero is invalid).
  if coalesce(new.delivered_qty, 0) <= 0 and coalesce(new.returned_qty, 0) <= 0 then
    raise exception 'invalid_entry_qty: delivered_qty or returned_qty must be positive'
      using errcode = 'P0001';
  end if;

  -- Entry type is fixed at creation (delivery vs bottle-only).
  if tg_op = 'UPDATE' then
    if old.delivered_qty = 0 and new.delivered_qty > 0 then
      raise exception 'entry_type_immutable: bottle-only entry cannot be changed to a delivery'
        using errcode = 'P0001';
    end if;
    if old.delivered_qty > 0 and new.delivered_qty = 0 then
      raise exception 'entry_type_immutable: delivery entry cannot be changed to bottle-only'
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

    if app_role() = 'staff' and v_agent.credit_limit > 0 then
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

-- 2) Block linking any agent_payments row to a bottle-only daily_entries row.
create or replace function public.guard_payment_source_entry() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivered integer;
begin
  if new.source_entry_id is not null then
    select delivered_qty into v_delivered
      from daily_entries
     where id = new.source_entry_id;
    if v_delivered is not null and v_delivered = 0 then
      raise exception 'bottle_only_no_cash: linked payments cannot be created for a bottle-only entry'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

revoke all on function public.guard_payment_source_entry() from public, anon, authenticated;

drop trigger if exists payments_guard_source_entry on agent_payments;
create trigger payments_guard_source_entry
  before insert or update on agent_payments
  for each row execute function public.guard_payment_source_entry();

-- 3) edit_daily_entry: allow same-day editing of bottle-only rows
--    (returned_qty, received_by, notes only) and forbid type switching.
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
  v_uid             uuid := auth.uid();
  v_entry           daily_entries%rowtype;
  v_entry_month     date;
  v_reason          text := btrim(coalesce(p_change_reason, ''));
  v_receiver        uuid;
  v_new_amount      bigint;
  v_to_today        bigint;
  v_to_old          bigint := 0;
  v_advance         bigint := 0;
  v_outstanding_now bigint := 0;
  v_linked_sum      bigint := 0;
  v_base            bigint := 0;
  v_resulting_bal   bigint := 0;
  v_old_debt_sum    bigint := 0;
  v_old_reg_sum     bigint := 0;
  v_old_linked_cnt  integer := 0;
  v_need_rewrite    boolean := false;
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

  v_receiver := coalesce(p_received_by, v_entry.received_by, v_entry.created_by);
  if v_receiver is not null and not exists (select 1 from profiles where id = v_receiver) then
    raise exception 'user_not_found'
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
           received_by      = v_receiver,
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
         received_by      = v_receiver,
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

-- 4) notify_on_entry: dedicated bottle-only wording with no money and no
--    credit-limit red-flag; delivery rows stay byte-identical to 0044.
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
  v_body       text;
begin
  select coalesce(nullif(trim(p.display_name), ''), p.username) into v_receiver
    from profiles p
   where p.id = coalesce(new.received_by, new.created_by);

  -- Bottle-only collection (delivered_qty = 0): dedicated notice naming
  -- returned bottles and receiver, no money, no credit-limit red-flag.
  if new.delivered_qty = 0 then
    for v_recip in select om_recipients(new.created_by) loop
      perform insert_notification(
        v_recip, 'delivery', 'ဗူးခွံပြန်ယူ မှတ်တမ်း',
        coalesce(new.agent_name, '') || ' — ' || new.returned_qty || ' ဗူး ပြန်ယူ'
          || case when v_receiver is not null
                  then ' · လက်ခံသူ: ' || v_receiver else '' end,
        '/entries', 'normal',
        'bottle_return:' || new.agent_id || ':' || new.entry_date);
    end loop;

    select id into v_agent_user from profiles
     where agent_id = new.agent_id and active and id is distinct from new.created_by
     limit 1;
    if v_agent_user is not null then
      v_body := new.entry_date::text || ' — ' || new.returned_qty || ' ဗူး ပြန်အပ်ပြီး'
        || case when v_receiver is not null
                then ' (' || v_receiver || ' လက်ခံ)' else '' end;
      perform insert_notification(
        v_agent_user, 'receipt', 'ဗူးခွံပြန်အပ် မှတ်တမ်း', v_body,
        '/my', 'normal',
        'bottle_return:' || new.agent_id || ':' || new.entry_date);
    end if;
    return new;
  end if;

  -- Delivery row (delivered_qty > 0): byte-identical to migration 0044.
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
        || case when v_receiver is not null
                then ' · လက်ခံသူ: ' || v_receiver else '' end,
      '/entries', v_priority,
      'delivery:' || new.agent_id || ':' || new.entry_date);
  end loop;

  select id into v_agent_user from profiles
   where agent_id = new.agent_id and active and id is distinct from new.created_by
   limit 1;
  if v_agent_user is not null then
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

revoke all on function public.notify_on_entry() from public, anon, authenticated;
