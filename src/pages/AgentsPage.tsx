import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { formatMMK, personName, todayYangon, type Agent } from '../lib/types'
import { FACE_TIERS } from '../lib/cardFace'
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
  /** Bottles sent per trip (agents.trip_qty, added after the shared Agent type). */
  trip_qty: number
  phone: string | null
  held: number
  outstanding: number
}

/** An existing agent login account not yet linked to any agent record. */
interface LinkableProfile {
  id: string
  username: string
  display_name: string | null
}

type EditableField = 'default_unit_price' | 'deposit_per_bottle' | 'bottle_limit' | 'credit_limit' | 'trip_qty'

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
  const [openId, setOpenId] = useState<string | null>(null)

  // Add-agent form
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [deposit, setDeposit] = useState('0')
  const [unitPrice, setUnitPrice] = useState('0')
  const [bottleLimit, setBottleLimit] = useState('0')
  const [creditLimit, setCreditLimit] = useState('0')
  // Bottles per trip — the live app's default is 10.
  const [tripQty, setTripQty] = useState('10')
  const [agentNotes, setAgentNotes] = useState('')
  const [initDepBottles, setInitDepBottles] = useState('')
  const [initDepPrice, setInitDepPrice] = useState('')
  const [linkUserId, setLinkUserId] = useState('')
  const [linkable, setLinkable] = useState<LinkableProfile[]>([])

  // Factory defaults from app_settings prefill the price / deposit fields
  // (SettingsPage maintains them). Loaded once on mount; a field is only
  // prefilled while it still holds its initial '0', so anything the user
  // has already typed wins. Unset (or zero) settings keep the old '0'.
  const [defaultPrice, setDefaultPrice] = useState('')
  const [defaultDeposit, setDefaultDeposit] = useState('')
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('app_settings')
        .select('key, value')
        .in('key', ['default_price_per_bottle', 'default_deposit_per_bottle'])
      if (cancelled || !data) return
      const map = new Map(
        (data as { key: string; value: unknown }[]).map((r) => [r.key, r.value]),
      )
      const price = Number(map.get('default_price_per_bottle'))
      if (Number.isFinite(price) && price > 0) {
        setDefaultPrice(String(price))
        setUnitPrice((cur) => (cur === '0' ? String(price) : cur))
      }
      const dep = Number(map.get('default_deposit_per_bottle'))
      if (Number.isFinite(dep) && dep > 0) {
        setDefaultDeposit(String(dep))
        setDeposit((cur) => (cur === '0' ? String(dep) : cur))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const { data: agents } = await supabase
      .from('agents')
      .select('*')
      .order('code', { ascending: true })
    // Phone numbers come from agent_contacts. RLS decides who sees them:
    // owner/manager get rows, staff get none — so staff simply see '—'.
    // Bottles-held per agent comes from the agent_held_totals RPC (0021),
    // which sums delivered − returned server-side; this page previously
    // downloaded every daily_entries row just for that one number.
    const [{ data: contacts }, { data: heldRows }] = await Promise.all([
      supabase.from('agent_contacts').select('agent_id, phone'),
      supabase.rpc('agent_held_totals'),
    ])
    const phoneByAgent = new Map<string, string>()
    for (const c of (contacts ?? []) as { agent_id: string; phone: string }[]) {
      phoneByAgent.set(c.agent_id, c.phone)
    }
    const heldByAgent = new Map<string, number>()
    for (const h of (heldRows ?? []) as { agent_id: string; held: number }[]) {
      heldByAgent.set(h.agent_id, Number(h.held) || 0)
    }
    // agents.trip_qty arrives with select('*'); it is not on the shared
    // Agent type yet, so widen the row type locally.
    const list = (agents ?? []) as (Agent & { trip_qty: number | null })[]
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
        trip_qty: a.trip_qty ?? 0,
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

  // Existing agent accounts (primary role 'agent') that are not linked to
  // an agent record yet — offered in the create form's account picker.
  const loadLinkable = useCallback(async () => {
    if (!canManage) return
    const { data } = await supabase
      .from('profiles')
      .select('id, username, display_name, role, agent_id')
      .eq('role', 'agent')
      .is('agent_id', null)
      .order('username', { ascending: true })
    setLinkable((data ?? []) as LinkableProfile[])
  }, [canManage])

  useEffect(() => {
    loadLinkable()
  }, [loadLinkable])

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
        trip_qty: Number(tripQty) || 0,
        notes: agentNotes.trim() || null,
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
    // Optional: link an existing agent login account to the new agent.
    if (linkUserId) {
      const { error: lErr } = await supabase
        .from('profiles')
        .update({ agent_id: newId })
        .eq('id', linkUserId)
      if (lErr) {
        hadIssue = true
        setMsg(`Agent ဆောက်ပြီးပါပြီ၊ အကောင့် ချိတ်ဆက်၍ မရပါ: ${lErr.message}`)
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
    setDeposit(defaultDeposit || '0')
    setUnitPrice(defaultPrice || '0')
    setBottleLimit('0')
    setCreditLimit('0')
    setTripQty('10')
    setAgentNotes('')
    setInitDepBottles('')
    setInitDepPrice('')
    setLinkUserId('')
    await load()
    await loadLinkable()
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

  function renderCard(a: AgentRow, idx: number, arr: AgentRow[]) {
    const open = openId === a.id
    // Wallet stack in the owner's chosen style, one silver-white face per
    // agent (FACE_TIERS.white): each face slides over the one above so only
    // its strip — name + outstanding — shows; the last face shows in full.
    // Tapping opens the detail body (contact, stat chips, inline edit
    // fields, detail-page link) below the face.
    const prevOpen = idx > 0 && openId === arr[idx - 1]?.id
    const stacked = !open && idx > 0 && !prevOpen
    const tier = FACE_TIERS.white
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
              {a.code && <span className={`ml-2 text-xs font-normal ${tier.sub}`}>({a.code})</span>}
              {!a.active && !a.closed_at && (
                <span className="ml-2 rounded-full bg-stone-900/10 px-2 py-0.5 text-[11px] font-medium text-stone-700">
                  ပိတ်ထားသည်
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                className={`font-bold tabular-nums ${a.outstanding > 0 ? 'text-red-600' : a.outstanding < 0 ? tier.neg : ''}`}
              >
                {formatMMK(a.outstanding)}
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
          <span className="block">
            <span className={`block text-xs ${tier.faint}`}>ရရန်ကျန်</span>
            <span className="block text-[28px] font-bold leading-tight tabular-nums">
              {formatMMK(a.outstanding)}
            </span>
            <span className={`mt-0.5 block text-xs ${tier.sub}`}>
              ကိုင်ထားဘူး {a.held.toLocaleString('en-US')} ဗူး · အပေါင်ငွေ/ဗူး{' '}
              {formatMMK(a.deposit_per_bottle)}
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
            <div className="rounded-b-2xl border border-t-0 border-stone-200/90 bg-white p-4 shadow-card dark:border-neutral-800 dark:bg-neutral-900">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 text-sm text-stone-500 dark:text-neutral-400">
                  ဖုန်း: {a.phone ?? '—'}
                  {a.address ? ` · ${a.address}` : ''}
                  {a.closed_at && <span className={`ml-2 ${chipCls}`}>စာရင်းပိတ်ပြီး</span>}
                </div>
                {canManage && !a.closed_at && (
                  <SecondaryButton size="sm" onClick={() => toggleActive(a)} className="shrink-0">
                    {a.active ? 'ပိတ်' : 'ဖွင့်'}
                  </SecondaryButton>
                )}
              </div>
              {canManage && (
                <div className="mt-2">
                  <Link
                    to={`/agents/${a.id}`}
                    className="text-sm font-medium text-brand-700 underline underline-offset-2 dark:text-brand-300"
                  >
                    အသေးစိတ် စာမျက်နှာ
                  </Link>
                </div>
              )}
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-stone-50 p-2.5 dark:bg-neutral-800/70">
                  <div className={miniLabel}>ကိုင်ထားဘူး</div>
                  <div className={miniValue}>{a.held.toLocaleString('en-US')} ဗူး</div>
                </div>
                <div className="rounded-xl bg-stone-50 p-2.5 dark:bg-neutral-800/70">
                  <div className={miniLabel}>ရရန်ကျန်</div>
                  <div className={`${miniValue} ${a.outstanding > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>
                    {formatMMK(a.outstanding)}
                  </div>
                </div>
                <div className="rounded-xl bg-stone-50 p-2.5 dark:bg-neutral-800/70">
                  <div className={miniLabel}>အပေါင်ငွေ/ဗူး</div>
                  <div className={miniValue}>{formatMMK(a.deposit_per_bottle)}</div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-stone-100 pt-3 text-sm dark:border-neutral-800">
                <label className="flex items-center justify-between gap-1">
                  <span className="opacity-75">ဈေးနှုန်း/ဗူး</span>
                  {canManage && !a.closed_at ? (
                    <InlineNumber value={a.default_unit_price} onSave={(v) => saveField(a, 'default_unit_price', v)} />
                  ) : (
                    <span>{formatMMK(a.default_unit_price)}</span>
                  )}
                </label>
                <label className="flex items-center justify-between gap-1">
                  <span className="opacity-75">အပေါင်ငွေ/ဗူး</span>
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
                    <span>{a.bottle_limit > 0 ? `${a.bottle_limit.toLocaleString('en-US')} ဗူး` : 'မကန့်သတ်'}</span>
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
                <label className="flex items-center justify-between gap-1">
                  <span className="opacity-75">တစ်ခါပို့</span>
                  {canManage && !a.closed_at ? (
                    <InlineNumber value={a.trip_qty} onSave={(v) => saveField(a, 'trip_qty', v)} />
                  ) : (
                    <span>{a.trip_qty.toLocaleString('en-US')} ဗူး</span>
                  )}
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader title="ကိုယ်စားလှယ်များ" subtitle="ကိုင်ထားဘူး၊ ရရန်ကျန်နှင့် အပေါင် အခြေအနေ" />

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
            <Field label="ဗူးတစ်ဗူးလျှင် အပေါင်ငွေ (ကျပ်)">
              <input
                value={deposit}
                onChange={(e) => setDeposit(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="ဗူးတစ်ဗူး ရောင်းဈေး (ကျပ်)">
              <input
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="တစ်ခါပို့ ဘူးအရေအတွက်">
              <input
                value={tripQty}
                onChange={(e) => setTripQty(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="ဗူး ကန့်သတ်ချက် (ဗူး၊ 0 = မကန့်သတ်)">
              <input
                value={bottleLimit}
                onChange={(e) => setBottleLimit(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="ကြွေးကန့်သတ်ချက် (ကျပ်၊ 0 = မကန့်သတ်)">
              <input
                value={creditLimit}
                onChange={(e) => setCreditLimit(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="အပေါင်ယူမည့် ဗူး (မထည့်လည်းရ)">
              <input
                value={initDepBottles}
                onChange={(e) => setInitDepBottles(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="အပေါင် ဈေးနှုန်း (၁ ဗူး)">
              <input
                value={initDepPrice}
                onChange={(e) => setInitDepPrice(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                placeholder="အပေါင်ငွေ အတိုင်း"
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="ချိတ်ဆက်မည့် အကောင့် (ရွေးချယ်နိုင်)">
            <select
              value={linkUserId}
              onChange={(e) => setLinkUserId(e.target.value)}
              className={inputCls}
            >
              <option value="">မချိတ်ဆက်ပါ</option>
              {linkable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name?.trim() ? `${personName(p)} (${p.username})` : p.username}
                </option>
              ))}
            </select>
          </Field>
          <Field label="မှတ်ချက်">
            <input value={agentNotes} onChange={(e) => setAgentNotes(e.target.value)} className={inputCls} />
          </Field>
          <PrimaryButton type="submit" className="w-full">
            ထည့်ရန်
          </PrimaryButton>
        </form>
      )}


      {loading ? (
        <LoadingState />
      ) : (
        <>
          {open.length === 0 ? (
            <EmptyState text="မရှိသေးပါ" />
          ) : displayOpen.length === 0 ? (
            <EmptyState text="ရှာတွေ့ခြင်း မရှိပါ" />
          ) : (
            <div>{displayOpen.map((a, i) => renderCard(a, i, displayOpen))}</div>
          )}

          {closed.length > 0 && displayClosed.length > 0 && (
            <div className="space-y-2.5">
              <h2 className="font-semibold opacity-80">စာရင်းပိတ်ပြီး ကိုယ်စားလှယ်များ</h2>
              <div className="opacity-80">{displayClosed.map((a, i) => renderCard(a, i, displayClosed))}</div>
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
