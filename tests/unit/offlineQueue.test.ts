import { beforeEach, describe, expect, it } from 'vitest'
import {
  clear,
  count,
  enqueue,
  isNetworkError,
  peekAll,
  removeAt,
  type EntryInsert,
} from '../../src/lib/offlineQueue'

// Minimal in-memory localStorage (the module reads the global at call
// time, so a plain stub is enough — no DOM needed).
class FakeStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
}
const storage = new FakeStorage()
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const payload = (agent: string): EntryInsert => ({
  entry_date: '2026-11-06',
  agent_id: agent,
  delivered_qty: 5,
  returned_qty: 1,
  amount_collected: 1000,
  notes: null,
  created_by: null,
})

beforeEach(() => clear())

describe('offlineQueue', () => {
  it('starts empty and tolerates corrupt storage', () => {
    expect(count()).toBe(0)
    storage.setItem('wfms-entry-queue', '{not json')
    expect(peekAll()).toEqual([])
    storage.setItem('wfms-entry-queue', '{"not":"an array"}')
    expect(peekAll()).toEqual([])
  })

  it('enqueues in FIFO order and removes by index', () => {
    enqueue(payload('agent-a'))
    enqueue(payload('agent-b'))
    expect(count()).toBe(2)
    expect(peekAll().map(q => q.payload.agent_id)).toEqual(['agent-a', 'agent-b'])
    expect(typeof peekAll()[0].queued_at).toBe('string')
    removeAt(0)
    expect(peekAll().map(q => q.payload.agent_id)).toEqual(['agent-b'])
    removeAt(99) // out of range: no-op, no throw
    expect(count()).toBe(1)
    clear()
    expect(count()).toBe(0)
  })

  it('classifies network errors vs server rule errors', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkError(new Error('Network request failed'))).toBe(true)
    expect(isNetworkError(new Error('same_day_only: entry_date must be today'))).toBe(false)
    expect(isNetworkError(new Error('permission denied'))).toBe(false)
    expect(isNetworkError(null)).toBe(false)
  })
})
