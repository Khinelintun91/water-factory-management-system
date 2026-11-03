import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { ROLE_LABELS, type Agent, type Profile, type Role } from '../lib/types'

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
    <div className="space-y-4">
      <h1 className="text-lg font-bold">အသုံးပြုသူများ</h1>

      <form onSubmit={onCreate} className="space-y-2 rounded-2xl border p-4">
        <div className="font-semibold">အကောင့်အသစ် ဆောက်ရန်</div>
        <div className="grid grid-cols-2 gap-2">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ''))}
            required
            placeholder="အသုံးပြုသူအမည် (a-z, 0-9)"
            className="rounded-xl border px-3 py-2 dark:bg-neutral-900"
          />
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
            required
            inputMode="numeric"
            placeholder="PIN (ဂဏန်း ၆ လုံး+)"
            className="rounded-xl border px-3 py-2 dark:bg-neutral-900"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="rounded-xl border px-3 py-2 dark:bg-neutral-900"
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
              className="rounded-xl border px-3 py-2 dark:bg-neutral-900"
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
        <button
          disabled={busy}
          className="w-full rounded-xl bg-teal-700 py-2.5 font-semibold text-white disabled:opacity-60"
        >
          {busy ? 'ဆောက်နေပါတယ်…' : 'ဆောက်ရန်'}
        </button>
      </form>

      {loading ? (
        <p>ခဏစောင့်ပါ…</p>
      ) : (
        <ul className="divide-y rounded-2xl border">
          {rows.map((p) => {
            const held = new Set<Role>([p.role, ...(extras[p.id] ?? [])])
            const grantable = (Object.keys(ROLE_LABELS) as Role[]).filter((r) => !held.has(r))
            return (
              <li key={p.id} className="p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      {p.username}
                      {!p.active && <span className="ml-2 text-xs text-red-500">ပိတ်ထားသည်</span>}
                    </div>
                    <div className="text-sm opacity-75">{ROLE_LABELS[p.role]} (အဓိက)</div>
                  </div>
                  <button
                    onClick={() => toggleActive(p)}
                    className="shrink-0 rounded-lg border px-2.5 py-1.5 text-sm"
                  >
                    {p.active ? 'ပိတ်' : 'ဖွင့်'}
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {(extras[p.id] ?? []).map((r) => (
                    <span
                      key={r}
                      className="inline-flex items-center gap-1 rounded-full bg-teal-700/10 px-2 py-0.5 text-xs"
                    >
                      {ROLE_LABELS[r]}
                      <button
                        onClick={() => revokeRole(p, r)}
                        className="font-bold text-red-600"
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
                      className="rounded-full border px-2 py-0.5 text-xs dark:bg-neutral-900"
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
          {rows.length === 0 && <li className="p-3 text-sm opacity-70">မရှိသေးပါ</li>}
        </ul>
      )}
    </div>
  )
}
