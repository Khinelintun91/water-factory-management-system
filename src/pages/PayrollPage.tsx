import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import {
  formatMMK,
  todayYangon,
  ROLE_LABELS,
  type Advance,
  type AdvanceRepayment,
  type Bonus,
  type PayrollRun,
  type Profile,
  type Role,
  type SalarySetting,
} from '../lib/types'
import {
  Card,
  EmptyState,
  Field,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  inputCls,
} from '../components/ui'

const MONTH_NAMES = [
  'ဇန်နဝါရီ', 'ဖေဖော်ဝါရီ', 'မတ်', 'ဧပြီ', 'မေ', 'ဇွန်',
  'ဇူလိုင်', 'ဩဂုတ်', 'စက်တင်ဘာ', 'အောက်တိုဘာ', 'နိုဝင်ဘာ', 'ဒီဇင်ဘာ',
]

/** Month options: current Yangon month + the 12 before it. */
function monthOptions(): { value: string; label: string }[] {
  const [y, m] = todayYangon().split('-').map(Number)
  const out: { value: string; label: string }[] = []
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

/** Primary role + user_roles extras; co_owner implies manager (mirrors AuthContext). */
function effectiveRoles(primary: Role, extras: Role[]): Role[] {
  const set = new Set<Role>([primary, ...extras])
  if (set.has('co_owner')) set.add('manager')
  return [...set]
}

/** Turn pay_month RPC errors into a readable Burmese message. */
function readablePayError(message: string, month: string): string {
  if (message.startsWith('already_paid:')) return message.slice('already_paid:'.length).trim()
  if (message.startsWith('month_locked:')) {
    const [y, m] = month.split('-').map(Number)
    return `${MONTH_NAMES[m - 1]} ${y} လ ပိတ်ထားပြီး ဖြစ်လို့ လစာ ပေးလို့ မရပါ`
  }
  if (message.startsWith('forbidden')) return 'ပိုင်ရှင် / မန်နေဂျာ သာ လစာ ပေးနိုင်ပါတယ်'
  return message
}

interface AdvanceView extends Advance {
  repaidTotal: number
  remainingNow: number
  /** Deduction this advance contributes to the viewed month (null = none). */
  planAmount: number | null
  /** True when it has a repayment recorded in the viewed month. */
  repaidThisMonth: boolean
}

interface UserPayroll {
  user: Profile
  roles: Role[]
  base: number
  bonuses: Bonus[]
  bonusTotal: number
  advances: AdvanceView[]
  /** Advances still owed, all remaining incl. future-dated (old-app rule). */
  outstanding: number
  deduction: number
  net: number
  run: PayrollRun | null
}

export default function PayrollPage() {
  const [month, setMonth] = useState(() => todayYangon().slice(0, 7))
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [extras, setExtras] = useState<{ profile_id: string; role: Role }[]>([])
  const [salaries, setSalaries] = useState<SalarySetting[]>([])
  const [bonuses, setBonuses] = useState<Bonus[]>([])
  const [advances, setAdvances] = useState<Advance[]>([])
  const [repayments, setRepayments] = useState<AdvanceRepayment[]>([])
  const [runs, setRuns] = useState<PayrollRun[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const [pf, ur, sal, bon, adv, rep, run] = await Promise.all([
        supabase.from('profiles').select('id, username, role, agent_id, active').eq('active', true).order('username'),
        supabase.from('user_roles').select('profile_id, role'),
        supabase.from('salary_settings').select('*'),
        supabase.from('bonuses').select('*').eq('month', month).order('created_at'),
        supabase.from('advances').select('*').order('advance_date'),
        supabase.from('advance_repayments').select('*'),
        supabase.from('payroll_runs').select('*').eq('month', month),
      ])
      for (const r of [pf, ur, sal, bon, adv, rep, run]) {
        if (r.error) throw new Error(r.error.message)
      }
      setProfiles((pf.data ?? []) as Profile[])
      setExtras((ur.data ?? []) as { profile_id: string; role: Role }[])
      setSalaries((sal.data ?? []) as SalarySetting[])
      setBonuses((bon.data ?? []) as Bonus[])
      setAdvances((adv.data ?? []) as Advance[])
      setRepayments((rep.data ?? []) as AdvanceRepayment[])
      setRuns((run.data ?? []) as PayrollRun[])
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [month])

  useEffect(() => {
    load()
  }, [load])

  // Port of the old app's computePayroll: population = active users whose
  // effective roles include staff/manager/co_owner (primary owner and agent
  // accounts excluded); deduction plan and outstanding mirror the RPC.
  const rows = useMemo<UserPayroll[]>(() => {
    const extrasByUser = new Map<string, Role[]>()
    for (const r of extras) {
      const list = extrasByUser.get(r.profile_id) ?? []
      list.push(r.role)
      extrasByUser.set(r.profile_id, list)
    }
    const population = profiles.filter((p) => {
      if (p.role === 'owner' || p.role === 'agent') return false
      const roles = effectiveRoles(p.role, extrasByUser.get(p.id) ?? [])
      return roles.includes('staff') || roles.includes('manager') || roles.includes('co_owner')
    })
    return population.map((user) => {
      const roles = effectiveRoles(user.role, extrasByUser.get(user.id) ?? [])
      const myBonuses = bonuses.filter((b) => b.user_id === user.id)
      const bonusTotal = myBonuses.reduce((s, b) => s + b.amount, 0)
      const salaryBase =
        salaries.find((s) => s.user_id === user.id)?.monthly_salary ?? 0

      let outstanding = 0
      let deduction = 0
      const advanceViews: AdvanceView[] = advances
        .filter((a) => a.user_id === user.id)
        .map((a) => {
          const reps = repayments.filter((r) => r.advance_id === a.id)
          const repaidTotal = reps.reduce((s, r) => s + r.amount, 0)
          const paidOtherMonths = reps
            .filter((r) => r.month !== month)
            .reduce((s, r) => s + r.amount, 0)
          const remaining = a.amount - paidOtherMonths
          let planAmount: number | null = null
          if (remaining > 0) {
            outstanding += remaining
            if (a.advance_date.slice(0, 7) <= month) {
              planAmount =
                a.installment > 0 ? Math.min(a.installment, remaining) : remaining
              deduction += planAmount
            }
          }
          return {
            ...a,
            repaidTotal,
            remainingNow: a.amount - repaidTotal,
            planAmount,
            repaidThisMonth: reps.some((r) => r.month === month),
          }
        })

      const run = runs.find((r) => r.user_id === user.id) ?? null
      return {
        user,
        roles,
        base: run ? run.base : salaryBase,
        bonuses: myBonuses,
        bonusTotal: run ? run.bonus : bonusTotal,
        advances: advanceViews,
        outstanding,
        deduction: run ? run.deduction : deduction,
        net: run ? run.net : salaryBase + bonusTotal - deduction,
        run,
      }
    })
  }, [profiles, extras, salaries, bonuses, advances, repayments, runs, month])

  const options = useMemo(monthOptions, [])

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="လစာ စီမံခန့်ခွဲမှု"
        subtitle="ဝန်ထမ်းများ၏ လစဉ် လစာ၊ အပိုဆုနှင့် ကြိုတင်ငွေ စီမံရန်"
      />
      <p className="text-sm text-stone-500 dark:text-neutral-400">
        ဝန်ထမ်းများ၏ လစဉ် လစာ၊ အပိုဆု နှင့် ကြိုတင်ငွေ ဖြတ်တောက်မှုများကို ဒီနေရာမှာ
        စီမံပြီး လကုန်မှာ လစာ ပေးနိုင်ပါတယ်။
      </p>

      <Field label="လ ရွေးရန်" className="max-w-xs">
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className={inputCls}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      {msg && <p className="text-sm text-red-600">{msg}</p>}
      {okMsg && <p className="text-sm font-medium text-brand-700 dark:text-brand-400">{okMsg}</p>}

      {loading ? (
        <LoadingState />
      ) : (
        <div className="space-y-3 lg:space-y-4">
          {rows.map((row) => (
            <PayrollCard
              key={row.user.id}
              row={row}
              month={month}
              salarySetting={
                salaries.find((s) => s.user_id === row.user.id)?.monthly_salary ?? 0
              }
              onChanged={load}
              onError={setMsg}
              onPaid={(name) => {
                setOkMsg(`${name} ၏ လစာ ပေးပြီးပါပြီ`)
                load()
              }}
            />
          ))}
          {rows.length === 0 && <EmptyState text="လစာ ရမည့် ဝန်ထမ်း မရှိသေးပါ" />}
        </div>
      )}
    </div>
  )
}

function PayrollCard({
  row,
  month,
  salarySetting,
  onChanged,
  onError,
  onPaid,
}: {
  row: UserPayroll
  month: string
  salarySetting: number
  onChanged: () => Promise<void>
  onError: (m: string | null) => void
  onPaid: (username: string) => void
}) {
  const paid = row.run !== null
  const [salaryDraft, setSalaryDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Bonus form.
  const [bonusAmount, setBonusAmount] = useState('')
  const [bonusNote, setBonusNote] = useState('')
  const [confirmBonusId, setConfirmBonusId] = useState<string | null>(null)

  // Advance form.
  const [advDate, setAdvDate] = useState(todayYangon())
  const [advAmount, setAdvAmount] = useState('')
  const [advMode, setAdvMode] = useState<'once' | 'monthly'>('once')
  const [advInstallment, setAdvInstallment] = useState('')
  const [advNote, setAdvNote] = useState('')
  const [confirmAdvanceId, setConfirmAdvanceId] = useState<string | null>(null)

  // Pay confirm.
  const [confirmPay, setConfirmPay] = useState(false)

  const salaryValue = salaryDraft ?? String(salarySetting || '')

  async function saveSalary() {
    if (busy) return
    setBusy(true)
    onError(null)
    const { error } = await supabase
      .from('salary_settings')
      .upsert(
        { user_id: row.user.id, monthly_salary: Number(salaryValue) || 0 },
        { onConflict: 'user_id' },
      )
    if (error) onError(error.message)
    else {
      setSalaryDraft(null)
      await onChanged()
    }
    setBusy(false)
  }

  async function addBonus(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const amount = Number(bonusAmount) || 0
    if (amount <= 0) {
      onError('အပိုဆု ပမာဏ မှန်ကန်စွာ ထည့်ပါ')
      return
    }
    setBusy(true)
    onError(null)
    const { error } = await supabase.from('bonuses').insert({
      user_id: row.user.id,
      month,
      amount,
      note: bonusNote.trim() || null,
    })
    if (error) onError(error.message)
    else {
      setBonusAmount('')
      setBonusNote('')
      await onChanged()
    }
    setBusy(false)
  }

  async function deleteBonus(b: Bonus) {
    if (busy) return
    setBusy(true)
    onError(null)
    const { error } = await supabase.from('bonuses').delete().eq('id', b.id)
    if (error) onError(error.message)
    setConfirmBonusId(null)
    await onChanged()
    setBusy(false)
  }

  async function addAdvance(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const amount = Number(advAmount) || 0
    const installment = advMode === 'monthly' ? Number(advInstallment) || 0 : 0
    if (amount <= 0) {
      onError('ကြိုတင်ငွေ ပမာဏ မှန်ကန်စွာ ထည့်ပါ')
      return
    }
    if (advMode === 'monthly' && installment <= 0) {
      onError('လစဉ် ဖြတ်မည့် ပမာဏ ထည့်ပါ')
      return
    }
    setBusy(true)
    onError(null)
    const { error } = await supabase.from('advances').insert({
      user_id: row.user.id,
      advance_date: advDate,
      amount,
      installment,
      note: advNote.trim() || null,
    })
    if (error) onError(error.message)
    else {
      setAdvAmount('')
      setAdvInstallment('')
      setAdvNote('')
      await onChanged()
    }
    setBusy(false)
  }

  async function deleteAdvance(a: AdvanceView) {
    if (busy) return
    setBusy(true)
    onError(null)
    const { error } = await supabase.from('advances').delete().eq('id', a.id)
    if (error) onError(error.message)
    setConfirmAdvanceId(null)
    await onChanged()
    setBusy(false)
  }

  async function pay() {
    if (busy) return
    setBusy(true)
    onError(null)
    const { error } = await supabase.rpc('pay_month', {
      p_user: row.user.id,
      p_month: month,
    })
    setConfirmPay(false)
    setBusy(false)
    if (error) onError(readablePayError(error.message, month))
    else onPaid(row.user.username)
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="font-semibold">{row.user.username}</span>
          <span className="ml-2 text-xs text-stone-500 dark:text-neutral-400">
            {row.roles.map((r) => ROLE_LABELS[r]).join(' · ')}
          </span>
        </div>
        {paid && (
          <span className="rounded-full bg-brand-700 px-2.5 py-1 text-xs font-semibold text-white">
            ပေးပြီး
          </span>
        )}
      </div>

      {/* Salary setting */}
      <div className="flex items-end gap-2">
        <Field label="လစဉ် အခြေခံလစာ (ကျပ်)" className="flex-1">
          <input
            value={salaryValue}
            onChange={(e) => setSalaryDraft(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            className={inputCls}
          />
        </Field>
        <SecondaryButton
          size="sm"
          onClick={saveSalary}
          disabled={busy || salaryDraft === null}
          className="shrink-0"
        >
          သိမ်းရန်
        </SecondaryButton>
      </div>

      {/* Summary (preview or stored run figures) */}
      <div className="grid grid-cols-2 gap-2 rounded-xl bg-stone-100/70 p-3 text-sm dark:bg-neutral-800/50">
        <div>
          <span className="text-stone-500 dark:text-neutral-400">အခြေခံလစာ</span>
          <div className="font-medium tabular-nums">{formatMMK(row.base)}</div>
        </div>
        <div>
          <span className="text-stone-500 dark:text-neutral-400">အပိုဆု</span>
          <div className="font-medium tabular-nums">+ {formatMMK(row.bonusTotal)}</div>
        </div>
        <div>
          <span className="text-stone-500 dark:text-neutral-400">ကြိုတင်ငွေ ဖြတ်မည်</span>
          <div className="font-medium tabular-nums">− {formatMMK(row.deduction)}</div>
        </div>
        <div>
          <span className="text-stone-500 dark:text-neutral-400">ကြိုတင်ငွေ ကျန်ရှိ</span>
          <div className="font-medium tabular-nums">{formatMMK(row.outstanding)}</div>
        </div>
        <div className="col-span-2 flex items-center justify-between border-t border-stone-200 pt-2 dark:border-neutral-700">
          <span className="font-semibold">{paid ? 'ပေးခဲ့သော စုစုပေါင်း' : 'ပေးရမည့် စုစုပေါင်း'}</span>
          <span className="text-base font-bold tabular-nums">{formatMMK(row.net)}</span>
        </div>
      </div>

      {/* Bonuses for this month */}
      <div className="space-y-2">
        <div className="text-sm font-semibold">အပိုဆုများ (ဒီလ)</div>
        <ul className="divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200/80 dark:divide-neutral-800/70 dark:border-neutral-800">
          {row.bonuses.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <span>
                {formatMMK(b.amount)}
                {b.note ? (
                  <span className="text-stone-500 dark:text-neutral-400"> · {b.note}</span>
                ) : null}
              </span>
              {!paid &&
                (confirmBonusId === b.id ? (
                  <span className="flex gap-1">
                    <button
                      onClick={() => deleteBonus(b)}
                      disabled={busy}
                      className="flex min-h-[44px] items-center rounded-lg px-2 font-semibold text-red-600"
                    >
                      သေချာပါတယ်, ဖျက်မည်
                    </button>
                    <button
                      onClick={() => setConfirmBonusId(null)}
                      className="flex min-h-[44px] items-center rounded-lg px-2 text-stone-500 dark:text-neutral-400"
                    >
                      မဖျက်တော့ပါ
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmBonusId(b.id)}
                    className="flex min-h-[44px] items-center rounded-lg px-2 text-red-600"
                  >
                    ဖျက်ရန်
                  </button>
                ))}
            </li>
          ))}
          {row.bonuses.length === 0 && (
            <li className="p-3 text-sm text-stone-500 dark:text-neutral-400">အပိုဆု မရှိသေးပါ</li>
          )}
        </ul>
        {!paid && (
          <form onSubmit={addBonus} className="grid grid-cols-2 gap-2.5">
            <Field label="ပမာဏ (ကျပ်)">
              <input
                value={bonusAmount}
                onChange={(e) => setBonusAmount(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                required
                className={inputCls}
              />
            </Field>
            <Field label="မှတ်ချက်">
              <input
                value={bonusNote}
                onChange={(e) => setBonusNote(e.target.value)}
                className={inputCls}
              />
            </Field>
            <SecondaryButton type="submit" disabled={busy} className="col-span-2">
              အပိုဆု ထည့်ရန်
            </SecondaryButton>
          </form>
        )}
      </div>

      {/* Advances */}
      <div className="space-y-2">
        <div className="text-sm font-semibold">ကြိုတင်ငွေများ</div>
        <ul className="divide-y divide-stone-100 overflow-hidden rounded-xl border border-stone-200/80 dark:divide-neutral-800/70 dark:border-neutral-800">
          {row.advances.map((a) => (
            <li key={a.id} className="p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium tabular-nums">{formatMMK(a.amount)}</span>
                <span className="text-stone-500 dark:text-neutral-400">{a.advance_date}</span>
              </div>
              <div className="text-stone-600 dark:text-neutral-300">
                {a.installment > 0
                  ? `လစဉ် ${formatMMK(a.installment)} ဖြတ်မည်`
                  : 'တစ်ခါတည်း အပြည့် ဖြတ်မည်'}
                {` · ပြန်ဆပ်ပြီး ${formatMMK(a.repaidTotal)} · ကျန် ${formatMMK(a.remainingNow)}`}
                {a.note ? ` · ${a.note}` : ''}
              </div>
              {!paid && a.planAmount !== null && (
                <div className="text-stone-600 dark:text-neutral-300">
                  ဒီလ ဖြတ်မည်: {formatMMK(a.planAmount)}
                </div>
              )}
              {confirmAdvanceId === a.id ? (
                <div className="mt-1 space-y-1">
                  <p className="text-red-600">
                    ဒီကြိုတင်ငွေကို ဖျက်ရင် သူ့ ပြန်ဆပ်မှတ်တမ်းတွေပါ အကုန် ပျက်ပါမယ်။
                    ဆက်ဖျက်မလား?
                  </p>
                  <span className="flex gap-1">
                    <button
                      onClick={() => deleteAdvance(a)}
                      disabled={busy}
                      className="flex min-h-[44px] items-center rounded-lg px-2 font-semibold text-red-600"
                    >
                      သေချာပါတယ်, ဖျက်မည်
                    </button>
                    <button
                      onClick={() => setConfirmAdvanceId(null)}
                      className="flex min-h-[44px] items-center rounded-lg px-2 text-stone-500 dark:text-neutral-400"
                    >
                      မဖျက်တော့ပါ
                    </button>
                  </span>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmAdvanceId(a.id)}
                  disabled={paid && a.repaidThisMonth}
                  className="mt-1 flex min-h-[44px] items-center rounded-lg px-2 text-red-600 disabled:opacity-40"
                >
                  ဖျက်ရန်
                </button>
              )}
            </li>
          ))}
          {row.advances.length === 0 && (
            <li className="p-3 text-sm text-stone-500 dark:text-neutral-400">ကြိုတင်ငွေ မရှိသေးပါ</li>
          )}
        </ul>
        <form onSubmit={addAdvance} className="grid grid-cols-2 gap-2.5">
          <Field label="ရက်စွဲ">
            <input
              type="date"
              value={advDate}
              onChange={(e) => setAdvDate(e.target.value)}
              required
              className={inputCls}
            />
          </Field>
          <Field label="ပမာဏ (ကျပ်)">
            <input
              value={advAmount}
              onChange={(e) => setAdvAmount(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              required
              className={inputCls}
            />
          </Field>
          <Field label="ပြန်ဆပ်ပုံ">
            <select
              value={advMode}
              onChange={(e) => setAdvMode(e.target.value as 'once' | 'monthly')}
              className={inputCls}
            >
              <option value="once">တစ်ခါတည်း အပြည့် ဖြတ်မည်</option>
              <option value="monthly">လစဉ် ခွဲဖြတ်မည်</option>
            </select>
          </Field>
          {advMode === 'monthly' ? (
            <Field label="လစဉ် ဖြတ်မည့် ပမာဏ (ကျပ်)">
              <input
                value={advInstallment}
                onChange={(e) => setAdvInstallment(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                required
                className={inputCls}
              />
            </Field>
          ) : (
            <Field label="မှတ်ချက်">
              <input
                value={advNote}
                onChange={(e) => setAdvNote(e.target.value)}
                className={inputCls}
              />
            </Field>
          )}
          {advMode === 'monthly' && (
            <Field label="မှတ်ချက်" className="col-span-2">
              <input
                value={advNote}
                onChange={(e) => setAdvNote(e.target.value)}
                className={inputCls}
              />
            </Field>
          )}
          <SecondaryButton type="submit" disabled={busy} className="col-span-2">
            ကြိုတင်ငွေ ထည့်ရန်
          </SecondaryButton>
        </form>
      </div>

      {/* Pay */}
      {!paid &&
        (confirmPay ? (
          <div className="space-y-2 rounded-xl border border-brand-600 p-3 dark:border-brand-800">
            <p className="text-sm">
              {row.user.username} ကို {formatMMK(row.net)} ပေးမှာ သေချာပါသလား? ပေးပြီးရင်
              ပြန်ပြင်လို့ မရပါ။
            </p>
            <div className="flex gap-2">
              <PrimaryButton onClick={pay} disabled={busy} className="flex-1">
                သေချာပါတယ်, ပေးမည်
              </PrimaryButton>
              <SecondaryButton
                onClick={() => setConfirmPay(false)}
                disabled={busy}
                className="flex-1"
              >
                မပေးတော့ပါ
              </SecondaryButton>
            </div>
          </div>
        ) : (
          <PrimaryButton
            onClick={() => setConfirmPay(true)}
            disabled={busy}
            className="w-full"
          >
            လစာ ပေးရန် — {formatMMK(row.net)}
          </PrimaryButton>
        ))}
    </Card>
  )
}
