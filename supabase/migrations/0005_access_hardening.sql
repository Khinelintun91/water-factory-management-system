-- 0005_access_hardening.sql — Fixes from the 2026-11-03 code review.
--
-- C1: deactivated accounts (profiles.active = false) kept full data access
--     because the RLS helpers never looked at `active`. The helpers now
--     return NULL for inactive profiles, so every policy fails closed.
-- H3: created_at / created_by were client-settable on INSERT, which made
--     the same-day rule forgeable. A BEFORE INSERT trigger now forces
--     both columns to server values on the money-bearing tables.
-- M1: agents could UPDATE their own disputes without column limits and
--     forge status/reply/replied_by. Dispute updates are now
--     owner/manager only (agents raise and read; management responds).
-- M3: profiles and app_settings changes were not audited. They now are,
--     and the audit row_id also understands app_settings' `key` column.

-- C1 ---------------------------------------------------------------------
create or replace function app_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
$$;

create or replace function app_agent_id() returns uuid
language sql stable security definer set search_path = public as $$
  select agent_id from profiles where id = auth.uid() and active
$$;

-- H3 ---------------------------------------------------------------------
create or replace function force_insert_attribution() returns trigger
language plpgsql as $$
begin
  new := jsonb_populate_record(new, jsonb_build_object(
    'created_at', now(),
    'created_by', auth.uid()
  ));
  return new;
end $$;

create trigger entries_attribution before insert on daily_entries
  for each row execute function force_insert_attribution();
create trigger payments_attribution before insert on agent_payments
  for each row execute function force_insert_attribution();
create trigger expenses_attribution before insert on expenses
  for each row execute function force_insert_attribution();
create trigger inventory_attribution before insert on inventory_movements
  for each row execute function force_insert_attribution();

-- M1 ---------------------------------------------------------------------
drop policy disputes_update on disputes;
create policy disputes_update on disputes for update to authenticated
  using (is_owner_manager()) with check (is_owner_manager());

-- M3 ---------------------------------------------------------------------
create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row_id text;
begin
  v_row_id := coalesce((to_jsonb(coalesce(new, old)) ->> 'id'),
                       (to_jsonb(coalesce(new, old)) ->> 'month'),
                       (to_jsonb(coalesce(new, old)) ->> 'agent_id'),
                       (to_jsonb(coalesce(new, old)) ->> 'key'));
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

create trigger profiles_audit after insert or update or delete on profiles
  for each row execute function audit_row_change();
create trigger settings_audit after insert or update or delete on app_settings
  for each row execute function audit_row_change();
