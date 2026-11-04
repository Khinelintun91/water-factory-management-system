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

// The kind column (regular vs old-debt collection) is not in lib/types
// AgentPayment yet, so the page reads it locally like other pages do for
// later-migration columns.
type PaymentKind = 'regular' | 'old_debt'

interface PaymentRow extends AgentPayment {
  kind: PaymentKind | null
}

function kindChip(r: PaymentRow) {
  if (r.kind !== 'old_debt') return null
  return (
    <span className="ml-2 rounded-full bg-accent-100 px-2 py-0.5 align-middle text-xs font-semibold text-accent-800 dark:bg-amber-900 dark:text-amber-200">
      ကြွေးဟောင်း
    </span>
  )
}

export default function PaymentsPage() {
  const { profile } = useAuth()
  const canWrite = profile?.role === 'owner' || profile?.role === 'manager' || profile?.role === 'staff'
  const [agents, setAgents] = useState<Agent[]>([])
  const [rows, setRows] = useState<PaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [deleteReason, setDeleteReason] = useState('')

  // Same-day edit form (one row at a time), mirroring EntriesPage.
  const [editId, setEditId] = useState<string | null>(null)
  const [eAmount, setEAmount] = useState('')
  const [eMethod, setEMethod] = useState('cash')
  const [eKind, setEKind] = useState<PaymentKind>('regular')
  const [eNotes, setENotes] = useState('')
  const [eReason, setEReason] = useState('')

  const [agentId, setAgentId] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('cash')
  const [kind, setKind] = useState<PaymentKind>('regular')
  const [notes, setNotes] = useState('')
  // Owner-only backdating (same exception as EntriesPage): only the owner
  // sees a date field; every other role's payments are dated today.
  const isOwner = profile?.role === 'owner'
  const [payDate, setPayDate] = useState(todayYangon())

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
    setRows((pm ?? []) as PaymentRow[])
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
      payment_date: isOwner ? payDate || todayYangon() : todayYangon(),
      agent_id: agentId,
      amount: Number(amount) || 0,
      method,
      kind,
      notes: notes.trim() || null,
      created_by: profile?.id ?? null,
    })
    if (error) {
      setMsg(error.message)
      setBusy(false)
      return
    }
    setAmount('')
    setKind('regular')
    setNotes('')
    setPayDate(todayYangon())
    await load()
    setBusy(false)
  }

  function startEdit(row: PaymentRow) {
    setConfirmId(null)
    setDeleteReason('')
    setMsg(null)
    setEditId(row.id)
    setEAmount(String(row.amount))
    setEMethod(row.method)
    setEKind(row.kind === 'old_debt' ? 'old_debt' : 'regular')
    setENotes(row.notes ?? '')
    setEReason('')
  }

  async function saveEdit(row: PaymentRow) {
    if (busy) return
    const reason = eReason.trim()
    if (reason.length < 2) {
      setMsg('ပြင်ရသည့် အကြောင်းအရင်း (အနည်းဆုံး ၂ လုံး) ရေးပါ')
      return
    }
    if ((Number(eAmount) || 0) <= 0) {
      setMsg('ပမာဏ ထည့်ပါ')
      return
    }
    setBusy(true)
    setMsg(null)
    const { error } = await supabase
      .from('agent_payments')
      .update({
        amount: Number(eAmount) || 0,
        method: eMethod,
        kind: eKind,
        notes: eNotes.trim() || null,
        change_reason: reason,
      })
      .eq('id', row.id)
    if (error) {
      setMsg(error.message)
      setBusy(false)
      return
    }
    setEditId(null)
    await load()
    setBusy(false)
  }

  async function onDelete(row: PaymentRow) {
    const reason = deleteReason.trim()
    if (reason.length < 2) {
      setMsg('ဖျက်ရသည့် အကြောင်းအရင်း (အနည်းဆုံး ၂ လုံး) ရေးပါ')
      return
    }
    setMsg(null)
    // Stamp the reason first so the audit before-image of the delete
    // carries why the row was removed.
    const { error: stampError } = await supabase
      .from('agent_payments')
      .update({ change_reason: reason })
      .eq('id', row.id)
    if (stampError) {
      setMsg(stampError.message)
      return
    }
    const { error } = await supabase.from('agent_payments').delete().eq('id', row.id)
    if (error) setMsg(error.message)
    setConfirmId(null)
    setDeleteReason('')
    await load()
  }

  // --- Row pieces shared by the card list (phone/tablet) and the table
  // (desktop), following EntriesPage's pattern. ------------------------------

  function rowButtons(r: PaymentRow) {
    if (!canWrite || !isTodayYangon(r.created_at) || editId === r.id || confirmId === r.id) {
      return null
    }
    return (
      <div className="flex gap-2">
        <button
          onClick={() => startEdit(r)}
          className="inline-flex min-h-[40px] items-center rounded-lg bg-brand-50 px-3.5 font-medium text-brand-700 transition active:scale-[0.98] dark:bg-brand-950/50 dark:text-brand-300"
        >
          ပြင်ရန်
        </button>
        <button
          onClick={() => {
            setConfirmId(r.id)
            setDeleteReason('')
          }}
          className="inline-flex min-h-[40px] items-center rounded-lg bg-red-50 px-3.5 font-medium text-red-600 transition active:scale-[0.98] dark:bg-red-950/40 dark:text-red-400"
        >
          ဖျက်ရန်
        </button>
      </div>
    )
  }

  function rowPanel(r: PaymentRow) {
    if (!canWrite || !isTodayYangon(r.created_at)) return null
    if (confirmId === r.id) {
      return (
        <div className="space-y-2 rounded-xl border border-red-200 bg-red-50/60 p-3 dark:border-red-900 dark:bg-red-950/20">
          <input
            value={deleteReason}
            onChange={(e) => setDeleteReason(e.target.value)}
            placeholder="ဖျက်ရသည့် အကြောင်းအရင်း (လိုအပ်)"
            className={inputCls}
          />
          <div className="flex flex-wrap gap-2">
            <DangerButton size="sm" onClick={() => onDelete(r)}>
              သေချာပါတယ်, ဖျက်မည်
            </DangerButton>
            <SecondaryButton
              size="sm"
              onClick={() => {
                setConfirmId(null)
                setDeleteReason('')
              }}
            >
              မဖျက်တော့ပါ
            </SecondaryButton>
          </div>
        </div>
      )
    }
    if (editId === r.id) {
      return (
        <div className="space-y-2.5 rounded-xl border border-stone-200 bg-stone-50/70 p-3.5 dark:border-neutral-800 dark:bg-neutral-800/40">
          <div className="font-semibold">မှတ်တမ် ပြင်ရန်</div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="ပမာဏ (ကျပ်)">
              <input
                value={eAmount}
                onChange={(e) => setEAmount(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="နည်းလမ်း">
              <select
                value={eMethod}
                onChange={(e) => setEMethod(e.target.value)}
                className={inputCls}
              >
                <option value="cash">ငွေသား</option>
                <option value="kbzpay">KBZPay</option>
                <option value="wavepay">WavePay</option>
                <option value="bank">ဘဏ်</option>
              </select>
            </Field>
            <Field label="အမျိုးအစား">
              <select
                value={eKind}
                onChange={(e) => setEKind(e.target.value as PaymentKind)}
                className={inputCls}
              >
                <option value="regular">ပုံမှန် ကောက်ငွေ</option>
                <option value="old_debt">ကြွေးဟောင်း</option>
              </select>
            </Field>
          </div>
          <input
            value={eNotes}
            onChange={(e) => setENotes(e.target.value)}
            placeholder="မှတ်ချက် (ရှိလျှင်)"
            className={inputCls}
          />
          <Field label="ပြင်ရသည့် အကြောင်းရင်း">
            <input
              value={eReason}
              onChange={(e) => setEReason(e.target.value)}
              placeholder="ပြင်ရသည့် အကြောင်းအရင်း (လိုအပ်)"
              className={inputCls}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <PrimaryButton size="sm" onClick={() => saveEdit(r)} disabled={busy}>
              သိမ်းမည်
            </PrimaryButton>
            <SecondaryButton size="sm" onClick={() => setEditId(null)}>
              မလုပ်တော့ပါ
            </SecondaryButton>
          </div>
        </div>
      )
    }
    return null
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
          {isOwner && (
            <Field label="ရက်စွဲ">
              <input
                type="date"
                value={payDate}
                max={todayYangon()}
                onChange={(e) => setPayDate(e.target.value)}
                className={inputCls}
              />
            </Field>
          )}
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
            <Field label="အမျိုးအစား">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as PaymentKind)}
                className={inputCls}
              >
                <option value="regular">ပုံမှန် ကောက်ငွေ</option>
                <option value="old_debt">ကြွေးဟောင်း</option>
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
                  <div className="font-semibold">
                    {agentName(r.agent_id)}
                    {kindChip(r)}
                  </div>
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
                          <div className="font-medium">
                            {agentName(r.agent_id)}
                            {kindChip(r)}
                          </div>
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
