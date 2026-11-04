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
