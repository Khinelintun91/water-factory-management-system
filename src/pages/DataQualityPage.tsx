import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { fetchAll } from '../lib/fetchAll'
import { dataQualityCsv } from '../lib/exports'
import { fmtDateTime12, fmtTime12, todayYangon } from '../lib/types'
import {
  Card,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  cardCls,
} from '../components/ui'

// Data-quality checks, ported from the old app's data-quality.ts
// (checkDataQuality + checkDebtAndHabits) and its month-lock annotation
// from data-quality.server.ts. The checks themselves now run SERVER-side
// in the data_quality_scan() RPC (migration 0022) — at multi-year scale
// the browser-side scan of every entry/payment took the better part of
// a minute. The RPC reproduces the checks issue-for-issue (same kinds,
// severities, texts and order) and returns the finished list plus the
// scanned-row counts; this page only annotates month-lock state and
// renders/filters/exports. Checks run on live data every time the page
// opens.

type Severity = 'high' | 'medium' | 'low'
type IssueKind =
  | 'duplicate'
  | 'impossible'
  | 'mismatch'
  | 'debt'
  | 'suspicious'
  | 'snapshot'
  | 'dispute'
  | 'system'
  | 'collection_anomaly'

interface DqIssue {
  kind: IssueKind
  severity: Severity
  table: string
  recordId: string
  date: string
  /** When the flagged record was entered (its created_at); null for
   * aggregate/system issues with no single source record. */
  ts?: string | null
  /** Display name of whoever entered the flagged record. */
  by?: string | null
  name: string
  problem: string
  suggestion: string
  locked?: boolean
}

/**
 * Full-table paginated load via the shared helper (src/lib/fetchAll.ts).
 * Only used for month_locks now (a tiny table) — the scan itself is the
 * data_quality_scan() RPC. The requested order column gets a unique `id`
 * tiebreak (`month` on month_locks is already unique): ordering by
 * `created_at` alone is not a stable page order when many rows share one
 * timestamp (bulk imports), so pages could repeat or skip rows. Errors
 * keep the `<table>: <message>` shape this page has always shown.
 */
async function fetchTable<T>(table: string, columns: string, orderBy = 'created_at'): Promise<T[]> {
  try {
    return await fetchAll<T>((from, to) => {
      let q = supabase.from(table).select(columns).order(orderBy, { ascending: true })
      if (orderBy !== 'month') q = q.order('id', { ascending: true })
      return q.range(from, to)
    })
  } catch (err) {
    throw new Error(`${table}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const GROUP_TITLES: { kind: IssueKind; title: string }[] = [
  { kind: 'duplicate', title: 'ထပ်နေသော မှတ်တမ်းများ' },
  { kind: 'impossible', title: 'မဖြစ်နိုင်သော ဂဏန်းများ' },
  { kind: 'mismatch', title: 'မကိုက်ညီသော ဂဏန်းများ' },
  { kind: 'snapshot', title: 'အမည် မှတ်တမ်း ပျောက်နေသည်များ' },
  { kind: 'debt', title: 'ကြွေးနှင့် လက်ကျန် သတိပေးချက်များ' },
  { kind: 'dispute', title: 'ဖြေရှင်းရန် ကျန်နေသော အငြင်းပွားမှုများ' },
  { kind: 'system', title: 'စနစ် စစ်ဆေးချက်များ' },
  { kind: 'collection_anomaly', title: 'သံသယရှိ (ကောက်ငွေ)' },
  { kind: 'suspicious', title: 'သံသယဖြစ်ဖွယ် မှတ်တမ်းများ' },
]

const SEVERITY_BADGE: Record<Severity, { label: string; cls: string }> = {
  high: { label: 'အရေးကြီး', cls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
  medium: { label: 'သတိပေးချက်', cls: 'bg-accent-100 text-accent-800 dark:bg-amber-900 dark:text-amber-200' },
  low: { label: 'အသေးစား', cls: 'bg-stone-200 text-stone-700 dark:bg-neutral-800 dark:text-neutral-300' },
}

const REVIEWED_KEY = 'wfms-dq-reviewed'

/**
 * Issue rows mounted per group before the "show more" button. With
 * multi-year data the checks legitimately produce 10k+ issues (e.g. an
 * entry priced off the agent's current default, or held bottles over the
 * limit, fire per entry), and mounting every row in one render blocks the
 * tab for minutes. Counts, filters and the CSV export still cover the
 * full issue list — only the initial DOM is windowed.
 */
const GROUP_PAGE = 100

/** Stable per-issue identity used for the per-device reviewed set. */
function issueKey(i: DqIssue): string {
  return `${i.kind}|${i.table}|${i.recordId}|${i.date}|${i.problem}`
}

function loadReviewed(): Set<string> {
  try {
    const raw = localStorage.getItem(REVIEWED_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Where to go to fix an issue, best effort by table/kind. */
function fixPath(i: DqIssue): string {
  if (i.table === 'disputes' || i.kind === 'dispute') return '/disputes'
  // Debt issues carry table 'agents' but are fixed from the Collections
  // ledger — the kind check must come before the agents-table branch.
  if (i.kind === 'debt') return '/collections'
  if (i.table === 'app_settings') return '/'
  if (i.table === 'payroll_runs') return '/payroll'
  if (i.table === 'agent_payments') return '/payments'
  if (i.table === 'daily_entries') return '/entries'
  if (i.table === 'expenses') return '/expenses'
  if (i.table === 'agents' || i.table === 'agent_deposits') return '/agents'
  return '/entries'
}

export default function DataQualityPage() {
  const [issues, setIssues] = useState<DqIssue[]>([])
  const [counts, setCounts] = useState<{ entries: number; deposits: number; payroll: number; expenses: number } | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [severityFilter, setSeverityFilter] = useState<'all' | Severity>('all')
  const [kindFilter, setKindFilter] = useState<IssueKind | null>(null)
  const [reviewed, setReviewed] = useState<Set<string>>(loadReviewed)
  const [hideReviewed, setHideReviewed] = useState(false)
  const [shownCounts, setShownCounts] = useState<Partial<Record<IssueKind, number>>>({})

  // Render windowing restarts whenever the visible issue set changes.
  useEffect(() => {
    setShownCounts({})
  }, [severityFilter, kindFilter, hideReviewed])

  const toggleReviewed = useCallback((key: string) => {
    setReviewed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(REVIEWED_KEY, JSON.stringify([...next]))
      } catch {
        /* storage full/blocked — marking still works for this session */
      }
      return next
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      // The scan runs server-side (migration 0022): one RPC returns the
      // finished issue list — identical kinds/severities/texts/order to
      // the old client-side runChecks — plus the scanned-row counts.
      // Only month_locks (a tiny table) is still fetched client-side, to
      // annotate issues whose month is locked.
      const [scan, locks] = await Promise.all([
        supabase.rpc('data_quality_scan'),
        fetchTable<{ month: string }>('month_locks', 'month', 'month'),
      ])
      if (scan.error) throw new Error(scan.error.message)
      const { issues: found, counts: scanned } = scan.data as {
        issues: DqIssue[]
        counts: { entries: number; deposits: number; payroll: number; expenses: number }
      }
      const lockedMonths = new Set(locks.map((l) => l.month.slice(0, 7)))
      for (const i of found) i.locked = lockedMonths.has(i.date.slice(0, 7))
      setIssues(found)
      setCounts(scanned)
      setCheckedAt(fmtDateTime12(new Date()))
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const countsBySeverity = useMemo(() => {
    const c: Record<Severity, number> = { high: 0, medium: 0, low: 0 }
    for (const i of issues) c[i.severity]++
    return c
  }, [issues])

  const severitiesPresent = useMemo(
    () => (['high', 'medium', 'low'] as Severity[]).filter((s) => countsBySeverity[s] > 0),
    [countsBySeverity],
  )

  const kindCounts = useMemo(() => {
    const m = new Map<IssueKind, number>()
    for (const i of issues) m.set(i.kind, (m.get(i.kind) ?? 0) + 1)
    return m
  }, [issues])

  const reviewedCount = useMemo(
    () => issues.filter((i) => reviewed.has(issueKey(i))).length,
    [issues, reviewed],
  )

  const visibleIssues = useMemo(
    () =>
      issues.filter(
        (i) =>
          (severityFilter === 'all' || i.severity === severityFilter) &&
          (!kindFilter || i.kind === kindFilter) &&
          (!hideReviewed || !reviewed.has(issueKey(i))),
      ),
    [issues, severityFilter, kindFilter, hideReviewed, reviewed],
  )

  const grouped = useMemo(
    () =>
      GROUP_TITLES.map((g) => ({
        ...g,
        items: visibleIssues.filter((i) => i.kind === g.kind),
      })).filter((g) => g.items.length > 0),
    [visibleIssues],
  )

  function onExportCsv() {
    dataQualityCsv(
      issues.map((i) => ({
        အဆင့်: SEVERITY_BADGE[i.severity].label,
        အမျိုးအစား: GROUP_TITLES.find((g) => g.kind === i.kind)?.title ?? i.kind,
        ပြဿနာ: i.problem,
        သက်ဆိုင်သူ: i.name,
        ရက်စွဲ: i.date,
        အချိန်: i.ts ? fmtTime12(i.ts) : '',
        ထည့်သူ: i.by ?? '',
        အကြံပြုချက်: i.suggestion,
        'လ ပိတ်ထားသည်': i.locked ? 'ဟုတ်' : '',
      })),
      `data-quality-${todayYangon()}.csv`,
    )
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="ဒေတာ အရည်အသွေး စစ်ဆေးမှု"
        subtitle="မှတ်တမ်းများထဲက မှားယွင်းမှုများ အလိုအလျောက် စစ်ဆေးရန်"
      />
      <p className="text-sm text-stone-500 dark:text-neutral-400">
        စစ်ဆေးမှုများကို စာမျက်နှာ ဖွင့်ချိန်တွင် နောက်ဆုံး ဒေတာဖြင့် အလိုအလျောက် လုပ်ဆောင်ပါတယ်။
        {checkedAt && <> နောက်ဆုံး စစ်ဆေးချိန်: {checkedAt}</>}
        {counts && (
          <>
            {' '}
            စစ်ဆေးခဲ့သော မှတ်တမ်း — ရေပို့ {counts.entries} · အပေါင် {counts.deposits} · လစာ{' '}
            {counts.payroll} · စရိတ် {counts.expenses}
          </>
        )}
      </p>

      <div className="flex flex-wrap gap-2">
        <PrimaryButton onClick={load} disabled={loading}>
          {loading ? 'စစ်ဆေးနေပါတယ်…' : 'ပြန်စစ်ရန်'}
        </PrimaryButton>
        <SecondaryButton onClick={onExportCsv} disabled={loading || issues.length === 0}>
          ⬇ CSV ထုတ်ရန်
        </SecondaryButton>
      </div>

      {msg && <p className="text-sm text-red-600">{msg}</p>}

      {loading ? (
        <LoadingState />
      ) : (
        <>
          <Card>
            {issues.length > 0 && (
              <>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => {
                      setSeverityFilter('all')
                      setKindFilter(null)
                    }}
                    className={`inline-flex min-h-[44px] items-center rounded-full px-3.5 text-sm font-semibold ${
                      severityFilter === 'all'
                        ? 'bg-brand-700 text-white'
                        : 'bg-stone-200 text-stone-700 dark:bg-neutral-800 dark:text-neutral-300'
                    }`}
                  >
                    အားလုံး
                  </button>
                  {severitiesPresent.map((s) => (
                    <button
                      key={s}
                      onClick={() => {
                        setKindFilter(null)
                        setSeverityFilter(severityFilter === s ? 'all' : s)
                      }}
                      className={`inline-flex min-h-[44px] items-center rounded-full px-3.5 text-sm font-semibold ${
                        severityFilter === s
                          ? 'bg-brand-700 text-white'
                          : SEVERITY_BADGE[s].cls
                      }`}
                    >
                      {SEVERITY_BADGE[s].label} {countsBySeverity[s]}
                    </button>
                  ))}
                  <button
                    onClick={() => setHideReviewed((v) => !v)}
                    className={`inline-flex min-h-[44px] items-center rounded-full px-3.5 text-sm font-semibold ${
                      hideReviewed
                        ? 'bg-brand-700 text-white'
                        : 'bg-stone-200 text-stone-700 dark:bg-neutral-800 dark:text-neutral-300'
                    }`}
                  >
                    {hideReviewed ? 'စစ်ပြီး ပြရန်' : 'စစ်ပြီး ဝှက်ရန်'}
                  </button>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                  {GROUP_TITLES.filter((g) => (kindCounts.get(g.kind) ?? 0) > 0).map((g) => {
                    const active = kindFilter === g.kind
                    return (
                      <button
                        key={g.kind}
                        onClick={() => {
                          if (active) {
                            setKindFilter(null)
                          } else {
                            // A kind card must always show its own issues:
                            // clear the severity filter and the reviewed-hide
                            // toggle so the two filter axes can never combine
                            // into a silently empty list.
                            setKindFilter(g.kind)
                            setSeverityFilter('all')
                            setHideReviewed(false)
                          }
                        }}
                        className={`rounded-xl border p-3 text-left transition ${
                          active
                            ? 'border-brand-500 bg-brand-50 dark:border-brand-700 dark:bg-brand-950/40'
                            : 'border-stone-200 bg-white dark:border-neutral-800 dark:bg-neutral-900'
                        }`}
                      >
                        <div className="text-sm font-semibold">{g.title}</div>
                        <div className="mt-0.5 text-xs text-stone-500 dark:text-neutral-400">
                          {kindCounts.get(g.kind)} ခု
                        </div>
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </Card>

          {issues.length === 0 ? (
            <section className="rounded-2xl border border-brand-300 bg-brand-50 p-4 shadow-card dark:border-brand-800 dark:bg-brand-950/40 lg:p-5">
              <p className="font-semibold text-brand-800 dark:text-brand-200">
                ✓ စစ်ဆေးမှု အားလုံး အောင်မြင်ပါတယ် — ပြဿနာ မတွေ့ပါ
              </p>
            </section>
          ) : visibleIssues.length === 0 ? (
            <section className="rounded-2xl border border-stone-300 bg-stone-50 p-4 shadow-card dark:border-neutral-700 dark:bg-neutral-800/40 lg:p-5">
              <p className="font-semibold">ရွေးထားသော စစ်ထုတ်မှုဖြင့် ပြစရာ မရှိပါ</p>
              <p className="mt-1 text-sm text-stone-500 dark:text-neutral-400">
                စစ်ပြီး ဝှက်ထားခြင်း သို့မဟုတ် အဆင့်/အမျိုးအစား စစ်ထုတ်မှုကြောင့် ဖြစ်နိုင်ပါတယ်။
              </p>
              <SecondaryButton
                size="sm"
                className="mt-3"
                onClick={() => {
                  setSeverityFilter('all')
                  setKindFilter(null)
                  setHideReviewed(false)
                }}
              >
                စစ်ထုတ်မှု အားလုံး ရှင်းရန်
              </SecondaryButton>
            </section>
          ) : (
            grouped.map((g) => {
              const shownItems = g.items.slice(0, shownCounts[g.kind] ?? GROUP_PAGE)
              const hasMore = g.items.length > shownItems.length
              return (
              <section key={g.kind} className="space-y-2">
                <h2 className="px-0.5 text-base font-bold">
                  {g.title}{' '}
                  <span className="text-stone-400 dark:text-neutral-500">({g.items.length})</span>
                </h2>
                <ul className={`${cardCls} divide-y divide-stone-100 overflow-hidden dark:divide-neutral-800/70`}>
                  {shownItems.map((i, idx) => {
                    const key = issueKey(i)
                    const isReviewed = reviewed.has(key)
                    return (
                      <li
                        key={`${i.recordId}-${idx}`}
                        className={`p-3.5 ${isReviewed ? 'opacity-50' : ''}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-medium">{i.problem}</div>
                          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${SEVERITY_BADGE[i.severity].cls}`}>
                            {SEVERITY_BADGE[i.severity].label}
                          </span>
                        </div>
                        <div className="mt-1 text-sm text-stone-500 dark:text-neutral-400">
                          {i.name} · {i.date}
                          {i.ts && <> · {fmtTime12(i.ts)}</>}
                          {i.by && <> · ထည့်သူ: {i.by}</>}
                          {i.locked && <span className="ml-2">🔒 လ ပိတ်ထားသည်</span>}
                        </div>
                        <div className="mt-1 text-sm text-stone-600 dark:text-neutral-300">
                          အကြံပြုချက်: {i.suggestion}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button
                            onClick={() => toggleReviewed(key)}
                            aria-pressed={isReviewed}
                            className={`inline-flex min-h-[44px] items-center rounded-full px-3.5 text-sm font-semibold ${
                              isReviewed
                                ? 'bg-brand-700 text-white'
                                : 'bg-stone-200 text-stone-700 dark:bg-neutral-800 dark:text-neutral-300'
                            }`}
                          >
                            {isReviewed ? '✓ စစ်ပြီးပါပြီ' : 'စစ်ပြီးပါပြီ'}
                          </button>
                          <Link
                            to={fixPath(i)}
                            className="inline-flex min-h-[44px] items-center rounded-full bg-brand-50 px-3.5 text-sm font-semibold text-brand-700 dark:bg-brand-950/50 dark:text-brand-300"
                          >
                            ပြင်ရန်
                          </Link>
                        </div>
                      </li>
                    )
                  })}
                </ul>
                {hasMore && (
                  <div>
                    <button
                      onClick={() =>
                        setShownCounts((prev) => ({
                          ...prev,
                          [g.kind]: (prev[g.kind] ?? GROUP_PAGE) + GROUP_PAGE,
                        }))
                      }
                      className="inline-flex min-h-[44px] items-center rounded-full bg-stone-200 px-4 text-sm font-semibold text-stone-700 dark:bg-neutral-800 dark:text-neutral-300"
                    >
                      ထပ်ပြမည်
                    </button>
                  </div>
                )}
              </section>
              )
            })
          )}
          <p className="text-xs text-stone-400 dark:text-neutral-500">
            ပြဿနာများကို အရေးကြီး အဆင့်မှ အစဉ်လိုက် ပြထားပါသည်။
          </p>
        </>
      )}
    </div>
  )
}
