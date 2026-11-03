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

/** Month filter options: "all" + current month and the 12 before it. */
function monthOptions(): { value: string; label: string }[] {
  const [y, m] = todayYangon().split('-').map(Number)
  const out: { value: string; label: string }[] = [{ value: 'all', label: 'အားလုံး' }]
  let yy = y
  let mm = m
  for (let i = 0; i < 13; i++) {
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

  // New-entry form.
  const [agentId, setAgentId] = useState('')
  const [delivered, setDelivered] = useState('')
  const [returned, setReturned] = useState('')
  const [cash, setCash] = useState('')
  const [notes, setNotes] = useState('')
  const [confirming, setConfirming] = useState(false)

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
    const [{ data: ag }, { data: en }] = await Promise.all([
      supabase.from('agents').select('*').order('created_at'),
      supabase
        .from('daily_entries')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100),
    ])
    setAgents((ag ?? []) as Agent[])
    setRows((en ?? []) as EntryRow[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Live preview from the selected agent's price (server snapshots the same
  // price and computes the amount; this is display-only).
  const selectedAgent = agents.find((a) => a.id === agentId) ?? null
  const price = selectedAgent?.default_unit_price ?? 0
  const qty = Number(delivered) || 0
  const due = qty * price
  const cashNum = Number(cash) || 0
  const remaining = due - cashNum

  const visibleRows = useMemo(
    () =>
      monthFilter === 'all'
        ? rows
        : rows.filter((r) => r.entry_date.startsWith(monthFilter)),
    [rows, monthFilter],
  )

  function onAdd(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setMsg(null)
    if (!agentId) {
      setMsg('ကိုယ်စားလှယ် ရွေးပါ')
      return
    }
    if (qty <= 0) {
      setMsg('ပို့သည့် ပုလင်း အရေအတွက် ထည့်ပါ')
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
    const { error } = await supabase.from('daily_entries').insert({
      entry_date: todayYangon(),
      agent_id: agentId,
      delivered_qty: qty,
      returned_qty: Number(returned) || 0,
      amount_collected: cashNum,
      notes: notes.trim() || null,
      created_by: profile?.id ?? null,
    })
    if (error) {
      setMsg(error.message)
      setConfirming(false)
      setBusy(false)
      return
    }
    setDelivered('')
    setReturned('')
    setCash('')
    setNotes('')
    setConfirming(false)
    await load()
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
      setMsg('ပို့သည့် ပုလင်း အရေအတွက် ထည့်ပါ')
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

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">ပို့ဆောင်မှု မှတ်တမ်းများ</h1>

      {canWrite && (
        <form onSubmit={onAdd} className="space-y-2 rounded-2xl border p-4">
          <div className="font-semibold">ယနေ့ မှတ်တမ်အသစ်</div>
          <select
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value)
              setConfirming(false)
            }}
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
              ပို့သည့် ပုလင်း
              <input
                value={delivered}
                onChange={(e) => {
                  setDelivered(e.target.value.replace(/\D/g, ''))
                  setConfirming(false)
                }}
                inputMode="numeric"
                required
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
            <label className="text-sm">
              ပြန်အပ်သည့် ပုလင်း
              <input
                value={returned}
                onChange={(e) => {
                  setReturned(e.target.value.replace(/\D/g, ''))
                  setConfirming(false)
                }}
                inputMode="numeric"
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
            <label className="text-sm">
              လက်ခံရရှိငွေ (ကျပ်)
              <input
                value={cash}
                onChange={(e) => {
                  setCash(e.target.value.replace(/\D/g, ''))
                  setConfirming(false)
                }}
                inputMode="numeric"
                placeholder="0"
                className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
              />
            </label>
            <label className="text-sm">
              ဈေးနှုန်း (၁ လုံး)
              <div className="mt-1 rounded-xl border px-3 py-2 opacity-75">
                {selectedAgent ? formatMMK(price) : '—'}
              </div>
            </label>
          </div>
          <input
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value)
              setConfirming(false)
            }}
            placeholder="မှတ်ချက် (ရှိလျှင်)"
            className="w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
          />
          {qty > 0 && (
            <p className="text-sm opacity-80">
              ပေးရန် စုစုပေါင်း: {formatMMK(due)} · လက်ခံရရှိငွေ: {formatMMK(cashNum)} ·
              ကျန်ကြွေး: {formatMMK(remaining)}
            </p>
          )}
          {msg && <p className="text-sm text-red-600">{msg}</p>}
          {!confirming && (
            <button disabled={busy} className="w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white disabled:opacity-50">
              သိမ်းရန်
            </button>
          )}
          {confirming && selectedAgent && (
            <div className="space-y-1 rounded-xl border border-amber-400 bg-amber-50 p-3 text-sm dark:bg-neutral-900">
              <div className="font-semibold">သိမ်းမည့် အချက်အလက် စစ်ဆေးပါ</div>
              <div>ကိုယ်စားလှယ်: {selectedAgent.name}</div>
              <div>
                ပို့သည့် ပုလင်း: {qty} လုံး · ပြန်အပ်သည့် ပုလင်း: {Number(returned) || 0} လုံး
              </div>
              <div>ဈေးနှုန်း: {formatMMK(price)}/လုံး</div>
              <div>ပေးရန် စုစုပေါင်း: {formatMMK(due)}</div>
              <div>လက်ခံရရှိငွေ: {formatMMK(cashNum)}</div>
              <div>ကျန်ကြွေး: {formatMMK(remaining)}</div>
              {cashNum === 0 && due > 0 && (
                <p className="font-semibold text-red-600">
                  သတိ: ငွေ လုံးဝ မကောက်ရသေးပါ — {formatMMK(due)} အပြည့် ကြွေး အဖြစ်
                  ကျန်ပါမည်
                </p>
              )}
              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={doInsert}
                  className="rounded-xl bg-teal-700 px-4 py-2 font-semibold text-white disabled:opacity-50"
                >
                  အတည်ပြု သိမ်းမည်
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="py-2 opacity-70"
                >
                  ပြန်ပြင်မည်
                </button>
              </div>
            </div>
          )}
          <p className="text-xs opacity-60">
            ပြင်/ဖျက် လုပ်ခွင့်က ထည့်သွင်းသည့် နေ့ တစ်နေ့တည်းသာ ရပါမယ် (ပိုင်ရှင် အပါအဝင် အားလုံး)။
          </p>
        </form>
      )}

      <div className="flex items-center gap-2">
        <label className="text-sm">လ အလိုက် ကြည့်ရန်</label>
        <select
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          className="rounded-xl border px-3 py-2 dark:bg-neutral-900"
        >
          {monthOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p>ခဏစောင့်ပါ…</p>
      ) : (
        <ul className="divide-y rounded-2xl border">
          {visibleRows.map((r) => (
            <li key={r.id} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">{r.agent_name ?? agentName(r.agent_id)}</div>
                <div className="text-sm font-semibold">{formatMMK(r.amount)}</div>
              </div>
              <div className="text-sm opacity-75">
                {r.entry_date} · ပို့ {r.delivered_qty} · ပြန် {r.returned_qty} ·{' '}
                {formatMMK(r.unit_price)}/လုံး
                {r.notes ? ` · ${r.notes}` : ''}
              </div>
              <div className="text-sm opacity-75">
                လက်ခံရရှိငွေ {formatMMK(r.amount_collected)} · ကျန်ပေးရန်{' '}
                {formatMMK(r.amount - r.amount_collected)}
              </div>
              {canWrite && isTodayYangon(r.created_at) && editId !== r.id &&
                (confirmId === r.id ? (
                  <div className="mt-2 space-y-2">
                    <input
                      value={deleteReason}
                      onChange={(e) => setDeleteReason(e.target.value)}
                      placeholder="ဖျက်ရသည့် အကြောင်းအရင်း (လိုအပ်)"
                      className="w-full rounded-xl border px-3 py-2 text-sm dark:bg-neutral-900"
                    />
                    <span className="flex gap-3 text-sm">
                      <button onClick={() => onDelete(r)} className="font-semibold text-red-600">
                        သေချာပါတယ်, ဖျက်မည်
                      </button>
                      <button
                        onClick={() => {
                          setConfirmId(null)
                          setDeleteReason('')
                        }}
                        className="opacity-70"
                      >
                        မဖျက်တော့ပါ
                      </button>
                    </span>
                  </div>
                ) : (
                  <div className="mt-1 flex gap-4 text-sm">
                    <button onClick={() => startEdit(r)} className="text-teal-700">
                      ပြင်ရန်
                    </button>
                    <button
                      onClick={() => {
                        setConfirmId(r.id)
                        setDeleteReason('')
                      }}
                      className="text-red-600"
                    >
                      ဖျက်ရန်
                    </button>
                  </div>
                ))}
              {canWrite && isTodayYangon(r.created_at) && editId === r.id && (
                <div className="mt-2 space-y-2 rounded-xl border p-3">
                  <div className="text-sm font-semibold">မှတ်တမ် ပြင်ရန်</div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-sm">
                      ပို့သည့် ပုလင်း
                      <input
                        value={eDelivered}
                        onChange={(e) => setEDelivered(e.target.value.replace(/\D/g, ''))}
                        inputMode="numeric"
                        className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
                      />
                    </label>
                    <label className="text-sm">
                      ပြန်အပ်သည့် ပုလင်း
                      <input
                        value={eReturned}
                        onChange={(e) => setEReturned(e.target.value.replace(/\D/g, ''))}
                        inputMode="numeric"
                        className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
                      />
                    </label>
                    <label className="text-sm">
                      လက်ခံရရှိငွေ (ကျပ်)
                      <input
                        value={eCash}
                        onChange={(e) => setECash(e.target.value.replace(/\D/g, ''))}
                        inputMode="numeric"
                        className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
                      />
                    </label>
                  </div>
                  <input
                    value={eNotes}
                    onChange={(e) => setENotes(e.target.value)}
                    placeholder="မှတ်ချက် (ရှိလျှင်)"
                    className="w-full rounded-xl border px-3 py-2 text-sm dark:bg-neutral-900"
                  />
                  <input
                    value={eReason}
                    onChange={(e) => setEReason(e.target.value)}
                    placeholder="ပြင်ရသည့် အကြောင်းအရင်း (လိုအပ်)"
                    className="w-full rounded-xl border px-3 py-2 text-sm dark:bg-neutral-900"
                  />
                  <div className="flex gap-3 text-sm">
                    <button
                      onClick={() => saveEdit(r)}
                      disabled={busy}
                      className="font-semibold text-teal-700 disabled:opacity-50"
                    >
                      သိမ်းမည်
                    </button>
                    <button onClick={() => setEditId(null)} className="opacity-70">
                      မလုပ်တော့ပါ
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className="p-3 text-sm opacity-70">မှတ်တမ် မရှိသေးပါ</li>}
          {rows.length > 0 && visibleRows.length === 0 && (
            <li className="p-3 text-sm opacity-70">ရွေးထားသော လတွင် မှတ်တမ် မရှိပါ</li>
          )}
        </ul>
      )}
    </div>
  )
}
