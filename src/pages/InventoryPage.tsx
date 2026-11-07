import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { isTodayYangon, todayYangon } from '../lib/types'
import {
  Banner,
  Card,
  CardTitle,
  DangerButton,
  EmptyState,
  Field,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  StatCard,
  cardCls,
  inputCls,
} from '../components/ui'

// inventory_movements shape (migration 0001 + kinds extended in 0006).
// move_date is defaulted to the Yangon today by the database and an insert
// guard requires it to be today — except for the owner, who may backdate;
// only the owner's form sends an explicit move_date.
interface StockMove {
  id: string
  move_date: string
  kind: string
  bottles: number
  notes: string | null
  created_at: string
}

const KIND_LABELS: Record<string, string> = {
  produce: 'ထုတ်လုပ်',
  purchase: 'ဝယ်ယူ',
  damage: 'ပျက်စီး',
  in: 'အဝင်',
  out: 'အထွက်',
  adjust: 'စာရင်းညှိ',
}

const fmtQty = (n: number) => `${n.toLocaleString('en-US')} ဗူး`

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
  const { profile } = useAuth()
  const [moves, setMoves] = useState<StockMove[]>([])
  const [invTotals, setInvTotals] = useState<{
    produced: number
    purchased: number
    damaged: number
    adjustments: number
    outQty: number
    inQty: number
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const [kind, setKind] = useState('produce')
  const [bottles, setBottles] = useState('')
  const [note, setNote] = useState('')
  // Owner-only backdating: only the owner sees a date field and sends an
  // explicit move_date; everyone else omits it and the DB defaults today.
  const isOwner = profile?.role === 'owner'
  const [moveDate, setMoveDate] = useState(todayYangon())

  const load = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const [mv, totals] = await Promise.all([
        fetchAll<StockMove>('inventory_movements', 'id, move_date, kind, bottles, notes, created_at'),
        supabase.rpc('inventory_totals'),
      ])
      if (totals.error) throw new Error(totals.error.message)
      setMoves(mv)
      setInvTotals(totals.data as typeof invTotals)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Stock formulas (identical to the old app):
  //   full  = produced - out + adjustments
  //   empty = purchased + in - produced - damaged
  //   withAgents = out - in ; total = full + empty + withAgents
  // Stock corrections (kind 'adjust', စာရင်းညှိ) carry a SIGNED quantity from
  // a dated physical count: the correction applies to the full bottles
  // physically at the factory, so the signed adjust sum is added to `full`
  // (and therefore flows into `total`).
  const stock = useMemo(() => {
    // Sums come from inventory_totals (migration 0023) — full-table server
    // aggregates; the page no longer downloads every entry row to add them.
    const produced = invTotals?.produced ?? 0
    const purchased = invTotals?.purchased ?? 0
    const damaged = invTotals?.damaged ?? 0
    const adjustments = invTotals?.adjustments ?? 0
    const out = invTotals?.outQty ?? 0
    const inn = invTotals?.inQty ?? 0
    const full = produced - out + adjustments
    const empty = purchased + inn - produced - damaged
    const withAgents = out - inn
    const total = full + empty + withAgents
    return { produced, purchased, damaged, adjustments, out, inn, full, empty, withAgents, total }
  }, [invTotals])

  const latestMoves = useMemo(() => [...moves].reverse().slice(0, 100), [moves])

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const qty = Number(bottles)
    if (kind === 'adjust') {
      // Corrections are signed: any non-zero quantity, and a reason is
      // required (stored in notes) so the correction stays explainable.
      if (!qty) {
        setMsg('ဗူး အရေအတွက် ထည့်ပါ')
        return
      }
      if (!note.trim()) {
        setMsg('စာရင်းညှိရန် အကြောင်းရင်း ထည့်ပါ')
        return
      }
    } else if (!(qty > 0)) {
      setMsg('ဗူး အရေအတွက် ထည့်ပါ')
      return
    }
    setBusy(true)
    setMsg(null)
    // No move_date for non-owners: the database defaults it to today (and
    // the insert guard requires today). The owner may send a past date.
    const { error } = await supabase.from('inventory_movements').insert({
      ...(isOwner ? { move_date: moveDate || todayYangon() } : {}),
      kind,
      bottles: qty,
      notes: note.trim() || null,
    })
    if (error) {
      setMsg(error.message)
      setBusy(false)
      return
    }
    setBottles('')
    setNote('')
    setMoveDate(todayYangon())
    await load()
    setBusy(false)
  }

  async function onDelete(row: StockMove) {
    const { error } = await supabase.from('inventory_movements').delete().eq('id', row.id)
    if (error) setMsg(error.message)
    setConfirmId(null)
    await load()
  }

  // --- Row pieces shared by the card list (phone/tablet) and the table
  // (desktop), following EntriesPage's pattern. ------------------------------

  function rowButtons(r: StockMove) {
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

  function rowPanel(r: StockMove) {
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

  const statCards: { label: string; value: number; danger?: boolean }[] = [
    { label: 'စက်ရုံထဲ အပြည့်', value: stock.full, danger: stock.full < 0 },
    { label: 'အခွံ', value: stock.empty, danger: stock.empty < 0 },
    { label: 'ကိုယ်စားလှယ်များထံ', value: stock.withAgents },
    { label: 'စုစုပေါင်း ဗူး', value: stock.total },
  ]

  const thCls = 'px-3 py-3 font-medium'
  const tdCls = 'px-3 py-3 tabular-nums'

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="ဗူးလက်ကျန်စာရင်း"
        subtitle="အပြည့်၊ အခွံနှင့် ကိုယ်စားလှယ်များထံ ဗူး အရေအတွက် ကြည့်ရန်"
      />

      {msg && (
        <p className="text-sm text-red-600" role="alert">
          {msg}
        </p>
      )}

      {loading ? (
        <LoadingState />
      ) : (
        <>
          {(stock.full < 0 || stock.empty < 0) && (
            <Banner tone="red">
              သတိပေးချက်: ဗူးလက်ကျန် အနှုတ် ဖြစ်နေပါတယ် — မှတ်တမ်းများ ပြန်စစ်ဆေးရန်
              လိုပါတယ်
            </Banner>
          )}
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4 lg:gap-3">
            {statCards.map((c) => (
              <StatCard
                key={c.label}
                label={c.label}
                value={fmtQty(c.value)}
                tone={c.danger ? 'danger' : c.label === 'စုစုပေါင်း ဗူး' ? 'brand' : 'default'}
              />
            ))}
          </div>
          <Card className="space-y-1 text-sm">
            <CardTitle>အသေးစိတ် တွက်ချက်မှု</CardTitle>
            <div className="flex items-baseline justify-between gap-3 py-0.5">
              <span className="text-stone-500 dark:text-neutral-400">ထုတ်လုပ်ပြီး:</span>
              <span className="font-medium tabular-nums">{fmtQty(stock.produced)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-0.5">
              <span className="text-stone-500 dark:text-neutral-400">ဝယ်ယူပြီး:</span>
              <span className="font-medium tabular-nums">{fmtQty(stock.purchased)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-0.5">
              <span className="text-stone-500 dark:text-neutral-400">ပျက်စီး:</span>
              <span className="font-medium tabular-nums">{fmtQty(stock.damaged)}</span>
            </div>
            {stock.adjustments !== 0 && (
              <div className="flex items-baseline justify-between gap-3 py-0.5">
                <span className="text-stone-500 dark:text-neutral-400">စာရင်းညှိ:</span>
                <span className="font-medium tabular-nums">{fmtQty(stock.adjustments)}</span>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-3 py-0.5">
              <span className="text-stone-500 dark:text-neutral-400">ကိုယ်စားလှယ်များထံ ပို့ပြီး:</span>
              <span className="font-medium tabular-nums">{fmtQty(stock.out)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3 py-0.5">
              <span className="text-stone-500 dark:text-neutral-400">ပြန်အပ်ပြီး အခွံ:</span>
              <span className="font-medium tabular-nums">{fmtQty(stock.inn)}</span>
            </div>
          </Card>
        </>
      )}

      <form onSubmit={onAdd} className={`${cardCls} space-y-3 p-4 lg:p-5`}>
        <div className="text-base font-semibold">{isOwner ? 'ဗူး ရွှေ့ပြောင်းမှု အသစ်' : 'ဗူး ရွှေ့ပြောင်းမှု အသစ် (ယနေ့)'}</div>
        <p className="text-sm text-stone-500 dark:text-neutral-400">
          ဝယ်ယူ = ဗူးအလွတ် ဝယ်ထည့်ခြင်း · ထုတ်လုပ် = ဗူးအလွတ်ကို ရေဖြည့်ပြီး အပြည့် ပြောင်းခြင်း ·
          ပျက်စီး = သုံးမရတော့သော ဗူးများ · စာရင်းညှိ = လက်ကျန် ပြန်စစ်ပြီး ကွာဟချက်ကို ညှိခြင်း
          (အနှုတ် ဂဏန်း ရိုက်နိုင်သည်)
        </p>
        <div className="grid grid-cols-2 gap-2.5">
          {isOwner && (
            <Field label="ရက်စွဲ">
              <input
                type="date"
                value={moveDate}
                max={todayYangon()}
                onChange={(e) => setMoveDate(e.target.value)}
                className={inputCls}
              />
            </Field>
          )}
          <Field label="အမျိုးအစား">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className={inputCls}
            >
              <option value="produce">ထုတ်လုပ်</option>
              <option value="purchase">ဝယ်ယူ</option>
              <option value="damage">ပျက်စီး</option>
              <option value="adjust">စာရင်းညှိ</option>
            </select>
          </Field>
          <Field label="ဗူး အရေအတွက်">
            <input
              value={bottles}
              onChange={(e) => {
                const v = e.target.value
                // 'adjust' quantities are signed — allow a single leading
                // minus; every other kind stays digits-only.
                setBottles(
                  kind === 'adjust'
                    ? v.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '')
                    : v.replace(/\D/g, ''),
                )
              }}
              inputMode={kind === 'adjust' ? 'text' : 'numeric'}
              required
              className={inputCls}
            />
          </Field>
        </div>
        <Field label={kind === 'adjust' ? 'အကြောင်းရင်း' : 'မှတ်ချက် (ရှိလျှင်)'}>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={kind === 'adjust' ? 'စာရင်းညှိရသည့် အကြောင်းရင်း ရေးပါ' : undefined}
            required={kind === 'adjust'}
            className={inputCls}
          />
        </Field>
        <div className="max-md:sticky max-md:bottom-[calc(70px_+_env(safe-area-inset-bottom))] max-md:z-10 max-md:-mx-4 max-md:border-t max-md:border-stone-200 max-md:bg-white max-md:px-4 max-md:py-2.5 dark:max-md:border-neutral-800 dark:max-md:bg-neutral-900">
          <PrimaryButton type="submit" disabled={busy} className="w-full">
            သိမ်းရန်
          </PrimaryButton>
        </div>
      </form>

      {loading ? null : latestMoves.length === 0 ? (
        <EmptyState text="ရွှေ့ပြောင်းမှု မှတ်တမ် မရှိသေးပါ" />
      ) : (
        <>
          {/* Phone / tablet: one card per record. */}
          <ul className="space-y-3 lg:hidden">
            {latestMoves.map((m) => (
              <li key={m.id} className={`${cardCls} p-3.5`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold">{KIND_LABELS[m.kind] ?? m.kind}</div>
                  <div className="font-bold tabular-nums">{fmtQty(m.bottles)}</div>
                </div>
                <div className="mt-0.5 text-sm text-stone-500 dark:text-neutral-400">
                  {m.move_date}
                  {m.notes ? ` · ${m.notes}` : ''}
                </div>
                <div className="mt-2.5 empty:hidden">{rowButtons(m)}</div>
                <div className="mt-2.5 empty:hidden">{rowPanel(m)}</div>
              </li>
            ))}
          </ul>

          {/* Desktop: table. */}
          <div className={`${cardCls} hidden overflow-x-auto lg:block`}>
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50/80 text-left text-stone-500 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-400">
                  <th className={`${thCls} pl-4`}>အမျိုးအစား</th>
                  <th className={thCls}>ရက်စွဲ</th>
                  <th className={`${thCls} text-right`}>ဗူး အရေအတွက်</th>
                  <th className={`${thCls} pr-4`}>
                    <span className="sr-only">လုပ်ဆောင်ချက်</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {latestMoves.map((m) => {
                  const panel = rowPanel(m)
                  return (
                    <Fragment key={m.id}>
                      <tr className="border-b border-stone-100 align-top last:border-0 dark:border-neutral-800/70">
                        <td className="px-3 py-3 pl-4">
                          <div className="font-medium">{KIND_LABELS[m.kind] ?? m.kind}</div>
                          {m.notes && <div className="text-xs opacity-60">{m.notes}</div>}
                        </td>
                        <td className={`${tdCls} whitespace-nowrap`}>{m.move_date}</td>
                        <td className={`${tdCls} text-right font-semibold`}>{fmtQty(m.bottles)}</td>
                        <td className="px-3 py-2 pr-4">{rowButtons(m)}</td>
                      </tr>
                      {panel && (
                        <tr className="border-b border-stone-100 last:border-0 dark:border-neutral-800/70">
                          <td colSpan={4} className="px-4 pb-3">
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
