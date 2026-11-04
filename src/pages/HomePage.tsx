import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase, usernameToEmail } from '../lib/supabase'
import { exportBackup, getLastBackupAt, isBackupOverdue } from '../lib/backup'
import { dailySummaryCsv, monthlyBackupCsv, monthlyBackupXlsx } from '../lib/exports'
import { formatMMK, personName, todayYangon } from '../lib/types'
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
        နောက်ဆုံး backup: {last ? new Date(last).toLocaleString('my-MM') : 'တစ်ခါမှ မလုပ်ရသေးပါ'}
      </p>
      {overdue && (
        <p className="mt-1 text-sm font-medium text-amber-700 dark:text-amber-300">
          ⚠️ Backup လုပ်ရန် ကျန်နေပါတယ် — တစ်ပတ်မှာ တစ်ကြိမ်တော့ လုပ်ပေးပါ
        </p>
      )}
      <PrimaryButton onClick={onExport} disabled={busy} className="mt-3 w-full">
        {busy ? 'ထုတ်နေပါတယ်…' : '⬇ Backup ဒေါင်းလုပ်'}
      </PrimaryButton>
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
    if (!month) return
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

function PinChangeCard() {
  const { profile } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function onChange() {
    setMsg(null)
    if (!profile) return
    if (!/^\d{6,12}$/.test(next)) {
      setMsg('PIN အသစ်သည် ဂဏန်း ၆ လုံးမှ ၁၂ လုံးအတွင်း ဖြစ်ရပါမယ်')
      return
    }
    if (next !== confirm) {
      setMsg('PIN အသစ် နှစ်ခါ ရိုက်တာ မတူပါ')
      return
    }
    if (next === current) {
      setMsg('PIN အသစ်သည် လက်ရှိ PIN နှင့် မတူရပါ')
      return
    }
    setBusy(true)
    try {
      // Verify the current PIN by re-authenticating before changing it.
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: usernameToEmail(profile.username),
        password: current,
      })
      if (signInError) {
        setMsg('လက်ရှိ PIN မှားနေပါတယ်')
        return
      }
      const { error } = await supabase.auth.updateUser({ password: next })
      if (error) throw error
      setCurrent('')
      setNext('')
      setConfirm('')
      setMsg('PIN ပြောင်းပြီးပါပြီ — နောက်တစ်ခါ login ဝင်ရင် PIN အသစ် သုံးပါ')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'PIN ပြောင်း၍ မရပါ')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardTitle>ကိုယ့် PIN ပြောင်းရန်</CardTitle>
      <div className="mt-3 space-y-2">
        <input
          className={inputCls}
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          placeholder="လက်ရှိ PIN"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <input
          className={inputCls}
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          placeholder="PIN အသစ် (ဂဏန်း ၆–၁၂ လုံး)"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <input
          className={inputCls}
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          placeholder="PIN အသစ် ထပ်ရိုက်ပါ"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <PrimaryButton
          className="w-full"
          onClick={onChange}
          disabled={busy || !current || !next || !confirm}
        >
          {busy ? 'ပြောင်းနေသည်…' : 'PIN ပြောင်းမည်'}
        </PrimaryButton>
        {msg && <p className="text-sm opacity-80">{msg}</p>}
      </div>
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
  const [csvBusy, setCsvBusy] = useState(false)
  const [csvMsg, setCsvMsg] = useState<string | null>(null)
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

  async function onDailyCsv() {
    setCsvBusy(true)
    setCsvMsg(null)
    try {
      const filename = await dailySummaryCsv(date)
      setCsvMsg(`${filename} ကို ဒေါင်းလုပ် လုပ်ပြီးပါပြီ`)
    } catch (e) {
      setCsvMsg(e instanceof Error ? e.message : 'CSV ထုတ်၍ မရပါ')
    }
    setCsvBusy(false)
  }

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
              <StatCard label="ရောင်းငွေ" value={<AnimMoney value={figs.sales} />} />
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
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <Link to="/entries" className={btnPrimaryCls}>
                <NavIcon to="/entries" className="h-5 w-5" />
                ပို့ဆောင်မှု ထည့်ရန် / ကြည့်ရန်
              </Link>
              <Link to="/payments" className={btnSecondaryCls}>
                <NavIcon to="/payments" className="h-5 w-5" />
                ငွေကောက်ခံမှု
              </Link>
            </div>
            {staffView && (
              <div className="mt-3">
                <SecondaryButton onClick={onDailyCsv} disabled={csvBusy} className="w-full">
                  {csvBusy ? 'ထုတ်နေပါတယ်…' : `⬇ နေ့စဉ် CSV (${date})`}
                </SecondaryButton>
                {csvMsg && <p className="mt-2 text-sm">{csvMsg}</p>}
              </div>
            )}
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

export default function HomePage() {
  const { profile } = useAuth()
  const role = profile?.role

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader title="ပင်မ" subtitle="ယနေ့ ရောင်းအား၊ လက်ခံငွေနှင့် လုပ်ရန်အလုပ်များ" />

      <Dashboard />

      {role === 'agent' && (
        <Card>
          <CardTitle>ကျွန်ုပ်၏ စာရင်း</CardTitle>
          <p className="mt-1 text-sm opacity-80">သင့်ရဲ့ ကိုယ်ပိုင် မှတ်တမ်းများကိုပဲ မြင်ရပါမယ်။</p>
          <Link to="/my" className={`${btnPrimaryCls} mt-3 w-full`}>
            ကြည့်ရန်
          </Link>
        </Card>
      )}

      {/* Management tools: visually demoted below the daily summary. */}
      {profile && (
        <section className="space-y-3">
          <h2 className="px-0.5 text-base font-bold">စီမံခန့်ခွဲမှု</h2>
          <div className="grid items-start gap-4 lg:grid-cols-3">
            {role === 'owner' && <BackupCard />}
            {(role === 'owner' || role === 'manager') && <MonthLockCard />}
            <PinChangeCard />
          </div>
        </section>
      )}
    </div>
  )
}
