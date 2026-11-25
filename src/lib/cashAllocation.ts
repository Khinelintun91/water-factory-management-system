// Cash allocation for the delivery-entry form (owner-approved redesign,
// 2026-11-20). The form takes ONE cash figure — the total the agent handed
// over on this visit — and the app, not the staff member, splits it:
//
//   1. toToday — pays this entry's own delivery charge first,
//   2. toOld   — then the agent's pre-existing debt (ကြွေးဟောင်း),
//   3. advance — whatever is left is overpayment (ပိုပေးငွေ).
//
// Storage mirrors the split: toToday lands on the entry itself
// (daily_entries.amount_collected); toOld and advance become linked
// agent_payments rows (kind 'old_debt' / 'regular', source_entry_id set,
// migration 0047) so every existing total — which sums entries plus ALL
// payments — stays exact. The split only LABELS parts of the cash: the
// agent's resulting balance is always outstandingBefore + entryAmount −
// cash, whatever the split.

export interface CashAllocation {
  /** Cash applied to this entry's own charge; stored on the entry. */
  toToday: number
  /** Cash applied to pre-existing debt; stored as an 'old_debt' payment. */
  toOld: number
  /** Cash beyond both; stored as a 'regular' payment (overpayment). */
  advance: number
  /** Agent balance after this save: > 0 still owed, < 0 overpaid. */
  resultingBalance: number
}

export function allocateCash(
  cash: number,
  entryAmount: number,
  outstandingBefore: number,
): CashAllocation {
  const c = Math.max(0, cash)
  const toToday = Math.min(c, Math.max(0, entryAmount))
  const toOld = Math.min(c - toToday, Math.max(outstandingBefore, 0))
  const advance = c - toToday - toOld
  return {
    toToday,
    toOld,
    advance,
    resultingBalance: outstandingBefore + entryAmount - c,
  }
}

export interface StandalonePaymentSplit {
  /** Part covering pre-existing debt; stored as an 'old_debt' payment. */
  debtPart: number
  /** The remainder; stored as a 'regular' payment (advance/overpayment). */
  restPart: number
  /** Agent balance after this save: > 0 still owed, < 0 overpaid. */
  resultingBalance: number
}

/**
 * Split for the Payments page's standalone collection (no delivery in
 * the same visit, so there is no "today" part): the staff member types
 * ONE amount and the app labels it — debt first, the rest is a regular
 * payment. Mirrors allocateCash's debt → overpayment order; as there,
 * the split only LABELS parts of the cash: the resulting balance is
 * always outstandingBefore − amount, whatever the split.
 */
export function splitStandalonePayment(
  amount: number,
  outstandingBefore: number,
): StandalonePaymentSplit {
  const a = Math.max(0, amount)
  const debtPart = Math.min(a, Math.max(outstandingBefore, 0))
  return {
    debtPart,
    restPart: a - debtPart,
    resultingBalance: outstandingBefore - a,
  }
}

/**
 * The base an EDIT allocates against: the agent's outstanding as if the
 * entry being edited and the payments it spawned did not exist.
 * outstandingNow already contains the entry's net contribution
 * +(oldEntryAmount − oldCollected) and its spawned payments' −sum, so
 * both are stripped back out; allocateCash(newCash, newEntryAmount, base)
 * then yields the correct new split and resulting balance.
 */
export function editBaseOutstanding(
  outstandingNow: number,
  oldEntryAmount: number,
  oldCollected: number,
  oldLinkedPaymentsSum: number,
): number {
  return outstandingNow - (oldEntryAmount - oldCollected) + oldLinkedPaymentsSum
}

/**
 * Auto-fill value for the new delivery-entry form's cash input.
 *
 * While the staff member has not manually edited the cash field
 * (`touched === false`), the field follows THIS visit's delivery charge
 * (`delivered_qty × unit_price`) — never including old debt — and stays
 * empty when the charge is 0. Once manually edited (`touched === true`),
 * the current cash string is preserved across later quantity or price
 * changes until auto-fill is reset (different agent selected, post-save
 * form reset, or remount).
 */
export function syncAutoCash(
  currentCash: string,
  deliveryCharge: number,
  touched: boolean,
): string {
  if (touched) return currentCash
  return deliveryCharge > 0 ? String(deliveryCharge) : ''
}
