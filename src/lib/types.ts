export type Role = 'owner' | 'co_owner' | 'manager' | 'staff' | 'agent'

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
  bottle_limit: number
  credit_limit: number
  closed_at: string | null
  closed_by: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface AgentDeposit {
  id: string
  agent_id: string | null
  agent_name: string | null
  deposit_date: string
  bottles: number
  price_per_bottle: number
  amount: number
  note: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface WriteOff {
  id: string
  agent_id: string | null
  agent_name: string | null
  writeoff_date: string
  amount: number
  note: string
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface AgentSettlement {
  id: string
  agent_id: string | null
  agent_name: string | null
  settle_date: string
  held_bottles: number
  returned_bottles: number
  missing_bottles: number
  current_price: number
  deposit_original: number
  refund_amount: number
  price_diff: number
  price_diff_kind: 'none' | 'extra_pay' | 'price_drop'
  forfeiture_income: number
  net_refund: number
  agent_owes: number
  note: string | null
  created_by: string | null
  created_at: string
}

export const PRICE_DIFF_KIND_LABELS: Record<AgentSettlement['price_diff_kind'], string> = {
  none: 'ဈေးကွာ မရှိ',
  extra_pay: 'ဈေးတက်၍ အပိုပြန်ပေး',
  price_drop: 'ဈေးကျ၍ မူလအပေါင်အပြည့် ပြန်အမ်း',
}

export interface DailyEntry {
  id: string
  entry_date: string
  agent_id: string
  agent_name: string | null
  delivered_qty: number
  returned_qty: number
  unit_price: number
  amount: number
  amount_collected: number
  change_reason: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface AgentPayment {
  id: string
  payment_date: string
  agent_id: string
  agent_name: string | null
  amount: number
  method: string
  change_reason: string | null
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
  co_owner: 'ပူးတွဲပိုင်ရှင်',
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
