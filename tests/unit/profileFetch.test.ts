import { describe, expect, it } from 'vitest'
import {
  loadProfileWithRetry,
  type ProfileQueryResult,
} from '../../src/lib/profileFetch'
import type { Profile } from '../../src/lib/types'

// The profile load must distinguish "the query errored" from "there is no
// profile row": an errored load used to render as the "account record not
// found" screen after a CORRECT login. Only a successful empty result may
// be treated as missing.

const row = {
  id: 'u-staff1',
  username: 'staff1',
  display_name: 'ခိုင်မောင်ဝင်း',
  role: 'staff',
  agent_id: null,
  active: true,
} as Profile

const found: ProfileQueryResult = { data: row, error: null }
const empty: ProfileQueryResult = { data: null, error: null }
const failed: ProfileQueryResult = {
  data: null,
  error: { message: 'fetch failed' },
}

/** A query that plays back scripted results (repeating the last one). */
function scripted(results: ProfileQueryResult[]) {
  let calls = 0
  const query = async (): Promise<ProfileQueryResult> => {
    const r = results[Math.min(calls, results.length - 1)]
    calls++
    return r
  }
  return { query, calls: () => calls }
}

/** Sleep stub that records the requested delays without waiting. */
function fakeSleep() {
  const delays: number[] = []
  const sleep = async (ms: number) => {
    delays.push(ms)
  }
  return { sleep, delays }
}

describe('loadProfileWithRetry', () => {
  it('succeeds on the first try: found, one call, no backoff', async () => {
    const { query, calls } = scripted([found])
    const { sleep, delays } = fakeSleep()
    const outcome = await loadProfileWithRetry(query, sleep)
    expect(outcome).toEqual({ status: 'found', profile: row })
    expect(calls()).toBe(1)
    expect(delays).toEqual([])
  })

  it('empty success on the first try is missing — no retries', async () => {
    const { query, calls } = scripted([empty])
    const { sleep, delays } = fakeSleep()
    const outcome = await loadProfileWithRetry(query, sleep)
    expect(outcome).toEqual({ status: 'missing' })
    expect(calls()).toBe(1)
    expect(delays).toEqual([])
  })

  it('fails once, then succeeds: found after one ≈600ms backoff', async () => {
    const { query, calls } = scripted([failed, found])
    const { sleep, delays } = fakeSleep()
    const outcome = await loadProfileWithRetry(query, sleep)
    expect(outcome).toEqual({ status: 'found', profile: row })
    expect(calls()).toBe(2)
    expect(delays).toEqual([600])
  })

  it('fails twice, then empty success: missing (genuinely absent)', async () => {
    const { query, calls } = scripted([failed, failed, empty])
    const { sleep, delays } = fakeSleep()
    const outcome = await loadProfileWithRetry(query, sleep)
    expect(outcome).toEqual({ status: 'missing' })
    expect(calls()).toBe(3)
    expect(delays).toEqual([600, 1500])
  })

  it('fails on every attempt: error outcome after 3 attempts', async () => {
    const { query, calls } = scripted([failed])
    const { sleep, delays } = fakeSleep()
    const outcome = await loadProfileWithRetry(query, sleep)
    expect(outcome).toEqual({ status: 'error' })
    expect(calls()).toBe(3)
    expect(delays).toEqual([600, 1500])
  })

  it('a rejected promise counts as an error and is retried', async () => {
    let calls = 0
    const query = async (): Promise<ProfileQueryResult> => {
      calls++
      if (calls === 1) throw new Error('network down')
      return found
    }
    const { sleep, delays } = fakeSleep()
    const outcome = await loadProfileWithRetry(query, sleep)
    expect(outcome).toEqual({ status: 'found', profile: row })
    expect(calls).toBe(2)
    expect(delays).toEqual([600])
  })
})
