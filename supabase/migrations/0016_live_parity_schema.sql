-- 0016_live_parity_schema.sql — Live-parity gap wave (schema only).
-- * agents.trip_qty (တစ်ခါပို့ ဘူးအရေအတွက် — bottles per trip) + agents.notes.
-- * agent_payments.kind: 'regular' vs 'old_debt' (ကြွေးဟောင်းကောက်ငွေ entries
--   are a separate form in the old app; the rebuild tags them instead).
-- * notify_prefs: per-topic alert toggles (old app settings had 4 toggles).
-- * app_settings is key/value (0001), so debt_alert_days is a new KEY,
--   not a column: the debt-age threshold (days) for aging alerts.
-- * inventory_movements: 'adjust' must be an allowed kind — 0006 already
--   extended the check, so the block below only rebuilds it if missing.

alter table public.agents
  add column if not exists trip_qty integer not null default 0;
alter table public.agents
  add column if not exists notes text;

alter table public.agent_payments
  add column if not exists kind text not null default 'regular';
do $$ begin
  alter table public.agent_payments
    add constraint agent_payments_kind_check
    check (kind in ('regular', 'old_debt'));
exception when duplicate_object then null; end $$;

alter table public.notify_prefs
  add column if not exists alert_old_debt   boolean not null default true;
alter table public.notify_prefs
  add column if not exists alert_digest     boolean not null default true;
alter table public.notify_prefs
  add column if not exists alert_stock      boolean not null default true;
alter table public.notify_prefs
  add column if not exists alert_collection boolean not null default true;

insert into public.app_settings (key, value)
values ('debt_alert_days', '30'::jsonb)
on conflict (key) do nothing;

do $$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.inventory_movements'::regclass
     and conname = 'inventory_movements_kind_check';
  if v_def is null or position('adjust' in v_def) = 0 then
    alter table public.inventory_movements
      drop constraint if exists inventory_movements_kind_check;
    alter table public.inventory_movements
      add constraint inventory_movements_kind_check
      check (kind in ('produce', 'purchase', 'damage', 'in', 'out', 'adjust'));
  end if;
end $$;
