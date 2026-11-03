import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { ROLE_LABELS, type Agent, type Profile, type Role } from '../lib/types'
import {
  Card,
  CardTitle,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  cardCls,
  inputCls,
} from '../components/ui'

export default function UsersPage() {
  const [rows, setRows] = useState<Profile[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [extras, setExtras] = useState<Record<string, Role[]>>({})
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [agentId, setAgentId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: p }, { data: a }, { data: ur }] = await Promise.all([
      supabase.from('profiles').select('id, username, role, agent_id, active').order('created_at', { ascending: true }),
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
    if (role === 'agent' && !agentId) {
      setMsg('ကိုယ်စားလှယ် အကောင့်အတွက် agent ရွေးပါ')
      return
    }
    setBusy(true)
    const { error } = await supabase.functions.invoke('admin-create-user', {
      body: {
        username: username.trim(),
        pin,
        role,
        agent_id: role === 'agent' ? agentId : undefined,
      },
    })
    setBusy(false)
    if (error) {
      setMsg(
        `အကောင့် ဆောက်၍ မရပါ: ${error.message} (admin-create-user function ကို Supabase မှာ deploy လုပ်ထားဖို့ လိုပါတယ် — docs/SETUP.md ကြည့်ပါ)`,
      )
      return
    }
    setUsername('')
    setPin('')
    await load()
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="အသုံးပြုသူများ"
        subtitle="အကောင့်အသစ် ဆောက်ရန်နှင့် အခန်းကဏ္ဍများ စီမံရန်"
      />

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
              placeholder="PIN (ဂဏန်း ၆ လုံး+)"
              className={inputCls}
            />
          </div>
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
                      {p.username}
                      {!p.active && <span className="ml-2 text-xs text-red-500">ပိတ်ထားသည်</span>}
                    </div>
                    <div className="text-sm text-stone-500 dark:text-neutral-400">
                      {ROLE_LABELS[p.role]} (အဓိက)
                    </div>
                  </div>
                  <SecondaryButton size="sm" onClick={() => toggleActive(p)} className="shrink-0">
                    {p.active ? 'ပိတ်' : 'ဖွင့်'}
                  </SecondaryButton>
                </div>
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
