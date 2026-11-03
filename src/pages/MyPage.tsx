import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { formatMMK, type AgentPayment, type DailyEntry } from '../lib/types'
import { LoadingState, PageHeader, StatCard, cardCls } from '../components/ui'

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
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title={
          <>
            ကျွန်ုပ်၏ စာရင်း — {profile?.username}
          </>
        }
        subtitle="ကိုယ်ပိုင် ပို့ဆောင်မှုနှင့် ပေးချေမှု မှတ်တမ်းများ"
      />

      <section className="grid grid-cols-2 gap-2.5">
        <StatCard label="ပို့ဆောင်မှု စုစုပေါင်း (နောက်ဆုံး ၅၀)" value={formatMMK(totalDelivered)} />
        <StatCard label="ပေးချေပြီး စုစုပေါင်း (နောက်ဆုံး ၅၀)" value={formatMMK(totalPaid)} />
      </section>

      {loading ? (
        <LoadingState />
      ) : (
        <>
          <section>
            <h2 className="mb-2 px-0.5 text-base font-bold">ပို့ဆောင်မှုများ</h2>
            <ul className={`${cardCls} divide-y divide-stone-100 overflow-hidden dark:divide-neutral-800/70`}>
              {entries.map((r) => (
                <li key={r.id} className="p-3.5 text-sm">
                  {r.entry_date} · ပို့ {r.delivered_qty} · ပြန် {r.returned_qty} ·{' '}
                  {formatMMK(r.amount)}
                </li>
              ))}
              {entries.length === 0 && (
                <li className="p-3.5 text-sm text-stone-500 dark:text-neutral-400">မရှိသေးပါ</li>
              )}
            </ul>
          </section>
          <section>
            <h2 className="mb-2 px-0.5 text-base font-bold">ပေးချေမှုများ</h2>
            <ul className={`${cardCls} divide-y divide-stone-100 overflow-hidden dark:divide-neutral-800/70`}>
              {payments.map((r) => (
                <li key={r.id} className="p-3.5 text-sm">
                  {r.payment_date} · {formatMMK(r.amount)} · {r.method}
                </li>
              ))}
              {payments.length === 0 && (
                <li className="p-3.5 text-sm text-stone-500 dark:text-neutral-400">မရှိသေးပါ</li>
              )}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
