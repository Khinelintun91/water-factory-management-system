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
import {
  Banner,
  Card,
  Field,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  btnSecondaryCls,
  cardCls,
  inputCls,
} from '../components/ui'

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

type StepState = 'done' | 'current' | 'todo' | 'locked'

/** Wizard progress header: numbered steps with the current one ringed,
 *  finished ones checked, and not-yet-open ones (3–4 before the debt is
 *  cleared) visibly dimmed/locked. Pure presentation of the step logic. */
function StepProgress({ steps }: { steps: { num: string; label: string; state: StepState }[] }) {
  const circleCls = (s: StepState) =>
    s === 'done'
      ? 'bg-brand-700 text-white'
      : s === 'current'
        ? 'bg-brand-50 text-brand-700 ring-2 ring-brand-600 dark:bg-brand-950/50 dark:text-brand-300'
        : s === 'locked'
          ? 'bg-stone-100 text-stone-400 dark:bg-neutral-800 dark:text-neutral-500'
          : 'bg-stone-100 text-stone-500 dark:bg-neutral-800 dark:text-neutral-400'
  const labelCls = (s: StepState) =>
    s === 'done' || s === 'current'
      ? 'font-semibold text-stone-800 dark:text-neutral-100'
      : s === 'locked'
        ? 'text-stone-400 dark:text-neutral-500'
        : 'text-stone-500 dark:text-neutral-400'
  return (
    <div className={`${cardCls} px-4 py-3.5`}>
      <ol className="flex items-start">
        {steps.map((s, i) => (
          <li key={s.num} className="flex flex-1 items-start last:flex-none">
            <div className="flex w-14 flex-col items-center">
              <span
                className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold ${circleCls(s.state)}`}
              >
                {s.state === 'done' ? '✓' : s.num}
              </span>
              <span className={`mt-1.5 text-center text-xs leading-tight ${labelCls(s.state)}`}>
                {s.label}
                {s.state === 'locked' ? ' 🔒' : ''}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                className={`mx-1 mt-4 h-0.5 min-w-3 flex-1 rounded ${
                  s.state === 'done'
                    ? 'bg-brand-300 dark:bg-brand-700'
                    : 'bg-stone-200 dark:bg-neutral-800'
                }`}
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** Section heading: numbered badge + the step's existing title text. */
function StepHeading({ num, title }: { num: string; title: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-700 text-sm font-bold text-white">
        {num}
      </span>
      <h2 className="text-base font-semibold">{title}</h2>
    </div>
  )
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

  if (loading) return <LoadingState />
  if (!agent) return <p className="text-sm text-red-600">ကိုယ်စားလှယ် မတွေ့ပါ</p>

  if (result || existing) {
    const s = result ?? existing
    return (
      <div className="space-y-4 lg:space-y-6">
        <PageHeader
          title={`စာရင်းပိတ်ခြင်း — ${agent.name}`}
          subtitle="ဘူးရေတွက်၊ ကြွေးရှင်းပြီး အပေါင် ပြန်အမ်း၍ စာရင်းပိတ်ရန်"
        />
        <Banner tone="brand">✅ စာရင်းပိတ်ပြီးပါပြီ</Banner>
        {s && <SettlementSummary s={s} />}
        <Link to="/agents" className={btnSecondaryCls}>
          ကိုယ်စားလှယ်များသို့ ပြန်သွားရန်
        </Link>
      </div>
    )
  }

  const step2Done = outstanding <= 0
  const canFinalize = returnedValid && step2Done && priceNum > 0

  const steps: { num: string; label: string; state: StepState }[] = [
    {
      num: '၁',
      label: 'ဘူးရေတွက်',
      state: returnedValid ? 'done' : 'current',
    },
    {
      num: '၂',
      label: 'ကြွေးရှင်း',
      state: step2Done ? 'done' : returnedValid ? 'current' : 'todo',
    },
    {
      num: '၃',
      label: 'အပေါင် ပြန်အမ်း',
      state: !step2Done ? 'locked' : priceNum > 0 ? 'done' : 'current',
    },
    {
      num: '၄',
      label: 'အတည်ပြု',
      state: !step2Done ? 'locked' : canFinalize ? 'current' : 'todo',
    },
  ]

  const previewRows: [string, string][] = [
    ['အပေါင်ဘူး စုစုပေါင်း', `${depBottles.toLocaleString('en-US')} ဗူး (ပျမ်းမျှ ${formatMMK(Math.round(preview.avg))}/ဗူး)`],
    ['ပျောက်ဘူး', `${preview.missing.toLocaleString('en-US')} ဗူး`],
    ['မူလတန်ဖိုးဖြင့် ပြန်အမ်း', formatMMK(Math.round(preview.origRet))],
    ['ယနေ့ဈေးဖြင့် ပြန်အမ်း', formatMMK(Math.round(preview.currRet))],
    ['ပြန်အမ်းငွေ (ပိုများရာ)', formatMMK(preview.refund)],
    ['ဈေးကွာ', `${formatMMK(preview.priceDiff)} (${PRICE_DIFF_KIND_LABELS[preview.kind]})`],
    ['ပျောက်ဘူး ကောက်ငွေ', formatMMK(preview.forfeiture)],
    ['အမှန် ပြန်အမ်းငွေ', formatMMK(preview.netRefund)],
    ['ကိုယ်စားလှယ် ပေးရန်ကျန်', formatMMK(preview.agentOwes)],
  ]

  return (
    <div className="space-y-4 lg:space-y-6">
      <div>
        <Link
          to={`/agents/${agent.id}`}
          className="text-sm font-medium text-brand-700 underline dark:text-brand-300"
        >
          ← {agent.name} အသေးစိတ်
        </Link>
        <div className="mt-1.5">
          <PageHeader
            title={`စာရင်းပိတ်ခြင်း — ${agent.name}`}
            subtitle="ဘူးရေတွက်၊ ကြွေးရှင်းပြီး အပေါင် ပြန်အမ်း၍ စာရင်းပိတ်ရန်"
          />
        </div>
      </div>

      {msg && (
        <p className="text-sm text-red-600" role="alert">
          {msg}
        </p>
      )}

      <StepProgress steps={steps} />

      <Card className="space-y-3">
        <StepHeading num="၁" title="အဆင့် ၁ — ဘူးရေတွက်" />
        <div className="rounded-xl bg-brand-50 px-3.5 py-2.5 text-sm dark:bg-brand-950/40">
          ကိုင်ထားဘူး:{' '}
          <span className="font-bold tabular-nums">{held.toLocaleString('en-US')} ဗူး</span>
        </div>
        <Field label={`ပြန်အပ်ဘူး (၀ မှ ${held.toLocaleString('en-US')} အတွင်း)`}>
          <input
            value={returned}
            onChange={(e) => setReturned(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            className={inputCls}
          />
        </Field>
        {returned !== '' && !returnedValid && (
          <p className="text-sm text-red-600">ပြန်အပ်ဘူး အရေအတွက် မမှန်ပါ</p>
        )}
        <p className="text-sm text-stone-500 dark:text-neutral-400">
          ပျောက်ဘူး: {preview.missing.toLocaleString('en-US')} ဗူး
        </p>
      </Card>

      <Card className="space-y-3">
        <StepHeading num="၂" title="အဆင့် ၂ — ကြွေးရှင်း" />
        <div className="rounded-xl bg-accent-50 px-3.5 py-2.5 text-sm dark:bg-amber-950/30">
          ရရန်ကျန်: <span className="font-bold tabular-nums">{formatMMK(outstanding)}</span>
        </div>
        {step2Done ? (
          <Banner tone="brand">✅ ကြွေးရှင်းပြီးပါပြီ — နောက်အဆင့်များ ဆက်လုပ်နိုင်ပါပြီ</Banner>
        ) : (
          <>
            <form onSubmit={onAddPayment} className="space-y-2.5">
              <div className="text-sm font-semibold">ငွေကောက် ထည့်ရန်</div>
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="ရက်စွဲ">
                  <input
                    type="date"
                    value={payDate}
                    onChange={(e) => setPayDate(e.target.value)}
                    required
                    className={inputCls}
                  />
                </Field>
                <Field label="ပမာဏ (ကျပ်)">
                  <input
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value.replace(/\D/g, ''))}
                    inputMode="numeric"
                    required
                    className={inputCls}
                  />
                </Field>
              </div>
              <input
                value={payNote}
                onChange={(e) => setPayNote(e.target.value)}
                placeholder="မှတ်ချက် (ရှိလျှင်)"
                className={inputCls}
              />
              <PrimaryButton type="submit" className="w-full">
                ငွေကောက် သိမ်းရန်
              </PrimaryButton>
            </form>

            <form onSubmit={onAddWriteOff} className="space-y-2.5">
              <div className="text-sm font-semibold">ကြွေးဖျက် ထည့်ရန် (Write-off)</div>
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
              <SecondaryButton type="submit" className="w-full">
                ကြွေးဖျက် သိမ်းရန်
              </SecondaryButton>
            </form>

            {(payments.length > 0 || writeOffs.length > 0) && (
              <ul className="divide-y divide-stone-100 text-sm dark:divide-neutral-800">
                {payments.map((p) => (
                  <li key={p.id} className="flex items-baseline justify-between gap-2 py-2">
                    <span>
                      {p.payment_date} · ငွေကောက်{p.notes ? ` · ${p.notes}` : ''}
                    </span>
                    <span className="font-medium tabular-nums">{formatMMK(p.amount)}</span>
                  </li>
                ))}
                {writeOffs.map((w) => (
                  <li key={w.id} className="flex items-baseline justify-between gap-2 py-2">
                    <span>
                      {w.writeoff_date} · ကြွေးဖျက် · {w.note}
                    </span>
                    <span className="font-medium tabular-nums">{formatMMK(w.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      {/* Steps 3–4 stay visible from the start so the user can see the whole
          flow; they render locked (dimmed, disabled) until the debt in
          step 2 is cleared, then unlock live on the next load. */}
      <Card className={`space-y-3 ${step2Done ? '' : 'opacity-50'}`}>
        <StepHeading num="၃" title="အဆင့် ၃ — အပေါင် ပြန်အမ်း" />
        {!step2Done && (
          <p className="text-sm font-medium text-accent-700 dark:text-amber-500">
            🔒 ကြွေး အရင် ရှင်းပြီးမှ ဒီ အဆင့် ဖွင့်ပါမယ်
          </p>
        )}
        <Field label="ယနေ့ အပေါင် ပေါက်ဈေး (၁ ဗူး)">
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            disabled={!step2Done}
            className={`${inputCls} disabled:cursor-not-allowed disabled:opacity-60`}
          />
        </Field>
        <dl className="text-sm">
          {previewRows.map(([k, v]) => (
            <div
              key={k}
              className="flex items-baseline justify-between gap-3 border-b border-stone-100 py-1.5 last:border-0 dark:border-neutral-800/70"
            >
              <dt className="text-stone-500 dark:text-neutral-400">{k}</dt>
              <dd
                className={`tabular-nums ${
                  k === 'အမှန် ပြန်အမ်းငွေ' || k === 'ကိုယ်စားလှယ် ပေးရန်ကျန်'
                    ? 'font-bold'
                    : 'font-medium'
                }`}
              >
                {v}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className={`space-y-3 ${step2Done ? '' : 'opacity-50'}`}>
        <StepHeading num="၄" title="အဆင့် ၄ — အတည်ပြု" />
        {!step2Done && (
          <p className="text-sm font-medium text-accent-700 dark:text-amber-500">
            🔒 ကြွေး အရင် ရှင်းပြီးမှ ဒီ အဆင့် ဖွင့်ပါမယ်
          </p>
        )}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="မှတ်ချက် (ရှိလျှင်)"
          disabled={!step2Done}
          className={`${inputCls} disabled:cursor-not-allowed disabled:opacity-60`}
        />
        <PrimaryButton onClick={onFinalize} disabled={!canFinalize || busy} className="w-full">
          {busy ? 'ပိတ်နေပါတယ်…' : 'စာရင်းပိတ် အတည်ပြုရန်'}
        </PrimaryButton>
        <p className="text-xs text-stone-500 dark:text-neutral-400">
          အတည်ပြုလိုက်ရင် ကိုယ်စားလှယ်ကို ပိတ်ပြီး စာရင်းပိတ် မှတ်တမ်း သိမ်းပါမယ်။ ဈေးကွာ
          ရှိရင် (ဈေးကွာ ၀ ထက် များရင်) အသုံးစရိတ်ထဲမှာ «ဗူးအပေါင် ဈေးကွာ» မှတ်တမ်း
          အလိုအလျောက် ထည့်ပေးပါမယ်။
        </p>
      </Card>
    </div>
  )
}
