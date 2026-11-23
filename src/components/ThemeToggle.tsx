import { useEffect, useState } from 'react'
import { applyTheme, getStoredTheme, nextToggleChoice } from '../lib/theme'
import { MoonIcon, SunIcon } from './icons'

// Header light/dark toggle (owner-approved 2026-11-23). Sits between the
// notification bell and the sign-out button in the shared App header, so
// it shows on every signed-in page for every role.
//
// The icon pictures what a tap switches TO: moon while light is showing
// (tap → dark), sun while dark is showing (tap → light). The component
// tracks only the RESOLVED appearance — the `dark` class on <html> — via
// a MutationObserver, so it stays correct no matter who changed the
// theme: this button, the Settings page control, or the OS while the
// stored choice is 'system'. The tap itself re-reads the stored choice
// and applies the explicit opposite of the current appearance through
// the same applyTheme() the Settings page uses (lib/theme.ts), so the
// two controls can never disagree about persistence.
export default function ThemeToggle() {
  const [dark, setDark] = useState<boolean>(
    () =>
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('dark'),
  )

  useEffect(() => {
    const el = document.documentElement
    const update = () => setDark(el.classList.contains('dark'))
    update()
    const observer = new MutationObserver(update)
    observer.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  function toggle() {
    const systemDark =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    applyTheme(nextToggleChoice(getStoredTheme(), systemDark))
  }

  return (
    <button
      type="button"
      aria-label="အလင်း/အမှောင် ပြောင်းရန်"
      title="အလင်း/အမှောင် ပြောင်းရန်"
      onClick={toggle}
      className="relative rounded-full border p-2 leading-none active:scale-95"
    >
      {dark ? (
        <SunIcon className="h-5 w-5" />
      ) : (
        <MoonIcon className="h-5 w-5" />
      )}
    </button>
  )
}
