import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { personName, ROLE_LABELS, type Agent, type Profile, type Role } from '../lib/types'
import {
  Card,
  CardTitle,
  Field,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  cardCls,
  inputCls,
} from '../components/ui'

/**
 * Map an admin RPC error code (raised by admin_create_user / admin_reset_pin,
 * surfaced inside error.message) to a Burmese message. Null = unmapped code.
 */
function rpcCodeMessage(message: string): string | null {
  if (message.includes('username_taken')) return 'ဒီ username ဖြင့် အကောင့် ရှိပြီးသားပါ'
  if (message.includes('invalid_username'))
    return 'username သည် အင်္ဂလိပ် အသေး စာလုံး, ဂဏန်း, _ . - သာ ဖြစ်ရပါမယ် (၃–၃၂ လုံး)'
  if (message.includes('pin_must_be_4_to_12_digits')) return 'PIN သည် ဂဏန်း ၄–၁၂ လုံး ဖြစ်ရပါမယ်'
  if (message.includes('pin_must_be_6_to_12_digits'))
    return 'ပိုင်ရှင်/မန်နေဂျာ PIN သည် ဂဏန်း ၆–၁၂ လုံး ဖြစ်ရပါမယ်'
  if (message.includes('agent_id_required')) return 'ကိုယ်စားလှယ် အကောင့်အတွက် agent ရွေးပါ'
  return null
}

export default function UsersPage() {
  const { profile: me } = useAuth()
  const [rows, setRows] = useState<Profile[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [extras, setExtras] = useState<Record<string, Role[]>>({})
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [pin, setPin] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [agentId, setAgentId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: p }, { data: a }, { data: ur }] = await Promise.all([
      supabase.from('profiles').select('id, username, display_name, role, agent_id, active').order('created_at', { ascending: true }),
      supabase.from('agents').select('*').order('created_at', { ascending: true }),
      supabase.from('user_roles').select('profile_id, role'),
    ])
    setRows((p ?? []) as Profile[])
    setAgents((a ?? []) as Agent[])
    const map: Record<string, Role[]> = {}
    for (const r of (ur ?? []) as { profile_id: string; role: Role }[]) {
      ;(map[r.profile_id] ??= []).push(r.role)
    }
    setExtras(map)
    setLoading(false)
  }, [])

  async function grantRole(p: Profile, r: Role) {
    setMsg(null)
    const { error } = await supabase.from('user_roles').insert({ profile_id: p.id, role: r })
    if (error) setMsg(error.message)
    await load()
  }

  async function revokeRole(p: Profile, r: Role) {
    setMsg(null)
    const { error } = await supabase
      .from('user_roles')
      .delete()
      .eq('profile_id', p.id)
      .eq('role', r)
    if (error) setMsg(error.message)
    await load()
  }

  useEffect(() => {
    load()
  }, [load])

  function showMsg(m: string | null) {
    setMsg(m)
    if (m) setOkMsg(null)
  }

  function showOk(m: string) {
    setOkMsg(m)
    setMsg(null)
  }

  async function toggleActive(p: Profile) {
    setMsg(null)
    if (p.role === 'owner' && p.active) {
      setMsg('Owner အကောင့်ကို ပိတ်၍ မရပါ')
      return
    }
    if (p.active && !confirm(`${p.username} အကောင့်ကို ပိတ်မှာ သေချာပါသလား?`)) return
    const { error } = await supabase.from('profiles').update({ active: !p.active }).eq('id', p.id)
    if (error) setMsg(error.message)
    await load()
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    setOkMsg(null)
    if (role === 'agent' && !agentId) {
      setMsg('ကိုယ်စားလှယ် အကောင့်အတွက် agent ရွေးပါ')
      return
    }
    setBusy(true)
    const { error } = await supabase.rpc('admin_create_user', {
      p_username: username.trim(),
      p_pin: pin,
      p_role: role,
      p_agent_id: role === 'agent' ? agentId : null,
      p_display_name: displayName.trim() ? displayName.trim() : null,
    })
    setBusy(false)
    if (error) {
      setMsg(rpcCodeMessage(error.message) ?? `အကောင့် ဆောက်၍ မရပါ: ${error.message}`)
      return
    }
    setUsername('')
    setDisplayName('')
    setPin('')
    await load()
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="အသုံးပြုသူများ"
        subtitle="အကောင့်အသစ် ဆောက်ရန်နှင့် အခန်းကဏ္ဍများ စီမံရန်"
      />

      {okMsg && <p className="text-sm font-medium text-brand-700 dark:text-brand-400">{okMsg}</p>}

      <Card>
        <form onSubmit={onCreate} className="space-y-3">
          <CardTitle>အကောင့်အသစ် ဆောက်ရန်</CardTitle>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ''))}
              required
              placeholder="အသုံးပြုသူအမည် (a-z, 0-9)"
              className={inputCls}
            />
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
              required
              inputMode="numeric"
              placeholder="PIN ဂဏန်း (ဝန်ထမ်း/ကိုယ်စားလှယ် ၄ လုံး+, ပိုင်ရှင်/မန်နေဂျာ ၆ လုံး+)"
              className={inputCls}
            />
          </div>
          <Field label="အမည်">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="မြန်မာလို ရိုက်နိုင်ပါတယ်"
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className={inputCls}
            >
              {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            {role === 'agent' && (
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                required
                className={inputCls}
              >
                <option value="">agent ရွေးပါ</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {msg && <p className="text-sm text-red-600">{msg}</p>}
          <PrimaryButton type="submit" disabled={busy} className="w-full">
            {busy ? 'ဆောက်နေပါတယ်…' : 'ဆောက်ရန်'}
          </PrimaryButton>
        </form>
      </Card>

      {loading ? (
        <LoadingState />
      ) : (
        <ul className={`${cardCls} divide-y divide-stone-100 overflow-hidden dark:divide-neutral-800/70`}>
          {rows.map((p) => {
            const held = new Set<Role>([p.role, ...(extras[p.id] ?? [])])
            const grantable = (Object.keys(ROLE_LABELS) as Role[]).filter((r) => !held.has(r))
            return (
              <li key={p.id} className="p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      {personName(p)}
                      {!p.active && <span className="ml-2 text-xs text-red-500">ပိတ်ထားသည်</span>}
                    </div>
                    {p.display_name?.trim() && (
                      <div className="text-xs text-stone-500 dark:text-neutral-400">{p.username}</div>
                    )}
                    <div className="text-sm text-stone-500 dark:text-neutral-400">
                      {ROLE_LABELS[p.role]} (အဓိက)
                    </div>
                  </div>
                  <SecondaryButton size="sm" onClick={() => toggleActive(p)} className="shrink-0">
                    {p.active ? 'ပိတ်' : 'ဖွင့်'}
                  </SecondaryButton>
                </div>
                <DisplayNameEditor profile={p} onMsg={showMsg} onChanged={load} />
                {p.id !== me?.id && (
                  <PinResetEditor profile={p} onMsg={showMsg} onOk={showOk} />
                )}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {(extras[p.id] ?? []).map((r) => (
                    <span
                      key={r}
                      className="inline-flex min-h-[32px] items-center gap-1 rounded-full bg-brand-100 px-2.5 py-0.5 text-xs font-medium text-brand-800 dark:bg-brand-950 dark:text-brand-200"
                    >
                      {ROLE_LABELS[r]}
                      <button
                        onClick={() => revokeRole(p, r)}
                        className="flex h-6 w-6 items-center justify-center rounded-full font-bold text-red-600"
                        aria-label={`${ROLE_LABELS[r]} ဖယ်ရန်`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {grantable.length > 0 && (
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) void grantRole(p, e.target.value as Role)
                        e.target.value = ''
                      }}
                      className="min-h-[36px] rounded-full border border-stone-300 bg-white px-2.5 py-0.5 text-xs shadow-sm outline-none focus:border-brand-500 dark:border-neutral-700 dark:bg-neutral-900"
                    >
                      <option value="">+ အခန်းကဏ္ဍ ထည့်ရန်</option>
                      {grantable.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </li>
            )
          })}
          {rows.length === 0 && (
            <li className="p-3.5 text-sm text-stone-500 dark:text-neutral-400">မရှိသေးပါ</li>
          )}
        </ul>
      )}
    </div>
  )
}

/** Inline editor for a user's display name (profiles.display_name; empty clears to null). */
function DisplayNameEditor({
  profile,
  onMsg,
  onChanged,
}: {
  profile: Profile
  onMsg: (m: string | null) => void
  onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  function start() {
    setValue(profile.display_name ?? '')
    setEditing(true)
  }

  async function save() {
    setBusy(true)
    onMsg(null)
    const trimmed = value.trim()
    const { error } = await supabase
      .from('profiles')
      .update({ display_name: trimmed ? trimmed : null })
      .eq('id', profile.id)
    setBusy(false)
    if (error) {
      onMsg(error.message)
      return
    }
    setEditing(false)
    await onChanged()
  }

  if (!editing) {
    return (
      <button
        onClick={start}
        className="mt-1.5 min-h-[32px] text-xs font-medium text-brand-700 underline-offset-2 hover:underline dark:text-brand-400"
      >
        အမည် ပြင်ရန်
      </button>
    )
  }

  return (
    <div className="mt-2 flex items-end gap-2">
      <Field label="အမည်" className="flex-1">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="မြန်မာလို ရိုက်နိုင်ပါတယ်"
          className={inputCls}
          autoFocus
        />
      </Field>
      <PrimaryButton size="sm" onClick={save} disabled={busy} className="shrink-0">
        သိမ်းရန်
      </PrimaryButton>
      <SecondaryButton
        size="sm"
        onClick={() => setEditing(false)}
        disabled={busy}
        className="shrink-0"
      >
        မလုပ်တော့ပါ
      </SecondaryButton>
    </div>
  )
}

/**
 * Inline PIN reset for another user's account (admin_reset_pin RPC; a reset
 * also clears the account's login lockout). Not rendered for the signed-in
 * owner's own row — owners change their own PIN on the Home page.
 */
function PinResetEditor({
  profile,
  onMsg,
  onOk,
}: {
  profile: Profile
  onMsg: (m: string | null) => void
  onOk: (m: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    onMsg(null)
    const { error } = await supabase.rpc('admin_reset_pin', {
      p_user_id: profile.id,
      p_new_pin: value,
    })
    setBusy(false)
    if (error) {
      onMsg(rpcCodeMessage(error.message) ?? `PIN အသစ် သတ်မှတ်၍ မရပါ: ${error.message}`)
      return
    }
    setOpen(false)
    setValue('')
    onOk('PIN အသစ် သတ်မှတ်ပြီးပါပြီ (lockout ပါ ပယ်ဖျက်ပြီးပါပြီ)')
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="ml-3 mt-1.5 min-h-[32px] text-xs font-medium text-brand-700 underline-offset-2 hover:underline dark:text-brand-400"
      >
        PIN အသစ် သတ်မှတ်ရန်
      </button>
    )
  }

  return (
    <div className="mt-2">
      <div className="flex items-end gap-2">
        <Field label="PIN အသစ်" className="flex-1">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 12))}
            inputMode="numeric"
            placeholder="PIN ဂဏန်း"
            className={inputCls}
            autoFocus
          />
        </Field>
        <PrimaryButton size="sm" onClick={save} disabled={busy} className="shrink-0">
          သတ်မှတ်ရန်
        </PrimaryButton>
        <SecondaryButton
          size="sm"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="shrink-0"
        >
          မလုပ်တော့ပါ
        </SecondaryButton>
      </div>
      <p className="mt-1 text-xs text-stone-500 dark:text-neutral-400">
        ဝန်ထမ်း/ကိုယ်စားလှယ် ၄ လုံး+, ပိုင်ရှင်/မန်နေဂျာ ၆ လုံး+
      </p>
    </div>
  )
}
