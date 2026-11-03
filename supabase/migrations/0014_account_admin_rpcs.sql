-- 0014: Owner-only account administration via security-definer RPCs.
--
-- Why RPCs instead of an Edge Function: creating a Supabase Auth user needs
-- privileged access. The Edge Function route (supabase/functions/
-- admin-create-user) could not be deployed from the build environment, so
-- the same logic lives here as database functions — versioned with the
-- schema, covered by the backup/recovery contract, and callable from the
-- app through PostgREST. Both functions re-check the caller is an active
-- Owner inside the function body; execute is granted to `authenticated`
-- only, and the internal check is the real gate.
--
-- The auth.users insert follows the verified recipe for SQL-created users:
-- bcrypt password via pgcrypto crypt(), ALL token columns as empty strings
-- (NULLs make GoTrue fail with "Database error querying schema"), plus a
-- matching auth.identities row (provider 'email').

create or replace function public.admin_create_user(
  p_username text,
  p_pin text,
  p_role text,
  p_agent_id uuid default null,
  p_display_name text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_caller uuid := auth.uid();
  v_username text := lower(trim(p_username));
  v_id uuid := gen_random_uuid();
  v_email text;
  v_min_pin int;
  v_display text := nullif(trim(coalesce(p_display_name, '')), '');
begin
  if v_caller is null or not exists (
    select 1 from public.profiles
    where id = v_caller and role = 'owner' and active
  ) then
    raise exception 'owner_only';
  end if;

  if v_username !~ '^[a-z0-9_.-]{3,32}$' then
    raise exception 'invalid_username';
  end if;
  if p_role not in ('owner', 'manager', 'staff', 'agent') then
    raise exception 'invalid_role';
  end if;
  v_min_pin := case when p_role in ('owner', 'manager') then 6 else 4 end;
  if p_pin !~ '^\d+$' or length(p_pin) < v_min_pin or length(p_pin) > 12 then
    raise exception 'pin_must_be_%_to_12_digits', v_min_pin;
  end if;
  if p_role = 'agent' then
    if p_agent_id is null then
      raise exception 'agent_id_required';
    end if;
    if not exists (select 1 from public.agents where id = p_agent_id) then
      raise exception 'agent_not_found';
    end if;
  end if;
  if exists (select 1 from public.profiles where username = v_username)
     or exists (select 1 from auth.users where email = v_username || '@waterfactory.local') then
    raise exception 'username_taken';
  end if;

  v_email := v_username || '@waterfactory.local';

  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, is_super_admin,
    confirmation_token, recovery_token, email_change, email_change_token_new,
    email_change_token_current, phone_change, phone_change_token,
    reauthentication_token, created_at, updated_at
  ) values (
    v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    v_email, extensions.crypt(p_pin, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('username', v_username, 'role', p_role),
    false, '', '', '', '', '', '', '', '', now(), now()
  );

  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  values (
    gen_random_uuid(), v_id,
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
    'email', v_id::text, now(), now(), now()
  );

  insert into public.profiles (id, username, role, agent_id, display_name, active)
  values (v_id, v_username, p_role::public.user_role,
          case when p_role = 'agent' then p_agent_id else null end,
          v_display, true);

  return (select to_jsonb(p) from public.profiles p where p.id = v_id);
end;
$$;

create or replace function public.admin_reset_pin(
  p_user_id uuid,
  p_new_pin text
) returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_caller uuid := auth.uid();
  v_role text;
  v_username text;
  v_min_pin int;
begin
  if v_caller is null or not exists (
    select 1 from public.profiles
    where id = v_caller and role = 'owner' and active
  ) then
    raise exception 'owner_only';
  end if;

  select role, username into v_role, v_username
  from public.profiles where id = p_user_id;
  if v_role is null then
    raise exception 'user_not_found';
  end if;

  v_min_pin := case when v_role in ('owner', 'manager') then 6 else 4 end;
  if p_new_pin !~ '^\d+$' or length(p_new_pin) < v_min_pin or length(p_new_pin) > 12 then
    raise exception 'pin_must_be_%_to_12_digits', v_min_pin;
  end if;

  update auth.users
  set encrypted_password = extensions.crypt(p_new_pin, extensions.gen_salt('bf')),
      updated_at = now()
  where id = p_user_id;

  -- A reset also frees the account from a login lockout.
  delete from public.pin_attempts where username = v_username;
end;
$$;

revoke all on function public.admin_create_user(text, text, text, uuid, text) from public, anon;
revoke all on function public.admin_reset_pin(uuid, text) from public, anon;
grant execute on function public.admin_create_user(text, text, text, uuid, text) to authenticated;
grant execute on function public.admin_reset_pin(uuid, text) to authenticated;
