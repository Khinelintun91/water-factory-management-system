import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { DropIcon } from '../components/icons'
import { Banner, Card, Field, PrimaryButton, inputCls } from '../components/ui'

export default function LoginPage({ factoryName }: { factoryName: string }) {
  const { signIn } = useAuth()
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
        <h1 className="mt-4 text-2xl font-bold tracking-tight">{factoryName}</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-neutral-400">
          စီမံခန့်ခွဲမှု စနစ်သို့ ဝင်ရောက်ပါ
        </p>
      </div>

      <Card className="mt-8">
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
