// Card-face tiers by lifetime sales, shared by the Collections wallet
// stack, the Agents-page stack and the agent's own face on My Page and
// Agent Home. Colours match the owner's reference card photos (gold /
// white-silver / black); text colours flip per tier so names stay
// readable. No chip graphic — the owner asked to leave it out.
//
// Tier rule (owner, 2026-11-16): a pure function of the agent's OWN
// lifetime sales (sum of daily_entries.amount) — fixed thresholds, not
// a ranking against other agents:
//   sales >= 20,000,000 MMK  → gold
//   sales >= 10,000,000 MMK  → white
//   otherwise (incl. zero)   → black
// Closed/settled agents are always black; that override lives at the
// render sites, which know the agent's closed state. This mirrors the
// my_card_tier() RPC (migration 0040), so the owner's pages and the
// agent's own pages always agree on a tier.
export type FaceTier = 'gold' | 'white' | 'black'
export const FACE_TIERS: Record<
  FaceTier,
  { bg: string; text: string; sub: string; faint: string; neg: string; extra: string }
> = {
  gold: {
    bg: 'linear-gradient(135deg, #F9E784 0%, #E3C565 35%, #C9A227 70%, #9A7B1C 100%)',
    text: 'text-stone-900',
    sub: 'text-stone-800/75',
    faint: 'text-stone-800/60',
    neg: 'text-emerald-800',
    extra: '',
  },
  white: {
    bg: 'linear-gradient(135deg, #FFFFFF 0%, #F5F5F4 55%, #D6D3D1 100%)',
    text: 'text-stone-900',
    sub: 'text-stone-600',
    faint: 'text-stone-500',
    neg: 'text-emerald-700',
    extra: 'border border-stone-300',
  },
  black: {
    bg: 'linear-gradient(135deg, #3F3F46 0%, #18181B 60%, #09090B 100%)',
    text: 'text-white',
    sub: 'text-white/70',
    faint: 'text-white/60',
    neg: 'text-emerald-300',
    extra: '',
  },
}

/** Lifetime-sales thresholds for the face tiers (MMK). */
export const GOLD_TIER_MIN_SALES = 20_000_000
export const WHITE_TIER_MIN_SALES = 10_000_000

/**
 * The face tier for one agent from their own lifetime sales alone.
 * Zero or negative sales is black (below the white threshold anyway).
 */
export function cardTierForSales(sales: number): FaceTier {
  if (sales >= GOLD_TIER_MIN_SALES) return 'gold'
  if (sales >= WHITE_TIER_MIN_SALES) return 'white'
  return 'black'
}
