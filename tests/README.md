# Test suite

Permanent regression tests for the money and access rules in SPEC.md.
The SQL suite is the core: it builds a **fresh** database from
`supabase/apply_all.sql`, loads a deterministic fixture, and asserts
the database-level behaviour that the app relies on — so a future
migration or RPC edit that weakens a guard fails loudly here instead
of silently in production.

## Run it

```bash
tests/run-sql-tests.sh
```

The runner imports the `pg` package from this repo's devDependencies
(`npm ci`). If that package is missing it falls back to
`~/workspace/restore-drill/node_modules/pg`, then exits with an error.

Embedded PostgreSQL (only when that drill rig is installed):

```bash
tests/run-sql-tests.sh
```

Override the rig location with `WF_DRILL_DIR` / `WF_PG_BIN_DIR`.

Isolated Postgres 17 with the real `pg_cron` extension preloaded
(`shared_preload_libraries=pg_cron`). pg_cron 1.6 allows
`CREATE EXTENSION` only in the database named by `cron.database_name`,
so the suite migrates that database in place and does not drop it.
Point this only at a throwaway server — Supabase hosts are refused
before any connection:

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
  WF_SQL_IN_PLACE=1 \
  tests/run-sql-tests.sh
```

`DATABASE_URL` without `WF_SQL_IN_PLACE` still creates and drops a side
database named `wf_suite_<random>`. That side database cannot load
`pg_cron`.

Exit code is 0 only when every file passes. Each `tests/sql/*.sql`
file prints its own PASS/FAIL line.

## What is covered

| File | Asserts |
|---|---|
| `01_same_day_guard.sql` | SPEC rule 4 on the 0003 tables **and** the 0027 tables (write-offs, deposits, advances, handovers), as the Owner; today-created rows still editable |
| `02_month_lock.sql` | SPEC rule 6 binds the Owner too; the 0018 backdate exception does not override a lock |
| `03_insert_today.sql` | Backdated inserts rejected for staff **and** manager, allowed for the primary Owner |
| `04_agent_isolation.sql` | SPEC rules 1–2: agents see only their own rows; staff see **zero** phone numbers; manager sees all |
| `05_login_gateway.sql` | 0026: no direct `login_logs` inserts; raw `record_login_failure` not callable; 5 fails lock, 6th call does not extend the lock |
| `06_last_owner_guard.sql` | 0026: the final active owner cannot be deactivated / re-roled / deleted at DB level |
| `07_agent_outstanding_gate.sql` | 0029: agent asking for another agent → `forbidden`; own/staff/owner reads keep exact pre-0029 values; anon has no grant |
| `08_payroll_golden.sql` | `pay_month`: 320,000 net flat case; the 2026-11-03 QA case 300,000 + 20,000 − 30,000 = 290,000 with repayment rows; double-pay rejected |
| `09_closeout_golden.sql` | `finalize_closeout` on a fixture agent: refund 10,000, no price diff, agent closed, second run rejected |
| `10_api_gap_fixes.sql` | 0032–0038: archive instead of delete, money-setting month lock + audit, settlement insert closed, owner-only PIN reset, login lockout abuse brake, pinned search_path, definer grants |
| `14_admin_create_co_owner.sql` | `0030`: owner creates `co_owner` with a 6-digit PIN; 5-digit and 13-digit PINs rejected; `employee` and `primary_agent` rejected; owner/manager stay at 6 and staff at 4; co-owner, manager, staff, and anon cannot create accounts |
| `15_agent_close_columns.sql` | `0031`: direct set, clear, and change of `closed_at` / `closed_by` rejected for owner, manager, a forged GUC, and the session owner; finalize still succeeds once; AgentsPage fields still update |
| `16_notifications_realtime.sql` | `0043`: `public.notifications` is a member of the `supabase_realtime` publication after apply_all (the migration creates the publication on plain PostgreSQL, where the platform object is missing); re-running the 0043 block leaves exactly one membership row |
| `17_om_notify_receiver_name.sql` | `0044`: OM delivery/collection notices name the receiver (`လက်ခံသူ: …`, display_name of `coalesce(received_by, created_by)`); `received_by` wins over the typist; NULL falls back to `created_by`; agent receipts byte-identical to 0041 |
| `18_edit_own_rows_only.sql` | `0045` Rule A: staff B's update/delete on staff A's same-day entry, payment and expense each affect 0 rows; staff edit/delete their OWN entries/payments; expenses keep OM-only SELECT (no read widening), so staff stay fully blocked there while the own-row clause waits in the update/delete policies; manager/owner edit anyone's; the same-day guard still refuses a yesterday row for the owner; agents still write nothing |
| `19_staff_own_visibility.sql` | `0046` staff own-visibility (variant 2): staff B sees 0 of staff A's plain entries/payments but DOES see the rows naming B as `received_by`, plus their own; staff A sees their created rows, not B's; unattributed fixture rows are invisible to staff; manager sees everything; agent A's and agent B's visible sets are exactly the old-policy sets (`agent_id = app_agent_id()`), unchanged |
| `20_entry_payment_link.sql` | `0047` entry↔payment link: a payment planted with `source_entry_id` = its entry is deleted by the FK cascade when the entry is deleted (audit before-images exist for BOTH rows); a standalone payment (NULL link) survives both entry deletes; `agent_outstanding` tracks each step (2950 → 1150 → 850 against the 1350 fixture baseline) |
| `21_edit_entries_expenses.sql` | `0048` same-day edit support: `expenses.change_reason` + audit + same-day + month-lock; `entries_agent_immutable` rejects changing `daily_entries.agent_id` even for Owner; atomic `edit_daily_entry` enforces Rule A (including blocking `received_by`-only staff, agents, and inactive accounts), same-day guard, month-lock, input validation, exact cash reallocation, cross-role OM→staff linked-payment reconciliation, in-place receiver update without payment re-insert churn, and atomic rollback on `credit_limit` |
| `22_bottle_only_collection.sql` | `0049` bottle-only collection trips: bottle-only insert (`delivered_qty = 0`, `returned_qty > 0`, zero money) succeeds; both-zero insert rejected; non-zero cash or linked `agent_payments` on a bottle-only row rejected at DB level; same-day bottle-only edit works; type-switch edits rejected both ways (via `edit_daily_entry` and direct `UPDATE`); dedicated bottle-only OM and agent notification wording with no money and no credit-limit red-flag alert even when over limit |
| `23_same_day_detection.sql` | `0050` Package A same-day detection: `send_daily_digest()` includes linked + standalone `agent_payments` in today's cash, matches `sum(agent_outstanding())` incl. damage charges & write-offs, uses `ကျသင့်ငွေ`/`ဗူး`, delivers to `mode = 'important'` OM recipients (only `alert_digest = false` skips), includes per-receiver totals / standalone payments / edits & deletes / handover mismatches (omitted when none); `run_data_quality_alerts()` runs at both 08:30 and 18:30 Yangon (`wfms-data-quality-evening`), flags same-day duplicate pairs (≤15 min), negative held bottles, and `delivered_qty > 2000` without double-alerting |

## How it works

- `scaffold.sql` + `post-grants.sql` emulate, for plain PostgreSQL
  only, what a Supabase project provides natively (API roles,
  `auth.uid()`, the `extensions` schema with pgcrypto, default table
  grants). They do **not** stub `pg_cron`: migration 0012 runs
  `create extension pg_cron` and `cron.schedule`, which needs the real
  extension installed and listed in `shared_preload_libraries`. The
  suite asserts those schedules can be registered. It does not wait
  for the daily jobs to fire.
  **Never apply them to a real Supabase project.**
- `fixture.sql` uses fixed UUIDs; historical rows are loaded with
  triggers disabled (`session_replication_role = 'replica'`) because
  the date guards would — correctly — refuse to create them.
- Every scenario in the test files runs inside `begin … rollback`
  with role simulation (`set local role` + `request.jwt.claims`),
  exactly like the manual drills. Side-effect and visibility counts
  are always read **while the role is active** or after `reset role`
  inside the same transaction — never after commit/rollback.

## CI

`.github/workflows/ci.yml` runs `npm test` and `npm run build` on Node
22.23.4, and runs this SQL suite against a throwaway `postgres:17`
service container after installing `postgresql-17-cron` into that
container (`WF_SQL_IN_PLACE=1`). Workflow permission is `contents: read`
only. The workflow does not deploy and does not connect to Supabase.

## Unit tests (client logic)

```bash
npm test
```

Vitest, `tests/unit/`: the offline entry queue (FIFO order, corrupt
storage, network-vs-rule error classification) and the backup-overdue
rule (none / <7 days / ≥7 days). Config is `vitest.config.ts` at the
repo root; it injects dummy Supabase env values so module imports do
not throw — the tests themselves touch no network and no database.

## Adding a test

Drop another `NN_name.sql` into `tests/sql/` (it runs in filename
order, on its own connection, after the fixture). Use the
`testkit.assert_true` / `testkit.assert_error` helpers (defined once
in `tests/helpers.sql`, applied by the runner — do NOT redefine them
with `pg_temp`: temp functions created at the top of a file sent as
one query string are rolled back with the first scenario block), and
wrap every scenario in `begin … rollback`.
