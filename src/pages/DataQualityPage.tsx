import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { fetchAll } from '../lib/fetchAll'
import { getLastBackupAt } from '../lib/backup'
import { dataQualityCsv } from '../lib/exports'
import { personName, todayYangon } from '../lib/types'
import {
  Card,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  cardCls,
} from '../components/ui'

// Data-quality checks, ported from the old app's data-quality.ts
// (checkDataQuality + checkDebtAndHabits) and its month-lock annotation
// from data-quality.server.ts. Column mapping: bottles_out ->
// delivered_qty, empties_in -> returned_qty, agents.price_per_bottle ->
// agents.default_unit_price, entries.entered_by -> created_by.
// Additions for this schema (noted in the build report): the entries table
// stores `amount`, so amount != delivered_qty * unit_price is checked; the
// agent_name snapshot can be missing; an agent's total balance can go
// negative; open disputes can age past 7 days; the backup stamp can go
// stale. Checks run on live data every time the page opens.

type Severity = 'high' | 'medium' | 'low'
type IssueKind =
  | 'duplicate'
  | 'impossible'
  | 'mismatch'
  | 'debt'
  | 'suspicious'
  | 'snapshot'
  | 'dispute'
  | 'system'
  | 'collection_anomaly'

interface DqIssue {
  kind: IssueKind
  severity: Severity
  table: string
  recordId: string
  date: string
  name: string
  problem: string
  suggestion: string
  locked?: boolean
}

interface EntryRow {
  id: string
  entry_date: string
  agent_id: string | null
  agent_name: string | null
  delivered_qty: number
  returned_qty: number
  unit_price: number
  amount: number
  amount_collected: number
  notes: string | null
  created_by: string | null
  created_at: string
}

interface AgentLite {
  id: string
  name: string
  default_unit_price: number
  bottle_limit: number
}

interface DepositRow {
  id: string
  agent_id: string | null
  deposit_date: string
  agent_name: string | null
  bottles: number
  price_per_bottle: number
  amount: number
}

interface PayrollLite {
  id: string
  month: string
  user_id: string
  base: number
  bonus: number
  deduction: number
  net: number
}

interface ExpenseLite {
  id: string
  expense_date: string
  category_id: string | null
  title: string
  amount: number
}

interface MoneyLite {
  agent_id: string | null
  amount: number
}

/** agent_payments rows as the anomaly check needs them: who collected, when. */
interface PaymentRow {
  agent_id: string | null
  amount: number
  payment_date: string
  created_by: string | null
}

interface DisputeLite {
  id: string
  agent_id: string
  message: string
  status: string
  created_at: string
}

const MAX_DAILY_BOTTLES = 2000
const n = Number
const fmt = (x: number) => Math.round(x).toLocaleString('en-US')
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400e3)
const shiftDay = (d: string, delta: number) =>
  new Date(Date.parse(d) + delta * 86400e3).toISOString().slice(0, 10)

/**
 * Full-table paginated load via the shared helper (src/lib/fetchAll.ts) —
 * the same loader Reports/Entries use. The requested order column gets a
 * unique `id` tiebreak (`month` on month_locks is already unique): ordering
 * by `created_at` alone is not a stable page order when many rows share one
 * timestamp (bulk imports), so pages could repeat or skip rows. Errors keep
 * the `<table>: <message>` shape this page has always shown.
 */
async function fetchTable<T>(table: string, columns: string, orderBy = 'created_at'): Promise<T[]> {
  try {
    return await fetchAll<T>((from, to) => {
      let q = supabase.from(table).select(columns).order(orderBy, { ascending: true })
      if (orderBy !== 'month') q = q.order('id', { ascending: true })
      return q.range(from, to)
    })
  } catch (err) {
    throw new Error(`${table}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function runChecks(input: {
  entries: EntryRow[]
  agents: AgentLite[]
  deposits: DepositRow[]
  payroll: PayrollLite[]
  expenses: ExpenseLite[]
  payments: PaymentRow[]
  writeOffs: MoneyLite[]
  disputes: DisputeLite[]
  usernameOf: (id: string | null) => string
  agentNameOf: (id: string | null) => string
  lastBackupAt: string | null
  today: string
}): DqIssue[] {
  const issues: DqIssue[] = []
  const agents = new Map(input.agents.map((a) => [a.id, a]))
  const today = input.today

  // --- Duplicates: same agent, same day, identical numbers ---------------
  const byKey = new Map<string, EntryRow[]>()
  for (const e of input.entries) {
    if (!e.agent_id) continue
    const k = `${e.agent_id}|${e.entry_date}`
    const arr = byKey.get(k)
    if (arr) arr.push(e)
    else byKey.set(k, [e])
  }
  for (const rows of byKey.values()) {
    if (rows.length < 2) continue
    const f = rows[0]!
    const same = rows.every(
      (r) =>
        r.delivered_qty === f.delivered_qty &&
        r.returned_qty === f.returned_qty &&
        n(r.amount_collected) === n(f.amount_collected),
    )
    if (!same) continue
    for (const r of rows.slice(1)) {
      issues.push({
        kind: 'duplicate',
        severity: 'high',
        table: 'daily_entries',
        recordId: r.id,
        date: r.entry_date,
        name: r.agent_name ?? input.agentNameOf(r.agent_id),
        problem: `တစ်ရက်တည်းတွင် မှတ်တမ်း ${rows.length} ခု (ဂဏန်းတူ)`,
        suggestion: 'ထပ်နေသော မှတ်တမ်းကို ဖျက်ပါ',
      })
    }
  }

  // --- Per-entry checks + running bottle balance --------------------------
  const sorted = [...input.entries].sort((a, b) => a.entry_date.localeCompare(b.entry_date))
  const held = new Map<string, number>()
  for (const e of sorted) {
    const base = {
      table: 'daily_entries',
      recordId: e.id,
      date: e.entry_date,
      name: e.agent_name ?? input.agentNameOf(e.agent_id),
    }
    if (e.delivered_qty < 0 || e.returned_qty < 0 || n(e.amount_collected) < 0)
      issues.push({ ...base, kind: 'impossible', severity: 'high', problem: 'အနုတ်ဂဏန်း ပါနေသည်', suggestion: 'ဂဏန်းကို 0 သို့မဟုတ် အမှန်ဖြင့် ပြင်ပါ' })
    if (e.delivered_qty > MAX_DAILY_BOTTLES)
      issues.push({ ...base, kind: 'impossible', severity: 'medium', problem: `တစ်ရက် ${fmt(e.delivered_qty)} ဘူး ပို့ — အလွန်များသည်`, suggestion: 'ဂဏန်း ထပ်ရိုက်မိခြင်း ရှိမရှိ စစ်ပါ' })
    if (e.entry_date > today)
      issues.push({ ...base, kind: 'impossible', severity: 'medium', problem: 'အနာဂတ်ရက်စွဲ', suggestion: 'ရက်စွဲကို မှန်အောင် ပြင်ပါ' })
    if (e.delivered_qty === 0 && e.returned_qty === 0 && n(e.amount_collected) === 0 && !e.notes?.trim())
      issues.push({ ...base, kind: 'impossible', severity: 'low', problem: 'ဂဏန်းအားလုံး 0 — အလွတ်မှတ်တမ်း', suggestion: 'မလိုအပ်ပါက ဖျက်ပါ' })
    if (Math.abs(n(e.amount) - e.delivered_qty * n(e.unit_price)) > 0.5)
      issues.push({
        ...base,
        kind: 'mismatch',
        severity: 'high',
        problem: `ရောင်းငွေ မကိုက် — ${fmt(e.delivered_qty)} × ${fmt(n(e.unit_price))} = ${fmt(e.delivered_qty * n(e.unit_price))} ဖြစ်ရမည် (မှတ်ထား ${fmt(n(e.amount))})`,
        suggestion: 'မှတ်တမ်းကို စစ်ပြီး ပြင်ပါ',
      })
    if (e.agent_id && !e.agent_name?.trim())
      issues.push({ ...base, kind: 'snapshot', severity: 'medium', problem: 'ကိုယ်စားလှယ် အမည် မှတ်တမ်း (snapshot) ပျောက်နေသည်', suggestion: 'မှတ်တမ်းကို တစ်ခါ ပြန်သိမ်းပါ (အမည် အလိုအလျောက် ပြန်ဝင်မည်)' })
    if (!e.agent_id) continue
    const h = (held.get(e.agent_id) ?? 0) + e.delivered_qty - e.returned_qty
    if (h < 0)
      issues.push({ ...base, kind: 'impossible', severity: 'high', problem: `ပို့ထားသည်ထက် ဗူးခွံ ပိုပြန်ယူ (လက်ကျန် ${fmt(h)})`, suggestion: 'ပြန်ယူဗူးခွံ အရေအတွက် သို့မဟုတ် ယခင်ပို့ဘူးကို စစ်ပြီး ပြင်ပါ' })
    held.set(e.agent_id, Math.max(0, h))
    const a = agents.get(e.agent_id)
    if (a && a.bottle_limit > 0 && h > a.bottle_limit)
      issues.push({ ...base, kind: 'impossible', severity: 'medium', problem: `လက်ကျန် ${fmt(h)} ဘူး — ကန့်သတ်ချက် ${fmt(a.bottle_limit)} ကျော်`, suggestion: 'ကန့်သတ်ချက် တိုးပါ သို့မဟုတ် ပို့ဘူးကို စစ်ပါ' })
    if (a && n(e.unit_price) !== n(a.default_unit_price))
      issues.push({ ...base, kind: 'mismatch', severity: 'medium', problem: `ယူနစ်ဈေး ${fmt(n(e.unit_price))} ≠ ကိုယ်စားလှယ်ဈေး ${fmt(n(a.default_unit_price))}`, suggestion: 'မှတ်တမ်းကို တစ်ခါ ပြန်သိမ်းပါ (ဈေး အလိုအလျောက် ညှိမည်)' })
  }

  // --- Deposits ------------------------------------------------------------
  for (const d of input.deposits) {
    const expect = n(d.bottles) * n(d.price_per_bottle)
    if (Math.abs(expect - n(d.amount)) > 0.5)
      issues.push({
        kind: 'mismatch',
        severity: 'high',
        table: 'agent_deposits',
        recordId: d.id,
        date: d.deposit_date,
        name: d.agent_name ?? input.agentNameOf(d.agent_id),
        problem: `အပေါင် ${fmt(n(d.bottles))} × ${fmt(n(d.price_per_bottle))} = ${fmt(expect)} ဖြစ်ရမည် (မှတ်ထား ${fmt(n(d.amount))})`,
        suggestion: `ပမာဏကို ${fmt(expect)} ကျပ် သို့ ပြင်ပါ`,
      })
  }

  // --- Payroll ---------------------------------------------------------------
  for (const p of input.payroll) {
    const uname = input.usernameOf(p.user_id)
    const expect = n(p.base) + n(p.bonus) - n(p.deduction)
    if (Math.abs(expect - n(p.net)) > 0.5)
      issues.push({
        kind: 'mismatch',
        severity: 'high',
        table: 'payroll_runs',
        recordId: p.id,
        date: p.month,
        name: uname,
        problem: `လစာ ${fmt(n(p.base))} + ${fmt(n(p.bonus))} − ${fmt(n(p.deduction))} = ${fmt(expect)} (မှတ်ထား ${fmt(n(p.net))})`,
        suggestion: 'လစာကို ပြန်တွက်ပါ',
      })
    if (n(p.net) < 0)
      issues.push({
        kind: 'impossible',
        severity: 'medium',
        table: 'payroll_runs',
        recordId: p.id,
        date: p.month,
        name: uname,
        problem: 'အသားတင်လစာ အနုတ်',
        suggestion: 'advance အရစ်ကျ ပမာဏကို လျှော့ပါ',
      })
  }

  // --- Expenses ---------------------------------------------------------------
  for (const x of input.expenses) {
    const base = { table: 'expenses', recordId: x.id, date: x.expense_date, name: x.title }
    if (n(x.amount) <= 0)
      issues.push({ ...base, kind: 'impossible', severity: 'medium', problem: 'ကုန်ကျငွေ 0 သို့မဟုတ် အနုတ်', suggestion: 'ပမာဏကို ပြင်ပါ သို့မဟုတ် ဖျက်ပါ' })
    if (x.expense_date > today)
      issues.push({ ...base, kind: 'impossible', severity: 'medium', problem: 'အနာဂတ်ရက်စွဲ', suggestion: 'ရက်စွဲကို ပြင်ပါ' })
  }

  // --- Debt aging (FIFO), negative balances, held vs deposit ------------------
  const credit = new Map<string, number>()
  for (const p of [...input.payments, ...input.writeOffs])
    if (p.agent_id) credit.set(p.agent_id, (credit.get(p.agent_id) ?? 0) + n(p.amount))
  const trips = new Map<string, EntryRow[]>()
  for (const e of input.entries) {
    if (!e.agent_id) continue
    const arr = trips.get(e.agent_id)
    if (arr) arr.push(e)
    else trips.set(e.agent_id, [e])
  }
  // Deposit bottles per agent, summed once (the per-agent loop below used
  // to re-filter the whole deposits array for every agent).
  const depBottlesByAgent = new Map<string, number>()
  for (const d of input.deposits)
    if (d.agent_id) depBottlesByAgent.set(d.agent_id, (depBottlesByAgent.get(d.agent_id) ?? 0) + n(d.bottles))

  // Negative total balance per agent (over-collected).
  const balance = new Map<string, number>()
  for (const [aid, rows] of trips)
    balance.set(aid, rows.reduce((s, e) => s + n(e.amount) - n(e.amount_collected), 0))
  for (const p of input.payments) if (p.agent_id) balance.set(p.agent_id, (balance.get(p.agent_id) ?? 0) - n(p.amount))
  for (const w of input.writeOffs) if (w.agent_id) balance.set(w.agent_id, (balance.get(w.agent_id) ?? 0) - n(w.amount))
  for (const [aid, bal] of balance) {
    if (bal < -0.5)
      issues.push({
        kind: 'debt',
        severity: 'high',
        table: 'agents',
        recordId: aid,
        date: today,
        name: input.agentNameOf(aid),
        problem: `ကိုယ်စားလှယ် လက်ကျန် အနုတ် ${fmt(bal)} ကျပ် — ငွေ ပိုကောက်ခံထားသည်`,
        suggestion: 'ကောက်ခံမှု မှတ်တမ်းများကို စစ်ပါ',
      })
  }

  for (const [aid, rows] of trips) {
    const sortedRows = [...rows].sort((a, b) => a.entry_date.localeCompare(b.entry_date))
    let pool = credit.get(aid) ?? 0
    for (const r of sortedRows) {
      const d = r.delivered_qty * n(r.unit_price) - n(r.amount_collected)
      if (d < 0) pool -= d
    }
    let owed = 0
    let oldest: EntryRow | null = null
    for (const r of sortedRows) {
      const d = r.delivered_qty * n(r.unit_price) - n(r.amount_collected)
      if (d <= 0) continue
      const left = d - Math.min(pool, d)
      pool = Math.max(0, pool - d)
      if (left > 0.5) {
        owed += left
        oldest ??= r
      }
    }
    if (oldest) {
      const age = daysBetween(oldest.entry_date, today)
      if (age > 30)
        issues.push({
          kind: 'debt',
          severity: age > 60 ? 'high' : 'medium',
          table: 'agents',
          recordId: aid,
          date: oldest.entry_date,
          name: oldest.agent_name ?? input.agentNameOf(aid),
          problem: `ကြွေး ${fmt(owed)} ကျပ် — အဟောင်းဆုံး ${age} ရက် ကြာပြီ`,
          suggestion:
            age > 60
              ? 'ယနေ့ပဲ ဖုန်းဆက်ကောက်ပါ၊ ငွေမရမချင်း ထပ်မပို့ပါနှင့်'
              : 'ကိုယ်စားလှယ်ကို သတိပေးပြီး ကောက်ခံရန် စီစဉ်ပါ',
        })
    }
    const a = agents.get(aid)
    const depBottles = depBottlesByAgent.get(aid) ?? 0
    const h = held.get(aid) ?? 0
    if (a && depBottles > 0 && h > depBottles)
      issues.push({
        kind: 'mismatch',
        severity: 'medium',
        table: 'agents',
        recordId: aid,
        date: today,
        name: a.name,
        problem: `လက်ကျန် ${fmt(h)} ဘူး > အပေါင်ယူထား ${fmt(depBottles)} ဘူး`,
        suggestion: `ကျန် ${fmt(h - depBottles)} ဘူးအတွက် အပေါင် ထပ်ယူပါ သို့မဟုတ် ဘူးခွံ ပြန်သိမ်းပါ`,
      })
  }

  // --- Suspicious habits -------------------------------------------------------
  for (const e of input.entries) {
    const base = {
      table: 'daily_entries',
      recordId: e.id,
      date: e.entry_date,
      name: e.agent_name ?? input.agentNameOf(e.agent_id),
    }
    if (e.delivered_qty >= 20 && n(e.amount_collected) === 0)
      issues.push({ ...base, kind: 'suspicious', severity: 'low', problem: `${fmt(e.delivered_qty)} ဘူး ပို့ပြီး ငွေ 0 လက်ခံ`, suggestion: 'အကြွေးသက်သက်ဟုတ်မဟုတ် ပို့သူဝန်ထမ်းကို မေးပါ' })
    if (e.created_at) {
      const hr = new Date(Date.parse(e.created_at) + 6.5 * 3600e3).getUTCHours()
      if (hr >= 22 || hr < 5) {
        const entered = input.usernameOf(e.created_by)
        issues.push({
          ...base,
          kind: 'suspicious',
          severity: 'low',
          problem: `ညနက် ${String(hr).padStart(2, '0')} နာရီတွင် ထည့်သွင်း${entered ? ` (${entered})` : ''}`,
          suggestion: 'အချိန်လွန်ထည့်ရသည့် အကြောင်းကို စစ်ပါ',
        })
      }
    }
  }

  // --- Collection anomalies (the live old app's signature check) -------------
  // What each collector (agent_payments.created_by) took in, grouped by day.
  // A day is flagged only against a baseline that exists in the fetched data:
  // (a) the day reaches 3x the collector's trailing-7-day daily average, or
  // (b) the day reaches 1.5x the collector's previous-day total — and in
  // both rules the day's total must be at least 100,000.
  const ANOMALY_MIN_TOTAL = 100000
  const byCollector = new Map<string, Map<string, number>>()
  for (const p of input.payments) {
    if (!p.created_by || !p.payment_date) continue
    let daysMap = byCollector.get(p.created_by)
    if (!daysMap) byCollector.set(p.created_by, (daysMap = new Map()))
    daysMap.set(p.payment_date, (daysMap.get(p.payment_date) ?? 0) + n(p.amount))
  }
  for (const [collectorId, daysMap] of byCollector) {
    const collector = input.usernameOf(collectorId)
    if (!collector) continue
    for (const [date, total] of daysMap) {
      if (total < ANOMALY_MIN_TOTAL) continue
      const base = {
        kind: 'collection_anomaly' as const,
        severity: 'high' as const,
        table: 'agent_payments',
        recordId: collectorId,
        date,
        name: collector,
      }
      // (a) Trailing-7-day daily average: the 7 calendar days before this
      // day; days without payments count as 0, but at least one of them
      // must exist in the fetched data (otherwise no baseline).
      let windowSum = 0
      let windowSeen = false
      for (let k = 1; k <= 7; k++) {
        const prevTotal = daysMap.get(shiftDay(date, -k))
        if (prevTotal !== undefined) {
          windowSeen = true
          windowSum += prevTotal
        }
      }
      if (windowSeen) {
        const avg = windowSum / 7
        if (avg > 0 && total >= 3 * avg)
          issues.push({
            ...base,
            problem: `${collector} သည် ပုံမှန်ထက် ၃ ဆပိုများသော ငွေကို ကောက်ခံခဲ့သည်`,
            suggestion: `ကောက်ငွေ ${fmt(total)} ကျပ် · ပုံမှန်ငွေ ${fmt(avg)} ကျပ် — ကောက်ခံမှု မှတ်တမ်းများကို စစ်ပါ`,
          })
      }
      // (b) Previous-day total, when that day exists in the fetched data.
      const prevDayTotal = daysMap.get(shiftDay(date, -1))
      if (prevDayTotal !== undefined && prevDayTotal > 0 && total >= 1.5 * prevDayTotal)
        issues.push({
          ...base,
          problem: `${collector} ကောက်ခံသောငွေသည် ယမန်နေ့၏ ${Math.round((total / prevDayTotal) * 100)}% ရှိသည်`,
          suggestion: `ကောက်ငွေ ${fmt(total)} ကျပ် · ယမန်နေ့ငွေ ${fmt(prevDayTotal)} ကျပ် — ကောက်ခံမှု မှတ်တမ်းများကို စစ်ပါ`,
        })
    }
  }

  // --- Disputes left unresolved > 7 days ---------------------------------------
  for (const d of input.disputes) {
    if (d.status === 'closed') continue
    const age = daysBetween(d.created_at.slice(0, 10), today)
    if (age > 7)
      issues.push({
        kind: 'dispute',
        severity: 'medium',
        table: 'disputes',
        recordId: d.id,
        date: d.created_at.slice(0, 10),
        name: input.agentNameOf(d.agent_id),
        problem: `အငြင်းပွားမှု ${age} ရက် ကြာပြီ — မဖြေရှင်းရသေးပါ`,
        suggestion: 'အငြင်းပွားမှု စာမျက်နှာတွင် ပြန်ဖြေပြီး ပိတ်ပါ',
      })
  }

  // --- Backup freshness ----------------------------------------------------------
  if (!input.lastBackupAt) {
    issues.push({
      kind: 'system',
      severity: 'medium',
      table: 'app_settings',
      recordId: 'last_backup_at',
      date: today,
      name: 'Backup',
      problem: 'Backup တစ်ခါမှ မလုပ်ရသေးပါ',
      suggestion: 'ပင်မ စာမျက်နှာမှ Backup ဒေါင်းလုပ် လုပ်ပါ',
    })
  } else {
    const age = daysBetween(input.lastBackupAt.slice(0, 10), today)
    if (age > 7)
      issues.push({
        kind: 'system',
        severity: 'medium',
        table: 'app_settings',
        recordId: 'last_backup_at',
        date: input.lastBackupAt.slice(0, 10),
        name: 'Backup',
        problem: `နောက်ဆုံး Backup သည် ${age} ရက် ကြာပြီ`,
        suggestion: 'ပင်မ စာမျက်နှာမှ Backup အသစ် ဒေါင်းလုပ် လုပ်ပါ',
      })
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 }
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity] || b.date.localeCompare(a.date))
}

const GROUP_TITLES: { kind: IssueKind; title: string }[] = [
  { kind: 'duplicate', title: 'ထပ်နေသော မှတ်တမ်းများ' },
  { kind: 'impossible', title: 'မဖြစ်နိုင်သော ဂဏန်းများ' },
  { kind: 'mismatch', title: 'မကိုက်ညီသော ဂဏန်းများ' },
  { kind: 'snapshot', title: 'အမည် မှတ်တမ်း ပျောက်နေသည်များ' },
  { kind: 'debt', title: 'ကြွေးနှင့် လက်ကျန် သတိပေးချက်များ' },
  { kind: 'dispute', title: 'ဖြေရှင်းရန် ကျန်နေသော အငြင်းပွားမှုများ' },
  { kind: 'system', title: 'စနစ် စစ်ဆေးချက်များ' },
  { kind: 'collection_anomaly', title: 'သံသယရှိ (ကောက်ငွေ)' },
  { kind: 'suspicious', title: 'သံသယဖြစ်ဖွယ် မှတ်တမ်းများ' },
]

const SEVERITY_BADGE: Record<Severity, { label: string; cls: string }> = {
  high: { label: 'အရေးကြီး', cls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
  medium: { label: 'သတိပေးချက်', cls: 'bg-accent-100 text-accent-800 dark:bg-amber-900 dark:text-amber-200' },
  low: { label: 'အသေးစား', cls: 'bg-stone-200 text-stone-700 dark:bg-neutral-800 dark:text-neutral-300' },
}

const REVIEWED_KEY = 'wfms-dq-reviewed'

/**
 * Issue rows mounted per group before the "show more" button. With
 * multi-year data the checks legitimately produce 10k+ issues (e.g. an
 * entry priced off the agent's current default, or held bottles over the
 * limit, fire per entry), and mounting every row in one render blocks the
 * tab for minutes. Counts, filters and the CSV export still cover the
 * full issue list — only the initial DOM is windowed.
 */
const GROUP_PAGE = 100

/** Stable per-issue identity used for the per-device reviewed set. */
function issueKey(i: DqIssue): string {
  return `${i.kind}|${i.table}|${i.recordId}|${i.date}|${i.problem}`
}

function loadReviewed(): Set<string> {
  try {
    const raw = localStorage.getItem(REVIEWED_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Where to go to fix an issue, best effort by table/kind. */
function fixPath(i: DqIssue): string {
  if (i.table === 'disputes' || i.kind === 'dispute') return '/disputes'
  if (i.table === 'app_settings') return '/'
  if (i.table === 'payroll_runs') return '/payroll'
  if (i.table === 'agent_payments') return '/payments'
  if (i.table === 'daily_entries') return '/entries'
  if (i.table === 'expenses') return '/expenses'
  if (i.table === 'agents' || i.table === 'agent_deposits') return '/agents'
  if (i.kind === 'debt') return '/collections'
  return '/entries'
}

export default function DataQualityPage() {
  const [issues, setIssues] = useState<DqIssue[]>([])
  const [counts, setCounts] = useState<{ entries: number; deposits: number; payroll: number; expenses: number } | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [severityFilter, setSeverityFilter] = useState<'all' | Severity>('all')
  const [kindFilter, setKindFilter] = useState<IssueKind | null>(null)
  const [reviewed, setReviewed] = useState<Set<string>>(loadReviewed)
  const [hideReviewed, setHideReviewed] = useState(false)
  const [shownCounts, setShownCounts] = useState<Partial<Record<IssueKind, number>>>({})

  // Render windowing restarts whenever the visible issue set changes.
  useEffect(() => {
    setShownCounts({})
  }, [severityFilter, kindFilter, hideReviewed])

  const toggleReviewed = useCallback((key: string) => {
    setReviewed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(REVIEWED_KEY, JSON.stringify([...next]))
      } catch {
        /* storage full/blocked — marking still works for this session */
      }
      return next
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const [entries, agents, deposits, payroll, expenses, payments, writeOffs, disputes, profiles, locks, lastBackupAt] =
        await Promise.all([
          fetchTable<EntryRow>(
            'daily_entries',
            'id, entry_date, agent_id, agent_name, delivered_qty, returned_qty, unit_price, amount, amount_collected, notes, created_by, created_at',
          ),
          fetchTable<AgentLite>('agents', 'id, name, default_unit_price, bottle_limit', 'name'),
          fetchTable<DepositRow>('agent_deposits', 'id, agent_id, deposit_date, agent_name, bottles, price_per_bottle, amount'),
          fetchTable<PayrollLite>('payroll_runs', 'id, month, user_id, base, bonus, deduction, net'),
          fetchTable<ExpenseLite>('expenses', 'id, expense_date, category_id, title, amount'),
          fetchTable<PaymentRow>('agent_payments', 'agent_id, amount, payment_date, created_by'),
          fetchTable<MoneyLite & { writeoff_date: string }>('write_offs', 'agent_id, amount, writeoff_date'),
          fetchTable<DisputeLite>('disputes', 'id, agent_id, message, status, created_at'),
          fetchTable<{ id: string; username: string; display_name?: string | null }>(
            'profiles',
            'id, username, display_name',
            'username',
          ),
          fetchTable<{ month: string }>('month_locks', 'month', 'month'),
          getLastBackupAt(),
        ])
      const usernames = new Map(profiles.map((p) => [p.id, personName(p)]))
      const agentNames = new Map(agents.map((a) => [a.id, a.name]))
      const found = runChecks({
        entries,
        agents,
        deposits,
        payroll,
        expenses,
        payments,
        writeOffs,
        disputes,
        usernameOf: (id) => (id ? usernames.get(id) ?? '' : ''),
        agentNameOf: (id) => (id ? agentNames.get(id) ?? '—' : '—'),
        lastBackupAt,
        today: todayYangon(),
      })
      const lockedMonths = new Set(locks.map((l) => l.month.slice(0, 7)))
      for (const i of found) i.locked = lockedMonths.has(i.date.slice(0, 7))
      setIssues(found)
      setCounts({ entries: entries.length, deposits: deposits.length, payroll: payroll.length, expenses: expenses.length })
      setCheckedAt(new Date().toLocaleString('my-MM'))
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const countsBySeverity = useMemo(() => {
    const c: Record<Severity, number> = { high: 0, medium: 0, low: 0 }
    for (const i of issues) c[i.severity]++
    return c
  }, [issues])

  const severitiesPresent = useMemo(
    () => (['high', 'medium', 'low'] as Severity[]).filter((s) => countsBySeverity[s] > 0),
    [countsBySeverity],
  )

  const kindCounts = useMemo(() => {
    const m = new Map<IssueKind, number>()
    for (const i of issues) m.set(i.kind, (m.get(i.kind) ?? 0) + 1)
    return m
  }, [issues])

  const reviewedCount = useMemo(
    () => issues.filter((i) => reviewed.has(issueKey(i))).length,
    [issues, reviewed],
  )

  const visibleIssues = useMemo(
    () =>
      issues.filter(
        (i) =>
          (severityFilter === 'all' || i.severity === severityFilter) &&
          (!kindFilter || i.kind === kindFilter) &&
          (!hideReviewed || !reviewed.has(issueKey(i))),
      ),
    [issues, severityFilter, kindFilter, hideReviewed, reviewed],
  )

  const grouped = useMemo(
    () =>
      GROUP_TITLES.map((g) => ({
        ...g,
        items: visibleIssues.filter((i) => i.kind === g.kind),
      })).filter((g) => g.items.length > 0),
    [visibleIssues],
  )

  function onExportCsv() {
    dataQualityCsv(
      issues.map((i) => ({
        အဆင့်: SEVERITY_BADGE[i.severity].label,
        အမျိုးအစား: GROUP_TITLES.find((g) => g.kind === i.kind)?.title ?? i.kind,
        ပြဿနာ: i.problem,
        သက်ဆိုင်သူ: i.name,
        ရက်စွဲ: i.date,
        အကြံပြုချက်: i.suggestion,
        'လ ပိတ်ထားသည်': i.locked ? 'ဟုတ်' : '',
      })),
      `data-quality-${todayYangon()}.csv`,
    )
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="ဒေတာ အရည်အသွေး စစ်ဆေးမှု"
        subtitle="မှတ်တမ်းများထဲက မှားယွင်းမှုများ အလိုအလျောက် စစ်ဆေးရန်"
      />
      <p className="text-sm text-stone-500 dark:text-neutral-400">
        စစ်ဆေးမှုများကို စာမျက်နှာ ဖွင့်ချိန်တွင် နောက်ဆုံး ဒေတာဖြင့် အလိုအလျောက် လုပ်ဆောင်ပါတယ်။
        {checkedAt && <> နောက်ဆုံး စစ်ဆေးချိန်: {checkedAt}</>}
        {counts && (
          <>
            {' '}
            စစ်ဆေးခဲ့သော မှတ်တမ်း — ရေပို့ {counts.entries} · အပေါင် {counts.deposits} · လစာ{' '}
            {counts.payroll} · စရိတ် {counts.expenses}
          </>
        )}
      </p>

      <div className="flex flex-wrap gap-2">
        <PrimaryButton onClick={load} disabled={loading}>
          {loading ? 'စစ်ဆေးနေပါတယ်…' : 'ပြန်စစ်ရန်'}
        </PrimaryButton>
        <SecondaryButton onClick={onExportCsv} disabled={loading || issues.length === 0}>
          ⬇ CSV ထုတ်ရန်
        </SecondaryButton>
      </div>

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      {loading ? (
        <LoadingState />
      ) : (
        <>
          <Card>
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-full bg-stone-200 px-3 py-1.5 font-semibold dark:bg-neutral-800">
                စုစုပေါင်း ပြဿနာ {issues.length} ခု
              </span>
              <span className={`rounded-full px-3 py-1.5 font-semibold ${SEVERITY_BADGE.high.cls}`}>
                အရေးကြီး {countsBySeverity.high}
              </span>
              <span className={`rounded-full px-3 py-1.5 font-semibold ${SEVERITY_BADGE.medium.cls}`}>
                သတိပေးချက် {countsBySeverity.medium}
              </span>
              <span className={`rounded-full px-3 py-1.5 font-semibold ${SEVERITY_BADGE.low.cls}`}>
                အသေးစား {countsBySeverity.low}
              </span>
              {reviewedCount > 0 && (
                <span className="rounded-full bg-brand-50 px-3 py-1.5 font-semibold text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
                  စစ်ပြီး {reviewedCount} ခု
                </span>
              )}
            </div>

            {issues.length > 0 && (
              <>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => setSeverityFilter('all')}
                    className={`inline-flex min-h-[44px] items-center rounded-full px-3.5 text-sm font-semibold ${
                      severityFilter === 'all'
                        ? 'bg-brand-700 text-white'
                        : 'bg-stone-200 text-stone-700 dark:bg-neutral-800 dark:text-neutral-300'
                    }`}
                  >
                    အားလုံး
                  </button>
                  {severitiesPresent.map((s) => (
                    <button
                      key={s}
                      onClick={() => setSeverityFilter(severityFilter === s ? 'all' : s)}
                      className={`inline-flex min-h-[44px] items-center rounded-full px-3.5 text-sm font-semibold ${
                        severityFilter === s
                          ? 'bg-brand-700 text-white'
                          : SEVERITY_BADGE[s].cls
                      }`}
                    >
                      {SEVERITY_BADGE[s].label} {countsBySeverity[s]}
                    </button>
                  ))}
                  <button
                    onClick={() => setHideReviewed((v) => !v)}
                    className={`inline-flex min-h-[44px] items-center rounded-full px-3.5 text-sm font-semibold ${
                      hideReviewed
                        ? 'bg-brand-700 text-white'
                        : 'bg-stone-200 text-stone-700 dark:bg-neutral-800 dark:text-neutral-300'
                    }`}
                  >
                    {hideReviewed ? 'စစ်ပြီး ပြရန်' : 'စစ်ပြီး ဝှက်ရန်'}
                  </button>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                  {GROUP_TITLES.filter((g) => (kindCounts.get(g.kind) ?? 0) > 0).map((g) => {
                    const active = kindFilter === g.kind
                    return (
                      <button
                        key={g.kind}
                        onClick={() => setKindFilter(active ? null : g.kind)}
                        className={`rounded-xl border p-3 text-left transition ${
                          active
                            ? 'border-brand-500 bg-brand-50 dark:border-brand-700 dark:bg-brand-950/40'
                            : 'border-stone-200 bg-white dark:border-neutral-800 dark:bg-neutral-900'
                        }`}
                      >
                        <div className="text-sm font-semibold">{g.title}</div>
                        <div className="mt-0.5 text-xs text-stone-500 dark:text-neutral-400">
                          {kindCounts.get(g.kind)} ခု
                        </div>
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </Card>

          {issues.length === 0 ? (
            <section className="rounded-2xl border border-brand-300 bg-brand-50 p-4 shadow-card dark:border-brand-800 dark:bg-brand-950/40 lg:p-5">
              <p className="font-semibold text-brand-800 dark:text-brand-200">
                ✓ စစ်ဆေးမှု အားလုံး အောင်မြင်ပါတယ် — ပြဿနာ မတွေ့ပါ
              </p>
            </section>
          ) : visibleIssues.length === 0 ? (
            <section className="rounded-2xl border border-stone-300 bg-stone-50 p-4 shadow-card dark:border-neutral-700 dark:bg-neutral-800/40 lg:p-5">
              <p className="font-semibold">ရွေးထားသော စစ်ထုတ်မှုဖြင့် ပြစရာ မရှိပါ</p>
              <p className="mt-1 text-sm text-stone-500 dark:text-neutral-400">
                စစ်ပြီး ဝှက်ထားခြင်း သို့မဟုတ် အဆင့်/အမျိုးအစား စစ်ထုတ်မှုကြောင့် ဖြစ်နိုင်ပါတယ်။
              </p>
            </section>
          ) : (
            grouped.map((g) => {
              const shownItems = g.items.slice(0, shownCounts[g.kind] ?? GROUP_PAGE)
              const hasMore = g.items.length > shownItems.length
              return (
              <section key={g.kind} className="space-y-2">
                <h2 className="px-0.5 text-base font-bold">
                  {g.title}{' '}
                  <span className="text-stone-400 dark:text-neutral-500">({g.items.length})</span>
                </h2>
                <ul className={`${cardCls} divide-y divide-stone-100 overflow-hidden dark:divide-neutral-800/70`}>
                  {shownItems.map((i, idx) => {
                    const key = issueKey(i)
                    const isReviewed = reviewed.has(key)
                    return (
                      <li
                        key={`${i.recordId}-${idx}`}
                        className={`p-3.5 ${isReviewed ? 'opacity-50' : ''}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-medium">{i.problem}</div>
                          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${SEVERITY_BADGE[i.severity].cls}`}>
                            {SEVERITY_BADGE[i.severity].label}
                          </span>
                        </div>
                        <div className="mt-1 text-sm text-stone-500 dark:text-neutral-400">
                          {i.name} · {i.date}
                          {i.locked && <span className="ml-2">🔒 လ ပိတ်ထားသည်</span>}
                        </div>
                        <div className="mt-1 text-sm text-stone-600 dark:text-neutral-300">
                          အကြံပြုချက်: {i.suggestion}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button
                            onClick={() => toggleReviewed(key)}
                            aria-pressed={isReviewed}
                            className={`inline-flex min-h-[44px] items-center rounded-full px-3.5 text-sm font-semibold ${
                              isReviewed
                                ? 'bg-brand-700 text-white'
                                : 'bg-stone-200 text-stone-700 dark:bg-neutral-800 dark:text-neutral-300'
                            }`}
                          >
                            {isReviewed ? '✓ စစ်ပြီးပါပြီ' : 'စစ်ပြီးပါပြီ'}
                          </button>
                          <Link
                            to={fixPath(i)}
                            className="inline-flex min-h-[44px] items-center rounded-full bg-brand-50 px-3.5 text-sm font-semibold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300"
                          >
                            ပြင်ရန်
                          </Link>
                        </div>
                      </li>
                    )
                  })}
                </ul>
                {hasMore && (
                  <div>
                    <button
                      onClick={() =>
                        setShownCounts((prev) => ({
                          ...prev,
                          [g.kind]: (prev[g.kind] ?? GROUP_PAGE) + GROUP_PAGE,
                        }))
                      }
                      className="inline-flex min-h-[44px] items-center rounded-full bg-stone-200 px-4 text-sm font-semibold text-stone-700 dark:bg-neutral-800 dark:text-neutral-300"
                    >
                      ထပ်ပြမည်
                    </button>
                  </div>
                )}
              </section>
              )
            })
          )}
          <p className="text-xs text-stone-400 dark:text-neutral-500">
            ပြဿနာများကို အရေးကြီး အဆင့်မှ အစဉ်လိုက် ပြထားပါသည်။
          </p>
        </>
      )}
    </div>
  )
}
