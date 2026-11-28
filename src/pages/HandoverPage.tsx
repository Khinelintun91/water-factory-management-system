import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { friendlyError } from '../lib/friendlyError'
import { dailySummaryCsv } from '../lib/exports'
import { formatMMK, personName, todayYangon, type Role } from '../lib/types'
import {
  collectOtherReceivers,
  evaluateHandoverRow,
  initialReceivedInput,
  parseReceivedInput,
  summarizeHandoverTotals,
  type OtherReceiver,
} from '../lib/handoverCount'
import {
  Card,
  CardTitle,
  EmptyState,
  Field,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  StatCard,
  inputCls,
} from '../components/ui'

// Cash handover (old ops.ts rule): what an employee should hand over for a
// day = delivery cash they received (daily_entries.amount_collected) +
// later debt collections they took (agent_payments) — attributed since
// migration 0041 to the RECEIVER, coalesce(received_by, created_by), not
// the typist: the person who physically took the cash hands it over.
// (Rows where both are NULL — legacy system rows — are attributed to
// nobody.) The received amount is typed in by OM and the difference is
// badged match / short / over.

interface HandoverRow {
  id: string
  handover_date: string
  employee_id: string
  expected: number
  received: number
  note: string | null
  received_by: string | null
}

interface EmployeeLite {
  id: string
  /** Display name (personName): display_name when set, else username. */
  name: string
}

const STAFF_ROLES: Role[] = ['staff', 'manager', 'co_owner']

/** Paginated fetch past the 1,000-row cap, for one day's rows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchDay<T>(table: string, columns: string, dateCol: string, date: string, extra?: (q: any) => any): Promise<T[]> {
  const pageSize = 1000
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase.from(table).select(columns).eq(dateCol, date).order('created_at', { ascending: true })
    if (extra) q = extra(q)
    const { data, error } = await q.range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const page = (data ?? []) as T[]
    out.push(...page)
    if (page.length < pageSize) break
  }
  return out
}

export default function HandoverPage() {
  const { profile } = useAuth()
  const [date, setDate] = useState(todayYangon())
  const [employees, setEmployees] = useState<EmployeeLite[]>([])
  const [otherReceivers, setOtherReceivers] = useState<OtherReceiver[]>([])
  const [expected, setExpected] = useState<Map<string, number>>(new Map())
  const [saved, setSaved] = useState<Map<string, HandoverRow>>(new Map())
  const [receivedIn, setReceivedIn] = useState<Record<string, string>>({})
  const [noteIn, setNoteIn] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [csvBusy, setCsvBusy] = useState(false)
  const [csvMsg, setCsvMsg] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const [{ data: profs, error: pErr }, { data: roleRows, error: rErr }] = await Promise.all([
        supabase.from('profiles').select('id, username, display_name, role, active').order('username'),
        supabase.from('user_roles').select('profile_id, role'),
      ])
      if (pErr) throw new Error(pErr.message)
      if (rErr) throw new Error(rErr.message)
      const extra = new Map<string, Role[]>()
      for (const r of (roleRows ?? []) as { profile_id: string; role: Role }[]) {
        extra.set(r.profile_id, [...(extra.get(r.profile_id) ?? []), r.role])
      }
      const allProfs = (profs ?? []) as {
        id: string
        username: string
        display_name?: string | null
        role: Role
        active: boolean
      }[]
      const emps: EmployeeLite[] = allProfs
        .filter(
          (p) =>
            p.active &&
            [p.role, ...(extra.get(p.id) ?? [])].some((r) => STAFF_ROLES.includes(r)),
        )
        .map((p) => ({ id: p.id, name: personName(p) }))
      setEmployees(emps)

      const [entryRows, paymentRows, handoverRows] = await Promise.all([
        fetchDay<{ created_by: string | null; received_by: string | null; amount_collected: number }>(
          'daily_entries',
          'created_by, received_by, amount_collected',
          'entry_date',
          date,
        ),
        fetchDay<{ created_by: string | null; received_by: string | null; amount: number }>(
          'agent_payments',
          'created_by, received_by, amount',
          'payment_date',
          date,
        ),
        fetchDay<HandoverRow>(
          'cash_handovers',
          'id, handover_date, employee_id, expected, received, note, received_by',
          'handover_date',
          date,
        ),
      ])

      const exp = new Map<string, number>()
      for (const e of entryRows) {
        const holder = e.received_by ?? e.created_by
        if (!holder) continue
        exp.set(holder, (exp.get(holder) ?? 0) + Number(e.amount_collected))
      }
      for (const p of paymentRows) {
        const holder = p.received_by ?? p.created_by
        if (!holder) continue
        exp.set(holder, (exp.get(holder) ?? 0) + Number(p.amount))
      }
      setExpected(exp)

      const empIds = new Set(emps.map((e) => e.id))
      setOtherReceivers(
        collectOtherReceivers(
          exp,
          empIds,
          allProfs.map((p) => ({
            id: p.id,
            name: personName(p),
            role: p.role,
            active: p.active,
          })),
        ),
      )

      const savedMap = new Map(handoverRows.map((h) => [h.employee_id, h]))
      setSaved(savedMap)
      // Blind count (Package A, 2026-11-28): saved handovers keep their
      // recorded received amount; unsaved rows start EMPTY so OM types the
      // physically counted cash before seeing the expected figure.
      const recInit: Record<string, string> = {}
      for (const e of emps) {
        const h = savedMap.get(e.id)
        recInit[e.id] = initialReceivedInput(h ? Number(h.received) : null)
      }
      setReceivedIn(recInit)
      setNoteIn(Object.fromEntries(handoverRows.map((h) => [h.employee_id, h.note ?? ''])))
      setRowMsg({})
    } catch (err) {
      setMsg(friendlyError(err))
    }
    setLoading(false)
  }, [date])

  useEffect(() => {
    load()
  }, [load])

  // Daily CSV export for the page's selected date, wired the same way as
  // HomePage's button.
  async function onDailyCsv() {
    setCsvBusy(true)
    setCsvMsg(null)
    try {
      const filename = await dailySummaryCsv(date)
      setCsvMsg(`${filename} ကို ဒေါင်းလုပ် လုပ်ပြီးပါပြီ`)
    } catch (e) {
      setCsvMsg(e instanceof Error ? friendlyError(e) : 'CSV ထုတ်၍ မရပါ')
    }
    setCsvBusy(false)
  }

  async function onSave(emp: EmployeeLite) {
    if (!profile) return
    const received = parseReceivedInput(receivedIn[emp.id] ?? '')
    if (received === null) {
      setRowMsg((m) => ({ ...m, [emp.id]: 'လက်ခံရငွေ မှန်ကန်စွာ ထည့်ပါ' }))
      return
    }
    setSavingId(emp.id)
    setRowMsg((m) => ({ ...m, [emp.id]: '' }))
    const { error } = await supabase.from('cash_handovers').upsert(
      {
        handover_date: date,
        employee_id: emp.id,
        expected: expected.get(emp.id) ?? 0,
        received,
        note: noteIn[emp.id]?.trim() ? noteIn[emp.id].trim() : null,
        received_by: profile.id,
      },
      { onConflict: 'handover_date,employee_id' },
    )
    setSavingId(null)
    if (error) {
      setRowMsg((m) => ({ ...m, [emp.id]: friendlyError(error) }))
      return
    }
    setRowMsg((m) => ({ ...m, [emp.id]: 'သိမ်းပြီးပါပြီ ✓' }))
    await load()
  }

  const totals = useMemo(
    () =>
      summarizeHandoverTotals(
        employees.map((e) => ({
          rawInput: receivedIn[e.id] ?? '',
          expected: expected.get(e.id) ?? 0,
          isSaved: saved.has(e.id),
        })),
      ),
    [employees, expected, receivedIn, saved],
  )

  function diffBadge(diff: number) {
    if (diff === 0)
      return (
        <span className="rounded-full bg-brand-100 px-2.5 py-1 text-xs font-semibold text-brand-800 dark:bg-brand-950 dark:text-brand-200">
          ကိုက်ညီပါတယ်
        </span>
      )
    if (diff < 0)
      return (
        <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700 dark:bg-red-950 dark:text-red-300">
          လိုနေပါတယ် {formatMMK(-diff)}
        </span>
      )
    return (
      <span className="rounded-full bg-accent-100 px-2.5 py-1 text-xs font-semibold text-accent-800 dark:bg-amber-900 dark:text-amber-200">
        ပိုနေပါတယ် {formatMMK(diff)}
      </span>
    )
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="ငွေလွှဲအပ်ခြင်း"
        subtitle="မျှော်မှန်းငွေနှင့် လက်ခံရငွေ အမှန် တိုက်စစ်ရန်"
      />
      <p className="text-sm text-stone-500 dark:text-neutral-400">
        မျှော်မှန်းငွေ = ထိုနေ့ ဝန်ထမ်း ကောက်ခံခဲ့သော ပို့ချိန်ငွေ + ကြွေးကောက်ငွေ။ လက်ခံရငွေ
        အမှန်ကို ရိုက်ထည့်ပြီး သိမ်းပါ။
      </p>

      <Field label="ရက်စွဲ" className="max-w-xs">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className={inputCls}
        />
      </Field>

      <div>
        <SecondaryButton onClick={onDailyCsv} disabled={csvBusy}>
          {csvBusy ? 'ထုတ်နေပါတယ်…' : 'နေ့စဉ် CSV ထုတ်မည်'}
        </SecondaryButton>
        {csvMsg && <p className="mt-2 text-sm">{csvMsg}</p>}
      </div>

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      {loading ? (
        <LoadingState />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2.5">
            <StatCard
              label="မျှော်မှန်း စုစုပေါင်း"
              value={totals.counted > 0 ? formatMMK(totals.exp) : '—'}
            />
            <StatCard label="လက်ခံ စုစုပေါင်း" value={formatMMK(totals.rec)} />
            <StatCard
              label="ကွာခြားချက်"
              value={totals.counted > 0 ? diffBadge(totals.diff) : '—'}
            />
          </div>

          <div className="space-y-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0">
            {employees.map((emp) => {
              const exp = expected.get(emp.id) ?? 0
              const savedRow = saved.get(emp.id)
              const rowState = evaluateHandoverRow(
                receivedIn[emp.id] ?? '',
                exp,
                savedRow !== undefined,
              )
              const expectedChanged = savedRow !== undefined && Number(savedRow.expected) !== exp
              return (
                <Card key={emp.id}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold">{emp.name}</div>
                    {rowState.diff !== null ? (
                      diffBadge(rowState.diff)
                    ) : (
                      <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600 dark:bg-neutral-800 dark:text-neutral-300">
                        မစစ်ရသေး
                      </span>
                    )}
                  </div>
                  <div className="mt-3">
                    <Field label="လက်ခံရငွေ (ကျပ်)">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        value={receivedIn[emp.id] ?? ''}
                        onChange={(e) => setReceivedIn((m) => ({ ...m, [emp.id]: e.target.value }))}
                        className={inputCls}
                        placeholder="ရေတွက်ရငွေ ထည့်ပါ"
                      />
                    </Field>
                  </div>
                  {rowState.revealed && (
                    <div
                      className={`mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm ${
                        rowState.status === 'short'
                          ? 'border border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'
                          : rowState.status === 'over'
                            ? 'border border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
                            : 'bg-stone-50 text-stone-700 dark:bg-neutral-800/60 dark:text-neutral-200'
                      }`}
                    >
                      <span className="tabular-nums">
                        မျှော်မှန်းငွေ: <span className="font-semibold">{formatMMK(exp)}</span>
                      </span>
                      {rowState.diff !== null && (
                        <span className="font-semibold tabular-nums">
                          {rowState.diff === 0
                            ? 'ကိုက်ညီပါတယ်'
                            : rowState.diff < 0
                              ? `လိုနေပါတယ် ${formatMMK(-rowState.diff)}`
                              : `ပိုနေပါတယ် ${formatMMK(rowState.diff)}`}
                        </span>
                      )}
                    </div>
                  )}
                  <input
                    type="text"
                    value={noteIn[emp.id] ?? ''}
                    onChange={(e) => setNoteIn((m) => ({ ...m, [emp.id]: e.target.value }))}
                    className={`${inputCls} mt-2.5`}
                    placeholder="မှတ်ချက် (ရှိလျှင်)"
                  />
                  {expectedChanged && (
                    <p className="mt-2 text-sm font-medium text-accent-700 dark:text-amber-300">
                      ⚠️ သိမ်းထားစဉ် မျှော်မှန်းငွေ {formatMMK(Number(savedRow.expected))} — ယခု
                      မှတ်တမ်းများ ပြောင်းလဲ၍ {formatMMK(exp)} ဖြစ်သွားပါပြီ
                    </p>
                  )}
                  <div className="mt-3 flex items-center gap-3">
                    <PrimaryButton onClick={() => onSave(emp)} disabled={savingId === emp.id}>
                      {savingId === emp.id ? 'သိမ်းနေပါတယ်…' : savedRow ? 'ပြင်မည်' : 'လက်ခံမည်'}
                    </PrimaryButton>
                    {rowMsg[emp.id] && (
                      <span className="text-sm text-stone-500 dark:text-neutral-400">{rowMsg[emp.id]}</span>
                    )}
                  </div>
                </Card>
              )
            })}
            {employees.length === 0 && (
              <div className="lg:col-span-2">
                <EmptyState text="ဝန်ထမ်း မရှိသေးပါ" />
              </div>
            )}
          </div>

          {otherReceivers.length > 0 && (
            <Card className="border-dashed">
              <CardTitle>အခြား လက်ခံသူများ (ငွေအပ်စာရင်း မပါ)</CardTitle>
              <p className="mt-1 text-xs text-stone-500 dark:text-neutral-400">
                ပိုင်ရှင် တိုက်ရိုက်လက်ခံငွေ သို့မဟုတ် ယနေ့ ပိတ်ထားသော ဝန်ထမ်းများ၏ လက်ခံငွေ (ကြည့်ရန်သာ)
              </p>
              <ul className="mt-3 divide-y divide-stone-100 text-sm dark:divide-neutral-800/70">
                {otherReceivers.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{r.name}</span>
                      {r.kind === 'owner' && (
                        <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950/60 dark:text-brand-300">
                          ပိုင်ရှင်
                        </span>
                      )}
                      {r.kind === 'inactive' && (
                        <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600 dark:bg-red-950/40 dark:text-red-400">
                          ပိတ်ထားသည်
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">
                      {formatMMK(r.amount)}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex items-center justify-between border-t border-stone-200/80 pt-2 text-sm font-semibold dark:border-neutral-800">
                <span>စုစုပေါင်း</span>
                <span className="tabular-nums">
                  {formatMMK(otherReceivers.reduce((s, r) => s + r.amount, 0))}
                </span>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
