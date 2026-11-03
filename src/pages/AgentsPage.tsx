import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { formatMMK, todayYangon, type Agent } from '../lib/types'
import {
  EmptyState,
  Field,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  cardCls,
  inputCls,
} from '../components/ui'

interface AgentRow extends Agent {
  phone: string | null
  held: number
  outstanding: number
}

type EditableField = 'default_unit_price' | 'deposit_per_bottle' | 'bottle_limit' | 'credit_limit'

/** Inline numeric field for owner/manager: saves on blur when changed. */
function InlineNumber({
  value,
  onSave,
}: {
  value: number
  onSave: (v: number) => void
}) {
  return (
    <input
      key={value}
      defaultValue={value}
      inputMode="numeric"
      onBlur={(e) => {
        const v = Number(e.target.value.replace(/\D/g, '')) || 0
        if (v !== value) onSave(v)
      }}
      className="min-h-[40px] w-24 rounded-lg border border-stone-300 px-2 py-1.5 text-right text-sm tabular-nums outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/40 dark:border-neutral-700 dark:bg-neutral-900"
    />
  )
}

export default function AgentsPage() {
  const { profile } = useAuth()
  const canManage = profile?.role === 'owner' || profile?.role === 'manager'
  const [rows, setRows] = useState<AgentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  // Add-agent form
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [deposit, setDeposit] = useState('0')
  const [unitPrice, setUnitPrice] = useState('0')
  const [bottleLimit, setBottleLimit] = useState('0')
  const [creditLimit, setCreditLimit] = useState('0')
  const [initDepBottles, setInitDepBottles] = useState('')
  const [initDepPrice, setInitDepPrice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const { data: agents } = await supabase
      .from('agents')
      .select('*')
      .order('created_at', { ascending: true })
    // Phone numbers come from agent_contacts. RLS decides who sees them:
    // owner/manager get rows, staff get none — so staff simply see '—'.
    const [{ data: contacts }, { data: entries }] = await Promise.all([
      supabase.from('agent_contacts').select('agent_id, phone'),
      supabase.from('daily_entries').select('agent_id, delivered_qty, returned_qty'),
    ])
    const phoneByAgent = new Map<string, string>()
    for (const c of (contacts ?? []) as { agent_id: string; phone: string }[]) {
      phoneByAgent.set(c.agent_id, c.phone)
    }
    const heldByAgent = new Map<string, number>()
    for (const e of (entries ?? []) as {
      agent_id: string
      delivered_qty: number
      returned_qty: number
    }[]) {
      heldByAgent.set(e.agent_id, (heldByAgent.get(e.agent_id) ?? 0) + e.delivered_qty - e.returned_qty)
    }
    const list = (agents ?? []) as Agent[]
    // Outstanding comes from the server RPC (single source of truth for the
    // sales − cash − payments − write-offs balance).
    const outstanding = await Promise.all(
      list.map(async (a) => {
        const { data } = await supabase.rpc('agent_outstanding', { p_agent: a.id })
        return typeof data === 'number' ? data : 0
      }),
    )
    setRows(
      list.map((a, i) => ({
        ...a,
        phone: phoneByAgent.get(a.id) ?? null,
        held: heldByAgent.get(a.id) ?? 0,
        outstanding: outstanding[i] ?? 0,
      })),
    )
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    setOkMsg(null)
    const { data, error } = await supabase
      .from('agents')
      .insert({
        name: name.trim(),
        code: code.trim() || null,
        address: address.trim() || null,
        deposit_per_bottle: Number(deposit) || 0,
        default_unit_price: Number(unitPrice) || 0,
        bottle_limit: Number(bottleLimit) || 0,
        credit_limit: Number(creditLimit) || 0,
      })
      .select('id')
      .single()
    if (error) {
      setMsg(error.message)
      return
    }
    const newId = (data as { id: string }).id
    // Partial failures (phone / opening deposit) report themselves via the
    // red msg area; only a fully clean create gets the success message.
    let hadIssue = false
    if (phone.trim()) {
      const { error: cErr } = await supabase
        .from('agent_contacts')
        .insert({ agent_id: newId, phone: phone.trim() })
      if (cErr) {
        hadIssue = true
        setMsg(`Agent ဆောက်ပြီးပါပြီ၊ ဖုန်းနံပါတ် သိမ်း၍ မရပါ: ${cErr.message}`)
      }
    }
    // Optional opening deposit goes straight into the deposits ledger.
    const depBottles = Number(initDepBottles) || 0
    if (depBottles > 0) {
      const depPrice = Number(initDepPrice) || Number(deposit) || 0
      const { error: dErr } = await supabase.from('agent_deposits').insert({
        agent_id: newId,
        deposit_date: todayYangon(),
        bottles: depBottles,
        price_per_bottle: depPrice,
        amount: depBottles * depPrice,
        note: 'အစအပေါင်',
      })
      if (dErr) {
        hadIssue = true
        setMsg(`Agent ဆောက်ပြီးပါပြီ၊ အစအပေါင် သိမ်း၍ မရပါ: ${dErr.message}`)
      }
    }
    if (!hadIssue) {
      let text = `‘${name.trim()}’ ကို ဆောက်ပြီးပါပြီ`
      if (depBottles > 0) {
        text += ` — အပေါင် ${depBottles.toLocaleString('en-US')} ဗူး ထည့်ပြီးပါပြီ`
      }
      setOkMsg(text)
    }
    setName('')
    setCode('')
    setPhone('')
    setAddress('')
    setDeposit('0')
    setUnitPrice('0')
    setBottleLimit('0')
    setCreditLimit('0')
    setInitDepBottles('')
    setInitDepPrice('')
    await load()
  }

  async function toggleActive(a: AgentRow) {
    setMsg(null)
    setOkMsg(null)
    const { error } = await supabase.from('agents').update({ active: !a.active }).eq('id', a.id)
    if (error) setMsg(error.message)
    await load()
  }

  async function saveField(a: AgentRow, field: EditableField, value: number) {
    setMsg(null)
    setOkMsg(null)
    const { error } = await supabase
      .from('agents')
      .update({ [field]: value })
      .eq('id', a.id)
    if (error) setMsg(error.message)
    await load()
  }

  const q = query.trim().toLowerCase()
  const matches = (a: AgentRow) =>
    q === '' ||
    a.name.toLowerCase().includes(q) ||
    (a.code ?? '').toLowerCase().includes(q) ||
    (a.phone ?? '').includes(q)

  const open = rows.filter((a) => !a.closed_at)
  const closed = rows.filter((a) => a.closed_at)
  const displayOpen = open.filter(matches)
  const displayClosed = closed.filter(matches)

  const chipCls =
    'rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600 dark:bg-red-950/40 dark:text-red-400'
  const miniLabel = 'text-[11px] font-medium text-stone-500 dark:text-neutral-400'
  const miniValue = 'mt-0.5 text-sm font-bold tabular-nums'

  function renderCard(a: AgentRow) {
    return (
      <li key={a.id} className={`${cardCls} p-4`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-semibold">
              {canManage ? (
                <Link to={`/agents/${a.id}`} className="text-brand-700 underline underline-offset-2 dark:text-brand-300">
                  {a.name}
                </Link>
              ) : (
                a.name
              )}{' '}
              {a.code && <span className="text-xs font-normal opacity-60">({a.code})</span>}
            </div>
            {(!a.active && !a.closed_at) || a.closed_at ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {!a.active && !a.closed_at && <span className={chipCls}>ပိတ်ထားသည်</span>}
                {a.closed_at && <span className={chipCls}>စာရင်းပိတ်ပြီး</span>}
              </div>
            ) : null}
            <div className="mt-1 text-sm text-stone-500 dark:text-neutral-400">
              ဖုန်း: {a.phone ?? '—'}
              {a.address ? ` · ${a.address}` : ''}
            </div>
          </div>
          {canManage && !a.closed_at && (
            <SecondaryButton size="sm" onClick={() => toggleActive(a)} className="shrink-0">
              {a.active ? 'ပိတ်' : 'ဖွင့်'}
            </SecondaryButton>
          )}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-xl bg-stone-50 p-2.5 dark:bg-neutral-800/70">
            <div className={miniLabel}>ကိုင်ထားဘူး</div>
            <div className={miniValue}>{a.held.toLocaleString('en-US')} လုံး</div>
          </div>
          <div className="rounded-xl bg-stone-50 p-2.5 dark:bg-neutral-800/70">
            <div className={miniLabel}>ရရန်ကျန်</div>
            <div className={`${miniValue} ${a.outstanding > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>
              {formatMMK(a.outstanding)}
            </div>
          </div>
          <div className="rounded-xl bg-stone-50 p-2.5 dark:bg-neutral-800/70">
            <div className={miniLabel}>အပ်ငွေ/လုံး</div>
            <div className={miniValue}>{formatMMK(a.deposit_per_bottle)}</div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-stone-100 pt-3 text-sm dark:border-neutral-800">
          <label className="flex items-center justify-between gap-1">
            <span className="opacity-75">ဈေးနှုန်း/လုံး</span>
            {canManage && !a.closed_at ? (
              <InlineNumber value={a.default_unit_price} onSave={(v) => saveField(a, 'default_unit_price', v)} />
            ) : (
              <span>{formatMMK(a.default_unit_price)}</span>
            )}
          </label>
          <label className="flex items-center justify-between gap-1">
            <span className="opacity-75">အပ်ငွေ/လုံး</span>
            {canManage && !a.closed_at ? (
              <InlineNumber value={a.deposit_per_bottle} onSave={(v) => saveField(a, 'deposit_per_bottle', v)} />
            ) : (
              <span>{formatMMK(a.deposit_per_bottle)}</span>
            )}
          </label>
          <label className="flex items-center justify-between gap-1">
            <span className="opacity-75">ဘူး ကန့်သတ်</span>
            {canManage && !a.closed_at ? (
              <InlineNumber value={a.bottle_limit} onSave={(v) => saveField(a, 'bottle_limit', v)} />
            ) : (
              <span>{a.bottle_limit > 0 ? `${a.bottle_limit.toLocaleString('en-US')} လုံး` : 'မကန့်သတ်'}</span>
            )}
          </label>
          <label className="flex items-center justify-between gap-1">
            <span className="opacity-75">ကြွေး ကန့်သတ်</span>
            {canManage && !a.closed_at ? (
              <InlineNumber value={a.credit_limit} onSave={(v) => saveField(a, 'credit_limit', v)} />
            ) : (
              <span>{a.credit_limit > 0 ? formatMMK(a.credit_limit) : 'မကန့်သတ်'}</span>
            )}
          </label>
        </div>
      </li>
    )
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader title="ကိုယ်စားလှယ်များ" subtitle="ကိုင်ထားဘူး၊ ရရန်ကျန်နှင့် အပ်ငွေ အခြေအနေ" />

      {msg && (
        <p className="text-sm text-red-600" role="alert">
          {msg}
        </p>
      )}
      {okMsg && <p className="text-sm font-medium text-brand-700 dark:text-brand-300">{okMsg}</p>}

      <div className="relative">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-stone-400"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20.5 20.5-4.6-4.6" />
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="အမည်၊ ကုဒ် သို့မဟုတ် ဖုန်းဖြင့် ရှာရန်"
          aria-label="အမည်၊ ကုဒ် သို့မဟုတ် ဖုန်းဖြင့် ရှာရန်"
          className={`${inputCls} pl-11`}
        />
      </div>

      {loading ? (
        <LoadingState />
      ) : (
        <>
          {open.length === 0 ? (
            <EmptyState text="မရှိသေးပါ" />
          ) : displayOpen.length === 0 ? (
            <EmptyState text="ရှာတွေ့ခြင်း မရှိပါ" />
          ) : (
            <ul className="grid gap-3 lg:grid-cols-2">{displayOpen.map(renderCard)}</ul>
          )}

          {closed.length > 0 && displayClosed.length > 0 && (
            <div className="space-y-2.5">
              <h2 className="font-semibold opacity-80">စာရင်းပိတ်ပြီး ကိုယ်စားလှယ်များ</h2>
              <ul className="grid gap-3 opacity-80 lg:grid-cols-2">{displayClosed.map(renderCard)}</ul>
            </div>
          )}
        </>
      )}

      {canManage && (
        <form onSubmit={onAdd} className={`${cardCls} space-y-3 p-4 lg:p-5`}>
          <div className="text-base font-semibold">ကိုယ်စားလှယ်အသစ် ထည့်ရန်</div>
          <Field label="အမည်">
            <input value={name} onChange={(e) => setName(e.target.value)} required className={inputCls} />
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="ကုဒ် (ရှိလျှင်)">
              <input value={code} onChange={(e) => setCode(e.target.value)} className={inputCls} />
            </Field>
            <Field label="ဖုန်းနံပါတ်">
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} />
            </Field>
          </div>
          <Field label="လိပ်စာ (ရှိလျှင်)">
            <input value={address} onChange={(e) => setAddress(e.target.value)} className={inputCls} />
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="ပုလင်းအပ်ငွေ (၁ လုံး)">
              <input
                value={deposit}
                onChange={(e) => setDeposit(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="ပုံမှန် ဈေးနှုန်း (၁ လုံး)">
              <input
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="ဘူး ကန့်သတ်ချက် (၀ = မကန့်သတ်)">
              <input
                value={bottleLimit}
                onChange={(e) => setBottleLimit(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="ကြွေး ကန့်သတ်ချက် (၀ = မကန့်သတ်)">
              <input
                value={creditLimit}
                onChange={(e) => setCreditLimit(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="အစအပေါင် ဘူး (ရှိလျှင်)">
              <input
                value={initDepBottles}
                onChange={(e) => setInitDepBottles(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="အပေါင် ဈေးနှုန်း (၁ လုံး)">
              <input
                value={initDepPrice}
                onChange={(e) => setInitDepPrice(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                placeholder="ပုလင်းအပ်ငွေ အတိုင်း"
                className={inputCls}
              />
            </Field>
          </div>
          <PrimaryButton type="submit" className="w-full">
            ထည့်ရန်
          </PrimaryButton>
        </form>
      )}

      <p className="text-xs opacity-60">
        ဖုန်းနံပါတ်များကို ပိုင်ရှင်နှင့် မန်နေဂျာသာ မြင်ရပါတယ် (ဝန်ထမ်းများ မမြင်ရပါ)။ ကန့်သတ်ချက် ၀
        ဆိုသည်မှာ မကန့်သတ်ပါ။
      </p>
    </div>
  )
}
