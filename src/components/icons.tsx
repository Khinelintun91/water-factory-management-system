import type { ReactNode } from 'react'

// Lightweight stroke icons (24x24, currentColor) for navigation and shell
// chrome. There is no icon library in this project, so these are drawn by
// hand in one consistent style: 1.8 stroke, round caps/joins, no fill.

function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Brand mark: a water drop. */
export function DropIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M12 3c3.4 4.1 5.8 7.4 5.8 10.4a5.8 5.8 0 1 1-11.6 0C6.2 10.4 8.6 7.1 12 3z" />
      <path d="M9.3 13.6a2.9 2.9 0 0 0 2 3.2" />
    </Svg>
  )
}

const PATHS: Record<string, ReactNode> = {
  '/': (
    <>
      <path d="M3.5 10.8 12 3.5l8.5 7.3" />
      <path d="M5.5 9.3V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.3" />
      <path d="M9.8 21v-5.5h4.4V21" />
    </>
  ),
  '/entries': (
    <>
      <path d="M2.5 7h11v9h-11z" />
      <path d="M13.5 10h3.8l3.2 3.2V16h-7" />
      <circle cx="6.8" cy="18" r="1.7" />
      <circle cx="16.8" cy="18" r="1.7" />
      <path d="M8.5 18h6.6M20.5 18h1M2.5 18h3.1" />
    </>
  ),
  '/payments': (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M5.8 9.2h.01M18.2 14.8h.01" />
    </>
  ),
  '/agents': (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
      <path d="M15.8 5.3a3.2 3.2 0 0 1 0 5.7" />
      <path d="M17.6 15.3c1.6.7 2.6 2.1 2.9 4.7" />
    </>
  ),
  '/collections': (
    <>
      <path d="M5.5 3.5h13V20a.5.5 0 0 1-.5.5H5.5z" />
      <path d="M9 3.5V20.5" />
      <path d="M12.5 8h3.5M12.5 12h3.5" />
    </>
  ),
  '/inventory': (
    <>
      <path d="M10.2 2.8h3.6" />
      <path d="M10.7 2.8v2.9L8.9 8.2V19a2.3 2.3 0 0 0 2.3 2.3h1.6A2.3 2.3 0 0 0 15.1 19V8.2L13.3 5.7V2.8" />
      <path d="M8.9 13.5h6.2" />
    </>
  ),
  '/expenses': (
    <>
      <path d="M6 3h12v17.2l-2-1.2-2 1.2-2-1.2-2 1.2-2-1.2-2 1.2z" />
      <path d="M9.2 8h5.6M9.2 12h5.6" />
    </>
  ),
  '/payroll': (
    <>
      <path d="M5.5 5.5A1.5 1.5 0 0 1 7 4h12.5v3" />
      <rect x="3" y="6.5" width="18" height="12" rx="2.5" />
      <circle cx="16.8" cy="12.5" r="1.3" />
    </>
  ),
  '/reports': (
    <>
      <path d="M4 4v15.5h16" />
      <path d="M8.2 16v-4.5M12.2 16V8.5M16.2 16v-2.8" />
    </>
  ),
  '/handover': (
    <>
      <path d="M4 7.8h12.5L13 4.3" />
      <path d="M20 16.2H7.5l3.5 3.5" />
    </>
  ),
  '/data-quality': (
    <>
      <path d="M12 3l7 2.5V11c0 4.6-2.9 7.9-7 9.5C7.9 18.9 5 15.6 5 11V5.5z" />
      <path d="M9.2 11.6l2 2 3.6-3.8" />
    </>
  ),
  '/history': (
    <>
      <circle cx="12" cy="12" r="8.3" />
      <path d="M12 7.6V12l3 2" />
    </>
  ),
  '/disputes': (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.6 3.8v-3.8H5.5A1.5 1.5 0 0 1 4 14.5z" />
      <path d="M12 8v3.6" />
      <path d="M12 14.4h.01" />
    </>
  ),
  '/users': (
    <>
      <circle cx="10" cy="8" r="3.2" />
      <path d="M4 20c.7-3.4 3-5.2 6-5.2 1.5 0 2.9.5 3.9 1.4" />
      <path d="M18.6 8.2v5.6M15.8 11h5.6" />
    </>
  ),
  '/my': (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20.5c.8-3.8 3.6-6 7-6s6.2 2.2 7 6" />
    </>
  ),
  '/settings': (
    <>
      <path d="M4.5 7h8M18.5 7h1.5M4.5 12h2.5M13 12h6.5M4.5 17h10.5" />
      <circle cx="15.5" cy="7" r="2.1" />
      <circle cx="10" cy="12" r="2.1" />
      <circle cx="18" cy="17" r="2.1" />
    </>
  ),
}

/** "More" icon for the phone tab bar (3x3 dots). */
export function MoreIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="5" cy="5" r="1.7" />
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="19" cy="5" r="1.7" />
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
      <circle cx="5" cy="19" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
      <circle cx="19" cy="19" r="1.7" />
    </svg>
  )
}

/** Icon for a nav route path; falls back to the "more" dots. */
export function NavIcon({ to, className }: { to: string; className?: string }) {
  const body = PATHS[to]
  if (!body) return <MoreIcon className={className} />
  return <Svg className={className}>{body}</Svg>
}
