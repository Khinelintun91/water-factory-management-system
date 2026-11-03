import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import {
  formatMMK,
  isTodayYangon,
  todayYangon,
  type Agent,
  type DailyEntry,
} from '../lib/types'

export default function EntriesPage() {
  const { profile } = useAuth()
  const canWrite = profile?.role === 'owner' || profile?.role === 'manager' || profile?.role === 'staff'
  const [agents, setAgents] = useState<Agent[]>([])
  const [rows, setRows] = useState<DailyEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [agentId, setAgentId] = useState('')
  const [delivered, setDelivered] = useState('')
  const [returned, setReturned] = useState('')
  const [unitPrice, setUnitPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')

  const agentName = useMemo(() => {
    const m = new Map(agents.map((a) => [a.id, a.name]))
    return (id: string) => m.get(id) ?? '—'
  }, [agents])

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ag }, { data: en }] = await Promise.all([
      supabase.from('agents').select('*').eq('active', true).order('created_at'),
      supabase
        .from('daily_entries')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100),
    ])
    setAgents((ag ?? []) as Agent[])
    setRows((en ?? []) as DailyEntry[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // When an agent is picked, prefill their default price and compute the amount.
  useEffect(() => {
    const a = agents.find((x) => x.id === agentId)
    if (a && !unitPrice) setUnitPrice(String(a.default_unit_price || ''))
  }, [agentId, agents, unitPrice])

  useEffect(() => {
    const q = Number(delivered) || 0
    const p = Number(unitPrice) || 0
    if (q > 0) setAmount(String(q * p))
  }, [delivered, unitPrice])

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setMsg(null)
    if (!agentId) {
      setMsg('ကိုယ်စားလှယ် ရွေးပါ')
      setBusy(false)
      return
    }
    const { error } = await supabase.from('daily_entries').insert({
      entry_date: todayYangon(),
      agent_id: agentId,
      delivered_qty: Number(delivered) || 0,
      returned_qty: Number(returned) || 0,
      unit_price: Number(unitPrice) || 0,
      amount: Number(amount) || 0,
      notes: notes.trim() || null,
      created_by: profile?.id ?? null,
    })
    if (error) {
      setMsg(error.message)
      setBusy(false)
      return
    }
    setDelivered('')
    setReturned('')
    setAmount('')
    setNotes('')
    await load()
    setBusy(false)
  }

  async function onDelete(row: DailyEntry) {
    if (!confirm('ဒီမှတ်တမ်ကို ဖျက်မှာ သေချာပါသလား? (ယနေ့ မှတ်တမ်သာ ဖျက်လို့ ရပါမယ်)')) return
    const { error } = await supabase.from('daily_entries').delete().eq('id', row.id)
    if (error) setMsg(error.message)
    await load()
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">ပို့ဆောင်မှု မှတ်တမ်းများ</h1>

      {canWrite && (
        <form onSubmit={onAdd} className="space-y-2 rounded-2xl border p-4">
          <div className="font-semibold">ယနေ့ မှတ်တမ်အသစ်</div>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            required
            className="w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
          >
            <option value="">ကိုယ်စားလှယ် ရွေးပါ</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              ပို့သည့် ပုလင်း
              <input
                value={delivered}
                onChange={(e) => setDelivered(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                required
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
            <label className="text-sm">
              ပြန်အပ်သည့် ပုလင်း
              <input
                value={returned}
                onChange={(e) => setReturned(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
            <label className="text-sm">
              ဈေးနှုန်း (၁ လုံး)
              <input
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
            <label className="text-sm">
              စုစုပေါင်း (ကျပ်)
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
          </div>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="မှတ်ချက် (ရှိလျှင်)"
            className="w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
          />
          {msg && <p className="text-sm text-red-600">{msg}</p>}
          <button disabled={busy} className="w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white disabled:opacity-50">
            သိမ်းရန်
          </button>
          <p className="text-xs opacity-60">
            ပြင်/ဖျက် လုပ်ခွင့်က ထည့်သွင်းသည့် နေ့ တစ်နေ့တည်းသာ ရပါမယ် (ပိုင်ရှင် အပါအဝင် အားလုံး)။
          </p>
        </form>
      )}

      {loading ? (
        <p>ခဏစောင့်ပါ…</p>
      ) : (
        <ul className="divide-y rounded-2xl border">
          {rows.map((r) => (
            <li key={r.id} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">{agentName(r.agent_id)}</div>
                <div className="text-sm font-semibold">{formatMMK(r.amount)}</div>
              </div>
              <div className="text-sm opacity-75">
                {r.entry_date} · ပို့ {r.delivered_qty} · ပြန် {r.returned_qty} ·{' '}
                {formatMMK(r.unit_price)}/လုံး
                {r.notes ? ` · ${r.notes}` : ''}
              </div>
              {canWrite && isTodayYangon(r.created_at) && (
                <button
                  onClick={() => onDelete(r)}
                  className="mt-1 text-sm text-red-600"
                >
                  ဖျက်ရန်
                </button>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className="p-3 text-sm opacity-70">မှတ်တမ် မရှိသေးပါ</li>}
        </ul>
      )}
    </div>
  )
}
