import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  formatMMK,
  todayYangon,
  PRICE_DIFF_KIND_LABELS,
  type Agent,
  type AgentPayment,
  type AgentSettlement,
  type WriteOff,
} from '../lib/types'
import { SettlementSummary } from './AgentDetailPage'

interface SettlementPreview {
  missing: number
  avg: number
  origRet: number
  currRet: number
  refund: number
  priceDiff: number
  kind: AgentSettlement['price_diff_kind']
  forfeiture: number
  netRefund: number
  agentOwes: number
}

/**
 * Settlement preview — the EXACT math of the old app (and of the server's
 * finalize_closeout RPC, which stays authoritative at finalize time):
 * the agent is always refunded the better of original vs today's deposit
 * value for returned bottles; missing bottles are charged at today's price,
 * partly offset by their original deposit share.
 */
function computeSettlementPreview(
  held: number,
  returned: number,
  depBottles: number,
  depAmount: number,
  price: number,
): SettlementPreview {
  const missing = Math.max(held - returned, 0)
  const avg = depBottles > 0 ? depAmount / depBottles : 0
  const missingDep = Math.min(missing, depBottles)
  const returnedDep = Math.max(depBottles - missingDep, 0)
  const origRet = avg * returnedDep
  const currRet = price * returnedDep
  const refund = Math.round(Math.max(origRet, currRet))
  const priceDiff = Math.round(Math.abs(currRet - origRet))
  const kind: SettlementPreview['kind'] =
    priceDiff === 0 ? 'none' : currRet > origRet ? 'extra_pay' : 'price_drop'
  const forfeiture = missing * price
  const net = refund + avg * missingDep - forfeiture
  return {
    missing,
    avg,
    origRet,
    currRet,
    refund,
    priceDiff,
    kind,
    forfeiture,
    netRefund: Math.max(0, Math.round(net)),
    agentOwes: Math.max(0, Math.round(-net)),
  }
}

export default function CloseoutPage() {
  const { id } = useParams<{ id: string }>()

  const [agent, setAgent] = useState<Agent | null>(null)
  const [held, setHeld] = useState(0)
  const [depBottles, setDepBottles] = useState(0)
  const [depAmount, setDepAmount] = useState(0)
  const [outstanding, setOutstanding] = useState(0)
  const [payments, setPayments] = useState<AgentPayment[]>([])
  const [writeOffs, setWriteOffs] = useState<WriteOff[]>([])
  const [existing, setExisting] = useState<AgentSettlement | null>(null)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Step inputs
  const [returned, setReturned] = useState('')
  const [price, setPrice] = useState('')
  const [note, setNote] = useState('')
  const [result, setResult] = useState<AgentSettlement | null>(null)
  const initialized = useRef(false)

  // Step 2 forms
  const [payDate, setPayDate] = useState(todayYangon())
  const [payAmount, setPayAmount] = useState('')
  const [payNote, setPayNote] = useState('')
  const [woAmount, setWoAmount] = useState('')
  const [woNote, setWoNote] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    const [{ data: ag }, { data: en }, { data: dp }, { data: pm }, { data: wo }, { data: st }, out] =
      await Promise.all([
        supabase.from('agents').select('*').eq('id', id).maybeSingle(),
        supabase.from('daily_entries').select('delivered_qty, returned_qty').eq('agent_id', id),
        supabase.from('agent_deposits').select('bottles, amount').eq('agent_id', id),
        supabase
          .from('agent_payments')
          .select('*')
          .eq('agent_id', id)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('write_offs')
          .select('*')
          .eq('agent_id', id)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase.from('agent_settlements').select('*').eq('agent_id', id).maybeSingle(),
        supabase.rpc('agent_outstanding', { p_agent: id }),
      ])
    const a = (ag as Agent | null) ?? null
    const heldNow = ((en ?? []) as { delivered_qty: number; returned_qty: number }[]).reduce(
      (s, e) => s + e.delivered_qty - e.returned_qty,
      0,
    )
    const dep = (dp ?? []) as { bottles: number; amount: number }[]
    setAgent(a)
    setHeld(heldNow)
    setDepBottles(dep.reduce((s, d) => s + d.bottles, 0))
    setDepAmount(dep.reduce((s, d) => s + d.amount, 0))
    setPayments((pm ?? []) as AgentPayment[])
    setWriteOffs((wo ?? []) as WriteOff[])
    setExisting((st as AgentSettlement | null) ?? null)
    setOutstanding(typeof out.data === 'number' ? out.data : 0)
    if (a && !initialized.current) {
      // Sensible defaults, editable: everything came back, deposit price
      // still at the agent's per-bottle deposit rate.
      setReturned(String(heldNow))
      setPrice(String(a.deposit_per_bottle || ''))
      initialized.current = true
    }
    setLoading(false)
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const returnedNum = Number(returned) || 0
  const returnedValid =
    returned !== '' &&
    Number.isInteger(returnedNum) &&
    returnedNum >= 0 &&
    returnedNum <= held
  const priceNum = Number(price) || 0

  const preview = useMemo(
    () => computeSettlementPreview(held, returnedValid ? returnedNum : held, depBottles, depAmount, priceNum),
    [held, returnedValid, returnedNum, depBottles, depAmount, priceNum],
  )

  async function onAddPayment(e: FormEvent) {
    e.preventDefault()
    if (!id) return
    setMsg(null)
    const { error } = await supabase.from('agent_payments').insert({
      agent_id: id,
      payment_date: payDate,
      amount: Number(payAmount) || 0,
      notes: payNote.trim() || null,
    })
    if (error) {
      setMsg(error.message)
      return
    }
    setPayAmount('')
    setPayNote('')
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

  async function onFinalize() {
    if (!id || busy) return
    setMsg(null)
    setBusy(true)
    const { data, error } = await supabase.rpc('finalize_closeout', {
      p_agent: id,
      p_returned: returnedNum,
      p_current_price: priceNum,
      p_note: note.trim() || null,
    })
    setBusy(false)
    if (error) {
      setMsg(error.message)
      return
    }
    setResult(data as AgentSettlement)
    await load()
  }

  if (loading) return <p>ခဏစောင့်ပါ…</p>
  if (!agent) return <p className="text-sm text-red-600">ကိုယ်စားလှယ် မတွေ့ပါ</p>

  if (result || existing) {
    const s = result ?? existing
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-bold">စာရင်းပိတ်ခြင်း — {agent.name}</h1>
        <p className="text-sm text-teal-700">✅ စာရင်းပိတ်ပြီးပါပြီ</p>
        {s && <SettlementSummary s={s} />}
        <Link to="/agents" className="block text-center text-sm text-teal-700 underline dark:text-teal-400">
          ကိုယ်စားလှယ်များသို့ ပြန်သွားရန်
        </Link>
      </div>
    )
  }

  const step2Done = outstanding <= 0
  const canFinalize = returnedValid && step2Done && priceNum > 0

  const previewRows: [string, string][] = [
    ['အပေါင်ဘူး စုစုပေါင်း', `${depBottles.toLocaleString('en-US')} လုံး (ပျမ်းမျှ ${formatMMK(Math.round(preview.avg))}/လုံး)`],
    ['ပျောက်ဘူး', `${preview.missing.toLocaleString('en-US')} လုံး`],
    ['မူလတန်ဖိုးဖြင့် ပြန်အမ်း', formatMMK(Math.round(preview.origRet))],
    ['ယနေ့ဈေးဖြင့် ပြန်အမ်း', formatMMK(Math.round(preview.currRet))],
    ['ပြန်အမ်းငွေ (ပိုများရာ)', formatMMK(preview.refund)],
    ['ဈေးကွာ', `${formatMMK(preview.priceDiff)} (${PRICE_DIFF_KIND_LABELS[preview.kind]})`],
    ['ပျောက်ဘူး ကောက်ငွေ', formatMMK(preview.forfeiture)],
    ['အမှန် ပြန်အမ်းငွေ', formatMMK(preview.netRefund)],
    ['ကိုယ်စားလှယ် ပေးရန်ကျန်', formatMMK(preview.agentOwes)],
  ]

  return (
    <div className="space-y-4">
      <div>
        <Link to={`/agents/${agent.id}`} className="text-sm text-teal-700 underline dark:text-teal-400">
          ← {agent.name} အသေးစိတ်
        </Link>
        <h1 className="mt-1 text-lg font-bold">စာရင်းပိတ်ခြင်း — {agent.name}</h1>
      </div>

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      <section className="space-y-2 rounded-2xl border p-4">
        <div className="font-semibold">အဆင့် ၁ — ဘူးရေတွက်</div>
        <div className="text-sm">
          ကိုင်ထားဘူး: <span className="font-semibold">{held.toLocaleString('en-US')} လုံး</span>
        </div>
        <label className="block text-sm">
          ပြန်အပ်ဘူး (၀ မှ {held.toLocaleString('en-US')} အတွင်း)
          <input
            value={returned}
            onChange={(e) => setReturned(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
          />
        </label>
        {returned !== '' && !returnedValid && (
          <p className="text-sm text-red-600">ပြန်အပ်ဘူး အရေအတွက် မမှန်ပါ</p>
        )}
        <p className="text-sm opacity-75">
          ပျောက်ဘူး: {preview.missing.toLocaleString('en-US')} လုံး
        </p>
      </section>

      <section className="space-y-3 rounded-2xl border p-4">
        <div className="font-semibold">အဆင့် ၂ — ကြွေးရှင်း</div>
        <div className="text-sm">
          ရရန်ကျန်: <span className="font-semibold">{formatMMK(outstanding)}</span>
        </div>
        {step2Done ? (
          <p className="text-sm text-teal-700">✅ ကြွေးရှင်းပြီးပါပြီ — နောက်အဆင့်များ ဆက်လုပ်နိုင်ပါပြီ</p>
        ) : (
          <>
            <form onSubmit={onAddPayment} className="space-y-2">
              <div className="text-sm font-medium">ငွေကောက် ထည့်ရန်</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-sm">
                  ရက်စွဲ
                  <input
                    type="date"
                    value={payDate}
                    onChange={(e) => setPayDate(e.target.value)}
                    required
                    className="mt-1 w-full rounded-xl border px-2 py-2 dark:bg-neutral-900"
                  />
                </label>
                <label className="text-sm">
                  ပမာဏ (ကျပ်)
                  <input
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value.replace(/\D/g, ''))}
                    inputMode="numeric"
                    required
                    className="mt-1 w-full rounded-xl border px-2 py-2 dark:bg-neutral-900"
                  />
                </label>
              </div>
              <input
                value={payNote}
                onChange={(e) => setPayNote(e.target.value)}
                placeholder="မှတ်ချက် (ရှိလျှင်)"
                className="w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
              <button className="w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white">
                ငွေကောက် သိမ်းရန်
              </button>
            </form>

            <form onSubmit={onAddWriteOff} className="space-y-2">
              <div className="text-sm font-medium">ကြွေးဖျက် ထည့်ရန် (Write-off)</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-sm">
                  ပမာဏ (ကျပ်)
                  <input
                    value={woAmount}
                    onChange={(e) => setWoAmount(e.target.value.replace(/\D/g, ''))}
                    inputMode="numeric"
                    required
                    className="mt-1 w-full rounded-xl border px-2 py-2 dark:bg-neutral-900"
                  />
                </label>
                <label className="text-sm">
                  အကြောင်းပြချက် (လိုအပ်)
                  <input
                    value={woNote}
                    onChange={(e) => setWoNote(e.target.value)}
                    required
                    className="mt-1 w-full rounded-xl border px-2 py-2 dark:bg-neutral-900"
                  />
                </label>
              </div>
              <button className="w-full rounded-xl border py-2.5 font-semibold">
                ကြွေးဖျက် သိမ်းရန်
              </button>
            </form>

            {(payments.length > 0 || writeOffs.length > 0) && (
              <ul className="divide-y text-sm">
                {payments.map((p) => (
                  <li key={p.id} className="flex justify-between py-1.5">
                    <span>
                      {p.payment_date} · ငွေကောက်{p.notes ? ` · ${p.notes}` : ''}
                    </span>
                    <span className="font-medium">{formatMMK(p.amount)}</span>
                  </li>
                ))}
                {writeOffs.map((w) => (
                  <li key={w.id} className="flex justify-between py-1.5">
                    <span>
                      {w.writeoff_date} · ကြွေးဖျက် · {w.note}
                    </span>
                    <span className="font-medium">{formatMMK(w.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* Steps 3–4 stay visible from the start so the user can see the whole
          flow; they render locked (dimmed, disabled) until the debt in
          step 2 is cleared, then unlock live on the next load. */}
      <section
        className={`space-y-2 rounded-2xl border p-4 ${step2Done ? '' : 'opacity-50'}`}
      >
        <div className="font-semibold">အဆင့် ၃ — အပေါင် ပြန်အမ်း</div>
        {!step2Done && (
          <p className="text-sm font-medium text-amber-600 dark:text-amber-500">
            🔒 ကြွေး အရင် ရှင်းပြီးမှ ဒီ အဆင့် ဖွင့်ပါမယ်
          </p>
        )}
        <label className="block text-sm">
          ယနေ့ အပေါင် ပေါက်ဈေး (၁ လုံး)
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            disabled={!step2Done}
            className="mt-1 w-full rounded-xl border px-3 py-2 disabled:cursor-not-allowed dark:bg-neutral-900"
          />
        </label>
        <dl className="space-y-1 text-sm">
          {previewRows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-2">
              <dt className="opacity-75">{k}</dt>
              <dd className="font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section
        className={`space-y-2 rounded-2xl border p-4 ${step2Done ? '' : 'opacity-50'}`}
      >
        <div className="font-semibold">အဆင့် ၄ — အတည်ပြု</div>
        {!step2Done && (
          <p className="text-sm font-medium text-amber-600 dark:text-amber-500">
            🔒 ကြွေး အရင် ရှင်းပြီးမှ ဒီ အဆင့် ဖွင့်ပါမယ်
          </p>
        )}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="မှတ်ချက် (ရှိလျှင်)"
          disabled={!step2Done}
          className="w-full rounded-xl border px-3 py-2 disabled:cursor-not-allowed dark:bg-neutral-900"
        />
        <button
          onClick={onFinalize}
          disabled={!canFinalize || busy}
          className="w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'ပိတ်နေပါတယ်…' : 'စာရင်းပိတ် အတည်ပြုရန်'}
        </button>
        <p className="text-xs opacity-60">
          အတည်ပြုလိုက်ရင် ကိုယ်စားလှယ်ကို ပိတ်ပြီး စာရင်းပိတ် မှတ်တမ်း သိမ်းပါမယ်။ ဈေးကွာ
          ရှိရင် (ဈေးကွာ ၀ ထက် များရင်) အသုံးစရိတ်ထဲမှာ «ဗူးအပေါင် ဈေးကွာ» မှတ်တမ်း
          အလိုအလျောက် ထည့်ပေးပါမယ်။
        </p>
      </section>
    </div>
  )
}
