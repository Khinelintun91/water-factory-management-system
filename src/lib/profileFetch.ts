import type { Profile } from './types'

/** One raw profiles-query attempt, in the supabase-js result shape. */
export interface ProfileQueryResult {
  data: Profile | null
  error: unknown
}

/**
 * Outcome of loading a signed-in user's profile row:
 * - 'found'   — a query succeeded and returned the row.
 * - 'missing' — a query SUCCEEDED and there is no row (genuinely absent —
 *               the only outcome that may be shown as "account not found").
 * - 'error'   — every attempt errored (network blip, token-refresh race,
 *               cold connection on first open). An error is NOT evidence
 *               that the account is missing and must never be rendered
 *               as such.
 */
export type ProfileLoadOutcome =
  | { status: 'found'; profile: Profile }
  | { status: 'missing' }
  | { status: 'error' }

/** Backoff between attempts: 3 attempts total (≈600ms, then ≈1500ms). */
export const PROFILE_RETRY_DELAYS_MS: readonly number[] = [600, 1500]

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Run the profiles query with retries on error. A successful response —
 * with or without a row — resolves immediately; only errors (including a
 * rejected promise) consume another attempt.
 */
export async function loadProfileWithRetry(
  query: () => Promise<ProfileQueryResult>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<ProfileLoadOutcome> {
  for (let attempt = 0; attempt <= PROFILE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(PROFILE_RETRY_DELAYS_MS[attempt - 1])
    try {
      const { data, error } = await query()
      if (error) continue
      return data ? { status: 'found', profile: data } : { status: 'missing' }
    } catch {
      // A rejected promise is just another transient failure.
      continue
    }
  }
  return { status: 'error' }
}
