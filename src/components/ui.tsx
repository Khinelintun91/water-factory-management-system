import type { ButtonHTMLAttributes, ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Shared UI kit. Ledger-ink surfaces: solid cool paper, ink-navy actions,
// rust for attention. Gold is not a chrome colour (wallet faces own it).
// >=44px touch targets, labels above inputs, tabular figures. No blur.
//
// Class-string exports (cardCls, inputCls, btn*Cls) exist for elements that
// cannot be the components themselves (Link, <li>, table wrappers, ...).
// ---------------------------------------------------------------------------

/** Card surface: rounded-2xl, subtle border + soft shadow. No padding —
 *  compose with p-4 / lg:p-5 (or use <Card>). */
export const cardCls =
  'rounded-xl border border-stone-200 bg-white shadow-card dark:border-neutral-800 dark:bg-neutral-900'

export function Card({
  tone = 'default',
  className = '',
  children,
}: {
  tone?: 'default' | 'amber'
  className?: string
  children: ReactNode
}) {
  const toneCls =
    tone === 'amber'
      ? 'border-accent-300 bg-accent-50 dark:border-accent-800 dark:bg-accent-950'
      : 'border-stone-200 bg-white dark:border-neutral-800 dark:bg-neutral-900'
  return (
    <section className={`rounded-xl border p-4 shadow-card lg:p-5 ${toneCls} ${className}`}>
      {children}
    </section>
  )
}

/** Card heading row: semibold title + optional right-side action. */
export function CardTitle({
  children,
  action,
  className = '',
}: {
  children: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 ${className}`}>
      <h2 className="text-base font-semibold">{children}</h2>
      {action}
    </div>
  )
}

/** Page heading: bold title + one-line purpose subtitle, so a first-time
 *  user knows what the page is for at a glance. Optional right action. */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="border-l-4 border-brand-700 pl-3 text-xl font-bold tracking-tight lg:text-2xl dark:border-brand-300">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 text-sm text-stone-500 dark:text-neutral-400">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  )
}

/** Big-figure summary tile. `value` is a ReactNode so animated counters and
 *  unit suffixes compose. Tones: brand = teal highlight, danger = red
 *  (e.g. outstanding debt), amber = attention. */
export function StatCard({
  label,
  value,
  sub,
  tone = 'default',
  className = '',
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'default' | 'brand' | 'danger' | 'amber'
  className?: string
}) {
  const valueTone =
    tone === 'brand'
      ? 'text-brand-700 dark:text-brand-300'
      : tone === 'danger'
        ? 'text-red-600 dark:text-red-400'
        : tone === 'amber'
          ? 'text-accent-700 dark:text-accent-300'
          : ''
  const shellTone = tone === 'brand' ? 'border-brand-200 bg-brand-50 dark:border-brand-800 dark:bg-brand-950' : ''
  return (
    <div className={`${cardCls} p-3.5 lg:p-4 ${shellTone} ${className}`}>
      <div className="text-xs font-medium text-stone-500 dark:text-neutral-400">{label}</div>
      <div className={`mt-1 text-lg font-bold tabular-nums lg:text-xl ${valueTone}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-stone-500 dark:text-neutral-400">{sub}</div>}
    </div>
  )
}

// --- Buttons ---------------------------------------------------------------

const btnBase =
  'inline-flex items-center justify-center gap-2 font-semibold transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50'
const btnSize = {
  md: 'min-h-[44px] rounded-lg px-4 py-2.5 text-base',
  sm: 'min-h-[44px] rounded-lg px-3 py-2 text-sm',
} as const

export const btnPrimaryCls = `${btnBase} ${btnSize.md} bg-brand-700 text-white hover:bg-brand-800`
export const btnSecondaryCls = `${btnBase} ${btnSize.md} border border-stone-300 bg-white text-stone-800 hover:bg-stone-50 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800`
export const btnDangerCls = `${btnBase} ${btnSize.md} bg-red-700 text-white hover:bg-red-800`

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { size?: 'md' | 'sm' }

export function PrimaryButton({ size = 'md', className = '', type = 'button', ...props }: BtnProps) {
  return (
    <button
      type={type}
      className={`${btnBase} ${btnSize[size]} bg-brand-700 text-white hover:bg-brand-800 ${className}`}
      {...props}
    />
  )
}

export function SecondaryButton({ size = 'md', className = '', type = 'button', ...props }: BtnProps) {
  return (
    <button
      type={type}
      className={`${btnBase} ${btnSize[size]} border border-stone-300 bg-white text-stone-800 hover:bg-stone-50 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800 ${className}`}
      {...props}
    />
  )
}

export function DangerButton({ size = 'md', className = '', type = 'button', ...props }: BtnProps) {
  return (
    <button
      type={type}
      className={`${btnBase} ${btnSize[size]} bg-red-700 text-white hover:bg-red-800 ${className}`}
      {...props}
    />
  )
}

// --- Forms -----------------------------------------------------------------

/** Standard text/select input: large (48px), 16px text (no iOS zoom),
 *  visible brand focus ring. */
export const inputCls =
  'min-h-[48px] w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-base text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-brand-700 focus:ring-2 focus:ring-brand-700/30 dark:border-neutral-600 dark:bg-neutral-950 dark:text-neutral-100'

export const labelCls = 'mb-1.5 block text-sm font-medium text-stone-700 dark:text-neutral-300'

/** Label-above-input wrapper (renders a real <label>). */
export function Field({
  label,
  className = '',
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <label className={`block ${className}`}>
      <span className={labelCls}>{label}</span>
      {children}
    </label>
  )
}

// --- States ----------------------------------------------------------------

/** Dashed empty placeholder with guidance text and an optional action. */
export function EmptyState({
  text,
  hint,
  action,
}: {
  text: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 px-4 py-8 text-center dark:border-neutral-700">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        className="mx-auto h-8 w-8 text-stone-300 dark:text-neutral-600"
        aria-hidden="true"
      >
        <path d="M3.5 13.5 6 6.5h12l2.5 7V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z" />
        <path d="M3.5 13.5H9a3 3 0 0 0 6 0h5.5" />
      </svg>
      <p className="mt-2 font-medium">{text}</p>
      {hint && <p className="mt-1 text-sm text-stone-500 dark:text-neutral-400">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

/** Spinner + text loading placeholder. */
export function LoadingState({ text = 'ခဏစောင့်ပါ…' }: { text?: string }) {
  return (
    <div className="flex items-center gap-2.5 py-8 text-sm text-stone-500 dark:text-neutral-400" role="status">
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 animate-spin" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {text}
    </div>
  )
}

/** Inline alert strip (queue warnings, blocking notices). */
export function Banner({
  tone = 'amber',
  action,
  children,
}: {
  tone?: 'amber' | 'red' | 'brand'
  action?: ReactNode
  children: ReactNode
}) {
  const toneCls =
    tone === 'red'
      ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200'
      : tone === 'brand'
        ? 'border-brand-200 bg-brand-50 text-brand-900 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-100'
        : 'border-accent-300 bg-accent-50 text-accent-800 dark:border-accent-800 dark:bg-accent-950 dark:text-accent-100'
  return (
    <div className={`flex items-center justify-between gap-3 rounded-xl border p-3.5 text-sm font-medium ${toneCls}`}>
      <span>{children}</span>
      {action}
    </div>
  )
}
