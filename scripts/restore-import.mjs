#!/usr/bin/env node
/**
 * restore-import.mjs — load a backup file produced by src/lib/backup.ts
 * (exportBackup) into a Postgres database whose schema has ALREADY been
 * created from supabase/apply_all.sql (migrations 0001–0025).
 *
 * Prerequisite: the `pg` package. It is deliberately NOT a runtime
 * dependency of the app; install it ad hoc where you run the restore:
 *     npm install --no-save pg
 *
 * Usage:
 *     DATABASE_URL=postgres://user:pass@host:5432/db \
 *       node scripts/restore-import.mjs <backup-file.json>
 *
 * What it does, in one transaction:
 *   1. Validates the file header (app + version 1).
 *   2. Creates STUB auth.users rows for every profile (profiles.id is an
 *      FK to auth.users.id). Auth itself is NOT restored: passwords/PINs
 *      live in Supabase Auth and are never in the backup file. On a real
 *      Supabase project you recreate the Auth users afterwards (or before,
 *      with the SAME ids, via the 0014 SQL recipe) and delete the stubs —
 *      see docs/RESTORE-RUNBOOK.md. Stub emails are
 *      <username>@waterfactory.local, encrypted_password is NULL, so a
 *      stub can never be used to sign in.
 *   3. Sets session_replication_role = replica for the load. This is
 *      required, not a shortcut: agents <-> profiles reference each other
 *      (a true FK cycle), and the audit triggers must not fire while
 *      importing (they would write a fresh audit row for every restored
 *      row and corrupt the restored audit_log). FK integrity is verified
 *      explicitly in step 5 instead.
 *   4. Truncates the target tables, then inserts in FK-safe order,
 *      preserving original ids. Truncation is required: migrations seed
 *      some tables themselves (expense_categories by name, app_settings
 *      by key), so a plain insert collides on a fresh schema. That makes
 *      this tool strictly a FRESH-TARGET restore: never point it at a
 *      database that holds data you want to keep.
 *   5. Verifies: per-table row counts equal the file's row counts, and
 *      orphan checks pass for every foreign-key pair in the schema.
 *   6. Resets the bigint identity sequences (audit_log, login_logs) to
 *      max(id) so new rows do not collide with restored ones.
 *
 * dq_seen is not part of the backup format; it is internal dedupe state
 * for data-quality alerts and is intentionally not restored (alerts may
 * re-send once after a restore — harmless).
 *
 * If any check fails the transaction is rolled back: the target stays
 * empty rather than half-restored.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'

const file = process.argv[2]
if (!file || !process.env.DATABASE_URL) {
  console.error('Usage: DATABASE_URL=... node scripts/restore-import.mjs <backup-file.json>')
  process.exit(2)
}

const payload = JSON.parse(readFileSync(file, 'utf8'))
if (payload.app !== 'water-factory-management-system' || payload.version !== 1) {
  console.error(`Not a recognised backup file (app=${payload.app}, version=${payload.version})`)
  process.exit(2)
}

// FK-safe order (agents <-> profiles is a cycle, broken by replica mode).
const ORDER = [
  'expense_categories', 'agents', 'agent_contacts', 'profiles', 'user_roles',
  'salary_settings', 'notify_prefs', 'push_tokens', 'app_settings',
  'month_locks', 'daily_entries', 'agent_payments', 'expenses',
  'inventory_movements', 'disputes', 'agent_deposits', 'write_offs',
  'agent_settlements', 'advances', 'bonuses', 'payroll_runs',
  'advance_repayments', 'cash_handovers', 'notifications', 'login_logs',
  'pin_attempts', 'audit_log',
]

// [child, fk column, parent] orphan checks, from the live FK map.
const ORPHAN_CHECKS = [
  ['advance_repayments', 'advance_id', 'advances'],
  ['advances', 'user_id', 'profiles'],
  ['agent_contacts', 'agent_id', 'agents'],
  ['agent_deposits', 'agent_id', 'agents'],
  ['agent_payments', 'agent_id', 'agents'],
  ['agent_settlements', 'agent_id', 'agents'],
  ['bonuses', 'user_id', 'profiles'],
  ['cash_handovers', 'employee_id', 'profiles'],
  ['daily_entries', 'agent_id', 'agents'],
  ['disputes', 'agent_id', 'agents'],
  ['expenses', 'category_id', 'expense_categories'],
  ['inventory_movements', 'agent_id', 'agents'],
  ['notifications', 'user_id', 'profiles'],
  ['notify_prefs', 'user_id', 'profiles'],
  ['profiles', 'agent_id', 'agents'],
  ['push_tokens', 'profile_id', 'profiles'],
  ['salary_settings', 'user_id', 'profiles'],
  ['user_roles', 'profile_id', 'profiles'],
  ['write_offs', 'agent_id', 'agents'],
]

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
const t0 = Date.now()
try {
  await client.query('begin')
  await client.query(`set local session_replication_role = 'replica'`)

  // json/jsonb columns need every value JSON-encoded (a plain string
  // stored as a JSON string, e.g. app_settings.value, is not valid JSON
  // syntax on its own and Postgres rejects it unquoted).
  const { rows: jsonCols } = await client.query(
    `select table_name, column_name from information_schema.columns
     where table_schema='public' and data_type in ('json','jsonb')`,
  )
  const JSON_COLS = new Set(jsonCols.map((r) => `${r.table_name}.${r.column_name}`))

  const profiles = payload.tables.profiles ?? []
  for (const p of profiles) {
    await client.query(
      `insert into auth.users (id, aud, role, email) values ($1,'authenticated','authenticated',$2)
       on conflict (id) do nothing`,
      [p.id, `${p.username}@waterfactory.local`],
    )
  }
  console.log(`auth stubs: ${profiles.length} (PINs are NOT restored — see runbook)`)

  const present = ORDER.filter((t) => payload.tables[t])
  await client.query(
    `truncate ${present.map((t) => `public."${t}"`).join(', ')} cascade`,
  )
  console.log(`truncated ${present.length} fresh-schema tables (migration seeds replaced by backup rows)`)

  const counts = {}
  for (const table of ORDER) {
    const rows = payload.tables[table]
    if (!rows) { console.log(`skip ${table}: not in backup file`); continue }
    if (rows.length === 0) { counts[table] = 0; continue }
    const cols = Object.keys(rows[0])
    const BATCH = 200
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH)
      const params = []
      const tuples = batch.map((row, ri) => {
        const ph = cols.map((c, ci) => {
          let v = row[c]
          if (v !== null && (typeof v === 'object' || JSON_COLS.has(`${table}.${c}`))) {
            v = JSON.stringify(v)
          }
          params.push(v)
          return `$${ri * cols.length + ci + 1}`
        })
        return `(${ph.join(',')})`
      })
      await client.query(
        // OVERRIDING SYSTEM VALUE: audit_log/login_logs use GENERATED
        // ALWAYS identity ids, which reject explicit values otherwise.
        `insert into public."${table}" (${cols.map((c) => `"${c}"`).join(',')}) overriding system value values ${tuples.join(',')}`,
        params,
      )
    }
    counts[table] = rows.length
    console.log(`loaded ${table}: ${rows.length}`)
  }

  // Verify counts against the live tables.
  for (const [table, expected] of Object.entries(counts)) {
    const { rows } = await client.query(`select count(*)::bigint as n from public."${table}"`)
    if (Number(rows[0].n) !== expected) {
      throw new Error(`count mismatch ${table}: db=${rows[0].n} file=${expected}`)
    }
  }
  console.log('row-count verification: all match')

  // Orphan checks (FKs were off during the load — prove integrity now).
  for (const [child, col, parent] of ORPHAN_CHECKS) {
    const { rows } = await client.query(
      `select count(*)::bigint as n from public."${child}" c
       where c."${col}" is not null and not exists (select 1 from public."${parent}" p where p.id = c."${col}")`,
    )
    if (Number(rows[0].n) !== 0) throw new Error(`orphans found: ${child}.${col} -> ${parent}: ${rows[0].n}`)
  }
  console.log(`orphan checks: ${ORPHAN_CHECKS.length}/${ORPHAN_CHECKS.length} FK pairs clean`)

  for (const table of ['audit_log', 'login_logs']) {
    await client.query(
      `select setval(pg_get_serial_sequence('public.${table}', 'id'),
                     coalesce((select max(id) from public.${table}), 0) + 1, false)`,
    )
  }
  console.log('identity sequences reset for audit_log, login_logs')

  await client.query('commit')
  console.log(`RESTORE COMPLETE in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
} catch (e) {
  await client.query('rollback')
  console.error(`RESTORE FAILED, rolled back: ${e.message}`)
  process.exitCode = 1
} finally {
  await client.end()
}
