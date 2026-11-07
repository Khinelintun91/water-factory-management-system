# RESTORE RUNBOOK — rebuilding the system from a backup file

Proven end-to-end on **2026-11-06** (the first successful restore drill):
live Supabase project → backup file in the app's own export format →
fresh schema from `supabase/apply_all.sql` → `scripts/restore-import.mjs` →
counts, money totals, RLS and guard triggers all verified equal.

Recovery contract (SPEC): *latest data export + repo migrations must be
enough to rebuild the whole system.* This runbook is that procedure.
**Auth is the one deliberate exception:** PINs/password hashes live in
Supabase Auth and are never in the backup file; accounts are recreated
(step 5) and PINs are re-issued by the Owner.

---

## 0. What you need

- The latest backup file (`backup-YYYY-MM-DD.json`, exported from the
  app's Owner home → Download backup, or produced by SQL in the same
  format: `{app, version: 1, exported_at, tables: {…}}`).
- This repo (schema = `supabase/apply_all.sql`, migrations 0001–0030).
- A target: a **fresh** Supabase project (preferred) or any PostgreSQL 15+
  (the drill used a local PostgreSQL 17 — notes in §7).
- Node.js with the `pg` package available where you run the importer:
  `npm install --no-save pg` (deliberately not an app dependency).

## 1. Create the target project

Supabase: create a new free project (any region near Myanmar), wait until
it is ACTIVE_HEALTHY. Do **not** restore over the live project.

> Drill note: creating a project through the Management API with the
> existing project-scoped access token returns **403 Forbidden** — the
> token can only see/manage the one project it was issued for. Project
> creation is a dashboard step for the Owner (or a token with org scope).

## 2. Build the schema

In the new project's SQL Editor, paste the whole of
`supabase/apply_all.sql` once and Run. It applies migrations 0001–0030 in
order (payroll, notifications, pg_cron job registrations included).

Drill result: applied cleanly, first try, on PostgreSQL 17.

## 3. Import the backup data

```
DATABASE_URL=postgres://<user>:<password>@<host>:5432/<db> \
  node scripts/restore-import.mjs backup-YYYY-MM-DD.json
```

What the importer does (single transaction — any failure rolls back to
an empty target, never a half-restore):

1. Validates the file header.
2. Creates **stub** `auth.users` rows for every profile (see §5).
3. Loads with FK checks deferred internally — required because
   `agents ↔ profiles` reference each other, and because the audit
   triggers must not fire while importing (they would write a new audit
   row for every restored row).
4. **Truncates the target tables first.** Migrations seed some tables
   themselves (`expense_categories`, `app_settings`); a plain insert
   collides with those seeds. Consequence: only ever point this tool at
   a **fresh** target.
5. Verifies per-table row counts equal the file, then runs orphan checks
   over the FK pairs (19 pairs) — integrity is proven after the load,
   not assumed.
6. Resets the `audit_log` / `login_logs` identity sequences.

Known data notes:

- `dq_seen` (1 row live at drill time) is **not** in the backup format —
  it is data-quality alert dedupe state. After a restore, one round of
  DQ alerts may re-send. Harmless; accepted.
- `notifications`, `notify_prefs`, `push_tokens` restore only what the
  exporting Owner could see under RLS (the backup format's own limit).

## 4. Verify the restore (do not skip)

Run these against the restored database and compare with the pre-restore
snapshot (take one before any disaster/recovery work, and keep the
export-day snapshot with the backup file):

```sql
-- Row counts (spot set; do all business tables in a real recovery)
select 'daily_entries', count(*) from daily_entries
union all select 'agent_payments', count(*) from agent_payments
union all select 'expenses', count(*) from expenses
union all select 'audit_log', count(*) from audit_log;

-- Money totals — must equal the snapshot exactly
select (select sum(amount) from daily_entries)          as entries_amount,
       (select sum(amount_collected) from daily_entries) as entries_cash,
       (select sum(amount) from agent_payments)          as payments_amount,
       (select sum(amount) from expenses)                as expenses_amount;
```

Guard/RLS spot-checks (each inside a transaction you roll back):

- As an agent (simulate with `set role authenticated` +
  `request.jwt.claims` = that agent's profile id): the agent sees only
  their own `daily_entries` and exactly 1 `agent_contacts` row.
- As staff: `agent_contacts` returns **0** rows (SPEC rule 2).
- Insert an entry dated inside a locked month **as Owner**: rejected
  with `month_locked` (the lock binds the Owner too — SPEC rule 6).
- Update an expense created on an earlier day: rejected with
  `same_day_only` (SPEC rule 4). Same for deleting an old payment.
  (Pick test rows in an *unlocked* month, or the month-lock fires first
  and masks the same-day guard; pick rows that don't trip the bottle
  limit for the same reason.)

Drill results 2026-11-06: 27/27 restored tables matched the live
snapshot (12,423 entries; 1,027 payments; 404 expenses; 25,040 audit
rows; 12 agents; 9 profiles), all four money totals matched to the kyat
(entries 136,815,070 / cash 101,744,410; payments 32,937,500; expenses
25,477,000), and every RLS/trigger check above passed with the expected
error messages.

## 5. Recreate the Auth accounts (PINs are re-issued, never restored)

The backup's `profiles` table is the account list. For each profile you
need: **username · role · agent link (for agent logins) · display name**.
(The drill snapshot's list: 1 owner + seed/staff/agent accounts — in a
real recovery, list the profiles from the restored DB:
`select username, role, agent_id from profiles order by role, username`.)

Two routes:

- **In-app (preferred once one Owner exists):** recreate the Owner first
  via the SQL recipe below, sign in, then create the rest from the Users
  page (it calls the `admin_create_user` RPC from migration 0014, revised
  by 0030 so a primary `co_owner` is accepted and uses the manager PIN
  minimum of 6 digits. The Owner chooses that initial PIN).
- **SQL recipe (bootstrap / bulk):** migration 0014's function inserts
  into `auth.users` + `auth.identities` with the bcrypt recipe and the
  empty-string token columns — copy that pattern exactly (NULL token
  columns make GoTrue fail with “Database error querying schema”).

To preserve the original profile ids (so restored rows keep pointing at
the right accounts), create each Auth user **with the same id** as its
profile row, then delete the importer's stub row for that id first.
PIN values are chosen by the Owner at recreation time and are never
written down in this runbook or the repo.

After recreating: every user signs in once; the Owner re-checks the
Users page list against the profiles list, then deletes any leftover
stub emails (`auth.users` rows created by the importer have
`encrypted_password IS NULL` — they cannot sign in, but remove them
anyway once the real accounts exist).

## 6. Point the app at the restored project

Update the hosting env vars (`VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`) to the new project, redeploy, sign in
as Owner, and run one full day-workflow smoke test (entry → collection →
expense → backup export) before telling staff to use it.

## 7. Local-target notes (only if restoring to plain PostgreSQL)

A real Supabase project already provides: the `auth` schema,
`auth.uid()`, the `anon` / `authenticated` / `service_role` roles, DML
grants on public tables (RLS does the filtering), usage on the `auth`
schema, an `extensions` schema with pgcrypto, and pg_cron. A plain
PostgreSQL has none of these — the drill created minimal stand-ins
(stub `auth.users`/`auth.identities` tables, a JWT-claims `auth.uid()`,
role grants after the schema load, and a records-only `cron` stub whose
job rows register but never execute). These are drill scaffolding, not
part of the product schema; never apply them to a Supabase project.

## 8. Problems the first drill found (already fixed in the importer)

1. Migration-seeded tables collided with backup rows → importer now
   truncates fresh targets before loading (§3.4).
2. JSON-string values in `jsonb` columns (e.g. `app_settings.value`)
   were rejected unquoted → importer JSON-encodes all values bound for
   json/jsonb columns.
3. `GENERATED ALWAYS` identity ids (`audit_log`, `login_logs`) rejected
   explicit values → importer inserts with `OVERRIDING SYSTEM VALUE`
   and resets the sequences afterwards.

## 9. Timings observed in the 2026-11-06 drill (for planning, not promises)

- Live snapshot (counts + totals, 28 tables): under a minute of queries.
- Producing the backup file by SQL pagination via the Management API:
  ~3.5 minutes for 41k rows / a 29.7 MB file (the in-app export is the
  normal route; SQL was used so the drill did not depend on a browser).
- Schema apply (`apply_all.sql`): seconds.
- Import with verification: ~2 seconds for the full file locally.
- Verification queries: seconds each; the RLS/trigger spot-checks took
  the longest in wall-clock terms because two first attempts were
  rejected by *other* guards (bottle limit, insert-date) before the
  intended guards could be isolated — see §4's test-row advice.

**Re-run this drill:** after any migration that adds a table, after any
change to `src/lib/backup.ts`, and at least quarterly. An untested
backup is not a backup.
