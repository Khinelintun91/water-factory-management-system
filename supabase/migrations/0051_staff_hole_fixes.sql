-- 0051_staff_hole_fixes.sql — Pack 1: close the 6 proven staff money &
-- data holes in Postgres (per docs/reports/staff-account-review-2026-11-28.md
-- and SPEC.md: server-side enforcement is mandatory).
--
--   Item 1 (M2) — Remove obsolete agent_id -> NULL hard-delete cascade
--                 bypass from guard_same_day_edit() and guard_month_lock()
--                 (agents have been archive-only since 0032); attach
--                 agent_immutable triggers to agent_payments and
--                 inventory_movements (reusing 0048's guard_entry_agent_immutable).
--   Item 2 (M1+M4) — Lock immutable columns on UPDATE:
--                 * daily_entries: reject changes to unit_price, entry_date,
--                   and created_at in entries_before_write().
--                 * agent_payments: BEFORE INSERT OR UPDATE trigger enforces
--                   amount > 0; locks payment_date, created_at, source_entry_id
--                   on UPDATE; blocks direct client UPDATE on entry-linked
--                   payments (source_entry_id IS NOT NULL) while keeping
--                   edit_daily_entry() (SECURITY DEFINER) working; and blocks
--                   non-OM amount reductions that would push debt above
--                   credit_limit.
--                 * agent_payments: BEFORE DELETE trigger blocks direct client
--                   DELETE on entry-linked payments while preserving both
--                   edit_daily_entry() and ON DELETE CASCADE from daily_entries,
--                   and blocks direct non-OM DELETE of standalone payments when
--                   removing the payment would push agent_outstanding above
--                   credit_limit (OM exempt).
--   Item 3 (M6) — Reject INSERT with agent_id IS NULL on daily_entries and
--                 agent_payments (pre-existing NULL rows remain readable and
--                 do not break unrelated UPDATEs). Also reject agent_payments
--                 INSERT for closed (closed_at) or archived (archived_at) agents.
--   Item 4 (M3/D2) — Lock inventory_movements RLS (SELECT: OM or own agent;
--                 INSERT/UPDATE/DELETE: OM only) and inventory_totals() RPC
--                 to is_owner_manager().
--   Item 5 (D1) — Lock agent_detail_stats(uuid) RPC to is_owner_manager()
--                 or own agent (p_agent = app_agent_id()).

-- =========================================================================
-- Item 1 (M2): remove legacy agent_id -> NULL cascade bypass from guards
--              and enforce agent_id immutability on agent_payments &
--              inventory_movements.
-- =========================================================================

create or replace function public.guard_same_day_edit() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (old.created_at at time zone 'Asia/Yangon')::date
     <> (now() at time zone 'Asia/Yangon')::date then
    raise exception 'same_day_only: records can only be edited or deleted on the day they were created';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

revoke all on function public.guard_same_day_edit() from public, anon, authenticated;

create or replace function public.guard_month_lock() returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_date_field text := tg_argv[0];
  v_old_month date;
  v_new_month date;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old_month := date_trunc('month', (to_jsonb(old) ->> v_date_field)::date)::date;
    if exists (select 1 from month_locks where month = v_old_month) then
      raise exception 'month_locked: % is locked', v_old_month;
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new_month := date_trunc('month', (to_jsonb(new) ->> v_date_field)::date)::date;
    if exists (select 1 from month_locks where month = v_new_month) then
      raise exception 'month_locked: % is locked', v_new_month;
    end if;
    return new;
  end if;
  return old;
end $$;

revoke all on function public.guard_month_lock() from public, anon, authenticated;

-- Reuse 0048's generic guard_entry_agent_immutable() (checks
-- `new.agent_id is distinct from old.agent_id`, so pre-existing NULL rows
-- stay untouched when agent_id remains NULL, while any change — including
-- detaching to NULL — is rejected).
drop trigger if exists payments_agent_immutable on public.agent_payments;
create trigger payments_agent_immutable
  before update on public.agent_payments
  for each row execute function public.guard_entry_agent_immutable();

drop trigger if exists inventory_agent_immutable on public.inventory_movements;
create trigger inventory_agent_immutable
  before update on public.inventory_movements
  for each row execute function public.guard_entry_agent_immutable();

-- =========================================================================
-- Item 2 (M1) + Item 3 (M6): daily_entries write guard
--   - Reject INSERT with agent_id IS NULL.
--   - On UPDATE, reject changes to unit_price, entry_date, or created_at
--     (edit_daily_entry() and UI change_reason stamp never modify them).
--   - Preserve all 0049 bottle-only, deposit_limit, and credit_limit rules.
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

  -- Item 3 (M6): new entries must always reference an agent. Pre-existing
  -- historical NULL rows (if any) keep working on unrelated UPDATEs without
  -- tripping agent lookup.
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

-- =========================================================================
-- Item 2 (M4) + Item 3 (M6): agent_payments write & delete guards
--   SECURITY INVOKER so current_user distinguishes direct client writes
--   ('authenticated' / 'anon') from SECURITY DEFINER RPC edit_daily_entry()
--   and PostgreSQL ON DELETE CASCADE RI triggers (both run as table/function
--   owner, never as 'authenticated').
-- =========================================================================

create or replace function public.payments_before_write() returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_agent agents%rowtype;
begin
  -- Amount must always be strictly positive on INSERT and UPDATE.
  if new.amount is null or new.amount <= 0 then
    raise exception 'invalid_amount: payment amount must be positive'
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    if new.agent_id is null then
      raise exception 'agent_required: agent_id cannot be null on insert'
        using errcode = 'P0001';
    end if;

    select * into v_agent from agents where id = new.agent_id;
    if v_agent.id is null then
      raise exception 'agent_not_found'
        using errcode = 'P0001';
    end if;
    if v_agent.closed_at is not null then
      raise exception 'agent_closed: cannot record payment for a closed agent'
        using errcode = 'P0001';
    end if;
    if v_agent.archived_at is not null then
      raise exception 'agent_archived: cannot record payment for an archived agent'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- UPDATE guards (agent_id immutability is also enforced by
  -- payments_agent_immutable).
  if new.payment_date is distinct from old.payment_date then
    raise exception 'payment_date_immutable: payment_date cannot be changed on update'
      using errcode = 'P0001';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'created_at_immutable: created_at cannot be changed on update'
      using errcode = 'P0001';
  end if;
  if new.source_entry_id is distinct from old.source_entry_id then
    raise exception 'source_entry_immutable: source_entry_id cannot be changed on update'
      using errcode = 'P0001';
  end if;

  -- Direct client UPDATE on an entry-linked payment is forbidden; only
  -- edit_daily_entry() (SECURITY DEFINER, running as function owner) may
  -- modify linked payments.
  if old.source_entry_id is not null
     and current_user in ('authenticated', 'anon') then
    raise exception 'linked_payment_immutable: entry-linked payments can only be edited via edit_daily_entry'
      using errcode = 'P0001';
  end if;

  -- Credit-limit parity on direct non-OM amount reduction (prevents the
  -- temp-payment -> big-delivery -> shrink-temp-payment bypass).
  if current_user in ('authenticated', 'anon')
     and not is_owner_manager()
     and old.agent_id is not null
     and new.amount < old.amount then
    select * into v_agent from agents where id = old.agent_id;
    if v_agent.id is not null and v_agent.credit_limit > 0 then
      if agent_outstanding(old.agent_id) + (old.amount - new.amount) > v_agent.credit_limit then
        raise exception 'credit_limit: reducing this payment would push agent debt above the credit limit'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  return new;
end $$;

revoke all on function public.payments_before_write() from public, anon, authenticated;

drop trigger if exists payments_before_write on public.agent_payments;
create trigger payments_before_write
  before insert or update on public.agent_payments
  for each row execute function public.payments_before_write();

create or replace function public.payments_before_delete() returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_credit_limit bigint;
begin
  -- Direct client DELETE on an entry-linked payment is forbidden.
  -- Both edit_daily_entry() (SECURITY DEFINER) and ON DELETE CASCADE from
  -- daily_entries (RI trigger) execute as the owner role, not authenticated.
  if old.source_entry_id is not null
     and current_user in ('authenticated', 'anon') then
    raise exception 'linked_payment_immutable: entry-linked payments can only be deleted via their delivery entry'
      using errcode = 'P0001';
  end if;

  -- Credit-limit delete guard: a direct non-OM DELETE of a payment must be
  -- rejected if removing it would push agent_outstanding above credit_limit.
  if current_user in ('authenticated', 'anon')
     and not is_owner_manager()
     and old.agent_id is not null then
    select credit_limit into v_credit_limit
      from agents
     where id = old.agent_id;
    if coalesce(v_credit_limit, 0) > 0 then
      if agent_outstanding(old.agent_id) + old.amount > v_credit_limit then
        raise exception 'credit_limit: deleting this payment would push agent debt above the credit limit'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  return old;
end $$;

revoke all on function public.payments_before_delete() from public, anon, authenticated;

drop trigger if exists payments_before_delete on public.agent_payments;
create trigger payments_before_delete
  before delete on public.agent_payments
  for each row execute function public.payments_before_delete();

-- =========================================================================
-- Item 4 (M3/D2): lock inventory_movements RLS & inventory_totals() to OM
-- =========================================================================

drop policy if exists inventory_select on public.inventory_movements;
create policy inventory_select on public.inventory_movements for select to authenticated
  using (is_owner_manager() or agent_id = app_agent_id());

drop policy if exists inventory_insert on public.inventory_movements;
create policy inventory_insert on public.inventory_movements for insert to authenticated
  with check (is_owner_manager());

drop policy if exists inventory_update on public.inventory_movements;
create policy inventory_update on public.inventory_movements for update to authenticated
  using (is_owner_manager())
  with check (is_owner_manager());

drop policy if exists inventory_delete on public.inventory_movements;
create policy inventory_delete on public.inventory_movements for delete to authenticated
  using (is_owner_manager());

create or replace function public.inventory_totals()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_owner_manager() then
    raise exception 'inventory_totals: not allowed'
      using errcode = '42501';
  end if;

  return (
    select jsonb_build_object(
      'produced', coalesce(sum(bottles) filter (where kind = 'produce'), 0),
      'purchased', coalesce(sum(bottles) filter (where kind = 'purchase'), 0),
      'damaged', coalesce(sum(bottles) filter (where kind = 'damage'), 0),
      'adjustments', coalesce(sum(bottles) filter (where kind = 'adjust'), 0)
    )
    from public.inventory_movements
  ) || (
    select jsonb_build_object(
      'outQty', coalesce(sum(delivered_qty), 0),
      'inQty', coalesce(sum(returned_qty), 0)
    )
    from public.daily_entries
  );
end;
$$;

revoke all on function public.inventory_totals() from public, anon;
grant execute on function public.inventory_totals() to authenticated;

-- =========================================================================
-- Item 5 (D1): lock agent_detail_stats(uuid) to OM or own agent
-- =========================================================================

create or replace function public.agent_detail_stats(p_agent uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (
    public.is_owner_manager()
    or (p_agent is not null and p_agent is not distinct from public.app_agent_id())
  ) then
    raise exception 'agent_detail_stats: not allowed'
      using errcode = '42501';
  end if;

  return (
    select jsonb_build_object(
      'held', coalesce(sum(delivered_qty - returned_qty), 0),
      'sales', coalesce(sum(amount), 0),
      'collectedEntries', coalesce(sum(amount_collected), 0)
    )
    from public.daily_entries
    where agent_id = p_agent
  ) || (
    select jsonb_build_object(
      'paymentsTotal', coalesce(sum(amount), 0)
    )
    from public.agent_payments
    where agent_id = p_agent
  ) || (
    select jsonb_build_object(
      'depBottles', coalesce(sum(bottles), 0),
      'depAmount', coalesce(sum(amount), 0)
    )
    from public.agent_deposits
    where agent_id = p_agent
  );
end;
$$;

revoke all on function public.agent_detail_stats(uuid) from public, anon;
grant execute on function public.agent_detail_stats(uuid) to authenticated;
