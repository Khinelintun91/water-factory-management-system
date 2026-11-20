import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// In-app notification bell. Rows are created by DB triggers (migration
// 0011); the client only reads them and marks them read (RLS: own rows
// only). Freshness is instant while the app is open: migration 0043
// publishes the table to Supabase Realtime, so an INSERT/UPDATE on the
// signed-in user's own rows triggers a reload the moment it happens.
// A refetch on visibility/focus covers returning to a backgrounded tab
// (phone browsers suspend timers and sockets), and the old 30-second
// poll stays as a fallback, mirroring the old app's refetchInterval.

interface NotificationRow {
  id: string
  kind: string
  title: string
  body: string
  link: string
  priority: 'normal' | 'high'
  read_at: string | null
  created_at: string
}

const KIND_STYLE: Record<string, { icon: string; chip: string }> = {
  delivery: { icon: '🚚', chip: 'bg-teal-100 dark:bg-teal-900/50' },
  collection: { icon: '💰', chip: 'bg-green-100 dark:bg-green-900/50' },
  receipt: { icon: '🧾', chip: 'bg-neutral-100 dark:bg-neutral-800' },
  dispute: { icon: '⚠️', chip: 'bg-red-100 dark:bg-red-900/50' },
  dispute_reply: { icon: '✅', chip: 'bg-green-100 dark:bg-green-900/50' },
  data_quality: { icon: '🔍', chip: 'bg-amber-100 dark:bg-amber-900/50' },
  digest: { icon: '📰', chip: 'bg-sky-100 dark:bg-sky-900/50' },
}
const FALLBACK_STYLE = { icon: '🔔', chip: 'bg-neutral-100 dark:bg-neutral-800' }

function yangonYmd(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yangon' }).format(d)
}

/** Short relative/absolute time, 12-hour AM/PM, always Asia/Yangon. */
function formatWhen(iso: string): string {
  const then = new Date(iso)
  const diffMin = Math.floor((Date.now() - then.getTime()) / 60000)
  if (diffMin < 1) return 'အခုပဲ'
  if (diffMin < 60) return `${diffMin} မိနစ် အလို`

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Yangon',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(then)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00'
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  const time = `${h12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`

  const dayGap = Math.round(
    (Date.parse(`${yangonYmd(new Date())}T00:00:00Z`) -
      Date.parse(`${yangonYmd(then)}T00:00:00Z`)) /
      86400000,
  )
  if (dayGap === 0) return time
  if (dayGap === 1) return `မနေ့က · ${time}`
  return `${yangonYmd(then)} · ${time}`
}

export default function NotificationBell() {
  const navigate = useNavigate()
  const { session } = useAuth()
  const userId = session?.user.id
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<NotificationRow[]>([])
  const [unread, setUnread] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const [{ data }, { count }] = await Promise.all([
      supabase
        .from('notifications')
        .select('id, kind, title, body, link, priority, read_at, created_at')
        .order('created_at', { ascending: false })
        .limit(30),
      supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .is('read_at', null),
    ])
    setRows((data ?? []) as NotificationRow[])
    setUnread(count ?? 0)
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30000)
    // Coming back to the app (tab visible again / window refocused) may
    // have missed events while the browser suspended us — reload at once
    // instead of waiting for the next poll tick.
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', load)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', load)
    }
  }, [load])

  // Instant delivery: Realtime streams changes to this user's own
  // notification rows (the filter narrows the subscription; RLS is what
  // enforces it server-side). Any event just runs the same reload as
  // the poll, so the badge and list can never drift from the table.
  useEffect(() => {
    if (!userId) return
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        () => load(),
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        () => load(),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [userId, load])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open ])

  async function openItem(n: NotificationRow) {
    if (!n.read_at) {
      await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', n.id)
      load()
    }
    setOpen(false)
    if (n.link) navigate(n.link)
  }

  async function markAllRead() {
    if (unread === 0) return
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .is('read_at', null)
    load()
  }

  // `static` below the sm breakpoint so the open panel is positioned
  // against the sticky header (see .notif-panel in index.css). From sm
  // up it stays anchored to this button, same as before.
  return (
    <div ref={rootRef} className="static sm:relative">
      <button
        type="button"
        aria-label="အသိပေးချက်များ"
        onClick={() => {
          setOpen((o) => !o)
          load()
        }}
        className="relative rounded-full border p-2 leading-none active:scale-95"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
          aria-hidden="true"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold tabular-nums text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="notif-panel absolute right-0 top-full z-30 mt-2 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-2xl border bg-white shadow-xl dark:bg-neutral-900">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="min-w-0 break-words text-sm font-semibold leading-5">အသိပေးချက်များ</span>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="shrink-0 rounded-lg px-2 py-1 text-xs text-teal-700 dark:text-teal-400"
              >
                အားလုံး ဖတ်ပြီး
              </button>
            )}
          </div>
          <div className="notif-scroll max-h-96 overflow-y-auto overscroll-contain">
            {rows.length === 0 && (
              <p className="py-8 text-center text-sm opacity-60">
                အသိပေးချက် မရှိသေးပါ
              </p>
            )}
            {rows.map((n) => {
              const style = KIND_STYLE[n.kind] ?? FALLBACK_STYLE
              const isUnread = !n.read_at
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => openItem(n)}
                  className={`block w-full border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-neutral-50 dark:hover:bg-neutral-800 ${
                    isUnread ? 'bg-teal-50/60 dark:bg-neutral-800/60' : ''
                  }`}
                >
                  <span className="flex items-start gap-2.5">
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base ${style.chip}`}
                    >
                      {style.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block break-words text-sm leading-5 ${
                          isUnread ? 'font-semibold' : 'opacity-75'
                        }`}
                      >
                        {n.title}
                        {n.priority === 'high' && (
                          <span className="ml-1.5 rounded bg-red-100 px-1 text-[10px] font-bold text-red-700 dark:bg-red-900/60 dark:text-red-300">
                            အရေးကြီး
                          </span>
                        )}
                      </span>
                      {n.body && (
                        <span className="mt-0.5 block break-words text-xs leading-5 opacity-70">
                          {n.body}
                        </span>
                      )}
                      <span className="mt-0.5 block text-[11px] opacity-50">
                        {formatWhen(n.created_at)}
                      </span>
                    </span>
                    {isUnread && (
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-600" />
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
