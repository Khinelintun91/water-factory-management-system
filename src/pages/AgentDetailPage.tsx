import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import {
  formatMMK,
  todayYangon,
  PRICE_DIFF_KIND_LABELS,
  type Agent,
  type AgentDeposit,
  type AgentPayment,
  type AgentSettlement,
  type DailyEntry,
  type WriteOff,
} from '../lib/types'
import {
  Card,
  CardTitle,
  DangerButton,
  Field,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  StatCard,
  btnPrimaryCls,
  cardCls,
  inputCls,
} from '../components/ui'

/** agents.trip_qty / agents.notes are not on the shared Agent type yet. */
type AgentFull = Agent & { trip_qty: number | null; notes: string | null }

/** agent_payments.kind is not on the shared AgentPayment type yet. */
type PaymentFull = AgentPayment & { kind: 'regular' | 'old_debt' | null }

export function SettlementSummary({ s }: { s: AgentSettlement }) {
  const rows: [string, string][] = [
    ['စာရင်းပိတ်ရက်', s.settle_date],
    ['ကိုင်ထားဘူး', `${s.held_bottles.toLocaleString('en-US')} ဗူး`],
    ['ပြန်အပ်ဘူး', `${s.returned_bottles.toLocaleString('en-US')} ဗူး`],
    ['ပျောက်ဘူး', `${s.missing_bottles.toLocaleString('en-US')} ဗူး`],
    ['ယနေ့ ပေါက်ဈေး', `${formatMMK(s.current_price)}/ဗူး`],
    ['မူလ အပေါင် စုစုပေါင်း', formatMMK(s.deposit_original)],
    ['ပြန်အမ်းငွေ', formatMMK(s.refund_amount)],
    ['ဈေးကွာ', `${formatMMK(s.price_diff)} (${PRICE_DIFF_KIND_LABELS[s.price_diff_kind]})`],
    ['ပျောက်ဘူး ကောက်ငွေ', formatMMK(s.forfeiture_income)],
    ['အမှန် ပြန်အမ်းငွေ', formatMMK(s.net_refund)],
    ['ကိုယ်စားလှယ် ပေးရန်ကျန်', formatMMK(s.agent_owes)],
  ]
  return (
    <Card>
      <CardTitle>စာရင်းပိတ် အကျဉ်းချုပ်</CardTitle>
      <dl className="mt-2 text-sm">
        {rows.map(([k, v]) => (
          <div
            key={k}
            className="flex items-center justify-between gap-2 border-b border-stone-100 py-1.5 last:border-0 dark:border-neutral-800/70"
          >
            <dt className="opacity-75">{k}</dt>
            <dd className="font-medium tabular-nums">{v}</dd>
          </div>
        ))}
        {s.note && (
          <div className="flex items-center justify-between gap-2 py-1.5">
            <dt className="opacity-75">မှတ်ချက်</dt>
            <dd className="font-medium">{s.note}</dd>
          </div>
        )}
      </dl>
    </Card>
  )
}

const METHOD_LABELS: Record<string, string> = {
  cash: 'ငွေသား',
  kbzpay: 'KBZPay',
  wavepay: 'WavePay',
  bank: 'ဘဏ်',
}

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { profile } = useAuth()
  const navigate = useNavigate()
  const isOwner = profile?.role === 'owner'

  const [agent, setAgent] = useState<AgentFull | null>(null)
  const [phone, setPhone] = useState<string | null>(null)
  const [entries, setEntries] = useState<DailyEntry[]>([])
  const [payments, setPayments] = useState<PaymentFull[]>([])
  const [deposits, setDeposits] = useState<AgentDeposit[]>([])
  const [writeOffs, setWriteOffs] = useState<WriteOff[]>([])
  const [settlement, setSettlement] = useState<AgentSettlement | null>(null)
  const [outstanding, setOutstanding] = useState(0)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Deposit form
  const [depDate, setDepDate] = useState(todayYangon())
  const [depBottles, setDepBottles] = useState('')
  const [depPrice, setDepPrice] = useState('')
  const [depNote, setDepNote] = useState('')

  // Full-table per-agent totals from agent_detail_stats (migration 0023).
  const [serverStats, setServerStats] = useState<{
    held: number
    sales: number
    collectedEntries: number
    paymentsTotal: number
    depBottles: number
    depAmount: number
  } | null>(null)

  // Write-off form
  const [woAmount, setWoAmount] = useState('')
  const [woNote, setWoNote] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const [{ data: ag }, { data: ct }, { data: en }, { data: pm }, { data: dp }, { data: wo }, { data: st }, out, statsRes] =
      await Promise.all([
        supabase.from('agents').select('*').eq('id', id).maybeSingle(),
        supabase.from('agent_contacts').select('phone').eq('agent_id', id).maybeSingle(),
        supabase
          .from('daily_entries')
          .select('*')
          .eq('agent_id', id)
          .order('created_at', { ascending: false })
          .limit(50),
        supabase
          .from('agent_payments')
          .select('*')
          .eq('agent_id', id)
          .order('created_at', { ascending: false })
          .limit(50),
        supabase
          .from('agent_deposits')
          .select('*')
          .eq('agent_id', id)
          .order('deposit_date', { ascending: false })
          .order('created_at', { ascending: false }),
        supabase
          .from('write_offs')
          .select('*')
          .eq('agent_id', id)
          .order('writeoff_date', { ascending: false })
          .order('created_at', { ascending: false }),
        supabase.from('agent_settlements').select('*').eq('agent_id', id).maybeSingle(),
        supabase.rpc('agent_outstanding', { p_agent: id }),
        supabase.rpc('agent_detail_stats', { p_agent: id }),
      ])
    const a = (ag as AgentFull | null) ?? null
    setAgent(a)
    setPhone((ct as { phone: string } | null)?.phone ?? null)
    setEntries((en ?? []) as DailyEntry[])
    // The payments select('*') above includes the kind column.
    setPayments((pm ?? []) as PaymentFull[])
    setDeposits((dp ?? []) as AgentDeposit[])
    setWriteOffs((wo ?? []) as WriteOff[])
    setSettlement((st as AgentSettlement | null) ?? null)
    setOutstanding(typeof out.data === 'number' ? out.data : 0)
    setServerStats(
      statsRes.error
        ? null
        : (statsRes.data as {
            held: number
            sales: number
            collectedEntries: number
            paymentsTotal: number
            depBottles: number
            depAmount: number
          }),
    )
    if (a && depPrice === '') setDepPrice(String(a.deposit_per_bottle || ''))
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const stats = useMemo(() => {
    // Totals come from agent_detail_stats (migration 0023): PostgREST caps
    // client fetches at 1,000 rows, so reducing over fetched rows silently
    // understates held/sales for agents with long histories. The reduce is
    // only a fallback if the RPC is unavailable.
    if (serverStats) {
      return {
        held: serverStats.held,
        sales: serverStats.sales,
        collected: serverStats.collectedEntries + serverStats.paymentsTotal,
        depBottles: serverStats.depBottles,
        depAmount: serverStats.depAmount,
      }
    }
    const held = entries.reduce((s, e) => s + e.delivered_qty - e.returned_qty, 0)
    const sales = entries.reduce((s, e) => s + e.amount, 0)
    const cash = entries.reduce((s, e) => s + (e.amount_collected ?? 0), 0)
    const paid = payments.reduce((s, p) => s + p.amount, 0)
    const depBottles = deposits.reduce((s, d) => s + d.bottles, 0)
    const depAmount = deposits.reduce((s, d) => s + d.amount, 0)
    return { held, sales, collected: cash + paid, depBottles, depAmount }
  }, [serverStats, entries, payments, deposits])

  const canDeliver = useMemo(() => {
    if (!agent) return '—'
    const { held, depBottles } = stats
    if (agent.deposit_per_bottle > 0) {
      const cap = agent.bottle_limit > 0 ? Math.min(agent.bottle_limit, depBottles) : depBottles
      return `${Math.max(0, cap - held).toLocaleString('en-US')} ဗူး`
    }
    if (agent.bottle_limit > 0) {
      return `${Math.max(0, agent.bottle_limit - held).toLocaleString('en-US')} ဗူး`
    }
    return '—'
  }, [agent, stats])

  async function onAddDeposit(e: FormEvent) {
    e.preventDefault()
    if (!id) return
    setMsg(null)
    const bottles = Number(depBottles) || 0
    const price = Number(depPrice) || 0
    const { error } = await supabase.from('agent_deposits').insert({
      agent_id: id,
      deposit_date: depDate,
      bottles,
      price_per_bottle: price,
      amount: bottles * price,
      note: depNote.trim() || null,
    })
    if (error) {
      setMsg(error.message)
      return
    }
    setDepBottles('')
    setDepNote('')
    await load()
  }

  async function onAddWriteOff(e: FormEvent) {
    e.preventDefault()
    if (!id) return
    setMsg(null)
    if (!woNote.trim()) {
      setMsg('Write-off အတွက် အကြောင်းပြချက် ထည့်ရန် လိုပါတယ်')
      return
    }
    const { error } = await supabase.from('write_offs').insert({
      agent_id: id,
      amount: Number(woAmount) || 0,
      note: woNote.trim(),
    })
    if (error) {
      setMsg(error.message)
      return
    }
    setWoAmount('')
    setWoNote('')
    await load()
  }

  async function onHardDelete() {
    if (!id) return
    setMsg(null)
    const { error } = await supabase.rpc('hard_delete_agent', { p_agent: id })
    if (error) {
      setMsg(error.message)
      setConfirmDelete(false)
      return
    }
    navigate('/agents')
  }

  if (loading) return <LoadingState />
  if (!agent) return <p className="text-sm text-red-600">ကိုယ်စားလှယ် မတွေ့ပါ</p>

  const closed = Boolean(agent.closed_at)
  const statCards: { label: string; value: string; tone?: 'danger' }[] = [
    // A closed agent's bottle position was consumed by the settlement (its
    // held/returned figures live in the settlement summary below), so the
    // live held / can-deliver figures no longer apply.
    { label: 'ကိုင်ထားဘူး', value: closed ? '0 ဗူး' : `${stats.held.toLocaleString('en-US')} ဗူး` },
    { label: 'အပေါင်ဘူး', value: `${stats.depBottles.toLocaleString('en-US')} ဗူး (${formatMMK(stats.depAmount)})` },
    { label: 'စုစုပေါင်း ရောင်းရ', value: formatMMK(stats.sales) },
    { label: 'ကောက်ခံပြီး', value: formatMMK(stats.collected) },
    { label: 'ရရန်ကျန်', value: formatMMK(outstanding), tone: outstanding > 0 ? 'danger' : undefined },
    { label: 'ဆက်ပို့နိုင်ဘူး', value: closed ? 'စာရင်းပိတ်ပြီး' : canDeliver },
  ]

  const listItemCls = 'p-3.5'
  const listMetaCls = 'text-sm text-stone-500 dark:text-neutral-400'

  return (
    <div className="space-y-4 lg:space-y-6">
      <div>
        <Link
          to="/agents"
          className="inline-flex min-h-[40px] items-center text-sm font-medium text-brand-700 dark:text-brand-300"
        >
          ← ကိုယ်စားလှယ်များ
        </Link>
        <PageHeader
          title={
            <>
              {agent.name}{' '}
              {agent.code && <span className="text-base font-medium opacity-60">({agent.code})</span>}
            </>
          }
          subtitle="အပေါင်၊ ကြွေးနှင့် မှတ်တမ်း အသေးစိတ်"
        />
      </div>

      {msg && (
        <p className="text-sm text-red-600" role="alert">
          {msg}
        </p>
      )}

      <Card className="text-sm">
        <div className="space-y-1">
          <div>ဖုန်း: {phone ?? '—'}</div>
          {agent.address && <div>လိပ်စာ: {agent.address}</div>}
          <div>
            ဈေးနှုန်း: {formatMMK(agent.default_unit_price)}/ဗူး · အပေါင်:{' '}
            {formatMMK(agent.deposit_per_bottle)}/ဗူး
          </div>
          <div>
            ဘူး ကန့်သတ်: {agent.bottle_limit > 0 ? `${agent.bottle_limit.toLocaleString('en-US')} ဗူး` : 'မကန့်သတ်'} ·
            ကြွေး ကန့်သတ်: {agent.credit_limit > 0 ? formatMMK(agent.credit_limit) : 'မကန့်သတ်'}
          </div>
          <div>တစ်ခါပို့ ဘူးအရေအတွက်: {(agent.trip_qty ?? 0).toLocaleString('en-US')} ဗူး</div>
          {agent.notes && <div>မှတ်ချက်: {agent.notes}</div>}
          <div>
            အခြေအနေ:{' '}
            {closed ? (
              <span className="text-red-500">
                စာရင်းပိတ်ပြီး ({agent.closed_at ? agent.closed_at.slice(0, 10) : ''})
              </span>
            ) : agent.active ? (
              'သုံးနေဆဲ'
            ) : (
              <span className="text-red-500">ပိတ်ထားသည်</span>
            )}
          </div>
        </div>
        {!closed && (
          <Link to={`/closeout/${agent.id}`} className={`${btnPrimaryCls} mt-3 w-full`}>
            စာရင်းပိတ်ရန်
          </Link>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
        {statCards.map((c) => (
          <StatCard key={c.label} label={c.label} value={c.value} tone={c.tone} />
        ))}
      </div>

      <div className="space-y-2.5">
        <h2 className="px-0.5 font-semibold">ပို့ဆောင်မှု မှတ်တမ်းများ (နောက်ဆုံး ၅၀)</h2>
        <ul className={`${cardCls} divide-y divide-stone-100 overflow-hidden dark:divide-neutral-800`}>
          {entries.slice(0, 50).map((r) => (
            <li key={r.id} className={listItemCls}>
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">{r.entry_date}</div>
                <div className="font-bold tabular-nums">{formatMMK(r.amount)}</div>
              </div>
              <div className={listMetaCls}>
                ပို့ {r.delivered_qty} · ပြန် {r.returned_qty} · ငွေကောက်{' '}
                {formatMMK(r.amount_collected ?? 0)} · ကျန်ကြွေး{' '}
                {formatMMK(r.amount - (r.amount_collected ?? 0))}
                {r.notes ? ` · ${r.notes}` : ''}
              </div>
            </li>
          ))}
          {entries.length === 0 && <li className={`${listItemCls} text-sm opacity-70`}>မှတ်တမ် မရှိသေးပါ</li>}
        </ul>
      </div>

      <div className="space-y-2.5">
        <h2 className="px-0.5 font-semibold">ငွေကောက်ခံမှု မှတ်တမ်းများ (နောက်ဆုံး ၅၀)</h2>
        <ul className={`${cardCls} divide-y divide-stone-100 overflow-hidden dark:divide-neutral-800`}>
          {payments.slice(0, 50).map((p) => (
            <li key={p.id} className={listItemCls}>
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">{p.payment_date}</div>
                <div className="font-bold tabular-nums">{formatMMK(p.amount)}</div>
              </div>
              <div className={listMetaCls}>
                {METHOD_LABELS[p.method] ?? p.method}
                {p.notes ? ` · ${p.notes}` : ''}
              </div>
            </li>
          ))}
          {payments.length === 0 && <li className={`${listItemCls} text-sm opacity-70`}>မှတ်တမ် မရှိသေးပါ</li>}
        </ul>
      </div>

      <div className="space-y-2.5">
        <h2 className="px-0.5 font-semibold">ကြွေးဟောင်းကောက်ငွေ မှတ်တမ်း</h2>
        <ul className={`${cardCls} divide-y divide-stone-100 overflow-hidden dark:divide-neutral-800`}>
          {payments
            .filter((p) => p.kind === 'old_debt')
            .map((p) => (
              <li key={p.id} className={listItemCls}>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">{p.payment_date}</div>
                  <div className="font-bold tabular-nums">{formatMMK(p.amount)}</div>
                </div>
                <div className={listMetaCls}>
                  {METHOD_LABELS[p.method] ?? p.method}
                  {p.notes ? ` · ${p.notes}` : ''}
                </div>
              </li>
            ))}
          {payments.every((p) => p.kind !== 'old_debt') && (
            <li className={`${listItemCls} text-sm opacity-70`}>ကြွေးဟောင်းကောက်ငွေ မှတ်တမ်း မရှိပါ</li>
          )}
        </ul>
      </div>

      <Card>
        <CardTitle>အပေါင် မှတ်တမ်း</CardTitle>
        <ul className="divide-y divide-stone-100 dark:divide-neutral-800">
          {deposits.map((d) => (
            <li key={d.id} className="py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span>
                  {d.deposit_date} · {d.bottles.toLocaleString('en-US')} ဗူး ×{' '}
                  {formatMMK(d.price_per_bottle)}
                </span>
                <span className="font-semibold tabular-nums">{formatMMK(d.amount)}</span>
              </div>
              {d.note && <div className="opacity-75">{d.note}</div>}
            </li>
          ))}
          {deposits.length === 0 && <li className="py-2 text-sm opacity-70">မှတ်တမ် မရှိသေးပါ</li>}
        </ul>
        {!closed && (
          <form onSubmit={onAddDeposit} className="space-y-2.5 pt-3">
            <div className="grid grid-cols-3 gap-2.5">
              <Field label="ရက်စွဲ">
                <input
                  type="date"
                  value={depDate}
                  onChange={(e) => setDepDate(e.target.value)}
                  max={todayYangon()}
                  disabled={!isOwner}
                  required
                  className={inputCls}
                />
              </Field>
              <Field label="ဘူး">
                <input
                  value={depBottles}
                  onChange={(e) => setDepBottles(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                  required
                  className={inputCls}
                />
              </Field>
              <Field label="ဈေးနှုန်း/ဗူး">
                <input
                  value={depPrice}
                  onChange={(e) => setDepPrice(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                  required
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="text-sm opacity-75">
              စုစုပေါင်း: {formatMMK((Number(depBottles) || 0) * (Number(depPrice) || 0))}
            </div>
            <input
              value={depNote}
              onChange={(e) => setDepNote(e.target.value)}
              placeholder="မှတ်ချက် (ရှိလျှင်)"
              className={inputCls}
            />
            <PrimaryButton type="submit" className="w-full">
              အပေါင် ထည့်ရန်
            </PrimaryButton>
          </form>
        )}
      </Card>

      <Card>
        <CardTitle>ကြွေးဖျက် မှတ်တမ်း (Write-off)</CardTitle>
        <ul className="divide-y divide-stone-100 dark:divide-neutral-800">
          {writeOffs.map((w) => (
            <li key={w.id} className="py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span>{w.writeoff_date}</span>
                <span className="font-semibold tabular-nums">{formatMMK(w.amount)}</span>
              </div>
              <div className="opacity-75">{w.note}</div>
            </li>
          ))}
          {writeOffs.length === 0 && <li className="py-2 text-sm opacity-70">မှတ်တမ် မရှိသေးပါ</li>}
        </ul>
        {!closed && (
          <form onSubmit={onAddWriteOff} className="space-y-2.5 pt-3">
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="ပမာဏ (ကျပ်)">
                <input
                  value={woAmount}
                  onChange={(e) => setWoAmount(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                  required
                  className={inputCls}
                />
              </Field>
              <Field label="အကြောင်းပြချက် (လိုအပ်)">
                <input
                  value={woNote}
                  onChange={(e) => setWoNote(e.target.value)}
                  required
                  className={inputCls}
                />
              </Field>
            </div>
            <PrimaryButton type="submit" className="w-full">
              ကြွေးဖျက် ထည့်ရန်
            </PrimaryButton>
          </form>
        )}
      </Card>

      {closed && settlement && (
        <>
          <SettlementSummary s={settlement} />
          {isOwner &&
            (confirmDelete ? (
              <div className="flex flex-wrap gap-2">
                <DangerButton size="sm" onClick={onHardDelete}>
                  သေချာပါတယ်, အပြီးဖျက်မည်
                </DangerButton>
                <SecondaryButton size="sm" onClick={() => setConfirmDelete(false)}>
                  မဖျက်တော့ပါ
                </SecondaryButton>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="inline-flex min-h-[44px] items-center px-1 text-sm font-medium text-red-600 dark:text-red-400"
              >
                ကိုယ်စားလှယ်ကို အပြီးဖျက်ရန် (Owner သာ)
              </button>
            ))}
        </>
      )}
    </div>
  )
}
