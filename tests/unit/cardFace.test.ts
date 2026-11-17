import { describe, expect, it } from 'vitest'
import {
  cardTierForSales,
  GOLD_TIER_MIN_SALES,
  WHITE_TIER_MIN_SALES,
} from '../../src/lib/cardFace'

// Owner's rule (2026-11-16): the wallet-face tier is a pure function of
// the agent's OWN lifetime sales — fixed thresholds, no ranking. This
// mirrors my_card_tier() in migration 0040; the SQL suite covers the
// database side of the same boundaries.
describe('cardTierForSales', () => {
  it('is black below the white threshold, including zero and negative', () => {
    expect(cardTierForSales(0)).toBe('black')
    expect(cardTierForSales(-1)).toBe('black')
    expect(cardTierForSales(200_000)).toBe('black')
    expect(cardTierForSales(WHITE_TIER_MIN_SALES - 1)).toBe('black')
  })

  it('is white from 10,000,000 up to just below 20,000,000', () => {
    expect(cardTierForSales(WHITE_TIER_MIN_SALES)).toBe('white')
    expect(cardTierForSales(15_000_000)).toBe('white')
    expect(cardTierForSales(GOLD_TIER_MIN_SALES - 1)).toBe('white')
  })

  it('is gold from 20,000,000 upwards', () => {
    expect(cardTierForSales(GOLD_TIER_MIN_SALES)).toBe('gold')
    expect(cardTierForSales(50_000_000)).toBe('gold')
  })

  it('threshold constants are the owner amounts (သိန်း 100 / သိန်း 200)', () => {
    expect(WHITE_TIER_MIN_SALES).toBe(10_000_000)
    expect(GOLD_TIER_MIN_SALES).toBe(20_000_000)
  })
})
