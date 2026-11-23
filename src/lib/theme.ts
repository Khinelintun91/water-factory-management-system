// Per-device theme (light / dark / system), stored in localStorage and
// applied via the .dark class on <html> — index.css maps Tailwind's dark:
// variant to that class. App.tsx should call applyStoredTheme() once on
// boot so the stored choice applies before any page renders.

export type ThemeChoice = 'light' | 'dark' | 'system'

const THEME_KEY = 'wfms-theme'

export function getStoredTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* storage unavailable */
  }
  return 'system'
}

const media = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

/** Whether a stored choice currently renders dark, given the OS
 *  preference (only consulted for the 'system' choice). */
export function resolvedDark(choice: ThemeChoice, systemDark: boolean): boolean {
  return choice === 'dark' || (choice === 'system' && systemDark)
}

/** The explicit choice a 2-way light/dark toggle (header button) picks:
 *  the opposite of what is currently shown. A stored 'system' therefore
 *  becomes the explicit opposite of the currently resolved appearance. */
export function nextToggleChoice(choice: ThemeChoice, systemDark: boolean): ThemeChoice {
  return resolvedDark(choice, systemDark) ? 'light' : 'dark'
}

let onSystemChange: (() => void) | null = null

function render(choice: ThemeChoice) {
  const m = media()
  const dark = resolvedDark(choice, m?.matches ?? false)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

/** Store + apply a theme choice; 'system' keeps following the OS live. */
export function applyTheme(choice: ThemeChoice) {
  try {
    localStorage.setItem(THEME_KEY, choice)
  } catch {
    /* storage unavailable */
  }
  const m = media()
  if (onSystemChange && m) {
    m.removeEventListener('change', onSystemChange)
    onSystemChange = null
  }
  render(choice)
  if (choice === 'system' && m) {
    onSystemChange = () => render('system')
    m.addEventListener('change', onSystemChange)
  }
}

/** Apply whatever is stored (default 'system'). Call once on app boot. */
export function applyStoredTheme() {
  applyTheme(getStoredTheme())
}
