import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import {
  formatMMK,
  isTodayYangon,
  todayYangon,
  type Agent,
  type AgentPayment,
} from '../lib/types'

export default function PaymentsPage() {
  const { profile } = useAuth()
  const canWrite = profile?.role === 'owner' || profile?.role === 'manager' || profile?.role === 'staff'
  const [agents, setAgents] = useState<Agent[]>([])
  const [rows, setRows] = useState<AgentPayment[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const [agentId, setAgentId] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('cash')
  const [notes, setNotes] = useState('')

  const agentName = useMemo(() => {
    const m = new Map(agents.map((a) => [a.id, a.name]))
    return (id: string) => m.get(id) ?? '—'
  }, [agents])

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ag }, { data: pm }] = await Promise.all([
      supabase.from('agents').select('*').order('created_at'),
      supabase
        .from('agent_payments')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100),
    ])
    setAgents((ag ?? []) as Agent[])
    setRows((pm ?? []) as AgentPayment[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

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
    const { error } = await supabase.from('agent_payments').insert({
      payment_date: todayYangon(),
      agent_id: agentId,
      amount: Number(amount) || 0,
      method,
      notes: notes.trim() || null,
      created_by: profile?.id ?? null,
    })
    if (error) {
      setMsg(error.message)
      setBusy(false)
      return
    }
    setAmount('')
    setNotes('')
    await load()
    setBusy(false)
  }

  async function onDelete(row: AgentPayment) {
    const { error } = await supabase.from('agent_payments').delete().eq('id', row.id)
    if (error) setMsg(error.message)
    setConfirmId(null)
    await load()
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">ငွေကောက်ခံမှုများ</h1>

      {canWrite && (
        <form onSubmit={onAdd} className="space-y-2 rounded-2xl border p-4">
          <div className="font-semibold">ကောက်ခံမှုအသစ်</div>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            required
            className="w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
          >
            <option value="">ကိုယ်စားလှယ် ရွေးပါ</option>
            {agents.filter((a) => a.active).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              ပမာဏ (ကျပ်)
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                required
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
            <label className="text-sm">
              နည်းလမ်း
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              >
                <option value="cash">ငွေသား</option>
                <option value="kbzpay">KBZPay</option>
                <option value="wavepay">WavePay</option>
                <option value="bank">ဘဏ်</option>
              </select>
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
                {r.payment_date} · {r.method}
                {r.notes ? ` · ${r.notes}` : ''}
              </div>
              {canWrite && isTodayYangon(r.created_at) &&
                (confirmId === r.id ? (
                  <span className="mt-1 flex gap-3 text-sm">
                    <button onClick={() => onDelete(r)} className="font-semibold text-red-600">
                      သေချာပါတယ်, ဖျက်မည်
                    </button>
                    <button onClick={() => setConfirmId(null)} className="opacity-70">
                      မဖျက်တော့ပါ
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmId(r.id)} className="mt-1 text-sm text-red-600">
                    ဖျက်ရန်
                  </button>
                ))}
            </li>
          ))}
          {rows.length === 0 && <li className="p-3 text-sm opacity-70">မှတ်တမ် မရှိသေးပါ</li>}
        </ul>
      )}
    </div>
  )
}
