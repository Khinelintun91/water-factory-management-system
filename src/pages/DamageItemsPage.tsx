import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { friendlyError } from '../lib/friendlyError'
import { formatMMK, type DamageItem } from '../lib/types'
import {
  Card,
  CardTitle,
  Field,
  LoadingState,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  inputCls,
} from '../components/ui'

/**
 * The owner's shared damage price list (migration 0042). One list for
 * the whole factory: the owner defines items (bottle caps, dispenser
 * taps, anything) and their prices here, and a change is instantly the
 * price every agent sees in their own account. Items are deactivated,
 * never deleted, so old charge records stay readable. Owner-only —
 * the route Guard and RLS both enforce it.
 */
export default function DamageItemsPage() {
  const [items, setItems] = useState<DamageItem[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)

  // Add form
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')

  // Inline edit state (one row at a time)
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editPrice, setEditPrice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('damage_items')
      .select('*')
      .order('created_at', { ascending: true })
    if (error) {
      setMsg(friendlyError(error))
    } else {
      setItems((data ?? []) as DamageItem[])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    const { error } = await supabase.from('damage_items').insert({
      name: name.trim(),
      unit_price: Number(price) || 0,
    })
    if (error) {
      setMsg(friendlyError(error))
      return
    }
    setName('')
    setPrice('')
    await load()
  }

  function startEdit(it: DamageItem) {
    setEditId(it.id)
    setEditName(it.name)
    setEditPrice(String(it.unit_price))
    setMsg(null)
  }

  async function onSaveEdit(id: string) {
    setMsg(null)
    const { error } = await supabase
      .from('damage_items')
      .update({ name: editName.trim(), unit_price: Number(editPrice) || 0 })
      .eq('id', id)
    if (error) {
      setMsg(friendlyError(error))
      return
    }
    setEditId(null)
    await load()
  }

  async function onToggleActive(it: DamageItem) {
    setMsg(null)
    const { error } = await supabase
      .from('damage_items')
      .update({ active: !it.active })
      .eq('id', it.id)
    if (error) {
      setMsg(friendlyError(error))
      return
    }
    await load()
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      <PageHeader
        title="ပျက်စီးမှု ဈေးနှုန်းများ"
        subtitle="ကိုယ်စားလှယ် အားလုံးအတွက် ဈေးနှုန်း စာရင်း တစ်ခုတည်း — ဒီမှာ ပြောင်းလိုက်သည်နှင့် ကိုယ်စားလှယ်များ ချက်ချင်း မြင်ရပါမည်"
      />

      {msg && (
        <p className="text-sm text-red-600" role="alert">
          {msg}
        </p>
      )}

      <Card>
        <CardTitle>ပစ္စည်း အသစ် ထည့်ရန်</CardTitle>
        <form onSubmit={onAdd} className="mt-3 space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="အမည်">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ဥပမာ — အဖုံး"
                required
                className={inputCls}
              />
            </Field>
            <Field label="ဈေးနှုန်း (ကျပ်)">
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                required
                className={inputCls}
              />
            </Field>
          </div>
          <PrimaryButton type="submit" className="w-full">
            ထည့်ရန်
          </PrimaryButton>
        </form>
      </Card>

      <Card>
        <CardTitle>ဈေးနှုန်း စာရင်း</CardTitle>
        {loading ? (
          <LoadingState />
        ) : items.length === 0 ? (
          <p className="mt-2 text-sm opacity-70">ပစ္စည်း မရှိသေးပါ</p>
        ) : (
          <ul className="divide-y divide-stone-100 dark:divide-neutral-800">
            {items.map((it) => (
              <li key={it.id} className="py-3 text-sm">
                {editId === it.id ? (
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-2 gap-2.5">
                      <Field label="အမည်">
                        <input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          required
                          className={inputCls}
                        />
                      </Field>
                      <Field label="ဈေးနှုန်း (ကျပ်)">
                        <input
                          value={editPrice}
                          onChange={(e) => setEditPrice(e.target.value.replace(/\D/g, ''))}
                          inputMode="numeric"
                          required
                          className={inputCls}
                        />
                      </Field>
                    </div>
                    <div className="flex gap-2">
                      <PrimaryButton size="sm" onClick={() => void onSaveEdit(it.id)}>
                        သိမ်းရန်
                      </PrimaryButton>
                      <SecondaryButton size="sm" onClick={() => setEditId(null)}>
                        မလုပ်တော့ပါ
                      </SecondaryButton>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="font-medium">{it.name}</span>{' '}
                      <span className={it.active ? 'text-xs text-brand-700 dark:text-brand-300' : 'text-xs text-red-500'}>
                        {it.active ? 'သုံးနေဆဲ' : 'ပိတ်ထားသည်'}
                      </span>
                      <span className="block tabular-nums opacity-75">{formatMMK(it.unit_price)}</span>
                    </span>
                    <span className="flex shrink-0 gap-1.5">
                      <SecondaryButton size="sm" onClick={() => startEdit(it)}>
                        ပြင်ရန်
                      </SecondaryButton>
                      <SecondaryButton size="sm" onClick={() => void onToggleActive(it)}>
                        {it.active ? 'ပိတ်ရန်' : 'ပြန်ဖွင့်ရန်'}
                      </SecondaryButton>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs opacity-70">
          ပစ္စည်းကို ဖျက်၍ မရပါ — မသုံးတော့လျှင် ပိတ်ထားပါ။ မှတ်တမ်း အဟောင်းများမှာ မူရင်း ဈေးနှုန်း အတိုင်း ကျန်ပါမည်။
        </p>
      </Card>
    </div>
  )
}
