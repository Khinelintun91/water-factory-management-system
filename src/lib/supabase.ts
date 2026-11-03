import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

if (!url || !publishableKey) {
  // Surfaced in the UI by AuthContext; keep the message explicit for setup.
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY — see .env.example')
}

export const supabase = createClient(url ?? '', publishableKey ?? '')

export const isConfigured = Boolean(url && publishableKey)

/** Login identity mapping: username -> synthetic email (same pattern as the old app). */
export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@waterfactory.local`
}
