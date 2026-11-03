import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { AuditLogRow } from '../lib/types'

const ACTION_LABELS: Record<AuditLogRow['action'], string> = {
  insert: 'အသစ်ထည့်',
  update: 'ပြင်ဆင်',
  delete: 'ဖျက်',
}

export default function HistoryPage() {
  const [rows, setRows] = useState<AuditLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
    setRows((data ?? []) as AuditLogRow[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">ပြောင်းလဲမှုမှတ်တမ်း</h1>
      <p className="text-sm opacity-75">
        မှတ်တမ်းအားလုံးကို ပြင်ဆင်/ဖျက်ချ၍ မရပါ (ပိုင်ရှင် အပါအဝင်)။ မှားယွင်းမှု ဖြစ်ခဲ့ရင် ဒီမှတ်တမ်းက
        မူလ အချက်အလက်ကို ပြန်ဆယ်ရန် သုံးနိုင်ပါတယ်။
      </p>

      {loading ? (
        <p>ခဏစောင့်ပါ…</p>
      ) : (
        <ul className="divide-y rounded-2xl border">
          {rows.map((r) => (
            <li key={r.id} className="p-3">
              <button
                className="flex w-full items-center justify-between gap-2 text-left"
                onClick={() => setOpenId(openId === r.id ? null : r.id)}
              >
                <span className="font-medium">
                  {r.table_name} · {ACTION_LABELS[r.action]}
                </span>
                <span className="text-xs opacity-60">
                  {new Date(r.created_at).toLocaleString('my-MM')}
                </span>
              </button>
              {openId === r.id && (
                <div className="mt-2 space-y-2 text-xs">
                  {r.old_data && (
                    <pre className="overflow-x-auto rounded-lg bg-red-50 p-2 dark:bg-red-950/40">
                      အရင်: {JSON.stringify(r.old_data, null, 1)}
                    </pre>
                  )}
                  {r.new_data && (
                    <pre className="overflow-x-auto rounded-lg bg-emerald-50 p-2 dark:bg-emerald-950/40">
                      အသစ်: {JSON.stringify(r.new_data, null, 1)}
                    </pre>
                  )}
                </div>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className="p-3 text-sm opacity-70">မှတ်တမ် မရှိသေးပါ</li>}
        </ul>
      )}
    </div>
  )
}
