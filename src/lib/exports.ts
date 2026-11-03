import { supabase } from './supabase'

/**
 * Export helpers: daily summary CSV, monthly backup (Excel + combined CSV),
 * and generic row exporters for the History / Data-Quality pages.
 *
 * Ported from the old app's backup-csv.ts + backup.functions.ts
 * (getMonthlyBackup): same sheet names, columns and month scoping, mapped
 * to this schema (entered_by -> created_by, bottles_out -> delivered_qty,
 * empties_in -> returned_qty, note -> notes, profiles.full_name ->
 * profiles.username). `xlsx` is loaded lazily via dynamic import so it
 * never lands in the main bundle.
 */

export interface BackupSheet {
  name: string
  rows: Record<string, unknown>[]
}

// ---------------------------------------------------------------------------
// Fetching (PostgREST caps one response at 1,000 rows — always page).
// ---------------------------------------------------------------------------

async function fetchAllRows<T>(
  table: string,
  columns: string,
  orderBy: string,
  modify?: (q: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<T[]> {
  const pageSize = 1000
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    let q = supabase.from(table).select(columns).order(orderBy, { ascending: true })
    if (modify) q = modify(q) as typeof q
    const { data, error } = await q.range(from, from + pageSize - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const page = (data ?? []) as unknown as T[]
    out.push(...page)
    if (page.length < pageSize) break
  }
  return out
}

// ---------------------------------------------------------------------------
// CSV primitives (UTF-8 BOM so Excel renders Burmese correctly).
// ---------------------------------------------------------------------------

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Headers-first CSV text (no BOM — downloadCsv/downloadText add it). */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(',')]
  for (const r of rows) lines.push(r.map(csvCell).join(','))
  return lines.join('\r\n')
}

function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Download ready-made CSV text, adding the UTF-8 BOM Excel needs. */
export function downloadCsv(filename: string, text: string): void {
  downloadText(filename, text.startsWith('\uFEFF') ? text : '\uFEFF' + text, 'text/csv;charset=utf-8')
}

/** Sectioned CSV in the old backup-csv.ts layout: title line, then one
 *  "## name (count)" section per sheet with its own header row. */
function sectionsToCsv(title: string, sheets: BackupSheet[]): string {
  const lines: string[] = [csvCell(title), '']
  for (const s of sheets) {
    lines.push(csvCell(`## ${s.name} (${s.rows.length})`))
    if (s.rows.length) {
      const cols = Object.keys(s.rows[0] ?? {})
      lines.push(cols.map(csvCell).join(','))
      for (const r of s.rows) lines.push(cols.map((c) => csvCell(r[c])).join(','))
    } else {
      lines.push(csvCell('မှတ်တမ်း မရှိပါ'))
    }
    lines.push('')
  }
  return '\uFEFF' + lines.join('\r\n')
}

/** Generic exporter: headers come from the first row's keys. */
function exportRowsCsv(rows: Record<string, unknown>[], filename: string): void {
  if (rows.length === 0) {
    downloadCsv(filename, 'မှတ်တမ်း မရှိပါ')
    return
  }
  const cols = Object.keys(rows[0] ?? {})
  downloadCsv(filename, toCsv(cols, rows.map((r) => cols.map((c) => r[c]))))
}

/** History page exporter (rows already shaped for display). */
export function historyCsv(rows: Record<string, unknown>[], filename = 'history.csv'): void {
  exportRowsCsv(rows, filename)
}

/** Data-quality page exporter (issue rows already shaped for display). */
export function dataQualityCsv(rows: Record<string, unknown>[], filename = 'data-quality.csv'): void {
  exportRowsCsv(rows, filename)
}

// ---------------------------------------------------------------------------
// Shared row shapes (only the columns the exports read).
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string
  entry_date: string
  agent_name: string | null
  delivered_qty: number
  returned_qty: number
  unit_price: number
  amount: number
  amount_collected: number
  notes: string | null
  created_by: string | null
  created_at: string
}

interface PaymentRow {
  id: string
  payment_date: string
  agent_name: string | null
  amount: number
  method: string
  notes: string | null
  created_by: string | null
  created_at: string
}

interface ExpenseRow {
  id: string
  expense_date: string
  category_id: string | null
  title: string
  amount: number
  notes: string | null
  created_by: string | null
  created_at: string
}

const ENTRY_COLS =
  'id, entry_date, agent_name, delivered_qty, returned_qty, unit_price, amount, amount_collected, notes, created_by, created_at'
const PAYMENT_COLS = 'id, payment_date, agent_name, amount, method, notes, created_by, created_at'
const EXPENSE_COLS = 'id, expense_date, category_id, title, amount, notes, created_by, created_at'

async function categoryNames(): Promise<Map<string, string>> {
  const { data } = await supabase.from('expense_categories').select('id, name')
  return new Map(((data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]))
}

async function profileNames(): Promise<Map<string, string>> {
  const rows = await fetchAllRows<{ id: string; username: string }>('profiles', 'id, username', 'username')
  return new Map(rows.map((p) => [p.id, p.username]))
}

const byDate = (col: string, from: string, to: string) => (q: any) => q.gte(col, from).lte(col, to) // eslint-disable-line @typescript-eslint/no-explicit-any
const byEq = (col: string, val: string) => (q: any) => q.eq(col, val) // eslint-disable-line @typescript-eslint/no-explicit-any

export function monthRange(month: string): { from: string; to: string } {
  const [y = 0, m = 0] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

// ---------------------------------------------------------------------------
// Daily summary CSV.
// ---------------------------------------------------------------------------

export async function dailySummaryCsv(dateStr: string): Promise<string> {
  const [entries, payments, expenses, cats] = await Promise.all([
    fetchAllRows<EntryRow>('daily_entries', ENTRY_COLS, 'created_at', byEq('entry_date', dateStr)),
    fetchAllRows<PaymentRow>('agent_payments', PAYMENT_COLS, 'created_at', byEq('payment_date', dateStr)),
    fetchAllRows<ExpenseRow>('expenses', EXPENSE_COLS, 'created_at', byEq('expense_date', dateStr)),
    categoryNames(),
  ])

  const sales = entries.reduce((s, e) => s + Number(e.amount), 0)
  const entryCash = entries.reduce((s, e) => s + Number(e.amount_collected), 0)
  const collected = payments.reduce((s, p) => s + Number(p.amount), 0)
  const received = entryCash + collected
  const expenseTotal = expenses.reduce((s, x) => s + Number(x.amount), 0)

  const sheets: BackupSheet[] = [
    {
      name: 'ရေပို့မှတ်တမ်း',
      rows: entries.map((e) => ({
        ကိုယ်စားလှယ်: e.agent_name ?? '',
        ပို့ဘူး: e.delivered_qty,
        ဘူးခွံပြန်: e.returned_qty,
        တစ်ဘူးဈေး: Number(e.unit_price),
        ရောင်းငွေ: Number(e.amount),
        လက်ခံငွေ: Number(e.amount_collected),
        ကျန်ကြွေး: Number(e.amount) - Number(e.amount_collected),
      })),
    },
    {
      name: 'ငွေကောက်ခံမှုများ',
      rows: payments.map((p) => ({
        ကိုယ်စားလှယ်: p.agent_name ?? '',
        ငွေ: Number(p.amount),
        နည်းလမ်း: p.method,
        မှတ်ချက်: p.notes ?? '',
      })),
    },
    {
      name: 'အသုံးစရိတ်များ',
      rows: expenses.map((x) => ({
        အမျိုးအစား: (x.category_id ? cats.get(x.category_id) : undefined) ?? x.title,
        ခေါင်းစဉ်: x.title,
        ငွေ: Number(x.amount),
        မှတ်ချက်: x.notes ?? '',
      })),
    },
    {
      name: 'စုစုပေါင်း',
      rows: [
        { အချက်: 'စုစုပေါင်း ရောင်း', ကျပ်: sales },
        { အချက်: 'ငွေလက်ခံ (ပို့ချိန်)', ကျပ်: entryCash },
        { အချက်: 'ငွေလက်ခံ (ကြွေးကောက်)', ကျပ်: collected },
        { အချက်: 'ငွေလက်ခံ စုစုပေါင်း', ကျပ်: received },
        { အချက်: 'စရိတ်', ကျပ်: expenseTotal },
        { အချက်: 'လက်ကျန်ငွေ', ကျပ်: received - expenseTotal },
      ],
    },
  ]

  const filename = `daily-${dateStr}.csv`
  downloadText(filename, sectionsToCsv(`နေ့စဉ် အကျဉ်းချုပ် — ${dateStr}`, sheets), 'text/csv;charset=utf-8')
  return filename
}

// ---------------------------------------------------------------------------
// Monthly backup — the old getMonthlyBackup sheet set, verbatim shape.
// ---------------------------------------------------------------------------

interface DepositRow {
  id: string
  deposit_date: string
  agent_name: string | null
  bottles: number
  price_per_bottle: number
  amount: number
  note: string | null
  created_at: string
}

interface SettlementRow {
  id: string
  settle_date: string
  agent_name: string | null
  held_bottles: number
  returned_bottles: number
  missing_bottles: number
  net_refund: number
  agent_owes: number
  note: string | null
  created_at: string
}

interface WriteOffRow {
  id: string
  writeoff_date: string
  agent_name: string | null
  amount: number
  note: string
  created_at: string
}

interface AdvanceRow {
  id: string
  advance_date: string
  user_id: string
  amount: number
  installment: number
  note: string | null
  created_at: string
}

interface RepaymentRow {
  month: string
  amount: number
}

interface BonusRow {
  month: string
  user_id: string
  amount: number
  note: string | null
}

interface PayrollRow {
  month: string
  user_id: string
  base: number
  bonus: number
  deduction: number
  net: number
}

export async function monthlyBackupSheets(month: string): Promise<BackupSheet[]> {
  const { from, to } = monthRange(month)
  const [names, entries, payments, expenses, cats, deposits, settlements, writeOffs, advances, repayments, bonuses, payroll] =
    await Promise.all([
      profileNames(),
      fetchAllRows<EntryRow>('daily_entries', ENTRY_COLS, 'entry_date', byDate('entry_date', from, to)),
      fetchAllRows<PaymentRow>('agent_payments', PAYMENT_COLS, 'payment_date', byDate('payment_date', from, to)),
      fetchAllRows<ExpenseRow>('expenses', EXPENSE_COLS, 'expense_date', byDate('expense_date', from, to)),
      categoryNames(),
      fetchAllRows<DepositRow>(
        'agent_deposits',
        'id, deposit_date, agent_name, bottles, price_per_bottle, amount, note, created_at',
        'deposit_date',
        byDate('deposit_date', from, to),
      ),
      fetchAllRows<SettlementRow>(
        'agent_settlements',
        'id, settle_date, agent_name, held_bottles, returned_bottles, missing_bottles, net_refund, agent_owes, note, created_at',
        'settle_date',
        byDate('settle_date', from, to),
      ),
      fetchAllRows<WriteOffRow>(
        'write_offs',
        'id, writeoff_date, agent_name, amount, note, created_at',
        'writeoff_date',
        byDate('writeoff_date', from, to),
      ),
      fetchAllRows<AdvanceRow>(
        'advances',
        'id, advance_date, user_id, amount, installment, note, created_at',
        'advance_date',
        byDate('advance_date', from, to),
      ),
      fetchAllRows<RepaymentRow>('advance_repayments', 'month, amount', 'created_at', byEq('month', month)),
      fetchAllRows<BonusRow>('bonuses', 'month, user_id, amount, note', 'created_at', byEq('month', month)),
      fetchAllRows<PayrollRow>('payroll_runs', 'month, user_id, base, bonus, deduction, net', 'created_at', byEq('month', month)),
    ])
  const who = (id: string | null) => (id ? names.get(id) ?? '' : '')

  return [
    {
      name: 'ရေပို့',
      rows: entries.map((r) => ({
        ရက်စွဲ: r.entry_date,
        ကိုယ်စားလှယ်: r.agent_name ?? '',
        ပို့ဘူး: r.delivered_qty,
        ဘူးခွံပြန်: r.returned_qty,
        တစ်ဘူးဈေး: Number(r.unit_price),
        လက်ခံငွေ: Number(r.amount_collected),
        ထည့်သူ: who(r.created_by),
        မှတ်ချက်: r.notes ?? '',
      })),
    },
    {
      name: 'ကြွေးကောက်ငွေ',
      rows: payments.map((r) => ({
        ရက်စွဲ: r.payment_date,
        ကိုယ်စားလှယ်: r.agent_name ?? '',
        ငွေ: Number(r.amount),
        ကောက်ခံသူ: who(r.created_by),
        မှတ်ချက်: r.notes ?? '',
      })),
    },
    {
      name: 'ကုန်ကျစရိတ်',
      rows: expenses.map((r) => ({
        ရက်စွဲ: r.expense_date,
        အမျိုးအစား: (r.category_id ? cats.get(r.category_id) : undefined) ?? r.title,
        ငွေ: Number(r.amount),
        ထည့်သူ: who(r.created_by),
        မှတ်ချက်: r.notes ?? '',
      })),
    },
    {
      name: 'အပေါင်ငွေ',
      rows: deposits.map((r) => ({
        ရက်စွဲ: r.deposit_date,
        ကိုယ်စားလှယ်: r.agent_name ?? '',
        ဘူး: r.bottles,
        တစ်ဘူးဈေး: Number(r.price_per_bottle),
        ငွေ: Number(r.amount),
        မှတ်ချက်: r.note ?? '',
      })),
    },
    {
      name: 'စာရင်းပိတ်',
      rows: settlements.map((r) => ({
        ရက်စွဲ: r.settle_date,
        ကိုယ်စားလှယ်: r.agent_name ?? '',
        ကိုင်ထားဘူး: r.held_bottles,
        ပြန်အပ်ဘူး: r.returned_bottles,
        ပျောက်ဘူး: r.missing_bottles,
        ပြန်ပေးငွေ: Number(r.net_refund),
        ကိုယ်စားလှယ်ပေးရန်: Number(r.agent_owes),
        မှတ်ချက်: r.note ?? '',
      })),
    },
    {
      name: 'ကြွေးပယ်ဖျက်',
      rows: writeOffs.map((r) => ({
        ရက်စွဲ: r.writeoff_date,
        ကိုယ်စားလှယ်: r.agent_name ?? '',
        ငွေ: Number(r.amount),
        မှတ်ချက်: r.note,
      })),
    },
    {
      name: 'ကြိုတင်ငွေ',
      rows: advances.map((r) => ({
        ရက်စွဲ: r.advance_date,
        ဝန်ထမ်း: who(r.user_id),
        ငွေ: Number(r.amount),
        အရစ်: Number(r.installment),
        မှတ်ချက်: r.note ?? '',
      })),
    },
    {
      name: 'ကြိုတင်ငွေပြန်ဆပ်',
      rows: repayments.map((r) => ({ လ: r.month, ငွေ: Number(r.amount) })),
    },
    {
      name: 'ဆုကြေး',
      rows: bonuses.map((r) => ({
        လ: r.month,
        ဝန်ထမ်း: who(r.user_id),
        ငွေ: Number(r.amount),
        မှတ်ချက်: r.note ?? '',
      })),
    },
    {
      name: 'လစာ',
      rows: payroll.map((r) => ({
        လ: r.month,
        ဝန်ထမ်း: who(r.user_id),
        အခြေခံ: Number(r.base),
        ဆုကြေး: Number(r.bonus),
        နုတ်ငွေ: Number(r.deduction),
        အသားတင်: Number(r.net),
      })),
    },
  ]
}

export async function monthlyBackupXlsx(month: string): Promise<string> {
  const sheets = await monthlyBackupSheets(month)
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  for (const s of sheets) {
    const ws = s.rows.length
      ? XLSX.utils.json_to_sheet(s.rows)
      : XLSX.utils.aoa_to_sheet([['မှတ်တမ်း မရှိပါ']])
    XLSX.utils.book_append_sheet(wb, ws, s.name)
  }
  const filename = `backup-${month}.xlsx`
  XLSX.writeFile(wb, filename)
  return filename
}

export async function monthlyBackupCsv(month: string): Promise<string> {
  const sheets = await monthlyBackupSheets(month)
  const filename = `backup-${month}.csv`
  downloadText(filename, sectionsToCsv(`လစဉ် Backup — ${month}`, sheets), 'text/csv;charset=utf-8')
  return filename
}
