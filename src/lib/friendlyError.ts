import { formatMMK } from './types'
import { isNetworkError } from './offlineQueue'

/**
 * Translate a raw database / PostgREST error into a Burmese message a staff
 * member can act on. DB functions raise coded English errors (raised in the
 * migrations as `raise exception 'code: detail'`); those strings used to be
 * shown to users verbatim. This is the single place that maps them.
 *
 * Rules:
 *  - Known codes map to fixed Burmese text; numbers embedded in the raw
 *    message (deposit shortfall, locked month, PIN minimum) are parsed out
 *    and reused.
 *  - Codes whose detail is already Burmese in the DB (already_closed,
 *    already_paid, …) surface just that Burmese detail.
 *  - A message that already contains Myanmar script and matches no known
 *    code is shown as-is — it is already in the user's language.
 *  - Anything else is logged to the console for diagnosis and replaced with
 *    a generic Burmese retry message. Raw English never reaches the screen.
 */

export const NO_PERMISSION = 'ဒီ လုပ်ဆောင်ချက်ကို လုပ်ခွင့် မရှိပါ'
export const NOT_FOUND = 'ရှာမတွေ့ပါ — မှတ်တမ်း မရှိပါ'
export const NETWORK_ERROR =
  'အင်တာနက် ချိတ်ဆက်မှု ပြဿနာ ဖြစ်နေပါတယ် — ခဏနေ ထပ်မံ ကြိုးစားပါ'
export const GENERIC_ERROR =
  'သိမ်းဆည်းရာတွင် ပြဿနာ တစ်ခု ဖြစ်ပွားခဲ့ပါတယ် — ထပ်မံ ကြိုးစားကြည့်ပါ'

const MYANMAR = /[\u1000-\u109F]/

/** Codes whose DB detail (after `code: `) is already Burmese — show the detail. */
const BURMESE_BODY_CODES = [
  'already_closed',
  'already_paid',
  'not_settled',
  'receivable_open',
  'bad_price',
  'bad_returned',
] as const

function rawMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  const m = (err as { message?: unknown } | null | undefined)?.message
  return typeof m === 'string' ? m : String(err ?? '')
}

function errorCode(err: unknown): string | null {
  const c = (err as { code?: unknown } | null | undefined)?.code
  return typeof c === 'string' ? c : null
}

export function friendlyError(err: unknown): string {
  const msg = rawMessage(err)

  // Connectivity first — a TypeError / fetch failure carries no rule code.
  if (isNetworkError(err) || isNetworkError(msg)) return NETWORK_ERROR

  // Deposit shortfall: 'deposit_limit: exceeds deposit bottles by 5 — top-up
  // 100000 MMK needed' — reuse both numbers.
  const dep = msg.match(
    /deposit_limit:\s*exceeds deposit bottles by\s+([\d,]+)\s*—\s*top-up\s+([\d,]+)\s*MMK needed/i,
  )
  if (dep) {
    const bottles = dep[1]
    const topUp = Number(dep[2].replace(/,/g, ''))
    return `အပေါင် ဗူး မလောက်ပါ — နောက်ထပ် ${bottles} ဗူး အတွက် ${formatMMK(topUp)} ထပ်တင်ရန် လိုပါတယ်`
  }
  if (msg.includes('deposit_limit'))
    return 'အပေါင် ဗူး မလောက်ပါ — အပေါင် ထပ်တင်ရန် လိုပါတယ်'

  // Locked month: 'month_locked: 2026-10 is locked' — reuse the month.
  const lock = msg.match(/month_locked:\s*(\S+)\s+is locked/i)
  if (lock) return `${lock[1]} လ ပိတ်ထားပြီးသားပါ — စာရင်း သွင်း/ပြင်/ဖျက် လို့ မရပါ`
  if (msg.includes('month_locked'))
    return 'ဒီလ ပိတ်ထားပြီးသားပါ — စာရင်း သွင်း/ပြင်/ဖျက် လို့ မရပါ'

  if (msg.includes('credit_limit'))
    return 'ဒီ ကိုယ်စားလှယ်ရဲ့ ကြွေးကန့်သတ်ချက် ကျော်သွားပါမယ် — ဒီစာရင်း သွင်းလို့ မရပါ'

  if (msg.includes('same_day_only'))
    return 'ဒီနေ့ ဖန်တီးတဲ့ စာရင်းကိုပဲ ဒီနေ့ ပြင်/ဖျက် လို့ ရပါတယ်'

  if (msg.includes('agent_closed')) return 'ဒီ ကိုယ်စားလှယ်က စာရင်း ပိတ်ပြီးသား ဖြစ်ပါတယ်'

  // Legacy bottle cap (superseded by the deposit rule in migration 0039,
  // but older function versions may still raise it).
  if (msg.includes('bottle_limit')) return 'ဗူး ကန့်သတ်ချက် ကျော်သွားပါတယ်'

  // Codes whose detail is already Burmese — surface just the detail.
  for (const code of BURMESE_BODY_CODES) {
    const at = msg.indexOf(`${code}:`)
    if (at >= 0) {
      const body = msg.slice(at + code.length + 1).trim()
      if (MYANMAR.test(body)) return body
    }
  }

  // Admin user RPC codes (admin_create_user / admin_reset_pin).
  if (msg.includes('username_taken')) return 'ဒီ username ကို တခြားသူ သုံးပြီးသား ဖြစ်ပါတယ်'
  if (msg.includes('invalid_username')) return 'username ပုံစံ မမှန်ပါ'
  if (msg.includes('invalid_role')) return 'ရာထူး ရွေးချယ်မှု မမှန်ပါ'
  const pin = msg.match(/pin_must_be_(\d+)_to_12_digits/)
  if (pin) return `PIN က ${pin[1]} လုံးကနေ 12 လုံး အတွင်း ဖြစ်ရပါမယ်`

  if (msg.includes('agent_not_found') || msg.includes('user_not_found')) return NOT_FOUND

  // Permission family: explicit owner/role guards, RPC 'not allowed'
  // rejections, and PostgREST row-level-security violations.
  if (
    msg.includes('pin_change_owner_only') ||
    msg.includes('forbidden') ||
    msg.includes('owner_only') ||
    msg.includes('owner_manager_only') ||
    msg.includes('data_quality_scan') ||
    msg.includes('not allowed') ||
    msg.includes('row-level security policy')
  )
    return NO_PERMISSION

  // Uniqueness: message text or the Postgres SQLSTATE on the error object.
  if (
    errorCode(err) === '23505' ||
    msg.includes('duplicate key value') ||
    /unique constraint/i.test(msg)
  )
    return 'ရှိပြီးသား မှတ်တမ်း ဖြစ်နေပါတယ်'

  // Already in the user's language (e.g. a Burmese raise without a known
  // code) — safe to show as-is.
  if (MYANMAR.test(msg)) return msg.trim()

  console.error('[friendlyError] unmapped error:', err)
  return GENERIC_ERROR
}
