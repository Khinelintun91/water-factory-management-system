import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { fetchAll } from '../lib/fetchAll'
import { exportBackup, getLastBackupAt, isBackupOverdue } from '../lib/backup'
import { monthlyBackupCsv, monthlyBackupXlsx } from '../lib/exports'
import {
  formatMMK,
  personName,
  todayYangon,
  type Agent,
  type AgentDeposit,
  type AgentPayment,
  type DailyEntry,
} from '../lib/types'
import { fmtDateTime12 } from '../lib/types'
import { fetchStaffDirectory, receiverName } from '../lib/staffDirectory'
import { FACE_TIERS, type FaceTier } from '../lib/cardFace'
import { NavIcon } from '../components/icons'
import {
  Card,
  CardTitle,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  StatCard,
  btnPrimaryCls,
  btnSecondaryCls,
  inputCls,
} from '../components/ui'

function BackupCard() {
  const [last, setLast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [bkMonth, setBkMonth] = useState(() => todayYangon().slice(0, 7))
  const [bkBusy, setBkBusy] = useState(false)

  async function onMonthly(kind: 'xlsx' | 'csv') {
    setBkBusy(true)
    setMsg(null)
    try {
      if (kind === 'xlsx') await monthlyBackupXlsx(bkMonth)
      else await monthlyBackupCsv(bkMonth)
      setMsg(`${bkMonth} အတွက် လစဉ် backup (${kind === 'xlsx' ? 'Excel' : 'CSV'}) ဒေါင်းလုပ် လုပ်ပြီးပါပြီ`)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Export မအောင်မြင်ပါ')
    }
    setBkBusy(false)
  }

  const load = useCallback(async () => {
    setLast(await getLastBackupAt())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function onExport() {
    setBusy(true)
    setMsg(null)
    try {
      const { filename } = await exportBackup()
      setMsg(`${filename} ကို ဒေါင်းလုပ် လုပ်ပြီးပါပြီ — ဖုန်း + Google Drive၊ ၂ နေရာ သိမ်းထားပါ`)
      await load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Export မအောင်မြင်ပါ')
    }
    setBusy(false)
  }

  const overdue = isBackupOverdue(last)

  return (
    <Card tone={overdue ? 'amber' : 'default'}>
      <CardTitle>ဒေတာ Backup</CardTitle>
      <p className="mt-1 text-sm opacity-80">
        နောက်ဆုံး backup: {last ? fmtDateTime12(last) : 'တစ်ခါမှ မလုပ်ရသေးပါ'}
      </p>
      {overdue && (
        <p className="mt-1 text-sm font-medium text-amber-700 dark:text-amber-300">
          ⚠️ Backup လုပ်ရန် ကျန်နေပါတယ် — တစ်ပတ်မှာ တစ်ကြိမ်တော့ လုပ်ပေးပါ
        </p>
      )}
      <PrimaryButton onClick={onExport} disabled={busy} className="mt-3 w-full">
        {busy ? 'ထုတ်နေပါတယ်…' : '⬇ Backup ဒေါင်းလုပ်'}
      </PrimaryButton>
      <p className="mt-2 text-xs opacity-70">
        မှတ်တမ်း များရင် ထုတ်တာ ၂–၃ မိနစ် ကြာနိုင်ပါတယ် — ပြီးတဲ့ထိ စောင့်ပေးပါ၊ စာမျက်နှာ မပိတ်ပါနဲ့။
      </p>
      <div className="mt-4 border-t border-stone-200/80 pt-3 dark:border-neutral-800">
        <p className="text-sm font-medium">လစဉ် မှတ်တမ်း ထုတ်ရန် (စာရင်းကိုင် အတွက်)</p>
        <div className="mt-2 flex gap-2">
          <input
            type="month"
            value={bkMonth}
            onChange={(e) => setBkMonth(e.target.value)}
            className={`${inputCls} min-w-0 flex-1`}
          />
          <SecondaryButton size="sm" onClick={() => onMonthly('xlsx')} disabled={bkBusy}>
            Excel
          </SecondaryButton>
          <SecondaryButton size="sm" onClick={() => onMonthly('csv')} disabled={bkBusy}>
            CSV
          </SecondaryButton>
        </div>
      </div>
      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </Card>
  )
}

function MonthLockCard() {
  const { profile } = useAuth()
  const [locks, setLocks] = useState<string[]>([])
  const [showLocks, setShowLocks] = useState(false)
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
    <Card>
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
        <>
          <button
            type="button"
            onClick={() => setShowLocks((v) => !v)}
            aria-expanded={showLocks}
            className="mt-3 flex min-h-[44px] w-full items-center justify-between gap-2 rounded-xl bg-stone-50 px-3 py-2 text-left text-sm font-medium transition active:scale-[0.99] dark:bg-neutral-800/70"
          >
            <span>🔒 ပိတ်ထားသော လ: {locks.length} လ</span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`h-5 w-5 shrink-0 opacity-70 transition-transform ${showLocks ? 'rotate-180' : ''}`}
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <div
            aria-hidden={!showLocks}
            className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${showLocks ? '[grid-template-rows:1fr]' : '[grid-template-rows:0fr]'}`}
          >
            <div className="min-h-0 overflow-hidden">
              <ul className="space-y-1.5 pt-2.5 text-sm">
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
            </div>
          </div>
        </>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Dashboard: per-day figures, auto-refreshed per app_settings.refresh_seconds.
// ---------------------------------------------------------------------------

/** Tween a number toward its new value (400ms); instant when the user
 *  prefers reduced motion. Keeps auto-refresh updates readable. */
function useAnimatedNumber(value: number): number {
  const [display, setDisplay] = useState(value)
  const prevRef = useRef(value)
  useEffect(() => {
    const from = prevRef.current
    prevRef.current = value
    if (from === value) {
      setDisplay(value)
      return
    }
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(value)
      return
    }
    let raf = 0
    const start = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 400)
      setDisplay(Math.round(from + (value - from) * p))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return display
}

function AnimMoney({ value }: { value: number }) {
  const v = useAnimatedNumber(value)
  return <>{formatMMK(v)}</>
}

function AnimCount({ value }: { value: number }) {
  const v = useAnimatedNumber(value)
  return <>{v.toLocaleString('en-US')}</>
}

interface DayEntry {
  delivered_qty: number
  returned_qty: number
  amount: number
  amount_collected: number
  created_by: string | null
}

interface DayPayment {
  amount: number
  created_by: string | null
}

interface EmpSummary {
  id: string
  name: string
  trips: number
  out: number
  in: number
  cash: number
  debt: number
  payments: number
}

async function fetchDay<T>(table: string, columns: string, dateCol: string, date: string): Promise<T[]> {
  const pageSize = 1000
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq(dateCol, date)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const page = (data ?? []) as T[]
    out.push(...page)
    if (page.length < pageSize) break
  }
  return out
}

function Dashboard() {
  const { profile, roles } = useAuth()
  const [date, setDate] = useState(todayYangon())
  const [entries, setEntries] = useState<DayEntry[]>([])
  const [payments, setPayments] = useState<DayPayment[]>([])
  const [expenseTotal, setExpenseTotal] = useState(0)
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [refreshSec, setRefreshSec] = useState(30)

  const staffView = ['owner', 'manager', 'co_owner', 'staff'].some(
    (r) => roles.includes(r) || profile?.role === r,
  )

  const load = useCallback(async (d: string) => {
    try {
      const [en, pm, ex, profs] = await Promise.all([
        fetchDay<DayEntry>('daily_entries', 'delivered_qty, returned_qty, amount, amount_collected, created_by', 'entry_date', d),
        fetchDay<DayPayment>('agent_payments', 'amount, created_by', 'payment_date', d),
        fetchDay<{ amount: number }>('expenses', 'amount', 'expense_date', d),
        supabase.from('profiles').select('id, username, display_name'),
      ])
      setEntries(en)
      setPayments(pm)
      setExpenseTotal(ex.reduce((s, x) => s + Number(x.amount), 0))
      setNames(
        new Map(
          ((profs.data ?? []) as { id: string; username: string; display_name?: string | null }[]).map(
            (p) => [p.id, personName(p)] as const,
          ),
        ),
      )
      setMsg(null)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    setLoading(true)
    load(date)
  }, [load, date])

  // Read the auto-refresh interval once (seconds; seeded as 30).
  useEffect(() => {
    supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'refresh_seconds')
      .maybeSingle()
      .then(({ data }) => {
        const v = (data as { value: unknown } | null)?.value
        const secs = typeof v === 'number' ? v : Number(v)
        if (Number.isFinite(secs) && secs >= 5) setRefreshSec(secs)
      })
  }, [])

  const loadRef = useRef(load)
  loadRef.current = load
  const dateRef = useRef(date)
  dateRef.current = date
  useEffect(() => {
    if (!refreshSec) return
    const t = setInterval(() => {
      loadRef.current(dateRef.current)
    }, refreshSec * 1000)
    return () => clearInterval(t)
  }, [refreshSec])

  const figs = {
    trips: entries.length,
    out: entries.reduce((s, e) => s + e.delivered_qty, 0),
    in: entries.reduce((s, e) => s + e.returned_qty, 0),
    sales: entries.reduce((s, e) => s + Number(e.amount), 0),
    entryCash: entries.reduce((s, e) => s + Number(e.amount_collected), 0),
    payments: payments.reduce((s, p) => s + Number(p.amount), 0),
  }
  const netCash = figs.entryCash + figs.payments
  const netCashAfterExpenses = netCash - expenseTotal

  const empRows: EmpSummary[] = (() => {
    const m = new Map<string, EmpSummary>()
    const blank = (id: string): EmpSummary => ({
      id,
      name: names.get(id) ?? '—',
      trips: 0,
      out: 0,
      in: 0,
      cash: 0,
      debt: 0,
      payments: 0,
    })
    for (const e of entries) {
      const id = e.created_by ?? 'unknown'
      const r = m.get(id) ?? blank(id)
      r.trips += 1
      r.out += e.delivered_qty
      r.in += e.returned_qty
      r.cash += Number(e.amount_collected)
      r.debt += Number(e.amount) - Number(e.amount_collected)
      m.set(id, r)
    }
    for (const p of payments) {
      const id = p.created_by ?? 'unknown'
      const r = m.get(id) ?? blank(id)
      r.payments += Number(p.amount)
      m.set(id, r)
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  })()

  const dateInputCls =
    'min-h-[44px] rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/40 dark:border-neutral-700 dark:bg-neutral-900'

  return (
    <>
      <Card>
        <CardTitle
          action={
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={dateInputCls} />
          }
        >
          နေ့စဉ် မြင်ကွင်း
        </CardTitle>
        {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
        {loading ? (
          <LoadingState />
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-4">
              <StatCard
                label="ပို့ဆောင်မှု အရေအတွက်"
                value={
                  <>
                    <AnimCount value={figs.trips} /> ခု
                  </>
                }
              />
              <StatCard
                label="ပို့ဘူး စုစုပေါင်း"
                value={
                  <>
                    <AnimCount value={figs.out} /> ဘူး
                  </>
                }
              />
              <StatCard
                label="ဘူးခွံပြန် စုစုပေါင်း"
                value={
                  <>
                    <AnimCount value={figs.in} /> ဘူး
                  </>
                }
              />
              <StatCard label="ကျသင့်ငွေ" value={<AnimMoney value={figs.sales} />} />
              <StatCard label="ပို့ချိန် လက်ခံငွေ" value={<AnimMoney value={figs.entryCash} />} />
              <StatCard label="ကြွေးကောက်ငွေ" value={<AnimMoney value={figs.payments} />} />
              <StatCard
                label="လက်ခံငွေ စုစုပေါင်း"
                tone="brand"
                className="col-span-2 md:col-span-1"
                value={<AnimMoney value={netCash} />}
              />
              <StatCard label="အသုံးစရိတ်" value={<AnimMoney value={expenseTotal} />} />
              <StatCard
                label="အသားတင် ငွေ"
                tone={netCashAfterExpenses < 0 ? 'danger' : 'brand'}
                value={<AnimMoney value={netCashAfterExpenses} />}
              />
            </div>
            {/* Narrow phones: one full-width row each, icon beside the
                label, so the wording stays on one line. sm+ is wide
                enough for the original two-column row. */}
            <div className="mt-3 flex flex-col gap-2.5 sm:grid sm:grid-cols-2">
              <Link to="/entries" className={`${btnPrimaryCls} w-full`}>
                <NavIcon to="/entries" className="h-5 w-5 shrink-0" />
                <span className="min-w-0 text-center">ပို့ဆောင်မှု ထည့်ရန် / ကြည့်ရန်</span>
              </Link>
              <Link to="/payments" className={`${btnSecondaryCls} w-full`}>
                <NavIcon to="/payments" className="h-5 w-5 shrink-0" />
                <span className="min-w-0 text-center">ငွေကောက်ခံမှု</span>
              </Link>
            </div>
          </>
        )}
      </Card>

      {staffView && !loading && (
        <Card>
          <CardTitle>ဝန်ထမ်းအလိုက် အကျဉ်းချုပ်</CardTitle>
          {empRows.length === 0 ? (
            <p className="mt-3 text-sm text-stone-500 dark:text-neutral-400">
              ဤရက်တွင် မှတ်တမ်း မရှိပါ
            </p>
          ) : (
            <>
          {/* Phone: one card per employee. */}
          <div className="mt-3 space-y-2.5 md:hidden">
            {empRows.map((r) => (
              <div
                key={r.id}
                className="rounded-xl border border-stone-200/80 p-3 dark:border-neutral-800"
              >
                <div className="font-semibold">{r.name}</div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-stone-500 dark:text-neutral-400">ပို့အရေအတွက်</dt>
                    <dd className="tabular-nums">{r.trips}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-stone-500 dark:text-neutral-400">ပို့</dt>
                    <dd className="tabular-nums">{r.out}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-stone-500 dark:text-neutral-400">ပြန်</dt>
                    <dd className="tabular-nums">{r.in}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-stone-500 dark:text-neutral-400">လက်ခံငွေ</dt>
                    <dd className="tabular-nums">{formatMMK(r.cash)}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-stone-500 dark:text-neutral-400">ကျန်ကြွေး</dt>
                    <dd className={`tabular-nums ${r.debt > 0 ? 'font-semibold text-red-600 dark:text-red-400' : ''}`}>
                      {formatMMK(r.debt)}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-stone-500 dark:text-neutral-400">ကောက်ခံငွေ</dt>
                    <dd className="tabular-nums">{formatMMK(r.payments)}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
          {/* Tablet / desktop: table. */}
          <div className="mt-3 hidden overflow-x-auto md:block">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-left text-stone-500 dark:border-neutral-800 dark:text-neutral-400">
                  <th className="py-2 pr-2 font-medium">ဝန်ထမ်း</th>
                  <th className="py-2 pr-2 text-right font-medium">ပို့အရေအတွက်</th>
                  <th className="py-2 pr-2 text-right font-medium">ပို့</th>
                  <th className="py-2 pr-2 text-right font-medium">ပြန်</th>
                  <th className="py-2 pr-2 text-right font-medium">လက်ခံငွေ</th>
                  <th className="py-2 pr-2 text-right font-medium">ကျန်ကြွေး</th>
                  <th className="py-2 text-right font-medium">ကောက်ခံငွေ</th>
                </tr>
              </thead>
              <tbody>
                {empRows.map((r) => (
                  <tr key={r.id} className="border-b border-stone-100 last:border-0 dark:border-neutral-800/70">
                    <td className="py-2 pr-2 font-medium">{r.name}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{r.trips}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{r.out}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{r.in}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatMMK(r.cash)}</td>
                    <td className={`py-2 pr-2 text-right tabular-nums ${r.debt > 0 ? 'font-medium text-red-600 dark:text-red-400' : ''}`}>
                      {formatMMK(r.debt)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatMMK(r.payments)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
            </>
          )}
        </Card>
      )}
    </>
  )
}


/**
 * Agent home: the agent's OWN figures only — never the factory-wide
 * daily dashboard. Every query is filtered by the agent's own id in
 * the client as well (RLS also scopes the rows; the explicit filter
 * is required for the same index/timeout reason documented in
 * MyPage). No expenses, no factory net, no other agents or staff.
 *
 * Layout: own wallet face (same card as My Page) → today's figures →
 * own status → latest own records → full-detail link to My Page.
 */
interface LatestRecord {
  kind: 'entry' | 'payment'
  id: string
  date: string
  createdAt: string
  delivered: number
  returned: number
  amount: number
  /** Resolved receiver name (0041) when cash moved on this record. */
  receiver: string | null
}

function AgentHome() {
  const { profile } = useAuth()
  const agentId = profile?.agent_id ?? null
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [agent, setAgent] = useState<Agent | null>(null)
  const [cardTier, setCardTier] = useState<{ tier: FaceTier; lifetimeSales: number } | null>(null)
  const [latest, setLatest] = useState<LatestRecord[]>([])
  const [figs, setFigs] = useState({
    todayOut: 0,
    todayIn: 0,
    todaySales: 0,
    held: 0,
    depBottles: 0,
    depTotal: 0,
    outstanding: 0,
    lifetimeSales: 0,
    lifetimeCollected: 0,
  })

  const load = useCallback(async () => {
    if (!agentId) {
      setLoading(false)
      return
    }
    try {
      const today = todayYangon()
      const [en, pm, dep, ag, out, ct, dir] = await Promise.all([
        fetchAll<Pick<DailyEntry, 'id' | 'entry_date' | 'created_at' | 'delivered_qty' | 'returned_qty' | 'amount' | 'amount_collected' | 'created_by' | 'received_by'>>(
          (from, to) =>
            supabase
              .from('daily_entries')
              .select('*')
              .eq('agent_id', agentId)
              .order('entry_date', { ascending: false })
              .order('created_at', { ascending: false })
              .range(from, to),
        ),
        fetchAll<Pick<AgentPayment, 'id' | 'payment_date' | 'created_at' | 'amount' | 'created_by' | 'received_by'>>((from, to) =>
          supabase
            .from('agent_payments')
            .select('*')
            .eq('agent_id', agentId)
            .order('payment_date', { ascending: false })
            .order('created_at', { ascending: false })
            .range(from, to),
        ),
        fetchAll<Pick<AgentDeposit, 'bottles' | 'amount'>>((from, to) =>
          supabase
            .from('agent_deposits')
            .select('bottles, amount')
            .eq('agent_id', agentId)
            .order('id')
            .range(from, to),
        ),
        supabase.from('agents').select('*').eq('id', agentId).maybeSingle(),
        supabase.rpc('agent_outstanding', { p_agent: agentId }),
        supabase.rpc('my_card_tier'),
        fetchStaffDirectory(),
      ])
      const mine = en.filter((e) => e.entry_date === today)
      setFigs({
        todayOut: mine.reduce((s, e) => s + e.delivered_qty, 0),
        todayIn: mine.reduce((s, e) => s + e.returned_qty, 0),
        todaySales: mine.reduce((s, e) => s + Number(e.amount), 0),
        held: en.reduce((s, e) => s + e.delivered_qty - e.returned_qty, 0),
        depBottles: dep.reduce((s, d) => s + d.bottles, 0),
        depTotal: dep.reduce((s, d) => s + Number(d.amount), 0),
        outstanding: typeof out.data === 'number' ? out.data : 0,
        lifetimeSales: en.reduce((s, e) => s + Number(e.amount), 0),
        lifetimeCollected:
          en.reduce((s, e) => s + Number(e.amount_collected), 0) +
          pm.reduce((s, p) => s + Number(p.amount), 0),
      })
      setAgent((ag.data as Agent | null) ?? null)
      const tierRows = (ct.data ?? []) as { tier: FaceTier; lifetime_sales: number }[]
      setCardTier(
        tierRows[0]
          ? { tier: tierRows[0].tier, lifetimeSales: Number(tierRows[0].lifetime_sales) }
          : null,
      )
      // Latest own activity, entries and payments merged newest-first
      // (business date, then creation time within the day).
      const merged: LatestRecord[] = [
        ...en.map((e) => ({
          kind: 'entry' as const,
          id: e.id,
          date: e.entry_date,
          createdAt: e.created_at,
          delivered: e.delivered_qty,
          returned: e.returned_qty,
          amount: Number(e.amount),
          // Cash moved on an entry only when something was collected.
          receiver: Number(e.amount_collected) > 0 ? receiverName(dir, e) : null,
        })),
        ...pm.map((p) => ({
          kind: 'payment' as const,
          id: p.id,
          date: p.payment_date,
          createdAt: p.created_at,
          delivered: 0,
          returned: 0,
          amount: Number(p.amount),
          receiver: receiverName(dir, p),
        })),
      ].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
      setLatest(merged.slice(0, 5))
      setMsg(null)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [agentId])

  useEffect(() => {
    load()
  }, [load])

  if (!agentId) {
    return (
      <Card>
        <CardTitle>ကျွန်ုပ်၏ စာရင်း</CardTitle>
        <p className="mt-1 text-sm opacity-80">အကောင့် ချိတ်ဆက်မှု မရှိသေးပါ</p>
      </Card>
    )
  }

  // The agent's own wallet face (same card as My Page): the balance is
  // signed internally; a negative balance is an overpayment and shows
  // as ပိုပေးထားငွေ with a positive amount. A closed (settled) agent's
  // face is black with settled zeroes, as on My Page.
  const closed = agent?.closed_at != null
  const faceOutstanding = closed ? 0 : figs.outstanding
  const faceTier = cardTier ? FACE_TIERS[closed ? 'black' : cardTier.tier] : null

  return (
    <>
      {cardTier && faceTier && agent && (
        <div>
          <div
            style={{ background: faceTier.bg }}
            className={`relative flex h-[168px] w-full flex-col justify-between rounded-2xl p-4 shadow-card lg:h-[184px] ${faceTier.text} ${faceTier.extra}`}
          >
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0 font-semibold">
                {agent.name}
                {agent.code && (
                  <span className={`ml-2 text-xs font-normal ${faceTier.sub}`}>({agent.code})</span>
                )}
                {!agent.active && !agent.closed_at && (
                  <span className={`ml-2 text-xs ${faceTier.sub}`}>(ပိတ်ထားသည်)</span>
                )}
              </span>
              <span
                className={`shrink-0 font-bold tabular-nums ${faceOutstanding < 0 ? faceTier.neg : ''}`}
              >
                {formatMMK(Math.abs(faceOutstanding))}
              </span>
            </span>
            <span className="block space-y-1.5">
              <span className={`block text-xs ${faceTier.faint}`}>{faceOutstanding < 0 ? 'ပိုပေးထားငွေ' : 'ကျန်ကြွေ'}</span>
              <span className="block text-[28px] font-bold leading-[1.3] tabular-nums">
                {formatMMK(Math.abs(faceOutstanding))}
              </span>
              <span className={`block text-xs ${faceTier.sub}`}>
                ကျသင့်ငွေ {formatMMK(figs.lifetimeSales)} · ပေးချေပြီး {formatMMK(figs.lifetimeCollected)}
              </span>
            </span>
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute bottom-4 right-4 opacity-25 ${faceTier.text}`}
            >
              <svg width="52" height="36" viewBox="0 0 52 36" fill="none">
                <circle cx="18" cy="18" r="15" stroke="currentColor" strokeWidth="2" />
                <circle cx="34" cy="18" r="15" stroke="currentColor" strokeWidth="2" />
              </svg>
            </span>
          </div>
          <p className="mt-1.5 px-0.5 text-xs text-stone-500 dark:text-neutral-400">
            စုစုပေါင်း ကျသင့်ငွေ: {formatMMK(figs.lifetimeSales)}
          </p>
        </div>
      )}

      <Card>
        <CardTitle>ယနေ့ ကျွန်ုပ်၏ အကျဉ်းချုပ်</CardTitle>
        {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
        {loading ? (
          <LoadingState />
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <StatCard label="ယနေ့ ပို့ဘူး" value={`${figs.todayOut.toLocaleString('en-US')} ဗူး`} />
            <StatCard label="ယနေ့ ဘူးခွံပြန်" value={`${figs.todayIn.toLocaleString('en-US')} ဗူး`} />
            <StatCard label="ယနေ့ ကျသင့်ငွေ" value={formatMMK(figs.todaySales)} />
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>ကျွန်ုပ်၏ အခြေအနေ</CardTitle>
        {loading ? (
          <LoadingState />
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <StatCard
              label={figs.outstanding < 0 ? 'ပိုပေးထားငွေ' : 'စုစုပေါင်း ကျန်ကြွေး'}
              value={formatMMK(Math.abs(figs.outstanding))}
              tone="brand"
            />
            <StatCard label="ကိုင်ထားဘူး" value={`${figs.held.toLocaleString('en-US')} ဗူး`} />
            <StatCard
              label="အပေါင် စုစုပေါင်း"
              value={formatMMK(figs.depTotal)}
              sub={`${figs.depBottles.toLocaleString('en-US')} ဗူး`}
            />
            {agent && agent.deposit_per_bottle > 0 && (
              <StatCard
                label="ထပ်ယူနိုင်သောဘူး"
                value={`${Math.max(0, figs.depBottles - figs.held).toLocaleString('en-US')} ဗူး`}
              />
            )}
            {agent && (
              <StatCard label="ရောင်းဈေး" value={`${formatMMK(agent.default_unit_price)}/ဗူး`} />
            )}
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>နောက်ဆုံး မှတ်တမ်းများ</CardTitle>
        {loading ? (
          <LoadingState />
        ) : latest.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500 dark:text-neutral-400">မရှိသေးပါ</p>
        ) : (
          <ul className="mt-1 divide-y divide-stone-100 dark:divide-neutral-800/70">
            {latest.map((r) => (
              <li
                key={`${r.kind}:${r.id}`}
                className="flex items-baseline justify-between gap-2 py-2.5 text-sm"
              >
                <span className="min-w-0">
                  {r.kind === 'entry' ? (
                    <>
                      ပို့ဆောင်မှု — {r.delivered.toLocaleString('en-US')} ဗူး ပို့ ·{' '}
                      {r.returned.toLocaleString('en-US')} ဗူး ပြန်
                    </>
                  ) : (
                    <>ငွေပေးချေမှု</>
                  )}
                  <span className="block text-xs text-stone-500 dark:text-neutral-400">
                    {r.date}
                    {r.receiver ? ` · လက်ခံသူ ${r.receiver}` : ''}
                  </span>
                </span>
                <span className="shrink-0 font-semibold tabular-nums">
                  {formatMMK(r.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {!loading && (
        <Link to="/my" className={`${btnPrimaryCls} w-full`}>
          ကျွန်ုပ်၏ စာရင်း အပြည့်အစုံ
        </Link>
      )}
    </>
  )
}

export default function HomePage() {
  const { profile } = useAuth()
  const role = profile?.role

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="ပင်မ"
        subtitle={
          role === 'agent'
            ? 'ယနေ့ ကျသင့်ငွေ၊ ပေးချေငွေနှင့် လုပ်ရန်အလုပ်များ'
            : 'ယနေ့ ကျသင့်ငွေ၊ လက်ခံငွေနှင့် လုပ်ရန်အလုပ်များ'
        }
      />

      {role === 'agent' ? <AgentHome /> : <Dashboard />}

      {/* Management tools: visually demoted below the daily summary.
          PIN changes are not here. Only the owner sets a PIN, from the
          Users page, through admin_reset_pin. */}
      {(role === 'owner' || role === 'manager') && (
        <section className="space-y-3">
          <h2 className="px-0.5 text-base font-bold">စီမံခန့်ခွဲမှု</h2>
          <div className="grid items-start gap-4 lg:grid-cols-3">
            {role === 'owner' && <BackupCard />}
            <MonthLockCard />
          </div>
        </section>
      )}
    </div>
  )
}
