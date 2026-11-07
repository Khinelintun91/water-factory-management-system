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

That uses the embedded-PostgreSQL rig in `~/workspace/restore-drill`
(override with `WF_DRILL_DIR` / `WF_PG_BIN_DIR`). To run against your
own PostgreSQL 15+ server instead:

```bash
DATABASE_URL=postgres://user:pass@host:5432/postgres tests/run-sql-tests.sh
```

(a throwaway database is created and dropped on that server).

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

## How it works

- `scaffold.sql` + `post-grants.sql` emulate, for plain PostgreSQL
  only, what a Supabase project provides natively (API roles,
  `auth.uid()`, a records-only `cron` stub, default table grants).
  **Never apply them to a real Supabase project.**
- `fixture.sql` uses fixed UUIDs; historical rows are loaded with
  triggers disabled (`session_replication_role = 'replica'`) because
  the date guards would — correctly — refuse to create them.
- Every scenario in the test files runs inside `begin … rollback`
  with role simulation (`set local role` + `request.jwt.claims`),
  exactly like the manual drills. Side-effect and visibility counts
  are always read **while the role is active** or after `reset role`
  inside the same transaction — never after commit/rollback.

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
