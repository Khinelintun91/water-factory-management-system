import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatMMK, type Agent, type Profile } from '../lib/types'

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

/** Fetch a whole table in created_at order, paging past the 1,000-row cap. */
async function fetchAll<T>(table: string, columns: string): Promise<T[]> {
  const pageSize = 1000
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const page = (data ?? []) as T[]
    out.push(...page)
    if (page.length < pageSize) break
  }
  return out
}

export default function CollectionsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [entries, setEntries] = useState<EntryLite[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [writeOffs, setWriteOffs] = useState<WriteOffLite[]>([])
  const [profiles, setProfiles] = useState<Pick<Profile, 'id' | 'username'>[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Collections-report filters.
  const [fAgent, setFAgent] = useState('')
  const [fFrom, setFFrom] = useState('')
  const [fTo, setFTo] = useState('')
  const [fBy, setFBy] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const [{ data: ag, error: agErr }, en, pm, wo, { data: pf, error: pfErr }] =
        await Promise.all([
          supabase.from('agents').select('*').order('created_at'),
          fetchAll<EntryLite>(
            'daily_entries',
            'id, agent_id, entry_date, delivered_qty, returned_qty, amount, amount_collected, created_at',
          ),
          fetchAll<PaymentRow>(
            'agent_payments',
            'id, agent_id, agent_name, payment_date, amount, method, notes, created_by, created_at',
          ),
          fetchAll<WriteOffLite>('write_offs', 'id, agent_id, writeoff_date, amount, created_at'),
          supabase.from('profiles').select('id, username').order('username'),
        ])
      if (agErr) throw new Error(agErr.message)
      if (pfErr) throw new Error(pfErr.message)
      setAgents((ag ?? []) as Agent[])
      setEntries(en)
      setPayments(pm)
      setWriteOffs(wo)
      setProfiles((pf ?? []) as Pick<Profile, 'id' | 'username'>[])
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const agentName = useMemo(() => {
    const m = new Map(agents.map((a) => [a.id, a.name]))
    return (id: string | null) => (id ? m.get(id) ?? '—' : '—')
  }, [agents])

  const usernameOf = useMemo(() => {
    const m = new Map(profiles.map((p) => [p.id, p.username]))
    return (id: string | null) => (id ? m.get(id) ?? '—' : '—')
  }, [profiles])

  // Per-agent totals by client aggregation — the same formula the
  // agent_outstanding RPC uses (sales - cash - payments - write-offs), and
  // the day-by-day ledger below is built from these same rows.
  const totals = useMemo(() => {
    const m = new Map<string, AgentTotals>()
    const blank = (): AgentTotals => ({
      sales: 0,
      cash: 0,
      payments: 0,
      writeOffs: 0,
      outstanding: 0,
    })
    for (const e of entries) {
      if (!e.agent_id) continue
      const t = m.get(e.agent_id) ?? blank()
      t.sales += e.amount
      t.cash += e.amount_collected
      m.set(e.agent_id, t)
    }
    for (const p of payments) {
      if (!p.agent_id) continue
      const t = m.get(p.agent_id) ?? blank()
      t.payments += p.amount
      m.set(p.agent_id, t)
    }
    for (const w of writeOffs) {
      if (!w.agent_id) continue
      const t = m.get(w.agent_id) ?? blank()
      t.writeOffs += w.amount
      m.set(w.agent_id, t)
    }
    for (const t of m.values()) {
      t.outstanding = t.sales - t.cash - t.payments - t.writeOffs
    }
    return m
  }, [entries, payments, writeOffs])

  /** Day-by-day ledger lines for one agent, ascending, with running balance. */
  function buildLedger(agentId: string): { line: LedgerLine; balance: number }[] {
    const raw: (LedgerLine & { sortKey: string; ord: number })[] = []
    for (const e of entries) {
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
    for (const p of payments) {
      if (p.agent_id !== agentId) continue
      raw.push({
        key: `pay-${p.id}`,
        date: p.payment_date,
        label: 'ကြွေးကောက်',
        detail: p.method,
        delta: -p.amount,
        sortKey: p.created_at,
        ord: 2,
      })
    }
    for (const w of writeOffs) {
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

  const expandedLedger = useMemo(
    () => (expandedId ? buildLedger(expandedId) : []),
    // buildLedger reads only the three datasets + expandedId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expandedId, entries, payments, writeOffs],
  )

  const visibleAgents = agents.filter((a) => {
    if (a.active) return true
    const t = totals.get(a.id)
    return (
      t !== undefined &&
      (t.sales !== 0 || t.cash !== 0 || t.payments !== 0 || t.writeOffs !== 0 || t.outstanding !== 0)
    )
  })

  const filteredPayments = useMemo(() => {
    const list = payments.filter(
      (p) =>
        (!fAgent || p.agent_id === fAgent) &&
        (!fFrom || p.payment_date >= fFrom) &&
        (!fTo || p.payment_date <= fTo) &&
        (!fBy || p.created_by === fBy),
    )
    return list.sort(
      (a, b) =>
        b.payment_date.localeCompare(a.payment_date) ||
        b.created_at.localeCompare(a.created_at),
    )
  }, [payments, fAgent, fFrom, fTo, fBy])

  const reportTotal = filteredPayments.reduce((s, p) => s + p.amount, 0)

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">ကောက်ခံမှုနှင့် ကြွေးစာရင်း</h1>

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      {loading ? (
        <p>ခဏစောင့်ပါ…</p>
      ) : (
        <>
          <div className="space-y-3">
            {visibleAgents.map((a) => {
              const t = totals.get(a.id) ?? {
                sales: 0,
                cash: 0,
                payments: 0,
                writeOffs: 0,
                outstanding: 0,
              }
              const expanded = expandedId === a.id
              return (
                <div key={a.id} className="rounded-2xl border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold">
                      {a.name}
                      {!a.active && <span className="ml-2 text-xs opacity-60">(ပိတ်ထားသည်)</span>}
                    </div>
                    <button
                      onClick={() => setExpandedId(expanded ? null : a.id)}
                      className="text-sm text-teal-700"
                    >
                      {expanded ? 'ပိတ်ရန်' : 'အသေးစိတ် စာရင်း'}
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <span className="opacity-70">စုစုပေါင်း ရောင်းအား</span>
                      <div className="font-medium">{formatMMK(t.sales)}</div>
                    </div>
                    <div>
                      <span className="opacity-70">ပို့ချိန် လက်ခံရရှိငွေ</span>
                      <div className="font-medium">{formatMMK(t.cash)}</div>
                    </div>
                    <div>
                      <span className="opacity-70">နောက်မှ ကောက်ခံငွေ</span>
                      <div className="font-medium">{formatMMK(t.payments)}</div>
                    </div>
                    <div>
                      <span className="opacity-70">ကြွေးပယ်ဖျက်</span>
                      <div className="font-medium">{formatMMK(t.writeOffs)}</div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t pt-2">
                    <span className="text-sm font-semibold">ကျန်ကြွေး</span>
                    <span
                      className={`font-bold ${t.outstanding > 0 ? 'text-red-600' : ''}`}
                    >
                      {formatMMK(t.outstanding)}
                    </span>
                  </div>
                  {expanded && (
                    <ul className="mt-3 divide-y border-t">
                      {expandedLedger.map(({ line, balance }) => (
                        <li key={line.key} className="flex items-center justify-between gap-2 py-2 text-sm">
                          <div>
                            <span className="font-medium">{line.label}</span>{' '}
                            <span className="opacity-70">
                              {line.date}
                              {line.detail ? ` · ${line.detail}` : ''}
                            </span>
                          </div>
                          <div className="text-right">
                            <div className="font-medium">
                              {line.delta >= 0 ? '+' : ''}
                              {formatMMK(line.delta)}
                            </div>
                            <div className="text-xs opacity-60">ကျန် {formatMMK(balance)}</div>
                          </div>
                        </li>
                      ))}
                      {expandedLedger.length === 0 && (
                        <li className="py-2 text-sm opacity-70">စာရင်း မရှိသေးပါ</li>
                      )}
                    </ul>
                  )}
                </div>
              )
            })}
            {visibleAgents.length === 0 && (
              <p className="text-sm opacity-70">ကိုယ်စားလှယ် မရှိသေးပါ</p>
            )}
          </div>

          <div className="space-y-2 rounded-2xl border p-4">
            <div className="font-semibold">ကောက်ခံမှု အစီရင်ခံစာ</div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm">
                ကိုယ်စားလှယ်
                <select
                  value={fAgent}
                  onChange={(e) => setFAgent(e.target.value)}
                  className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
                >
                  <option value="">အားလုံး</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                ထည့်သွင်းသူ
                <select
                  value={fBy}
                  onChange={(e) => setFBy(e.target.value)}
                  className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
                >
                  <option value="">အားလုံး</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.username}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                ရက်စ မှ
                <input
                  type="date"
                  value={fFrom}
                  onChange={(e) => setFFrom(e.target.value)}
                  className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
                />
              </label>
              <label className="text-sm">
                ရက်စ အထိ
                <input
                  type="date"
                  value={fTo}
                  onChange={(e) => setFTo(e.target.value)}
                  className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
                />
              </label>
            </div>
            <p className="text-sm">
              စုစုပေါင်း {filteredPayments.length} ခု · {formatMMK(reportTotal)}
            </p>
          </div>

          <ul className="divide-y rounded-2xl border">
            {filteredPayments.map((p) => (
              <li key={p.id} className="p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">{p.agent_name ?? agentName(p.agent_id)}</div>
                  <div className="text-sm font-semibold">{formatMMK(p.amount)}</div>
                </div>
                <div className="text-sm opacity-75">
                  {p.payment_date} · {p.method} · ထည့်သွင်းသူ {usernameOf(p.created_by)}
                  {p.notes ? ` · ${p.notes}` : ''}
                </div>
              </li>
            ))}
            {filteredPayments.length === 0 && (
              <li className="p-3 text-sm opacity-70">ကောက်ခံမှု မှတ်တမ် မရှိပါ</li>
            )}
          </ul>
        </>
      )}
    </div>
  )
}
