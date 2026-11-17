import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  friendlyError,
  GENERIC_ERROR,
  NETWORK_ERROR,
  NO_PERMISSION,
  NOT_FOUND,
} from '../../src/lib/friendlyError'

// DB functions raise coded English errors (`raise exception 'code: detail'`
// in the migrations); PostgREST surfaces them as { message, code } objects.
// friendlyError is the only thing standing between those strings and staff
// who cannot read English, so every mapping is pinned here.
describe('friendlyError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('translates the deposit limit, reusing both numbers', () => {
    expect(
      friendlyError({
        message: 'deposit_limit: exceeds deposit bottles by 5 — top-up 100000 MMK needed',
      }),
    ).toBe('အပေါင် ဗူး မလောက်ပါ — နောက်ထပ် 5 ဗူး အတွက် 100,000 ကျပ် ထပ်တင်ရန် လိုပါတယ်')
    expect(
      friendlyError(
        new Error('deposit_limit: exceeds deposit bottles by 12 — top-up 240000 MMK needed'),
      ),
    ).toBe('အပေါင် ဗူး မလောက်ပါ — နောက်ထပ် 12 ဗူး အတွက် 240,000 ကျပ် ထပ်တင်ရန် လိုပါတယ်')
  })

  it('translates the credit limit', () => {
    expect(friendlyError({ message: 'credit_limit: agent debt would exceed the credit limit' })).toBe(
      'ဒီ ကိုယ်စားလှယ်ရဲ့ ကြွေးကန့်သတ်ချက် ကျော်သွားပါမယ် — ဒီစာရင်း သွင်းလို့ မရပါ',
    )
  })

  it('translates a locked month, reusing the month from the message', () => {
    expect(friendlyError({ message: 'month_locked: 2026-10 is locked' })).toBe(
      '2026-10 လ ပိတ်ထားပြီးသားပါ — စာရင်း သွင်း/ပြင်/ဖျက် လို့ မရပါ',
    )
  })

  it('translates both same_day_only variants', () => {
    expect(
      friendlyError({ message: 'same_day_only: records can only be edited or deleted on the day they were created' }),
    ).toBe('ဒီနေ့ ဖန်တီးတဲ့ စာရင်းကိုပဲ ဒီနေ့ ပြင်/ဖျက် လို့ ရပါတယ်')
    expect(friendlyError({ message: 'same_day_only: entry_date must be today (Asia/Yangon)' })).toBe(
      'ဒီနေ့ ဖန်တီးတဲ့ စာရင်းကိုပဲ ဒီနေ့ ပြင်/ဖျက် လို့ ရပါတယ်',
    )
  })

  it('translates agent_closed and the legacy bottle_limit', () => {
    expect(friendlyError({ message: 'agent_closed: this agent has been closed out' })).toBe(
      'ဒီ ကိုယ်စားလှယ်က စာရင်း ပိတ်ပြီးသား ဖြစ်ပါတယ်',
    )
    expect(friendlyError({ message: 'bottle_limit: exceeds the bottle limit by 3 bottles' })).toBe(
      'ဗူး ကန့်သတ်ချက် ကျော်သွားပါတယ်',
    )
  })

  it('translates the admin user RPC codes', () => {
    expect(friendlyError('username_taken')).toBe('ဒီ username ကို တခြားသူ သုံးပြီးသား ဖြစ်ပါတယ်')
    expect(friendlyError('invalid_username')).toBe('username ပုံစံ မမှန်ပါ')
    expect(friendlyError('invalid_role')).toBe('ရာထူး ရွေးချယ်မှု မမှန်ပါ')
    expect(friendlyError({ message: 'agent_not_found' })).toBe(NOT_FOUND)
    expect(friendlyError({ message: 'user_not_found' })).toBe(NOT_FOUND)
  })

  it('translates the PIN length code, reusing the minimum from the code', () => {
    expect(friendlyError({ message: 'pin_must_be_4_to_12_digits' })).toBe(
      'PIN က 4 လုံးကနေ 12 လုံး အတွင်း ဖြစ်ရပါမယ်',
    )
    expect(friendlyError({ message: 'pin_must_be_6_to_12_digits' })).toBe(
      'PIN က 6 လုံးကနေ 12 လုံး အတွင်း ဖြစ်ရပါမယ်',
    )
  })

  it('maps the whole permission family to the no-permission text', () => {
    const cases = [
      'pin_change_owner_only: only the owner can set a PIN, through admin_reset_pin',
      'forbidden',
      'forbidden: owner only',
      'forbidden: owner/manager only',
      'owner_only',
      'owner_manager_only',
      'agent_detail_stats: not allowed',
      'inventory_totals: not allowed',
      'data_quality_scan: owner/manager only',
      'new row violates row-level security policy for table "daily_entries"',
    ]
    for (const message of cases) {
      expect(friendlyError({ message }), message).toBe(NO_PERMISSION)
    }
  })

  it('surfaces just the Burmese body of already-Burmese codes', () => {
    expect(friendlyError({ message: 'already_closed: စာရင်းပိတ်ပြီးသားပါ' })).toBe('စာရင်းပိတ်ပြီးသားပါ')
    expect(friendlyError({ message: 'already_paid: ဒီလအတွက် ပေးပြီးသားပါ' })).toBe('ဒီလအတွက် ပေးပြီးသားပါ')
    expect(friendlyError({ message: 'not_settled: စာရင်းမပိတ်ရသေးပါ' })).toBe('စာရင်းမပိတ်ရသေးပါ')
    expect(friendlyError({ message: 'receivable_open: ရရန်ကျန်ငွေ မရှင်းရသေးပါ' })).toBe(
      'ရရန်ကျန်ငွေ မရှင်းရသေးပါ',
    )
    expect(friendlyError({ message: 'bad_price: ယနေ့ ပေါက်ဈေး ထည့်ပါ' })).toBe('ယနေ့ ပေါက်ဈေး ထည့်ပါ')
    expect(friendlyError({ message: 'bad_returned: ပြန်အပ်ဘူး အရေအတွက် မမှန်ပါ' })).toBe(
      'ပြန်အပ်ဘူး အရေအတွက် မမှန်ပါ',
    )
  })

  it('still finds a coded error behind a table prefix (backup/export throws)', () => {
    expect(friendlyError(new Error('daily_entries: month_locked: 2026-09 is locked'))).toBe(
      '2026-09 လ ပိတ်ထားပြီးသားပါ — စာရင်း သွင်း/ပြင်/ဖျက် လို့ မရပါ',
    )
  })

  it('translates uniqueness violations by message and by SQLSTATE', () => {
    expect(
      friendlyError({
        message: 'duplicate key value violates unique constraint "disputes_open_unique"',
      }),
    ).toBe('ရှိပြီးသား မှတ်တမ်း ဖြစ်နေပါတယ်')
    expect(friendlyError({ message: 'some pg wording', code: '23505' })).toBe(
      'ရှိပြီးသား မှတ်တမ်း ဖြစ်နေပါတယ်',
    )
  })

  it('translates network failures', () => {
    expect(friendlyError(new TypeError('Failed to fetch'))).toBe(NETWORK_ERROR)
    expect(friendlyError('Failed to fetch')).toBe(NETWORK_ERROR)
    expect(friendlyError({ message: 'NetworkError when attempting to fetch resource.' })).toBe(
      NETWORK_ERROR,
    )
  })

  it('passes through a message that is already Burmese', () => {
    expect(friendlyError({ message: 'တစ်ခုခု မှားနေပါတယ်' })).toBe('တစ်ခုခု မှားနေပါတယ်')
  })

  it('falls back to the generic message for unknown errors and logs the raw error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const raw = { message: 'canceling statement due to statement timeout', code: '57014' }
    expect(friendlyError(raw)).toBe(GENERIC_ERROR)
    expect(spy).toHaveBeenCalledWith('[friendlyError] unmapped error:', raw)
    expect(friendlyError(null)).toBe(GENERIC_ERROR)
    expect(friendlyError(undefined)).toBe(GENERIC_ERROR)
  })
})
