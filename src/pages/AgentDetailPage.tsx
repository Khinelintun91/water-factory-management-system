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

export function SettlementSummary({ s }: { s: AgentSettlement }) {
  const rows: [string, string][] = [
    ['စာရင်းပိတ်ရက်', s.settle_date],
    ['ကိုင်ထားဘူး', `${s.held_bottles.toLocaleString('en-US')} လုံး`],
    ['ပြန်အပ်ဘူး', `${s.returned_bottles.toLocaleString('en-US')} လုံး`],
    ['ပျောက်ဘူး', `${s.missing_bottles.toLocaleString('en-US')} လုံး`],
    ['ယနေ့ ပေါက်ဈေး', `${formatMMK(s.current_price)}/လုံး`],
    ['မူလ အပေါင် စုစုပေါင်း', formatMMK(s.deposit_original)],
    ['ပြန်အမ်းငွေ', formatMMK(s.refund_amount)],
    ['ဈေးကွာ', `${formatMMK(s.price_diff)} (${PRICE_DIFF_KIND_LABELS[s.price_diff_kind]})`],
    ['ပျောက်ဘူး ကောက်ငွေ', formatMMK(s.forfeiture_income)],
    ['အမှန် ပြန်အမ်းငွေ', formatMMK(s.net_refund)],
    ['ကိုယ်စားလှယ် ပေးရန်ကျန်', formatMMK(s.agent_owes)],
  ]
  return (
    <div className="rounded-2xl border p-4">
      <div className="font-semibold">စာရင်းပိတ် အကျဉ်းချုပ်</div>
      <dl className="mt-2 space-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-2">
            <dt className="opacity-75">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
        {s.note && (
          <div className="flex items-center justify-between gap-2">
            <dt className="opacity-75">မှတ်ချက်</dt>
            <dd className="font-medium">{s.note}</dd>
          </div>
        )}
      </dl>
    </div>
  )
}

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { profile } = useAuth()
  const navigate = useNavigate()
  const isOwner = profile?.role === 'owner'

  const [agent, setAgent] = useState<Agent | null>(null)
  const [phone, setPhone] = useState<string | null>(null)
  const [entries, setEntries] = useState<DailyEntry[]>([])
  const [payments, setPayments] = useState<AgentPayment[]>([])
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

  // Write-off form
  const [woAmount, setWoAmount] = useState('')
  const [woNote, setWoNote] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const [{ data: ag }, { data: ct }, { data: en }, { data: pm }, { data: dp }, { data: wo }, { data: st }, out] =
      await Promise.all([
        supabase.from('agents').select('*').eq('id', id).maybeSingle(),
        supabase.from('agent_contacts').select('phone').eq('agent_id', id).maybeSingle(),
        supabase
          .from('daily_entries')
          .select('*')
          .eq('agent_id', id)
          .order('created_at', { ascending: false })
          .limit(10000),
        supabase
          .from('agent_payments')
          .select('*')
          .eq('agent_id', id)
          .order('created_at', { ascending: false })
          .limit(10000),
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
      ])
    const a = (ag as Agent | null) ?? null
    setAgent(a)
    setPhone((ct as { phone: string } | null)?.phone ?? null)
    setEntries((en ?? []) as DailyEntry[])
    setPayments((pm ?? []) as AgentPayment[])
    setDeposits((dp ?? []) as AgentDeposit[])
    setWriteOffs((wo ?? []) as WriteOff[])
    setSettlement((st as AgentSettlement | null) ?? null)
    setOutstanding(typeof out.data === 'number' ? out.data : 0)
    if (a && depPrice === '') setDepPrice(String(a.deposit_per_bottle || ''))
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const stats = useMemo(() => {
    const held = entries.reduce((s, e) => s + e.delivered_qty - e.returned_qty, 0)
    const sales = entries.reduce((s, e) => s + e.amount, 0)
    const cash = entries.reduce((s, e) => s + (e.amount_collected ?? 0), 0)
    const paid = payments.reduce((s, p) => s + p.amount, 0)
    const depBottles = deposits.reduce((s, d) => s + d.bottles, 0)
    const depAmount = deposits.reduce((s, d) => s + d.amount, 0)
    return { held, sales, collected: cash + paid, depBottles, depAmount }
  }, [entries, payments, deposits])

  const canDeliver = useMemo(() => {
    if (!agent) return '—'
    const { held, depBottles } = stats
    if (agent.deposit_per_bottle > 0) {
      const cap = agent.bottle_limit > 0 ? Math.min(agent.bottle_limit, depBottles) : depBottles
      return `${Math.max(0, cap - held).toLocaleString('en-US')} လုံး`
    }
    if (agent.bottle_limit > 0) {
      return `${Math.max(0, agent.bottle_limit - held).toLocaleString('en-US')} လုံး`
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

  if (loading) return <p>ခဏစောင့်ပါ…</p>
  if (!agent) return <p className="text-sm text-red-600">ကိုယ်စားလှယ် မတွေ့ပါ</p>

  const closed = Boolean(agent.closed_at)
  const statCards: [string, string][] = [
    ['ကိုင်ထားဘူး', `${stats.held.toLocaleString('en-US')} လုံး`],
    ['အပေါင်ဘူး', `${stats.depBottles.toLocaleString('en-US')} လုံး (${formatMMK(stats.depAmount)})`],
    ['စုစုပေါင်း ရောင်းရ', formatMMK(stats.sales)],
    ['ကောက်ခံပြီး', formatMMK(stats.collected)],
    ['ရရန်ကျန်', formatMMK(outstanding)],
    ['ဆက်ပို့နိုင်ဘူး', canDeliver],
  ]

  return (
    <div className="space-y-4">
      <div>
        <Link to="/agents" className="text-sm text-teal-700 underline dark:text-teal-400">
          ← ကိုယ်စားလှယ်များ
        </Link>
        <h1 className="mt-1 text-lg font-bold">
          {agent.name} {agent.code && <span className="text-sm opacity-60">({agent.code})</span>}
        </h1>
      </div>

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      <div className="rounded-2xl border p-4 text-sm">
        <div className="space-y-1">
          <div>ဖုန်း: {phone ?? '—'}</div>
          {agent.address && <div>လိပ်စာ: {agent.address}</div>}
          <div>
            ဈေးနှုန်း: {formatMMK(agent.default_unit_price)}/လုံး · အပ်ငွေ:{' '}
            {formatMMK(agent.deposit_per_bottle)}/လုံး
          </div>
          <div>
            ဘူး ကန့်သတ်: {agent.bottle_limit > 0 ? `${agent.bottle_limit.toLocaleString('en-US')} လုံး` : 'မကန့်သတ်'} ·
            ကြွေး ကန့်သတ်: {agent.credit_limit > 0 ? formatMMK(agent.credit_limit) : 'မကန့်သတ်'}
          </div>
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
          <Link
            to={`/closeout/${agent.id}`}
            className="mt-3 block rounded-xl bg-teal-700 py-2.5 text-center font-semibold text-white"
          >
            စာရင်းပိတ်ရန်
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {statCards.map(([label, value]) => (
          <div key={label} className="rounded-2xl border p-3">
            <div className="text-xs opacity-70">{label}</div>
            <div className="mt-0.5 font-semibold">{value}</div>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <h2 className="font-semibold">ပို့ဆောင်မှု မှတ်တမ်းများ (နောက်ဆုံး ၅၀)</h2>
        <ul className="divide-y rounded-2xl border">
          {entries.slice(0, 50).map((r) => (
            <li key={r.id} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">{r.entry_date}</div>
                <div className="text-sm font-semibold">{formatMMK(r.amount)}</div>
              </div>
              <div className="text-sm opacity-75">
                ပို့ {r.delivered_qty} · ပြန် {r.returned_qty} · ငွေကောက်{' '}
                {formatMMK(r.amount_collected ?? 0)} · ကျန်ကြွေး{' '}
                {formatMMK(r.amount - (r.amount_collected ?? 0))}
                {r.notes ? ` · ${r.notes}` : ''}
              </div>
            </li>
          ))}
          {entries.length === 0 && <li className="p-3 text-sm opacity-70">မှတ်တမ် မရှိသေးပါ</li>}
        </ul>
      </div>

      <div className="space-y-2">
        <h2 className="font-semibold">ငွေကောက်ခံမှု မှတ်တမ်းများ (နောက်ဆုံး ၅၀)</h2>
        <ul className="divide-y rounded-2xl border">
          {payments.slice(0, 50).map((p) => (
            <li key={p.id} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">{p.payment_date}</div>
                <div className="text-sm font-semibold">{formatMMK(p.amount)}</div>
              </div>
              <div className="text-sm opacity-75">
                {p.method}
                {p.notes ? ` · ${p.notes}` : ''}
              </div>
            </li>
          ))}
          {payments.length === 0 && <li className="p-3 text-sm opacity-70">မှတ်တမ် မရှိသေးပါ</li>}
        </ul>
      </div>

      <div className="space-y-2 rounded-2xl border p-4">
        <div className="font-semibold">အပေါင် မှတ်တမ်း</div>
        <ul className="divide-y">
          {deposits.map((d) => (
            <li key={d.id} className="py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span>
                  {d.deposit_date} · {d.bottles.toLocaleString('en-US')} လုံး ×{' '}
                  {formatMMK(d.price_per_bottle)}
                </span>
                <span className="font-semibold">{formatMMK(d.amount)}</span>
              </div>
              {d.note && <div className="opacity-75">{d.note}</div>}
            </li>
          ))}
          {deposits.length === 0 && <li className="py-2 text-sm opacity-70">မှတ်တမ် မရှိသေးပါ</li>}
        </ul>
        {!closed && (
          <form onSubmit={onAddDeposit} className="space-y-2 pt-2">
            <div className="grid grid-cols-3 gap-2">
              <label className="text-sm">
                ရက်စွဲ
                <input
                  type="date"
                  value={depDate}
                  onChange={(e) => setDepDate(e.target.value)}
                  required
                  className="mt-1 w-full rounded-xl border px-2 py-2 dark:bg-neutral-900"
                />
              </label>
              <label className="text-sm">
                ဘူး
                <input
                  value={depBottles}
                  onChange={(e) => setDepBottles(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                  required
                  className="mt-1 w-full rounded-xl border px-2 py-2 dark:bg-neutral-900"
                />
              </label>
              <label className="text-sm">
                ဈေးနှုန်း/လုံး
                <input
                  value={depPrice}
                  onChange={(e) => setDepPrice(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                  required
                  className="mt-1 w-full rounded-xl border px-2 py-2 dark:bg-neutral-900"
                />
              </label>
            </div>
            <div className="text-sm opacity-75">
              စုစုပေါင်း: {formatMMK((Number(depBottles) || 0) * (Number(depPrice) || 0))}
            </div>
            <input
              value={depNote}
              onChange={(e) => setDepNote(e.target.value)}
              placeholder="မှတ်ချက် (ရှိလျှင်)"
              className="w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
            />
            <button className="w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white">
              အပေါင် ထည့်ရန်
            </button>
          </form>
        )}
      </div>

      <div className="space-y-2 rounded-2xl border p-4">
        <div className="font-semibold">ကြွေးဖျက် မှတ်တမ်း (Write-off)</div>
        <ul className="divide-y">
          {writeOffs.map((w) => (
            <li key={w.id} className="py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span>{w.writeoff_date}</span>
                <span className="font-semibold">{formatMMK(w.amount)}</span>
              </div>
              <div className="opacity-75">{w.note}</div>
            </li>
          ))}
          {writeOffs.length === 0 && <li className="py-2 text-sm opacity-70">မှတ်တမ် မရှိသေးပါ</li>}
        </ul>
        {!closed && (
          <form onSubmit={onAddWriteOff} className="space-y-2 pt-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-sm">
                ပမာဏ (ကျပ်)
                <input
                  value={woAmount}
                  onChange={(e) => setWoAmount(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                  required
                  className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
                />
              </label>
              <label className="text-sm">
                အကြောင်းပြချက် (လိုအပ်)
                <input
                  value={woNote}
                  onChange={(e) => setWoNote(e.target.value)}
                  required
                  className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
                />
              </label>
            </div>
            <button className="w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white">
              ကြွေးဖျက် ထည့်ရန်
            </button>
          </form>
        )}
      </div>

      {closed && settlement && (
        <>
          <SettlementSummary s={settlement} />
          {isOwner &&
            (confirmDelete ? (
              <div className="flex gap-3 text-sm">
                <button onClick={onHardDelete} className="font-semibold text-red-600">
                  သေချာပါတယ်, အပြီးဖျက်မည်
                </button>
                <button onClick={() => setConfirmDelete(false)} className="opacity-70">
                  မဖျက်တော့ပါ
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-sm text-red-600"
              >
                ကိုယ်စားလှယ်ကို အပြီးဖျက်ရန် (Owner သာ)
              </button>
            ))}
        </>
      )}
    </div>
  )
}
