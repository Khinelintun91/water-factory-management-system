import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getLang, setLang as setAppLang, type Lang } from '../lib/i18n'
import { DropIcon } from '../components/icons'
import { Banner, Card, Field, PrimaryButton, inputCls } from '../components/ui'

export default function LoginPage({ factoryName }: { factoryName: string }) {
  const { signIn } = useAuth()
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The app_settings table is not readable before sign-in, so the card
  // title comes from the public_factory_name RPC (owner-set name, with a
  // server-side default). Until it resolves — or if it fails — the static
  // fallback name passed in by App is shown.
  const [rpcName, setRpcName] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    supabase.rpc('public_factory_name').then(({ data }) => {
      if (!cancelled && typeof data === 'string' && data.trim()) setRpcName(data)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const shownName = rpcName ?? factoryName

  // Language on the login card — same mechanism as SettingsPage: the
  // choice is stored by the i18n engine and applied immediately.
  const [lang, setLangState] = useState<Lang>(() => getLang())
  function chooseLang(next: Lang) {
    setLangState(next)
    setAppLang(next)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await signIn(username, pin)
    if (res.error) setError(res.error)
    setBusy(false)
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center p-6">
      <div className="flex flex-col items-center text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-brand-700 text-white shadow-pop">
          <DropIcon className="h-9 w-9" />
        </span>
        <h1 className="mt-4 text-2xl font-bold tracking-tight">{shownName}</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-neutral-400">
          စီမံခန့်ခွဲမှု စနစ်သို့ ဝင်ရောက်ပါ
        </p>
      </div>

      <Card className="mt-8">
        <div className="mb-4 flex gap-2" role="group" aria-label="ဘာသာစကား">
          {(
            [
              { value: 'my', label: 'မြန်မာ' },
              { value: 'en', label: 'English' },
            ] as { value: Lang; label: string }[]
          ).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => chooseLang(o.value)}
              className={`min-h-[44px] flex-1 rounded-xl px-3 py-2 text-sm transition active:scale-[0.98] ${
                lang === o.value
                  ? 'bg-brand-700 font-semibold text-white shadow-sm'
                  : 'bg-stone-100 dark:bg-neutral-800'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="အသုံးပြုသူ အမည်">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              className={inputCls}
              placeholder="ဥပမာ - owner"
            />
          </Field>
          <Field label="PIN">
            <div className="relative">
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
                type={showPin ? 'text' : 'password'}
                inputMode="numeric"
                autoComplete="current-password"
                required
                className={`${inputCls} pr-14`}
                placeholder="••••••"
              />
              <button
                type="button"
                onClick={() => setShowPin((s) => !s)}
                className="absolute right-2 top-1/2 flex min-h-[36px] -translate-y-1/2 items-center rounded-lg px-2.5 text-sm text-stone-500 dark:text-neutral-400"
              >
                {showPin ? 'ဖျောက်' : 'ပြ'}
              </button>
            </div>
          </Field>

          {error && <Banner tone="red">{error}</Banner>}

          <PrimaryButton type="submit" disabled={busy} className="w-full py-3">
            {busy ? 'ဝင်နေပါတယ်…' : 'ဝင်ရောက်ရန်'}
          </PrimaryButton>
          <p className="text-center text-xs text-stone-500 dark:text-neutral-400">
            ဝင်ရောက်ထားမှုကို ဒီစက်မှာ မှတ်ထားပေးပါတယ်။
          </p>
        </form>
      </Card>
    </div>
  )
}
