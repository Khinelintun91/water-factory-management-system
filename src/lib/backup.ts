import { supabase } from './supabase'
import { todayYangon } from './types'

/**
 * Owner-only full backup export (SPEC: Backups and data safety).
 * Reads every business table through the owner's RLS access and downloads
 * one JSON file. The owner stores 2 copies in 2 places (phone + Drive).
 * Rhythm: weekly minimum. `last_backup_at` is stamped in app_settings so
 * the home screen can warn when a backup is overdue.
 *
 * Tables are fetched with .range() pagination: PostgREST caps a single
 * response at 1,000 rows, and a silently truncated backup would be worse
 * than no backup. Ordering uses each table's unique key so pages are
 * stable. `audit_log` is included: it is the before-image store the SPEC
 * relies on for restoring mistakes. Auth accounts (PINs live in Supabase
 * Auth) are NOT in this file and must be recreated after a restore.
 */
const BACKUP_TABLES: { table: string; orderBy: string }[] = [
  { table: 'agents', orderBy: 'id' },
  { table: 'agent_contacts', orderBy: 'agent_id' },
  { table: 'daily_entries', orderBy: 'id' },
  { table: 'agent_payments', orderBy: 'id' },
  { table: 'expenses', orderBy: 'id' },
  { table: 'expense_categories', orderBy: 'id' },
  { table: 'inventory_movements', orderBy: 'id' },
  { table: 'disputes', orderBy: 'id' },
  { table: 'month_locks', orderBy: 'month' },
  { table: 'profiles', orderBy: 'id' },
  { table: 'app_settings', orderBy: 'key' },
  { table: 'login_logs', orderBy: 'id' },
  { table: 'audit_log', orderBy: 'id' },
]

const PAGE_SIZE = 1000

async function fetchAllRows(table: string, orderBy: string): Promise<unknown[]> {
  const rows: unknown[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return rows
}

export interface BackupFile {
  app: string
  version: 1
  exported_at: string
  tables: Record<string, unknown[]>
}

export async function exportBackup(): Promise<{ filename: string; rowCounts: Record<string, number> }> {
  const tables: Record<string, unknown[]> = {}
  const rowCounts: Record<string, number> = {}

  for (const { table, orderBy } of BACKUP_TABLES) {
    const rows = await fetchAllRows(table, orderBy)
    tables[table] = rows
    rowCounts[table] = rows.length
  }

  const payload: BackupFile = {
    app: 'water-factory-management-system',
    version: 1,
    exported_at: new Date().toISOString(),
    tables,
  }

  // SPEC file naming uses the Yangon calendar date, not UTC.
  const filename = `backup-${todayYangon()}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)

  // Stamp the backup time. `value` is jsonb: pass the raw ISO string so it
  // is stored as a plain JSON string (an extra JSON.stringify here would
  // double-encode it and break the overdue check). A failed stamp must
  // surface, not pass silently.
  const { error: stampError } = await supabase
    .from('app_settings')
    .update({ value: payload.exported_at, updated_at: new Date().toISOString() })
    .eq('key', 'last_backup_at')
  if (stampError) throw new Error(`last_backup_at: ${stampError.message}`)

  return { filename, rowCounts }
}

export async function getLastBackupAt(): Promise<string | null> {
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'last_backup_at')
    .maybeSingle()
  const v = (data as { value: unknown } | null)?.value
  if (typeof v !== 'string') return null
  // Tolerate values double-encoded by an older build (a JSON string
  // containing a quoted ISO string).
  if (v.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v)
      return typeof parsed === 'string' ? parsed : v
    } catch {
      return v
    }
  }
  return v
}

/** Backup is overdue when none exists or the last one is 7+ days old. */
export function isBackupOverdue(lastBackupAt: string | null): boolean {
  if (!lastBackupAt) return true
  const ageMs = Date.now() - new Date(lastBackupAt).getTime()
  return ageMs >= 7 * 24 * 60 * 60 * 1000
}
