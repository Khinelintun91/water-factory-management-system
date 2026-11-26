import type { EntryInsert } from './offlineQueue'

/**
 * New delivery-entry form modes:
 * - 'delivery': normal water delivery (with optional returned empties and cash).
 * - 'bottle_only': empty-bottle-only collection trip (delivered_qty = 0,
 *   returned_qty > 0, amount = 0, amount_collected = 0, no payments spawned).
 */
export type EntryMode = 'delivery' | 'bottle_only'

/** True when a daily_entries row is a bottle-only collection (0 delivered). */
export function isBottleOnlyEntry(row: { delivered_qty: number }): boolean {
  return row.delivered_qty === 0
}

export interface NewEntryValidationInput {
  mode: EntryMode
  agentId: string
  deliveredQty: number
  returnedQty: number
}

/**
 * Client-side pre-submit validation for the new-entry form.
 * Returns a Burmese error string, or null when valid.
 * The database enforces the same invariant in entries_before_write().
 */
export function validateNewEntry(input: NewEntryValidationInput): string | null {
  if (!input.agentId) return 'ကိုယ်စားလှယ် ရွေးပါ'
  if (input.mode === 'bottle_only') {
    if (input.returnedQty <= 0) return 'ပြန်အပ်သည့် ဗူး အရေအတွက် ထည့်ပါ'
    return null
  }
  if (input.deliveredQty <= 0) return 'ပို့သည့် ဗူး အရေအတွက် ထည့်ပါ'
  return null
}

export interface EditEntryValidationInput {
  isBottleOnly: boolean
  deliveredQty: number
  returnedQty: number
  reason: string
}

/**
 * Client-side pre-submit validation for same-day editing of an existing entry.
 * Entry type is fixed at creation (delivery vs bottle-only); mirrors edit_daily_entry().
 */
export function validateEditEntry(input: EditEntryValidationInput): string | null {
  if (input.reason.trim().length < 2) {
    return 'ပြင်ရသည့် အကြောင်းအရင်း (အနည်းဆုံး ၂ လုံး) ရေးပါ'
  }
  if (input.isBottleOnly) {
    if (input.returnedQty <= 0) return 'ပြန်အပ်သည့် ဗူး အရေအတွက် ထည့်ပါ'
    return null
  }
  if (input.deliveredQty <= 0) return 'ပို့သည့် ဗူး အရေအတွက် ထည့်ပါ'
  return null
}

/**
 * True when a bottle-only return exceeds the agent's current held bottles.
 * Used to surface a non-blocking warning (saving is still allowed).
 */
export function isOverReturn(
  returnedQty: number,
  heldBottles: number | null,
): boolean {
  return heldBottles !== null && returnedQty > 0 && returnedQty > heldBottles
}

/**
 * Build the daily_entries insert payload shared by the online save path and
 * the offline queue. In bottle-only mode delivered_qty and amount_collected
 * are always forced to 0.
 */
export function buildEntryPayload(input: {
  mode: EntryMode
  entryDate: string
  agentId: string
  deliveredQty: number
  returnedQty: number
  cashAmount: number
  notes: string
  createdBy: string | null
  receivedBy: string | null
}): EntryInsert {
  const isBottleOnly = input.mode === 'bottle_only'
  return {
    entry_date: input.entryDate,
    agent_id: input.agentId,
    delivered_qty: isBottleOnly ? 0 : input.deliveredQty,
    returned_qty: input.returnedQty,
    amount_collected: isBottleOnly ? 0 : input.cashAmount,
    notes: input.notes.trim() || null,
    created_by: input.createdBy,
    received_by: input.receivedBy,
  }
}
