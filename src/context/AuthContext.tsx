import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isConfigured, supabase, usernameToEmail } from '../lib/supabase'
import type { Profile } from '../lib/types'
import { fmtTime12 } from '../lib/types'

interface AuthState {
  loading: boolean
  configured: boolean
  session: Session | null
  profile: Profile | null
  /** Effective roles: primary role + user_roles extras; co_owner implies manager. */
  roles: string[]
  signIn: (username: string, pin: string) => Promise<{ error?: string }>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

function effectiveRoles(primary: string, extras: string[]): string[] {
  const set = new Set<string>([primary, ...extras])
  if (set.has('co_owner')) set.add('manager')
  return [...set]
}

const AuthContext = createContext<AuthState | null>(null)

async function logAttempt(username: string, success: boolean) {
  // Best effort only: login history must never block a sign-in.
  try {
    await supabase
      .from('login_logs')
      .insert({ username, success, user_agent: navigator.userAgent })
  } catch {
    /* ignore */
  }
}

function lockedMessage(lockedUntil: string): string {
  const when = fmtTime12(lockedUntil)
  return `PIN မှားတာ များလွန်းလို့ ဒီအကောင့် ယာယီ ပိတ်ထားပါတယ် — ${when} အထိ စောင့်ပြီး ပြန်ဝင်ပါ`
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [roles, setRoles] = useState<string[]>([])

  const loadProfile = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('id, username, display_name, role, agent_id, active')
      .eq('id', userId)
      .maybeSingle()
    const p = (data as Profile | null) ?? null
    setProfile(p)
    if (p) {
      const { data: extra } = await supabase
        .from('user_roles')
        .select('role')
        .eq('profile_id', userId)
      setRoles(
        effectiveRoles(
          p.role,
          ((extra ?? []) as { role: string }[]).map((r) => r.role),
        ),
      )
    } else {
      setRoles([])
    }
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
      else {
        setProfile(null)
        setRoles([])
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [loadProfile])

  const signIn = useCallback(async (username: string, pin: string) => {
    // Lockout (old-app rule): 5 consecutive failures lock the account for
    // 15 minutes. Checked before the attempt; recorded on failure; cleared
    // on success. All enforcement lives in the pin_attempts RPCs.
    const { data: lockedUntil } = await supabase.rpc('login_lock_status', {
      p_username: username,
    })
    if (typeof lockedUntil === 'string' && lockedUntil) {
      await logAttempt(username, false)
      return { error: lockedMessage(lockedUntil) }
    }
    const { data, error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password: pin,
    })
    if (error || !data.user) {
      const { data: newLock } = await supabase.rpc('record_login_failure', {
        p_username: username,
      })
      await logAttempt(username, false)
      if (typeof newLock === 'string' && newLock) {
        return { error: lockedMessage(newLock) }
      }
      return { error: 'အမည် သို့မဟုတ် PIN မှားနေပါတယ်' }
    }
    const { data: p } = await supabase
      .from('profiles')
      .select('id, username, display_name, role, agent_id, active')
      .eq('id', data.user.id)
      .maybeSingle()
    if (!p || !(p as Profile).active) {
      await supabase.auth.signOut()
      await logAttempt(username, false)
      return { error: 'ဒီအကောင့် ပိတ်ထားပါတယ် — ပိုင်ရှင်ကို ဆက်သွယ်ပါ' }
    }
    setProfile(p as Profile)
    const { data: extra } = await supabase
      .from('user_roles')
      .select('role')
      .eq('profile_id', data.user.id)
    setRoles(
      effectiveRoles(
        (p as Profile).role,
        ((extra ?? []) as { role: string }[]).map((r) => r.role),
      ),
    )
    try {
      await supabase.rpc('clear_login_failures')
    } catch {
      /* best effort */
    }
    await logAttempt(username, true)
    return {}
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setProfile(null)
    setRoles([])
    setSession(null)
  }, [])

  const refreshProfile = useCallback(async () => {
    if (session) await loadProfile(session.user.id)
  }, [session, loadProfile])

  return (
    <AuthContext.Provider
      value={{
        loading,
        configured: isConfigured,
        session,
        profile,
        roles,
        signIn,
        signOut,
        refreshProfile,
      }}
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
