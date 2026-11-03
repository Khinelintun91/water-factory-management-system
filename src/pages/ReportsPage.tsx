import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchAll } from '../lib/fetchAll'
import { formatMMK, todayYangon, type Agent } from '../lib/types'

// Row shapes read by this page (defined locally, like the other pages).
interface EntryLite {
  id: string
  agent_id: string | null
  agent_name: string | null
  entry_date: string
  delivered_qty: number
  returned_qty: number
  amount: number
  amount_collected: number
  created_at: string
}

interface PaymentLite {
  id: string
  agent_id: string | null
  agent_name: string | null
  payment_date: string
  amount: number
}

interface WriteOffLite {
  id: string
  agent_id: string | null
  agent_name: string | null
  writeoff_date: string
  amount: number
}

interface DepositLite {
  id: string
  agent_id: string | null
  agent_name: string | null
  deposit_date: string
  amount: number
}

interface SettlementLite {
  id: string
  agent_id: string | null
  agent_name: string | null
  settle_date: string
  forfeiture_income: number
  net_refund: number
}

interface ExpenseLite {
  id: string
  expense_date: string
  category_id: string | null
  amount: number
}

interface RunLite {
  id: string
  month: string
  base: number
  bonus: number
}

interface CategoryLite {
  id: string
  name: string
}

type Bucket = 'd30' | 'd60' | 'd60p'

interface AgingRow {
  bucket: Bucket
  agent: string
  date: string
  days: number
  amount: number
}

interface AgentReport {
  id: string
  name: string
  closed: boolean
  deleted: boolean
  sales: number
  collected: number
  writeOff: number
  receivable: number
  bottles: number
  deposit: number
}

interface Report {
  sales: number
  collected: number
  writeOffs: number
  expenseTotal: number
  byCategory: { name: string; total: number }[]
  payroll: number
  profit: number
  forfeitureIncome: number
  refunds: number
  depositLiability: number
  receivable: number
  aging: Record<Bucket, number>
  agingRows: AgingRow[]
  perAgent: AgentReport[]
}

interface TrendRow {
  month: string
  sales: number
  costs: number
  profit: number
}

/** Last day (YYYY-MM-DD) of the month containing a YYYY-MM-DD date. */
function monthEnd(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}

/** The `count` months ending at endMonth ('YYYY-MM'), ascending. */
function monthList(endMonth: string, count: number): string[] {
  const y = Number(endMonth.slice(0, 4))
  const m = Number(endMonth.slice(5, 7))
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

const BUCKET_LABELS: Record<Bucket, string> = {
  d30: 'ရက် ၃၀ အတွင်း',
  d60: 'ရက် ၃၁–၆၀',
  d60p: 'ရက် ၆၀ ကျော်',
}

export default function ReportsPage() {
  const today = todayYangon()
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`)
  const [to, setTo] = useState(monthEnd(today))
  const [applied, setApplied] = useState({ from, to })

  const [agents, setAgents] = useState<Agent[]>([])
  const [entries, setEntries] = useState<EntryLite[]>([])
  const [expenses, setExpenses] = useState<ExpenseLite[]>([])
  const [categories, setCategories] = useState<CategoryLite[]>([])
  const [writeOffs, setWriteOffs] = useState<WriteOffLite[]>([])
  const [runs, setRuns] = useState<RunLite[]>([])
  const [payments, setPayments] = useState<PaymentLite[]>([])
  const [deposits, setDeposits] = useState<DepositLite[]>([])
  const [settlements, setSettlements] = useState<SettlementLite[]>([])
  const [trendExpenses, setTrendExpenses] = useState<ExpenseLite[]>([])
  const [trendRuns, setTrendRuns] = useState<RunLite[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [showAgingDetail, setShowAgingDetail] = useState(false)
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const { from: f, to: t } = applied
      const trendMonths = monthList(t.slice(0, 7), 12)
      const trendFrom = `${trendMonths[0]}-01`
      const [
        ag, en, ex, ct, wo, rn, pm, dp, st, tEx, tRn,
      ] = await Promise.all([
        supabase.from('agents').select('*').order('name'),
        fetchAll<EntryLite>((a, b) =>
          supabase
            .from('daily_entries')
            .select('id, agent_id, agent_name, entry_date, delivered_qty, returned_qty, amount, amount_collected, created_at')
            .lte('entry_date', t)
            .order('entry_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<ExpenseLite>((a, b) =>
          supabase
            .from('expenses')
            .select('id, expense_date, category_id, amount')
            .gte('expense_date', f)
            .lte('expense_date', t)
            .order('expense_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        supabase.from('expense_categories').select('id, name').order('name'),
        fetchAll<WriteOffLite>((a, b) =>
          supabase
            .from('write_offs')
            .select('id, agent_id, agent_name, writeoff_date, amount')
            .lte('writeoff_date', t)
            .order('writeoff_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<RunLite>((a, b) =>
          supabase
            .from('payroll_runs')
            .select('id, month, base, bonus')
            .gte('month', f.slice(0, 7))
            .lte('month', t.slice(0, 7))
            .order('month', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<PaymentLite>((a, b) =>
          supabase
            .from('agent_payments')
            .select('id, agent_id, agent_name, payment_date, amount')
            .lte('payment_date', t)
            .order('payment_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<DepositLite>((a, b) =>
          supabase
            .from('agent_deposits')
            .select('id, agent_id, agent_name, deposit_date, amount')
            .lte('deposit_date', t)
            .order('deposit_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<SettlementLite>((a, b) =>
          supabase
            .from('agent_settlements')
            .select('id, agent_id, agent_name, settle_date, forfeiture_income, net_refund')
            .lte('settle_date', t)
            .order('settle_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<ExpenseLite>((a, b) =>
          supabase
            .from('expenses')
            .select('id, expense_date, category_id, amount')
            .gte('expense_date', trendFrom)
            .lte('expense_date', t)
            .order('expense_date', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
        fetchAll<RunLite>((a, b) =>
          supabase
            .from('payroll_runs')
            .select('id, month, base, bonus')
            .gte('month', trendMonths[0])
            .lte('month', trendMonths[trendMonths.length - 1])
            .order('month', { ascending: true })
            .order('created_at', { ascending: true })
            .range(a, b),
        ),
      ])
      if (ag.error) throw new Error(ag.error.message)
      if (ct.error) throw new Error(ct.error.message)
      setAgents((ag.data ?? []) as Agent[])
      setCategories((ct.data ?? []) as CategoryLite[])
      setEntries(en)
      setExpenses(ex)
      setWriteOffs(wo)
      setRuns(rn)
      setPayments(pm)
      setDeposits(dp)
      setSettlements(st)
      setTrendExpenses(tEx)
      setTrendRuns(tRn)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [applied])

  useEffect(() => {
    load()
  }, [load])

  // Port of the old app's getReport (phase2.functions.ts), on this repo's
  // column names: entry.amount is the server-computed delivered x unit price.
  const report = useMemo<Report>(() => {
    const { from: f, to: t } = applied
    const inRange = (d: string) => d >= f && d <= t
    const toMs = new Date(t).getTime()
    const key = (r: { agent_id: string | null; agent_name: string | null }) =>
      r.agent_id ?? `deleted:${r.agent_name}`

    const groups = new Map<
      string,
      { id: string; name: string; closed: boolean; deleted: boolean }
    >()
    for (const a of agents) {
      groups.set(a.id, { id: a.id, name: a.name, closed: !!a.closed_at, deleted: false })
    }
    for (const r of [...entries, ...writeOffs, ...payments, ...deposits, ...settlements]) {
      if (!r.agent_id && !groups.has(key(r))) {
        groups.set(key(r), {
          id: key(r),
          name: `${r.agent_name ?? '—'} (ဖျက်ပြီး)`,
          closed: true,
          deleted: true,
        })
      }
    }

    const sumAmt = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0)

    let sales = 0
    let collectedEntries = 0
    let writeOffTotal = 0
    let paymentsTotal = 0
    let forfeitureIncome = 0
    let refunds = 0
    let depositLiability = 0
    const aging: Record<Bucket, number> = { d30: 0, d60: 0, d60p: 0 }
    const agingRows: AgingRow[] = []

    const perAgent: AgentReport[] = [...groups.values()].map((g) => {
      const ae = entries.filter((e) => key(e) === g.id)
      let allSales = 0
      let allColl = 0
      let rSales = 0
      let rColl = 0
      let bottles = 0
      for (const e of ae) {
        allSales += e.amount
        allColl += e.amount_collected
        bottles += e.delivered_qty - e.returned_qty
        if (inRange(e.entry_date)) {
          rSales += e.amount
          rColl += e.amount_collected
        }
      }
      const aw = writeOffs.filter((w) => key(w) === g.id)
      const allWo = sumAmt(aw)
      const rWo = sumAmt(aw.filter((w) => inRange(w.writeoff_date)))
      const ap = payments.filter((p) => key(p) === g.id)
      const allPaid = sumAmt(ap)
      const rPaid = sumAmt(ap.filter((p) => inRange(p.payment_date)))

      const receivable = Math.max(0, allSales - allColl - allPaid - allWo)
      // Aging: outstanding assigned to the newest sales first.
      let left = receivable
      for (const e of [...ae].reverse()) {
        if (left <= 0) break
        const s = Math.min(left, e.amount)
        if (s <= 0) continue
        left -= s
        const days = (toMs - new Date(e.entry_date).getTime()) / 86400000
        const bucket: Bucket = days <= 30 ? 'd30' : days <= 60 ? 'd60' : 'd60p'
        aging[bucket] += s
        agingRows.push({
          bucket,
          agent: g.name,
          date: e.entry_date,
          days: Math.max(0, Math.round(days)),
          amount: s,
        })
      }

      const st = settlements.find((s) => key(s) === g.id)
      const deposit = st
        ? 0
        : sumAmt(deposits.filter((d) => key(d) === g.id))
      if (st && inRange(st.settle_date)) {
        forfeitureIncome += st.forfeiture_income
        refunds += st.net_refund
      }
      sales += rSales
      collectedEntries += rColl
      writeOffTotal += rWo
      paymentsTotal += rPaid
      depositLiability += deposit
      if (st) bottles = 0
      return {
        id: g.id,
        name: g.name,
        closed: g.closed,
        deleted: g.deleted,
        sales: rSales,
        collected: rColl + rPaid,
        writeOff: rWo,
        receivable,
        bottles,
        deposit,
      }
    })

    const catName = new Map(categories.map((c) => [c.id, c.name]))
    const catTotals = new Map<string, number>()
    for (const e of expenses) {
      const name = (e.category_id && catName.get(e.category_id)) || 'အမျိုးအစား မသတ်မှတ်'
      catTotals.set(name, (catTotals.get(name) ?? 0) + e.amount)
    }
    const byCategory = [...catTotals.entries()]
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total)
    const expenseTotal = byCategory.reduce((s, c) => s + c.total, 0)

    const payroll = runs.reduce((s, r) => s + r.base + r.bonus, 0)
    const profit = sales + forfeitureIncome - expenseTotal - payroll - writeOffTotal

    agingRows.sort((a, b) => b.days - a.days || b.amount - a.amount)
    perAgent.sort((a, b) => b.receivable - a.receivable || a.name.localeCompare(b.name))

    return {
      sales,
      collected: collectedEntries + paymentsTotal,
      writeOffs: writeOffTotal,
      expenseTotal,
      byCategory,
      payroll,
      profit,
      forfeitureIncome,
      refunds,
      depositLiability,
      receivable: perAgent.reduce((s, a) => s + a.receivable, 0),
      aging,
      agingRows,
      perAgent,
    }
  }, [agents, entries, expenses, categories, writeOffs, runs, payments, deposits, settlements, applied])

  // Port of buildMonthlyTrend (monthly-trend.ts) for the 12 months ending at
  // the applied `to` month.
  const trend = useMemo<TrendRow[]>(() => {
    const months = monthList(applied.to.slice(0, 7), 12)
    const acc = new Map(months.map((m) => [m, { sales: 0, costs: 0, extra: 0 }]))
    const add = (dateStr: string, fn: (r: { sales: number; costs: number; extra: number }) => void) => {
      const r = acc.get(dateStr.slice(0, 7))
      if (r) fn(r)
    }
    for (const e of entries) add(e.entry_date, (r) => (r.sales += e.amount))
    for (const e of trendExpenses) add(e.expense_date, (r) => (r.costs += e.amount))
    for (const p of trendRuns) add(p.month, (r) => (r.costs += p.base + p.bonus))
    for (const w of writeOffs) add(w.writeoff_date, (r) => (r.costs += w.amount))
    for (const s of settlements) add(s.settle_date, (r) => (r.extra += s.forfeiture_income))
    return months.map((m) => {
      const r = acc.get(m)!
      return { month: m, sales: r.sales, costs: r.costs, profit: r.sales + r.extra - r.costs }
    })
  }, [entries, trendExpenses, trendRuns, writeOffs, settlements, applied])

  const hasData =
    entries.length > 0 ||
    expenses.length > 0 ||
    payments.length > 0 ||
    writeOffs.length > 0 ||
    runs.length > 0 ||
    deposits.length > 0 ||
    settlements.length > 0

  async function exportExcel() {
    if (exporting) return
    setExporting(true)
    setMsg(null)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()
      const summary: (string | number)[][] = [
        ['အချိန်ကာလ', `${applied.from} မှ ${applied.to}`],
        ['ရောင်းရငွေ', report.sales],
        ['ကောက်ခံရငွေ', report.collected],
        ['ကြွေးကျန်', report.receivable],
        ['အသုံးစရိတ်', report.expenseTotal],
        ['လစာ', report.payroll],
        ['လျော်ကြေး/စွန့်ပစ်', report.writeOffs],
        ['ပုလင်းပျောက် ဝင်ငွေ', report.forfeitureIncome],
        ['အမြတ်', report.profit],
        ['အပေါင် စုစုပေါင်း', report.depositLiability],
        ['ပြန်အမ်းပြီး', report.refunds],
      ]
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([['အကြောင်းအရာ', 'ပမာဏ (ကျပ်)'], ...summary]),
        'အကျဉ်းချုပ်',
      )
      const perAgentRows: (string | number)[][] = [
        ['အမည်', 'ရောင်းရငွေ', 'ကောက်ခံရငွေ', 'လျော်ကြေး/စွန့်ပစ်', 'ကြွေးကျန်', 'လက်ထဲ ဘူး', 'အပေါင်'],
        ...report.perAgent.map((a) => [
          a.name,
          a.sales,
          a.collected,
          a.writeOff,
          a.receivable,
          a.bottles,
          a.deposit,
        ]),
      ]
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet(perAgentRows),
        'ကိုယ်စားလှယ်အလိုက်',
      )
      const catRows: (string | number)[][] = [
        ['အမျိုးအစား', 'ပမာဏ (ကျပ်)'],
        ...report.byCategory.map((c) => [c.name, c.total]),
        ['စုစုပေါင်း', report.expenseTotal],
      ]
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet(catRows),
        'စရိတ်အမျိုးအစား',
      )
      XLSX.writeFile(wb, `report-${applied.from}-${applied.to}.xlsx`)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setExporting(false)
  }

  const cards: { label: string; value: number; highlight?: boolean }[] = [
    { label: 'ရောင်းရငွေ', value: report.sales },
    { label: 'ကောက်ခံရငွေ', value: report.collected },
    { label: 'ကြွေးကျန်', value: report.receivable },
    { label: 'အသုံးစရိတ်', value: report.expenseTotal },
    { label: 'လစာ', value: report.payroll },
    { label: 'လျော်ကြေး/စွန့်ပစ်', value: report.writeOffs },
    { label: 'ပုလင်းပျောက် ဝင်ငွေ', value: report.forfeitureIncome },
    { label: 'အပေါင် စုစုပေါင်း', value: report.depositLiability },
    { label: 'ပြန်အမ်းပြီး', value: report.refunds },
    { label: 'အမြတ်', value: report.profit, highlight: true },
  ]
  const maxCat = Math.max(1, ...report.byCategory.map((c) => c.total))
  const maxTrendSales = Math.max(1, ...trend.map((t) => t.sales))
  const inputCls = 'mt-1 w-full rounded-xl border px-3 py-2 dark:bg-neutral-900'

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">အစီရင်ခံစာများ</h1>
      <p className="text-sm opacity-80">
        ရွေးထားတဲ့ ကာလအတွင်း ရောင်းအား၊ ကောက်ခံမှု၊ စရိတ်၊ လစာ နဲ့ အမြတ်ကို ဒီနေရာမှာ
        ကြည့်နိုင်ပါတယ်။
      </p>

      <div className="space-y-2 rounded-2xl border p-4 print:hidden">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">
            ရက်စ မှ
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="text-sm">
            ရက်စ အထိ
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={inputCls}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setApplied({ from, to })}
            className="flex-1 rounded-xl bg-teal-700 py-2.5 font-semibold text-white"
          >
            အစီရင်ခံစာ ကြည့်ရန်
          </button>
          <button
            onClick={exportExcel}
            disabled={exporting || loading || !hasData}
            className="rounded-xl bg-neutral-200 px-4 py-2.5 text-sm font-semibold disabled:opacity-50 dark:bg-neutral-800"
          >
            Excel ထုတ်ရန်
          </button>
          <button
            onClick={() => window.print()}
            className="rounded-xl bg-neutral-200 px-4 py-2.5 text-sm font-semibold dark:bg-neutral-800"
          >
            ပုံနှိပ်ရန်
          </button>
        </div>
      </div>

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      {loading ? (
        <p>ခဏစောင့်ပါ…</p>
      ) : !hasData ? (
        <p className="rounded-2xl border p-4 text-sm opacity-70">
          ဒီကာလအတွင်း စာရင်း မရှိသေးပါ — ကာလ ပြောင်းပြီး ပြန်ကြည့်ပါ။
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            {cards.map((c) =>
              c.highlight ? (
                <div
                  key={c.label}
                  className={`col-span-2 rounded-2xl p-4 text-white ${
                    c.value < 0 ? 'bg-red-700' : 'bg-teal-700'
                  }`}
                >
                  <div className="text-sm opacity-90">{c.label}</div>
                  <div className="text-xl font-bold">{formatMMK(c.value)}</div>
                </div>
              ) : (
                <div key={c.label} className="rounded-2xl border p-3">
                  <div className="text-sm opacity-70">{c.label}</div>
                  <div className="font-bold">{formatMMK(c.value)}</div>
                </div>
              ),
            )}
          </div>

          <section className="space-y-2 rounded-2xl border p-4">
            <div className="font-semibold">စရိတ် အမျိုးအစားအလိုက်</div>
            {report.byCategory.map((c) => (
              <div key={c.name} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span>{c.name}</span>
                  <span className="font-medium">{formatMMK(c.total)}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-neutral-200 dark:bg-neutral-800">
                  <div
                    className="h-2 rounded-full bg-teal-700"
                    style={{ width: `${Math.round((c.total / maxCat) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {report.byCategory.length === 0 && (
              <p className="text-sm opacity-70">ဒီကာလအတွင်း အသုံးစရိတ် မရှိပါ</p>
            )}
          </section>

          <section className="space-y-2 rounded-2xl border p-4">
            <div className="font-semibold">ကြွေး သက်တမ်း (ကြွေးကျန် ခွဲခြားချက်)</div>
            <div className="grid grid-cols-3 gap-2 text-center text-sm">
              {(Object.keys(BUCKET_LABELS) as Bucket[]).map((b) => (
                <div key={b} className="rounded-xl bg-neutral-50 p-2 dark:bg-neutral-900">
                  <div className="opacity-70">{BUCKET_LABELS[b]}</div>
                  <div className="font-bold">{formatMMK(report.aging[b])}</div>
                </div>
              ))}
            </div>
            <button
              onClick={() => setShowAgingDetail((v) => !v)}
              className="text-sm text-teal-700 print:hidden"
            >
              {showAgingDetail ? 'အသေးစိတ် ပိတ်ရန်' : 'အသေးစိတ် ကြည့်ရန်'}
            </button>
            {showAgingDetail && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-1 pr-2">ကိုယ်စားလှယ်</th>
                      <th className="py-1 pr-2">ရက်စွဲ</th>
                      <th className="py-1 pr-2 text-right">ရက်</th>
                      <th className="py-1 text-right">ပမာဏ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.agingRows.map((r, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="py-1 pr-2">{r.agent}</td>
                        <td className="py-1 pr-2">{r.date}</td>
                        <td className="py-1 pr-2 text-right">{r.days}</td>
                        <td className="py-1 text-right">{formatMMK(r.amount)}</td>
                      </tr>
                    ))}
                    {report.agingRows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-2 opacity-70">
                          ကြွေးကျန် မရှိပါ
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2 rounded-2xl border p-4">
            <div className="font-semibold">ကိုယ်စားလှယ်အလိုက် အကျဉ်းချုပ်</div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-1 pr-2">အမည်</th>
                    <th className="py-1 pr-2 text-right">ရောင်းရငွေ</th>
                    <th className="py-1 pr-2 text-right">ကောက်ခံရငွေ</th>
                    <th className="py-1 pr-2 text-right">လျော်ကြေး</th>
                    <th className="py-1 pr-2 text-right">ကြွေးကျန်</th>
                    <th className="py-1 pr-2 text-right">လက်ထဲ ဘူး</th>
                    <th className="py-1 text-right">အပေါင်</th>
                  </tr>
                </thead>
                <tbody>
                  {report.perAgent.map((a) => (
                    <tr key={a.id} className="border-b last:border-0">
                      <td className="py-1 pr-2">
                        {a.name}
                        {a.deleted ? (
                          <span className="ml-1 text-xs text-red-600">(ဖျက်ပြီး)</span>
                        ) : a.closed ? (
                          <span className="ml-1 text-xs opacity-60">(ပိတ်ပြီး)</span>
                        ) : null}
                      </td>
                      <td className="py-1 pr-2 text-right">{formatMMK(a.sales)}</td>
                      <td className="py-1 pr-2 text-right">{formatMMK(a.collected)}</td>
                      <td className="py-1 pr-2 text-right">{formatMMK(a.writeOff)}</td>
                      <td
                        className={`py-1 pr-2 text-right font-semibold ${
                          a.receivable > 0 ? 'text-red-600' : ''
                        }`}
                      >
                        {formatMMK(a.receivable)}
                      </td>
                      <td className="py-1 pr-2 text-right">{a.bottles}</td>
                      <td className="py-1 text-right">{formatMMK(a.deposit)}</td>
                    </tr>
                  ))}
                  {report.perAgent.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-2 opacity-70">
                        ကိုယ်စားလှယ် မရှိသေးပါ
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-3 rounded-2xl border p-4">
            <div className="font-semibold">လအလိုက် အရောင်း နှင့် အမြတ် (၁၂ လ)</div>
            <div className="flex h-32 items-end gap-1">
              {trend.map((t) => (
                <div key={t.month} className="flex flex-1 flex-col items-center gap-1">
                  <div className="flex h-24 w-full items-end justify-center gap-0.5">
                    <div
                      className="w-2/5 rounded-t bg-teal-600"
                      style={{ height: `${Math.max(2, Math.round((t.sales / maxTrendSales) * 100))}%` }}
                      title={`အရောင်း ${formatMMK(t.sales)}`}
                    />
                    <div
                      className={`w-2/5 rounded-t ${t.profit < 0 ? 'bg-red-500' : 'bg-emerald-500'}`}
                      style={{
                        height: `${Math.max(2, Math.round((Math.abs(t.profit) / maxTrendSales) * 100))}%`,
                      }}
                      title={`အမြတ် ${formatMMK(t.profit)}`}
                    />
                  </div>
                  <div className="text-[10px] opacity-70">{t.month.slice(5)}</div>
                </div>
              ))}
            </div>
            <div className="flex gap-4 text-xs opacity-80">
              <span>■ အရောင်း (အစိမ်း)</span>
              <span>■ အမြတ် (အစိမ်းဖျော့ / အနှုတ်ဆို အနီ)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-1 pr-2">လ</th>
                    <th className="py-1 pr-2 text-right">ရောင်းရငွေ</th>
                    <th className="py-1 pr-2 text-right">ကုန်ကျစရိတ်</th>
                    <th className="py-1 text-right">အမြတ်</th>
                  </tr>
                </thead>
                <tbody>
                  {trend.map((t) => (
                    <tr key={t.month} className="border-b last:border-0">
                      <td className="py-1 pr-2">{t.month}</td>
                      <td className="py-1 pr-2 text-right">{formatMMK(t.sales)}</td>
                      <td className="py-1 pr-2 text-right">{formatMMK(t.costs)}</td>
                      <td
                        className={`py-1 text-right font-medium ${
                          t.profit < 0 ? 'text-red-600' : ''
                        }`}
                      >
                        {formatMMK(t.profit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
