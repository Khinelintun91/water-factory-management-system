-- 0010_audit_row_id_user_id.sql — audit_row_change() row_id fallback.
--
-- salary_settings (PK = user_id, no id/month/agent_id/key column) produced a
-- NULL audit row_id, which violated audit_log's NOT NULL and blocked the
-- insert entirely. Add user_id to the fallback chain.

create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row_id text;
begin
  v_row_id := coalesce((to_jsonb(coalesce(new, old)) ->> 'id'),
                       (to_jsonb(coalesce(new, old)) ->> 'month'),
                       (to_jsonb(coalesce(new, old)) ->> 'agent_id'),
                       (to_jsonb(coalesce(new, old)) ->> 'user_id'),
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
