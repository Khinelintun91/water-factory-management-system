import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { dailySummaryCsv } from '../lib/exports'
import { formatMMK, personName, todayYangon, type Agent, type Profile } from '../lib/types'
import { FACE_TIERS, salesTierMap } from '../lib/cardFace'
import {
  Banner,
  Card,
  CardTitle,
  EmptyState,
  Field,
  LoadingState,
  PageHeader,
  SecondaryButton,
  cardCls,
  inputCls,
} from '../components/ui'

// Display labels for the stored payment-method values (same words as the
// PaymentsPage form's <option> labels).
const METHOD_LABELS: Record<string, string> = {
  cash: 'ငွေသား',
  kpay: 'KBZPay',
  wave: 'WavePay',
  kbzpay: 'KBZPay',
  wavepay: 'WavePay',
  bank: 'ဘဏ်',
}

const detailBtnCls =
  'inline-flex min-h-[40px] shrink-0 items-center rounded-lg bg-brand-50 px-3.5 font-medium text-brand-700 transition active:scale-[0.98] dark:bg-brand-950/50 dark:text-brand-300'

// Row shapes for the collections datasets (columns added by migration 0006
// are not in lib/types yet, so the page defines what it reads locally).
interface EntryLite {
  id: string
  agent_id: string | null
  entry_date: string
  delivered_qty: number
  returned_qty: number
  amount: number
  amount_collected: number
  created_at: string
}

interface PaymentRow {
  id: string
  agent_id: string | null
  agent_name: string | null
  payment_date: string
  amount: number
  method: string
  notes: string | null
  created_by: string | null
  created_at: string
}

interface WriteOffLite {
  id: string
  agent_id: string | null
  writeoff_date: string
  amount: number
  created_at: string
}

interface AgentTotals {
  sales: number
  cash: number
  payments: number
  writeOffs: number
  outstanding: number
}

interface LedgerLine {
  key: string
  date: string
  label: string
  detail: string
  delta: number
}

const PAGE_SIZE = 1000

/**
 * Fetch agent_payments with the report filters applied server-side,
 * paging past the 1,000-row cap. Ordered newest first, exactly like the
 * client-side sort this replaces (payment_date, then created_at; id is
 * only a paging tiebreak).
 */
async function fetchPaymentsFiltered(f: {
  agent: string
  from: string
  to: string
  by: string
}): Promise<PaymentRow[]> {
  const out: PaymentRow[] = []
  for (let start = 0; ; start += PAGE_SIZE) {
    let q = supabase
      .from('agent_payments')
      .select(
        'id, agent_id, agent_name, payment_date, amount, method, notes, created_by, created_at',
      )
      .order('payment_date', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
    if (f.agent) q = q.eq('agent_id', f.agent)
    if (f.from) q = q.gte('payment_date', f.from)
    if (f.to) q = q.lte('payment_date', f.to)
    if (f.by) q = q.eq('created_by', f.by)
    const { data, error } = await q.range(start, start + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const page = (data ?? []) as PaymentRow[]
    out.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return out
}

/** Fetch one agent's rows from a table, paging past the 1,000-row cap. */
async function fetchAgentRows<T>(table: string, columns: string, agentId: string): Promise<T[]> {
  const out: T[] = []
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq('agent_id', agentId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(start, start + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const page = (data ?? []) as T[]
    out.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return out
}

/** One agent's raw rows, loaded on demand for the expanded ledger. */
interface LedgerSource {
  entries: EntryLite[]
  payments: PaymentRow[]
  writeOffs: WriteOffLite[]
}


export default function CollectionsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  // Per-agent all-time totals from the collections_summary RPC (0021).
  const [totals, setTotals] = useState<Map<string, AgentTotals>>(new Map())
  // Report-list payments, fetched with the filters applied server-side.
  const [payments, setPayments] = useState<PaymentRow[]>([])
  // Raw rows for the expanded agent's ledger, loaded on demand per agent.
  const [ledger, setLedger] = useState<Record<string, LedgerSource>>({})
  const [profiles, setProfiles] = useState<Pick<Profile, 'id' | 'username' | 'display_name'>[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [csvBusy, setCsvBusy] = useState(false)
  const [csvMsg, setCsvMsg] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Which agent's card body is open. Cards start collapsed to a name row so
  // the page is a compact stacked list; tapping a name opens its full card.
  const [openId, setOpenId] = useState<string | null>(null)

  // Collections-report filters.
  const [fAgent, setFAgent] = useState('')
  const [fFrom, setFFrom] = useState('')
  const [fTo, setFTo] = useState('')
  const [fBy, setFBy] = useState('')
  const [reportShown, setReportShown] = useState(100)
  const [ledgerShown, setLedgerShown] = useState(100)

  useEffect(() => {
    setReportShown(100)
  }, [fAgent, fFrom, fTo, fBy])
  useEffect(() => {
    setLedgerShown(100)
  }, [expandedId])

  const load = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const [{ data: ag, error: agErr }, { data: sum, error: sumErr }, { data: pf, error: pfErr }] =
        await Promise.all([
          supabase.from('agents').select('*').order('created_at'),
          supabase.rpc('collections_summary'),
          supabase.from('profiles').select('id, username, display_name').order('username'),
        ])
      if (agErr) throw new Error(agErr.message)
      if (sumErr) throw new Error(sumErr.message)
      if (pfErr) throw new Error(pfErr.message)
      setAgents((ag ?? []) as Agent[])
      // The RPC aggregates server-side; its all-time outstanding column
      // is agent_outstanding() itself, so these cards can never drift
      // from the per-agent balance used elsewhere.
      const m = new Map<string, AgentTotals>()
      for (const r of (sum ?? []) as {
        agent_id: string
        sales: number
        cash: number
        payments: number
        write_offs: number
        outstanding: number
      }[]) {
        m.set(r.agent_id, {
          sales: Number(r.sales) || 0,
          cash: Number(r.cash) || 0,
          payments: Number(r.payments) || 0,
          writeOffs: Number(r.write_offs) || 0,
          outstanding: Number(r.outstanding) || 0,
        })
      }
      setTotals(m)
      setProfiles((pf ?? []) as Pick<Profile, 'id' | 'username' | 'display_name'>[])
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Report list: refetch whenever a filter changes, with the filters in
  // the query (previously every payment was downloaded and filtered in
  // the browser).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const rows = await fetchPaymentsFiltered({ agent: fAgent, from: fFrom, to: fTo, by: fBy })
        if (!cancelled) setPayments(rows)
      } catch (err) {
        if (!cancelled) setMsg(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fAgent, fFrom, fTo, fBy])

  // Expanded ledger: fetch that one agent's rows only, once, on expand.
  useEffect(() => {
    if (!expandedId || ledger[expandedId]) return
    let cancelled = false
    ;(async () => {
      try {
        const [en, pm, wo] = await Promise.all([
          fetchAgentRows<EntryLite>(
            'daily_entries',
            'id, agent_id, entry_date, delivered_qty, returned_qty, amount, amount_collected, created_at',
            expandedId,
          ),
          fetchAgentRows<PaymentRow>(
            'agent_payments',
            'id, agent_id, agent_name, payment_date, amount, method, notes, created_by, created_at',
            expandedId,
          ),
          fetchAgentRows<WriteOffLite>(
            'write_offs',
            'id, agent_id, writeoff_date, amount, created_at',
            expandedId,
          ),
        ])
        if (!cancelled) {
          setLedger((prev) => ({ ...prev, [expandedId]: { entries: en, payments: pm, writeOffs: wo } }))
        }
      } catch (err) {
        if (!cancelled) setMsg(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [expandedId, ledger])

  // Daily CSV export, wired the same way as HomePage's button. This page
  // has no single selected date (only report range filters), so the export
  // always covers today (Asia/Yangon).
  async function onDailyCsv() {
    setCsvBusy(true)
    setCsvMsg(null)
    try {
      const filename = await dailySummaryCsv(todayYangon())
      setCsvMsg(`${filename} ကို ဒေါင်းလုပ် လုပ်ပြီးပါပြီ`)
    } catch (e) {
      setCsvMsg(e instanceof Error ? e.message : 'CSV ထုတ်၍ မရပါ')
    }
    setCsvBusy(false)
  }

  const agentName = useMemo(() => {
    const m = new Map(agents.map((a) => [a.id, a.name]))
    return (id: string | null) => (id ? m.get(id) ?? '—' : '—')
  }, [agents])

  const usernameOf = useMemo(() => {
    const m = new Map(profiles.map((p) => [p.id, personName(p)]))
    return (id: string | null) => (id ? m.get(id) ?? '—' : '—')
  }, [profiles])

  /** Day-by-day ledger lines for one agent, ascending, with running balance. */
  function buildLedger(agentId: string): { line: LedgerLine; balance: number }[] {
    const src: LedgerSource = ledger[agentId] ?? { entries: [], payments: [], writeOffs: [] }
    const raw: (LedgerLine & { sortKey: string; ord: number })[] = []
    for (const e of src.entries) {
      if (e.agent_id !== agentId) continue
      raw.push({
        key: `due-${e.id}`,
        date: e.entry_date,
        label: 'ရေပို့',
        detail: `ပို့ ${e.delivered_qty} · ပြန် ${e.returned_qty}`,
        delta: e.amount,
        sortKey: e.created_at,
        ord: 0,
      })
      if (e.amount_collected > 0) {
        raw.push({
          key: `cash-${e.id}`,
          date: e.entry_date,
          label: 'ငွေလက်ခံ',
          detail: 'ပို့ချိန် ကောက်ငွေ',
          delta: -e.amount_collected,
          sortKey: e.created_at,
          ord: 1,
        })
      }
    }
    for (const p of src.payments) {
      if (p.agent_id !== agentId) continue
      raw.push({
        key: `pay-${p.id}`,
        date: p.payment_date,
        label: 'ကြွေးကောက်',
        detail: METHOD_LABELS[p.method] ?? p.method,
        delta: -p.amount,
        sortKey: p.created_at,
        ord: 2,
      })
    }
    for (const w of src.writeOffs) {
      if (w.agent_id !== agentId) continue
      raw.push({
        key: `wo-${w.id}`,
        date: w.writeoff_date,
        label: 'ကြွေးပယ်ဖျက်',
        detail: '',
        delta: -w.amount,
        sortKey: w.created_at,
        ord: 3,
      })
    }
    raw.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.sortKey.localeCompare(b.sortKey) ||
        a.ord - b.ord,
    )
    let balance = 0
    return raw.map(({ sortKey: _s, ord: _o, ...line }) => {
      balance += line.delta
      return { line, balance }
    })
  }

  // Face tier per agent: rank all agents by lifetime sales and split into
  // thirds — top gold, middle white, bottom black (shared salesTierMap;
  // agents arrive in created_at order, matching the My Page RPC).
  const tierByAgent = useMemo(
    () => salesTierMap(agents.map((a) => ({ id: a.id, sales: totals.get(a.id)?.sales ?? 0 }))),
    [agents, totals],
  )

  const expandedLedger = useMemo(
    () => (expandedId ? buildLedger(expandedId) : []),
    // buildLedger reads only the per-agent ledger cache + expandedId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expandedId, ledger],
  )
  const visibleLedger = expandedLedger.slice(-ledgerShown)

  const visibleAgents = agents.filter((a) => {
    if (a.active) return true
    const t = totals.get(a.id)
    return (
      t !== undefined &&
      (t.sales !== 0 || t.cash !== 0 || t.payments !== 0 || t.writeOffs !== 0 || t.outstanding !== 0)
    )
  })

  // The payments state is already filtered and ordered by the server
  // query, so the report list reads it directly.
  const filteredPayments = payments

  const visiblePayments = filteredPayments.slice(0, reportShown)

  const reportTotal = filteredPayments.reduce((s, p) => s + p.amount, 0)

  const thCls = 'px-3 py-3 font-medium'
  const tdCls = 'px-3 py-3 tabular-nums'

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="ကောက်ခံမှုနှင့် ကြွေးစာရင်း"
        subtitle="ကိုယ်စားလှယ်အလိုက် ရောင်းအား၊ ကောက်ခံငွေနှင့် ကျန်ကြွေး ကြည့်ရန်"
      />

      <div>
        <SecondaryButton onClick={onDailyCsv} disabled={csvBusy}>
          {csvBusy ? 'ထုတ်နေပါတယ်…' : 'နေ့စဉ် CSV ထုတ်မည်'}
        </SecondaryButton>
        {csvMsg && <p className="mt-2 text-sm">{csvMsg}</p>}
      </div>

      {msg && (
        <Banner tone="red">
          <span role="alert">{msg}</span>
        </Banner>
      )}

      {loading ? (
        <LoadingState />
      ) : (
        <>
          <div>
            {visibleAgents.map((a, idx) => {
              const t = totals.get(a.id) ?? {
                sales: 0,
                cash: 0,
                payments: 0,
                writeOffs: 0,
                outstanding: 0,
              }
              const expanded = expandedId === a.id
              const open = openId === a.id
              // Wallet stack (the owner's reference video): every agent is a
              // full-height coloured card face. Each face slides up over the
              // one above, so only its top strip — name + outstanding — shows;
              // the last face shows in full. Tapping a face opens its detail
              // body below it, and the card under an open one never slides
              // over that body.
              const prevOpen = idx > 0 && openId === visibleAgents[idx - 1]?.id
              const stacked = !open && idx > 0 && !prevOpen
              const tier = FACE_TIERS[a.closed_at ? 'black' : (tierByAgent.get(a.id) ?? 'black')]
              return (
                <div
                  key={a.id}
                  style={{ marginTop: idx === 0 ? 0 : stacked ? -108 : 12 }}
                  className="transition-all duration-300 ease-out motion-reduce:transition-none"
                >
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : a.id)}
                    aria-expanded={open}
                    style={{ background: tier.bg }}
                    className={`relative flex h-[168px] w-full flex-col justify-between p-4 text-left shadow-[0_-8px_18px_rgba(0,0,0,0.35)] lg:h-[184px] ${tier.text} ${tier.extra} ${open ? 'rounded-t-2xl' : 'rounded-2xl'}`}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 font-semibold">
                        {a.name}
                        {a.code && (
                          <span className={`ml-2 text-xs font-normal ${tier.sub}`}>{a.code}</span>
                        )}
                        {!a.active && (
                          <span className={`ml-2 text-xs ${tier.sub}`}>(ပိတ်ထားသည်)</span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span
                          className={`font-bold tabular-nums ${t.outstanding < 0 ? tier.neg : ''}`}
                        >
                          {formatMMK(Math.abs(t.outstanding))}
                        </span>
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={`h-5 w-5 shrink-0 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`}
                          aria-hidden="true"
                        >
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                    </span>
                    <span className="block space-y-1.5">
                      <span className={`block text-xs ${tier.faint}`}>{t.outstanding < 0 ? 'ပိုပေးထားငွေ' : 'ကျန်ကြွေ'}</span>
                      <span className="block text-[28px] font-bold leading-[1.3] tabular-nums">
                        {formatMMK(Math.abs(t.outstanding))}
                      </span>
                      <span className={`block text-xs ${tier.sub}`}>
                        ရောင်းအား {formatMMK(t.sales)} · ကောက်ခံပြီး{' '}
                        {formatMMK(t.cash + t.payments)}
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute bottom-4 right-4 opacity-25 ${tier.text}`}
                    >
                      <svg width="52" height="36" viewBox="0 0 52 36" fill="none">
                        <circle cx="18" cy="18" r="15" stroke="currentColor" strokeWidth="2" />
                        <circle cx="34" cy="18" r="15" stroke="currentColor" strokeWidth="2" />
                      </svg>
                    </span>
                  </button>
                  <div
                    aria-hidden={!open}
                    className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${open ? '[grid-template-rows:1fr]' : '[grid-template-rows:0fr]'}`}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="rounded-b-2xl border border-t-0 border-stone-200/90 bg-white p-4 shadow-card dark:border-neutral-800 dark:bg-neutral-900 lg:p-5">
                        <div className="flex justify-end">
                          <button
                            onClick={() => setExpandedId(expanded ? null : a.id)}
                            className={detailBtnCls}
                          >
                            {expanded ? 'ပိတ်ရန်' : 'အသေးစိတ် စာရင်း'}
                          </button>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm lg:grid-cols-4">
                          <div>
                            <div className="text-xs font-medium text-stone-500 dark:text-neutral-400">
                              စုစုပေါင်း ရောင်းအား
                            </div>
                            <div className="mt-0.5 font-semibold tabular-nums">{formatMMK(t.sales)}</div>
                          </div>
                          <div>
                            <div className="text-xs font-medium text-stone-500 dark:text-neutral-400">
                              ပို့ချိန် လက်ခံရရှိငွေ
                            </div>
                            <div className="mt-0.5 font-semibold tabular-nums">{formatMMK(t.cash)}</div>
                          </div>
                          <div>
                            <div className="text-xs font-medium text-stone-500 dark:text-neutral-400">
                              နောက်မှ ကောက်ခံငွေ
                            </div>
                            <div className="mt-0.5 font-semibold tabular-nums">{formatMMK(t.payments)}</div>
                          </div>
                          <div>
                            <div className="text-xs font-medium text-stone-500 dark:text-neutral-400">
                              ကြွေးပယ်ဖျက်
                            </div>
                            <div className="mt-0.5 font-semibold tabular-nums">{formatMMK(t.writeOffs)}</div>
                          </div>
                        </div>
                        <div className="mt-3 flex items-center justify-between border-t border-stone-100 pt-3 dark:border-neutral-800">
                          <span className="text-sm font-semibold">{t.outstanding < 0 ? 'ပိုပေးထားငွေ' : 'ကျန်ကြွေ'}</span>
                          <span
                            className={`font-bold tabular-nums ${t.outstanding > 0 ? 'text-red-600 dark:text-red-400' : ''}`}
                          >
                            {formatMMK(Math.abs(t.outstanding))}
                          </span>
                        </div>
                        {expanded && !ledger[a.id] ? (
                          <div className="mt-3 border-t border-stone-100 pt-3 dark:border-neutral-800">
                            <LoadingState />
                          </div>
                        ) : expanded ? (
                          <>
                            {expandedLedger.length > ledgerShown && (
                              <div className="mt-3 border-t border-stone-100 pt-3 text-center dark:border-neutral-800">
                                <SecondaryButton
                                  size="sm"
                                  onClick={() => setLedgerShown((n) => n + 100)}
                                >
                                  မှတ်တမ်း အဟောင်းများ ထပ်ပြမည်
                                </SecondaryButton>
                              </div>
                            )}
                            <ul className="mt-3 divide-y divide-stone-100 border-t border-stone-100 dark:divide-neutral-800 dark:border-neutral-800">
                              {visibleLedger.map(({ line, balance }) => (
                                <li key={line.key} className="flex items-center justify-between gap-2 py-2.5 text-sm">
                                  <div>
                                    <span className="font-medium">{line.label}</span>{' '}
                                    <span className="text-stone-500 dark:text-neutral-400">
                                      {line.date}
                                      {line.detail ? ` · ${line.detail}` : ''}
                                    </span>
                                  </div>
                                  <div className="text-right">
                                    <div className="font-medium tabular-nums">
                                      {line.delta >= 0 ? '+' : ''}
                                      {formatMMK(line.delta)}
                                    </div>
                                    <div className="text-xs text-stone-500 tabular-nums dark:text-neutral-400">
                                      ကျန် {formatMMK(balance)}
                                    </div>
                                  </div>
                                </li>
                              ))}
                              {expandedLedger.length === 0 && (
                                <li className="py-2.5 text-sm text-stone-500 dark:text-neutral-400">
                                  စာရင်း မရှိသေးပါ
                                </li>
                              )}
                            </ul>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
            {visibleAgents.length === 0 && <EmptyState text="ကိုယ်စားလှယ် မရှိသေးပါ" />}
          </div>

          <Card className="space-y-3">
            <CardTitle>ကောက်ခံမှု အစီရင်ခံစာ</CardTitle>
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              <Field label="ကိုယ်စားလှယ်">
                <select
                  value={fAgent}
                  onChange={(e) => setFAgent(e.target.value)}
                  className={inputCls}
                >
                  <option value="">အားလုံး</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="ထည့်သွင်းသူ">
                <select
                  value={fBy}
                  onChange={(e) => setFBy(e.target.value)}
                  className={inputCls}
                >
                  <option value="">အားလုံး</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {personName(p)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="ရက်စ မှ">
                <input
                  type="date"
                  value={fFrom}
                  onChange={(e) => setFFrom(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label="ရက်စ အထိ">
                <input
                  type="date"
                  value={fTo}
                  onChange={(e) => setFTo(e.target.value)}
                  className={inputCls}
                />
              </Field>
            </div>
            {(fFrom || fTo) && (
              <div>
                <SecondaryButton
                  size="sm"
                  onClick={() => {
                    setFFrom('')
                    setFTo('')
                  }}
                >
                  ရက်အပိုင်း ရှင်းရန်
                </SecondaryButton>
              </div>
            )}
            <p className="rounded-xl bg-brand-50 px-3.5 py-2.5 text-sm font-medium dark:bg-brand-950/40">
              စုစုပေါင်း {filteredPayments.length} ခု ·{' '}
              <span className="tabular-nums">{formatMMK(reportTotal)}</span>
            </p>
          </Card>

          {filteredPayments.length === 0 ? (
            <EmptyState text="ကောက်ခံမှု မှတ်တမ် မရှိပါ" />
          ) : (
            <>
              {/* Phone / tablet: one card per record. */}
              <ul className="space-y-3 lg:hidden">
                {visiblePayments.map((p) => (
                  <li key={p.id} className={`${cardCls} p-3.5`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold">{p.agent_name ?? agentName(p.agent_id)}</div>
                      <div className="font-bold tabular-nums">{formatMMK(p.amount)}</div>
                    </div>
                    <div className="mt-0.5 text-sm text-stone-500 dark:text-neutral-400">
                      {p.payment_date} · {METHOD_LABELS[p.method] ?? p.method} · ထည့်သွင်းသူ{' '}
                      {usernameOf(p.created_by)}
                      {p.notes ? ` · ${p.notes}` : ''}
                    </div>
                  </li>
                ))}
              </ul>

              {/* Desktop: table. */}
              <div className={`${cardCls} hidden overflow-x-auto lg:block`}>
                <table className="w-full min-w-[820px] text-sm">
                  <thead>
                    <tr className="border-b border-stone-200 bg-stone-50/80 text-left text-stone-500 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-400">
                      <th className={`${thCls} pl-4`}>ကိုယ်စားလှယ်</th>
                      <th className={thCls}>ရက်စွဲ</th>
                      <th className={thCls}>နည်းလမ်း</th>
                      <th className={thCls}>ထည့်သွင်းသူ</th>
                      <th className={`${thCls} pr-4 text-right`}>ပမာဏ (ကျပ်)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePayments.map((p) => (
                      <tr
                        key={p.id}
                        className="border-b border-stone-100 align-top last:border-0 dark:border-neutral-800/70"
                      >
                        <td className="px-3 py-3 pl-4">
                          <div className="font-medium">{p.agent_name ?? agentName(p.agent_id)}</div>
                          {p.notes && <div className="text-xs opacity-60">{p.notes}</div>}
                        </td>
                        <td className={`${tdCls} whitespace-nowrap`}>{p.payment_date}</td>
                        <td className="px-3 py-3">{METHOD_LABELS[p.method] ?? p.method}</td>
                        <td className="px-3 py-3">{usernameOf(p.created_by)}</td>
                        <td className={`${tdCls} pr-4 text-right font-semibold`}>
                          {formatMMK(p.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredPayments.length > reportShown && (
                <div className="pt-1 text-center">
                  <SecondaryButton size="sm" onClick={() => setReportShown((n) => n + 100)}>
                    ထပ်ပြမည် ({reportShown}/{filteredPayments.length})
                  </SecondaryButton>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
