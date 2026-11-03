// Offline delivery-entry queue. When a save cannot reach the server
// (no connection / network error), EntriesPage stores the EXACT insert
// payload it would have sent, so nothing typed is lost; the queue is
// flushed in order when the connection returns. Payloads carry no
// amount/unit_price — the server computes both at insert time, exactly
// like the normal save path.
//
// Caveat: the DB insert-date guard requires entry_date = today
// (Asia/Yangon) at insert time, so an entry queued near midnight and
// flushed the next day is rejected with same_day_only; the flush drops
// such stale items, keeps flushing the rest, and EntriesPage shows a
// persistent warning with the dropped count.

/** The exact object EntriesPage inserts into daily_entries. */
export interface EntryInsert {
  entry_date: string
  agent_id: string
  delivered_qty: number
  returned_qty: number
  amount_collected: number
  notes: string | null
  created_by: string | null
}

export interface QueuedEntry {
  payload: EntryInsert
  queued_at: string
}

const QUEUE_KEY = 'wfms-entry-queue'

export function peekAll(): QueuedEntry[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as QueuedEntry[]) : []
  } catch {
    return []
  }
}

function writeAll(items: QueuedEntry[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items))
}

export function enqueue(payload: EntryInsert): void {
  writeAll([...peekAll(), { payload, queued_at: new Date().toISOString() }])
}

export function removeAt(index: number): void {
  const items = peekAll()
  if (index < 0 || index >= items.length) return
  items.splice(index, 1)
  writeAll(items)
}

export function clear(): void {
  try {
    localStorage.removeItem(QUEUE_KEY)
  } catch {
    /* storage unavailable */
  }
}

export function count(): number {
  return peekAll().length
}

/** True for connectivity-style failures (as opposed to server rule errors). */
export function isNetworkError(err: unknown): boolean {
  const m = String((err as { message?: unknown } | null)?.message ?? err)
  return (
    err instanceof TypeError ||
    /failed to fetch|networkerror|network request failed|load failed|fetcherror/i.test(m)
  )
}
