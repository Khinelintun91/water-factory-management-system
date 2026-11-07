import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import { supabase } from './lib/supabase'
import { personName, ROLE_LABELS } from './lib/types'
import LoginPage from './pages/LoginPage'
import HomePage from './pages/HomePage'
import AgentsPage from './pages/AgentsPage'
import AgentDetailPage from './pages/AgentDetailPage'
import CloseoutPage from './pages/CloseoutPage'
import EntriesPage from './pages/EntriesPage'
import PaymentsPage from './pages/PaymentsPage'
import CollectionsPage from './pages/CollectionsPage'
import InventoryPage from './pages/InventoryPage'
import ExpensesPage from './pages/ExpensesPage'
import HistoryPage from './pages/HistoryPage'
import UsersPage from './pages/UsersPage'
import MyPage from './pages/MyPage'
import DisputesPage from './pages/DisputesPage'
import PayrollPage from './pages/PayrollPage'
import ReportsPage from './pages/ReportsPage'
import HandoverPage from './pages/HandoverPage'
import DataQualityPage from './pages/DataQualityPage'
import SettingsPage from './pages/SettingsPage'
import NotificationBell from './components/NotificationBell'
import ScrollNav from './components/ScrollNav'
import { DropIcon, MoreIcon, NavIcon } from './components/icons'
import { Card, LoadingState, PrimaryButton, SecondaryButton } from './components/ui'
import { applyStoredTheme } from './lib/theme'
import { applyLanguage } from './lib/i18n'

applyStoredTheme()
applyLanguage()

function useFactoryName(): string {
  const [name, setName] = useState('ရေသန့်စက်ရုံ')
  useEffect(() => {
    supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'factory_name')
      .maybeSingle()
      .then(({ data }) => {
        const v = (data as { value: unknown } | null)?.value
        if (typeof v === 'string' && v.trim()) setName(v)
      })
  }, [])
  return name
}

const NAV: { to: string; label: string; roles: string[] }[] = [
  { to: '/', label: 'ပင်မ', roles: ['owner', 'manager', 'staff', 'agent'] },
  { to: '/entries', label: 'ပို့ဆောင်မှုများ', roles: ['owner', 'manager', 'staff', 'agent'] },
  { to: '/payments', label: 'ငွေကောက်ခံမှုများ', roles: ['owner', 'manager', 'staff', 'agent'] },
  { to: '/agents', label: 'ကိုယ်စားလှယ်များ', roles: ['owner', 'manager', 'staff'] },
  { to: '/collections', label: 'ကောက်ခံမှုနှင့် ကြွေးစာရင်း', roles: ['owner', 'manager'] },
  { to: '/inventory', label: 'ဗူးလက်ကျန်', roles: ['owner', 'manager'] },
  { to: '/expenses', label: 'အသုံးစရိတ်များ', roles: ['owner', 'manager'] },
  { to: '/payroll', label: 'လစာ', roles: ['owner', 'manager'] },
  { to: '/reports', label: 'အစီရင်ခံစာ', roles: ['owner', 'manager'] },
  { to: '/handover', label: 'ငွေလွှဲအပ်', roles: ['owner', 'manager'] },
  { to: '/data-quality', label: 'ဒေတာ စစ်ဆေးမှု', roles: ['owner', 'manager'] },
  { to: '/history', label: 'ပြောင်းလဲမှုမှတ်တမ်း', roles: ['owner', 'manager'] },
  { to: '/disputes', label: 'အငြင်းပွားမှုများ', roles: ['owner', 'manager', 'agent'] },
  { to: '/users', label: 'အသုံးပြုသူများ', roles: ['owner'] },
  { to: '/my', label: 'ကျွန်ုပ်၏ စာရင်း', roles: ['agent'] },
  { to: '/settings', label: 'ဆက်တင်', roles: ['owner', 'manager', 'staff', 'agent'] },
]

/** Which nav item the current path belongs to (detail pages highlight
 *  their parent section, e.g. an agent detail / close-out highlights
 *  Agents). */
function isNavActive(to: string, pathname: string): boolean {
  if (to === '/') return pathname === '/'
  if (to === '/agents') return pathname.startsWith('/agents') || pathname.startsWith('/closeout')
  return pathname === to || pathname.startsWith(`${to}/`)
}

/** Route-level role gate (defense in depth; RLS remains the real boundary).
 *  Uses the EFFECTIVE roles (primary + extras; co_owner counts as manager). */
function Guard({ roles: allowed, children }: { roles: string[]; children: ReactNode }) {
  const { profile, roles } = useAuth()
  if (!profile) return null
  return allowed.some((r) => roles.includes(r)) ? (
    <>{children}</>
  ) : (
    <Navigate to="/" replace />
  )
}

export default function App() {
  const { loading, configured, session, profile, roles, signOut } = useAuth()
  const factoryName = useFactoryName()
  const location = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)

  // The "more" sheet closes whenever the route changes / on Escape.
  useEffect(() => {
    setMoreOpen(false)
  }, [location.pathname])
  useEffect(() => {
    if (!moreOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [moreOpen])

  if (!configured) {
    return (
      <div className="mx-auto max-w-md p-6 text-center">
        <h1 className="text-xl font-bold">စနစ် မပြင်ဆင်ရသေးပါ</h1>
        <p className="mt-2 text-sm opacity-80">
          Supabase URL နှင့် publishable key သတ်မှတ်ရန် လိုအပ်ပါတယ် (.env.example ကို ကြည့်ပါ)။
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <LoadingState />
      </div>
    )
  }

  if (!session) {
    return <LoginPage factoryName={factoryName} />
  }

  if (!profile) {
    // Signed in, but the account has no profile row — falling back to the
    // login form would dead-end (submitting it changes nothing), so show a
    // plain notice with a working sign-out instead.
    return (
      <div className="grid min-h-dvh place-items-center p-6">
        <Card className="w-full max-w-md text-center">
          <h1 className="text-lg font-bold">အကောင့် မှတ်တမ်း မတွေ့ပါ</h1>
          <p className="mt-2 text-sm text-stone-600 dark:text-neutral-300">
            ဒီအကောင့်အတွက် အသုံးပြုသူ မှတ်တမ်း မရှိသေးပါ — ပိုင်ရှင်ကို ဆက်သွယ်ပါ
          </p>
          <PrimaryButton onClick={signOut} className="mt-4 w-full">
            ထွက်ရန်
          </PrimaryButton>
        </Card>
      </div>
    )
  }

  const nav = NAV.filter((n) => n.roles.some((r) => roles.includes(r)))

  // Phone bottom tabs: the role's primary destinations in priority order,
  // up to four; everything else lives under "More".
  const TAB_PRIORITY = ['/', '/entries', '/agents', '/collections', '/payments', '/my', '/disputes']
  const tabs = TAB_PRIORITY.filter((p) => nav.some((n) => n.to === p))
    .slice(0, 4)
    .map((p) => nav.find((n) => n.to === p)!)
  const moreActive =
    !tabs.some((t) => isNavActive(t.to, location.pathname)) &&
    nav.some((n) => isNavActive(n.to, location.pathname))

  const tabItemCls = (active: boolean) =>
    `flex min-h-[62px] flex-col items-center justify-center gap-1 px-1 py-1.5 text-center text-[11px] leading-tight ${
      active
        ? 'font-semibold text-brand-700 dark:text-brand-300'
        : 'text-stone-500 dark:text-neutral-400'
    }`

  return (
    <div className="min-h-dvh">
      {/* Tablet icon rail (768-1023px) / desktop sidebar (>=1024px). */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[76px] flex-col border-r border-stone-200 bg-white dark:border-neutral-800 dark:bg-neutral-900 md:flex lg:w-64 print:hidden">
        <div className="flex items-center justify-center gap-2.5 px-3 pb-2 pt-4 lg:justify-start lg:px-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-700 text-white shadow-sm">
            <DropIcon className="h-6 w-6" />
          </span>
          <span className="hidden min-w-0 lg:block">
            <span className="block truncate font-bold leading-tight">{factoryName}</span>
            <span className="block text-xs text-stone-500 dark:text-neutral-400">
              စီမံခန့်ခွဲမှုစနစ်
            </span>
          </span>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3 lg:px-3" aria-label="Menu">
          {nav.map((n) => {
            const active = isNavActive(n.to, location.pathname)
            return (
              <Link
                key={n.to}
                to={n.to}
                aria-current={active ? 'page' : undefined}
                className={`flex flex-col items-center justify-center gap-1 rounded-lg px-1 py-2.5 text-center text-[11px] leading-tight transition lg:flex-row lg:justify-start lg:gap-3 lg:px-3.5 lg:text-left lg:text-sm ${
                  active
                    ? 'bg-brand-700 font-semibold text-white'
                    : 'text-stone-600 hover:bg-brand-50 hover:text-brand-800 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white'
                }`}
              >
                <NavIcon to={n.to} className="h-6 w-6 shrink-0 lg:h-5 lg:w-5" />
                <span className="min-w-0">{n.label}</span>
              </Link>
            )
          })}
        </nav>
      </aside>

      <div className="flex min-h-dvh flex-col md:pl-[76px] lg:pl-64">
        {/* Top bar: identity + bell + sign-out on every size. */}
        <header className="sticky top-0 z-20 border-b border-stone-200 bg-white dark:border-neutral-800 dark:bg-neutral-900 print:hidden">
          <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-2 px-4 py-2.5 md:max-w-3xl lg:max-w-6xl lg:px-6">
            <div className="min-w-0">
              <div className="truncate font-bold leading-tight lg:hidden">{factoryName}</div>
              <div className="truncate text-xs text-stone-500 dark:text-neutral-400">
                {personName(profile)} · {ROLE_LABELS[profile.role]}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <NotificationBell />
              <SecondaryButton size="sm" onClick={signOut}>
                ထွက်ရန်
              </SecondaryButton>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-[calc(6.5rem_+_env(safe-area-inset-bottom))] pt-4 md:max-w-3xl md:pb-10 lg:max-w-6xl lg:px-6 lg:pt-6">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route
              path="/entries"
              element={
                <Guard roles={['owner', 'manager', 'staff', 'agent']}>
                  <EntriesPage />
                </Guard>
              }
            />
            <Route
              path="/payments"
              element={
                <Guard roles={['owner', 'manager', 'staff', 'agent']}>
                  <PaymentsPage />
                </Guard>
              }
            />
            <Route
              path="/agents"
              element={
                <Guard roles={['owner', 'manager', 'staff']}>
                  <AgentsPage />
                </Guard>
              }
            />
            <Route
              path="/agents/:id"
              element={
                <Guard roles={['owner', 'manager']}>
                  <AgentDetailPage />
                </Guard>
              }
            />
            <Route
              path="/closeout/:id"
              element={
                <Guard roles={['owner', 'manager']}>
                  <CloseoutPage />
                </Guard>
              }
            />
            <Route
              path="/collections"
              element={
                <Guard roles={['owner', 'manager']}>
                  <CollectionsPage />
                </Guard>
              }
            />
            <Route
              path="/inventory"
              element={
                <Guard roles={['owner', 'manager']}>
                  <InventoryPage />
                </Guard>
              }
            />
            <Route
              path="/expenses"
              element={
                <Guard roles={['owner', 'manager']}>
                  <ExpensesPage />
                </Guard>
              }
            />
            <Route
              path="/payroll"
              element={
                <Guard roles={['owner', 'manager']}>
                  <PayrollPage />
                </Guard>
              }
            />
            <Route
              path="/reports"
              element={
                <Guard roles={['owner', 'manager']}>
                  <ReportsPage />
                </Guard>
              }
            />
            <Route
              path="/handover"
              element={
                <Guard roles={['owner', 'manager']}>
                  <HandoverPage />
                </Guard>
              }
            />
            <Route
              path="/data-quality"
              element={
                <Guard roles={['owner', 'manager']}>
                  <DataQualityPage />
                </Guard>
              }
            />
            <Route
              path="/history"
              element={
                <Guard roles={['owner', 'manager']}>
                  <HistoryPage />
                </Guard>
              }
            />
            <Route
              path="/disputes"
              element={
                <Guard roles={['owner', 'manager', 'agent']}>
                  <DisputesPage />
                </Guard>
              }
            />
            <Route
              path="/users"
              element={
                <Guard roles={['owner']}>
                  <UsersPage />
                </Guard>
              }
            />
            <Route
              path="/my"
              element={
                <Guard roles={['agent']}>
                  <MyPage />
                </Guard>
              }
            />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>

        <ScrollNav />
      </div>

      {/* Phone bottom tab bar: primary destinations + More. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-neutral-800 dark:bg-neutral-900 md:hidden print:hidden"
        aria-label="Menu"
      >
        <div
          className="grid"
          style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}
        >
          {tabs.map((t) => {
            const active = isNavActive(t.to, location.pathname)
            return (
              <Link
                key={t.to}
                to={t.to}
                aria-current={active ? 'page' : undefined}
                className={tabItemCls(active)}
              >
                <span
                  className={`flex items-center justify-center rounded-full px-3 py-0.5 ${
                    active ? 'bg-brand-100 text-brand-800 dark:bg-brand-800 dark:text-white' : ''
                  }`}
                >
                  <NavIcon to={t.to} className="h-6 w-6" />
                </span>
                <span className="line-clamp-2 max-w-full">{t.label}</span>
              </Link>
            )
          })}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-expanded={moreOpen}
            className={tabItemCls(moreActive)}
          >
            <span
              className={`flex items-center justify-center rounded-full px-3 py-0.5 ${
                moreActive ? 'bg-brand-100 text-brand-800 dark:bg-brand-800 dark:text-white' : ''
              }`}
            >
              <MoreIcon className="h-6 w-6" />
            </span>
            <span className="line-clamp-2 max-w-full">နောက်ထပ်</span>
          </button>
        </div>
      </nav>

      {/* Phone "More" sheet: the full nav list for the role. */}
      {moreOpen && (
        <div className="fixed inset-0 z-40 md:hidden print:hidden" role="dialog" aria-modal="true" aria-label="နောက်ထပ်">
          <button
            type="button"
            aria-label="ပိတ်ရန်"
            onClick={() => setMoreOpen(false)}
            className="absolute inset-0 h-full w-full bg-black/40"
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-stone-200 bg-white p-4 pb-[calc(1rem_+_env(safe-area-inset-bottom))] shadow-pop dark:border-neutral-700 dark:bg-neutral-900">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-stone-300 dark:bg-neutral-700" />
            <div className="mb-3 flex items-center justify-between">
              <span className="font-bold">နောက်ထပ်</span>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="ပိတ်ရန်"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-stone-100 text-lg leading-none dark:bg-neutral-800"
              >
                ✕
              </button>
            </div>
            <div className="grid max-h-[55vh] grid-cols-4 gap-2 overflow-y-auto">
              {nav.map((n) => {
                const active = isNavActive(n.to, location.pathname)
                return (
                  <Link
                    key={n.to}
                    to={n.to}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setMoreOpen(false)}
                    className={`flex flex-col items-center gap-1.5 rounded-xl border px-1 py-3 text-center text-[11px] leading-tight ${
                      active
                        ? 'border-brand-700 bg-brand-50 font-semibold text-brand-800 dark:border-brand-400 dark:bg-brand-950 dark:text-brand-100'
                        : 'border-stone-200 text-stone-600 dark:border-neutral-800 dark:text-neutral-300'
                    }`}
                  >
                    <NavIcon to={n.to} className="h-6 w-6" />
                    <span className="line-clamp-2 max-w-full">{n.label}</span>
                  </Link>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
