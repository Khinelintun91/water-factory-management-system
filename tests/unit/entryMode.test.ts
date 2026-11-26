import { describe, expect, it } from 'vitest'
import {
  buildEntryPayload,
  isBottleOnlyEntry,
  isOverReturn,
  validateEditEntry,
  validateNewEntry,
} from '../../src/lib/entryMode'
import { toEnglish } from '../../src/lib/i18n'

describe('isBottleOnlyEntry', () => {
  it('identifies delivered_qty === 0 as bottle-only and > 0 as delivery', () => {
    expect(isBottleOnlyEntry({ delivered_qty: 0 })).toBe(true)
    expect(isBottleOnlyEntry({ delivered_qty: 1 })).toBe(false)
    expect(isBottleOnlyEntry({ delivered_qty: 50 })).toBe(false)
  })
})

describe('validateNewEntry', () => {
  it('requires an agent in both modes', () => {
    expect(
      validateNewEntry({ mode: 'delivery', agentId: '', deliveredQty: 10, returnedQty: 0 }),
    ).toBe('ကိုယ်စားလှယ် ရွေးပါ')
    expect(
      validateNewEntry({ mode: 'bottle_only', agentId: '', deliveredQty: 0, returnedQty: 50 }),
    ).toBe('ကိုယ်စားလှယ် ရွေးပါ')
  })

  it('delivery mode requires positive delivered quantity', () => {
    expect(
      validateNewEntry({ mode: 'delivery', agentId: 'a1', deliveredQty: 0, returnedQty: 50 }),
    ).toBe('ပို့သည့် ဗူး အရေအတွက် ထည့်ပါ')
    expect(
      validateNewEntry({ mode: 'delivery', agentId: 'a1', deliveredQty: 10, returnedQty: 0 }),
    ).toBeNull()
  })

  it('bottle-only mode requires positive returned quantity even when delivered is 0', () => {
    expect(
      validateNewEntry({ mode: 'bottle_only', agentId: 'a1', deliveredQty: 0, returnedQty: 0 }),
    ).toBe('ပြန်အပ်သည့် ဗူး အရေအတွက် ထည့်ပါ')
    expect(
      validateNewEntry({ mode: 'bottle_only', agentId: 'a1', deliveredQty: 0, returnedQty: 100 }),
    ).toBeNull()
  })
})

describe('validateEditEntry', () => {
  it('requires a 2+ character change reason in both entry types', () => {
    expect(
      validateEditEntry({ isBottleOnly: false, deliveredQty: 10, returnedQty: 0, reason: 'a' }),
    ).toBe('ပြင်ရသည့် အကြောင်းအရင်း (အနည်းဆုံး ၂ လုံး) ရေးပါ')
    expect(
      validateEditEntry({ isBottleOnly: true, deliveredQty: 0, returnedQty: 10, reason: ' ' }),
    ).toBe('ပြင်ရသည့် အကြောင်းအရင်း (အနည်းဆုံး ၂ လုံး) ရေးပါ')
  })

  it('bottle-only edit requires positive returned quantity; delivery edit requires positive delivered', () => {
    expect(
      validateEditEntry({ isBottleOnly: true, deliveredQty: 0, returnedQty: 0, reason: 'fix' }),
    ).toBe('ပြန်အပ်သည့် ဗူး အရေအတွက် ထည့်ပါ')
    expect(
      validateEditEntry({ isBottleOnly: true, deliveredQty: 0, returnedQty: 80, reason: 'fix' }),
    ).toBeNull()
    expect(
      validateEditEntry({ isBottleOnly: false, deliveredQty: 0, returnedQty: 80, reason: 'fix' }),
    ).toBe('ပို့သည့် ဗူး အရေအတွက် ထည့်ပါ')
    expect(
      validateEditEntry({ isBottleOnly: false, deliveredQty: 20, returnedQty: 0, reason: 'fix' }),
    ).toBeNull()
  })
})

describe('isOverReturn', () => {
  it('warns only when held is known and returned exceeds held', () => {
    expect(isOverReturn(100, null)).toBe(false)
    expect(isOverReturn(0, 50)).toBe(false)
    expect(isOverReturn(50, 50)).toBe(false)
    expect(isOverReturn(51, 50)).toBe(true)
    expect(isOverReturn(10, 0)).toBe(true)
    expect(isOverReturn(1, -5)).toBe(true)
  })
})

describe('buildEntryPayload', () => {
  it('forces delivered_qty = 0 and amount_collected = 0 in bottle-only mode', () => {
    expect(
      buildEntryPayload({
        mode: 'bottle_only',
        entryDate: '2026-11-25',
        agentId: 'a1',
        deliveredQty: 99,
        returnedQty: 100,
        cashAmount: 50000,
        notes: '  empty pickup  ',
        createdBy: 'u1',
        receivedBy: 'u2',
      }),
    ).toEqual({
      entry_date: '2026-11-25',
      agent_id: 'a1',
      delivered_qty: 0,
      returned_qty: 100,
      amount_collected: 0,
      notes: 'empty pickup',
      created_by: 'u1',
      received_by: 'u2',
    })
  })

  it('preserves delivered_qty and full cash in delivery mode', () => {
    expect(
      buildEntryPayload({
        mode: 'delivery',
        entryDate: '2026-11-25',
        agentId: 'a1',
        deliveredQty: 20,
        returnedQty: 10,
        cashAmount: 20000,
        notes: '   ',
        createdBy: 'u1',
        receivedBy: 'u1',
      }),
    ).toEqual({
      entry_date: '2026-11-25',
      agent_id: 'a1',
      delivered_qty: 20,
      returned_qty: 10,
      amount_collected: 20000,
      notes: null,
      created_by: 'u1',
      received_by: 'u1',
    })
  })
})

describe('bottle-only UI strings translate cleanly to English', () => {
  const MYANMAR = /[\u1000-\u109F]/
  const strings = [
    'ရေပို့ + ဗူးခွံယူ',
    'ဗူးခွံသီးသန့် ပြန်ယူ',
    'ပြန်အပ်သည့် ဗူး အရေအတွက် ထည့်ပါ',
    'လက်ရှိ ကိုင်ထားဗူး: 40 ဗူး',
    'သတိ: လက်ရှိ ကိုင်ထားဗူး (40 ဗူး) ထက် ပိုနေပါတယ် — ဆက်သိမ်းနိုင်ပါတယ်',
    'ပြန်အပ် 100 ဗူး',
    'ဗူးခွံပြန်ယူ မှတ်တမ်း',
    'ဗူးခွံပြန်အပ် မှတ်တမ်း',
    'ပို့သည့် ဗူး သို့မဟုတ် ပြန်အပ်သည့် ဗူး အရေအတွက် ထည့်ပါ',
    'ဗူးခွံသီးသန့် ပြန်ယူ မှတ်တမ်းတွင် ငွေပမာဏ ထည့်၍ မရပါ',
    'ရေပို့ မှတ်တမ်းနှင့် ဗူးခွံသီးသန့် မှတ်တမ်း အမျိုးအစား ပြောင်းလဲ၍ မရပါ — ဖျက်ပြီး အသစ်ထည့်ပါ',
  ]
  for (const s of strings) {
    it(`translates "${s}" with no leftover Myanmar script`, () => {
      const en = toEnglish(s)
      expect(MYANMAR.test(en)).toBe(false)
    })
  }
})
