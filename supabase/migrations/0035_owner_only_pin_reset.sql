-- 0035: only an active primary owner may set a PIN.
--
-- Owner decision 2026-11-16: co_owner, manager, staff, agent, and every
-- other non-owner cannot change a PIN, including their own. There is
-- no self-service PIN change. The Home screen does not offer one.
--
-- The allowed path is the existing admin_reset_pin (0014). This file
-- does not replace that function, so 0030 can still replace it before
-- or after this migration without losing its co_owner PIN floor. The
-- caller gate and the digit rule stay inside admin_reset_pin:
-- active primary profiles.role = 'owner', digits only, 6-12 for
-- owner/manager and 4-12 for every other primary role (0014).
--
-- auth.users.encrypted_password may change only when current_user is
-- the owner of admin_reset_pin. Inside that SECURITY DEFINER function,
-- current_user is the function owner, and the owner check plus the
-- digit rule have already run. A client session (authenticated, anon)
-- is rejected. On hosted Supabase, GoTrue's updateUser and the
-- recovery password write run as supabase_auth_admin, not as the
-- function owner, so those writes are rejected too.
--
-- What this migration cannot close from here (do not treat as done):
--   * If a host runs GoTrue as the same role that owns admin_reset_pin,
--     this trigger cannot tell updateUser apart from the RPC. Hosted
--     Supabase uses supabase_auth_admin for GoTrue and postgres /
--     supabase_admin for SQL functions. Confirm that split on the live
--     project; this repo cannot read the live role.
--   * A session that is the function owner (SQL editor as postgres)
--     can still set encrypted_password directly and skip the digit
--     rule. That is the same privilege as owning the function.
--   * INSERT of a new auth user is not blocked. Dashboard "add user"
--     and admin_create_user stay available. The first owner is created
--     that way (SETUP).
--   * Leaked-password protection and the Auth dashboard's recovery
--     toggle are hosted settings. This file does not change them.
--     Recovery's password write is an UPDATE of encrypted_password, so
--     the trigger rejects it when GoTrue is not the function owner.
--
-- The audit row records that a PIN was reset, for whom, and by whom.
-- It does not store the PIN or the password hash. audit_log stays
-- insert-only (no new update/delete policy).

create or replace function public.guard_auth_password_change()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_owner name;
begin
  if new.encrypted_password is not distinct from old.encrypted_password then
    return new;
  end if;

  select pg_get_userbyid(p.proowner) into v_owner
    from pg_proc p
   where p.oid = 'public.admin_reset_pin(uuid,text)'::regprocedure;

  if current_user is distinct from v_owner then
    raise exception 'pin_change_owner_only: only the owner can set a PIN, through admin_reset_pin'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger auth_password_owner_only
  before update of encrypted_password on auth.users
  for each row execute function public.guard_auth_password_change();

revoke all on function public.guard_auth_password_change() from public, anon, authenticated;

create or replace function public.audit_pin_reset()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
begin
  if new.encrypted_password is not distinct from old.encrypted_password then
    return new;
  end if;

  select username into v_username
    from public.profiles
   where id = new.id;

  -- Names and the event only. Never the PIN, and never the hash.
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, actor)
  values (
    'auth.users',
    new.id::text,
    'update',
    jsonb_build_object('event', 'pin_reset', 'username', v_username),
    jsonb_build_object('event', 'pin_reset', 'username', v_username),
    auth.uid()
  );
  return new;
end $$;

create trigger auth_password_audit
  after update of encrypted_password on auth.users
  for each row execute function public.audit_pin_reset();

revoke all on function public.audit_pin_reset() from public, anon, authenticated;
