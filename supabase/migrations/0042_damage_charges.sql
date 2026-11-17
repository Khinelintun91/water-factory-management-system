-- 0042_damage_charges.sql — damage charges: bottle caps (အဖုံး), dispenser
-- taps (ရေတပ်ခေါင်း) and anything else an agent breaks are charged to the
-- agent at prices the OWNER sets (owner's design, agreed 2026-11-16).
--
-- THE MODEL
--   damage_items          — ONE shared price list for the whole factory.
--                           The owner defines items (name + unit price) on
--                           a dedicated owner page; a price change there is
--                           instantly the price every agent sees. Items are
--                           DEACTIVATED, never hard-deleted (no DELETE
--                           policy exists), so old charge rows stay
--                           readable forever.
--   agent_damage_charges  — one row per charge against one agent. Each row
--                           SNAPSHOTS the item name + unit price at charge
--                           time (filled by a BEFORE INSERT trigger from
--                           the item row, never trusted from the client),
--                           so later price changes never rewrite history.
--                           total is computed by the same trigger as
--                           qty × snapshot price and stored.
--
-- MONEY: a charge is agent debt. agent_outstanding() gains
--   + coalesce(sum(agent_damage_charges.total), 0)
-- so charges settle through the ordinary paths that already read that
-- function: agent payments, the credit-limit check in
-- entries_before_write(), collections_summary()'s all-time column and
-- finalize_closeout()'s receivable_open gate. (The range-bounded report
-- and data-quality formulas in 0020/0021/0025 keep their period scope —
-- they are period views, not the outstanding balance.)
--
-- ACCESS (SPEC rule 1 + the owner's "recording is owner-only" decision)
--   damage_items:  SELECT — owner/manager see ALL rows (incl. inactive,
--                  needed to manage the list); any other authenticated
--                  user (agents, staff) sees ACTIVE rows only, enforced
--                  by the policy itself, not a client filter.
--                  INSERT/UPDATE — owner only (app_role() = 'owner').
--                  DELETE — no policy: deactivation is the only removal.
--   charges:       SELECT — owner/manager all rows; an agent only their
--                  own (agent_id = app_agent_id()).
--                  INSERT — owner only. A BEFORE INSERT trigger rejects
--                  an inactive item ('damage_item_inactive') and fills
--                  the snapshots + total.
--                  UPDATE — no policy: a charge is a ledger fact.
--                  DELETE — owner only, and the shared guards still bind
--                  it: same-day only (guard_same_day_edit) and never in
--                  a locked month (guard_month_lock) — the same-day
--                  delete + re-record is the correction path, exactly
--                  like every other business table.
--
-- NOTIFICATION: an AFTER INSERT trigger sends the agent's linked user
-- the standard 'receipt' notification naming the charge (the
-- notify_on_payment pattern from 0011/0041). Unlinked agents get none.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table damage_items (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  unit_price bigint not null check (unit_price >= 0),
  active     boolean not null default true,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table agent_damage_charges (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid not null references agents (id),
  item_id     uuid references damage_items (id) on delete restrict,
  item_name   text not null,
  unit_price  bigint not null check (unit_price >= 0),
  qty         integer not null check (qty > 0),
  total       bigint not null check (total >= 0),
  charge_date date not null default (now() at time zone 'Asia/Yangon')::date,
  note        text,
  created_by  uuid references profiles (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index damage_charges_agent_idx on agent_damage_charges (agent_id, charge_date desc);

-- ---------------------------------------------------------------------------
-- Snapshot + total (BEFORE INSERT): the item row is the only source of
-- truth for name/price; an inactive or missing item rejects the charge.
-- ---------------------------------------------------------------------------
create or replace function damage_charge_snapshot() returns trigger
language plpgsql as $$
declare
  v_name   text;
  v_price  bigint;
  v_active boolean;
begin
  if new.item_id is not null then
    select name, unit_price, active into v_name, v_price, v_active
      from damage_items where id = new.item_id;
    if not found then
      raise exception 'damage_item_not_found';
    end if;
    if not v_active then
      raise exception 'damage_item_inactive: this damage item is not active';
    end if;
    new.item_name  := v_name;
    new.unit_price := v_price;
  end if;
  new.total := new.qty::bigint * new.unit_price;
  return new;
end $$;

create trigger damage_charges_snapshot before insert on agent_damage_charges
  for each row execute function damage_charge_snapshot();

-- ---------------------------------------------------------------------------
-- Agent receipt notification (AFTER INSERT) — the notify_on_payment
-- agent-receipt pattern: linked, active agent user only, never the actor.
-- ---------------------------------------------------------------------------
create or replace function notify_on_damage_charge() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_agent_user uuid;
begin
  select id into v_agent_user from profiles
   where agent_id = new.agent_id and active and id is distinct from new.created_by
   limit 1;
  if v_agent_user is not null then
    perform insert_notification(
      v_agent_user, 'receipt', 'ပျက်စီးမှု စရိတ် မှတ်တမ်း',
      'ပျက်စီးမှု စရိတ် ' || to_char(new.total, 'FM999,999,999')
        || ' ကျပ် မှတ်တမ်းတင်ထားပါတယ် — ' || new.item_name || ' × ' || new.qty,
      '/my', 'normal', 'damage:' || new.agent_id || ':' || new.charge_date);
  end if;
  return new;
end $$;

create trigger damage_charges_notify after insert on agent_damage_charges
  for each row execute function notify_on_damage_charge();

-- ---------------------------------------------------------------------------
-- Shared triggers: attribution, updated_at, audit, guards.
-- ---------------------------------------------------------------------------
create trigger damage_items_attribution before insert on damage_items
  for each row execute function force_insert_attribution();
create trigger damage_charges_attribution before insert on agent_damage_charges
  for each row execute function force_insert_attribution();

create trigger damage_items_updated before update on damage_items
  for each row execute function set_updated_at();
create trigger damage_charges_updated before update on agent_damage_charges
  for each row execute function set_updated_at();

create trigger damage_items_audit after insert or update or delete on damage_items
  for each row execute function audit_row_change();
create trigger damage_charges_audit after insert or update or delete on agent_damage_charges
  for each row execute function audit_row_change();

create trigger damage_charges_same_day before update or delete on agent_damage_charges
  for each row execute function guard_same_day_edit();
create trigger damage_charges_month_lock before insert or update or delete on agent_damage_charges
  for each row execute function guard_month_lock('charge_date');

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table damage_items         enable row level security;
alter table agent_damage_charges enable row level security;

create policy damage_items_select on damage_items for select to authenticated
  using (is_owner_manager() or active);
create policy damage_items_insert on damage_items for insert to authenticated
  with check (app_role() = 'owner');
create policy damage_items_update on damage_items for update to authenticated
  using (app_role() = 'owner') with check (app_role() = 'owner');
-- No damage_items DELETE policy: items are deactivated, never deleted.

create policy damage_charges_select on agent_damage_charges for select to authenticated
  using (is_owner_manager() or agent_id = app_agent_id());
create policy damage_charges_insert on agent_damage_charges for insert to authenticated
  with check (app_role() = 'owner');
create policy damage_charges_delete on agent_damage_charges for delete to authenticated
  using (app_role() = 'owner');
-- No charges UPDATE policy: correct a charge by same-day delete + re-record.

-- ---------------------------------------------------------------------------
-- agent_outstanding(): the 0029 body (caller gate unchanged) plus the
-- damage-charges term. Charges are agent debt, so every existing reader
-- (payments flow, credit-limit check, collections all-time column,
-- close-out gate) picks them up with no further change.
-- ---------------------------------------------------------------------------
create or replace function agent_outstanding(p_agent uuid) returns bigint
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and not is_staff_plus()
     and app_agent_id() is distinct from p_agent then
    raise exception 'forbidden';
  end if;

  return coalesce((
           select sum(delivered_qty::bigint * unit_price - amount_collected)
           from daily_entries where agent_id = p_agent), 0)
       - coalesce((select sum(amount) from agent_payments where agent_id = p_agent), 0)
       - coalesce((select sum(amount) from write_offs    where agent_id = p_agent), 0)
       + coalesce((select sum(total)  from agent_damage_charges where agent_id = p_agent), 0);
end $$;

revoke all on function public.agent_outstanding(uuid) from public, anon;
grant execute on function public.agent_outstanding(uuid) to authenticated;
