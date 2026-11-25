-- 0048_edit_entries_expenses.sql — Server-side support for the same-day
-- edit forms across daily_entries, agent_payments and expenses:
--
--   1. expenses.change_reason: matches daily_entries and agent_payments
--      (0006) so same-day edits and deletes on expenses carry an audit
--      reason in audit_log (old_data / new_data).
--   2. entries_agent_immutable: BEFORE UPDATE trigger on daily_entries
--      that rejects any change to agent_id (owner rule 2026-11-24: an
--      entry's agent cannot be changed when editing; delete and re-enter
--      if the wrong agent was chosen).
--   3. edit_daily_entry(...): atomic SECURITY DEFINER RPC that updates
--      a delivery entry AND reconciles its source_entry_id-linked
--      agent_payments (0047) in a single transaction, enforcing EVERY
--      server-side rule directly in the database:
--        * authenticated + active staff-plus (is_staff_plus())
--        * Rule A (0045): owner/manager/co_owner may edit any row;
--          non-OM staff may edit ONLY rows they created
--          (created_by = auth.uid()), even when named as received_by
--        * Same-day guard (SPEC rule 4, 0003): ALL roles, Owner included
--        * Month lock (SPEC rule 6, 0003): ALL roles, Owner included
--        * Agent immutability + unit_price snapshot preserved
--        * Deposit limit & staff credit limit (entries_before_write,
--          evaluated against the already-updated linked payments so the
--          final balance is exact)
--        * Immutable audit_log (entries_audit + payments_audit fire as
--          usual with actor = auth.uid())
--      This also fixes the cross-role linked-payment RLS edge case where
--      OM editing a staff member's entry created linked payments with
--      created_by = OM that the staff member could not delete on a later
--      same-day edit of their own entry.

-- 1) expenses.change_reason
alter table expenses add column if not exists change_reason text;

-- 2) Immutable agent_id on daily_entries UPDATE
create or replace function public.guard_entry_agent_immutable() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.agent_id is distinct from old.agent_id then
    raise exception 'agent_immutable: agent cannot be changed when editing an entry'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

revoke all on function public.guard_entry_agent_immutable() from public, anon, authenticated;

drop trigger if exists entries_agent_immutable on daily_entries;
create trigger entries_agent_immutable
  before update on daily_entries
  for each row execute function public.guard_entry_agent_immutable();

-- 3) Atomic same-day delivery-entry edit with cash reallocation
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

  -- Input validation.
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
  if char_length(v_reason) < 2 then
    raise exception 'change_reason_required: change reason must be at least 2 characters'
      using errcode = 'P0001';
  end if;

  v_receiver := coalesce(p_received_by, v_entry.received_by, v_entry.created_by);
  if v_receiver is not null and not exists (select 1 from profiles where id = v_receiver) then
    raise exception 'user_not_found'
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

    -- Reconcile linked payments BEFORE updating daily_entries so
    -- entries_before_write's credit_limit check sees the exact final
    -- balance. Any trigger failure on daily_entries rolls back the
    -- entire transaction atomically.
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
