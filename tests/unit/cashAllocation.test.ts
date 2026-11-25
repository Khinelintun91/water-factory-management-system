import { describe, expect, it } from 'vitest'
import {
  allocateCash,
  editBaseOutstanding,
  splitStandalonePayment,
  syncAutoCash,
} from '../../src/lib/cashAllocation'

// The entry form takes ONE cash figure; allocateCash labels its parts
// (today → old debt → overpayment). The split never moves the balance:
// resultingBalance is always outstandingBefore + entryAmount − cash.
describe('allocateCash', () => {
  it('cash = 0: nothing is applied, the full amount becomes debt', () => {
    expect(allocateCash(0, 20000, 200000)).toEqual({
      toToday: 0,
      toOld: 0,
      advance: 0,
      resultingBalance: 220000,
    })
  })

  it('cash < today: everything goes to today, old debt untouched', () => {
    expect(allocateCash(10000, 20000, 200000)).toEqual({
      toToday: 10000,
      toOld: 0,
      advance: 0,
      resultingBalance: 210000,
    })
  })

  it('cash = today exactly: today settled, old debt untouched', () => {
    expect(allocateCash(20000, 20000, 200000)).toEqual({
      toToday: 20000,
      toOld: 0,
      advance: 0,
      resultingBalance: 200000,
    })
  })

  it('today < cash < today + old: the rest chips into old debt', () => {
    expect(allocateCash(100000, 20000, 200000)).toEqual({
      toToday: 20000,
      toOld: 80000,
      advance: 0,
      resultingBalance: 120000,
    })
  })

  it('cash = today + old: everything settled, balance exactly zero', () => {
    expect(allocateCash(220000, 20000, 200000)).toEqual({
      toToday: 20000,
      toOld: 200000,
      advance: 0,
      resultingBalance: 0,
    })
  })

  it('cash > today + old (the UAM case): the excess is overpayment', () => {
    // U Aye Myint, 2026-11-20: old debt 200,000, 20 bottles × 1,000,
    // handed over 320,000 → 100,000 overpaid.
    expect(allocateCash(320000, 20000, 200000)).toEqual({
      toToday: 20000,
      toOld: 200000,
      advance: 100000,
      resultingBalance: -100000,
    })
  })

  it('no old debt + extra cash: the excess is overpayment', () => {
    expect(allocateCash(50000, 20000, 0)).toEqual({
      toToday: 20000,
      toOld: 0,
      advance: 30000,
      resultingBalance: -30000,
    })
  })

  it('prior credit (outstandingBefore < 0): no old-debt part, credit grows or shrinks exactly', () => {
    // Agent already 50,000 in credit; a 20,000 delivery with no cash
    // leaves 30,000 of credit.
    expect(allocateCash(0, 20000, -50000)).toEqual({
      toToday: 0,
      toOld: 0,
      advance: 0,
      resultingBalance: -30000,
    })
    // Paying the delivery in full restores the full prior credit.
    expect(allocateCash(20000, 20000, -50000)).toEqual({
      toToday: 20000,
      toOld: 0,
      advance: 0,
      resultingBalance: -50000,
    })
    // Paying beyond the delivery adds to the credit as overpayment.
    expect(allocateCash(35000, 20000, -50000)).toEqual({
      toToday: 20000,
      toOld: 0,
      advance: 15000,
      resultingBalance: -65000,
    })
  })
})

// The Payments form takes ONE amount for a standalone collection (no
// delivery in the same visit); splitStandalonePayment labels its parts
// (old debt → regular). The split never moves the balance:
// resultingBalance is always outstandingBefore − amount.
describe('splitStandalonePayment', () => {
  it('amount < debt: everything is old-debt collection, the rest stays owed', () => {
    expect(splitStandalonePayment(50000, 200000)).toEqual({
      debtPart: 50000,
      restPart: 0,
      resultingBalance: 150000,
    })
  })

  it('amount = debt exactly: all old debt, balance exactly zero', () => {
    expect(splitStandalonePayment(200000, 200000)).toEqual({
      debtPart: 200000,
      restPart: 0,
      resultingBalance: 0,
    })
  })

  it('amount > debt: debt part capped at the debt, the excess is regular', () => {
    expect(splitStandalonePayment(320000, 200000)).toEqual({
      debtPart: 200000,
      restPart: 120000,
      resultingBalance: -120000,
    })
  })

  it('no debt: the whole amount is a regular payment (pure overpayment)', () => {
    expect(splitStandalonePayment(100000, 0)).toEqual({
      debtPart: 0,
      restPart: 100000,
      resultingBalance: -100000,
    })
  })

  it('prior credit (outstandingBefore < 0): no debt part, credit grows by the amount', () => {
    expect(splitStandalonePayment(30000, -50000)).toEqual({
      debtPart: 0,
      restPart: 30000,
      resultingBalance: -80000,
    })
  })

  it('amount = 0: no parts, balance unchanged', () => {
    expect(splitStandalonePayment(0, 200000)).toEqual({
      debtPart: 0,
      restPart: 0,
      resultingBalance: 200000,
    })
    expect(splitStandalonePayment(0, 0)).toEqual({
      debtPart: 0,
      restPart: 0,
      resultingBalance: 0,
    })
  })
})

describe('editBaseOutstanding', () => {
  it('strips the entry and its spawned payments back out of the live balance', () => {
    // After the UAM save above the live balance is −100,000. The entry
    // contributed +(20,000 − 20,000) and its spawned payments −300,000,
    // so the base the edit must allocate against is the pre-entry debt.
    expect(editBaseOutstanding(-100000, 20000, 20000, 300000)).toBe(200000)
  })

  it('handles a partially paid entry with no spawned payments', () => {
    // Entry 20,000, collected 5,000, nothing spawned: live balance
    // 215,000 = base 200,000 + 15,000 unpaid part of this entry.
    expect(editBaseOutstanding(215000, 20000, 5000, 0)).toBe(200000)
  })

  it('reallocating the same cash over the base reproduces the live balance', () => {
    const base = editBaseOutstanding(-100000, 20000, 20000, 300000)
    expect(allocateCash(320000, 20000, base).resultingBalance).toBe(-100000)
  })
})

describe('syncAutoCash', () => {
  it('untouched: follows qty × price (delivery charge only)', () => {
    expect(syncAutoCash('', 100 * 1000, false)).toBe('100000')
    expect(syncAutoCash('100000', 50 * 1000, false)).toBe('50000')
  })

  it('touched: quantity or price change does not overwrite manual input', () => {
    // Staff typed 0 (agent not home), then fixes bottle count -> cash stays 0.
    expect(syncAutoCash('0', 80 * 1000, true)).toBe('0')
    // Staff typed a partial amount -> stays unchanged on qty edit.
    expect(syncAutoCash('25000', 80 * 1000, true)).toBe('25000')
    // Staff cleared the cash input -> stays empty on qty edit.
    expect(syncAutoCash('', 80 * 1000, true)).toBe('')
  })

  it('agent change / form reset (touched reset to false): auto-fill resumes', () => {
    // Switching from agent A (cash manually set to 0) to agent B (price 1,500)
    // resets touched=false so cash follows the new agent's qty × price.
    expect(syncAutoCash('0', 80 * 1500, false)).toBe('120000')
    // After a post-save reset (cash='', touched=false), next qty auto-fills.
    expect(syncAutoCash('', 30 * 1000, false)).toBe('30000')
  })

  it('charge 0 (or non-positive): shows empty string when untouched', () => {
    expect(syncAutoCash('', 0, false)).toBe('')
    expect(syncAutoCash('100000', 0, false)).toBe('')
    expect(syncAutoCash('100000', -1000, false)).toBe('')
  })
})
