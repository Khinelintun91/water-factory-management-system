import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { fetchAll } from '../lib/fetchAll'
import {
  formatMMK,
  personName,
  todayYangon,
  type Agent,
  type AgentDeposit,
  type AgentPayment,
  type DailyEntry,
  type WriteOff,
} from '../lib/types'
import { FACE_TIERS, type FaceTier } from '../lib/cardFace'
import {
  Banner,
  Card,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  StatCard,
  cardCls,
  inputCls,
} from '../components/ui'

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
  const [writeOffTotal, setWriteOffTotal] = useState(0)
  const [depositTotal, setDepositTotal] = useState(0)
  const [agent, setAgent] = useState<Agent | null>(null)
  const [cardTier, setCardTier] = useState<{ tier: FaceTier; rank: number; count: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [monthFilter, setMonthFilter] = useState('all')
  // Per-record dispute filing (live old-app parity): an agent can flag one
  // specific delivery/payment row from this page. filedKeys is session-only
  // state — a successful insert flips that row's button to its filed state.
  const [disputeKey, setDisputeKey] = useState<string | null>(null)
  const [disputeText, setDisputeText] = useState('')
  const [disputeMsg, setDisputeMsg] = useState<string | null>(null)
  const [disputeBusy, setDisputeBusy] = useState(false)
  const [disputeOk, setDisputeOk] = useState<string | null>(null)
  const [filedKeys, setFiledKeys] = useState<ReadonlySet<string>>(new Set())
  const runRef = useRef(0)

  const load = useCallback(async () => {
    if (!agentId) {
      setLoading(false)
      return
    }
    const run = ++runRef.current
    setLoading(true)
    setLoadError(false)
    try {
      // The explicit agent_id filter is REQUIRED, not just an optimisation:
      // RLS scopes the rows, but its policy helpers (app_role / app_agent_id)
      // are security-definer functions Postgres evaluates once per scanned
      // row. Without the filter the query scans EVERY agent's history
      // (~12k rows) before discarding all but this agent's, which overruns
      // the API timeout — the request errors, and the old catch-all silently
      // left every total at zero. With the filter, Postgres drives the query
      // from the (agent_id, date) index and only this agent's rows are ever
      // touched. RLS still applies on top, so access is unchanged.
      const [en, pm, wo, dep, ag, ct] = await Promise.all([
        fetchAll<DailyEntry>((from, to) =>
          supabase
            .from('daily_entries')
            .select('*')
            .eq('agent_id', agentId)
            .order('entry_date', { ascending: false })
            .order('created_at', { ascending: false })
            .range(from, to),
        ),
        fetchAll<AgentPayment>((from, to) =>
          supabase
            .from('agent_payments')
            .select('*')
            .eq('agent_id', agentId)
            .order('payment_date', { ascending: false })
            .order('created_at', { ascending: false })
            .range(from, to),
        ),
        fetchAll<Pick<WriteOff, 'amount'>>((from, to) =>
          supabase
            .from('write_offs')
            .select('amount')
            .eq('agent_id', agentId)
            .order('writeoff_date', { ascending: false })
            .order('created_at', { ascending: false })
            .range(from, to),
        ),
        fetchAll<Pick<AgentDeposit, 'amount'>>((from, to) =>
          supabase
            .from('agent_deposits')
            .select('amount')
            .eq('agent_id', agentId)
            .order('id')
            .range(from, to),
        ),
        supabase.from('agents').select('*').eq('id', agentId).maybeSingle(),
        supabase.rpc('my_card_tier'),
      ])
      if (runRef.current !== run) return
      setEntries(en)
      setPayments(pm)
      setWriteOffTotal(wo.reduce((s, w) => s + w.amount, 0))
      setDepositTotal(dep.reduce((s, d) => s + d.amount, 0))
      setAgent((ag.data ?? null) as Agent | null)
      const tierRows = (ct.data ?? []) as { tier: FaceTier; sales_rank: number; agent_count: number }[]
      setCardTier(
        tierRows[0]
          ? { tier: tierRows[0].tier, rank: tierRows[0].sales_rank, count: tierRows[0].agent_count }
          : null,
      )
    } catch {
      // Never fail silently into plausible-looking zeroes again: surface the
      // failure with a retry instead.
      if (runRef.current === run) setLoadError(true)
    } finally {
      if (runRef.current === run) setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    void load()
  }, [load])

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
  // Owner-side debt ledger (CollectionsPage) nets write-offs against the
  // balance, so the agent's own card must too — otherwise the two sides
  // disagree by exactly the written-off amount.
  const owed = Math.max(0, lifetimeDue - totalPayments - writeOffTotal)
  const held = entries.reduce((s, r) => s + (r.delivered_qty - r.returned_qty), 0)

  // A closed (settled) agent keeps their history visible, but balances are
  // presented as settled zeroes, as the old app did.
  const closed = agent?.closed_at != null
  const shownOwed = closed ? 0 : owed
  const shownHeld = closed ? 0 : held
  const settledNote = closed ? 'စာရင်းပိတ် ပြီး ဖြစ်ပါသည်' : undefined

  // The agent's own wallet face (same card as the owner's Collections
  // stack): lifetime sales / collected from this page's loaded rows. The
  // balance is signed internally; when it is negative the agent has
  // overpaid, and both sides display it as ပိုပေးထားငွေ with a positive
  // amount (owner's wording rule — overpayment is not a debt or an error).
  const salesTotal = entries.reduce((s, r) => s + r.amount, 0)
  const collectedTotal = entries.reduce((s, r) => s + r.amount_collected, 0) + totalPayments
  const faceOutstanding = closed ? 0 : lifetimeDue - totalPayments - writeOffTotal
  const faceTier = cardTier ? FACE_TIERS[closed ? 'black' : cardTier.tier] : null

  function openDispute(key: string) {
    setDisputeKey(key)
    setDisputeText('')
    setDisputeMsg(null)
    setDisputeOk(null)
  }

  function closeDispute() {
    setDisputeKey(null)
    setDisputeText('')
    setDisputeMsg(null)
  }

  async function submitDispute(target: {
    key: string
    kind: 'entry' | 'payment'
    recordId: string
    recordDate: string
    summary: string
  }) {
    if (!agentId) return
    const text = disputeText.trim()
    if (!text) {
      setDisputeMsg('အမှား အသေးစိတ် စာသား ရေးပါ')
      return
    }
    setDisputeBusy(true)
    setDisputeMsg(null)
    // Same insert path as DisputesPage's agent form (RLS scopes the insert
    // to this agent); kind 'entry'/'payment' pins the dispute to the
    // specific row so owner/manager see exactly which record is being
    // questioned. (The disputes_kind_check constraint allows only those
    // two values — a generic 'record' kind is rejected by the database.)
    const { error } = await supabase.from('disputes').insert({
      agent_id: agentId,
      kind: target.kind,
      record_id: target.recordId,
      record_date: target.recordDate,
      record_summary: target.summary,
      message: text,
    })
    setDisputeBusy(false)
    if (error) {
      setDisputeMsg(
        error.code === '23505'
          ? 'ဒီမှတ်တမ်အတွက် အမှားတင်ပြချက် ဖွင့်ထားပြီး ဖြစ်ပါတယ်'
          : `တင်ပြ၍ မရပါ: ${error.message}`,
      )
      return
    }
    setFiledKeys((s) => new Set(s).add(target.key))
    closeDispute()
    setDisputeOk('အမှားတင်ပြချက် ပို့ပြီးပါပြီ')
  }

  /** The per-row dispute button, or its inline compose when open, or the
   *  disabled filed state after a successful submit this session. */
  function renderDispute(target: {
    key: string
    kind: 'entry' | 'payment'
    recordId: string
    recordDate: string
    summary: string
  }) {
    if (filedKeys.has(target.key)) {
      return (
        <div className="mt-1.5">
          <SecondaryButton size="sm" disabled>
            အမှားတင်ပြပြီး
          </SecondaryButton>
        </div>
      )
    }
    return (
      <div className="mt-1.5">
        {disputeKey === target.key ? (
          <div className="space-y-2">
            <textarea
              value={disputeText}
              onChange={(e) => setDisputeText(e.target.value)}
              rows={2}
              placeholder="အမှား အသေးစိတ် ရေးပါ"
              className={inputCls}
            />
            {disputeMsg && (
              <p className="text-sm text-red-600" role="alert">
                {disputeMsg}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                size="sm"
                disabled={disputeBusy}
                onClick={() => void submitDispute(target)}
              >
                တင်ပြရန်
              </PrimaryButton>
              <SecondaryButton size="sm" onClick={closeDispute}>
                မလုပ်တော့ပါ
              </SecondaryButton>
            </div>
          </div>
        ) : (
          <SecondaryButton size="sm" onClick={() => openDispute(target.key)}>
            အမှားတင်ပြ
          </SecondaryButton>
        )}
      </div>
    )
  }

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

      {loadError && !loading && (
        <Banner
          tone="red"
          action={
            <SecondaryButton onClick={() => void load()} className="shrink-0">
              ပြန်စမ်းကြည့်ပါ
            </SecondaryButton>
          }
        >
          မှတ်တမ်းများ ဖွင့်၍ မရပါ
        </Banner>
      )}

      {disputeOk && !loading && <Banner tone="brand">{disputeOk}</Banner>}

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
              <span className="block text-[28px] font-bold leading-tight tabular-nums">
                {formatMMK(Math.abs(faceOutstanding))}
              </span>
              <span className={`block text-xs ${faceTier.sub}`}>
                ရောင်းအား {formatMMK(salesTotal)} · ကောက်ခံပြီး {formatMMK(collectedTotal)}
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
            ရောင်းအား အဆင့်: {cardTier.rank} / {cardTier.count}
          </p>
        </div>
      )}

      <section className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard label="ဒီနေ့" value={`${todayDelivered} ဗူး`} sub={formatMMK(todayAmount)} />
        <StatCard
          label={faceOutstanding < 0 ? 'ပိုပေးထားငွေ' : 'စုစုပေါင်း ကျန်ကြွေး'}
          value={formatMMK(faceOutstanding < 0 ? -faceOutstanding : shownOwed)}
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
                    {renderDispute({
                      key: `entry:${r.id}`,
                      kind: 'entry',
                      recordId: r.id,
                      recordDate: r.entry_date,
                      summary: `${r.entry_date} · ပို့ ${r.delivered_qty} · ပြန် ${r.returned_qty} · ${formatMMK(r.amount)} · လက်ခံရရှိငွေ ${formatMMK(r.amount_collected)}`,
                    })}
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
                  <div>
                    {r.payment_date} · {formatMMK(r.amount)} · {r.method}
                  </div>
                  {renderDispute({
                    key: `payment:${r.id}`,
                    kind: 'payment',
                    recordId: r.id,
                    recordDate: r.payment_date,
                    summary: `${r.payment_date} · ${formatMMK(r.amount)} · ${r.method}`,
                  })}
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
