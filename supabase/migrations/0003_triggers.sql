-- 0003_triggers.sql — Rule triggers: audit, same-day, month lock, updated_at.
-- These fire for EVERY role, Owner included (SPEC rules 4, 5, 6 — the old
-- app's silent Owner exemptions are deliberately NOT reproduced here).

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger agents_updated before update on agents
  for each row execute function set_updated_at();
create trigger contacts_updated before update on agent_contacts
  for each row execute function set_updated_at();
create trigger entries_updated before update on daily_entries
  for each row execute function set_updated_at();
create trigger payments_updated before update on agent_payments
  for each row execute function set_updated_at();
create trigger expenses_updated before update on expenses
  for each row execute function set_updated_at();
create trigger inventory_updated before update on inventory_movements
  for each row execute function set_updated_at();
create trigger disputes_updated before update on disputes
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit: full before/after images, written as definer so the insert succeeds
-- despite audit_log having no client INSERT policy (SPEC rule 5).
-- ---------------------------------------------------------------------------
create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row_id text;
begin
  v_row_id := coalesce((to_jsonb(coalesce(new, old)) ->> 'id'),
                       (to_jsonb(coalesce(new, old)) ->> 'month'),
                       (to_jsonb(coalesce(new, old)) ->> 'agent_id'));
  if tg_op = 'INSERT' then
    insert into audit_log (table_name, row_id, action, old_data, new_data, actor)
    values (tg_table_name, v_row_id, 'insert', null, to_jsonb(new), auth.uid());
    return new;
  elsif tg_op = 'UPDATE' then
    insert into audit_log (table_name, row_id, action, old_data, new_data, actor)
    values (tg_table_name, v_row_id, 'update', to_jsonb(old), to_jsonb(new), auth.uid());
    return new;
  else
    insert into audit_log (table_name, row_id, action, old_data, new_data, actor)
    values (tg_table_name, v_row_id, 'delete', to_jsonb(old), null, auth.uid());
    return old;
  end if;
end $$;

create trigger agents_audit after insert or update or delete on agents
  for each row execute function audit_row_change();
create trigger contacts_audit after insert or update or delete on agent_contacts
  for each row execute function audit_row_change();
create trigger entries_audit after insert or update or delete on daily_entries
  for each row execute function audit_row_change();
create trigger payments_audit after insert or update or delete on agent_payments
  for each row execute function audit_row_change();
create trigger expenses_audit after insert or update or delete on expenses
  for each row execute function audit_row_change();
create trigger categories_audit after insert or update or delete on expense_categories
  for each row execute function audit_row_change();
create trigger inventory_audit after insert or update or delete on inventory_movements
  for each row execute function audit_row_change();
create trigger disputes_audit after insert or update or delete on disputes
  for each row execute function audit_row_change();
create trigger locks_audit after insert or update or delete on month_locks
  for each row execute function audit_row_change();

-- ---------------------------------------------------------------------------
-- Same-day rule (SPEC rule 4): UPDATE/DELETE allowed only when the row was
-- created on the current Asia/Yangon calendar day. Applies to ALL roles.
-- ---------------------------------------------------------------------------
create or replace function guard_same_day_edit() returns trigger
language plpgsql as $$
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

create trigger entries_same_day before update or delete on daily_entries
  for each row execute function guard_same_day_edit();
create trigger payments_same_day before update or delete on agent_payments
  for each row execute function guard_same_day_edit();
create trigger expenses_same_day before update or delete on expenses
  for each row execute function guard_same_day_edit();
create trigger inventory_same_day before update or delete on inventory_movements
  for each row execute function guard_same_day_edit();

-- ---------------------------------------------------------------------------
-- Month lock (SPEC rule 6): no INSERT/UPDATE/DELETE into a locked month,
-- for ANY role. The business month comes from the row's business date.
-- ---------------------------------------------------------------------------
create or replace function guard_month_lock() returns trigger
language plpgsql as $$
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

create trigger entries_month_lock before insert or update or delete on daily_entries
  for each row execute function guard_month_lock('entry_date');
create trigger payments_month_lock before insert or update or delete on agent_payments
  for each row execute function guard_month_lock('payment_date');
create trigger expenses_month_lock before insert or update or delete on expenses
  for each row execute function guard_month_lock('expense_date');
create trigger inventory_month_lock before insert or update or delete on inventory_movements
  for each row execute function guard_month_lock('move_date');
