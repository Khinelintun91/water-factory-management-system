import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import {
  formatMMK,
  isTodayYangon,
  todayYangon,
  type Agent,
  type AgentPayment,
} from '../lib/types'
import {
  DangerButton,
  EmptyState,
  Field,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  cardCls,
  inputCls,
} from '../components/ui'

// Display labels for the stored method values (same words as the form's
// <option> labels below).
const METHOD_LABELS: Record<string, string> = {
  cash: 'ငွေသား',
  kbzpay: 'KBZPay',
  wavepay: 'WavePay',
  bank: 'ဘဏ်',
}

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

  // --- Row pieces shared by the card list (phone/tablet) and the table
  // (desktop), following EntriesPage's pattern. ------------------------------

  function rowButtons(r: AgentPayment) {
    if (!canWrite || !isTodayYangon(r.created_at) || confirmId === r.id) {
      return null
    }
    return (
      <button
        onClick={() => setConfirmId(r.id)}
        className="inline-flex min-h-[40px] items-center rounded-lg bg-red-50 px-3.5 font-medium text-red-600 transition active:scale-[0.98] dark:bg-red-950/40 dark:text-red-400"
      >
        ဖျက်ရန်
      </button>
    )
  }

  function rowPanel(r: AgentPayment) {
    if (!canWrite || !isTodayYangon(r.created_at) || confirmId !== r.id) {
      return null
    }
    return (
      <div className="rounded-xl border border-red-200 bg-red-50/60 p-3 dark:border-red-900 dark:bg-red-950/20">
        <div className="flex flex-wrap gap-2">
          <DangerButton size="sm" onClick={() => onDelete(r)}>
            သေချာပါတယ်, ဖျက်မည်
          </DangerButton>
          <SecondaryButton size="sm" onClick={() => setConfirmId(null)}>
            မဖျက်တော့ပါ
          </SecondaryButton>
        </div>
      </div>
    )
  }

  const thCls = 'px-3 py-3 font-medium'
  const tdCls = 'px-3 py-3 tabular-nums'

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="ငွေကောက်ခံမှုများ"
        subtitle="ကိုယ်စားလှယ်များထံမှ ကြွေးကောက် လက်ခံငွေ မှတ်ရန်"
      />

      {canWrite && (
        <form onSubmit={onAdd} className={`${cardCls} space-y-3 p-4 lg:p-5`}>
          <div className="text-base font-semibold">ကောက်ခံမှုအသစ်</div>
          <Field label="ကိုယ်စားလှယ်">
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              required
              className={inputCls}
            >
              <option value="">ကိုယ်စားလှယ် ရွေးပါ</option>
              {agents.filter((a) => a.active).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="ပမာဏ (ကျပ်)">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                required
                className={inputCls}
              />
            </Field>
            <Field label="နည်းလမ်း">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className={inputCls}
              >
                <option value="cash">ငွေသား</option>
                <option value="kbzpay">KBZPay</option>
                <option value="wavepay">WavePay</option>
                <option value="bank">ဘဏ်</option>
              </select>
            </Field>
          </div>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="မှတ်ချက် (ရှိလျှင်)"
            className={inputCls}
          />
          {msg && (
            <p className="text-sm text-red-600" role="alert">
              {msg}
            </p>
          )}
          <div className="max-md:sticky max-md:bottom-[calc(70px_+_env(safe-area-inset-bottom))] max-md:z-10 max-md:-mx-4 max-md:border-t max-md:border-stone-200/90 max-md:bg-white/95 max-md:px-4 max-md:py-2.5 max-md:backdrop-blur dark:max-md:border-neutral-800 dark:max-md:bg-neutral-900/95">
            <PrimaryButton type="submit" disabled={busy} className="w-full">
              သိမ်းရန်
            </PrimaryButton>
          </div>
        </form>
      )}

      {loading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState text="မှတ်တမ် မရှိသေးပါ" />
      ) : (
        <>
          {/* Phone / tablet: one card per record. */}
          <ul className="space-y-3 lg:hidden">
            {rows.map((r) => (
              <li key={r.id} className={`${cardCls} p-3.5`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold">{agentName(r.agent_id)}</div>
                  <div className="font-bold tabular-nums">{formatMMK(r.amount)}</div>
                </div>
                <div className="mt-0.5 text-sm text-stone-500 dark:text-neutral-400">
                  {r.payment_date} · {METHOD_LABELS[r.method] ?? r.method}
                  {r.notes ? ` · ${r.notes}` : ''}
                </div>
                <div className="mt-2.5 empty:hidden">{rowButtons(r)}</div>
                <div className="mt-2.5 empty:hidden">{rowPanel(r)}</div>
              </li>
            ))}
          </ul>

          {/* Desktop: table. */}
          <div className={`${cardCls} hidden overflow-x-auto lg:block`}>
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50/80 text-left text-stone-500 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-400">
                  <th className={`${thCls} pl-4`}>ကိုယ်စားလှယ်</th>
                  <th className={thCls}>ရက်စွဲ</th>
                  <th className={thCls}>နည်းလမ်း</th>
                  <th className={`${thCls} text-right`}>ပမာဏ (ကျပ်)</th>
                  <th className={`${thCls} pr-4`}>
                    <span className="sr-only">လုပ်ဆောင်ချက်</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const panel = rowPanel(r)
                  return (
                    <Fragment key={r.id}>
                      <tr className="border-b border-stone-100 align-top last:border-0 dark:border-neutral-800/70">
                        <td className="px-3 py-3 pl-4">
                          <div className="font-medium">{agentName(r.agent_id)}</div>
                          {r.notes && <div className="text-xs opacity-60">{r.notes}</div>}
                        </td>
                        <td className={`${tdCls} whitespace-nowrap`}>{r.payment_date}</td>
                        <td className="px-3 py-3">{METHOD_LABELS[r.method] ?? r.method}</td>
                        <td className={`${tdCls} text-right font-semibold`}>{formatMMK(r.amount)}</td>
                        <td className="px-3 py-2 pr-4">{rowButtons(r)}</td>
                      </tr>
                      {panel && (
                        <tr className="border-b border-stone-100 last:border-0 dark:border-neutral-800/70">
                          <td colSpan={5} className="px-4 pb-3">
                            {panel}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
