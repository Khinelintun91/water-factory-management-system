import { getLang } from './i18n'

export type Role = 'owner' | 'co_owner' | 'manager' | 'staff' | 'agent'

export interface Profile {
  id: string
  username: string
  /** Free-text display name (Burmese welcome); login username stays Latin. */
  display_name?: string | null
  role: Role
  agent_id: string | null
  active: boolean
}

/** Person's display name when set (trimmed, non-empty), else their login username. */
export function personName(p: { display_name?: string | null; username: string }): string {
  const d = p.display_name?.trim()
  return d ? d : p.username
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

export interface SalarySetting {
  user_id: string
  monthly_salary: number
  updated_at: string
}

export interface Advance {
  id: string
  user_id: string
  advance_date: string
  amount: number
  /** 0 = one-shot deduction; > 0 = fixed amount deducted per month. */
  installment: number
  note: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface Bonus {
  id: string
  user_id: string
  /** 'YYYY-MM' */
  month: string
  amount: number
  note: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface PayrollRun {
  id: string
  user_id: string
  /** 'YYYY-MM' */
  month: string
  base: number
  bonus: number
  deduction: number
  net: number
  created_by: string | null
  created_at: string
}

export interface AdvanceRepayment {
  id: string
  advance_id: string
  /** 'YYYY-MM' — the payroll month the repayment was deducted in. */
  month: string
  amount: number
  created_at: string
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

/** Burmese daypart word for a Yangon hour (mirrors NotificationBell). */
function daypartMy(hour: number): string {
  if (hour < 5) return 'ည'
  if (hour < 12) return 'မနက်'
  if (hour < 16) return 'နေ့လယ်'
  if (hour < 19) return 'ညနေ'
  return 'ည'
}

function yangonParts(d: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Yangon',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    hour: Number(get('hour')),
    minute: get('minute'),
    day: get('day'),
    month: get('month'),
    year: get('year'),
  }
}

/**
 * 12-hour clock ONLY — the user cannot read 24h format (instruction
 * 2026-11-04: every time shown in the app must be 12-hour).
 * Burmese: "ညနေ 5:27" · English: "5:27 PM". Always Asia/Yangon.
 */
export function fmtTime12(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  const p = yangonParts(d)
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12
  if (getLang() === 'en') return `${h12}:${p.minute} ${p.hour < 12 ? 'AM' : 'PM'}`
  return `${daypartMy(p.hour)} ${h12}:${p.minute}`
}

/** "4/11/2026 · ညနေ 5:27" (English: "4/11/2026 · 5:27 PM"). */
export function fmtDateTime12(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  const p = yangonParts(d)
  return `${Number(p.day)}/${Number(p.month)}/${p.year} · ${fmtTime12(d)}`
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
