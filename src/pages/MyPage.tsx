import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { fetchAll } from '../lib/fetchAll'
import {
  formatMMK,
  personName,
  todayYangon,
  type Agent,
  type AgentPayment,
  type DailyEntry,
} from '../lib/types'
import { Banner, Card, LoadingState, PageHeader, StatCard, cardCls } from '../components/ui'

const MONTH_NAMES = [
  'ဇန်နဝါရီ', 'ဖေဖော်ဝါရီ', 'မတ်', 'ဧပြီ', 'မေ', 'ဇွန်',
  'ဇူလိုင်', 'ဩဂုတ်', 'စက်တင်ဘာ', 'အောက်တိုဘာ', 'နိုဝင်ဘာ', 'ဒီဇင်ဘာ',
]

/** "YYYY-MM" -> "မတ် 2026" style label (same naming as EntriesPage). */
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${MONTH_NAMES[m - 1]} ${y}`
}

const compactSelectCls =
  'min-h-[44px] rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/40 dark:border-neutral-700 dark:bg-neutral-900'

export default function MyPage() {
  const { profile } = useAuth()
  const agentId = profile?.agent_id ?? null
  const [entries, setEntries] = useState<DailyEntry[]>([])
  const [payments, setPayments] = useState<AgentPayment[]>([])
  const [depositTotal, setDepositTotal] = useState(0)
  const [agent, setAgent] = useState<Agent | null>(null)
  const [loading, setLoading] = useState(true)
  const [monthFilter, setMonthFilter] = useState('all')

  useEffect(() => {
    // RLS scopes every row to this agent automatically; no agent_id filter
    // is needed in the client for entries/payments (and adding one would not
    // widen access anyway). Deposits and the agent row are fetched by the
    // profile's linked agent_id.
    if (!agentId) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    Promise.all([
      fetchAll<DailyEntry>((from, to) =>
        supabase
          .from('daily_entries')
          .select('*')
          .order('entry_date', { ascending: false })
          .order('created_at', { ascending: false })
          .range(from, to),
      ),
      fetchAll<AgentPayment>((from, to) =>
        supabase
          .from('agent_payments')
          .select('*')
          .order('payment_date', { ascending: false })
          .order('created_at', { ascending: false })
          .range(from, to),
      ),
      supabase.from('agent_deposits').select('amount').eq('agent_id', agentId),
      supabase.from('agents').select('*').eq('id', agentId).maybeSingle(),
    ])
      .then(([en, pm, dep, ag]) => {
        if (cancelled) return
        setEntries(en)
        setPayments(pm)
        setDepositTotal(
          ((dep.data ?? []) as { amount: number }[]).reduce((s, d) => s + d.amount, 0),
        )
        setAgent((ag.data ?? null) as Agent | null)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  // Month filter options: "all" + every month present in the loaded data,
  // newest first (the EntriesPage monthOptions pattern).
  const monthOptions = useMemo(() => {
    const months = new Set<string>()
    entries.forEach((r) => months.add(r.entry_date.slice(0, 7)))
    payments.forEach((r) => months.add(r.payment_date.slice(0, 7)))
    return [
      { value: 'all', label: 'အားလုံး' },
      ...[...months]
        .sort()
        .reverse()
        .map((ym) => ({ value: ym, label: monthLabel(ym) })),
    ]
  }, [entries, payments])

  const visibleEntries =
    monthFilter === 'all'
      ? entries
      : entries.filter((r) => r.entry_date.startsWith(monthFilter))
  const visiblePayments =
    monthFilter === 'all'
      ? payments
      : payments.filter((r) => r.payment_date.startsWith(monthFilter))

  const today = todayYangon()
  const todayEntries = entries.filter((r) => r.entry_date === today)
  const todayDelivered = todayEntries.reduce((s, r) => s + r.delivered_qty, 0)
  const todayAmount = todayEntries.reduce((s, r) => s + r.amount, 0)

  const lifetimeDue = entries.reduce((s, r) => s + (r.amount - r.amount_collected), 0)
  const totalPayments = payments.reduce((s, r) => s + r.amount, 0)
  const owed = Math.max(0, lifetimeDue - totalPayments)
  const held = entries.reduce((s, r) => s + (r.delivered_qty - r.returned_qty), 0)

  // A closed (settled) agent keeps their history visible, but balances are
  // presented as settled zeroes, as the old app did.
  const closed = agent?.closed_at != null
  const shownOwed = closed ? 0 : owed
  const shownHeld = closed ? 0 : held
  const settledNote = closed ? 'စာရင်းပိတ် ပြီး ဖြစ်ပါသည်' : undefined

  const header = (
    <PageHeader
      title={
        <>
          ကျွန်ုပ်၏ စာရင်း — {profile ? personName(profile) : ''}
        </>
      }
      subtitle="ကိုယ်ပိုင် ပို့ဆောင်မှုနှင့် ပေးချေမှု မှတ်တမ်းများ"
    />
  )

  if (profile && !profile.agent_id) {
    return (
      <div className="space-y-4 lg:space-y-6">
        {header}
        <Card>
          <p className="text-sm">
            ဒီအကောင့်က ကိုယ်စားလှယ် မှတ်တမ်းနဲ့ မချိတ်ရသေးပါ — ပိုင်ရှင်ကို ဆက်သွယ်ပါ
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      {header}

      {closed && (
        <Banner tone="brand">ဒီ ကိုယ်စားလှယ် အကောင့်ကို စာရင်းပိတ် ပြီးပါပြီ</Banner>
      )}

      <section className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard label="ဒီနေ့" value={`${todayDelivered} ဗူး`} sub={formatMMK(todayAmount)} />
        <StatCard
          label="စုစုပေါင်း ကျန်ကြွေး"
          value={formatMMK(shownOwed)}
          sub={settledNote}
          tone={shownOwed > 0 ? 'danger' : 'default'}
        />
        <StatCard label="ကိုင်ထားဗူး" value={`${shownHeld} ဗူး`} sub={settledNote} />
        <StatCard label="အပေါင် စုစုပေါင်း" value={formatMMK(depositTotal)} />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="my-month-filter" className="text-sm font-medium">
          လ အလိုက် ကြည့်ရန်
        </label>
        <select
          id="my-month-filter"
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          className={compactSelectCls}
        >
          {monthOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <LoadingState />
      ) : (
        <>
          <section>
            <h2 className="mb-2 px-0.5 text-base font-bold">ပို့ဆောင်မှုများ</h2>
            <ul className={`${cardCls} divide-y divide-stone-100 overflow-hidden dark:divide-neutral-800/70`}>
              {visibleEntries.map((r) => {
                const due = r.amount - r.amount_collected
                return (
                  <li key={r.id} className="p-3.5 text-sm">
                    <div>
                      {r.entry_date} · ပို့ {r.delivered_qty} · ပြန် {r.returned_qty} ·{' '}
                      {formatMMK(r.amount)}
                    </div>
                    <div className="mt-0.5 text-stone-500 dark:text-neutral-400">
                      လက်ခံရရှိငွေ {formatMMK(r.amount_collected)} · ကျန်ပေးရန်{' '}
                      <span
                        className={
                          due > 0
                            ? 'font-semibold text-red-600 dark:text-red-400'
                            : 'font-medium'
                        }
                      >
                        {formatMMK(due)}
                      </span>
                    </div>
                  </li>
                )
              })}
              {visibleEntries.length === 0 && (
                <li className="p-3.5 text-sm text-stone-500 dark:text-neutral-400">
                  {monthFilter === 'all'
                    ? 'မရှိသေးပါ'
                    : 'ရွေးထားသော လတွင် မှတ်တမ် မရှိပါ'}
                </li>
              )}
            </ul>
          </section>
          <section>
            <h2 className="mb-2 px-0.5 text-base font-bold">ပေးချေမှုများ</h2>
            <ul className={`${cardCls} divide-y divide-stone-100 overflow-hidden dark:divide-neutral-800/70`}>
              {visiblePayments.map((r) => (
                <li key={r.id} className="p-3.5 text-sm">
                  {r.payment_date} · {formatMMK(r.amount)} · {r.method}
                </li>
              ))}
              {visiblePayments.length === 0 && (
                <li className="p-3.5 text-sm text-stone-500 dark:text-neutral-400">
                  {monthFilter === 'all'
                    ? 'မရှိသေးပါ'
                    : 'ရွေးထားသော လတွင် မှတ်တမ် မရှိပါ'}
                </li>
              )}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
