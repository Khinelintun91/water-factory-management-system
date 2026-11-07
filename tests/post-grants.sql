-- tests/post-grants.sql — POST-migration grants for the plain-Postgres
-- test rig. A real Supabase project gives the API roles DML grants on
-- public tables by default and lets RLS do the filtering; plain
-- PostgreSQL does not, so the rig grants them here (AFTER apply_all.sql
-- has created the tables). Test scaffolding only — never apply to a
-- real Supabase project.
grant select, insert, update, delete on all tables in schema public
  to anon, authenticated, service_role;
grant usage, select on all sequences in schema public
  to anon, authenticated, service_role;
-- Deliberately NO blanket EXECUTE grant on functions: the migrations'
-- own grant/revoke statements (0026/0028/0029 in particular) are part
-- of what this suite verifies — re-granting everything here would
-- silently undo them on the rig.
