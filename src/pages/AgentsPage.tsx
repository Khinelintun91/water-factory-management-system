import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { formatMMK, type Agent } from '../lib/types'

interface AgentRow extends Agent {
  phone: string | null
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
  const [deposit, setDeposit] = useState('0')
  const [unitPrice, setUnitPrice] = useState('0')

  const load = useCallback(async () => {
    setLoading(true)
    const { data: agents } = await supabase
      .from('agents')
      .select('*')
      .order('created_at', { ascending: true })
    // Phone numbers come from agent_contacts. RLS decides who sees them:
    // owner/manager get rows, staff get none — so staff simply see '—'.
    const { data: contacts } = await supabase.from('agent_contacts').select('agent_id, phone')
    const phoneByAgent = new Map<string, string>()
    for (const c of (contacts ?? []) as { agent_id: string; phone: string }[]) {
      phoneByAgent.set(c.agent_id, c.phone)
    }
    setRows(
      ((agents ?? []) as Agent[]).map((a) => ({ ...a, phone: phoneByAgent.get(a.id) ?? null })),
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
        deposit_per_bottle: Number(deposit) || 0,
        default_unit_price: Number(unitPrice) || 0,
      })
      .select('id')
      .single()
    if (error) {
      setMsg(error.message)
      return
    }
    if (phone.trim() && data) {
      const { error: cErr } = await supabase
        .from('agent_contacts')
        .insert({ agent_id: (data as { id: string }).id, phone: phone.trim() })
      if (cErr) setMsg(`Agent ဆောက်ပြီးပါပြီ၊ ဖုန်းနံပါတ် သိမ်း၍ မရပါ: ${cErr.message}`)
    }
    setName('')
    setCode('')
    setPhone('')
    setDeposit('0')
    setUnitPrice('0')
    await load()
  }

  async function toggleActive(a: AgentRow) {
    setMsg(null)
    const { error } = await supabase.from('agents').update({ active: !a.active }).eq('id', a.id)
    if (error) setMsg(error.message)
    await load()
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">ကိုယ်စားလှယ်များ</h1>

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
          </div>
          {msg && <p className="text-sm text-red-600">{msg}</p>}
          <button className="w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white">
            ထည့်ရန်
          </button>
        </form>
      )}

      {loading ? (
        <p>ခဏစောင့်ပါ…</p>
      ) : (
        <ul className="divide-y rounded-2xl border">
          {rows.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 p-3">
              <div>
                <div className="font-medium">
                  {a.name} {a.code && <span className="text-xs opacity-60">({a.code})</span>}
                  {!a.active && <span className="ml-2 text-xs text-red-500">ပိတ်ထားသည်</span>}
                </div>
                <div className="text-sm opacity-75">
                  ဖုန်း: {a.phone ?? '—'} · အပ်ငွေ {formatMMK(a.deposit_per_bottle)}/လုံး
                </div>
              </div>
              {canManage && (
                <button
                  onClick={() => toggleActive(a)}
                  className="shrink-0 rounded-lg border px-2.5 py-1.5 text-sm"
                >
                  {a.active ? 'ပိတ်' : 'ဖွင့်'}
                </button>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className="p-3 text-sm opacity-70">မရှိသေးပါ</li>}
        </ul>
      )}
      <p className="text-xs opacity-60">
        ဖုန်းနံပါတ်များကို ပိုင်ရှင်နှင့် မန်နေဂျာသာ မြင်ရပါတယ် (ဝန်ထမ်းများ မမြင်ရပါ)။
      </p>
    </div>
  )
}
