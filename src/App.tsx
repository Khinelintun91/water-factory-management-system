import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import { supabase } from './lib/supabase'
import { ROLE_LABELS } from './lib/types'
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
import { applyStoredTheme } from './lib/theme'

applyStoredTheme()

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
  { to: '/inventory', label: 'ပုလင်း စာရင်း', roles: ['owner', 'manager'] },
  { to: '/expenses', label: 'အသုံးစရိတ်များ', roles: ['owner', 'manager'] },
  { to: '/payroll', label: 'လစာ', roles: ['owner', 'manager'] },
  { to: '/reports', label: 'အစီရင်ခံစာ', roles: ['owner', 'manager'] },
  { to: '/handover', label: 'ငွေလွှဲအပ်', roles: ['owner', 'manager'] },
  { to: '/data-quality', label: 'Data စစ်ဆေးမှု', roles: ['owner', 'manager'] },
  { to: '/history', label: 'ပြောင်းလဲမှုမှတ်တမ်း', roles: ['owner', 'manager'] },
  { to: '/disputes', label: 'အငြင်းပွားမှုများ', roles: ['owner', 'manager', 'agent'] },
  { to: '/users', label: 'အသုံးပြုသူများ', roles: ['owner'] },
  { to: '/my', label: 'ကျွန်ုပ်၏ စာရင်း', roles: ['agent'] },
  { to: '/settings', label: 'ဆက်တင်', roles: ['owner', 'manager', 'staff', 'agent'] },
]

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
    return <div className="p-6 text-center">ခဏစောင့်ပါ…</div>
  }

  if (!session || !profile) {
    return <LoginPage factoryName={factoryName} />
  }

  const nav = NAV.filter((n) => n.roles.some((r) => roles.includes(r)))

  return (
    <div className="mx-auto min-h-dvh max-w-2xl">
      <header className="sticky top-0 z-10 border-b bg-white/90 px-4 py-3 backdrop-blur dark:bg-neutral-900/90">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-bold leading-tight">{factoryName}</div>
            <div className="text-xs opacity-70">
              {profile.username} · {ROLE_LABELS[profile.role]}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell />
            <button
              onClick={signOut}
              className="rounded-lg border px-3 py-1.5 text-sm active:scale-95"
            >
              ထွက်ရန်
            </button>
          </div>
        </div>
        <nav className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm ${
                location.pathname === n.to
                  ? 'bg-teal-700 text-white'
                  : 'bg-neutral-100 dark:bg-neutral-800'
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="p-4">
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
    </div>
  )
}
