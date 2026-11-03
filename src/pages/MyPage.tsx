import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { formatMMK, type AgentPayment, type DailyEntry } from '../lib/types'

export default function MyPage() {
  const { profile } = useAuth()
  const [entries, setEntries] = useState<DailyEntry[]>([])
  const [payments, setPayments] = useState<AgentPayment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // RLS scopes every row to this agent automatically; no agent_id filter
    // is needed in the client (and adding one would not widen access anyway).
    Promise.all([
      supabase.from('daily_entries').select('*').order('created_at', { ascending: false }).limit(50),
      supabase.from('agent_payments').select('*').order('created_at', { ascending: false }).limit(50),
    ]).then(([e, p]) => {
      setEntries((e.data ?? []) as DailyEntry[])
      setPayments((p.data ?? []) as AgentPayment[])
      setLoading(false)
    })
  }, [])

  const totalDelivered = entries.reduce((s, r) => s + r.amount, 0)
  const totalPaid = payments.reduce((s, r) => s + r.amount, 0)

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">ကျွန်ုပ်၏ စာရင်း — {profile?.username}</h1>

      <section className="grid grid-cols-2 gap-2 text-center">
        <div className="rounded-2xl border p-3">
          <div className="text-xs opacity-70">ပို့ဆောင်မှု စုစုပေါင်း (နောက်ဆုံး ၅၀)</div>
          <div className="mt-1 font-bold">{formatMMK(totalDelivered)}</div>
        </div>
        <div className="rounded-2xl border p-3">
          <div className="text-xs opacity-70">ပေးချေပြီး စုစုပေါင်း (နောက်ဆုံး ၅၀)</div>
          <div className="mt-1 font-bold">{formatMMK(totalPaid)}</div>
        </div>
      </section>

      {loading ? (
        <p>ခဏစောင့်ပါ…</p>
      ) : (
        <>
          <section>
            <h2 className="mb-2 font-semibold">ပို့ဆောင်မှုများ</h2>
            <ul className="divide-y rounded-2xl border">
              {entries.map((r) => (
                <li key={r.id} className="p-3 text-sm">
                  {r.entry_date} · ပို့ {r.delivered_qty} · ပြန် {r.returned_qty} ·{' '}
                  {formatMMK(r.amount)}
                </li>
              ))}
              {entries.length === 0 && <li className="p-3 text-sm opacity-70">မရှိသေးပါ</li>}
            </ul>
          </section>
          <section>
            <h2 className="mb-2 font-semibold">ပေးချေမှုများ</h2>
            <ul className="divide-y rounded-2xl border">
              {payments.map((r) => (
                <li key={r.id} className="p-3 text-sm">
                  {r.payment_date} · {formatMMK(r.amount)} · {r.method}
                </li>
              ))}
              {payments.length === 0 && <li className="p-3 text-sm opacity-70">မရှိသေးပါ</li>}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
