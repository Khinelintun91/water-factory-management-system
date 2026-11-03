import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { formatMMK, isTodayYangon, todayYangon } from '../lib/types'

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
      return
    }
    setTitle('')
    setAmount('')
    setNotes('')
    await load()
  }

  async function onDelete(row: ExpenseRow) {
    if (!confirm('ဒီအသုံးစရိတ် မှတ်တမ်ကို ဖျက်မှာ သေချာပါသလား? (ယနေ့ မှတ်တမ်သာ ဖျက်လို့ ရပါမယ်)')) return
    const { error } = await supabase.from('expenses').delete().eq('id', row.id)
    if (error) setMsg(error.message)
    await load()
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">အသုံးစရိတ်များ</h1>

      <form onSubmit={onAdd} className="space-y-2 rounded-2xl border p-4">
        <div className="font-semibold">အသုံးစရိတ်အသစ်</div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          placeholder="အကြောင်းအရာ (ဥပမာ - ဒီဇယ်)"
          className="w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
        />
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">
            ပမာဏ (ကျပ်)
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              required
              className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
            />
          </label>
          <label className="text-sm">
            အမျိုးအစား
            <input
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              list="expense-cats"
              placeholder="ရွေးရန် / အသစ်ရေးရန်"
              className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
            />
            <datalist id="expense-cats">
              {cats.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </label>
        </div>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="မှတ်ချက် (ရှိလျှင်)"
          className="w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
        />
        {msg && <p className="text-sm text-red-600">{msg}</p>}
        <button className="w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white">
          သိမ်းရန်
        </button>
      </form>

      {loading ? (
        <p>ခဏစောင့်ပါ…</p>
      ) : (
        <ul className="divide-y rounded-2xl border">
          {rows.map((r) => (
            <li key={r.id} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">{r.title}</div>
                <div className="text-sm font-semibold">{formatMMK(r.amount)}</div>
              </div>
              <div className="text-sm opacity-75">
                {r.expense_date}
                {catName(r.category_id) ? ` · ${catName(r.category_id)}` : ''}
                {r.notes ? ` · ${r.notes}` : ''}
              </div>
              {isTodayYangon(r.created_at) && (
                <button onClick={() => onDelete(r)} className="mt-1 text-sm text-red-600">
                  ဖျက်ရန်
                </button>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className="p-3 text-sm opacity-70">မှတ်တမ် မရှိသေးပါ</li>}
        </ul>
      )}
    </div>
  )
}
