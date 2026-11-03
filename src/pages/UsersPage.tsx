import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { ROLE_LABELS, type Agent, type Profile, type Role } from '../lib/types'

export default function UsersPage() {
  const [rows, setRows] = useState<Profile[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [agentId, setAgentId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: p }, { data: a }] = await Promise.all([
      supabase.from('profiles').select('id, username, role, agent_id, active').order('created_at', { ascending: true }),
      supabase.from('agents').select('*').order('created_at', { ascending: true }),
    ])
    setRows((p ?? []) as Profile[])
    setAgents((a ?? []) as Agent[])
    setLoading(false)
  }, [])

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
          {rows.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 p-3">
              <div>
                <div className="font-medium">
                  {p.username}
                  {!p.active && <span className="ml-2 text-xs text-red-500">ပိတ်ထားသည်</span>}
                </div>
                <div className="text-sm opacity-75">{ROLE_LABELS[p.role]}</div>
              </div>
              <button
                onClick={() => toggleActive(p)}
                className="shrink-0 rounded-lg border px-2.5 py-1.5 text-sm"
              >
                {p.active ? 'ပိတ်' : 'ဖွင့်'}
              </button>
            </li>
          ))}
          {rows.length === 0 && <li className="p-3 text-sm opacity-70">မရှိသေးပါ</li>}
        </ul>
      )}
    </div>
  )
}
