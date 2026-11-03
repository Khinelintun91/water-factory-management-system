import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { isTodayYangon } from '../lib/types'

// inventory_movements shape (migration 0001 + kinds extended in 0006).
// move_date is defaulted to the Yangon today by the database and an insert
// guard requires it to be today, so the form never sends a date.
interface StockMove {
  id: string
  move_date: string
  kind: string
  bottles: number
  notes: string | null
  created_at: string
}

interface EntryQty {
  delivered_qty: number
  returned_qty: number
}

const KIND_LABELS: Record<string, string> = {
  produce: 'ထုတ်လုပ်',
  purchase: 'ဝယ်ယူ',
  damage: 'ပျက်စီး',
  in: 'အဝင်',
  out: 'အထွက်',
  adjust: 'ပြင်ဆင်',
}

const fmtQty = (n: number) => `${n.toLocaleString('en-US')} လုံး`

/** Fetch a whole table in created_at order, paging past the 1,000-row cap. */
async function fetchAll<T>(table: string, columns: string): Promise<T[]> {
  const pageSize = 1000
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const page = (data ?? []) as T[]
    out.push(...page)
    if (page.length < pageSize) break
  }
  return out
}

export default function InventoryPage() {
  const [moves, setMoves] = useState<StockMove[]>([])
  const [entryQty, setEntryQty] = useState<EntryQty[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const [kind, setKind] = useState('produce')
  const [bottles, setBottles] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const [mv, eq] = await Promise.all([
        fetchAll<StockMove>('inventory_movements', 'id, move_date, kind, bottles, notes, created_at'),
        fetchAll<EntryQty>('daily_entries', 'delivered_qty, returned_qty'),
      ])
      setMoves(mv)
      setEntryQty(eq)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Stock formulas (identical to the old app):
  //   full  = produced - out
  //   empty = purchased + in - produced - damaged
  //   withAgents = out - in ; total = full + empty + withAgents
  const stock = useMemo(() => {
    const sumKind = (k: string) =>
      moves.filter((m) => m.kind === k).reduce((s, m) => s + m.bottles, 0)
    const produced = sumKind('produce')
    const purchased = sumKind('purchase')
    const damaged = sumKind('damage')
    const out = entryQty.reduce((s, e) => s + e.delivered_qty, 0)
    const inn = entryQty.reduce((s, e) => s + e.returned_qty, 0)
    const full = produced - out
    const empty = purchased + inn - produced - damaged
    const withAgents = out - inn
    const total = full + empty + withAgents
    return { produced, purchased, damaged, out, inn, full, empty, withAgents, total }
  }, [moves, entryQty])

  const latestMoves = useMemo(() => [...moves].reverse().slice(0, 100), [moves])

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const n = Number(bottles) || 0
    if (n <= 0) {
      setMsg('ပုလင်း အရေအတွက် ထည့်ပါ')
      return
    }
    setBusy(true)
    setMsg(null)
    // No move_date: the database defaults it to today (and requires today).
    const { error } = await supabase.from('inventory_movements').insert({
      kind,
      bottles: n,
      notes: note.trim() || null,
    })
    if (error) {
      setMsg(error.message)
      setBusy(false)
      return
    }
    setBottles('')
    setNote('')
    await load()
    setBusy(false)
  }

  async function onDelete(row: StockMove) {
    const { error } = await supabase.from('inventory_movements').delete().eq('id', row.id)
    if (error) setMsg(error.message)
    setConfirmId(null)
    await load()
  }

  const statCards: { label: string; value: number; danger?: boolean }[] = [
    { label: 'စက်ရုံထဲ အပြည့်', value: stock.full, danger: stock.full < 0 },
    { label: 'အခွံ', value: stock.empty, danger: stock.empty < 0 },
    { label: 'ကိုယ်စားလှယ်များထံ', value: stock.withAgents },
    { label: 'စုစုပေါင်း ပုလင်း', value: stock.total },
  ]

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">ပုလင်း စာရင်း</h1>

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      {loading ? (
        <p>ခဏစောင့်ပါ…</p>
      ) : (
        <>
          {(stock.full < 0 || stock.empty < 0) && (
            <p className="rounded-xl border border-red-400 bg-red-50 p-3 text-sm font-semibold text-red-700 dark:bg-neutral-900">
              သတိပေးချက်: ပုလင်း စာရင်း အနှုတ် ဖြစ်နေပါတယ် — မှတ်တမ်းများ ပြန်စစ်ဆေးရန်
              လိုပါတယ်
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            {statCards.map((c) => (
              <div key={c.label} className="rounded-2xl border p-3">
                <div className="text-sm opacity-70">{c.label}</div>
                <div className={`text-lg font-bold ${c.danger ? 'text-red-600' : ''}`}>
                  {fmtQty(c.value)}
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-2xl border p-4 text-sm">
            <div className="font-semibold">အသေးစိတ် တွက်ချက်မှု</div>
            <div className="mt-1 space-y-0.5 opacity-80">
              <div>ထုတ်လုပ်ပြီး: {fmtQty(stock.produced)}</div>
              <div>ဝယ်ယူပြီး: {fmtQty(stock.purchased)}</div>
              <div>ပျက်စီး: {fmtQty(stock.damaged)}</div>
              <div>ကိုယ်စားလှယ်များထံ ပို့ပြီး: {fmtQty(stock.out)}</div>
              <div>ပြန်အပ်ပြီး အခွံ: {fmtQty(stock.inn)}</div>
            </div>
          </div>
        </>
      )}

      <form onSubmit={onAdd} className="space-y-2 rounded-2xl border p-4">
        <div className="font-semibold">ပုလင်း ရွှေ့ပြောင်းမှု အသစ် (ယနေ့)</div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">
            အမျိုးအစား
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
            >
              <option value="produce">ထုတ်လုပ်</option>
              <option value="purchase">ဝယ်ယူ</option>
              <option value="damage">ပျက်စီး</option>
            </select>
          </label>
          <label className="text-sm">
            ပုလင်း အရေအတွက်
            <input
              value={bottles}
              onChange={(e) => setBottles(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              required
              className="mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
            />
          </label>
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="မှတ်ချက် (ရှိလျှင်)"
          className="w-full rounded-xl border px-3 py-2 dark:bg-neutral-900"
        />
        <button disabled={busy} className="w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white disabled:opacity-50">
          သိမ်းရန်
        </button>
      </form>

      {loading ? null : (
        <ul className="divide-y rounded-2xl border">
          {latestMoves.map((m) => (
            <li key={m.id} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">{KIND_LABELS[m.kind] ?? m.kind}</div>
                <div className="text-sm font-semibold">{fmtQty(m.bottles)}</div>
              </div>
              <div className="text-sm opacity-75">
                {m.move_date}
                {m.notes ? ` · ${m.notes}` : ''}
              </div>
              {isTodayYangon(m.created_at) &&
                (confirmId === m.id ? (
                  <span className="mt-1 flex gap-3 text-sm">
                    <button onClick={() => onDelete(m)} className="font-semibold text-red-600">
                      သေချာပါတယ်, ဖျက်မည်
                    </button>
                    <button onClick={() => setConfirmId(null)} className="opacity-70">
                      မဖျက်တော့ပါ
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmId(m.id)} className="mt-1 text-sm text-red-600">
                    ဖျက်ရန်
                  </button>
                ))}
            </li>
          ))}
          {latestMoves.length === 0 && (
            <li className="p-3 text-sm opacity-70">ရွှေ့ပြောင်းမှု မှတ်တမ် မရှိသေးပါ</li>
          )}
        </ul>
      )}
    </div>
  )
}
