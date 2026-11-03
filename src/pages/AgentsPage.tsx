import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { formatMMK, todayYangon, type Agent } from '../lib/types'

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
      className="w-24 rounded-lg border px-2 py-1 text-right text-sm dark:bg-neutral-900"
    />
  )
}

export default function AgentsPage() {
  const { profile } = useAuth()
  const canManage = profile?.role === 'owner' || profile?.role === 'manager'
  const [rows, setRows] = useState<AgentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)

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
    if (phone.trim()) {
      const { error: cErr } = await supabase
        .from('agent_contacts')
        .insert({ agent_id: newId, phone: phone.trim() })
      if (cErr) setMsg(`Agent ဆောက်ပြီးပါပြီ၊ ဖုန်းနံပါတ် သိမ်း၍ မရပါ: ${cErr.message}`)
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
      if (dErr) setMsg(`Agent ဆောက်ပြီးပါပြီ၊ အစအပေါင် သိမ်း၍ မရပါ: ${dErr.message}`)
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
    const { error } = await supabase.from('agents').update({ active: !a.active }).eq('id', a.id)
    if (error) setMsg(error.message)
    await load()
  }

  async function saveField(a: AgentRow, field: EditableField, value: number) {
    setMsg(null)
    const { error } = await supabase
      .from('agents')
      .update({ [field]: value })
      .eq('id', a.id)
    if (error) setMsg(error.message)
    await load()
  }

  const open = rows.filter((a) => !a.closed_at)
  const closed = rows.filter((a) => a.closed_at)

  function renderRow(a: AgentRow) {
    return (
      <li key={a.id} className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-medium">
              {canManage ? (
                <Link to={`/agents/${a.id}`} className="text-teal-700 underline dark:text-teal-400">
                  {a.name}
                </Link>
              ) : (
                a.name
              )}{' '}
              {a.code && <span className="text-xs opacity-60">({a.code})</span>}
              {!a.active && !a.closed_at && (
                <span className="ml-2 text-xs text-red-500">ပိတ်ထားသည်</span>
              )}
              {a.closed_at && <span className="ml-2 text-xs text-red-500">စာရင်းပိတ်ပြီး</span>}
            </div>
            <div className="text-sm opacity-75">
              ဖုန်း: {a.phone ?? '—'}
              {a.address ? ` · ${a.address}` : ''}
            </div>
            <div className="text-sm opacity-75">
              ကိုင်ထားဘူး: {a.held.toLocaleString('en-US')} လုံး · ရရန်ကျန်:{' '}
              {formatMMK(a.outstanding)}
            </div>
          </div>
          {canManage && !a.closed_at && (
            <button
              onClick={() => toggleActive(a)}
              className="shrink-0 rounded-lg border px-2.5 py-1.5 text-sm"
            >
              {a.active ? 'ပိတ်' : 'ဖွင့်'}
            </button>
          )}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:grid-cols-4">
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
    <div className="space-y-4">
      <h1 className="text-lg font-bold">ကိုယ်စားလှယ်များ</h1>

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      {canManage && (
        <form onSubmit={onAdd} className="space-y-2 rounded-2xl border p-4">
          <div className="font-semibold">ကိုယ်စားလှယ်အသစ် ထည့်ရန်</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="အမည်"
            className="w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ကုဒ် (ရှိလျှင်)"
              className="rounded-xl border px-3 py-2 dark:bg-neutral-900"
            />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="ဖုန်းနံပါတ်"
              className="rounded-xl border px-3 py-2 dark:bg-neutral-900"
            />
          </div>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="လိပ်စာ (ရှိလျှင်)"
            className="w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
          />
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              ပုလင်းအပ်ငွေ (၁ လုံး)
              <input
                value={deposit}
                onChange={(e) => setDeposit(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
            <label className="text-sm">
              ပုံမှန် ဈေးနှုန်း (၁ လုံး)
              <input
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
            <label className="text-sm">
              ဘူး ကန့်သတ်ချက် (၀ = မကန့်သတ်)
              <input
                value={bottleLimit}
                onChange={(e) => setBottleLimit(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
            <label className="text-sm">
              ကြွေး ကန့်သတ်ချက် (၀ = မကန့်သတ်)
              <input
                value={creditLimit}
                onChange={(e) => setCreditLimit(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              အစအပေါင် ဘူး (ရှိလျှင်)
              <input
                value={initDepBottles}
                onChange={(e) => setInitDepBottles(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
            <label className="text-sm">
              အပေါင် ဈေးနှုန်း (၁ လုံး)
              <input
                value={initDepPrice}
                onChange={(e) => setInitDepPrice(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                placeholder="ပုလင်းအပ်ငွေ အတိုင်း"
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
          </div>
          <button className="w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white">
            ထည့်ရန်
          </button>
        </form>
      )}

      {loading ? (
        <p>ခဏစောင့်ပါ…</p>
      ) : (
        <>
          <ul className="divide-y rounded-2xl border">
            {open.map(renderRow)}
            {open.length === 0 && <li className="p-3 text-sm opacity-70">မရှိသေးပါ</li>}
          </ul>

          {closed.length > 0 && (
            <div className="space-y-2">
              <h2 className="font-semibold opacity-80">စာရင်းပိတ်ပြီး ကိုယ်စားလှယ်များ</h2>
              <ul className="divide-y rounded-2xl border opacity-80">{closed.map(renderRow)}</ul>
            </div>
          )}
        </>
      )}
      <p className="text-xs opacity-60">
        ဖုန်းနံပါတ်များကို ပိုင်ရှင်နှင့် မန်နေဂျာသာ မြင်ရပါတယ် (ဝန်ထမ်းများ မမြင်ရပါ)။ ကန့်သတ်ချက် ၀
        ဆိုသည်မှာ မကန့်သတ်ပါ။
      </p>
    </div>
  )
}
