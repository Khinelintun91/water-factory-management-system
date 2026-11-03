export type Role = 'owner' | 'manager' | 'staff' | 'agent'

export interface Profile {
  id: string
  username: string
  role: Role
  agent_id: string | null
  active: boolean
}

export interface Agent {
  id: string
  code: string | null
  name: string
  address: string | null
  deposit_per_bottle: number
  default_unit_price: number
  active: boolean
  created_at: string
  updated_at: string
}

export interface DailyEntry {
  id: string
  entry_date: string
  agent_id: string
  delivered_qty: number
  returned_qty: number
  unit_price: number
  amount: number
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface AgentPayment {
  id: string
  payment_date: string
  agent_id: string
  amount: number
  method: string
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface AuditLogRow {
  id: number
  table_name: string
  row_id: string
  action: 'insert' | 'update' | 'delete'
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
  actor: string | null
  created_at: string
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'ပိုင်ရှင်',
  manager: 'မန်နေဂျာ',
  staff: 'ဝန်ထမ်း',
  agent: 'ကိုယ်စားလှယ်',
}

export function formatMMK(n: number): string {
  return `${n.toLocaleString('en-US')} ကျပ်`
}

/** Today's date (YYYY-MM-DD) in Asia/Yangon. */
export function todayYangon(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yangon' }).format(new Date())
}

/** True when an ISO timestamp falls on today's Yangon calendar day (same-day rule mirror for UI hints; the DB trigger is authoritative). */
export function isTodayYangon(iso: string): boolean {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yangon' }).format(new Date(iso))
  return d === todayYangon()
}
