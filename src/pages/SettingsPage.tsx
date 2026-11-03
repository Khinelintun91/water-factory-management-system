import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { applyStoredTheme, applyTheme, getStoredTheme, type ThemeChoice } from '../lib/theme'

// Settings page: factory info (owner), per-user notification prefs,
// phone-push status, per-device theme and language. Factory values live
// in app_settings (jsonb `value`: plain strings / numbers, matching how
// backup.ts and HomePage read them); prefs live in notify_prefs (own-row
// RLS, migration 0011); theme/language are per-device localStorage.

interface AppSettingRow {
  key: string
  value: unknown
}

const inputCls = 'w-full rounded-xl border px-3 py-2 dark:bg-neutral-900'
const cardCls = 'space-y-3 rounded-2xl border p-4'
const saveBtnCls =
  'rounded-xl bg-teal-700 px-4 py-2 font-semibold text-white disabled:opacity-50'

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function asNumber(v: unknown): string {
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return v
  return ''
}

export default function SettingsPage() {
  const { profile, roles } = useAuth()
  const isOwner = roles.includes('owner')

  // ---- Factory settings (owner) ----
  const [loading, setLoading] = useState(true)
  const [factoryName, setFactoryName] = useState('')
  const [factoryPhone, setFactoryPhone] = useState('')
  const [factoryAddress, setFactoryAddress] = useState('')
  const [defaultPrice, setDefaultPrice] = useState('')
  const [defaultDeposit, setDefaultDeposit] = useState('')
  const [refreshSeconds, setRefreshSeconds] = useState('')
  const [factoryBusy, setFactoryBusy] = useState(false)
  const [factoryMsg, setFactoryMsg] = useState<string | null>(null)
  const [factoryErr, setFactoryErr] = useState(false)

  // ---- Notification prefs (all roles) ----
  const [mode, setMode] = useState<'all' | 'important'>('all')
  const [quietNight, setQuietNight] = useState(true)
  const [prefsBusy, setPrefsBusy] = useState(false)
  const [prefsMsg, setPrefsMsg] = useState<string | null>(null)
  const [prefsErr, setPrefsErr] = useState(false)

  // ---- Push status ----
  const [tokenCount, setTokenCount] = useState<number | null>(null)

  // ---- Appearance / language (per device) ----
  const [theme, setTheme] = useState<ThemeChoice>(() => getStoredTheme())
  const [lang, setLang] = useState<string>(() => {
    try {
      return localStorage.getItem('wfms-lang') === 'en' ? 'en' : 'my'
    } catch {
      return 'my'
    }
  })

  // Apply the stored theme when the page opens too (App boot also does
  // this centrally once wired).
  useEffect(() => {
    applyStoredTheme()
  }, [])

  useEffect(() => {
    if (!profile) return
    let cancelled = false
    ;(async () => {
      const [{ data: settings }, { data: prefs }, { count }] = await Promise.all([
        supabase.from('app_settings').select('key, value'),
        supabase
          .from('notify_prefs')
          .select('mode, quiet_night')
          .eq('user_id', profile.id)
          .maybeSingle(),
        supabase
          .from('push_tokens')
          .select('id', { count: 'exact', head: true })
          .eq('profile_id', profile.id),
      ])
      if (cancelled) return
      const map = new Map(
        ((settings ?? []) as AppSettingRow[]).map((r) => [r.key, r.value]),
      )
      setFactoryName(asString(map.get('factory_name')))
      setFactoryPhone(asString(map.get('factory_phone')))
      setFactoryAddress(asString(map.get('factory_address')))
      setDefaultPrice(asNumber(map.get('default_price_per_bottle')))
      setDefaultDeposit(asNumber(map.get('default_deposit_per_bottle')))
      setRefreshSeconds(asNumber(map.get('refresh_seconds')) || '30')
      const p = prefs as { mode: string; quiet_night: boolean } | null
      if (p) {
        setMode(p.mode === 'important' ? 'important' : 'all')
        setQuietNight(Boolean(p.quiet_night))
      }
      setTokenCount(count ?? 0)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [profile])

  async function saveFactory() {
    if (factoryBusy) return
    const secs = Number(refreshSeconds)
    if (!Number.isFinite(secs) || secs < 5) {
      setFactoryErr(true)
      setFactoryMsg('အလိုအလျောက် ပြန်ဖွင့် စက္ကန့် — အနည်းဆုံး ၅ ထည့်ပါ')
      return
    }
    setFactoryBusy(true)
    setFactoryMsg(null)
    const rows = [
      { key: 'factory_name', value: factoryName.trim() },
      { key: 'factory_phone', value: factoryPhone.trim() },
      { key: 'factory_address', value: factoryAddress.trim() },
      { key: 'default_price_per_bottle', value: Number(defaultPrice) || 0 },
      { key: 'default_deposit_per_bottle', value: Number(defaultDeposit) || 0 },
      { key: 'refresh_seconds', value: Math.floor(secs) },
    ]
    const { error } = await supabase
      .from('app_settings')
      .upsert(rows, { onConflict: 'key' })
    setFactoryBusy(false)
    setFactoryErr(Boolean(error))
    setFactoryMsg(error ? error.message : 'သိမ်းပြီးပါပြီ')
  }

  async function savePrefs() {
    if (!profile || prefsBusy) return
    setPrefsBusy(true)
    setPrefsMsg(null)
    const { error } = await supabase
      .from('notify_prefs')
      .upsert(
        { user_id: profile.id, mode, quiet_night: quietNight },
        { onConflict: 'user_id' },
      )
    setPrefsBusy(false)
    setPrefsErr(Boolean(error))
    setPrefsMsg(error ? error.message : 'သိမ်းပြီးပါပြီ')
  }

  function chooseTheme(choice: ThemeChoice) {
    setTheme(choice)
    applyTheme(choice)
  }

  function chooseLang(next: string) {
    setLang(next)
    try {
      localStorage.setItem('wfms-lang', next)
    } catch {
      /* storage unavailable */
    }
  }

  if (loading) return <p>ခဏစောင့်ပါ…</p>

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">ဆက်တင်များ</h1>

      {isOwner && (
        <section className={cardCls}>
          <h2 className="font-semibold">စက်ရုံ အချက်အလက်</h2>
          <label className="block text-sm">
            စက်ရုံ အမည်
            <input
              value={factoryName}
              onChange={(e) => setFactoryName(e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-sm">
            ဖုန်းနံပါတ်
            <input
              value={factoryPhone}
              onChange={(e) => setFactoryPhone(e.target.value)}
              inputMode="tel"
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <label className="block text-sm">
            လိပ်စာ
            <input
              value={factoryAddress}
              onChange={(e) => setFactoryAddress(e.target.value)}
              className={`mt-1 ${inputCls}`}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              ပုံမှန် ရေဈေး (၁ လုံး, ကျပ်)
              <input
                value={defaultPrice}
                onChange={(e) => setDefaultPrice(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={`mt-1 ${inputCls}`}
              />
            </label>
            <label className="text-sm">
              ပုံမှန် အပေါင် (၁ လုံး, ကျပ်)
              <input
                value={defaultDeposit}
                onChange={(e) => setDefaultDeposit(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={`mt-1 ${inputCls}`}
              />
            </label>
          </div>
          <label className="block text-sm">
            Dashboard အလိုအလျောက် ပြန်ဖွင့် (စက္ကန့်, အနည်းဆုံး ၅)
            <input
              value={refreshSeconds}
              onChange={(e) => setRefreshSeconds(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              className={`mt-1 ${inputCls}`}
            />
          </label>
          {factoryMsg && (
            <p className={`text-sm ${factoryErr ? 'text-red-600' : 'text-teal-700 dark:text-teal-400'}`}>
              {factoryMsg}
            </p>
          )}
          <button onClick={saveFactory} disabled={factoryBusy} className={saveBtnCls}>
            သိမ်းမည်
          </button>
        </section>
      )}

      <section className={cardCls}>
        <h2 className="font-semibold">အသိပေးချက် ဆက်တင်</h2>
        <label className="block text-sm">
          အသိပေးမည့် ပုံစံ
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'all' | 'important')}
            className={`mt-1 ${inputCls}`}
          >
            <option value="all">အားလုံး</option>
            <option value="important">အရေးကြီးတာပဲ</option>
          </select>
        </label>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">
            ညဘက် အသံတိတ်
            <span className="block text-xs opacity-60">၂၂:၀၀–၀၆:၀၀ အတွင်း ပုံမှန် အသိပေးချက်များ မပို့ပါ</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={quietNight}
            aria-label="ညဘက် အသံတိတ်"
            onClick={() => setQuietNight((q) => !q)}
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
              quietNight ? 'bg-teal-700' : 'bg-neutral-300 dark:bg-neutral-700'
            }`}
          >
            <span
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all ${
                quietNight ? 'left-[1.375rem]' : 'left-0.5'
              }`}
            />
          </button>
        </div>
        {prefsMsg && (
          <p className={`text-sm ${prefsErr ? 'text-red-600' : 'text-teal-700 dark:text-teal-400'}`}>
            {prefsMsg}
          </p>
        )}
        <button onClick={savePrefs} disabled={prefsBusy} className={saveBtnCls}>
          သိမ်းမည်
        </button>
      </section>

      <section className={cardCls}>
        <h2 className="font-semibold">ဖုန်း အသိပေးချက် (Push)</h2>
        <p className="text-sm opacity-80">
          ဖုန်း push အသိပေးချက် မဖွင့်ရသေးပါ — စီမံသူ ဆက်တင် ကျန်ပါသေးတယ်။
          ဖွင့်ပြီးပါက ရေပို့/ငွေကောက် မှတ်တမ်းများ ဖုန်းပေါ် တန်း ရောက်ပါမယ်။
        </p>
        <p className="text-sm opacity-80">
          ဒီအကောင့်အတွက် မှတ်ပုံတင်ထားသော စက်:{' '}
          {tokenCount == null ? '…' : `${tokenCount} လုံး`}
        </p>
      </section>

      <section className={cardCls}>
        <h2 className="font-semibold">အသွင်အပြင်</h2>
        <div className="flex gap-2">
          {(
            [
              { value: 'light', label: 'အလင်း' },
              { value: 'dark', label: 'အမှောင်' },
              { value: 'system', label: 'စက် အတိုင်း' },
            ] as { value: ThemeChoice; label: string }[]
          ).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => chooseTheme(o.value)}
              className={`flex-1 rounded-xl px-3 py-2 text-sm ${
                theme === o.value
                  ? 'bg-teal-700 font-semibold text-white'
                  : 'bg-neutral-100 dark:bg-neutral-800'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-xs opacity-60">ဒီစက်မှာသာ သက်ရောက်ပါတယ်</p>
      </section>

      <section className={cardCls}>
        <h2 className="font-semibold">ဘာသာစကား</h2>
        <div className="flex gap-2">
          {[
            { value: 'my', label: 'မြန်မာ' },
            { value: 'en', label: 'English' },
          ].map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => chooseLang(o.value)}
              className={`flex-1 rounded-xl px-3 py-2 text-sm ${
                lang === o.value
                  ? 'bg-teal-700 font-semibold text-white'
                  : 'bg-neutral-100 dark:bg-neutral-800'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        {lang === 'en' && (
          <p className="text-sm opacity-80">
            English ကို ရွေးရင် နောက်အဆင့်မှာ ဘာသာပြန် စနစ် ဖွင့်ပေးပါမယ်
            (ဆက်တင် သိမ်းထားပါပြီ)။
          </p>
        )}
      </section>
    </div>
  )
}
