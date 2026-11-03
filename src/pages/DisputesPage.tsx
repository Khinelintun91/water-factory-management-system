import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

interface Dispute {
  id: string
  agent_id: string
  message: string
  status: 'open' | 'replied' | 'closed'
  reply: string | null
  created_at: string
}

const STATUS_LABELS: Record<Dispute['status'], string> = {
  open: 'ဖွင့်ထားဆဲ',
  replied: 'ပြန်ဖြေပြီး',
  closed: 'ပိတ်ပြီး',
}

export default function DisputesPage() {
  const { profile } = useAuth()
  const isAgent = profile?.role === 'agent'
  const canManage = profile?.role === 'owner' || profile?.role === 'manager'
  const [rows, setRows] = useState<Dispute[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [agentNames, setAgentNames] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const [replyById, setReplyById] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('disputes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
    setRows((data ?? []) as Dispute[])
    const { data: ag } = await supabase.from('agents').select('id, name')
    if (ag) {
      setAgentNames(
        Object.fromEntries((ag as { id: string; name: string }[]).map((a) => [a.id, a.name])),
      )
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    if (!profile?.agent_id) {
      setMsg('ဒီအကောင့်မှာ ကိုယ်စားလှယ် မချိတ်ထားပါ')
      return
    }
    const { error } = await supabase
      .from('disputes')
      .insert({ agent_id: profile.agent_id, message: message.trim() })
    if (error) {
      setMsg(error.message)
      return
    }
    setMessage('')
    await load()
  }

  async function onReply(d: Dispute) {
    const reply = (replyById[d.id] ?? '').trim()
    if (!reply) return
    const { error } = await supabase
      .from('disputes')
      .update({ reply, status: 'replied', replied_by: profile?.id ?? null })
      .eq('id', d.id)
    if (error) setMsg(error.message)
    await load()
  }

  async function onClose(d: Dispute) {
    const { error } = await supabase.from('disputes').update({ status: 'closed' }).eq('id', d.id)
    if (error) setMsg(error.message)
    await load()
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">အငြင်းပွားမှုများ</h1>

      {isAgent && (
        <form onSubmit={onCreate} className="space-y-2 rounded-2xl border p-4">
          <div className="font-semibold">ပြဿနာ တင်ပြရန်</div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            required
            rows={3}
            placeholder="ဖြစ်ပျက်ခဲ့တာကို ရှင်းပြပါ"
            className="w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
          />
          {msg && <p className="text-sm text-red-600">{msg}</p>}
          <button className="w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white">
            တင်ပြရန်
          </button>
        </form>
      )}

      {loading ? (
        <p>ခဏစောင့်ပါ…</p>
      ) : (
        <ul className="divide-y rounded-2xl border">
          {rows.map((d) => (
            <li key={d.id} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  {agentNames[d.agent_id] ? `${agentNames[d.agent_id]} · ` : ''}
                  {STATUS_LABELS[d.status]}
                </span>
                <span className="text-xs opacity-60">
                  {new Date(d.created_at).toLocaleString('my-MM')}
                </span>
              </div>
              <p className="mt-1 text-sm">{d.message}</p>
              {d.reply && <p className="mt-1 rounded-lg bg-neutral-100 p-2 text-sm dark:bg-neutral-800">ပြန်ဖြေ: {d.reply}</p>}
              {canManage && d.status !== 'closed' && (
                <div className="mt-2 space-y-2">
                  <textarea
                    value={replyById[d.id] ?? ''}
                    onChange={(e) => setReplyById((s) => ({ ...s, [d.id]: e.target.value }))}
                    rows={2}
                    placeholder="ပြန်ဖြေရန်"
                    className="w-full rounded-xl border px-3 py-2 text-sm dark:bg-neutral-900"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => onReply(d)}
                      className="rounded-lg bg-teal-700 px-3 py-1.5 text-sm font-medium text-white"
                    >
                      ပြန်ဖြေရန်
                    </button>
                    <button
                      onClick={() => onClose(d)}
                      className="rounded-lg border px-3 py-1.5 text-sm"
                    >
                      ပိတ်ရန်
                    </button>
                  </div>
                  {msg && <p className="text-sm text-red-600">{msg}</p>}
                </div>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className="p-3 text-sm opacity-70">မရှိသေးပါ</li>}
        </ul>
      )}
    </div>
  )
}
