import { describe, expect, it } from 'vitest'
import {
  collectOtherReceivers,
  evaluateHandoverRow,
  initialReceivedInput,
  parseReceivedInput,
  summarizeHandoverTotals,
} from '../../src/lib/handoverCount'
import { toEnglish } from '../../src/lib/i18n'

describe('initialReceivedInput', () => {
  it('starts empty for unsaved handovers (blind count)', () => {
    expect(initialReceivedInput(null)).toBe('')
    expect(initialReceivedInput(undefined)).toBe('')
  })

  it('keeps saved received amount for existing handovers', () => {
    expect(initialReceivedInput(0)).toBe('0')
    expect(initialReceivedInput(320000)).toBe('320000')
  })
})

describe('parseReceivedInput', () => {
  it('returns null for blank or invalid strings rather than coercing blank to 0', () => {
    expect(parseReceivedInput('')).toBeNull()
    expect(parseReceivedInput('   ')).toBeNull()
    expect(parseReceivedInput('-100')).toBeNull()
    expect(parseReceivedInput('abc')).toBeNull()
  })

  it('parses valid non-negative numeric counts including explicit 0', () => {
    expect(parseReceivedInput('0')).toBe(0)
    expect(parseReceivedInput('320000')).toBe(320000)
  })
})

describe('evaluateHandoverRow', () => {
  it('keeps expected hidden while unsaved and blank', () => {
    expect(evaluateHandoverRow('', 500000, false)).toEqual({
      hasInput: false,
      revealed: false,
      received: null,
      diff: null,
      status: 'uncounted',
    })
  })

  it('reveals expected and over/short difference immediately once typed', () => {
    expect(evaluateHandoverRow('520000', 500000, false)).toEqual({
      hasInput: true,
      revealed: true,
      received: 520000,
      diff: 20000,
      status: 'over',
    })
    expect(evaluateHandoverRow('480000', 500000, false)).toEqual({
      hasInput: true,
      revealed: true,
      received: 480000,
      diff: -20000,
      status: 'short',
    })
    expect(evaluateHandoverRow('500000', 500000, false)).toEqual({
      hasInput: true,
      revealed: true,
      received: 500000,
      diff: 0,
      status: 'match',
    })
  })

  it('keeps saved rows revealed with their saved received amount', () => {
    expect(evaluateHandoverRow('300000', 300000, true)).toEqual({
      hasInput: true,
      revealed: true,
      received: 300000,
      diff: 0,
      status: 'match',
    })
  })
})

describe('summarizeHandoverTotals', () => {
  it('excludes uncounted rows so expected totals do not leak before blind count', () => {
    expect(
      summarizeHandoverTotals([
        { rawInput: '', expected: 500000, isSaved: false },
        { rawInput: '', expected: 200000, isSaved: false },
      ]),
    ).toEqual({ exp: 0, rec: 0, diff: 0, counted: 0, total: 2 })

    expect(
      summarizeHandoverTotals([
        { rawInput: '520000', expected: 500000, isSaved: false },
        { rawInput: '', expected: 200000, isSaved: false },
      ]),
    ).toEqual({ exp: 500000, rec: 520000, diff: 20000, counted: 1, total: 2 })
  })
})

describe('Package A UI strings translate cleanly to English', () => {
  const MYANMAR = /[\u1000-\u109F]/
  const strings = [
    'မစစ်ရသေး',
    'ရေတွက်ရငွေ ထည့်ပါ',
    'လိုနေပါတယ် 20,000 ကျပ်',
    'ပိုနေပါတယ် 20,000 ကျပ်',
    'မျှော်မှန်းငွေ: 500,000 ကျပ်',
    'လက်ခံသူအလိုက်',
    'သီးသန့်ငွေကောက်',
    'ငွေအပ်ကွာဟ',
    'ထပ်တူမှတ်တမ်း သံသယ',
    'ကိုင်ထားဗူး အနုတ်ဖြစ်နေသည်',
    'ပို့သည့်ဗူး အလွန်များနေသည်',
    'အခြား လက်ခံသူများ (ငွေအပ်စာရင်း မပါ)',
    'ပိုင်ရှင် တိုက်ရိုက်လက်ခံငွေ သို့မဟုတ် ယနေ့ ပိတ်ထားသော ဝန်ထမ်းများ၏ လက်ခံငွေ (ကြည့်ရန်သာ)',
    'မှတ်တမ်းတင်သူ',
    'ပိုင်ရှင်',
    'ပိတ်ထားသည်',
  ]
  for (const s of strings) {
    it(`translates "${s}" with no leftover Myanmar script`, () => {
      expect(MYANMAR.test(toEnglish(s))).toBe(false)
    })
  }
})

describe('collectOtherReceivers (Pack 2 M5 HandoverPage)', () => {
  const profiles = [
    { id: 'u-owner', name: 'Owner', role: 'owner', active: true },
    { id: 'u-staff1', name: 'Staff 1', role: 'staff', active: true },
    { id: 'u-staff-off', name: 'Staff Off', role: 'staff', active: false },
  ]

  it('collects Owner-received cash and deactivated-today staff outside active employee cards', () => {
    const expected = new Map([
      ['u-staff1', 500000],
      ['u-owner', 200000],
      ['u-staff-off', 350000],
    ])
    const employeeIds = new Set(['u-staff1'])
    expect(collectOtherReceivers(expected, employeeIds, profiles)).toEqual([
      { id: 'u-staff-off', name: 'Staff Off', amount: 350000, kind: 'inactive' },
      { id: 'u-owner', name: 'Owner', amount: 200000, kind: 'owner' },
    ])
  })

  it('ignores zero-expected holders and active employee card holders', () => {
    const expected = new Map([
      ['u-staff1', 500000],
      ['u-owner', 0],
    ])
    const employeeIds = new Set(['u-staff1'])
    expect(collectOtherReceivers(expected, employeeIds, profiles)).toEqual([])
  })

  it('falls back cleanly for an unknown holder id', () => {
    const expected = new Map([['u-ghost', 10000]])
    expect(collectOtherReceivers(expected, new Set(), profiles)).toEqual([
      { id: 'u-ghost', name: '—', amount: 10000, kind: 'other' },
    ])
  })
})
