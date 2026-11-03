import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase, usernameToEmail } from '../lib/supabase'
import { exportBackup, getLastBackupAt, isBackupOverdue } from '../lib/backup'
import { dailySummaryCsv, monthlyBackupCsv, monthlyBackupXlsx } from '../lib/exports'
import { formatMMK, todayYangon } from '../lib/types'

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
    <section
      className={`rounded-2xl border p-4 ${overdue ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/40' : ''}`}
    >
      <h2 className="font-semibold">ဒေတာ Backup</h2>
      <p className="mt-1 text-sm opacity-80">
        နောက်ဆုံး backup: {last ? new Date(last).toLocaleString('my-MM') : 'တစ်ခါမှ မလုပ်ရသေးပါ'}
      </p>
      {overdue && (
        <p className="mt-1 text-sm font-medium text-amber-700 dark:text-amber-300">
          ⚠️ Backup လုပ်ရန် ကျန်နေပါတယ် — တစ်ပတ်မှာ တစ်ကြိမ်တော့ လုပ်ပေးပါ
        </p>
      )}
      <button
        onClick={onExport}
        disabled={busy}
        className="mt-3 w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white disabled:opacity-60"
      >
        {busy ? 'ထုတ်နေပါတယ်…' : '⬇ Backup ဒေါင်းလုပ်'}
      </button>
      <div className="mt-4 border-t pt-3">
        <p className="text-sm font-medium">လစဉ် မှတ်တမ်း ထုတ်ရန် (စာရင်းကိုင် အတွက်)</p>
        <div className="mt-2 flex gap-2">
          <input
            type="month"
            value={bkMonth}
            onChange={(e) => setBkMonth(e.target.value)}
            className="min-w-0 flex-1 rounded-xl border bg-transparent px-3 py-2.5"
          />
          <button
            onClick={() => onMonthly('xlsx')}
            disabled={bkBusy}
            className="rounded-xl bg-neutral-200 px-3 py-2.5 text-sm font-medium disabled:opacity-60 dark:bg-neutral-800"
          >
            Excel
          </button>
          <button
            onClick={() => onMonthly('csv')}
            disabled={bkBusy}
            className="rounded-xl bg-neutral-200 px-3 py-2.5 text-sm font-medium disabled:opacity-60 dark:bg-neutral-800"
          >
            CSV
          </button>
        </div>
      </div>
      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </section>
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
    <section className="rounded-2xl border p-4">
      <h2 className="font-semibold">လ ပိတ်ခြင်း (Month Lock)</h2>
      <p className="mt-1 text-sm opacity-80">
        ပိတ်ထားသော လအတွင်း မည်သည့် မှတ်တမ်ကိုမှ ပြင်/ဖျက်/ထည့် လုပ်၍ မရပါ (ပိုင်ရှင် အပါအဝင်)။
      </p>
      <div className="mt-3 flex gap-2">
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="flex-1 rounded-xl border px-3 py-2 dark:bg-neutral-900"
        />
        <button onClick={onLock} className="rounded-xl bg-teal-700 px-4 py-2 font-semibold text-white">
          ပိတ်ရန်
        </button>
      </div>
      {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
      {locks.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {locks.map((m) => (
            <li key={m} className="flex items-center justify-between">
              <span>🔒 {m.slice(0, 7)}</span>
              {profile?.role === 'owner' && (
                <button onClick={() => onUnlock(m)} className="rounded-lg border px-2.5 py-1">
                  ပြန်ဖွင့်ရန်
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
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

  const inputCls =
    'w-full rounded-xl border bg-transparent px-3 py-2 text-sm outline-none focus:ring'
  return (
    <section className="rounded-2xl border p-4">
      <h2 className="font-semibold">ကိုယ့် PIN ပြောင်းရန်</h2>
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
        <button
          className="w-full rounded-xl bg-neutral-900 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          onClick={onChange}
          disabled={busy || !current || !next || !confirm}
        >
          {busy ? 'ပြောင်းနေသည်…' : 'PIN ပြောင်းမည်'}
        </button>
        {msg && <p className="text-sm opacity-80">{msg}</p>}
      </div>
    </section>
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
        supabase.from('profiles').select('id, username'),
      ])
      setEntries(en)
      setPayments(pm)
      setExpenseTotal(ex.reduce((s, x) => s + Number(x.amount), 0))
      setNames(
        new Map(((profs.data ?? []) as { id: string; username: string }[]).map((p) => [p.id, p.username])),
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

  const statCls = 'rounded-xl bg-neutral-100 p-3 dark:bg-neutral-800'
  const statLabel = 'text-xs opacity-70'
  const statValue = 'mt-1 font-bold'

  return (
    <>
      <section className="rounded-2xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">နေ့စဉ် မြင်ကွင်း</h2>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-xl border px-3 py-2 text-sm dark:bg-neutral-900"
          />
        </div>
        {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
        {loading ? (
          <p className="mt-3 text-sm opacity-70">ခဏစောင့်ပါ…</p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              <div className={statCls}>
                <div className={statLabel}>ပို့ဆောင်မှု အရေအတွက်</div>
                <div className={statValue}>
                  <AnimCount value={figs.trips} /> ခု
                </div>
              </div>
              <div className={statCls}>
                <div className={statLabel}>ပို့ဘူး စုစုပေါင်း</div>
                <div className={statValue}>
                  <AnimCount value={figs.out} /> ဘူး
                </div>
              </div>
              <div className={statCls}>
                <div className={statLabel}>ဘူးခွံပြန် စုစုပေါင်း</div>
                <div className={statValue}>
                  <AnimCount value={figs.in} /> ဘူး
                </div>
              </div>
              <div className={statCls}>
                <div className={statLabel}>ရောင်းငွေ</div>
                <div className={statValue}>
                  <AnimMoney value={figs.sales} />
                </div>
              </div>
              <div className={statCls}>
                <div className={statLabel}>ပို့ချိန် လက်ခံငွေ</div>
                <div className={statValue}>
                  <AnimMoney value={figs.entryCash} />
                </div>
              </div>
              <div className={statCls}>
                <div className={statLabel}>ကြွေးကောက်ငွေ</div>
                <div className={statValue}>
                  <AnimMoney value={figs.payments} />
                </div>
              </div>
              <div className={`${statCls} col-span-2 sm:col-span-1`}>
                <div className={statLabel}>လက်ခံငွေ စုစုပေါင်း</div>
                <div className={`${statValue} text-teal-700 dark:text-teal-300`}>
                  <AnimMoney value={netCash} />
                </div>
              </div>
              <div className={statCls}>
                <div className={statLabel}>အသုံးစရိတ်</div>
                <div className={statValue}>
                  <AnimMoney value={expenseTotal} />
                </div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-center text-sm">
              <Link to="/entries" className="rounded-xl bg-neutral-100 py-3 dark:bg-neutral-800">
                ပို့ဆောင်မှု ထည့်ရန် / ကြည့်ရန်
              </Link>
              <Link to="/payments" className="rounded-xl bg-neutral-100 py-3 dark:bg-neutral-800">
                ငွေကောက်ခံမှု
              </Link>
            </div>
            {staffView && (
              <div className="mt-3">
                <button
                  onClick={onDailyCsv}
                  disabled={csvBusy}
                  className="w-full rounded-xl border py-2.5 font-semibold disabled:opacity-60"
                >
                  {csvBusy ? 'ထုတ်နေပါတယ်…' : `⬇ နေ့စဉ် CSV (${date})`}
                </button>
                {csvMsg && <p className="mt-2 text-sm">{csvMsg}</p>}
              </div>
            )}
          </>
        )}
      </section>

      {staffView && !loading && empRows.length > 0 && (
        <section className="rounded-2xl border p-4">
          <h2 className="font-semibold">ဝန်ထမ်းအလိုက် အကျဉ်းချုပ်</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b text-left opacity-70">
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
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-2 font-medium">{r.name}</td>
                    <td className="py-2 pr-2 text-right">{r.trips}</td>
                    <td className="py-2 pr-2 text-right">{r.out}</td>
                    <td className="py-2 pr-2 text-right">{r.in}</td>
                    <td className="py-2 pr-2 text-right">{formatMMK(r.cash)}</td>
                    <td className={`py-2 pr-2 text-right ${r.debt > 0 ? 'font-medium text-red-600' : ''}`}>
                      {formatMMK(r.debt)}
                    </td>
                    <td className="py-2 text-right">{formatMMK(r.payments)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  )
}

export default function HomePage() {
  const { profile } = useAuth()
  const role = profile?.role

  return (
    <div className="space-y-4">
      <Dashboard />

      {role === 'agent' && (
        <section className="rounded-2xl border p-4">
          <h2 className="font-semibold">ကျွန်ုပ်၏ စာရင်း</h2>
          <p className="mt-1 text-sm opacity-80">သင့်ရဲ့ ကိုယ်ပိုင် မှတ်တမ်းများကိုပဲ မြင်ရပါမယ်။</p>
          <Link
            to="/my"
            className="mt-3 block rounded-xl bg-teal-700 py-2.5 text-center font-semibold text-white"
          >
            ကြည့်ရန်
          </Link>
        </section>
      )}

      {role === 'owner' && <BackupCard />}
      {(role === 'owner' || role === 'manager') && <MonthLockCard />}
      {profile && <PinChangeCard />}
    </div>
  )
}
