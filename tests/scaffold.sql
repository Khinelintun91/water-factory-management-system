-- tests/scaffold.sql — PRE-migration scaffolding for running the suite
-- against a PLAIN PostgreSQL (the embedded-postgres test rig).
--
-- It emulates only what a real Supabase project provides out of the box:
-- the API roles, the auth schema + auth.uid(), and the extensions
-- schema with pgcrypto. (pg_cron needs no stub: the embedded build
-- ships the real extension, 0012 creates it, and without
-- shared_preload_libraries its jobs are recorded but never executed —
-- exactly what a test rig wants.)
--
-- NEVER apply this file to a real Supabase project — everything here
-- already exists there and re-creating it would conflict.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema extensions;
create extension if not exists pgcrypto with schema extensions;

create schema auth;
create table auth.users (
  id uuid primary key,
  instance_id uuid,
  aud text, role text, email text, encrypted_password text,
  email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  is_super_admin boolean,
  confirmation_token text, recovery_token text, email_change text,
  email_change_token_new text, email_change_token_current text,
  phone_change text, phone_change_token text, reauthentication_token text,
  created_at timestamptz, updated_at timestamptz
);
create table auth.identities (
  id uuid primary key, user_id uuid references auth.users(id) on delete cascade,
  identity_data jsonb, provider text, provider_id text,
  last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz
);
create function auth.uid() returns uuid language plpgsql stable as $$
declare v text;
begin
  v := current_setting('request.jwt.claims', true);
  if v is null or v = '' then return null; end if;
  return (v::jsonb ->> 'sub')::uuid;
exception when others then return null;
end $$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
