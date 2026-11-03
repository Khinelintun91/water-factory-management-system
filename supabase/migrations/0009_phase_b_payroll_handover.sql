-- 0009_phase_b_payroll_handover.sql — Phase B data layer: payroll + handover.
--
-- Payroll model (exact old-app rules, phase2.functions.ts computePayroll):
-- population = active users whose effective roles include staff/manager/
-- co_owner; base = salary_settings.monthly_salary; bonus = sum of the
-- month's bonuses; each advance deducts from the first payroll month >= its
-- advance month: installment amount per month when installment > 0, else the
-- whole remaining balance; paying writes one immutable payroll_runs row plus
-- advance_repayments rows, atomically, via the pay_month RPC.
-- Month columns are 'YYYY-MM' text (old-app shape); a dedicated guard keeps
-- locked months closed for bonuses / payroll_runs / advance_repayments.

create table salary_settings (
  user_id        uuid primary key references profiles (id) on delete cascade,
  monthly_salary bigint not null default 0 check (monthly_salary >= 0),
  updated_at     timestamptz not null default now()
);

create table advances (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles (id) on delete cascade,
  advance_date date not null default (now() at time zone 'Asia/Yangon')::date,
  amount       bigint not null check (amount > 0),
  installment  bigint not null default 0 check (installment >= 0),  -- 0 = one-shot
  note         text,
  created_by   uuid references profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table bonuses (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles (id) on delete cascade,
  month      text not null check (month ~ '^\d{4}-\d{2}$'),
  amount     bigint not null check (amount > 0),
  note       text,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table payroll_runs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles (id) on delete cascade,
  month      text not null check (month ~ '^\d{4}-\d{2}$'),
  base       bigint not null,
  bonus      bigint not null,
  deduction  bigint not null,
  net        bigint not null,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  unique (user_id, month)
);

create table advance_repayments (
  id         uuid primary key default gen_random_uuid(),
  advance_id uuid not null references advances (id) on delete cascade,
  month      text not null check (month ~ '^\d{4}-\d{2}$'),
  amount     bigint not null check (amount > 0),
  created_at timestamptz not null default now()
);

create table cash_handovers (
  id            uuid primary key default gen_random_uuid(),
  handover_date date not null default (now() at time zone 'Asia/Yangon')::date,
  employee_id   uuid not null references profiles (id) on delete cascade,
  expected      bigint not null,
  received      bigint not null,
  note          text,
  received_by   uuid references profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (handover_date, employee_id)
);

alter table salary_settings    enable row level security;
alter table advances           enable row level security;
alter table bonuses            enable row level security;
alter table payroll_runs       enable row level security;
alter table advance_repayments enable row level security;
alter table cash_handovers     enable row level security;

create policy salary_select on salary_settings for select to authenticated using (is_owner_manager());
create policy salary_write  on salary_settings for insert to authenticated with check (is_owner_manager());
create policy salary_update on salary_settings for update to authenticated using (is_owner_manager()) with check (is_owner_manager());

create policy advances_select on advances for select to authenticated using (is_owner_manager());
create policy advances_write  on advances for insert to authenticated with check (is_owner_manager());
create policy advances_update on advances for update to authenticated using (is_owner_manager()) with check (is_owner_manager());
create policy advances_delete on advances for delete to authenticated using (is_owner_manager());

create policy bonuses_select on bonuses for select to authenticated using (is_owner_manager());
create policy bonuses_write  on bonuses for insert to authenticated with check (is_owner_manager());
create policy bonuses_update on bonuses for update to authenticated using (is_owner_manager()) with check (is_owner_manager());
create policy bonuses_delete on bonuses for delete to authenticated using (is_owner_manager());

create policy runs_select on payroll_runs for select to authenticated using (is_owner_manager());
-- payroll_runs rows are written by the pay_month RPC only (definer bypasses
-- RLS); no client insert/update/delete policies on purpose (immutable).

create policy repayments_select on advance_repayments for select to authenticated using (is_owner_manager());
-- advance_repayments likewise: RPC-written only.

create policy handover_select on cash_handovers for select to authenticated using (is_owner_manager());
create policy handover_write  on cash_handovers for insert to authenticated with check (is_owner_manager());
create policy handover_update on cash_handovers for update to authenticated using (is_owner_manager()) with check (is_owner_manager());
create policy handover_delete on cash_handovers for delete to authenticated using (is_owner_manager());

create index advances_user_idx   on advances (user_id, advance_date);
create index bonuses_user_month  on bonuses (user_id, month);
create index runs_user_month     on payroll_runs (user_id, month);
create index repayments_adv_idx  on advance_repayments (advance_id);
create index handover_date_idx   on cash_handovers (handover_date desc);

-- Month lock for 'YYYY-MM' text-month tables.
create or replace function guard_month_lock_text() returns trigger
language plpgsql as $$
declare
  v_field text := tg_argv[0];
  v_month date;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_month := ((to_jsonb(old) ->> v_field) || '-01')::date;
    if exists (select 1 from month_locks where month = v_month) then
      raise exception 'month_locked: % is locked', to_char(v_month, 'YYYY-MM');
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_month := ((to_jsonb(new) ->> v_field) || '-01')::date;
    if exists (select 1 from month_locks where month = v_month) then
      raise exception 'month_locked: % is locked', to_char(v_month, 'YYYY-MM');
    end if;
    return new;
  end if;
  return old;
end $$;

create trigger bonuses_month_lock before insert or update or delete on bonuses
  for each row execute function guard_month_lock_text('month');
create trigger runs_month_lock before insert or update or delete on payroll_runs
  for each row execute function guard_month_lock_text('month');
create trigger repayments_month_lock before insert or update or delete on advance_repayments
  for each row execute function guard_month_lock_text('month');
create trigger advances_month_lock before insert or update or delete on advances
  for each row execute function guard_month_lock('advance_date');
create trigger handovers_month_lock before insert or update or delete on cash_handovers
  for each row execute function guard_month_lock('handover_date');

-- Attribution / updated_at / audit.
create trigger advances_attribution before insert on advances
  for each row execute function force_insert_attribution();
create trigger bonuses_attribution before insert on bonuses
  for each row execute function force_insert_attribution();
create trigger handovers_attribution before insert on cash_handovers
  for each row execute function force_insert_attribution();

create trigger advances_updated before update on advances
  for each row execute function set_updated_at();
create trigger bonuses_updated before update on bonuses
  for each row execute function set_updated_at();
create trigger salary_updated before update on salary_settings
  for each row execute function set_updated_at();
create trigger handovers_updated before update on cash_handovers
  for each row execute function set_updated_at();

create trigger salary_audit after insert or update or delete on salary_settings
  for each row execute function audit_row_change();
create trigger advances_audit after insert or update or delete on advances
  for each row execute function audit_row_change();
create trigger bonuses_audit after insert or update or delete on bonuses
  for each row execute function audit_row_change();
create trigger runs_audit after insert or update or delete on payroll_runs
  for each row execute function audit_row_change();
create trigger repayments_audit after insert or update or delete on advance_repayments
  for each row execute function audit_row_change();
create trigger handovers_audit after insert or update or delete on cash_handovers
  for each row execute function audit_row_change();

-- Pay a month's salary for one user (atomic: run + repayments).
create or replace function pay_month(p_user uuid, p_month text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_base      bigint := 0;
  v_bonus     bigint := 0;
  v_deduction bigint := 0;
  v_run       payroll_runs%rowtype;
  r           record;
  v_paid      bigint;
  v_remaining bigint;
begin
  if not is_owner_manager() then
    raise exception 'forbidden: owner/manager only';
  end if;
  if exists (select 1 from month_locks where month = (p_month || '-01')::date) then
    raise exception 'month_locked: % is locked', p_month;
  end if;
  if exists (select 1 from payroll_runs where user_id = p_user and month = p_month) then
    raise exception 'already_paid: ဒီလအတွက် ပေးပြီးသားပါ';
  end if;

  select coalesce(monthly_salary, 0) into v_base
    from salary_settings where user_id = p_user;
  v_base := coalesce(v_base, 0);
  select coalesce(sum(amount), 0) into v_bonus
    from bonuses where user_id = p_user and month = p_month;

  -- Pass 1: compute the deduction (old-app plan rules).
  for r in select * from advances where user_id = p_user order by advance_date, created_at loop
    select coalesce(sum(amount), 0) into v_paid
      from advance_repayments where advance_id = r.id and month <> p_month;
    v_remaining := r.amount - v_paid;
    if v_remaining <= 0 then continue; end if;
    if to_char(r.advance_date, 'YYYY-MM') > p_month then continue; end if;
    v_deduction := v_deduction
      + case when r.installment > 0 then least(r.installment, v_remaining)
             else v_remaining end;
  end loop;

  insert into payroll_runs (user_id, month, base, bonus, deduction, net, created_by)
  values (p_user, p_month, v_base, v_bonus, v_deduction,
          v_base + v_bonus - v_deduction, auth.uid())
  returning * into v_run;

  -- Pass 2: write the repayment rows with the same deterministic plan.
  for r in select * from advances where user_id = p_user order by advance_date, created_at loop
    select coalesce(sum(amount), 0) into v_paid
      from advance_repayments where advance_id = r.id and month <> p_month;
    v_remaining := r.amount - v_paid;
    if v_remaining <= 0 then continue; end if;
    if to_char(r.advance_date, 'YYYY-MM') > p_month then continue; end if;
    insert into advance_repayments (advance_id, month, amount)
    values (r.id, p_month,
            case when r.installment > 0 then least(r.installment, v_remaining)
                 else v_remaining end);
  end loop;

  return to_jsonb(v_run);
end $$;
grant execute on function pay_month(uuid, text) to authenticated;
