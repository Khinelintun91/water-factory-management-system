import { useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import { supabase } from './lib/supabase'
import { ROLE_LABELS } from './lib/types'
import LoginPage from './pages/LoginPage'
import HomePage from './pages/HomePage'
import AgentsPage from './pages/AgentsPage'
import EntriesPage from './pages/EntriesPage'
import PaymentsPage from './pages/PaymentsPage'
import ExpensesPage from './pages/ExpensesPage'
import HistoryPage from './pages/HistoryPage'
import UsersPage from './pages/UsersPage'
import MyPage from './pages/MyPage'
import DisputesPage from './pages/DisputesPage'

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
  { to: '/expenses', label: 'အသုံးစရိတ်များ', roles: ['owner', 'manager'] },
  { to: '/history', label: 'ပြောင်းလဲမှုမှတ်တမ်း', roles: ['owner', 'manager'] },
  { to: '/disputes', label: 'အငြင်းပွားမှုများ', roles: ['owner', 'manager', 'agent'] },
  { to: '/users', label: 'အသုံးပြုသူများ', roles: ['owner'] },
  { to: '/my', label: 'ကျွန်ုပ်၏ စာရင်း', roles: ['agent'] },
]

export default function App() {
  const { loading, configured, session, profile, signOut } = useAuth()
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

  const nav = NAV.filter((n) => n.roles.includes(profile.role))

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
          <button
            onClick={signOut}
            className="rounded-lg border px-3 py-1.5 text-sm active:scale-95"
          >
            ထွက်ရန်
          </button>
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
          <Route path="/entries" element={<EntriesPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/disputes" element={<DisputesPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/my" element={<MyPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
