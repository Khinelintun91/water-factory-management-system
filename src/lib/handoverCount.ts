/**
 * Pure blind-count helpers for HandoverPage (Package A, 2026-11-28).
 *
 * Unsaved handovers start with an empty received input so Owner/Manager
 * types the physically counted cash first without seeing the system's
 * expected figure beforehand. Once a value is typed (or a saved handover
 * already exists), expected and the over/short difference are revealed.
 */

export type HandoverDiffStatus = 'uncounted' | 'match' | 'short' | 'over'

export interface HandoverRowState {
  /** True when the user has typed a valid non-negative count. */
  hasInput: boolean
  /** True when expected + difference should be revealed (saved or typed). */
  revealed: boolean
  /** Parsed received figure, or null when empty / invalid. */
  received: number | null
  /** received - expected when revealed and hasInput, else null. */
  diff: number | null
  status: HandoverDiffStatus
}

/** Initial text value for an employee's received input on page load. */
export function initialReceivedInput(savedReceived: number | null | undefined): string {
  return savedReceived !== null && savedReceived !== undefined ? String(savedReceived) : ''
}

/** Parse a received-cash input string; blank string returns null (not 0). */
export function parseReceivedInput(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

/** Compute blind-count visibility and over/short status for one employee card. */
export function evaluateHandoverRow(
  rawInput: string,
  expected: number,
  isSaved: boolean,
): HandoverRowState {
  const received = parseReceivedInput(rawInput)
  const hasInput = received !== null
  const revealed = isSaved || hasInput
  if (!hasInput) {
    return { hasInput: false, revealed, received: null, diff: null, status: 'uncounted' }
  }
  const diff = received - expected
  const status: HandoverDiffStatus = diff === 0 ? 'match' : diff < 0 ? 'short' : 'over'
  return { hasInput: true, revealed, received, diff, status }
}

/**
 * Aggregate summary across only revealed (counted or saved) employees so the
 * top summary cards never leak uncounted employees' expected cash ahead of
 * their blind count.
 */
export function summarizeHandoverTotals(
  rows: { rawInput: string; expected: number; isSaved: boolean }[],
): { exp: number; rec: number; diff: number; counted: number; total: number } {
  let exp = 0
  let rec = 0
  let counted = 0
  for (const r of rows) {
    const state = evaluateHandoverRow(r.rawInput, r.expected, r.isSaved)
    if (!state.revealed) continue
    counted += 1
    exp += r.expected
    if (state.received !== null) rec += state.received
  }
  return { exp, rec, diff: rec - exp, counted, total: rows.length }
}

export interface OtherReceiver {
  id: string
  name: string
  amount: number
  kind: 'owner' | 'inactive' | 'other'
}

/**
 * Collect every receiver who has expected cash > 0 today and is NOT rendered
 * in the active employee handover cards (e.g., Owner-received cash, or staff
 * deactivated earlier today). Read-only surface — never fed into
 * summarizeHandoverTotals().
 */
export function collectOtherReceivers(
  expected: ReadonlyMap<string, number>,
  employeeIds: ReadonlySet<string>,
  profiles: readonly { id: string; name: string; role: string; active: boolean }[],
): OtherReceiver[] {
  const byId = new Map(profiles.map((p) => [p.id, p]))
  const out: OtherReceiver[] = []
  for (const [id, amount] of expected.entries()) {
    if (amount <= 0 || employeeIds.has(id)) continue
    const p = byId.get(id)
    const kind: OtherReceiver['kind'] = !p
      ? 'other'
      : !p.active
        ? 'inactive'
        : p.role === 'owner'
          ? 'owner'
          : 'other'
    out.push({
      id,
      name: p?.name ?? '—',
      amount,
      kind,
    })
  }
  return out.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name))
}
