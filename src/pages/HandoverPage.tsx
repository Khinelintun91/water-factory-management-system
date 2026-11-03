import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { formatMMK, personName, todayYangon, type Role } from '../lib/types'
import {
  Card,
  EmptyState,
  Field,
  LoadingState,
  PageHeader,
  PrimaryButton,
  StatCard,
  inputCls,
} from '../components/ui'

// Cash handover (old ops.ts rule): what an employee should hand over for a
// day = delivery cash they collected (daily_entries.amount_collected where
// they are created_by) + later debt collections they took (agent_payments
// where they are created_by). The received amount is typed in by OM and the
// difference is badged match / short / over.

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
  const [expected, setExpected] = useState<Map<string, number>>(new Map())
  const [saved, setSaved] = useState<Map<string, HandoverRow>>(new Map())
  const [receivedIn, setReceivedIn] = useState<Record<string, string>>({})
  const [noteIn, setNoteIn] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const [{ data: profs, error: pErr }, { data: roleRows, error: rErr }] = await Promise.all([
        supabase.from('profiles').select('id, username, display_name, role, active').eq('active', true).order('username'),
        supabase.from('user_roles').select('profile_id, role'),
      ])
      if (pErr) throw new Error(pErr.message)
      if (rErr) throw new Error(rErr.message)
      const extra = new Map<string, Role[]>()
      for (const r of (roleRows ?? []) as { profile_id: string; role: Role }[]) {
        extra.set(r.profile_id, [...(extra.get(r.profile_id) ?? []), r.role])
      }
      const emps: EmployeeLite[] = (
        (profs ?? []) as { id: string; username: string; display_name?: string | null; role: Role }[]
      )
        .filter((p) => [p.role, ...(extra.get(p.id) ?? [])].some((r) => STAFF_ROLES.includes(r)))
        .map((p) => ({ id: p.id, name: personName(p) }))
      setEmployees(emps)

      const [entryRows, paymentRows, handoverRows] = await Promise.all([
        fetchDay<{ created_by: string | null; amount_collected: number }>(
          'daily_entries',
          'created_by, amount_collected',
          'entry_date',
          date,
        ),
        fetchDay<{ created_by: string | null; amount: number }>(
          'agent_payments',
          'created_by, amount',
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
        if (!e.created_by) continue
        exp.set(e.created_by, (exp.get(e.created_by) ?? 0) + Number(e.amount_collected))
      }
      for (const p of paymentRows) {
        if (!p.created_by) continue
        exp.set(p.created_by, (exp.get(p.created_by) ?? 0) + Number(p.amount))
      }
      setExpected(exp)

      const savedMap = new Map(handoverRows.map((h) => [h.employee_id, h]))
      setSaved(savedMap)
      setReceivedIn(Object.fromEntries(handoverRows.map((h) => [h.employee_id, String(h.received)])))
      setNoteIn(Object.fromEntries(handoverRows.map((h) => [h.employee_id, h.note ?? ''])))
      setRowMsg({})
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [date])

  useEffect(() => {
    load()
  }, [load])

  async function onSave(emp: EmployeeLite) {
    if (!profile) return
    const received = Number(receivedIn[emp.id] ?? '')
    if (!Number.isFinite(received) || received < 0) {
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
      setRowMsg((m) => ({ ...m, [emp.id]: error.message }))
      return
    }
    setRowMsg((m) => ({ ...m, [emp.id]: 'သိမ်းပြီးပါပြီ ✓' }))
    await load()
  }

  const totals = useMemo(() => {
    let exp = 0
    let rec = 0
    for (const e of employees) {
      exp += expected.get(e.id) ?? 0
      const v = Number(receivedIn[e.id] ?? '')
      if (Number.isFinite(v)) rec += v
    }
    return { exp, rec, diff: rec - exp }
  }, [employees, expected, receivedIn])

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

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      {loading ? (
        <LoadingState />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2.5">
            <StatCard label="မျှော်မှန်း စုစုပေါင်း" value={formatMMK(totals.exp)} />
            <StatCard label="လက်ခံ စုစုပေါင်း" value={formatMMK(totals.rec)} />
            <StatCard label="ကွာခြားချက်" value={diffBadge(totals.diff)} />
          </div>

          <div className="space-y-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0">
            {employees.map((emp) => {
              const exp = expected.get(emp.id) ?? 0
              const receivedVal = Number(receivedIn[emp.id] ?? '')
              const diff = Number.isFinite(receivedVal) ? receivedVal - exp : 0
              const savedRow = saved.get(emp.id)
              const expectedChanged = savedRow !== undefined && Number(savedRow.expected) !== exp
              return (
                <Card key={emp.id}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold">{emp.name}</div>
                    {diffBadge(diff)}
                  </div>
                  <div className="mt-3 grid grid-cols-2 items-end gap-2.5">
                    <div>
                      <span className="text-sm text-stone-500 dark:text-neutral-400">မျှော်မှန်းငွေ</span>
                      <div className="mt-1 font-semibold tabular-nums">{formatMMK(exp)}</div>
                    </div>
                    <Field label="လက်ခံရငွေ (ကျပ်)">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        value={receivedIn[emp.id] ?? ''}
                        onChange={(e) => setReceivedIn((m) => ({ ...m, [emp.id]: e.target.value }))}
                        className={inputCls}
                        placeholder="0"
                      />
                    </Field>
                  </div>
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
                      {savingId === emp.id ? 'သိမ်းနေပါတယ်…' : savedRow ? 'ပြန်သိမ်းရန်' : 'သိမ်းရန်'}
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
        </>
      )}
    </div>
  )
}
