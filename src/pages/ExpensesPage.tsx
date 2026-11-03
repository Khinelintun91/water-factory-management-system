import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
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
  created_at: string
}

interface Category {
  id: string
  name: string
}

export default function ExpensesPage() {
  const [rows, setRows] = useState<ExpenseRow[]>([])
  const [cats, setCats] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [categoryName, setCategoryName] = useState('')
  const [notes, setNotes] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ex }, { data: ct }] = await Promise.all([
      supabase.from('expenses').select('*').order('created_at', { ascending: false }).limit(100),
      supabase.from('expense_categories').select('*').order('name'),
    ])
    setRows((ex ?? []) as ExpenseRow[])
    setCats((ct ?? []) as Category[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const catName = (id: string | null) => cats.find((c) => c.id === id)?.name ?? ''

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setMsg(null)
    let categoryId: string | null = null
    const name = categoryName.trim()
    if (name) {
      const existing = cats.find((c) => c.name === name)
      if (existing) {
        categoryId = existing.id
      } else {
        const { data, error } = await supabase
          .from('expense_categories')
          .insert({ name })
          .select('id')
          .single()
        if (error) {
          setMsg(error.message)
          setBusy(false)
          return
        }
        categoryId = (data as { id: string }).id
      }
    }
    const { error } = await supabase.from('expenses').insert({
      expense_date: todayYangon(),
      category_id: categoryId,
      title: title.trim(),
      amount: Number(amount) || 0,
      notes: notes.trim() || null,
    })
    if (error) {
      setMsg(error.message)
      setBusy(false)
      return
    }
    setTitle('')
    setAmount('')
    setNotes('')
    await load()
    setBusy(false)
  }

  async function onDelete(row: ExpenseRow) {
    const { error } = await supabase.from('expenses').delete().eq('id', row.id)
    if (error) setMsg(error.message)
    setConfirmId(null)
    await load()
  }

  // --- Row pieces shared by the card list (phone/tablet) and the table
  // (desktop), following EntriesPage's pattern. ------------------------------

  function rowButtons(r: ExpenseRow) {
    if (!isTodayYangon(r.created_at) || confirmId === r.id) {
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

  function rowPanel(r: ExpenseRow) {
    if (!isTodayYangon(r.created_at) || confirmId !== r.id) {
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
        title="အသုံးစရိတ်များ"
        subtitle="နေ့စဉ် ကုန်ကျစရိတ်များ မှတ်တမ်း ထည့်ရန်"
      />

      <form onSubmit={onAdd} className={`${cardCls} space-y-3 p-4 lg:p-5`}>
        <div className="text-base font-semibold">အသုံးစရိတ်အသစ်</div>
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
            <input
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              list="expense-cats"
              placeholder="ရွေးရန် / အသစ်ရေးရန်"
              className={inputCls}
            />
          </Field>
          <datalist id="expense-cats">
            {cats.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
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
                {rows.map((r) => {
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
