import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { fetchAll } from '../lib/fetchAll'
import { formatMMK, personName, todayYangon, type Agent } from '../lib/types'
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
  created_by: string | null
  created_at: string
}

interface WriteOffLite {
  id: string
  agent_id: string | null
  agent_name: string | null
  writeoff_date: string
  amount: number
  note: string
  created_by: string | null
  created_at: string
}

interface ProfileLite {
  id: string
  username: string
  display_name: string | null
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
  receivableRaw: number
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

interface EmployeePerfRow {
  id: string
  bottles: number
  cash: number
  debtCollected: number
  total: number
}

/**
 * Shape returned by the report_range RPC (migration 0020), which computes
 * the whole report server-side. Mirrors Report plus the page's auxiliary
 * datasets (employee performance, in-range write-off list, data-presence
 * flag, earliest entry year for the trend year picker).
 */
interface ReportRpc extends Report {
  employeePerf: EmployeePerfRow[]
  rangeWriteOffs: WriteOffLite[]
  hasData: boolean
  earliestYear: number | null
}

const EMPTY_REPORT: Report = {
  sales: 0,
  collected: 0,
  writeOffs: 0,
  expenseTotal: 0,
  byCategory: [],
  payroll: 0,
  profit: 0,
  forfeitureIncome: 0,
  refunds: 0,
  depositLiability: 0,
  receivable: 0,
  receivableRaw: 0,
  aging: { d30: 0, d60: 0, d60p: 0 },
  agingRows: [],
  perAgent: [],
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

/**
 * Month close, also exposed here as on the old app's reports page. Same
 * behavior as HomePage's MonthLockCard (reproduced locally — that component
 * is not exported): same month_locks rows and lock/unlock calls.
 */
function MonthLockSection() {
  const { profile } = useAuth()
  const [locks, setLocks] = useState<string[]>([])
  const [month, setMonth] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('month_locks').select('month').order('month', { ascending: false })
    setLocks(((data ?? []) as { month: string }[]).map((r) => r.month))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function onLock() {
    if (!month) {
      setMsg('လ ရွေးပါ')
      return
    }
    setMsg(null)
    const { error } = await supabase
      .from('month_locks')
      .insert({ month: `${month}-01`, locked_by: profile?.id ?? null })
    if (error) setMsg(error.message)
    await load()
  }

  async function onUnlock(m: string) {
    if (!confirm(`${m.slice(0, 7)} ကို lock ပြန်ဖွင့်မှာ သေချာပါသလား?`)) return
    setMsg(null)
    const { error } = await supabase.from('month_locks').delete().eq('month', m)
    if (error) setMsg(error.message)
    await load()
  }

  return (
    <Card className="print:hidden">
      <CardTitle>လ ပိတ်ခြင်း (Month Lock)</CardTitle>
      <p className="mt-1 text-sm opacity-80">
        ပိတ်ထားသော လအတွင်း မည်သည့် မှတ်တမ်ကိုမှ ပြင်/ဖျက်/ထည့် လုပ်၍ မရပါ (ပိုင်ရှင် အပါအဝင်)။
      </p>
      <div className="mt-3 flex gap-2">
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className={`${inputCls} min-w-0 flex-1`}
        />
        <PrimaryButton onClick={onLock} className="shrink-0">
          ပိတ်ရန်
        </PrimaryButton>
      </div>
      {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
      {locks.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {locks.map((m) => (
            <li key={m} className="flex items-center justify-between gap-2">
              <span>🔒 {m.slice(0, 7)}</span>
              {profile?.role === 'owner' && (
                <SecondaryButton size="sm" onClick={() => onUnlock(m)}>
                  ပြန်ဖွင့်ရန်
                </SecondaryButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export default function ReportsPage() {
  const { profile } = useAuth()
  const today = todayYangon()
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`)
  const [to, setTo] = useState(monthEnd(today))
  const [applied, setApplied] = useState({ from, to })

  const [agents, setAgents] = useState<Agent[]>([])
  const [profiles, setProfiles] = useState<ProfileLite[]>([])
  // The whole report (range figures, aging, per-agent, employee table,
  // in-range write-offs) now comes from the report_range RPC — the page no
  // longer downloads the full entry/payment history to aggregate locally.
  const [reportData, setReportData] = useState<ReportRpc | null>(null)
  // Rolling 24-month trend from the report_months RPC.
  const [trend, setTrend] = useState<TrendRow[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [showAgingDetail, setShowAgingDetail] = useState(false)
  const [exporting, setExporting] = useState(false)

  // Daily Brief (always about TODAY, independent of the applied range).
  // Its aging buckets come from the report_aging RPC; its entry-level
  // checks only ever look at today and the previous 7 days, so the entry
  // fetch is bounded to that window.
  const [openDisputes, setOpenDisputes] = useState(0)
  const [briefEntries, setBriefEntries] = useState<EntryLite[]>([])
  const [briefAging, setBriefAging] = useState<Record<Bucket, number>>({
    d30: 0,
    d60: 0,
    d60p: 0,
  })
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
  const [okMsg, setOkMsg] = useState<string | null>(null)

  // Trend controls: rolling window size, or a calendar year.
  const [trendCount, setTrendCount] = useState<6 | 12 | 24>(12)
  const [trendYear, setTrendYear] = useState('')
  // Per-year trend rows from report_months (12 months of trendYear).
  const [yearTrendRows, setYearTrendRows] = useState<TrendRow[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const { from: f, to: t } = applied
      const trendMonths = monthList(t.slice(0, 7), 24)
      // The Daily Brief only inspects today and the previous 7 days, so
      // its entry fetch is bounded to that window (its aging buckets come
      // from the report_aging RPC instead of a full-history scan).
      const briefFrom = addDays(today, -7)
      const [ag, pf, dsp, bEn, rr, tm, ra] = await Promise.all([
        supabase.from('agents').select('*').order('name'),
        supabase.from('profiles').select('id, username, display_name').order('username'),
        // Daily Brief: open-dispute count (small, bounded by open rows).
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
            .gte('entry_date', briefFrom)
            .lte('entry_date', today)
            .order('entry_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        // The report itself: one server-side aggregation round trip.
        supabase.rpc('report_range', { p_from: f, p_to: t }),
        supabase.rpc('report_months', {
          p_from_month: trendMonths[0],
          p_months: 24,
          p_cap: t,
          p_exp_cap: t,
        }),
        supabase.rpc('report_aging', { p_as_of: today }),
      ])
      if (ag.error) throw new Error(ag.error.message)
      if (pf.error) throw new Error(pf.error.message)
      if (rr.error) throw new Error(rr.error.message)
      if (tm.error) throw new Error(tm.error.message)
      if (ra.error) throw new Error(ra.error.message)
      setProfiles((pf.data ?? []) as ProfileLite[])
      setAgents((ag.data ?? []) as Agent[])
      setReportData(rr.data as ReportRpc)
      setTrend((tm.data ?? []) as TrendRow[])
      setBriefAging((ra.data ?? { d30: 0, d60: 0, d60p: 0 }) as Record<Bucket, number>)
      setOpenDisputes(dsp.length)
      setBriefEntries(bEn)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [applied])

  useEffect(() => {
    load()
  }, [load])

  // Report figures: computed server-side by the report_range RPC
  // (migration 0020 — the old app's getReport math, on this repo's column
  // names; entry.amount is the server-computed delivered x unit price).
  // Only the final display sorts run client-side, with the original
  // comparators, so ordering matches the old in-browser computation.
  const report = useMemo<Report>(() => {
    if (!reportData) return EMPTY_REPORT
    const perAgent = [...reportData.perAgent].sort(
      (a, b) => b.receivable - a.receivable || a.name.localeCompare(b.name),
    )
    const agingRows = [...reportData.agingRows].sort(
      (a, b) => b.days - a.days || b.amount - a.amount,
    )
    return {
      sales: reportData.sales,
      collected: reportData.collected,
      writeOffs: reportData.writeOffs,
      expenseTotal: reportData.expenseTotal,
      byCategory: reportData.byCategory,
      payroll: reportData.payroll,
      profit: reportData.profit,
      forfeitureIncome: reportData.forfeitureIncome,
      refunds: reportData.refunds,
      depositLiability: reportData.depositLiability,
      receivable: reportData.receivable,
      receivableRaw: reportData.receivableRaw,
      aging: reportData.aging,
      agingRows,
      perAgent,
    }
  }, [reportData])

  // Display names for created_by lookups (write-off list, employee table).
  const profileNameById = useMemo(
    () => new Map(profiles.map((p) => [p.id, personName(p)])),
    [profiles],
  )

  // Per-employee performance for the applied range, grouped by who recorded
  // the work: entries give bottles delivered + cash collected at delivery,
  // payments give debt collected afterwards.
  const employeePerf = useMemo(
    () => [...(reportData?.employeePerf ?? [])].sort((a, b) => b.total - a.total),
    [reportData],
  )

  // Write-offs inside the applied range, newest first (the form's list).
  const rangeWriteOffs = useMemo(
    () =>
      [...(reportData?.rangeWriteOffs ?? [])].sort(
        (a, b) =>
          b.writeoff_date.localeCompare(a.writeoff_date) ||
          b.created_at.localeCompare(a.created_at),
      ),
    [reportData],
  )

  // The rolling 24-month trend is fetched by load() via the report_months
  // RPC (state `trend`); the UI below shows a 6/12/24-month slice of it.

  // Per-year trend mode: all 12 months of the selected calendar year via
  // report_months, with the same profit math as the main report (sales +
  // forfeiture - expenses - payroll(base+bonus) - write-offs). Entries /
  // write-offs / settlements stay capped at the applied `to` (mirroring
  // the main report datasets); the year's expenses/payroll cover the
  // full calendar year, as the page's per-year datasets always did.
  useEffect(() => {
    if (!trendYear) {
      setYearTrendRows([])
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await supabase.rpc('report_months', {
          p_from_month: `${trendYear}-01`,
          p_months: 12,
          p_cap: applied.to,
          p_exp_cap: `${trendYear}-12-31`,
        })
        if (error) throw new Error(error.message)
        if (!cancelled) setYearTrendRows((data ?? []) as TrendRow[])
      } catch {
        /* year mode simply shows zeroed months if the RPC is unavailable */
        if (!cancelled) {
          setYearTrendRows(
            Array.from({ length: 12 }, (_, i) => ({
              month: `${trendYear}-${String(i + 1).padStart(2, '0')}`,
              sales: 0,
              costs: 0,
              profit: 0,
            })),
          )
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [trendYear, applied])

  const displayTrend = trendYear ? yearTrendRows : trend.slice(-trendCount)

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
    const earliest = Math.min(cur, reportData?.earliestYear ?? cur)
    const out: string[] = []
    for (let y = cur; y >= earliest; y--) out.push(String(y))
    return out
  }, [reportData, today])

  // --- Daily Brief ---------------------------------------------------------
  // (briefAging is state, set from the report_aging RPC in load().)

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

  const hasData = reportData?.hasData ?? false

  async function exportExcel() {
    if (exporting) return
    setExporting(true)
    setMsg(null)
    setOkMsg(null)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()
      const summary: (string | number)[][] = [
        ['အချိန်ကာလ', `${applied.from} မှ ${applied.to}`],
        ['ရောင်းရငွေ', report.sales],
        ['ကောက်ခံရငွေ', report.collected],
        ['ကြွေးကျန်', report.receivable],
        ['ပိုပေးထားငွေ', report.receivable - report.receivableRaw],
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
      setOkMsg('Excel ဖိုင် ဒေါင်းလုပ် လုပ်ပြီးပါပြီ')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setExporting(false)
  }

  const cards: { label: string; value: number; highlight?: boolean }[] = [
    { label: 'ရောင်းရငွေ', value: report.sales },
    { label: 'ကောက်ခံရငွေ', value: report.collected },
    { label: 'ကြွေးကျန်', value: report.receivable },
    // Agents who overpaid: floored receivable minus the raw ledger net is
    // exactly the total credit the factory holds for agents (owner's line —
    // overpayment is not an error, and it must not net against others' debt).
    { label: 'ပိုပေးထားငွေ', value: report.receivable - report.receivableRaw },
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
      {okMsg && <p className="text-sm text-emerald-600 dark:text-emerald-400">{okMsg}</p>}

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

          <Card className="space-y-3">
            <CardTitle>ဝန်ထမ်းအလိုက် စွမ်းဆောင်ရည်</CardTitle>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-stone-200 text-left text-stone-500 dark:border-neutral-800 dark:text-neutral-400">
                    <th className="py-2 pr-2 font-medium">ဝန်ထမ်း</th>
                    <th className="py-2 pr-2 text-right font-medium">ပို့ဘူး</th>
                    <th className="py-2 pr-2 text-right font-medium">ကောက်ငွေ</th>
                    <th className="py-2 pr-2 text-right font-medium">ကြွေးကောက်ငွေ</th>
                    <th className="py-2 text-right font-medium">စုစုပေါင်း</th>
                  </tr>
                </thead>
                <tbody>
                  {employeePerf.map((r) => (
                    <tr key={r.id} className="border-b border-stone-100 last:border-0 dark:border-neutral-800/70">
                      <td className="py-2 pr-2 font-medium">
                        {profileNameById.get(r.id) ?? '—'}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">{r.bottles}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatMMK(r.cash)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">
                        {formatMMK(r.debtCollected)}
                      </td>
                      <td className="py-2 text-right font-semibold tabular-nums">
                        {formatMMK(r.total)}
                      </td>
                    </tr>
                  ))}
                  {employeePerf.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-2 text-stone-500 dark:text-neutral-400">
                        မှတ်တမ်း မရှိပါ
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
                  onChange={(e) => {
                    setWoAgentId(e.target.value)
                    setWoMsg(null)
                    setWoOk(null)
                  }}
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
            <CardTitle>ကြွေးပယ်ဖျက် မှတ်တမ်း</CardTitle>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-stone-200 text-left text-stone-500 dark:border-neutral-800 dark:text-neutral-400">
                    <th className="py-2 pr-2 font-medium">ရက်စွဲ</th>
                    <th className="py-2 pr-2 font-medium">ကိုယ်စားလှယ်</th>
                    <th className="py-2 pr-2 text-right font-medium">ပမာဏ</th>
                    <th className="py-2 pr-2 font-medium">အကြောင်းအရင်း</th>
                    <th className="py-2 text-right font-medium">လုပ်ဆောင်သူ</th>
                  </tr>
                </thead>
                <tbody>
                  {rangeWriteOffs.map((w) => (
                    <tr key={w.id} className="border-b border-stone-100 last:border-0 dark:border-neutral-800/70">
                      <td className="py-2 pr-2 whitespace-nowrap">{w.writeoff_date}</td>
                      <td className="py-2 pr-2 font-medium">{w.agent_name ?? '—'}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatMMK(w.amount)}</td>
                      <td className="py-2 pr-2">{w.note}</td>
                      <td className="py-2 text-right">
                        {w.created_by ? (profileNameById.get(w.created_by) ?? '—') : '—'}
                      </td>
                    </tr>
                  ))}
                  {rangeWriteOffs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-2 text-stone-500 dark:text-neutral-400">
                        ကြွေးပယ်ဖျက် မှတ်တမ်း မရှိပါ
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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

      {(profile?.role === 'owner' || profile?.role === 'manager') && <MonthLockSection />}
    </div>
  )
}
