import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { historyCsv } from '../lib/exports'
import { todayYangon, type AuditLogRow } from '../lib/types'
import {
  EmptyState,
  LoadingState,
  PageHeader,
  SecondaryButton,
  cardCls,
} from '../components/ui'

const ACTION_LABELS: Record<AuditLogRow['action'], string> = {
  insert: 'အသစ်ထည့်',
  update: 'ပြင်ဆင်',
  delete: 'ဖျက်',
}

export default function HistoryPage() {
  const [rows, setRows] = useState<AuditLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
    setRows((data ?? []) as AuditLogRow[])
    setHasMore((data ?? []).length === 100)
    setLoading(false)
  }, [])

  async function loadMore() {
    const { data } = await supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .range(rows.length, rows.length + 99)
    const page = (data ?? []) as AuditLogRow[]
    setRows((prev) => [...prev, ...page])
    setHasMore(page.length === 100)
  }

  useEffect(() => {
    load()
  }, [load])

  // Export the rows currently loaded (including any "load more" pages) —
  // same shaping pattern as the Data-Quality page's CSV export.
  function onExportCsv() {
    historyCsv(
      rows.map((r) => ({
        အချိန်: new Date(r.created_at).toLocaleString('my-MM'),
        ဇယား: r.table_name,
        လုပ်ဆောင်ချက်: ACTION_LABELS[r.action],
        'မှတ်တမ်း ID': r.row_id,
        'အရင် အချက်အလက်': r.old_data ? JSON.stringify(r.old_data) : '',
        'အသစ် အချက်အလက်': r.new_data ? JSON.stringify(r.new_data) : '',
      })),
      `history-${todayYangon()}.csv`,
    )
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="ပြောင်းလဲမှုမှတ်တမ်း"
        subtitle="မည်သူ ဘာပြောင်းခဲ့လဲ ပြန်ကြည့်ရန်"
        action={
          <SecondaryButton
            onClick={onExportCsv}
            disabled={loading || rows.length === 0}
            className="shrink-0"
          >
            CSV ဒေါင်းလုပ်
          </SecondaryButton>
        }
      />
      <p className="text-sm text-stone-500 dark:text-neutral-400">
        မှတ်တမ်းအားလုံးကို ပြင်ဆင်/ဖျက်ချ၍ မရပါ (ပိုင်ရှင် အပါအဝင်)။ မှားယွင်းမှု ဖြစ်ခဲ့ရင် ဒီမှတ်တမ်းက
        မူလ အချက်အလက်ကို ပြန်ဆယ်ရန် သုံးနိုင်ပါတယ်။
      </p>

      {loading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState text="မှတ်တမ် မရှိသေးပါ" />
      ) : (
        <ul className={`${cardCls} divide-y divide-stone-100 overflow-hidden dark:divide-neutral-800/70`}>
          {rows.map((r) => (
            <li key={r.id} className="px-3.5">
              <button
                className="flex min-h-[52px] w-full items-center justify-between gap-2 py-2 text-left"
                onClick={() => setOpenId(openId === r.id ? null : r.id)}
              >
                <span className="font-medium">
                  {r.table_name} · {ACTION_LABELS[r.action]}
                </span>
                <span className="shrink-0 text-xs text-stone-500 dark:text-neutral-400">
                  {new Date(r.created_at).toLocaleString('my-MM')}
                </span>
              </button>
              {openId === r.id && (
                <div className="space-y-2 pb-3.5 text-xs">
                  {r.old_data && (
                    <pre className="overflow-x-auto rounded-lg bg-red-50 p-2.5 dark:bg-red-950/40">
                      အရင်: {JSON.stringify(r.old_data, null, 1)}
                    </pre>
                  )}
                  {r.new_data && (
                    <pre className="overflow-x-auto rounded-lg bg-brand-50 p-2.5 dark:bg-brand-950/40">
                      အသစ်: {JSON.stringify(r.new_data, null, 1)}
                    </pre>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <SecondaryButton onClick={loadMore} className="w-full">
          နောက်ထပ် ၁၀၀ ကြည့်ရန်
        </SecondaryButton>
      )}
    </div>
  )
}
