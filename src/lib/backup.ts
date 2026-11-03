import { supabase } from './supabase'

/**
 * Owner-only full backup export (SPEC: Backups and data safety).
 * Reads every business table through the owner's RLS access and downloads
 * one JSON file. The owner stores 2 copies in 2 places (phone + Drive).
 * Rhythm: weekly minimum. `last_backup_at` is stamped in app_settings so
 * the home screen can warn when a backup is overdue.
 */
const BACKUP_TABLES = [
  'agents',
  'agent_contacts',
  'daily_entries',
  'agent_payments',
  'expenses',
  'expense_categories',
  'inventory_movements',
  'disputes',
  'month_locks',
  'profiles',
] as const

export interface BackupFile {
  app: string
  version: 1
  exported_at: string
  tables: Record<string, unknown[]>
}

export async function exportBackup(): Promise<{ filename: string; rowCounts: Record<string, number> }> {
  const tables: Record<string, unknown[]> = {}
  const rowCounts: Record<string, number> = {}

  for (const table of BACKUP_TABLES) {
    const { data, error } = await supabase.from(table).select('*')
    if (error) throw new Error(`${table}: ${error.message}`)
    tables[table] = data ?? []
    rowCounts[table] = (data ?? []).length
  }

  const payload: BackupFile = {
    app: 'water-factory-management-system',
    version: 1,
    exported_at: new Date().toISOString(),
    tables,
  }

  const date = payload.exported_at.slice(0, 10)
  const filename = `backup-${date}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)

  await supabase
    .from('app_settings')
    .update({ value: JSON.stringify(payload.exported_at), updated_at: new Date().toISOString() })
    .eq('key', 'last_backup_at')

  return { filename, rowCounts }
}

export async function getLastBackupAt(): Promise<string | null> {
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'last_backup_at')
    .maybeSingle()
  const v = (data as { value: unknown } | null)?.value
  return typeof v === 'string' ? v : null
}

/** Backup is overdue when none exists or the last one is 7+ days old. */
export function isBackupOverdue(lastBackupAt: string | null): boolean {
  if (!lastBackupAt) return true
  const ageMs = Date.now() - new Date(lastBackupAt).getTime()
  return ageMs >= 7 * 24 * 60 * 60 * 1000
}
