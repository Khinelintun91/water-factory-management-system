import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'

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
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-6">
      <h1 className="text-center text-2xl font-bold">{factoryName}</h1>
      <p className="mt-1 text-center text-sm opacity-70">စီမံခန့်ခွဲမှု စနစ်သို့ ဝင်ရောက်ပါ</p>

      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">အသုံးပြုသူ အမည်</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            className="w-full rounded-xl border px-3 py-2.5 dark:bg-neutral-900"
            placeholder="ဥပမာ - owner"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">PIN</label>
          <div className="relative">
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
              type={showPin ? 'text' : 'password'}
              inputMode="numeric"
              autoComplete="current-password"
              required
              className="w-full rounded-xl border px-3 py-2.5 pr-14 dark:bg-neutral-900"
              placeholder="••••••"
            />
            <button
              type="button"
              onClick={() => setShowPin((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-sm opacity-70"
            >
              {showPin ? 'ဖျောက်' : 'ပြ'}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-teal-700 py-3 font-semibold text-white active:scale-[0.99] disabled:opacity-60"
        >
          {busy ? 'ဝင်နေပါတယ်…' : 'ဝင်ရောက်ရန်'}
        </button>
        <p className="text-center text-xs opacity-60">
          ဝင်ရောက်ထားမှုကို ဒီစက်မှာ မှတ်ထားပေးပါတယ်။
        </p>
      </form>
    </div>
  )
}
