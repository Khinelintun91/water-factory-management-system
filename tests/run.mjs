// tests/run.mjs — SQL test-suite runner (see tests/README.md).
//
// Builds a FRESH database from supabase/apply_all.sql on a scratch
// PostgreSQL, loads tests/fixture.sql, then runs every tests/sql/*.sql
// file in filename order on its own connection, printing PASS/FAIL per
// file. Exit code is non-zero when anything fails.
//
// Database sources, in priority order:
//   1. DATABASE_URL + WF_SQL_IN_PLACE=1 — migrate the named database on
//      that server and do not drop it. Required for pg_cron 1.6, which
//      can be created only in cron.database_name. Point this only at a
//      throwaway server. Hosts under supabase.co / supabase.com are
//      refused before any connection.
//   2. DATABASE_URL — connect to that server, create (and drop) a
//      throwaway database wf_suite_<random> on it. This mode cannot
//      CREATE EXTENSION pg_cron (wrong database for the worker).
//   3. The embedded-postgres rig in ~/workspace/restore-drill (override
//      with WF_DRILL_DIR / WF_PG_BIN_DIR): initdb + postgres are run in
//      a throwaway temp dir; when this process runs as root, the
//      binaries are wrapped in `unshare --user --map-user=65534
//      --map-group=65534` (postgres refuses to run as root; the drill
//      rig has always used this nobody-mapping trick).
//
// The `pg` module is a repo devDependency. If it is missing, the runner
// falls back to the drill rig's node_modules, then exits with an error.

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const DRILL = process.env.WF_DRILL_DIR || join(homedir(), 'workspace', 'restore-drill')

let pg
try {
  pg = (await import('pg')).default
} catch (first) {
  try {
    pg = (await import(pathToFileURL(join(DRILL, 'node_modules', 'pg', 'lib', 'index.js')).href)).default
  } catch {
    console.error('FAIL: node module `pg` is not installed. From the repo root run `npm ci` (`pg` is a devDependency).')
    console.error('Fallback also missing: ' + join(DRILL, 'node_modules', 'pg'))
    console.error(first instanceof Error ? first.message : String(first))
    process.exit(2)
  }
}

function databaseUrlOrExit(raw) {
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    console.error('FAIL: DATABASE_URL is not a valid URL')
    process.exit(2)
  }
  const host = parsed.hostname.toLowerCase()
  if (
    host === 'supabase.co' || host.endsWith('.supabase.co') ||
    host === 'supabase.com' || host.endsWith('.supabase.com')
  ) {
    console.error(`FAIL: refusing DATABASE_URL host ${host} — SQL tests use an isolated throwaway Postgres only, never a Supabase project`)
    process.exit(2)
  }
  return parsed
}

const read = (p) => readFileSync(p, 'utf8')
const asNobody = process.getuid && process.getuid() === 0
  ? ['unshare', '--user', '--map-user=65534', '--map-group=65534']
  : []
function runSync(cmd, args, opts = {}) {
  const [c, a] = asNobody.length ? ['unshare', [...asNobody.slice(1), cmd, ...args]] : [cmd, args]
  return execFileSync(c, a, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

let cleanup = async () => {}
let admin // pg client connected to a maintenance database
let testDbName

if (process.env.DATABASE_URL) {
  const base = databaseUrlOrExit(process.env.DATABASE_URL)
  if (process.env.WF_SQL_IN_PLACE === '1') {
    const dbName = decodeURIComponent(base.pathname.replace(/^\//, ''))
    if (!dbName) {
      console.error('FAIL: WF_SQL_IN_PLACE=1 requires DATABASE_URL to name a database (pg_cron can be created only in cron.database_name)')
      process.exit(2)
    }
    testDbName = dbName
    process.env._WF_TEST_URL = base.toString()
    console.log(`SQL target: in-place throwaway ${base.hostname}:${base.port || '5432'}/${dbName} (database is not dropped)`)
    cleanup = async () => {}
  } else {
    testDbName = 'wf_suite_' + Math.random().toString(36).slice(2, 10)
    const adminUrl = new URL(base); adminUrl.pathname = '/postgres'
    admin = new pg.Client(adminUrl.toString())
    await admin.connect()
    await admin.query(`create database ${testDbName}`)
    const testUrl = new URL(base); testUrl.pathname = '/' + testDbName
    process.env._WF_TEST_URL = testUrl.toString()
    cleanup = async () => { await admin.query(`drop database if exists ${testDbName}`); await admin.end() }
  }
} else {
  const binDir = process.env.WF_PG_BIN_DIR ||
    join(DRILL, 'node_modules', '@embedded-postgres', 'linux-x64', 'native', 'bin')
  const work = mkdtempSync(join(tmpdir(), 'wf-tests-'))
  const data = join(work, 'data'), sock = join(work, 'sock')
  mkdirSync(sock)
  const port = 54400 + Math.floor(Math.random() * 400)
  runSync(join(binDir, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'],
    { stdio: 'ignore' })
  const child = (() => {
    const [c, a] = asNobody.length
      ? ['unshare', [...asNobody.slice(1), join(binDir, 'postgres'), '-D', data, '-p', String(port), '-k', sock, '-h', '127.0.0.1']]
      : [join(binDir, 'postgres'), ['-D', data, '-p', String(port), '-k', sock, '-h', '127.0.0.1']]
    return spawn(c, a, { stdio: 'ignore', detached: true })
  })()
  child.unref()
  testDbName = 'postgres'
  process.env._WF_TEST_URL = `postgres://postgres@127.0.0.1:${port}/postgres`
  cleanup = async () => {
    try { runSync(join(binDir, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' }) } catch {}
    rmSync(work, { recursive: true, force: true })
  }
  // Wait until the server accepts connections (fresh client per
  // attempt — a node-pg client cannot retry a failed connect()).
  let up = false
  for (let i = 0; i < 75 && !up; i++) {
    const probe = new pg.Client(process.env._WF_TEST_URL)
    try { await probe.connect(); await probe.end(); up = true }
    catch { await probe.end().catch(() => {}); await new Promise(r => setTimeout(r, 200)) }
  }
  if (!up) { console.error('FAIL: scratch postgres did not start'); await cleanup(); process.exit(2) }
}

const url = process.env._WF_TEST_URL
async function runFile(label, path) {
  const client = new pg.Client(url)
  await client.connect()
  try {
    const res = await client.query(read(path))
    const last = Array.isArray(res) ? res[res.length - 1] : res
    const note = last && last.rows && last.rows[0] ? Object.values(last.rows[0])[0] : ''
    console.log(`PASS ${label}${note ? ' — ' + note : ''}`)
    return true
  } catch (e) {
    console.log(`FAIL ${label} — ${e.message.split('\n')[0]}`)
    return false
  } finally {
    await client.end().catch(() => {})
  }
}

let ok = true
try {
  if (process.env.WF_SQL_IN_PLACE === '1') {
    const probe = new pg.Client(url)
    await probe.connect()
    try {
      const ver = await probe.query('show server_version')
      const preload = await probe.query('show shared_preload_libraries')
      const avail = await probe.query("select default_version from pg_available_extensions where name = 'pg_cron'")
      const libs = String(preload.rows[0].shared_preload_libraries)
      console.log(`server_version=${ver.rows[0].server_version}`)
      console.log(`shared_preload_libraries=${libs}`)
      const loaded = libs.split(',').map((s) => s.trim()).includes('pg_cron')
      if (avail.rowCount === 0) {
        console.error('FAIL: pg_cron is not installed on this Postgres')
        ok = false
      } else if (!loaded) {
        console.error('FAIL: pg_cron is not in shared_preload_libraries, so CREATE EXTENSION pg_cron cannot succeed')
        ok = false
      } else {
        console.log(`pg_cron available ${avail.rows[0].default_version}`)
      }
    } finally {
      await probe.end().catch(() => {})
    }
  }
  if (ok) {
    for (const [label, path] of [
      ['setup:scaffold', join(HERE, 'scaffold.sql')],
      ['setup:apply_all', join(REPO, 'supabase', 'apply_all.sql')],
      ['setup:post-grants', join(HERE, 'post-grants.sql')],
      ['setup:fixture', join(HERE, 'fixture.sql')],
      ['setup:helpers', join(HERE, 'helpers.sql')],
    ]) {
      if (!await runFile(label, path)) { ok = false; break }
    }
  }
  if (ok) {
    const files = readdirSync(join(HERE, 'sql')).filter(f => f.endsWith('.sql')).sort()
    for (const f of files) {
      if (!await runFile('sql/' + f, join(HERE, 'sql', f))) ok = false
    }
  }
} finally {
  await cleanup()
}
console.log(ok ? 'SUITE RESULT: ALL PASS' : 'SUITE RESULT: FAILURES PRESENT')
process.exit(ok ? 0 : 1)
