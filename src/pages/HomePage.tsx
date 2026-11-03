import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { exportBackup, getLastBackupAt, isBackupOverdue } from '../lib/backup'
import { formatMMK, todayYangon } from '../lib/types'

function BackupCard() {
  const [last, setLast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLast(await getLastBackupAt())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function onExport() {
    setBusy(true)
    setMsg(null)
    try {
      const { filename } = await exportBackup()
      setMsg(`${filename} ကို ဒေါင်းလုပ် လုပ်ပြီးပါပြီ — ဖုန်း + Google Drive၊ ၂ နေရာ သိမ်းထားပါ`)
      await load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Export မအောင်မြင်ပါ')
    }
    setBusy(false)
  }

  const overdue = isBackupOverdue(last)

  return (
    <section
      className={`rounded-2xl border p-4 ${overdue ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/40' : ''}`}
    >
      <h2 className="font-semibold">ဒေတာ Backup</h2>
      <p className="mt-1 text-sm opacity-80">
        နောက်ဆုံး backup: {last ? new Date(last).toLocaleString('my-MM') : 'တစ်ခါမှ မလုပ်ရသေးပါ'}
      </p>
      {overdue && (
        <p className="mt-1 text-sm font-medium text-amber-700 dark:text-amber-300">
          ⚠️ Backup လုပ်ရန် ကျန်နေပါတယ် — တစ်ပတ်မှာ တစ်ကြိမ်တော့ လုပ်ပေးပါ
        </p>
      )}
      <button
        onClick={onExport}
        disabled={busy}
        className="mt-3 w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white disabled:opacity-60"
      >
        {busy ? 'ထုတ်နေပါတယ်…' : '⬇ Backup ဒေါင်းလုပ်'}
      </button>
      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </section>
  )
}

function MonthLockCard() {
  const { profile } = useAuth()
  const [locks, setLocks] = useState<string[]>([])
  const [month, setMonth] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('month_locks').select('month').order('month', { ascending: false })
    setLocks(((data ?? []) as { month: string }[]).map((r) => r.month))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function onLock() {
    if (!month) return
    setMsg(null)
    const { error } = await supabase
      .from('month_locks')
      .insert({ month: `${month}-01`, locked_by: profile?.id ?? null })
    if (error) setMsg(error.message)
    await load()
  }

  async function onUnlock(m: string) {
    if (!confirm(`${m.slice(0, 7)} ကို lock ပြန်ဖွင့်မှာ သေချာပါသလား?`)) return
    setMsg(null)
    const { error } = await supabase.from('month_locks').delete().eq('month', m)
    if (error) setMsg(error.message)
    await load()
  }

  return (
    <section className="rounded-2xl border p-4">
      <h2 className="font-semibold">လ ပိတ်ခြင်း (Month Lock)</h2>
      <p className="mt-1 text-sm opacity-80">
        ပိတ်ထားသော လအတွင်း မည်သည့် မှတ်တမ်ကိုမှ ပြင်/ဖျက်/ထည့် လုပ်၍ မရပါ (ပိုင်ရှင် အပါအဝင်)။
      </p>
      <div className="mt-3 flex gap-2">
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="flex-1 rounded-xl border px-3 py-2 dark:bg-neutral-900"
        />
        <button onClick={onLock} className="rounded-xl bg-teal-700 px-4 py-2 font-semibold text-white">
          ပိတ်ရန်
        </button>
      </div>
      {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
      {locks.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {locks.map((m) => (
            <li key={m} className="flex items-center justify-between">
              <span>🔒 {m.slice(0, 7)}</span>
              {profile?.role === 'owner' && (
                <button onClick={() => onUnlock(m)} className="rounded-lg border px-2.5 py-1">
                  ပြန်ဖွင့်ရန်
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function HomePage() {
  const { profile } = useAuth()
  const [todayCount, setTodayCount] = useState<number | null>(null)
  const [todayAmount, setTodayAmount] = useState<number | null>(null)

  useEffect(() => {
    const today = todayYangon()
    supabase
      .from('daily_entries')
      .select('amount')
      .eq('entry_date', today)
      .then(({ data }) => {
        const rows = (data ?? []) as { amount: number }[]
        setTodayCount(rows.length)
        setTodayAmount(rows.reduce((s, r) => s + (r.amount ?? 0), 0))
      })
  }, [])

  const role = profile?.role

  return (
    <div className="space-y-4">
      {role === 'owner' && <BackupCard />}
      {(role === 'owner' || role === 'manager') && <MonthLockCard />}

      <section className="rounded-2xl border p-4">
        <h2 className="font-semibold">ယနေ့ အခြေအနေ</h2>
        <p className="mt-1 text-sm opacity-80">
          ပို့ဆောင်မှု မှတ်တမ်း {todayCount ?? '…'} ခု · စုစုပေါင်း{' '}
          {todayAmount != null ? formatMMK(todayAmount) : '…'}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center text-sm">
          <Link to="/entries" className="rounded-xl bg-neutral-100 py-3 dark:bg-neutral-800">
            ပို့ဆောင်မှု ထည့်ရန် / ကြည့်ရန်
          </Link>
          <Link to="/payments" className="rounded-xl bg-neutral-100 py-3 dark:bg-neutral-800">
            ငွေကောက်ခံမှု
          </Link>
        </div>
      </section>

      {role === 'agent' && (
        <section className="rounded-2xl border p-4">
          <h2 className="font-semibold">ကျွန်ုပ်၏ စာရင်း</h2>
          <p className="mt-1 text-sm opacity-80">သင့်ရဲ့ ကိုယ်ပိုင် မှတ်တမ်းများကိုပဲ မြင်ရပါမယ်။</p>
          <Link
            to="/my"
            className="mt-3 block rounded-xl bg-teal-700 py-2.5 text-center font-semibold text-white"
          >
            ကြည့်ရန်
          </Link>
        </section>
      )}
    </div>
  )
}
