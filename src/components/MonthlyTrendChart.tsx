import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export interface TrendChartRow {
  /** X-axis label, e.g. '26/01'. */
  label: string
  /** Full month 'YYYY-MM' — the tooltip title. */
  month: string
  sales: number
  costs: number
  profit: number
}

const GREEN = '#16a34a'
const RED = '#dc2626'
const BLUE = '#2563eb'
const AXIS = '#78716c'
const GRID = '#a8a29e'

/** 300000 -> "300K", 1500000 -> "1.5M", -300000 -> "-300K". */
function compactTick(v: number): string {
  const trim = (n: number) => {
    const s = n.toFixed(1)
    return s.endsWith('.0') ? s.slice(0, -2) : s
  }
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `${trim(v / 1_000_000)}M`
  if (abs >= 1_000) return `${trim(v / 1_000)}K`
  return `${v}`
}

function TrendTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: ReadonlyArray<{ payload: TrendChartRow }>
}) {
  if (!active || !payload || payload.length === 0) return null
  const row = payload[0]!.payload
  const line = (label: string, value: number, color: string) => (
    <div key={label} style={{ color }}>
      {label} : {value.toLocaleString('en-US')} ကျပ်
    </div>
  )
  return (
    <div className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
      <div className="mb-1 font-semibold text-stone-700 dark:text-neutral-100">{row.month}</div>
      {line('အရောင်း', row.sales, GREEN)}
      {line('ကုန်ကျငွေ', row.costs, RED)}
      {line('အမြတ်', row.profit, BLUE)}
    </div>
  )
}

/**
 * Monthly trend chart matching the old Lovable app: green sales bars, red
 * cost bars and a blue profit line, with a per-month figures tooltip.
 * Lazy-loaded from ReportsPage so Recharts stays out of the main bundle.
 */
export default function MonthlyTrendChart({ rows }: { rows: TrendChartRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} strokeOpacity={0.35} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 12, fill: AXIS }}
          tickLine={false}
          axisLine={{ stroke: GRID }}
        />
        <YAxis
          tickFormatter={compactTick}
          tick={{ fontSize: 12, fill: AXIS }}
          tickLine={false}
          axisLine={false}
          width={44}
        />
        <Tooltip content={<TrendTooltip />} />
        <Legend />
        <Bar dataKey="sales" name="အရောင်း" fill={GREEN} />
        <Bar dataKey="costs" name="ကုန်ကျငွေ" fill={RED} />
        <Line type="monotone" dataKey="profit" name="အမြတ်" stroke={BLUE} strokeWidth={2} dot={{ r: 3 }} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
