import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { friendlyError } from '../lib/friendlyError'
import { fetchAll } from '../lib/fetchAll'
import { downloadCsv, toCsv } from '../lib/exports'
import { formatMMK, isTodayYangon, todayYangon } from '../lib/types'
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

interface ExpenseRow {
  id: string
  expense_date: string
  category_id: string | null
  title: string
  amount: number
  notes: string | null
  change_reason: string | null
  created_by: string | null
  created_at: string
}

interface Category {
  id: string
  name: string
}

/** Auto-booked by the close-out flow; never offered as a manual form choice. */
const AUTO_CATEGORY = 'ဗူးအပေါင် ဈေးကွာ'

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

export default function ExpensesPage() {
  const { profile, roles } = useAuth()
  // Owner-only backdating: only the owner sees a date field; every other
  // role's expenses are dated today, exactly as before.
  const isOwner = profile?.role === 'owner'
  // Rule A (migration 0045, enforced in RLS): owner/manager (effective
  // roles; co_owner counts as manager) may delete any row, staff only
  // rows they created. The button mirrors the DB rule. (Today the page
  // itself is OM-only, so this is the same rule stated the same way as
  // Entries/Payments rather than a behaviour change.)
  const isOM = roles.includes('owner') || roles.includes('manager')
  const canEditRow = (r: ExpenseRow) => isOM || r.created_by === profile?.id
  const [rows, setRows] = useState<ExpenseRow[]>([])
  const [monthFilter, setMonthFilter] = useState(() => todayYangon().slice(0, 7))
  const [shown, setShown] = useState(200)
  const [cats, setCats] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [rowMsg, setRowMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [deleteReason, setDeleteReason] = useState('')

  // Same-day edit form (one row at a time), mirroring EntriesPage & PaymentsPage.
  const [editId, setEditId] = useState<string | null>(null)
  const [eTitle, setETitle] = useState('')
  const [eAmount, setEAmount] = useState('')
  const [eCategoryId, setECategoryId] = useState('')
  const [eNotes, setENotes] = useState('')
  const [eReason, setEReason] = useState('')

  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [notes, setNotes] = useState('')
  const [expDate, setExpDate] = useState(todayYangon())

  const filteredRows = useMemo(
    () =>
      monthFilter === 'all'
        ? rows
        : rows.filter((r) => r.expense_date.startsWith(monthFilter)),
    [rows, monthFilter],
  )
  const visibleRows = filteredRows.slice(0, shown)

  const load = useCallback(async () => {
    setLoading(true)
    const [ex, { data: ct }] = await Promise.all([
      // Full pagination instead of a silent 100-row cap.
      fetchAll<ExpenseRow>((from, to) =>
        supabase
          .from('expenses')
          .select('*')
          .order('created_at', { ascending: false })
          .range(from, to),
      ),
      supabase.from('expense_categories').select('*').order('name'),
    ])
    setRows(ex)
    setCats((ct ?? []) as Category[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const catName = (id: string | null) => cats.find((c) => c.id === id)?.name ?? ''

  // Manual choices: existing categories only, minus the auto-booked one.
  const manualCats = cats.filter((c) => c.name !== AUTO_CATEGORY)

  // This month's per-category breakdown, from the rows already loaded.
  const thisMonth = todayYangon().slice(0, 7)
  const monthCatTotals = new Map<string, number>()
  let monthTotal = 0
  for (const r of rows) {
    if (!r.expense_date.startsWith(thisMonth)) continue
    const name = catName(r.category_id) || 'အမျိုးအစား မသတ်မှတ်'
    monthCatTotals.set(name, (monthCatTotals.get(name) ?? 0) + r.amount)
    monthTotal += r.amount
  }
  const monthBreakdown = [...monthCatTotals.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total)

  function onExportCsv() {
    downloadCsv(
      `expenses-${todayYangon()}.csv`,
      toCsv(
        ['ရက်စွဲ', 'အမျိုးအစား', 'အကြောင်းအရာ', 'ငွေပမာဏ', 'မှတ်ချက်'],
        rows.map((r) => [r.expense_date, catName(r.category_id), r.title, r.amount, r.notes ?? '']),
      ),
    )
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setMsg(null)
    const { error } = await supabase.from('expenses').insert({
      expense_date: isOwner ? expDate || todayYangon() : todayYangon(),
      category_id: categoryId || null,
      title: title.trim(),
      amount: Number(amount) || 0,
      notes: notes.trim() || null,
    })
    if (error) {
      setMsg(friendlyError(error))
      setBusy(false)
      return
    }
    setTitle('')
    setAmount('')
    setNotes('')
    setExpDate(todayYangon())
    await load()
    setBusy(false)
  }

  function startEdit(row: ExpenseRow) {
    setConfirmId(null)
    setDeleteReason('')
    setRowMsg(null)
    setEditId(row.id)
    setETitle(row.title)
    setEAmount(String(row.amount))
    setECategoryId(row.category_id ?? '')
    setENotes(row.notes ?? '')
    setEReason('')
  }

  async function saveEdit(row: ExpenseRow) {
    if (busy) return
    const trimmedTitle = eTitle.trim()
    if (!trimmedTitle) {
      setRowMsg('အကြောင်းအရာ ထည့်ပါ')
      return
    }
    const newAmount = Number(eAmount) || 0
    if (newAmount <= 0) {
      setRowMsg('ပမာဏ ထည့်ပါ')
      return
    }
    const reason = eReason.trim()
    if (reason.length < 2) {
      setRowMsg('ပြင်ရသည့် အကြောင်းအရင်း (အနည်းဆုံး ၂ လုံး) ရေးပါ')
      return
    }
    setBusy(true)
    setRowMsg(null)
    const { error } = await supabase
      .from('expenses')
      .update({
        title: trimmedTitle,
        amount: newAmount,
        category_id: eCategoryId || null,
        notes: eNotes.trim() || null,
        change_reason: reason,
      })
      .eq('id', row.id)
    if (error) {
      setRowMsg(friendlyError(error))
      setBusy(false)
      return
    }
    setEditId(null)
    setRowMsg(null)
    await load()
    setBusy(false)
  }

  async function onDelete(row: ExpenseRow) {
    if (busy) return
    const reason = deleteReason.trim()
    if (reason.length < 2) {
      setRowMsg('ဖျက်ရသည့် အကြောင်းအရင်း (အနည်းဆုံး ၂ လုံး) ရေးပါ')
      return
    }
    setBusy(true)
    setRowMsg(null)
    // Stamp the reason first so the audit before-image of the delete
    // carries why the row was removed (same pattern as Entries/Payments).
    const { error: stampError } = await supabase
      .from('expenses')
      .update({ change_reason: reason })
      .eq('id', row.id)
    if (stampError) {
      setRowMsg(friendlyError(stampError))
      setBusy(false)
      return
    }
    const { error } = await supabase.from('expenses').delete().eq('id', row.id)
    if (error) {
      setRowMsg(friendlyError(error))
      setBusy(false)
      return
    }
    setConfirmId(null)
    setDeleteReason('')
    setRowMsg(null)
    await load()
    setBusy(false)
  }

  // --- Row pieces shared by the card list (phone/tablet) and the table
  // (desktop), following EntriesPage's pattern. ------------------------------

  function rowButtons(r: ExpenseRow) {
    if (!canEditRow(r) || !isTodayYangon(r.created_at) || editId === r.id || confirmId === r.id) {
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

  function rowPanel(r: ExpenseRow) {
    if (!canEditRow(r) || !isTodayYangon(r.created_at)) return null
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
      // Preserve an existing auto-booked category on this row if present so
      // editing notes/title cannot accidentally clear it.
      const editCats =
        r.category_id && !manualCats.some((c) => c.id === r.category_id)
          ? [...manualCats, ...cats.filter((c) => c.id === r.category_id)]
          : manualCats
      return (
        <div className="space-y-2.5 rounded-xl border border-stone-200 bg-stone-50/70 p-3.5 dark:border-neutral-800 dark:bg-neutral-800/40">
          <div className="font-semibold">အသုံးစရိတ် ပြင်ရန်</div>
          <Field label="အကြောင်းအရာ">
            <input
              value={eTitle}
              onChange={(e) => setETitle(e.target.value)}
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="ပမာဏ (ကျပ်)">
              <input
                value={eAmount}
                onChange={(e) => setEAmount(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="အမျိုးအစား">
              <select
                value={eCategoryId}
                onChange={(e) => setECategoryId(e.target.value)}
                className={inputCls}
              >
                <option value="">ရွေးပါ</option>
                {editCats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
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
        title="အသုံးစရိတ်များ"
        subtitle="နေ့စဉ် ကုန်ကျစရိတ်များ မှတ်တမ်း ထည့်ရန်"
        action={
          <SecondaryButton
            onClick={onExportCsv}
            disabled={loading || rows.length === 0}
            className="shrink-0"
          >
            CSV ထုတ်မည်
          </SecondaryButton>
        }
      />

      <form onSubmit={onAdd} className={`${cardCls} space-y-3 p-4 lg:p-5`}>
        <div className="text-base font-semibold">အသုံးစရိတ်အသစ်</div>
        {isOwner && (
          <Field label="ရက်စွဲ">
            <input
              type="date"
              value={expDate}
              max={todayYangon()}
              onChange={(e) => setExpDate(e.target.value)}
              className={inputCls}
            />
          </Field>
        )}
        <Field label="အကြောင်းအရာ">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            placeholder="အကြောင်းအရာ (ဥပမာ - ဒီဇယ်)"
            className={inputCls}
          />
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
          <Field label="အမျိုးအစား">
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className={inputCls}
            >
              <option value="">ရွေးပါ</option>
              {manualCats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
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
        <div className="max-md:sticky max-md:bottom-[calc(5.75rem_+_env(safe-area-inset-bottom))] max-md:z-10 max-md:-mx-4 max-md:border-t max-md:border-stone-200/90 max-md:bg-white/95 max-md:px-4 max-md:py-2.5 max-md:backdrop-blur dark:max-md:border-neutral-800 dark:max-md:bg-neutral-900/95">
          <PrimaryButton type="submit" disabled={busy} className="w-full">
            သိမ်းရန်
          </PrimaryButton>
        </div>
      </form>

      {loading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState text="မှတ်တမ် မရှိသေးပါ" />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={monthFilter}
              onChange={(e) => {
                setMonthFilter(e.target.value)
                setShown(200)
              }}
              className={`${inputCls} w-auto`}
              aria-label="လ ရွေးရန်"
            >
              {monthOptions().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="text-sm text-stone-500 dark:text-neutral-400">
              {filteredRows.length} ခု
            </span>
          </div>
          <p className="text-xs text-stone-500 dark:text-neutral-400">
            ပြင်/ဖျက် လုပ်ခွင့်က ထည့်သွင်းသည့် နေ့ တစ်နေ့တည်းသာ ရပါမယ် (ပိုင်ရှင် အပါအဝင် အားလုံး)။
          </p>
          <div className={`${cardCls} space-y-2.5 p-4 lg:p-5`}>
            <div className="text-base font-semibold">
              ဤလအတွက် အမျိုးအစားအလိုက် ခွဲခြမ်းစိတ်ဖြာမှု
            </div>
            {monthBreakdown.length === 0 ? (
              <p className="text-sm text-stone-500 dark:text-neutral-400">မှတ်တမ် မရှိသေးပါ</p>
            ) : (
              monthBreakdown.map((c) => {
                const pct = monthTotal > 0 ? (c.total / monthTotal) * 100 : 0
                return (
                  <div key={c.name} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span>{c.name}</span>
                      <span className="font-medium tabular-nums">
                        {formatMMK(c.total)} · {pct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="mt-1 h-2 rounded-full bg-stone-200 dark:bg-neutral-800">
                      <div
                        className="h-2 rounded-full bg-brand-600"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {/* Phone / tablet: one card per record. */}
          {filteredRows.length === 0 && (
            <EmptyState text="ရွေးထားသော လတွင် မှတ်တမ် မရှိပါ" />
          )}
          <ul className="space-y-3 lg:hidden">
            {visibleRows.map((r) => (
              <li key={r.id} className={`${cardCls} p-3.5`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold">{r.title}</div>
                  <div className="font-bold tabular-nums">{formatMMK(r.amount)}</div>
                </div>
                <div className="mt-0.5 text-sm text-stone-500 dark:text-neutral-400">
                  {r.expense_date}
                  {catName(r.category_id) ? ` · ${catName(r.category_id)}` : ''}
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
                  <th className={`${thCls} pl-4`}>အကြောင်းအရာ</th>
                  <th className={thCls}>ရက်စွဲ</th>
                  <th className={thCls}>အမျိုးအစား</th>
                  <th className={`${thCls} text-right`}>ပမာဏ (ကျပ်)</th>
                  <th className={`${thCls} pr-4`}>
                    <span className="sr-only">လုပ်ဆောင်ချက်</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const panel = rowPanel(r)
                  return (
                    <Fragment key={r.id}>
                      <tr className="border-b border-stone-100 align-top last:border-0 dark:border-neutral-800/70">
                        <td className="px-3 py-3 pl-4">
                          <div className="font-medium">{r.title}</div>
                          {r.notes && <div className="text-xs opacity-60">{r.notes}</div>}
                        </td>
                        <td className={`${tdCls} whitespace-nowrap`}>{r.expense_date}</td>
                        <td className="px-3 py-3">{catName(r.category_id)}</td>
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
