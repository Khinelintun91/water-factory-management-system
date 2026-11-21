import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isConfigured, supabase, usernameToEmail } from '../lib/supabase'
import type { Profile } from '../lib/types'
import { fmtTime12 } from '../lib/types'
import { loadProfileWithRetry, type ProfileQueryResult } from '../lib/profileFetch'

/**
 * Where the signed-in user's profile load stands:
 * - 'loading' — a load is in flight (or none has run yet).
 * - 'ready'   — a profile row is loaded.
 * - 'missing' — a load SUCCEEDED and there is no profile row (genuinely
 *               absent — the only state that may show "account not found").
 * - 'error'   — every load attempt errored (connection problem); the
 *               account may well exist, so this is never "not found".
 */
export type ProfileLoadStatus = 'loading' | 'ready' | 'missing' | 'error'

interface AuthState {
  loading: boolean
  configured: boolean
  session: Session | null
  profile: Profile | null
  profileStatus: ProfileLoadStatus
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
    await supabase.rpc('log_login_attempt', {
      p_username: username,
      p_success: success,
      p_user_agent: navigator.userAgent,
    })
  } catch {
    /* ignore */
  }
}

function lockedMessage(lockedUntil: string): string {
  const when = fmtTime12(lockedUntil)
  return `PIN မှားတာ များလွန်းလို့ ဒီအကောင့် ယာယီ ပိတ်ထားပါတယ် — ${when} အထိ စောင့်ပြီး ပြန်ဝင်ပါ`
}

const PROFILE_COLUMNS = 'id, username, display_name, role, agent_id, active'

/** One raw profiles-query attempt; the error is preserved, never swallowed. */
async function queryProfileOnce(userId: string): Promise<ProfileQueryResult> {
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', userId)
    .maybeSingle()
  return { data: (data as Profile | null) ?? null, error }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileStatus, setProfileStatus] = useState<ProfileLoadStatus>('loading')
  const [roles, setRoles] = useState<string[]>([])
  // Mirror of the loaded profile so an errored (re)load can never clear a
  // profile that is already on screen.
  const profileRef = useRef<Profile | null>(null)

  const loadRoles = useCallback(async (p: Profile) => {
    const { data: extra } = await supabase
      .from('user_roles')
      .select('role')
      .eq('profile_id', p.id)
    setRoles(
      effectiveRoles(
        p.role,
        ((extra ?? []) as { role: string }[]).map((r) => r.role),
      ),
    )
  }, [])

  const applyProfile = useCallback(
    async (p: Profile) => {
      profileRef.current = p
      setProfile(p)
      setProfileStatus('ready')
      await loadRoles(p)
    },
    [loadRoles],
  )

  const loadProfile = useCallback(
    async (userId: string) => {
      if (!profileRef.current) setProfileStatus('loading')
      const outcome = await loadProfileWithRetry(() => queryProfileOnce(userId))
      if (outcome.status === 'found') {
        await applyProfile(outcome.profile)
      } else if (outcome.status === 'missing') {
        // A successful empty result is the only proof the row is absent.
        profileRef.current = null
        setProfile(null)
        setRoles([])
        setProfileStatus('missing')
      } else if (!profileRef.current) {
        // All attempts errored and nothing is loaded: a connection
        // problem, NOT a missing account.
        setProfileStatus('error')
      }
      // Errored with a profile already loaded: keep showing it.
    },
    [applyProfile],
  )

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
        profileRef.current = null
        setProfile(null)
        setProfileStatus('loading')
        setRoles([])
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [loadProfile])

  const signIn = useCallback(
    async (username: string, pin: string) => {
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
        const { data: newLock } = await supabase.rpc('log_failed_login', {
          p_username: username,
          p_user_agent: navigator.userAgent,
        })
        if (typeof newLock === 'string' && newLock) {
          return { error: lockedMessage(newLock) }
        }
        return { error: 'အမည် သို့မဟုတ် PIN မှားနေပါတယ်' }
      }
      // The password was accepted. From here the profile load decides:
      // an errored load is a connection problem (retry; never claim the
      // account is disabled), and only a genuinely missing or inactive
      // row earns the disabled message.
      const outcome = await loadProfileWithRetry(() => queryProfileOnce(data.user.id))
      if (outcome.status === 'error') {
        await logAttempt(username, true)
        return {
          error: 'ချိတ်ဆက်မှု ပြဿနာ ရှိပါတယ် — ခဏစောင့်ပြီး ပြန်ကြိုးစားပါ',
        }
      }
      if (outcome.status === 'missing' || !outcome.profile.active) {
        await supabase.auth.signOut()
        await logAttempt(username, false)
        return { error: 'ဒီအကောင့် ပိတ်ထားပါတယ် — ပိုင်ရှင်ကို ဆက်သွယ်ပါ' }
      }
      await applyProfile(outcome.profile)
      try {
        await supabase.rpc('clear_login_failures')
      } catch {
        /* best effort */
      }
      await logAttempt(username, true)
      return {}
    },
    [applyProfile],
  )

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    profileRef.current = null
    setProfile(null)
    setProfileStatus('loading')
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
        profileStatus,
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
