import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { applyStoredTheme, applyTheme, getStoredTheme, type ThemeChoice } from '../lib/theme'
import { setLang as setAppLang } from '../lib/i18n'
import {
  Card,
  CardTitle,
  Field,
  LoadingState,
  PageHeader,
  PrimaryButton,
  inputCls,
} from '../components/ui'

// Settings page: factory info (owner), per-user notification prefs,
// phone-push status, per-device theme and language. Factory values live
// in app_settings (jsonb `value`: plain strings / numbers, matching how
// backup.ts and HomePage read them); prefs live in notify_prefs (own-row
// RLS, migration 0011); theme/language are per-device localStorage.

interface AppSettingRow {
  key: string
  value: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function asNumber(v: unknown): string {
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return v
  return ''
}

/** One labelled on/off row in the notification prefs card. */
function ToggleRow({
  label,
  sub,
  checked,
  onToggle,
}: {
  label: string
  sub: string
  checked: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3">
      <span className="text-sm">
        {label}
        <span className="block text-xs text-stone-500 dark:text-neutral-400">{sub}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onToggle}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-brand-700' : 'bg-stone-300 dark:bg-neutral-700'
        }`}
      >
        <span
          className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all ${
            checked ? 'left-[1.375rem]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  )
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
  const [debtAlertDays, setDebtAlertDays] = useState('')
  const [refreshSeconds, setRefreshSeconds] = useState('')
  const [factoryBusy, setFactoryBusy] = useState(false)
  const [factoryMsg, setFactoryMsg] = useState<string | null>(null)
  const [factoryErr, setFactoryErr] = useState(false)

  // ---- Notification prefs (all roles) ----
  const [mode, setMode] = useState<'all' | 'important'>('all')
  const [quietNight, setQuietNight] = useState(true)
  const [alertOldDebt, setAlertOldDebt] = useState(true)
  const [alertDigest, setAlertDigest] = useState(true)
  const [alertStock, setAlertStock] = useState(true)
  const [alertCollection, setAlertCollection] = useState(true)
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
          .select(
            'mode, quiet_night, alert_old_debt, alert_digest, alert_stock, alert_collection',
          )
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
      setDebtAlertDays(asNumber(map.get('debt_alert_days')) || '30')
      setRefreshSeconds(asNumber(map.get('refresh_seconds')) || '30')
      const p = prefs as {
        mode: string
        quiet_night: boolean
        alert_old_debt: boolean | null
        alert_digest: boolean | null
        alert_stock: boolean | null
        alert_collection: boolean | null
      } | null
      if (p) {
        setMode(p.mode === 'important' ? 'important' : 'all')
        setQuietNight(Boolean(p.quiet_night))
        // Alert columns default true (schema default); null keeps the default.
        setAlertOldDebt(p.alert_old_debt ?? true)
        setAlertDigest(p.alert_digest ?? true)
        setAlertStock(p.alert_stock ?? true)
        setAlertCollection(p.alert_collection ?? true)
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
      { key: 'debt_alert_days', value: Math.floor(Number(debtAlertDays)) || 30 },
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
    const { error } = await supabase.from('notify_prefs').upsert(
      {
        user_id: profile.id,
        mode,
        quiet_night: quietNight,
        alert_old_debt: alertOldDebt,
        alert_digest: alertDigest,
        alert_stock: alertStock,
        alert_collection: alertCollection,
      },
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
    // The i18n engine stores the preference and applies/removes the
    // English DOM translation immediately.
    setAppLang(next === 'en' ? 'en' : 'my')
  }

  if (loading) return <LoadingState />

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="ဆက်တင်များ"
        subtitle="စက်ရုံ အချက်အလက်၊ အသိပေးချက်နှင့် အသွင်အပြင် ဆက်တင်များ"
      />

      {isOwner && (
        <Card className="space-y-3">
          <CardTitle>စက်ရုံ အချက်အလက်</CardTitle>
          <Field label="စက်ရုံ အမည်">
            <input
              value={factoryName}
              onChange={(e) => setFactoryName(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="ဖုန်းနံပါတ်">
            <input
              value={factoryPhone}
              onChange={(e) => setFactoryPhone(e.target.value)}
              inputMode="tel"
              className={inputCls}
            />
          </Field>
          <Field label="လိပ်စာ">
            <input
              value={factoryAddress}
              onChange={(e) => setFactoryAddress(e.target.value)}
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="ပုံမှန် ရေဈေး (၁ ဗူး, ကျပ်)">
              <input
                value={defaultPrice}
                onChange={(e) => setDefaultPrice(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="ပုံမှန် အပေါင် (၁ ဗူး, ကျပ်)">
              <input
                value={defaultDeposit}
                onChange={(e) => setDefaultDeposit(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
          </div>
          <Field label="ကြွေးသတိပေးရက် (ရက်)">
            <input
              value={debtAlertDays}
              onChange={(e) => setDebtAlertDays(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              className={inputCls}
            />
          </Field>
          <Field label="Dashboard အလိုအလျောက် ပြန်ဖွင့် (စက္ကန့်, အနည်းဆုံး ၅)">
            <input
              value={refreshSeconds}
              onChange={(e) => setRefreshSeconds(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              className={inputCls}
            />
          </Field>
          {factoryMsg && (
            <p className={`text-sm ${factoryErr ? 'text-red-600' : 'text-brand-700 dark:text-brand-400'}`}>
              {factoryMsg}
            </p>
          )}
          <PrimaryButton onClick={saveFactory} disabled={factoryBusy}>
            သိမ်းမည်
          </PrimaryButton>
        </Card>
      )}

      <Card className="space-y-3">
        <CardTitle>အသိပေးချက် ဆက်တင်</CardTitle>
        <Field label="အသိပေးမည့် ပုံစံ">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'all' | 'important')}
            className={inputCls}
          >
            <option value="all">အားလုံး</option>
            <option value="important">အရေးကြီးတာပဲ</option>
          </select>
        </Field>
        <ToggleRow
          label="ညဘက် အသံတိတ်"
          sub="၂၂:၀၀–၀၆:၀၀ အတွင်း ပုံမှန် အသိပေးချက်များ မပို့ပါ"
          checked={quietNight}
          onToggle={() => setQuietNight((q) => !q)}
        />
        <ToggleRow
          label="ကြွေးကြာနေသတိပေးချက်"
          sub="ကြွေးကြာနေသော ကိုယ်စားလှယ်များကို သတိပေးမည်"
          checked={alertOldDebt}
          onToggle={() => setAlertOldDebt((v) => !v)}
        />
        <ToggleRow
          label="နေ့စဉ်အနှစ်ချုပ် သတိပေးချက်"
          sub="နေ့စဉ်အနှစ်ချုပ်ကို အသိပေးမည်"
          checked={alertDigest}
          onToggle={() => setAlertDigest((v) => !v)}
        />
        <ToggleRow
          label="စတော့သတိပေးချက်"
          sub="စတော့နည်းလာလျှင် သတိပေးမည်"
          checked={alertStock}
          onToggle={() => setAlertStock((v) => !v)}
        />
        <ToggleRow
          label="ကြွေးကောက်ငွေသတိပေးချက်"
          sub="ကြွေးကောက်ငွေရရှိလျှင် သတိပေးမည်"
          checked={alertCollection}
          onToggle={() => setAlertCollection((v) => !v)}
        />
        {prefsMsg && (
          <p className={`text-sm ${prefsErr ? 'text-red-600' : 'text-brand-700 dark:text-brand-400'}`}>
            {prefsMsg}
          </p>
        )}
        <PrimaryButton onClick={savePrefs} disabled={prefsBusy}>
          သိမ်းမည်
        </PrimaryButton>
      </Card>

      <Card className="space-y-3">
        <CardTitle>ဖုန်း အသိပေးချက် (Push)</CardTitle>
        <p className="text-sm text-stone-600 dark:text-neutral-300">
          ဖုန်း push အသိပေးချက် မဖွင့်ရသေးပါ — စီမံသူ ဆက်တင် ကျန်ပါသေးတယ်။
          ဖွင့်ပြီးပါက ရေပို့/ငွေကောက် မှတ်တမ်းများ ဖုန်းပေါ် တန်း ရောက်ပါမယ်။
        </p>
        <p className="text-sm text-stone-600 dark:text-neutral-300">
          ဒီအကောင့်အတွက် မှတ်ပုံတင်ထားသော စက်:{' '}
          {tokenCount == null ? '…' : `${tokenCount} လုံး`}
        </p>
      </Card>

      <Card className="space-y-3">
        <CardTitle>အသွင်အပြင်</CardTitle>
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
              className={`min-h-[44px] flex-1 rounded-xl px-3 py-2 text-sm transition active:scale-[0.98] ${
                theme === o.value
                  ? 'bg-brand-700 font-semibold text-white shadow-sm'
                  : 'bg-stone-100 dark:bg-neutral-800'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-stone-500 dark:text-neutral-400">ဒီစက်မှာသာ သက်ရောက်ပါတယ်</p>
      </Card>

      <Card className="space-y-3">
        <CardTitle>ဘာသာစကား</CardTitle>
        <div className="flex gap-2">
          {[
            { value: 'my', label: 'မြန်မာ' },
            { value: 'en', label: 'English' },
          ].map((o) => (
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
        {lang === 'en' && (
          <p className="text-sm text-stone-600 dark:text-neutral-300">
            English mode is on — interface labels are shown in English. Names
            and notes you entered stay as written.
          </p>
        )}
      </Card>
    </div>
  )
}
