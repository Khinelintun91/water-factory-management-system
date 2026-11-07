import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { fetchAll } from '../lib/fetchAll'
import {
  count as queueCount,
  enqueue,
  isNetworkError,
  peekAll,
  removeAt,
  type EntryInsert,
} from '../lib/offlineQueue'
import {
  formatMMK,
  isTodayYangon,
  todayYangon,
  type Agent,
  type DailyEntry,
} from '../lib/types'
import {
  Banner,
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

// Columns added by migration 0006 (not in lib/types DailyEntry yet).
// unit_price / amount on the row are server-computed (price snapshot of the
// agent at insert time; amount = delivered_qty x unit_price) — the client
// never sends them.
interface EntryRow extends Omit<DailyEntry, 'agent_id'> {
  agent_id: string | null
  agent_name: string | null
  amount_collected: number
  change_reason: string | null
}

const MONTH_NAMES = [
  'ဇန်နဝါရီ', 'ဖေဖော်ဝါရီ', 'မတ်', 'ဧပြီ', 'မေ', 'ဇွန်',
  'ဇူလိုင်', 'ဩဂုတ်', 'စက်တင်ဘာ', 'အောက်တိုဘာ', 'နိုဝင်ဘာ', 'ဒီဇင်ဘာ',
]

/**
 * Month filter options: "all" + every month from the 2020-01 floor through
 * next month, newest first. The business keeps ALL history, so any past
 * month must stay reachable in this selector.
 */
function monthOptions(): { value: string; label: string }[] {
  const [y, m] = todayYangon().split('-').map(Number)
  const out: { value: string; label: string }[] = [{ value: 'all', label: 'အားလုံး' }]
  let yy = y
  let mm = m + 1
  if (mm === 13) {
    mm = 1
    yy += 1
  }
  while (yy > 2020 || (yy === 2020 && mm >= 1)) {
    out.push({
      value: `${yy}-${String(mm).padStart(2, '0')}`,
      label: `${MONTH_NAMES[mm - 1]} ${yy}`,
    })
    mm -= 1
    if (mm === 0) {
      mm = 12
      yy -= 1
    }
  }
  return out
}

/** Rows rendered at a time in the entries list; "load more" adds another page. */
const RENDER_PAGE_SIZE = 200

const compactSelectCls =
  'min-h-[44px] rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/40 dark:border-neutral-700 dark:bg-neutral-900'

export default function EntriesPage() {
  const { profile } = useAuth()
  const canWrite = profile?.role === 'owner' || profile?.role === 'manager' || profile?.role === 'staff'
  const [agents, setAgents] = useState<Agent[]>([])
  const [rows, setRows] = useState<EntryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [deleteReason, setDeleteReason] = useState('')
  const [monthFilter, setMonthFilter] = useState(() => todayYangon().slice(0, 7))
  // Render cap only (data is fully fetched): large sets — "all" mode or a
  // busy month — would otherwise freeze the tab rendering thousands of rows.
  const [renderLimit, setRenderLimit] = useState(RENDER_PAGE_SIZE)

  // New-entry form.
  const [agentId, setAgentId] = useState('')
  const [delivered, setDelivered] = useState('')
  const [returned, setReturned] = useState('')
  const [cash, setCash] = useState('')
  // Optional: money the agent pays toward OLD debt during this same visit.
  // On save it becomes a separate agent_payments row (kind 'old_debt'),
  // never part of this entry's amount/amount_collected.
  const [oldDebt, setOldDebt] = useState('')
  const [notes, setNotes] = useState('')
  const [confirming, setConfirming] = useState(false)
  // Owner-only backdating: only the owner sees a date field and may file an
  // entry for a past day (the DB insert guard carries the same exception).
  // Every other role's entries are always dated today, exactly as before.
  const isOwner = profile?.role === 'owner'
  const [entryDate, setEntryDate] = useState(todayYangon())

  // Offline queue (lib/offlineQueue): entries saved while unreachable.
  const [queued, setQueued] = useState(() => queueCount())
  const [droppedStale, setDroppedStale] = useState(0)
  const [flushing, setFlushing] = useState(false)
  const flushingRef = useRef(false)

  // Same-day edit form (one row at a time).
  const [editId, setEditId] = useState<string | null>(null)
  const [eDelivered, setEDelivered] = useState('')
  const [eReturned, setEReturned] = useState('')
  const [eCash, setECash] = useState('')
  const [eNotes, setENotes] = useState('')
  const [eReason, setEReason] = useState('')

  const agentName = useMemo(() => {
    const m = new Map(agents.map((a) => [a.id, a.name]))
    return (id: string | null) => (id ? m.get(id) ?? '—' : '—')
  }, [agents])

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ag }, en] = await Promise.all([
      supabase.from('agents').select('*').order('created_at'),
      // The selected month is filtered server-side by entry_date range and
      // every page is fetched — the old client-side filter over a capped
      // list silently dropped rows from busier months.
      fetchAll<EntryRow>((from, to) => {
        let q = supabase.from('daily_entries').select('*')
        if (monthFilter !== 'all') {
          const [y, m] = monthFilter.split('-').map(Number)
          const start = `${monthFilter}-01`
          const end =
            m === 12
              ? `${y + 1}-01-01`
              : `${y}-${String(m + 1).padStart(2, '0')}-01`
          q = q.gte('entry_date', start).lt('entry_date', end)
        }
        return q
          .order('entry_date', { ascending: false })
          .order('created_at', { ascending: false })
          .range(from, to)
      }),
    ])
    setAgents((ag ?? []) as Agent[])
    setRows(en)
    setLoading(false)
  }, [monthFilter])

  useEffect(() => {
    load()
  }, [load])

  // Flush queued entries in order. An entry rejected by the DB same-day
  // insert guard (queued before midnight, flushed after) can NEVER succeed,
  // so it is dropped and counted instead of blocking everything queued
  // behind it forever; the dropped count surfaces as a persistent warning
  // below. Any other failure stops the flush so nothing is skipped over a
  // server-rule error. Returns the first blocking error message, or null.
  const flushQueue = useCallback(async (): Promise<string | null> => {
    if (flushingRef.current) return null
    if (peekAll().length === 0) {
      setQueued(0)
      return null
    }
    flushingRef.current = true
    setFlushing(true)
    let firstError: string | null = null
    let dropped = 0
    const resolved: number[] = [] // indices sent or dropped; removed after
    const items = peekAll()
    for (let i = 0; i < items.length; i++) {
      let failure: string | null = null
      try {
        const { error } = await supabase.from('daily_entries').insert(items[i].payload)
        if (error) failure = error.message
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
      }
      if (failure === null) {
        resolved.push(i)
      } else if (failure.includes('same_day_only')) {
        // Stale: its Yangon day has passed; the guard will never accept it.
        resolved.push(i)
        dropped += 1
      } else {
        firstError = failure
        break
      }
    }
    if (resolved.length > 0) {
      // Remove from the end backwards so earlier indices stay valid.
      for (const i of [...resolved].sort((a, b) => b - a)) removeAt(i)
      await load()
    }
    if (dropped > 0) setDroppedStale((n) => n + dropped)
    setQueued(queueCount())
    flushingRef.current = false
    setFlushing(false)
    return firstError
  }, [load])

  // Auto-flush on mount and whenever the connection comes back.
  useEffect(() => {
    flushQueue()
    const onOnline = () => {
      flushQueue()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [flushQueue])

  // Live preview from the selected agent's price (server snapshots the same
  // price and computes the amount; this is display-only).
  const selectedAgent = agents.find((a) => a.id === agentId) ?? null
  const price = selectedAgent?.default_unit_price ?? 0
  const qty = Number(delivered) || 0
  const due = qty * price
  const cashNum = Number(cash) || 0
  const remaining = due - cashNum
  const oldDebtNum = Number(oldDebt) || 0

  // Rows arrive already scoped to the selected month (see load()).
  // visibleRows is the FULL set (summaries/counts use it); displayRows is
  // only what gets rendered, capped by renderLimit with a load-more button.
  const visibleRows = rows
  const displayRows = visibleRows.slice(0, renderLimit)

  function onAdd(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setMsg(null)
    if (!agentId) {
      setMsg('ကိုယ်စားလှယ် ရွေးပါ')
      return
    }
    if (qty <= 0) {
      setMsg('ပို့သည့် ဗူး အရေအတွက် ထည့်ပါ')
      return
    }
    // Step 1: show the in-app confirmation panel; insert happens on confirm.
    setConfirming(true)
  }

  async function doInsert() {
    if (busy) return
    setBusy(true)
    setMsg(null)
    // unit_price and amount are computed by the server — do not send them.
    const payload: EntryInsert = {
      entry_date: isOwner ? entryDate || todayYangon() : todayYangon(),
      agent_id: agentId,
      delivered_qty: qty,
      returned_qty: Number(returned) || 0,
      amount_collected: cashNum,
      notes: notes.trim() || null,
      created_by: profile?.id ?? null,
    }
    // Offline right now: queue the exact payload instead of losing the form.
    // The queue stores daily_entries payloads only (lib/offlineQueue), so a
    // ကြွေးကောက် amount cannot ride along safely — it is excluded from
    // queued submissions and afterQueued tells the user to record it
    // separately on the Payments page once reconnected.
    if (!navigator.onLine) {
      enqueue(payload)
      afterQueued()
      return
    }
    let failure: unknown = null
    try {
      const { error } = await supabase.from('daily_entries').insert(payload)
      failure = error
    } catch (err) {
      failure = err
    }
    if (failure) {
      // Connection dropped mid-save: queue it, same as the offline path.
      if (isNetworkError(failure)) {
        enqueue(payload)
        afterQueued()
        return
      }
      const m = (failure as { message?: unknown }).message
      setMsg(typeof m === 'string' ? m : String(failure))
      setConfirming(false)
      setBusy(false)
      return
    }
    // Entry saved. A ကြွေးကောက် amount typed with this visit is money
    // toward the agent's OLD debt, so it lands as its own payments row
    // (kind 'old_debt') for the same agent and day — the entry's own
    // amount/amount_collected are untouched. If this second write fails,
    // say so plainly (entry kept, collection missing) in the AgentsPage
    // partial-failure style instead of pretending a full success.
    let partialMsg: string | null = null
    if (oldDebtNum > 0) {
      let pFailure: unknown = null
      try {
        const { error } = await supabase.from('agent_payments').insert({
          payment_date: payload.entry_date,
          agent_id: agentId,
          agent_name: selectedAgent?.name ?? null,
          amount: oldDebtNum,
          method: 'cash',
          kind: 'old_debt',
          notes: 'ရေပို့မှတ်တမ်းနှင့်အတူ ကောက်ခံသည်',
          created_by: profile?.id ?? null,
        })
        pFailure = error
      } catch (err) {
        pFailure = err
      }
      if (pFailure) {
        const m = (pFailure as { message?: unknown }).message
        partialMsg = `ရေပို့မှတ်တမ် သိမ်းပြီးပါပြီ၊ ကြွေးကောက်ငွေ သိမ်း၍ မရပါ: ${typeof m === 'string' ? m : String(pFailure)}`
      }
    }
    setDelivered('')
    setReturned('')
    setCash('')
    setOldDebt('')
    setNotes('')
    setEntryDate(todayYangon())
    setConfirming(false)
    await load()
    if (partialMsg) setMsg(partialMsg)
    setBusy(false)
  }

  // Shared tail for "saved to the offline queue": clear the form and tell
  // the user it will upload itself when the connection returns. A
  // ကြွေးကောက် amount never enters the queue (the queue holds entry
  // payloads only), so when one was typed the message says it was NOT
  // saved and must be recorded separately after reconnecting.
  function afterQueued() {
    const hadOldDebt = oldDebtNum > 0
    setDelivered('')
    setReturned('')
    setCash('')
    setOldDebt('')
    setNotes('')
    setEntryDate(todayYangon())
    setConfirming(false)
    setQueued(queueCount())
    setMsg(
      hadOldDebt
        ? 'အင်တာနက် မရှိသေးလို့ ရေပို့မှတ်တမ်းကို သိမ်းထားပါတယ် — ပြန်ချိတ်ရင် အလိုအလျောက် တင်ပေးပါမယ်။ ကြွေးကောက်ငွေ ကိုတော့ မသိမ်းရသေးပါ — ပြန်ချိတ်ပြီးရင် ငွေကောက်ခံမှုများ စာမျက်နှာမှာ သီးခြား မှတ်ပေးပါ'
        : 'အင်တာနက် မရှိသေးလို့ သိမ်းထားပါတယ် — ပြန်ချိတ်ရင် အလိုအလျောက် တင်ပေးပါမယ်',
    )
    setBusy(false)
  }

  function startEdit(row: EntryRow) {
    setConfirmId(null)
    setDeleteReason('')
    setMsg(null)
    setEditId(row.id)
    setEDelivered(String(row.delivered_qty))
    setEReturned(String(row.returned_qty))
    setECash(String(row.amount_collected))
    setENotes(row.notes ?? '')
    setEReason('')
  }

  async function saveEdit(row: EntryRow) {
    if (busy) return
    const reason = eReason.trim()
    if (reason.length < 2) {
      setMsg('ပြင်ရသည့် အကြောင်းအရင်း (အနည်းဆုံး ၂ လုံး) ရေးပါ')
      return
    }
    if ((Number(eDelivered) || 0) <= 0) {
      setMsg('ပို့သည့် ဗူး အရေအတွက် ထည့်ပါ')
      return
    }
    setBusy(true)
    setMsg(null)
    // Server recomputes amount from qty x the row's snapshot price.
    const { error } = await supabase
      .from('daily_entries')
      .update({
        delivered_qty: Number(eDelivered) || 0,
        returned_qty: Number(eReturned) || 0,
        amount_collected: Number(eCash) || 0,
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

  async function onDelete(row: EntryRow) {
    const reason = deleteReason.trim()
    if (reason.length < 2) {
      setMsg('ဖျက်ရသည့် အကြောင်းအရင်း (အနည်းဆုံး ၂ လုံး) ရေးပါ')
      return
    }
    setMsg(null)
    // Stamp the reason first so the audit before-image of the delete
    // carries why the row was removed.
    const { error: stampError } = await supabase
      .from('daily_entries')
      .update({ change_reason: reason })
      .eq('id', row.id)
    if (stampError) {
      setMsg(stampError.message)
      return
    }
    const { error } = await supabase.from('daily_entries').delete().eq('id', row.id)
    if (error) setMsg(error.message)
    setConfirmId(null)
    setDeleteReason('')
    await load()
  }

  // --- Row pieces shared by the card list (phone/tablet) and the table
  // (desktop). Plain render functions (not components) so the edit inputs
  // keep focus across re-renders. -------------------------------------------

  function rowButtons(r: EntryRow) {
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

  function rowPanel(r: EntryRow) {
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
            <Field label="ပို့သည့် ဗူး">
              <input
                value={eDelivered}
                onChange={(e) => setEDelivered(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="ပြန်အပ်သည့် ဗူး">
              <input
                value={eReturned}
                onChange={(e) => setEReturned(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="လက်ခံရရှိငွေ (ကျပ်)">
              <input
                value={eCash}
                onChange={(e) => setECash(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
          </div>
          <input
            value={eNotes}
            onChange={(e) => setENotes(e.target.value)}
            placeholder="မှတ်ချက် (ရှိလျှင်)"
            className={inputCls}
          />
          <input
            value={eReason}
            onChange={(e) => setEReason(e.target.value)}
            placeholder="ပြင်ရသည့် အကြောင်းအရင်း (လိုအပ်)"
            className={inputCls}
          />
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
        title="ပို့ဆောင်မှု မှတ်တမ်းများ"
        subtitle="ပို့ဘူး၊ ပြန်အပ်ဘူးနှင့် လက်ခံငွေ နေ့စဉ် မှတ်ရန်"
      />

      {queued > 0 && (
        <Banner
          tone="amber"
          action={
            <PrimaryButton
              size="sm"
              disabled={flushing}
              onClick={async () => {
                const err = await flushQueue()
                if (err) setMsg(err)
              }}
              className="shrink-0"
            >
              အခု တင်မယ်
            </PrimaryButton>
          }
        >
          ⏳ တင်ရန် စောင့်နေသော မှတ်တမ်း {queued} ခု
        </Banner>
      )}

      {droppedStale > 0 && (
        <Banner tone="red">
          ⚠️ ရက်ကျော်သွားလို့ တင်လို့ မရတော့သော မှတ်တမ်း {droppedStale} ခု ရှိပါတယ် — စီမံသူကို အကြောင်းကြားပါ
        </Banner>
      )}

      {canWrite && (
        <form onSubmit={onAdd} className={`${cardCls} space-y-3 p-4 lg:p-5`}>
          <div className="text-base font-semibold">{isOwner ? 'မှတ်တမ်အသစ်' : 'ယနေ့ မှတ်တမ်အသစ်'}</div>
          {isOwner && (
            <Field label="ရက်စွဲ">
              <input
                type="date"
                value={entryDate}
                max={todayYangon()}
                onChange={(e) => {
                  setEntryDate(e.target.value)
                  setConfirming(false)
                }}
                className={inputCls}
              />
            </Field>
          )}
          <Field label="ကိုယ်စားလှယ်">
            <select
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value)
                setConfirming(false)
              }}
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
            <Field label="ပို့သည့် ဗူး">
              <input
                value={delivered}
                onChange={(e) => {
                  setDelivered(e.target.value.replace(/\D/g, ''))
                  setConfirming(false)
                }}
                inputMode="numeric"
                required
                className={inputCls}
              />
            </Field>
            <Field label="ပြန်အပ်သည့် ဗူး">
              <input
                value={returned}
                onChange={(e) => {
                  setReturned(e.target.value.replace(/\D/g, ''))
                  setConfirming(false)
                }}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="လက်ခံရရှိငွေ (ကျပ်)">
              <input
                value={cash}
                onChange={(e) => {
                  setCash(e.target.value.replace(/\D/g, ''))
                  setConfirming(false)
                }}
                inputMode="numeric"
                placeholder="0"
                className={inputCls}
              />
            </Field>
            <Field label="ဈေးနှုန်း (၁ ဗူး)">
              <div className="flex min-h-[48px] items-center rounded-xl border border-stone-200 bg-stone-50 px-3.5 font-medium tabular-nums dark:border-neutral-800 dark:bg-neutral-800/60">
                {selectedAgent ? formatMMK(price) : '—'}
              </div>
            </Field>
          </div>
          <Field label="ကြွေးကောက်ငွေ (ကျပ်)">
            <input
              value={oldDebt}
              onChange={(e) => {
                setOldDebt(e.target.value.replace(/\D/g, ''))
                setConfirming(false)
              }}
              inputMode="numeric"
              placeholder="0"
              className={inputCls}
            />
            <span className="mt-1 block text-xs opacity-60">
              ကြွေးကောက်ငွေသည် ကြွေးကျန်မှ နုတ်မည်
            </span>
          </Field>
          <input
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value)
              setConfirming(false)
            }}
            placeholder="မှတ်ချက် (ရှိလျှင်)"
            className={inputCls}
          />
          {qty > 0 && (
            <p className="rounded-xl bg-brand-50 px-3.5 py-2.5 text-sm dark:bg-brand-950/40">
              ပေးရန် စုစုပေါင်း: {formatMMK(due)} · လက်ခံရရှိငွေ: {formatMMK(cashNum)} ·
              ကျန်ကြွေး: {formatMMK(remaining)}
            </p>
          )}
          {msg && (
            <p className="text-sm text-red-600" role="alert">
              {msg}
            </p>
          )}
          {!confirming && (
            <div className="max-md:sticky max-md:bottom-[calc(70px_+_env(safe-area-inset-bottom))] max-md:z-10 max-md:-mx-4 max-md:border-t max-md:border-stone-200 max-md:bg-white max-md:px-4 max-md:py-2.5 dark:max-md:border-neutral-800 dark:max-md:bg-neutral-900">
              <PrimaryButton type="submit" disabled={busy} className="w-full">
                သိမ်းရန်
              </PrimaryButton>
            </div>
          )}
          {confirming && selectedAgent && (
            <div className="space-y-1.5 rounded-2xl border-2 border-accent-400 bg-accent-50 p-4 text-sm dark:border-accent-700 dark:bg-amber-950/30">
              <div className="text-base font-bold">သိမ်းမည့် အချက်အလက် စစ်ဆေးပါ</div>
              <dl className="space-y-1">
                {isOwner && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="opacity-70">ရက်စွဲ</dt>
                    <dd className="font-medium tabular-nums">{entryDate}</dd>
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="opacity-70">ကိုယ်စားလှယ်</dt>
                  <dd className="font-semibold">{selectedAgent.name}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="opacity-70">ပို့သည့် ဗူး</dt>
                  <dd className="font-medium tabular-nums">{qty} ဗူး</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="opacity-70">ပြန်အပ်သည့် ဗူး</dt>
                  <dd className="font-medium tabular-nums">{Number(returned) || 0} ဗူး</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="opacity-70">ဈေးနှုန်း (၁ ဗူး)</dt>
                  <dd className="font-medium tabular-nums">{formatMMK(price)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="opacity-70">ပေးရန် စုစုပေါင်း</dt>
                  <dd className="font-bold tabular-nums">{formatMMK(due)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="opacity-70">လက်ခံရရှိငွေ (ကျပ်)</dt>
                  <dd className="font-medium tabular-nums">{formatMMK(cashNum)}</dd>
                </div>
                {oldDebtNum > 0 && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="opacity-70">ကြွေးကောက်ငွေ (ကျပ်)</dt>
                    <dd className="font-medium tabular-nums">{formatMMK(oldDebtNum)}</dd>
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="opacity-70">ကျန်ကြွေး</dt>
                  <dd className={`font-bold tabular-nums ${remaining > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>
                    {formatMMK(remaining)}
                  </dd>
                </div>
              </dl>
              {cashNum === 0 && due > 0 && (
                <p className="font-semibold text-red-600">
                  သတိ: ငွေ လုံးဝ မကောက်ရသေးပါ — {formatMMK(due)} အပြည့် ကြွေး အဖြစ်
                  ကျန်ပါမည်
                </p>
              )}
              <div className="flex gap-2 pt-1.5">
                <PrimaryButton disabled={busy} onClick={doInsert} className="flex-1">
                  အတည်ပြု သိမ်းမည်
                </PrimaryButton>
                <SecondaryButton onClick={() => setConfirming(false)}>
                  ပြန်ပြင်မည်
                </SecondaryButton>
              </div>
            </div>
          )}
          <p className="text-xs opacity-60">
            ပြင်/ဖျက် လုပ်ခွင့်က ထည့်သွင်းသည့် နေ့ တစ်နေ့တည်းသာ ရပါမယ် (ပိုင်ရှင် အပါအဝင် အားလုံး)။
          </p>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="entries-month-filter" className="text-sm font-medium">
          လ အလိုက် ကြည့်ရန်
        </label>
        <select
          id="entries-month-filter"
          value={monthFilter}
          onChange={(e) => {
            setMonthFilter(e.target.value)
            setRenderLimit(RENDER_PAGE_SIZE)
          }}
          className={compactSelectCls}
        >
          {monthOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <>
          <LoadingState />
          {monthFilter === 'all' && (
            <p className="text-center text-sm text-stone-500 dark:text-neutral-400">
              မှတ်တမ်း အားလုံး ဖတ်နေပါတယ် — ၅ နှစ်စာ မို့ ခဏ ကြာနိုင်ပါတယ်…
            </p>
          )}
        </>
      ) : visibleRows.length === 0 ? (
        <EmptyState
          text={
            monthFilter === 'all'
              ? 'မှတ်တမ် မရှိသေးပါ'
              : 'ရွေးထားသော လတွင် မှတ်တမ် မရှိပါ'
          }
        />
      ) : (
        <>
          {/* Phone / tablet: one card per record. */}
          <ul className="space-y-3 lg:hidden">
            {displayRows.map((r) => (
              <li key={r.id} className={`${cardCls} p-3.5`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold">{r.agent_name ?? agentName(r.agent_id)}</div>
                  <div className="font-bold tabular-nums">{formatMMK(r.amount)}</div>
                </div>
                <div className="mt-0.5 text-sm text-stone-500 dark:text-neutral-400">
                  {r.entry_date} · ပို့ {r.delivered_qty} · ပြန် {r.returned_qty} ·{' '}
                  {formatMMK(r.unit_price)}/ဗူး
                  {r.notes ? ` · ${r.notes}` : ''}
                </div>
                <div className="text-sm text-stone-500 dark:text-neutral-400">
                  လက်ခံရရှိငွေ {formatMMK(r.amount_collected)} · ကျန်ပေးရန်{' '}
                  <span
                    className={
                      r.amount - r.amount_collected > 0
                        ? 'font-semibold text-red-600 dark:text-red-400'
                        : 'font-medium'
                    }
                  >
                    {formatMMK(r.amount - r.amount_collected)}
                  </span>
                </div>
                <div className="mt-2.5 empty:hidden">{rowButtons(r)}</div>
                <div className="mt-2.5 empty:hidden">{rowPanel(r)}</div>
              </li>
            ))}
          </ul>

          {/* Desktop: table. */}
          <div className={`${cardCls} hidden overflow-x-auto lg:block`}>
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50/80 text-left text-stone-500 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-400">
                  <th className={`${thCls} pl-4`}>ကိုယ်စားလှယ်</th>
                  <th className={thCls}>ရက်စွဲ</th>
                  <th className={`${thCls} text-right`}>ပို့သည့် ဗူး</th>
                  <th className={`${thCls} text-right`}>ပြန်အပ်သည့် ဗူး</th>
                  <th className={`${thCls} text-right`}>ဈေးနှုန်း (၁ ဗူး)</th>
                  <th className={`${thCls} text-right`}>ပေးရန် စုစုပေါင်း</th>
                  <th className={`${thCls} text-right`}>လက်ခံရရှိငွေ (ကျပ်)</th>
                  <th className={`${thCls} text-right`}>ကျန်ပေးရန်</th>
                  <th className={`${thCls} pr-4`}>
                    <span className="sr-only">လုပ်ဆောင်ချက်</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r) => {
                  const panel = rowPanel(r)
                  return (
                    <Fragment key={r.id}>
                      <tr className="border-b border-stone-100 align-top last:border-0 dark:border-neutral-800/70">
                        <td className="px-3 py-3 pl-4">
                          <div className="font-medium">{r.agent_name ?? agentName(r.agent_id)}</div>
                          {r.notes && <div className="text-xs opacity-60">{r.notes}</div>}
                        </td>
                        <td className={`${tdCls} whitespace-nowrap`}>{r.entry_date}</td>
                        <td className={`${tdCls} text-right`}>{r.delivered_qty}</td>
                        <td className={`${tdCls} text-right`}>{r.returned_qty}</td>
                        <td className={`${tdCls} text-right`}>{formatMMK(r.unit_price)}</td>
                        <td className={`${tdCls} text-right font-semibold`}>{formatMMK(r.amount)}</td>
                        <td className={`${tdCls} text-right`}>{formatMMK(r.amount_collected)}</td>
                        <td
                          className={`${tdCls} text-right ${
                            r.amount - r.amount_collected > 0
                              ? 'font-semibold text-red-600 dark:text-red-400'
                              : ''
                          }`}
                        >
                          {formatMMK(r.amount - r.amount_collected)}
                        </td>
                        <td className="px-3 py-2 pr-4">{rowButtons(r)}</td>
                      </tr>
                      {panel && (
                        <tr className="border-b border-stone-100 last:border-0 dark:border-neutral-800/70">
                          <td colSpan={9} className="px-4 pb-3">
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

          {visibleRows.length > RENDER_PAGE_SIZE && (
            <div className="space-y-2">
              <p className="text-center text-sm text-stone-500 dark:text-neutral-400">
                {displayRows.length} / {visibleRows.length} မှတ်တမ်း
              </p>
              {displayRows.length < visibleRows.length && (
                <SecondaryButton
                  onClick={() => setRenderLimit((n) => n + RENDER_PAGE_SIZE)}
                  className="w-full"
                >
                  နောက်ထပ် ၂၀၀ ကြည့်ရန်
                </SecondaryButton>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
