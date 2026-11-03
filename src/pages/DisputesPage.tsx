import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import {
  Card,
  EmptyState,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  cardCls,
  inputCls,
} from '../components/ui'

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

const STATUS_CHIP_CLS: Record<Dispute['status'], string> = {
  open: 'bg-accent-100 text-accent-800 dark:bg-amber-950/40 dark:text-amber-200',
  replied: 'bg-brand-100 text-brand-800 dark:bg-brand-950/50 dark:text-brand-200',
  closed: 'bg-stone-100 text-stone-500 dark:bg-neutral-800 dark:text-neutral-400',
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
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="အငြင်းပွားမှုများ"
        subtitle="ပြဿနာ တင်ပြချက်များ စစ်ဆေး ပြန်ဖြေရန်"
      />

      {isAgent && (
        <Card className="space-y-3">
          <form onSubmit={onCreate} className="space-y-3">
            <h2 className="text-base font-semibold">ပြဿနာ တင်ပြရန်</h2>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
              rows={3}
              placeholder="ဖြစ်ပျက်ခဲ့တာကို ရှင်းပြပါ"
              className={inputCls}
            />
            {msg && (
              <p className="text-sm text-red-600" role="alert">
                {msg}
              </p>
            )}
            <PrimaryButton type="submit" className="w-full">
              တင်ပြရန်
            </PrimaryButton>
          </form>
        </Card>
      )}

      {loading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState text="မရှိသေးပါ" />
      ) : (
        <ul className="space-y-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-3 lg:space-y-0">
          {rows.map((d) => (
            <li key={d.id} className={`${cardCls} p-3.5 lg:p-4`}>
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold">{agentNames[d.agent_id] ?? ''}</span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_CHIP_CLS[d.status]}`}
                  >
                    {STATUS_LABELS[d.status]}
                  </span>
                  <span className="text-xs text-stone-500 dark:text-neutral-400">
                    {new Date(d.created_at).toLocaleString('my-MM')}
                  </span>
                </span>
              </div>
              <p className="mt-1.5 text-sm">{d.message}</p>
              {d.reply && (
                <p className="mt-2 rounded-xl bg-stone-100 p-3 text-sm dark:bg-neutral-800">
                  ပြန်ဖြေ: {d.reply}
                </p>
              )}
              {canManage && d.status !== 'closed' && (
                <div className="mt-3 space-y-2.5">
                  <textarea
                    value={replyById[d.id] ?? ''}
                    onChange={(e) => setReplyById((s) => ({ ...s, [d.id]: e.target.value }))}
                    rows={2}
                    placeholder="ပြန်ဖြေရန်"
                    className={inputCls}
                  />
                  <div className="flex flex-wrap gap-2">
                    <PrimaryButton size="sm" onClick={() => onReply(d)}>
                      ပြန်ဖြေရန်
                    </PrimaryButton>
                    <SecondaryButton size="sm" onClick={() => onClose(d)}>
                      ပိတ်ရန်
                    </SecondaryButton>
                  </div>
                  {msg && (
                    <p className="text-sm text-red-600" role="alert">
                      {msg}
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
