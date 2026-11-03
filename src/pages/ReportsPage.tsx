import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { fetchAll } from '../lib/fetchAll'
import { formatMMK, todayYangon, type Agent } from '../lib/types'
import {
  Card,
  CardTitle,
  EmptyState,
  Field,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  StatCard,
  inputCls,
} from '../components/ui'

// Recharts is heavy — keep it in its own chunk, loaded only with this page's
// trend card.
const MonthlyTrendChart = lazy(() => import('../components/MonthlyTrendChart'))

// Row shapes read by this page (defined locally, like the other pages).
interface EntryLite {
  id: string
  agent_id: string | null
  agent_name: string | null
  entry_date: string
  delivered_qty: number
  returned_qty: number
  amount: number
  amount_collected: number
  created_at: string
}

interface PaymentLite {
  id: string
  agent_id: string | null
  agent_name: string | null
  payment_date: string
  amount: number
}

interface WriteOffLite {
  id: string
  agent_id: string | null
  agent_name: string | null
  writeoff_date: string
  amount: number
}

interface DepositLite {
  id: string
  agent_id: string | null
  agent_name: string | null
  deposit_date: string
  amount: number
}

interface SettlementLite {
  id: string
  agent_id: string | null
  agent_name: string | null
  settle_date: string
  forfeiture_income: number
  net_refund: number
}

interface ExpenseLite {
  id: string
  expense_date: string
  category_id: string | null
  amount: number
}

interface RunLite {
  id: string
  month: string
  base: number
  bonus: number
}

interface CategoryLite {
  id: string
  name: string
}

type Bucket = 'd30' | 'd60' | 'd60p'

interface AgingRow {
  bucket: Bucket
  agent: string
  date: string
  days: number
  amount: number
}

interface AgentReport {
  id: string
  name: string
  closed: boolean
  deleted: boolean
  sales: number
  collected: number
  writeOff: number
  receivable: number
  bottles: number
  deposit: number
}

interface Report {
  sales: number
  collected: number
  writeOffs: number
  expenseTotal: number
  byCategory: { name: string; total: number }[]
  payroll: number
  profit: number
  forfeitureIncome: number
  refunds: number
  depositLiability: number
  receivable: number
  aging: Record<Bucket, number>
  agingRows: AgingRow[]
  perAgent: AgentReport[]
}

interface TrendRow {
  month: string
  sales: number
  costs: number
  profit: number
}

/** Last day (YYYY-MM-DD) of the month containing a YYYY-MM-DD date. */
function monthEnd(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}

/** The `count` months ending at endMonth ('YYYY-MM'), ascending. */
function monthList(endMonth: string, count: number): string[] {
  const y = Number(endMonth.slice(0, 4))
  const m = Number(endMonth.slice(5, 7))
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

const BUCKET_LABELS: Record<Bucket, string> = {
  d30: 'ရက် ၃၀ အတွင်း',
  d60: 'ရက် ၃၁–၆၀',
  d60p: 'ရက် ၆၀ ကျော်',
}

interface DisputeLite {
  id: string
  status: string
}

/** Shift a YYYY-MM-DD date by `delta` days (UTC math, date-only). */
function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/**
 * Aging buckets as of `asOf`, using the same rule as the main report:
 * per-agent receivable = sales - entry cash - payments - write-offs
 * (floored at 0), allocated to the NEWEST entries first.
 */
function computeAging(
  allEntries: EntryLite[],
  allPayments: PaymentLite[],
  allWriteOffs: WriteOffLite[],
  asOf: string,
): Record<Bucket, number> {
  const aging: Record<Bucket, number> = { d30: 0, d60: 0, d60p: 0 }
  const toMs = new Date(asOf).getTime()
  const key = (r: { agent_id: string | null; agent_name: string | null }) =>
    r.agent_id ?? `deleted:${r.agent_name}`
  const agentKeys = new Set<string>()
  for (const r of [...allEntries, ...allPayments, ...allWriteOffs]) agentKeys.add(key(r))
  const sumAmt = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0)
  for (const k of agentKeys) {
    const ae = allEntries.filter((e) => key(e) === k)
    const allSales = sumAmt(ae)
    const allColl = ae.reduce((s, e) => s + e.amount_collected, 0)
    const allPaid = sumAmt(allPayments.filter((p) => key(p) === k))
    const allWo = sumAmt(allWriteOffs.filter((w) => key(w) === k))
    let left = Math.max(0, allSales - allColl - allPaid - allWo)
    for (const e of [...ae].reverse()) {
      if (left <= 0) break
      const s = Math.min(left, e.amount)
      if (s <= 0) continue
      left -= s
      const days = (toMs - new Date(e.entry_date).getTime()) / 86400000
      const bucket: Bucket = days <= 30 ? 'd30' : days <= 60 ? 'd60' : 'd60p'
      aging[bucket] += s
    }
  }
  return aging
}

type BriefSeverity = 'high' | 'warn' | 'info'
type BriefGroup = 'dispute' | 'debt' | 'sales'

interface BriefItem {
  group: BriefGroup
  severity: BriefSeverity
  text: string
}

const BRIEF_SEVERITY: Record<
  BriefSeverity,
  { label: string; rowCls: string; badgeCls: string }
> = {
  high: {
    label: 'အရေးကြီး',
    rowCls: 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30',
    badgeCls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  },
  warn: {
    label: 'သတိပေးချက်',
    rowCls: 'border-accent-300 bg-accent-50 dark:border-accent-800 dark:bg-amber-950/30',
    badgeCls: 'bg-accent-100 text-accent-800 dark:bg-amber-900 dark:text-amber-200',
  },
  info: {
    label: 'အချက်အလက်',
    rowCls: 'border-stone-200 bg-stone-50 dark:border-neutral-800 dark:bg-neutral-800/40',
    badgeCls: 'bg-stone-200 text-stone-700 dark:bg-neutral-800 dark:text-neutral-300',
  },
}

export default function ReportsPage() {
  const { profile } = useAuth()
  const today = todayYangon()
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`)
  const [to, setTo] = useState(monthEnd(today))
  const [applied, setApplied] = useState({ from, to })

  const [agents, setAgents] = useState<Agent[]>([])
  const [entries, setEntries] = useState<EntryLite[]>([])
  const [expenses, setExpenses] = useState<ExpenseLite[]>([])
  const [categories, setCategories] = useState<CategoryLite[]>([])
  const [writeOffs, setWriteOffs] = useState<WriteOffLite[]>([])
  const [runs, setRuns] = useState<RunLite[]>([])
  const [payments, setPayments] = useState<PaymentLite[]>([])
  const [deposits, setDeposits] = useState<DepositLite[]>([])
  const [settlements, setSettlements] = useState<SettlementLite[]>([])
  const [trendExpenses, setTrendExpenses] = useState<ExpenseLite[]>([])
  const [trendRuns, setTrendRuns] = useState<RunLite[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [showAgingDetail, setShowAgingDetail] = useState(false)
  const [exporting, setExporting] = useState(false)

  // Daily Brief (always about TODAY, independent of the applied range).
  const [openDisputes, setOpenDisputes] = useState(0)
  const [briefEntries, setBriefEntries] = useState<EntryLite[]>([])
  const [briefPayments, setBriefPayments] = useState<PaymentLite[]>([])
  const [briefWriteOffs, setBriefWriteOffs] = useState<WriteOffLite[]>([])
  const [focusDispute, setFocusDispute] = useState(true)
  const [focusDebt, setFocusDebt] = useState(true)
  const [focusSales, setFocusSales] = useState(true)

  // Write-off form.
  const [woAgentId, setWoAgentId] = useState('')
  const [woAmount, setWoAmount] = useState('')
  const [woNote, setWoNote] = useState('')
  const [woMsg, setWoMsg] = useState<string | null>(null)
  const [woOk, setWoOk] = useState<string | null>(null)
  const [woBusy, setWoBusy] = useState(false)

  // Trend controls: rolling window size, or a calendar year.
  const [trendCount, setTrendCount] = useState<6 | 12 | 24>(12)
  const [trendYear, setTrendYear] = useState('')
  const [yearExpenses, setYearExpenses] = useState<ExpenseLite[]>([])
  const [yearRuns, setYearRuns] = useState<RunLite[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const { from: f, to: t } = applied
      const trendMonths = monthList(t.slice(0, 7), 24)
      const trendFrom = `${trendMonths[0]}-01`
      const [
        ag, en, ex, ct, wo, rn, pm, dp, st, tEx, tRn, dsp, bEn, bPm, bWo,
      ] = await Promise.all([
        supabase.from('agents').select('*').order('name'),
        fetchAll<EntryLite>((a, b) =>
          supabase
            .from('daily_entries')
            .select('id, agent_id, agent_name, entry_date, delivered_qty, returned_qty, amount, amount_collected, created_at')
            .lte('entry_date', t)
            .order('entry_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<ExpenseLite>((a, b) =>
          supabase
            .from('expenses')
            .select('id, expense_date, category_id, amount')
            .gte('expense_date', f)
            .lte('expense_date', t)
            .order('expense_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        supabase.from('expense_categories').select('id, name').order('name'),
        fetchAll<WriteOffLite>((a, b) =>
          supabase
            .from('write_offs')
            .select('id, agent_id, agent_name, writeoff_date, amount')
            .lte('writeoff_date', t)
            .order('writeoff_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<RunLite>((a, b) =>
          supabase
            .from('payroll_runs')
            .select('id, month, base, bonus')
            .gte('month', f.slice(0, 7))
            .lte('month', t.slice(0, 7))
            .order('month', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<PaymentLite>((a, b) =>
          supabase
            .from('agent_payments')
            .select('id, agent_id, agent_name, payment_date, amount')
            .lte('payment_date', t)
            .order('payment_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<DepositLite>((a, b) =>
          supabase
            .from('agent_deposits')
            .select('id, agent_id, agent_name, deposit_date, amount')
            .lte('deposit_date', t)
            .order('deposit_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<SettlementLite>((a, b) =>
          supabase
            .from('agent_settlements')
            .select('id, agent_id, agent_name, settle_date, forfeiture_income, net_refund')
            .lte('settle_date', t)
            .order('settle_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<ExpenseLite>((a, b) =>
          supabase
            .from('expenses')
            .select('id, expense_date, category_id, amount')
            .gte('expense_date', trendFrom)
            .lte('expense_date', t)
            .order('expense_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<RunLite>((a, b) =>
          supabase
            .from('payroll_runs')
            .select('id, month, base, bonus')
            .gte('month', trendMonths[0])
            .lte('month', trendMonths[trendMonths.length - 1])
            .order('month', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        // Daily Brief datasets (anchored to today, not the applied range).
        fetchAll<DisputeLite>((a, b) =>
          supabase
            .from('disputes')
            .select('id, status')
            .eq('status', 'open')
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<EntryLite>((a, b) =>
          supabase
            .from('daily_entries')
            .select('id, agent_id, agent_name, entry_date, delivered_qty, returned_qty, amount, amount_collected, created_at')
            .lte('entry_date', today)
            .order('entry_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<PaymentLite>((a, b) =>
          supabase
            .from('agent_payments')
            .select('id, agent_id, agent_name, payment_date, amount')
            .lte('payment_date', today)
            .order('payment_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<WriteOffLite>((a, b) =>
          supabase
            .from('write_offs')
            .select('id, agent_id, agent_name, writeoff_date, amount')
            .lte('writeoff_date', today)
            .order('writeoff_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
      ])
      if (ag.error) throw new Error(ag.error.message)
      if (ct.error) throw new Error(ct.error.message)
      setAgents((ag.data ?? []) as Agent[])
      setCategories((ct.data ?? []) as CategoryLite[])
      setEntries(en)
      setExpenses(ex)
      setWriteOffs(wo)
      setRuns(rn)
      setPayments(pm)
      setDeposits(dp)
      setSettlements(st)
      setTrendExpenses(tEx)
      setTrendRuns(tRn)
      setOpenDisputes(dsp.length)
      setBriefEntries(bEn)
      setBriefPayments(bPm)
      setBriefWriteOffs(bWo)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [applied])

  useEffect(() => {
    load()
  }, [load])

  // Port of the old app's getReport (phase2.functions.ts), on this repo's
  // column names: entry.amount is the server-computed delivered x unit price.
  const report = useMemo<Report>(() => {
    const { from: f, to: t } = applied
    const inRange = (d: string) => d >= f && d <= t
    const toMs = new Date(t).getTime()
    const key = (r: { agent_id: string | null; agent_name: string | null }) =>
      r.agent_id ?? `deleted:${r.agent_name}`

    const groups = new Map<
      string,
      { id: string; name: string; closed: boolean; deleted: boolean }
    >()
    for (const a of agents) {
      groups.set(a.id, { id: a.id, name: a.name, closed: !!a.closed_at, deleted: false })
    }
    for (const r of [...entries, ...writeOffs, ...payments, ...deposits, ...settlements]) {
      if (!r.agent_id && !groups.has(key(r))) {
        groups.set(key(r), {
          id: key(r),
          name: `${r.agent_name ?? '—'} (ဖျက်ပြီး)`,
          closed: true,
          deleted: true,
        })
      }
    }

    const sumAmt = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0)

    let sales = 0
    let collectedEntries = 0
    let writeOffTotal = 0
    let paymentsTotal = 0
    let forfeitureIncome = 0
    let refunds = 0
    let depositLiability = 0
    const aging: Record<Bucket, number> = { d30: 0, d60: 0, d60p: 0 }
    const agingRows: AgingRow[] = []

    const perAgent: AgentReport[] = [...groups.values()].map((g) => {
      const ae = entries.filter((e) => key(e) === g.id)
      let allSales = 0
      let allColl = 0
      let rSales = 0
      let rColl = 0
      let bottles = 0
      for (const e of ae) {
        allSales += e.amount
        allColl += e.amount_collected
        bottles += e.delivered_qty - e.returned_qty
        if (inRange(e.entry_date)) {
          rSales += e.amount
          rColl += e.amount_collected
        }
      }
      const aw = writeOffs.filter((w) => key(w) === g.id)
      const allWo = sumAmt(aw)
      const rWo = sumAmt(aw.filter((w) => inRange(w.writeoff_date)))
      const ap = payments.filter((p) => key(p) === g.id)
      const allPaid = sumAmt(ap)
      const rPaid = sumAmt(ap.filter((p) => inRange(p.payment_date)))

      const receivable = Math.max(0, allSales - allColl - allPaid - allWo)
      // Aging: outstanding assigned to the newest sales first.
      let left = receivable
      for (const e of [...ae].reverse()) {
        if (left <= 0) break
        const s = Math.min(left, e.amount)
        if (s <= 0) continue
        left -= s
        const days = (toMs - new Date(e.entry_date).getTime()) / 86400000
        const bucket: Bucket = days <= 30 ? 'd30' : days <= 60 ? 'd60' : 'd60p'
        aging[bucket] += s
        agingRows.push({
          bucket,
          agent: g.name,
          date: e.entry_date,
          days: Math.max(0, Math.round(days)),
          amount: s,
        })
      }

      const st = settlements.find((s) => key(s) === g.id)
      const deposit = st
        ? 0
        : sumAmt(deposits.filter((d) => key(d) === g.id))
      if (st && inRange(st.settle_date)) {
        forfeitureIncome += st.forfeiture_income
        refunds += st.net_refund
      }
      sales += rSales
      collectedEntries += rColl
      writeOffTotal += rWo
      paymentsTotal += rPaid
      depositLiability += deposit
      if (st) bottles = 0
      return {
        id: g.id,
        name: g.name,
        closed: g.closed,
        deleted: g.deleted,
        sales: rSales,
        collected: rColl + rPaid,
        writeOff: rWo,
        receivable,
        bottles,
        deposit,
      }
    })

    const catName = new Map(categories.map((c) => [c.id, c.name]))
    const catTotals = new Map<string, number>()
    for (const e of expenses) {
      const name = (e.category_id && catName.get(e.category_id)) || 'အမျိုးအစား မသတ်မှတ်'
      catTotals.set(name, (catTotals.get(name) ?? 0) + e.amount)
    }
    const byCategory = [...catTotals.entries()]
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total)
    const expenseTotal = byCategory.reduce((s, c) => s + c.total, 0)

    const payroll = runs.reduce((s, r) => s + r.base + r.bonus, 0)
    const profit = sales + forfeitureIncome - expenseTotal - payroll - writeOffTotal

    agingRows.sort((a, b) => b.days - a.days || b.amount - a.amount)
    perAgent.sort((a, b) => b.receivable - a.receivable || a.name.localeCompare(b.name))

    return {
      sales,
      collected: collectedEntries + paymentsTotal,
      writeOffs: writeOffTotal,
      expenseTotal,
      byCategory,
      payroll,
      profit,
      forfeitureIncome,
      refunds,
      depositLiability,
      receivable: perAgent.reduce((s, a) => s + a.receivable, 0),
      aging,
      agingRows,
      perAgent,
    }
  }, [agents, entries, expenses, categories, writeOffs, runs, payments, deposits, settlements, applied])

  // Port of buildMonthlyTrend (monthly-trend.ts) for the 24 months ending at
  // the applied `to` month; the UI shows a 6/12/24-month slice of it.
  const trend = useMemo<TrendRow[]>(() => {
    const months = monthList(applied.to.slice(0, 7), 24)
    const acc = new Map(months.map((m) => [m, { sales: 0, costs: 0, extra: 0 }]))
    const add = (dateStr: string, fn: (r: { sales: number; costs: number; extra: number }) => void) => {
      const r = acc.get(dateStr.slice(0, 7))
      if (r) fn(r)
    }
    for (const e of entries) add(e.entry_date, (r) => (r.sales += e.amount))
    for (const e of trendExpenses) add(e.expense_date, (r) => (r.costs += e.amount))
    for (const p of trendRuns) add(p.month, (r) => (r.costs += p.base + p.bonus))
    for (const w of writeOffs) add(w.writeoff_date, (r) => (r.costs += w.amount))
    for (const s of settlements) add(s.settle_date, (r) => (r.extra += s.forfeiture_income))
    return months.map((m) => {
      const r = acc.get(m)!
      return { month: m, sales: r.sales, costs: r.costs, profit: r.sales + r.extra - r.costs }
    })
  }, [entries, trendExpenses, trendRuns, writeOffs, settlements, applied])

  // Calendar-year datasets for the per-year trend mode.
  useEffect(() => {
    if (!trendYear) {
      setYearExpenses([])
      setYearRuns([])
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const [ex, rn] = await Promise.all([
          fetchAll<ExpenseLite>((a, b) =>
            supabase
              .from('expenses')
              .select('id, expense_date, category_id, amount')
              .gte('expense_date', `${trendYear}-01-01`)
              .lte('expense_date', `${trendYear}-12-31`)
              .order('expense_date', { ascending: true })
              .order('created_at', { ascending: true })
              .range(a, b),
          ),
          fetchAll<RunLite>((a, b) =>
            supabase
              .from('payroll_runs')
              .select('id, month, base, bonus')
              .gte('month', `${trendYear}-01`)
              .lte('month', `${trendYear}-12`)
              .order('month', { ascending: true })
              .order('created_at', { ascending: true })
              .range(a, b),
          ),
        ])
        if (!cancelled) {
          setYearExpenses(ex)
          setYearRuns(rn)
        }
      } catch {
        /* year mode simply shows what the main datasets hold */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [trendYear])

  // Per-year view: all 12 months of the selected calendar year, with the
  // same profit math as the main report (sales + forfeiture - expenses
  // - payroll(base+bonus) - write-offs). Empty months show 0.
  const yearTrend = useMemo<TrendRow[]>(() => {
    if (!trendYear) return []
    const months = Array.from(
      { length: 12 },
      (_, i) => `${trendYear}-${String(i + 1).padStart(2, '0')}`,
    )
    return months.map((m) => {
      const sales = entries
        .filter((e) => e.entry_date.startsWith(m))
        .reduce((s, e) => s + e.amount, 0)
      const forfeiture = settlements
        .filter((s) => s.settle_date.startsWith(m))
        .reduce((s, x) => s + x.forfeiture_income, 0)
      const exp = yearExpenses
        .filter((e) => e.expense_date.startsWith(m))
        .reduce((s, e) => s + e.amount, 0)
      const pay = yearRuns
        .filter((r) => r.month === m)
        .reduce((s, r) => s + r.base + r.bonus, 0)
      const wo = writeOffs
        .filter((w) => w.writeoff_date.startsWith(m))
        .reduce((s, w) => s + w.amount, 0)
      const costs = exp + pay + wo
      return { month: m, sales, costs, profit: sales + forfeiture - costs }
    })
  }, [trendYear, entries, settlements, yearExpenses, yearRuns, writeOffs])

  const displayTrend = trendYear ? yearTrend : trend.slice(-trendCount)

  // Month-over-month change for the rolling trend (last month vs previous).
  const momChange = (pick: (t: TrendRow) => number) => {
    if (trend.length < 2) return null
    const cur = pick(trend[trend.length - 1]!)
    const prev = pick(trend[trend.length - 2]!)
    if (prev === 0) return null
    return ((cur - prev) / Math.abs(prev)) * 100
  }
  const momProfit = momChange((t) => t.profit)
  // The last month of the rolling trend — the "ယခုလ" of the summary cards.
  const currentTrendMonth = trend.length ? trend[trend.length - 1]! : null
  const bestTrendMonth = displayTrend.length
    ? displayTrend.reduce((best, t) => (t.profit > best.profit ? t : best), displayTrend[0]!)
    : null

  const yearOptions = useMemo(() => {
    const cur = Number(today.slice(0, 4))
    let earliest = cur
    for (const e of entries) {
      const y = Number(e.entry_date.slice(0, 4))
      if (Number.isFinite(y) && y < earliest) earliest = y
    }
    const out: string[] = []
    for (let y = cur; y >= earliest; y--) out.push(String(y))
    return out
  }, [entries, today])

  // --- Daily Brief ---------------------------------------------------------
  const briefAging = useMemo(
    () => computeAging(briefEntries, briefPayments, briefWriteOffs, today),
    [briefEntries, briefPayments, briefWriteOffs, today],
  )

  const briefItems = useMemo<BriefItem[]>(() => {
    const items: BriefItem[] = []
    if (openDisputes > 0) {
      items.push({
        group: 'dispute',
        severity: 'high',
        text: `ဖွင့်ထားဆဲ အငြင်းပွားမှု ${openDisputes} ခု ရှိပါသည်`,
      })
    }
    if (briefAging.d60p > 0) {
      items.push({
        group: 'debt',
        severity: 'high',
        text: `ရက် ၆၀ ကျော် ကြွေး ${formatMMK(briefAging.d60p)} ရှိပါသည်`,
      })
    }
    if (briefAging.d60 > 0) {
      items.push({
        group: 'debt',
        severity: 'warn',
        text: `ရက် ၃၁–၆၀ ကြွေး ${formatMMK(briefAging.d60)} ရှိပါသည်`,
      })
    }
    const todayEntries = briefEntries.filter((e) => e.entry_date === today)
    const unpaidTrips = todayEntries.filter((e) => e.amount > e.amount_collected).length
    if (unpaidTrips > 0) {
      items.push({
        group: 'debt',
        severity: 'info',
        text: `ဒီနေ့ အပြည့် မပေးရသေးသော ခရီး ${unpaidTrips} ခု`,
      })
    }
    const todaySales = todayEntries.reduce((s, e) => s + e.amount, 0)
    const prev7From = addDays(today, -7)
    const prev7Sales = briefEntries
      .filter((e) => e.entry_date >= prev7From && e.entry_date < today)
      .reduce((s, e) => s + e.amount, 0)
    const prev7Avg = prev7Sales / 7
    if (todayEntries.length === 0 || todaySales === 0) {
      items.push({
        group: 'sales',
        severity: 'warn',
        text: 'ဒီနေ့ အရောင်း မှတ်တမ်း မရှိသေးပါ',
      })
    } else if (prev7Avg > 0 && todaySales < prev7Avg * 0.8) {
      items.push({
        group: 'sales',
        severity: 'warn',
        text: 'ဒီနေ့ အရောင်း ပျမ်းမျှ အောက် နည်းနေပါသည်',
      })
    } else if (todaySales > 0) {
      items.push({
        group: 'sales',
        severity: 'info',
        text: 'ဒီနေ့ အရောင်း ပုံမှန် အခြေအနေပါ',
      })
    }
    const deliveredPrev7 = new Set(
      briefEntries
        .filter((e) => e.entry_date >= prev7From && e.entry_date < today && e.agent_id)
        .map((e) => e.agent_id as string),
    )
    const deliveredToday = new Set(
      todayEntries.filter((e) => e.agent_id).map((e) => e.agent_id as string),
    )
    const notDelivered = [...deliveredPrev7].filter((id) => !deliveredToday.has(id)).length
    if (notDelivered > 0) {
      items.push({
        group: 'sales',
        severity: 'info',
        text: `ဒီနေ့ မပို့ရသေးသော ကိုယ်စားလှယ် ${notDelivered} ဦး ရှိပါသည်`,
      })
    }
    return items
  }, [openDisputes, briefAging, briefEntries, today])

  const briefVisible = briefItems.filter(
    (i) =>
      (i.group === 'dispute' && focusDispute) ||
      (i.group === 'debt' && focusDebt) ||
      (i.group === 'sales' && focusSales),
  )

  // --- Write-off form --------------------------------------------------------
  async function onAddWriteOff() {
    setWoMsg(null)
    setWoOk(null)
    const agent = agents.find((a) => a.id === woAgentId)
    if (!agent) {
      setWoMsg('ကိုယ်စားလှယ် ရွေးပါ')
      return
    }
    const amount = Number(woAmount)
    if (!Number.isInteger(amount) || amount <= 0) {
      setWoMsg('ပမာဏကို မှန်ကန်သော ကိန်းပြည့် ထည့်ပါ')
      return
    }
    if (!woNote.trim()) {
      setWoMsg('အကြောင်းရင်း ထည့်ပါ')
      return
    }
    if (!profile) {
      setWoMsg('အကောင့် ပြန်ဝင်ပြီးမှ ထပ်ကြိုးစားပါ')
      return
    }
    setWoBusy(true)
    const { error } = await supabase.from('write_offs').insert({
      agent_id: agent.id,
      agent_name: agent.name,
      amount,
      note: woNote.trim(),
      created_by: profile.id,
    })
    if (error) {
      setWoMsg(error.message)
    } else {
      setWoOk('ကြွေးပယ်ဖျက် မှတ်တမ်း သိမ်းပြီးပါပြီ')
      setWoAmount('')
      setWoNote('')
      await load()
    }
    setWoBusy(false)
  }

  const hasData =
    entries.length > 0 ||
    expenses.length > 0 ||
    payments.length > 0 ||
    writeOffs.length > 0 ||
    runs.length > 0 ||
    deposits.length > 0 ||
    settlements.length > 0

  async function exportExcel() {
    if (exporting) return
    setExporting(true)
    setMsg(null)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()
      const summary: (string | number)[][] = [
        ['အချိန်ကာလ', `${applied.from} မှ ${applied.to}`],
        ['ရောင်းရငွေ', report.sales],
        ['ကောက်ခံရငွေ', report.collected],
        ['ကြွေးကျန်', report.receivable],
        ['အသုံးစရိတ်', report.expenseTotal],
        ['လစာ', report.payroll],
        ['လျော်ကြေး/စွန့်ပစ်', report.writeOffs],
        ['ဗူးမအပ်၍ ရငွေ', report.forfeitureIncome],
        ['အမြတ်', report.profit],
        ['အပေါင် စုစုပေါင်း', report.depositLiability],
        ['ပြန်အမ်းပြီး', report.refunds],
      ]
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([['အကြောင်းအရာ', 'ပမာဏ (ကျပ်)'], ...summary]),
        'အကျဉ်းချုပ်',
      )
      const perAgentRows: (string | number)[][] = [
        ['အမည်', 'ရောင်းရငွေ', 'ကောက်ခံရငွေ', 'လျော်ကြေး/စွန့်ပစ်', 'ကြွေးကျန်', 'လက်ထဲ ဘူး', 'အပေါင်'],
        ...report.perAgent.map((a) => [
          a.name,
          a.sales,
          a.collected,
          a.writeOff,
          a.receivable,
          a.bottles,
          a.deposit,
        ]),
      ]
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet(perAgentRows),
        'ကိုယ်စားလှယ်အလိုက်',
      )
      const catRows: (string | number)[][] = [
        ['အမျိုးအစား', 'ပမာဏ (ကျပ်)'],
        ...report.byCategory.map((c) => [c.name, c.total]),
        ['စုစုပေါင်း', report.expenseTotal],
      ]
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet(catRows),
        'စရိတ်အမျိုးအစား',
      )
      XLSX.writeFile(wb, `report-${applied.from}-${applied.to}.xlsx`)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setExporting(false)
  }

  const cards: { label: string; value: number; highlight?: boolean }[] = [
    { label: 'ရောင်းရငွေ', value: report.sales },
    { label: 'ကောက်ခံရငွေ', value: report.collected },
    { label: 'ကြွေးကျန်', value: report.receivable },
    { label: 'အသုံးစရိတ်', value: report.expenseTotal },
    { label: 'လစာ', value: report.payroll },
    { label: 'လျော်ကြေး/စွန့်ပစ်', value: report.writeOffs },
    { label: 'ဗူးမအပ်၍ ရငွေ', value: report.forfeitureIncome },
    { label: 'အပေါင် စုစုပေါင်း', value: report.depositLiability },
    { label: 'ပြန်အမ်းပြီး', value: report.refunds },
    { label: 'အမြတ်', value: report.profit, highlight: true },
  ]
  const maxCat = Math.max(1, ...report.byCategory.map((c) => c.total))

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="အစီရင်ခံစာများ"
        subtitle="ကာလအလိုက် ရောင်းအား၊ စရိတ်၊ လစာနှင့် အမြတ် ကြည့်ရန်"
      />
      <p className="text-sm text-stone-500 dark:text-neutral-400">
        ရွေးထားတဲ့ ကာလအတွင်း ရောင်းအား၊ ကောက်ခံမှု၊ စရိတ်၊ လစာ နဲ့ အမြတ်ကို ဒီနေရာမှာ
        ကြည့်နိုင်ပါတယ်။
      </p>

      <Card className="space-y-3">
        <CardTitle>နေ့စဉ် အကျဉ်းချုပ် (Daily Brief)</CardTitle>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={focusDispute}
              onChange={(e) => setFocusDispute(e.target.checked)}
              className="h-5 w-5 accent-brand-700"
            />
            အငြင်းပွားမှု
          </label>
          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={focusDebt}
              onChange={(e) => setFocusDebt(e.target.checked)}
              className="h-5 w-5 accent-brand-700"
            />
            ကြွေး
          </label>
          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={focusSales}
              onChange={(e) => setFocusSales(e.target.checked)}
              className="h-5 w-5 accent-brand-700"
            />
            အရောင်း
          </label>
        </div>
        {loading ? (
          <LoadingState />
        ) : briefItems.length === 0 ? (
          <div
            className={`flex items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-sm ${BRIEF_SEVERITY.info.rowCls}`}
          >
            <span>ဒီနေ့ လုပ်စရာ မရှိပါ</span>
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${BRIEF_SEVERITY.info.badgeCls}`}
            >
              {BRIEF_SEVERITY.info.label}
            </span>
          </div>
        ) : briefVisible.length === 0 ? (
          <p className="text-sm text-stone-500 dark:text-neutral-400">
            ရွေးထားသော အုပ်စုများတွင် ပြစရာ မရှိပါ
          </p>
        ) : (
          <ul className="space-y-2">
            {briefVisible.map((item, i) => (
              <li
                key={i}
                className={`flex items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-sm ${BRIEF_SEVERITY[item.severity].rowCls}`}
              >
                <span>{item.text}</span>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${BRIEF_SEVERITY[item.severity].badgeCls}`}
                >
                  {BRIEF_SEVERITY[item.severity].label}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="space-y-3 print:hidden">
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="ရက်စ မှ">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="ရက်စ အထိ">
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={() => setApplied({ from, to })} className="flex-1">
            အစီရင်ခံစာ ကြည့်ရန်
          </PrimaryButton>
          <SecondaryButton
            onClick={exportExcel}
            disabled={exporting || loading || !hasData}
          >
            Excel ထုတ်ရန်
          </SecondaryButton>
          <SecondaryButton onClick={() => window.print()}>ပုံနှိပ်ရန်</SecondaryButton>
        </div>
      </Card>

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      {loading ? (
        <LoadingState />
      ) : !hasData ? (
        <EmptyState text="ဒီကာလအတွင်း စာရင်း မရှိသေးပါ — ကာလ ပြောင်းပြီး ပြန်ကြည့်ပါ။" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-5">
            {cards.map((c) =>
              c.highlight ? (
                <div
                  key={c.label}
                  className={`col-span-2 rounded-2xl p-4 text-white shadow-card md:col-span-3 lg:col-span-1 ${
                    c.value < 0 ? 'bg-red-700' : 'bg-brand-700'
                  }`}
                >
                  <div className="text-sm opacity-90">{c.label}</div>
                  <div className="mt-1 text-xl font-bold tabular-nums">{formatMMK(c.value)}</div>
                </div>
              ) : (
                <StatCard
                  key={c.label}
                  label={c.label}
                  value={formatMMK(c.value)}
                  tone={c.label === 'ကြွေးကျန်' && c.value > 0 ? 'danger' : 'default'}
                />
              ),
            )}
          </div>

          <Card className="space-y-2.5">
            <CardTitle>စရိတ် အမျိုးအစားအလိုက်</CardTitle>
            {report.byCategory.map((c) => (
              <div key={c.name} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span>{c.name}</span>
                  <span className="font-medium tabular-nums">{formatMMK(c.total)}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-stone-200 dark:bg-neutral-800">
                  <div
                    className="h-2 rounded-full bg-brand-600"
                    style={{ width: `${Math.round((c.total / maxCat) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {report.byCategory.length === 0 && (
              <p className="text-sm text-stone-500 dark:text-neutral-400">ဒီကာလအတွင်း အသုံးစရိတ် မရှိပါ</p>
            )}
          </Card>

          <Card className="space-y-3">
            <CardTitle>ကြွေး သက်တမ်း (ကြွေးကျန် ခွဲခြားချက်)</CardTitle>
            <div className="grid grid-cols-3 gap-2.5">
              {(Object.keys(BUCKET_LABELS) as Bucket[]).map((b) => (
                <StatCard
                  key={b}
                  label={BUCKET_LABELS[b]}
                  value={formatMMK(report.aging[b])}
                  tone={b === 'd60p' && report.aging[b] > 0 ? 'danger' : 'default'}
                />
              ))}
            </div>
            <button
              onClick={() => setShowAgingDetail((v) => !v)}
              className="inline-flex min-h-[44px] items-center text-sm font-medium text-brand-700 print:hidden dark:text-brand-300"
            >
              {showAgingDetail ? 'အသေးစိတ် ပိတ်ရန်' : 'အသေးစိတ် ကြည့်ရန်'}
            </button>
            {showAgingDetail && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-stone-200 text-left text-stone-500 dark:border-neutral-800 dark:text-neutral-400">
                      <th className="py-2 pr-2 font-medium">ကိုယ်စားလှယ်</th>
                      <th className="py-2 pr-2 font-medium">ရက်စွဲ</th>
                      <th className="py-2 pr-2 text-right font-medium">ရက်</th>
                      <th className="py-2 text-right font-medium">ပမာဏ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.agingRows.map((r, i) => (
                      <tr key={i} className="border-b border-stone-100 last:border-0 dark:border-neutral-800/70">
                        <td className="py-2 pr-2">{r.agent}</td>
                        <td className="py-2 pr-2">{r.date}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{r.days}</td>
                        <td className="py-2 text-right tabular-nums">{formatMMK(r.amount)}</td>
                      </tr>
                    ))}
                    {report.agingRows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-2 text-stone-500 dark:text-neutral-400">
                          ကြွေးကျန် မရှိပါ
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="space-y-3">
            <CardTitle>ကိုယ်စားလှယ်အလိုက် အကျဉ်းချုပ်</CardTitle>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-stone-200 text-left text-stone-500 dark:border-neutral-800 dark:text-neutral-400">
                    <th className="py-2 pr-2 font-medium">အမည်</th>
                    <th className="py-2 pr-2 text-right font-medium">ရောင်းရငွေ</th>
                    <th className="py-2 pr-2 text-right font-medium">ကောက်ခံရငွေ</th>
                    <th className="py-2 pr-2 text-right font-medium">လျော်ကြေး</th>
                    <th className="py-2 pr-2 text-right font-medium">ကြွေးကျန်</th>
                    <th className="py-2 pr-2 text-right font-medium">လက်ထဲ ဘူး</th>
                    <th className="py-2 text-right font-medium">အပေါင်</th>
                  </tr>
                </thead>
                <tbody>
                  {report.perAgent.map((a) => (
                    <tr key={a.id} className="border-b border-stone-100 last:border-0 dark:border-neutral-800/70">
                      <td className="py-2 pr-2 font-medium">
                        {a.name}
                        {a.deleted ? (
                          <span className="ml-1 text-xs text-red-600">(ဖျက်ပြီး)</span>
                        ) : a.closed ? (
                          <span className="ml-1 text-xs text-stone-400 dark:text-neutral-500">(ပိတ်ပြီး)</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatMMK(a.sales)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatMMK(a.collected)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatMMK(a.writeOff)}</td>
                      <td
                        className={`py-2 pr-2 text-right font-semibold tabular-nums ${
                          a.receivable > 0 ? 'text-red-600 dark:text-red-400' : ''
                        }`}
                      >
                        {formatMMK(a.receivable)}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">{a.bottles}</td>
                      <td className="py-2 text-right tabular-nums">{formatMMK(a.deposit)}</td>
                    </tr>
                  ))}
                  {report.perAgent.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-2 text-stone-500 dark:text-neutral-400">
                        ကိုယ်စားလှယ် မရှိသေးပါ
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="space-y-3 print:hidden">
            <CardTitle>ကြွေးပယ်ဖျက် မှတ်တမ်းသစ်</CardTitle>
            <div className="grid gap-2.5 md:grid-cols-3">
              <Field label="ကိုယ်စားလှယ်">
                <select
                  value={woAgentId}
                  onChange={(e) => setWoAgentId(e.target.value)}
                  className={inputCls}
                >
                  <option value="">ရွေးပါ</option>
                  {agents
                    .filter((a) => a.active && !a.closed_at)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="ပမာဏ (ကျပ်)">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={woAmount}
                  onChange={(e) => setWoAmount(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label="အကြောင်းရင်း">
                <input
                  type="text"
                  value={woNote}
                  onChange={(e) => setWoNote(e.target.value)}
                  className={inputCls}
                />
              </Field>
            </div>
            {woMsg && <p className="text-sm text-red-600">{woMsg}</p>}
            {woOk && (
              <p className="text-sm font-medium text-brand-700 dark:text-brand-400">{woOk}</p>
            )}
            <PrimaryButton onClick={onAddWriteOff} disabled={woBusy} className="w-full md:w-auto">
              {woBusy ? 'သိမ်းနေပါတယ်…' : 'သိမ်းရန်'}
            </PrimaryButton>
          </Card>

          <Card className="space-y-3">
            <CardTitle>
              {trendYear
                ? `${trendYear} ခုနှစ် လအလိုက် အရောင်း နှင့် အမြတ်`
                : `လအလိုက် အရောင်း နှင့် အမြတ် (${trendCount} လ)`}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2 print:hidden">
              <select
                value={trendYear}
                onChange={(e) => setTrendYear(e.target.value)}
                className={`${inputCls} w-auto min-w-[150px]`}
                aria-label="နှစ် ရွေးရန်"
              >
                <option value="">နောက်ဆုံး လများ</option>
                {yearOptions.map((y) => (
                  <option key={y} value={y}>
                    {y} ခုနှစ်
                  </option>
                ))}
              </select>
              {!trendYear &&
                ([6, 12, 24] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => setTrendCount(c)}
                    className={`inline-flex min-h-[44px] items-center rounded-full px-3.5 text-sm font-semibold ${
                      trendCount === c
                        ? 'bg-brand-700 text-white'
                        : 'bg-stone-200 text-stone-700 dark:bg-neutral-800 dark:text-neutral-300'
                    }`}
                  >
                    {c} လ
                  </button>
                ))}
            </div>
            {!trendYear && (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                <StatCard
                  label="ယခုလ အရောင်း"
                  value={formatMMK(currentTrendMonth?.sales ?? 0)}
                />
                <StatCard
                  label="ယခုလ အမြတ်"
                  value={formatMMK(currentTrendMonth?.profit ?? 0)}
                  sub={
                    momProfit === null ? (
                      '—'
                    ) : momProfit >= 0 ? (
                      <span className="font-medium text-green-600 dark:text-green-400">
                        ▲ {momProfit.toFixed(1)}% ပြီးခဲ့သည့်လထက်
                      </span>
                    ) : (
                      <span className="font-medium text-red-600 dark:text-red-400">
                        ▼ {Math.abs(momProfit).toFixed(1)}% ပြီးခဲ့သည့်လထက်
                      </span>
                    )
                  }
                />
                <StatCard
                  label="အမြတ်အများဆုံးလ"
                  value={
                    bestTrendMonth
                      ? `${bestTrendMonth.month.slice(2, 4)}/${bestTrendMonth.month.slice(5, 7)} · ${bestTrendMonth.profit.toLocaleString('en-US')}`
                      : '—'
                  }
                />
              </div>
            )}
            <Suspense
              fallback={
                <div className="h-[300px] animate-pulse rounded-lg bg-stone-100 dark:bg-neutral-800/60" />
              }
            >
              <MonthlyTrendChart
                rows={displayTrend.map((t) => ({
                  label: `${t.month.slice(2, 4)}/${t.month.slice(5, 7)}`,
                  month: t.month,
                  sales: t.sales,
                  costs: t.costs,
                  profit: t.profit,
                }))}
              />
            </Suspense>
            <p className="text-xs text-stone-500 dark:text-neutral-400">
              ကုန်ကျငွေ = ကုန်ကျစရိတ် + လစာ/Bonus + ပယ်ဖျက်ငွေ။
              {!trendYear && ' နောက်ဆုံးလ = "ထိ" ရက်စွဲ ပါဝင်သည်လ။'}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-stone-200 text-left text-stone-500 dark:border-neutral-800 dark:text-neutral-400">
                    <th className="py-2 pr-2 font-medium">လ</th>
                    <th className="py-2 pr-2 text-right font-medium">ရောင်းရငွေ</th>
                    <th className="py-2 pr-2 text-right font-medium">ကုန်ကျစရိတ်</th>
                    <th className="py-2 text-right font-medium">အမြတ်</th>
                  </tr>
                </thead>
                <tbody>
                  {displayTrend.map((t) => (
                    <tr key={t.month} className="border-b border-stone-100 last:border-0 dark:border-neutral-800/70">
                      <td className="py-2 pr-2">{t.month}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatMMK(t.sales)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatMMK(t.costs)}</td>
                      <td
                        className={`py-2 text-right font-medium tabular-nums ${
                          t.profit < 0 ? 'text-red-600 dark:text-red-400' : ''
                        }`}
                      >
                        {formatMMK(t.profit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
