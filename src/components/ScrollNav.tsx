import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'

// Floating jump-to-top / jump-to-bottom buttons for long pages. Mounted once
// in the app shell, so every authenticated page gets them. Each button only
// appears when there is somewhere to jump to: up after scrolling down a
// bit, down while the bottom is still far away; neither on short pages.
export default function ScrollNav() {
  const [showUp, setShowUp] = useState(false)
  const [showDown, setShowDown] = useState(false)
  const { pathname } = useLocation()

  const update = useCallback(() => {
    const el = document.documentElement
    const max = el.scrollHeight - window.innerHeight
    const y = window.scrollY
    setShowUp(y > 300)
    setShowDown(max - y > 300)
  }, [])

  useEffect(() => {
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [update])

  // Pages grow after their data loads; re-check shortly after navigation.
  useEffect(() => {
    const t1 = window.setTimeout(update, 250)
    const t2 = window.setTimeout(update, 1200)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [pathname, update])

  if (!showUp && !showDown) return null

  const btnCls =
    'flex h-11 w-11 items-center justify-center rounded-full border border-white/25 bg-brand-700/90 text-white shadow-lg backdrop-blur transition hover:bg-brand-700 active:scale-95 dark:bg-neutral-800/90 dark:hover:bg-neutral-800'

  return (
    <div className="fixed bottom-[calc(6rem_+_env(safe-area-inset-bottom))] right-3 z-30 flex flex-col gap-2 print:hidden md:bottom-6 md:right-6">
      {showUp && (
        <button
          type="button"
          className={btnCls}
          aria-label="အပေါ်ဆုံးသို့"
          title="အပေါ်ဆုံးသို့"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
            <path d="m5 14 7-7 7 7" />
          </svg>
        </button>
      )}
      {showDown && (
        <button
          type="button"
          className={btnCls}
          aria-label="အောက်ဆုံးသို့"
          title="အောက်ဆုံးသို့"
          onClick={() =>
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
          }
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
            <path d="m19 10-7 7-7-7" />
          </svg>
        </button>
      )}
    </div>
  )
}
