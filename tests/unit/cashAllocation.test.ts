import { describe, expect, it } from 'vitest'
import { allocateCash, editBaseOutstanding } from '../../src/lib/cashAllocation'

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
