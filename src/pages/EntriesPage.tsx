import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { friendlyError } from '../lib/friendlyError'
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
  personName,
  todayYangon,
  type Agent,
  type DailyEntry,
} from '../lib/types'
import {
  fetchStaffDirectory,
  receiverName,
  type StaffDirectory,
} from '../lib/staffDirectory'
import { allocateCash, editBaseOutstanding, syncAutoCash } from '../lib/cashAllocation'
import {
  buildEntryPayload,
  isBottleOnlyEntry,
  isOverReturn,
  validateEditEntry,
  validateNewEntry,
  type EntryMode,
} from '../lib/entryMode'
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
  const { profile, roles } = useAuth()
  const canWrite =
    roles.includes('owner') || roles.includes('manager') || roles.includes('staff')
  const isAgent = !canWrite && (profile?.role === 'agent' || roles.includes('agent'))
  // Rule A (migration 0045, enforced in RLS): owner/manager (effective
  // roles; co_owner counts as manager) may edit/delete any row, staff
  // only rows they created. The buttons mirror the DB rule so staff
  // never see ပြင်/ဖျက် on another staff member's record.
  const isOM = roles.includes('owner') || roles.includes('manager')
  const canEditRow = (r: EntryRow) => isOM || r.created_by === profile?.id
  const [agents, setAgents] = useState<Agent[]>([])
  const [directory, setDirectory] = useState<StaffDirectory | null>(null)
  const [rows, setRows] = useState<EntryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [rowMsg, setRowMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [deleteReason, setDeleteReason] = useState('')
  const [monthFilter, setMonthFilter] = useState(() => todayYangon().slice(0, 7))
  // Render cap only (data is fully fetched): large sets — "all" mode or a
  // busy month — would otherwise freeze the tab rendering thousands of rows.
  const [renderLimit, setRenderLimit] = useState(RENDER_PAGE_SIZE)

  // New-entry form.
  const [mode, setMode] = useState<EntryMode>('delivery')
  const [agentId, setAgentId] = useState('')
  const [delivered, setDelivered] = useState('')
  const [returned, setReturned] = useState('')
  const [cash, setCash] = useState('')
  // Whether the user manually edited the new-entry cash field in this
  // form session; while false, cash auto-fills from qty × price.
  const [cashTouched, setCashTouched] = useState(false)
  // Per-agent held bottles (agent_held_totals RPC), shown as an info line
  // and used for the non-blocking over-return warning in bottle-only mode.
  const [heldByAgent, setHeldByAgent] = useState<Map<string, number>>(new Map())
  // The selected agent's CURRENT balance (agent_outstanding RPC), shown
  // in the form and used to preview the cash split. null = not loaded
  // yet (or the RPC failed); the save path re-reads it fresh, so a
  // stale preview can never mis-store money. balanceTick forces a
  // re-read after each save (the agent stays selected across saves).
  const [agentBalance, setAgentBalance] = useState<number | null>(null)
  const [balanceTick, setBalanceTick] = useState(0)
  // Who physically received this visit's cash (0041). '' means "me" —
  // the current user is the default receiver and is sent explicitly.
  const [receivedBy, setReceivedBy] = useState('')
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

  // Same-day edit form (one row at a time). Agent is never editable
  // (enforced in UI and by entries_agent_immutable trigger in 0048).
  const [editId, setEditId] = useState<string | null>(null)
  const [eDelivered, setEDelivered] = useState('')
  const [eReturned, setEReturned] = useState('')
  const [eCash, setECash] = useState('')
  const [eReceivedBy, setEReceivedBy] = useState('')
  const [eNotes, setENotes] = useState('')
  const [eReason, setEReason] = useState('')
  // Sum of the payments the entry being edited spawned (0047 link) and the
  // agent's live balance when the editor opens, used to populate eCash with
  // the visit's full cash and show a live split preview. Saving runs
  // edit_daily_entry() atomically in Postgres, which recomputes live numbers.
  const [editLinkedSum, setEditLinkedSum] = useState(0)
  const [editAgentBalance, setEditAgentBalance] = useState<number | null>(null)

  const agentName = useMemo(() => {
    const m = new Map(agents.map((a) => [a.id, a.name]))
    return (id: string | null) => (id ? m.get(id) ?? '—' : '—')
  }, [agents])

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ag }, en, dir, heldRes] = await Promise.all([
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
      fetchStaffDirectory(),
      canWrite
        ? supabase.rpc('agent_held_totals')
        : Promise.resolve({ data: null, error: null }),
    ])
    setAgents((ag ?? []) as Agent[])
    setDirectory(dir)
    setRows(en)
    if (heldRes && !heldRes.error && Array.isArray(heldRes.data)) {
      const m = new Map<string, number>()
      for (const r of heldRes.data as { agent_id: string; held: number }[]) {
        m.set(r.agent_id, Number(r.held) || 0)
      }
      setHeldByAgent(m)
    }
    setLoading(false)
  }, [monthFilter, canWrite])

  useEffect(() => {
    load()
  }, [load])

  // Keep the selected agent's balance current for the form's info line
  // and the cash-split preview.
  useEffect(() => {
    if (!agentId) {
      setAgentBalance(null)
      return
    }
    let cancelled = false
    supabase.rpc('agent_outstanding', { p_agent: agentId }).then(({ data, error }) => {
      if (cancelled) return
      setAgentBalance(!error && typeof data === 'number' ? data : null)
    })
    return () => {
      cancelled = true
    }
  }, [agentId, balanceTick])

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

  // Receiver options for the form: active staff from the directory,
  // with the current user always present (they are the default) even
  // if the directory fetch failed.
  const receiverOptions = useMemo(() => {
    const opts = directory?.active ?? []
    if (profile && !opts.some((o) => o.id === profile.id)) {
      return [{ id: profile.id, name: personName(profile), active: true }, ...opts]
    }
    return opts
  }, [directory, profile])
  const chosenReceiverId = receivedBy || profile?.id || ''
  const chosenReceiverName =
    receiverOptions.find((o) => o.id === chosenReceiverId)?.name ??
    (profile ? personName(profile) : '—')

  // Live preview from the selected agent's price (server snapshots the same
  // price and computes the amount; this is display-only).
  const isBottleOnly = mode === 'bottle_only'
  const selectedAgent = agents.find((a) => a.id === agentId) ?? null
  const price = selectedAgent?.default_unit_price ?? 0
  const qty = Number(delivered) || 0
  const returnedQty = Number(returned) || 0
  const selectedHeld = agentId ? (heldByAgent.get(agentId) ?? null) : null
  const overReturn = isBottleOnly && isOverReturn(returnedQty, selectedHeld)
  const due = qty * price
  // Auto-fill the new-entry cash input from this visit's delivery charge
  // (qty × price, never old debt) until the user edits cash manually.
  useEffect(() => {
    setCash((prev) => syncAutoCash(prev, due, cashTouched))
  }, [due, cashTouched])
  const cashNum = Number(cash) || 0
  // How the ONE cash figure will split (lib/cashAllocation): this entry
  // first, then old debt, then overpayment. Previewed against the
  // balance loaded for the form; the save re-reads the balance fresh
  // and re-runs the same split, so the stored split uses live numbers.
  const outstandingBefore = agentBalance ?? 0
  const alloc = allocateCash(cashNum, due, outstandingBefore)
  const totalDue = due + Math.max(outstandingBefore, 0)

  // Rows arrive already scoped to the selected month (see load()).
  // visibleRows is the FULL set (summaries/counts use it); displayRows is
  // only what gets rendered, capped by renderLimit with a load-more button.
  const visibleRows = rows
  const displayRows = visibleRows.slice(0, renderLimit)

  function onAdd(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setMsg(null)
    const err = validateNewEntry({
      mode,
      agentId,
      deliveredQty: qty,
      returnedQty,
    })
    if (err) {
      setMsg(err)
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
    // In bottle-only mode delivered_qty and amount_collected are forced to 0
    // and no payments are spawned; in delivery mode the payload carries the
    // FULL cash figure for the offline queue while the online insert writes
    // toToday on the entry and spawns linked payments for the remainder.
    const payload: EntryInsert = buildEntryPayload({
      mode,
      entryDate: isOwner ? entryDate || todayYangon() : todayYangon(),
      agentId,
      deliveredQty: qty,
      returnedQty,
      cashAmount: cashNum,
      notes,
      createdBy: profile?.id ?? null,
      receivedBy: receivedBy || profile?.id || null,
    })
    // Offline right now: queue the exact payload instead of losing the form.
    if (!navigator.onLine) {
      enqueue(payload)
      afterQueued()
      return
    }

    if (isBottleOnly) {
      let failure: unknown = null
      try {
        const { error } = await supabase.from('daily_entries').insert(payload)
        failure = error
      } catch (err) {
        failure = err
      }
      if (failure) {
        if (isNetworkError(failure)) {
          enqueue(payload)
          afterQueued()
          return
        }
        setMsg(friendlyError(failure))
        setConfirming(false)
        setBusy(false)
        return
      }
      setMode('delivery')
      setDelivered('')
      setReturned('')
      setCash('')
      setCashTouched(false)
      setReceivedBy('')
      setNotes('')
      setEntryDate(todayYangon())
      setConfirming(false)
      setBalanceTick((t) => t + 1)
      await load()
      setBusy(false)
      return
    }

    // Read the agent's balance FRESH so the split is computed from live
    // numbers, not the form's possibly stale preview value. If the read
    // fails, fall back to the preview value: the agent's resulting
    // balance is exact either way (only the part labels could shift).
    let freshBefore = outstandingBefore
    try {
      const { data, error } = await supabase.rpc('agent_outstanding', {
        p_agent: agentId,
      })
      if (!error && typeof data === 'number') freshBefore = data
    } catch {
      /* keep the preview value */
    }
    const split = allocateCash(cashNum, due, freshBefore)
    let failure: unknown = null
    let newEntryId: string | null = null
    try {
      // .select('id') reads the new row's id back (the row is always
      // visible to its creator under the 0046 select policy) so the
      // spawned payments below can link to this entry (0047).
      const { data, error } = await supabase
        .from('daily_entries')
        .insert({ ...payload, amount_collected: split.toToday })
        .select('id')
        .single()
      failure = error
      if (!error) newEntryId = (data as { id: string } | null)?.id ?? null
    } catch (err) {
      failure = err
    }
    if (failure) {
      // Connection dropped mid-save: queue the FULL-cash payload, same
      // as the offline path — nothing was stored, so nothing is lost.
      if (isNetworkError(failure)) {
        enqueue(payload)
        afterQueued()
        return
      }
      setMsg(friendlyError(failure))
      setConfirming(false)
      setBusy(false)
      return
    }
    // Entry saved. The rest of the visit's cash lands as linked payment
    // rows for the same agent and day: the old-debt part as kind
    // 'old_debt', any overpayment as kind 'regular'. Both carry
    // source_entry_id (0047), so deleting the entry cascades them away
    // and editing the entry can find and rewrite them. They are real
    // agent_payments rows, so the usual payment notifications fire for
    // them exactly as they did for the old flow's spawned row. If one
    // of these writes fails, say so plainly (entry kept, that part
    // missing) in the AgentsPage partial-failure style instead of
    // pretending a full success.
    const spawns: { amount: number; kind: 'old_debt' | 'regular'; notes: string; label: string }[] = []
    if (split.toOld > 0) {
      spawns.push({
        amount: split.toOld,
        kind: 'old_debt',
        notes: 'ရေပို့မှတ်တမ်းနှင့်အတူ ပေးချေသည်',
        label: 'ကြွေးကောက်ငွေ',
      })
    }
    if (split.advance > 0) {
      spawns.push({
        amount: split.advance,
        kind: 'regular',
        notes: 'ရေပို့မှတ်တမ်းနှင့်အတူ ပိုပေးငွေ',
        label: 'ပိုပေးငွေ',
      })
    }
    let partialMsg: string | null = null
    for (const s of spawns) {
      let pFailure: unknown = null
      try {
        const { error } = await supabase.from('agent_payments').insert({
          payment_date: payload.entry_date,
          agent_id: agentId,
          agent_name: selectedAgent?.name ?? null,
          amount: s.amount,
          method: 'cash',
          kind: s.kind,
          notes: s.notes,
          created_by: profile?.id ?? null,
          // Same visit, same hands: this cash was received by the same
          // person as the entry's own cash.
          received_by: receivedBy || profile?.id || null,
          source_entry_id: newEntryId,
        })
        pFailure = error
      } catch (err) {
        pFailure = err
      }
      if (pFailure) {
        partialMsg = `ရေပို့မှတ်တမ် သိမ်းပြီးပါပြီ၊ ${s.label} သိမ်း၍ မရပါ: ${friendlyError(pFailure)}`
        break
      }
    }
    setMode('delivery')
    setDelivered('')
    setReturned('')
    setCash('')
    setCashTouched(false)
    setReceivedBy('')
    setNotes('')
    setEntryDate(todayYangon())
    setConfirming(false)
    setBalanceTick((t) => t + 1)
    await load()
    if (partialMsg) setMsg(partialMsg)
    setBusy(false)
  }

  // Shared tail for "saved to the offline queue": clear the form and tell
  // the user it will upload itself when the connection returns. The
  // queued payload carries the visit's FULL cash as the entry's
  // amount_collected (the queue holds entry payloads only and never
  // spawns payments), so a replayed entry keeps the whole amount on the
  // entry itself — the agent's balance stays exact, just unsplit.
  function afterQueued() {
    setMode('delivery')
    setDelivered('')
    setReturned('')
    setCash('')
    setCashTouched(false)
    setReceivedBy('')
    setNotes('')
    setEntryDate(todayYangon())
    setConfirming(false)
    setQueued(queueCount())
    setMsg('အင်တာနက် မရှိသေးလို့ သိမ်းထားပါတယ် — ပြန်ချိတ်ရင် အလိုအလျောက် တင်ပေးပါမယ်')
    setBusy(false)
  }

  async function startEdit(row: EntryRow) {
    setConfirmId(null)
    setDeleteReason('')
    setMsg(null)
    setRowMsg(null)
    // Bottle-only rows carry zero money and never have linked payments;
    // edit returned_qty / received_by / notes only.
    if (isBottleOnlyEntry(row)) {
      setEditLinkedSum(0)
      setEditAgentBalance(null)
      setEditId(row.id)
      setEDelivered('0')
      setEReturned(String(row.returned_qty))
      setECash('0')
      setEReceivedBy(row.received_by ?? row.created_by ?? profile?.id ?? '')
      setENotes(row.notes ?? '')
      setEReason('')
      return
    }
    // The edit cash field must show ALL the cash of the visit: the
    // entry's own amount_collected plus the payments it spawned (0047
    // link). Without the linked sum, saving would silently shrink the
    // visit's cash to the entry part alone — so if the linked rows
    // cannot be read, the editor does not open at all.
    let linkedSum = 0
    let liveBalance: number | null = null
    if (row.agent_id) {
      const [{ data, error }, { data: bal, error: balErr }] = await Promise.all([
        supabase
          .from('agent_payments')
          .select('amount')
          .eq('source_entry_id', row.id),
        supabase.rpc('agent_outstanding', { p_agent: row.agent_id }),
      ])
      if (error) {
        setMsg(friendlyError(error))
        return
      }
      linkedSum = (data ?? []).reduce((s, p) => s + Number(p.amount), 0)
      if (!balErr && typeof bal === 'number') liveBalance = bal
    }
    setEditLinkedSum(linkedSum)
    setEditAgentBalance(liveBalance)
    setEditId(row.id)
    setEDelivered(String(row.delivered_qty))
    setEReturned(String(row.returned_qty))
    setECash(String(row.amount_collected + linkedSum))
    setEReceivedBy(row.received_by ?? row.created_by ?? profile?.id ?? '')
    setENotes(row.notes ?? '')
    setEReason('')
  }

  async function saveEdit(row: EntryRow) {
    if (busy) return
    const bottleOnly = isBottleOnlyEntry(row)
    const reason = eReason.trim()
    const newQty = bottleOnly ? 0 : Number(eDelivered) || 0
    const newReturned = Number(eReturned) || 0
    const newCash = bottleOnly ? 0 : Number(eCash) || 0
    const err = validateEditEntry({
      isBottleOnly: bottleOnly,
      deliveredQty: newQty,
      returnedQty: newReturned,
      reason,
    })
    if (err) {
      setRowMsg(err)
      return
    }
    setBusy(true)
    setRowMsg(null)
    // Atomic server-side update (migration 0048 / 0049): enforces Rule A,
    // same-day guard, month lock, immutable agent_id and entry type,
    // unit_price snapshot, deposit/credit limits, and linked-payment
    // reallocation in a single Postgres transaction.
    const { error } = await supabase.rpc('edit_daily_entry', {
      p_entry_id: row.id,
      p_delivered_qty: newQty,
      p_returned_qty: newReturned,
      p_total_cash: newCash,
      p_received_by: eReceivedBy || null,
      p_notes: eNotes.trim() || null,
      p_change_reason: reason,
    })
    if (error) {
      setRowMsg(friendlyError(error))
      setBusy(false)
      return
    }
    setEditId(null)
    setEditLinkedSum(0)
    setEditAgentBalance(null)
    setRowMsg(null)
    setBalanceTick((t) => t + 1)
    await load()
    setBusy(false)
  }

  async function onDelete(row: EntryRow) {
    if (busy) return
    const reason = deleteReason.trim()
    if (reason.length < 2) {
      setRowMsg('ဖျက်ရသည့် အကြောင်းအရင်း (အနည်းဆုံး ၂ လုံး) ရေးပါ')
      return
    }
    setBusy(true)
    setRowMsg(null)
    // Stamp the reason first so the audit before-image of the delete
    // carries why the row was removed.
    const { error: stampError } = await supabase
      .from('daily_entries')
      .update({ change_reason: reason })
      .eq('id', row.id)
    if (stampError) {
      setRowMsg(friendlyError(stampError))
      setBusy(false)
      return
    }
    const { error } = await supabase.from('daily_entries').delete().eq('id', row.id)
    if (error) {
      setRowMsg(friendlyError(error))
      setBusy(false)
      return
    }
    setConfirmId(null)
    setDeleteReason('')
    setRowMsg(null)
    setBalanceTick((t) => t + 1)
    await load()
    setBusy(false)
  }

  // --- Row pieces shared by the card list (phone/tablet) and the table
  // (desktop). Plain render functions (not components) so the edit inputs
  // keep focus across re-renders. -------------------------------------------

  function rowButtons(r: EntryRow) {
    if (!canWrite || !canEditRow(r) || !isTodayYangon(r.created_at) || editId === r.id || confirmId === r.id) {
      return null
    }
    return (
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => startEdit(r)}
          className="inline-flex min-h-[40px] items-center rounded-lg bg-brand-50 px-3.5 font-medium text-brand-700 transition active:scale-[0.98] dark:bg-brand-950/50 dark:text-brand-300"
        >
          ပြင်ရန်
        </button>
        <button
          type="button"
          onClick={() => {
            setEditId(null)
            setConfirmId(r.id)
            setDeleteReason('')
            setRowMsg(null)
          }}
          className="inline-flex min-h-[40px] items-center rounded-lg bg-red-50 px-3.5 font-medium text-red-600 transition active:scale-[0.98] dark:bg-red-950/40 dark:text-red-400"
        >
          ဖျက်ရန်
        </button>
      </div>
    )
  }

  function rowPanel(r: EntryRow) {
    if (!canWrite || !canEditRow(r) || !isTodayYangon(r.created_at)) return null
    if (confirmId === r.id) {
      return (
        <div className="space-y-2 rounded-xl border border-red-200 bg-red-50/60 p-3 dark:border-red-900 dark:bg-red-950/20">
          <input
            value={deleteReason}
            onChange={(e) => setDeleteReason(e.target.value)}
            placeholder="ဖျက်ရသည့် အကြောင်းအရင်း (လိုအပ်)"
            className={inputCls}
          />
          {rowMsg && (
            <p className="text-sm text-red-600" role="alert">
              {rowMsg}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <DangerButton size="sm" onClick={() => onDelete(r)} disabled={busy}>
              သေချာပါတယ်, ဖျက်မည်
            </DangerButton>
            <SecondaryButton
              size="sm"
              onClick={() => {
                setConfirmId(null)
                setDeleteReason('')
                setRowMsg(null)
              }}
            >
              မဖျက်တော့ပါ
            </SecondaryButton>
          </div>
        </div>
      )
    }
    if (editId === r.id) {
      const bottleOnlyEdit = isBottleOnlyEntry(r)
      // Preserve the row's current receiver in the dropdown even if that
      // staff member was deactivated after recording this entry.
      const editReceiverOptions =
        eReceivedBy && !receiverOptions.some((o) => o.id === eReceivedBy)
          ? [
              ...receiverOptions,
              {
                id: eReceivedBy,
                name: directory?.nameOf.get(eReceivedBy) ?? '—',
                active: false,
              },
            ]
          : receiverOptions
      const eQtyNum = Number(eDelivered) || 0
      const eCashNum = Number(eCash) || 0
      const eNewAmount = eQtyNum * r.unit_price
      const editBase =
        !bottleOnlyEdit && editAgentBalance !== null
          ? editBaseOutstanding(
              editAgentBalance,
              r.amount,
              r.amount_collected,
              editLinkedSum,
            )
          : null
      const editAlloc =
        editBase !== null ? allocateCash(eCashNum, eNewAmount, editBase) : null

      return (
        <div className="space-y-2.5 rounded-xl border border-stone-200 bg-stone-50/70 p-3.5 dark:border-neutral-800 dark:bg-neutral-800/40">
          <div className="flex flex-wrap items-baseline justify-between gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">မှတ်တမ်း ပြင်ရန်</span>
              {bottleOnlyEdit && (
                <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                  ဗူးခွံသီးသန့် ပြန်ယူ
                </span>
              )}
            </div>
            <div className="text-xs text-stone-500 dark:text-neutral-400">
              ကိုယ်စားလှယ်: {r.agent_name ?? agentName(r.agent_id)} (ပြောင်း၍ မရပါ)
            </div>
          </div>
          <Field label="လက်ခံသူ">
            <select
              value={eReceivedBy}
              onChange={(e) => setEReceivedBy(e.target.value)}
              className={inputCls}
            >
              {editReceiverOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          {bottleOnlyEdit ? (
            <Field label="ပြန်အပ်သည့် ဗူး">
              <input
                value={eReturned}
                onChange={(e) => setEReturned(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
          ) : (
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
              <Field label="ဈေးနှုန်း (၁ ဗူး)">
                <div className="flex min-h-[48px] items-center rounded-xl border border-stone-200 bg-white px-3.5 font-medium tabular-nums dark:border-neutral-700 dark:bg-neutral-900/60">
                  {formatMMK(r.unit_price)}
                </div>
              </Field>
            </div>
          )}
          {!bottleOnlyEdit && eQtyNum > 0 && editAlloc && (
            <div className="space-y-0.5 rounded-xl bg-brand-50 px-3 py-2 text-xs dark:bg-brand-950/40">
              <div>
                ဒီနေ့ ရေဖိုး: {formatMMK(eNewAmount)} · လက်ခံရရှိငွေ: {formatMMK(eCashNum)}
              </div>
              {editAlloc.toOld > 0 && (
                <div>ကြွေးဟောင်း {formatMMK(editAlloc.toOld)} ရှင်းပါမယ်</div>
              )}
              {editAlloc.advance > 0 && (
                <div>ပိုပေးငွေ {formatMMK(editAlloc.advance)} ကျန်ပါမယ်</div>
              )}
              <div
                className={`font-semibold ${
                  editAlloc.resultingBalance > 0 ? 'text-red-600 dark:text-red-400' : ''
                }`}
              >
                {editAlloc.resultingBalance > 0
                  ? `သိမ်းပြီးရင်: ကျန်ပေးရန် ${formatMMK(editAlloc.resultingBalance)} ကျန်ပါမယ်`
                  : editAlloc.resultingBalance < 0
                    ? `သိမ်းပြီးရင်: ပိုပေးထားငွေ ${formatMMK(-editAlloc.resultingBalance)} ဖြစ်ပါမယ်`
                    : 'သိမ်းပြီးရင်: အားလုံး ရှင်းပြီးပါပြီ'}
              </div>
            </div>
          )}
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
          {rowMsg && (
            <p className="text-sm text-red-600" role="alert">
              {rowMsg}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <PrimaryButton size="sm" onClick={() => saveEdit(r)} disabled={busy}>
              သိမ်းမည်
            </PrimaryButton>
            <SecondaryButton
              size="sm"
              onClick={() => {
                setEditId(null)
                setEditLinkedSum(0)
                setEditAgentBalance(null)
                setRowMsg(null)
              }}
            >
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
        subtitle={
          isAgent
            ? 'ပို့ဘူး၊ ပြန်အပ်ဘူးနှင့် ပေးချေငွေ မှတ်တမ်းများ'
            : 'ပို့ဘူး၊ ပြန်အပ်ဘူးနှင့် လက်ခံငွေ နေ့စဉ် မှတ်ရန်'
        }
      />

      {canWrite && queued > 0 && (
        <Banner
          tone="amber"
          action={
            <PrimaryButton
              size="sm"
              disabled={flushing}
              onClick={async () => {
                const err = await flushQueue()
                if (err) setMsg(friendlyError(err))
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

      {canWrite && droppedStale > 0 && (
        <Banner tone="red">
          ⚠️ ရက်ကျော်သွားလို့ တင်လို့ မရတော့သော မှတ်တမ်း {droppedStale} ခု ရှိပါတယ် — စီမံသူကို အကြောင်းကြားပါ
        </Banner>
      )}

      {canWrite && (
        <form onSubmit={onAdd} className={`${cardCls} space-y-3 p-4 lg:p-5`}>
          <div className="text-base font-semibold">{isOwner ? 'မှတ်တမ်အသစ်' : 'ယနေ့ မှတ်တမ်အသစ်'}</div>
          <div
            role="group"
            aria-label="အမျိုးအစား"
            className="grid grid-cols-2 gap-1.5 rounded-xl bg-stone-100 p-1 dark:bg-neutral-800/80"
          >
            <button
              type="button"
              aria-pressed={!isBottleOnly}
              onClick={() => {
                setMode('delivery')
                setConfirming(false)
                setMsg(null)
              }}
              className={`min-h-[44px] rounded-lg px-3 py-2 text-sm font-semibold transition ${
                !isBottleOnly
                  ? 'bg-white text-brand-700 shadow-sm dark:bg-neutral-900 dark:text-brand-300'
                  : 'text-stone-600 hover:text-stone-900 dark:text-neutral-300 dark:hover:text-white'
              }`}
            >
              ရေပို့ + ဗူးခွံယူ
            </button>
            <button
              type="button"
              aria-pressed={isBottleOnly}
              onClick={() => {
                setMode('bottle_only')
                setConfirming(false)
                setMsg(null)
              }}
              className={`min-h-[44px] rounded-lg px-3 py-2 text-sm font-semibold transition ${
                isBottleOnly
                  ? 'bg-white text-brand-700 shadow-sm dark:bg-neutral-900 dark:text-brand-300'
                  : 'text-stone-600 hover:text-stone-900 dark:text-neutral-300 dark:hover:text-white'
              }`}
            >
              ဗူးခွံသီးသန့် ပြန်ယူ
            </button>
          </div>
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
                const nextAgentId = e.target.value
                setAgentId(nextAgentId)
                if (nextAgentId !== agentId) {
                  const nextPrice =
                    agents.find((a) => a.id === nextAgentId)?.default_unit_price ?? 0
                  setCashTouched(false)
                  setCash((prev) => syncAutoCash(prev, qty * nextPrice, false))
                }
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
            {isBottleOnly && selectedHeld !== null && (
              <span className="mt-1 block text-xs font-medium text-stone-600 dark:text-neutral-300">
                လက်ရှိ ကိုင်ထားဗူး: {selectedHeld.toLocaleString('en-US')} ဗူး
              </span>
            )}
            {!isBottleOnly && agentBalance !== null && agentBalance > 0 && (
              <span className="mt-1 block text-xs font-medium text-red-600 dark:text-red-400">
                ကြွေးဟောင်း: {formatMMK(agentBalance)} ရှိပါတယ်
              </span>
            )}
            {!isBottleOnly && agentBalance !== null && agentBalance < 0 && (
              <span className="mt-1 block text-xs font-medium">
                ပိုပေးထားငွေ: {formatMMK(-agentBalance)} ရှိပါတယ်
              </span>
            )}
          </Field>
          <Field label="လက်ခံသူ">
            <select
              value={chosenReceiverId}
              onChange={(e) => {
                setReceivedBy(e.target.value)
                setConfirming(false)
              }}
              className={inputCls}
            >
              {receiverOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          {isBottleOnly ? (
            <>
              <Field label="ပြန်အပ်သည့် ဗူး">
                <input
                  value={returned}
                  onChange={(e) => {
                    setReturned(e.target.value.replace(/\D/g, ''))
                    setConfirming(false)
                  }}
                  inputMode="numeric"
                  required
                  className={inputCls}
                />
              </Field>
              {overReturn && selectedHeld !== null && (
                <p
                  className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                  role="status"
                >
                  သတိ: လက်ရှိ ကိုင်ထားဗူး ({selectedHeld.toLocaleString('en-US')} ဗူး) ထက်
                  ပိုနေပါတယ် — ဆက်သိမ်းနိုင်ပါတယ်
                </p>
              )}
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="ပို့သည့် ဗူး">
                <input
                  value={delivered}
                  onChange={(e) => {
                    const nextDelivered = e.target.value.replace(/\D/g, '')
                    const nextQty = Number(nextDelivered) || 0
                    setDelivered(nextDelivered)
                    setCash((prev) => syncAutoCash(prev, nextQty * price, cashTouched))
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
                    setCashTouched(true)
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
          )}
          <input
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value)
              setConfirming(false)
            }}
            placeholder="မှတ်ချက် (ရှိလျှင်)"
            className={inputCls}
          />
          {!isBottleOnly && qty > 0 && (
            <p className="rounded-xl bg-brand-50 px-3.5 py-2.5 text-sm dark:bg-brand-950/40">
              ပေးရန် စုစုပေါင်း: {formatMMK(totalDue)} · လက်ခံရရှိငွေ: {formatMMK(cashNum)}
              {agentBalance !== null && (
                <>
                  {' · '}
                  {alloc.resultingBalance > 0
                    ? `ကျန်ပေးရန် ${formatMMK(alloc.resultingBalance)} ကျန်ပါမယ်`
                    : alloc.resultingBalance < 0
                      ? `ပိုပေးထားငွေ ${formatMMK(-alloc.resultingBalance)} ဖြစ်ပါမယ်`
                      : 'အားလုံး ရှင်းပြီးပါပြီ'}
                </>
              )}
            </p>
          )}
          {msg && (
            <p className="text-sm text-red-600" role="alert">
              {msg}
            </p>
          )}
          {!confirming && (
            <div className="max-md:sticky max-md:bottom-[calc(5.75rem_+_env(safe-area-inset-bottom))] max-md:z-10 max-md:-mx-4 max-md:border-t max-md:border-stone-200/90 max-md:bg-white/95 max-md:px-4 max-md:py-2.5 max-md:backdrop-blur dark:max-md:border-neutral-800 dark:max-md:bg-neutral-900/95">
              <PrimaryButton type="submit" disabled={busy} className="w-full">
                သိမ်းရန်
              </PrimaryButton>
            </div>
          )}
          {confirming && selectedAgent && (
            <div className="space-y-1.5 rounded-2xl border-2 border-accent-400 bg-accent-50 p-4 text-sm dark:border-accent-700 dark:bg-amber-950/30">
              <div className="text-base font-bold">သိမ်းမည့် အချက်အလက် စစ်ဆေးပါ</div>
              {isBottleOnly ? (
                <>
                  <dl className="space-y-1">
                    {isOwner && (
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="opacity-70">ရက်စွဲ</dt>
                        <dd className="font-medium tabular-nums">{entryDate}</dd>
                      </div>
                    )}
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="opacity-70">အမျိုးအစား</dt>
                      <dd className="font-semibold">ဗူးခွံသီးသန့် ပြန်ယူ</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="opacity-70">ကိုယ်စားလှယ်</dt>
                      <dd className="font-semibold">{selectedAgent.name}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="opacity-70">ပြန်အပ်သည့် ဗူး</dt>
                      <dd className="font-bold tabular-nums">ပြန်အပ် {returnedQty} ဗူး</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="opacity-70">လက်ခံသူ</dt>
                      <dd className="font-medium">{chosenReceiverName}</dd>
                    </div>
                  </dl>
                  {overReturn && selectedHeld !== null && (
                    <p className="font-medium text-amber-800 dark:text-amber-200">
                      သတိ: လက်ရှိ ကိုင်ထားဗူး ({selectedHeld.toLocaleString('en-US')} ဗူး) ထက်
                      ပိုနေပါတယ် — ဆက်သိမ်းနိုင်ပါတယ်
                    </p>
                  )}
                </>
              ) : (
                <>
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
                      <dt className="opacity-70">လက်ခံသူ</dt>
                      <dd className="font-medium">{chosenReceiverName}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="opacity-70">ပို့သည့် ဗူး</dt>
                      <dd className="font-medium tabular-nums">{qty} ဗူး</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="opacity-70">ပြန်အပ်သည့် ဗူး</dt>
                      <dd className="font-medium tabular-nums">{returnedQty} ဗူး</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="opacity-70">ဈေးနှုန်း (၁ ဗူး)</dt>
                      <dd className="font-medium tabular-nums">{formatMMK(price)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="opacity-70">
                        {outstandingBefore > 0
                          ? 'ပေးရန် စုစုပေါင်း (ဒီနေ့ ရေဖိုး + ကြွေးဟောင်း)'
                          : 'ပေးရန် စုစုပေါင်း'}
                      </dt>
                      <dd className="font-bold tabular-nums">{formatMMK(totalDue)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="opacity-70">လက်ခံရရှိငွေ (ကျပ်)</dt>
                      <dd className="font-medium tabular-nums">{formatMMK(cashNum)}</dd>
                    </div>
                  </dl>
                  {/* The split, in plain sentences: how the one cash figure
                      settles today / old debt / overpayment, and the balance
                      the agent is left with. Only parts that occur are shown. */}
                  {alloc.toToday > 0 && (
                    <p>ဒီနေ့ ရေဖိုး {formatMMK(alloc.toToday)} ရှင်းပါမယ်</p>
                  )}
                  {alloc.toOld > 0 && (
                    <p>ကြွေးဟောင်း {formatMMK(alloc.toOld)} ရှင်းပါမယ်</p>
                  )}
                  {alloc.advance > 0 && (
                    <p>ပိုပေးငွေ {formatMMK(alloc.advance)} ကျန်ပါမယ်</p>
                  )}
                  <p
                    className={`font-bold ${
                      alloc.resultingBalance > 0 ? 'text-red-600 dark:text-red-400' : ''
                    }`}
                  >
                    {alloc.resultingBalance > 0
                      ? `ကျန်ပေးရန် ${formatMMK(alloc.resultingBalance)} ကျန်ပါမယ်`
                      : alloc.resultingBalance < 0
                        ? `ပိုပေးထားငွေ ${formatMMK(-alloc.resultingBalance)} ဖြစ်ပါမယ်`
                        : 'အားလုံး ရှင်းပြီးပါပြီ'}
                  </p>
                  {cashNum === 0 && totalDue > 0 && (
                    <p className="font-semibold text-red-600">
                      သတိ: ငွေ လုံးဝ မကောက်ရသေးပါ — {formatMMK(totalDue)} အပြည့် ကြွေး အဖြစ်
                      ကျန်ပါမည်
                    </p>
                  )}
                </>
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
            {displayRows.map((r) => {
              const bottleOnlyRow = isBottleOnlyEntry(r)
              const rec = directory ? receiverName(directory, r) : null
              return (
                <li key={r.id} className={`${cardCls} p-3.5`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold">{r.agent_name ?? agentName(r.agent_id)}</div>
                    {bottleOnlyRow ? (
                      <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                        ဗူးခွံသီးသန့် ပြန်ယူ
                      </span>
                    ) : (
                      <div className="font-bold tabular-nums">{formatMMK(r.amount)}</div>
                    )}
                  </div>
                  {bottleOnlyRow ? (
                    <div className="mt-0.5 text-sm text-stone-500 dark:text-neutral-400">
                      {r.entry_date} · ပြန်အပ် {r.returned_qty} ဗူး
                      {r.notes ? ` · ${r.notes}` : ''}
                    </div>
                  ) : (
                    <>
                      <div className="mt-0.5 text-sm text-stone-500 dark:text-neutral-400">
                        {r.entry_date} · ပို့ {r.delivered_qty} · ပြန် {r.returned_qty} ·{' '}
                        {formatMMK(r.unit_price)}/ဗူး
                        {r.notes ? ` · ${r.notes}` : ''}
                      </div>
                      <div className="text-sm text-stone-500 dark:text-neutral-400">
                        {isAgent ? 'ပေးချေပြီး' : 'လက်ခံရရှိငွေ'} {formatMMK(r.amount_collected)} · ကျန်ပေးရန်{' '}
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
                    </>
                  )}
                  {/* Receiver name: staff-plus viewers always see who received/
                      recorded the entry; agents see it for bottle-only returns
                      and whenever cash was collected. */}
                  {rec && (!isAgent || r.amount_collected > 0 || bottleOnlyRow) && (
                    <div className="text-sm text-stone-500 dark:text-neutral-400">
                      လက်ခံသူ: {rec}
                    </div>
                  )}
                  <div className="mt-2.5 empty:hidden">{rowButtons(r)}</div>
                  <div className="mt-2.5 empty:hidden">{rowPanel(r)}</div>
                </li>
              )
            })}
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
                  <th className={`${thCls} text-right`}>{isAgent ? 'ပေးချေပြီး (ကျပ်)' : 'လက်ခံရရှိငွေ (ကျပ်)'}</th>
                  <th className={`${thCls} text-right`}>ကျန်ပေးရန်</th>
                  <th className={`${thCls} pr-4`}>
                    <span className="sr-only">လုပ်ဆောင်ချက်</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r) => {
                  const panel = rowPanel(r)
                  const bottleOnlyRow = isBottleOnlyEntry(r)
                  const rec = directory ? receiverName(directory, r) : null
                  return (
                    <Fragment key={r.id}>
                      <tr className="border-b border-stone-100 align-top last:border-0 dark:border-neutral-800/70">
                        <td className="px-3 py-3 pl-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium">{r.agent_name ?? agentName(r.agent_id)}</span>
                            {bottleOnlyRow && (
                              <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                                ဗူးခွံသီးသန့် ပြန်ယူ
                              </span>
                            )}
                          </div>
                          {r.notes && <div className="text-xs opacity-60">{r.notes}</div>}
                        </td>
                        <td className={`${tdCls} whitespace-nowrap`}>{r.entry_date}</td>
                        <td className={`${tdCls} text-right`}>
                          {bottleOnlyRow ? '—' : r.delivered_qty}
                        </td>
                        <td className={`${tdCls} text-right`}>
                          {bottleOnlyRow ? `ပြန်အပ် ${r.returned_qty} ဗူး` : r.returned_qty}
                        </td>
                        <td className={`${tdCls} text-right`}>
                          {bottleOnlyRow ? '—' : formatMMK(r.unit_price)}
                        </td>
                        <td className={`${tdCls} text-right font-semibold`}>
                          {bottleOnlyRow ? '—' : formatMMK(r.amount)}
                        </td>
                        <td className={`${tdCls} text-right`}>
                          {bottleOnlyRow ? '—' : formatMMK(r.amount_collected)}
                          {/* Same receiver-name rule as the card list:
                              always for staff-plus, agents for bottle-only
                              returns and whenever cash was collected. */}
                          {rec && (!isAgent || r.amount_collected > 0 || bottleOnlyRow) && (
                            <div className="text-xs font-normal opacity-60">
                              လက်ခံသူ: {rec}
                            </div>
                          )}
                        </td>
                        <td
                          className={`${tdCls} text-right ${
                            !bottleOnlyRow && r.amount - r.amount_collected > 0
                              ? 'font-semibold text-red-600 dark:text-red-400'
                              : ''
                          }`}
                        >
                          {bottleOnlyRow ? '—' : formatMMK(r.amount - r.amount_collected)}
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
