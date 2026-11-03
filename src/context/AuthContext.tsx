import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isConfigured, supabase, usernameToEmail } from '../lib/supabase'
import type { Profile } from '../lib/types'

interface AuthState {
  loading: boolean
  configured: boolean
  session: Session | null
  profile: Profile | null
  signIn: (username: string, pin: string) => Promise<{ error?: string }>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

async function logAttempt(username: string, success: boolean) {
  // Best effort only: login history must never block a sign-in.
  try {
    await supabase.from('login_logs').insert({ username, success })
  } catch {
    /* ignore */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)

  const loadProfile = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('id, username, role, agent_id, active')
      .eq('id', userId)
      .maybeSingle()
    setProfile((data as Profile | null) ?? null)
  }, [])

  useEffect(() => {
    if (!isConfigured) {
      setLoading(false)
      return
    }
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session)
      if (data.session) await loadProfile(data.session.user.id)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, s) => {
      setSession(s)
      if (s) await loadProfile(s.user.id)
      else setProfile(null)
    })
    return () => sub.subscription.unsubscribe()
  }, [loadProfile])

  const signIn = useCallback(async (username: string, pin: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password: pin,
    })
    if (error || !data.user) {
      await logAttempt(username, false)
      return { error: 'အမည် သို့မဟုတ် PIN မှားနေပါတယ်' }
    }
    const { data: p } = await supabase
      .from('profiles')
      .select('id, username, role, agent_id, active')
      .eq('id', data.user.id)
      .maybeSingle()
    if (!p || !(p as Profile).active) {
      await supabase.auth.signOut()
      await logAttempt(username, false)
      return { error: 'ဒီအကောင့် ပိတ်ထားပါတယ် — ပိုင်ရှင်ကို ဆက်သွယ်ပါ' }
    }
    setProfile(p as Profile)
    await logAttempt(username, true)
    return {}
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setProfile(null)
    setSession(null)
  }, [])

  const refreshProfile = useCallback(async () => {
    if (session) await loadProfile(session.user.id)
  }, [session, loadProfile])

  return (
    <AuthContext.Provider
      value={{ loading, configured: isConfigured, session, profile, signIn, signOut, refreshProfile }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
