// Card-face tiers by sales, shared by the Collections wallet stack, the
// Agents-page stack and the agent's own face on My Page. Colours match the
// owner's reference card photos (gold / white-silver / black); text colours
// flip per tier so names stay readable. No chip graphic — the owner asked
// to leave it out.
// the best-selling agents get a gold face, the middle group a white/silver
// face, the lowest a black face. (No chip graphic — the owner asked to
// leave it out.) Text colours flip per tier so names stay readable.
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

/**
 * Rank agents by lifetime sales and split into thirds — top gold, middle
 * white, bottom black; zero sales is always black. `rows` must be in
 * created_at order so sales ties break the same way everywhere; this
 * mirrors the my_card_tier() RPC (migration 0024), so the owner's pages
 * and the agent's own My Page always agree on a tier.
 */
export function salesTierMap(rows: { id: string; sales: number }[]): Map<string, FaceTier> {
  const ranked = [...rows].sort((x, y) => y.sales - x.sales)
  const n = ranked.length
  const m = new Map<string, FaceTier>()
  ranked.forEach((r, i) => {
    m.set(
      r.id,
      r.sales <= 0
        ? 'black'
        : i < Math.ceil(n / 3)
          ? 'gold'
          : i < Math.ceil((2 * n) / 3)
            ? 'white'
            : 'black',
    )
  })
  return m
}
