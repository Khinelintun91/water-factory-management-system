// Card-face tiers by sales, shared by the Collections wallet stack, the
// Agents-page stack and the agent's own face on My Page. Colours match the
// owner's reference card photos (gold / white-silver / black); text colours
// flip per tier so names stay readable. No chip graphic — the owner asked
// to leave it out. Faces use a frosted-glass treatment (owner's glass-card
// reference): translucent tier tint, soft light blobs and a diagonal sheen
// baked into the background layers, plus a thin pale border. The glass is
// done with gradients only — no backdrop-blur — so a full stack of faces
// still scrolls smoothly on low-end phones.
// the best-selling agents get a gold face, the middle group a white/silver
// face, the lowest a black face. (No chip graphic — the owner asked to
// leave it out.) Text colours flip per tier so names stay readable.
export type FaceTier = 'gold' | 'white' | 'black'
export const FACE_TIERS: Record<
  FaceTier,
  { bg: string; text: string; sub: string; faint: string; neg: string; extra: string }
> = {
  gold: {
    bg: 'radial-gradient(150px 100px at 88% -10%, rgba(255,255,255,0.55), rgba(255,255,255,0) 60%), radial-gradient(190px 130px at 6% 115%, rgba(255,255,255,0.35), rgba(255,255,255,0) 62%), linear-gradient(115deg, rgba(255,255,255,0.20), rgba(255,255,255,0) 42%), linear-gradient(135deg, rgba(249,231,132,0.94) 0%, rgba(227,197,101,0.92) 35%, rgba(201,162,39,0.92) 70%, rgba(154,123,28,0.94) 100%)',
    text: 'text-stone-900',
    sub: 'text-stone-800/75',
    faint: 'text-stone-800/60',
    neg: 'text-emerald-800',
    extra: 'border border-white/40',
  },
  white: {
    bg: 'radial-gradient(150px 100px at 88% -10%, rgba(255,255,255,0.9), rgba(255,255,255,0) 60%), radial-gradient(190px 130px at 6% 115%, rgba(168,162,158,0.35), rgba(168,162,158,0) 62%), linear-gradient(115deg, rgba(255,255,255,0.5), rgba(255,255,255,0) 42%), linear-gradient(135deg, rgba(255,255,255,0.96) 0%, rgba(245,245,244,0.94) 55%, rgba(214,211,209,0.94) 100%)',
    text: 'text-stone-900',
    sub: 'text-stone-600',
    faint: 'text-stone-500',
    neg: 'text-emerald-700',
    extra: 'border border-stone-300',
  },
  black: {
    bg: 'radial-gradient(150px 100px at 88% -10%, rgba(255,255,255,0.38), rgba(255,255,255,0) 60%), radial-gradient(190px 130px at 6% 115%, rgba(255,255,255,0.20), rgba(255,255,255,0) 62%), linear-gradient(115deg, rgba(255,255,255,0.16), rgba(255,255,255,0) 42%), linear-gradient(135deg, rgba(82,82,91,0.88) 0%, rgba(24,24,27,0.90) 60%, rgba(9,9,11,0.92) 100%)',
    text: 'text-white',
    sub: 'text-white/70',
    faint: 'text-white/60',
    neg: 'text-emerald-300',
    extra: 'border border-white/35',
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
