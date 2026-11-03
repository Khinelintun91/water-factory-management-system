-- 0004_insert_date_guard.sql — New records must be dated today.
--
-- QA finding 2026-11-03: the same-day guard (0003) covered UPDATE/DELETE
-- only, so a client could INSERT a record backdated to any unlocked past
-- day — silently rewriting history that was never visible on its own day.
-- This guard closes that hole for every role, Owner included: the date
-- column of a newly inserted record must equal the current Asia/Yangon
-- calendar day. (Reversible by dropping these four triggers if the
-- business ever wants next-morning backfill instead.)

create or replace function guard_insert_today() returns trigger
language plpgsql as $$
declare
  v_date date;
begin
  v_date := (to_jsonb(new) ->> tg_argv[0])::date;
  if v_date is distinct from (now() at time zone 'Asia/Yangon')::date then
    raise exception 'same_day_only: % must be today (Asia/Yangon)', tg_argv[0]
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger entries_insert_today before insert on daily_entries
  for each row execute function guard_insert_today('entry_date');
create trigger payments_insert_today before insert on agent_payments
  for each row execute function guard_insert_today('payment_date');
create trigger expenses_insert_today before insert on expenses
  for each row execute function guard_insert_today('expense_date');
create trigger inventory_insert_today before insert on inventory_movements
  for each row execute function guard_insert_today('move_date');
