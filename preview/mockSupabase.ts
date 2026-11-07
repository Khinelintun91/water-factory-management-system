// Local screenshot harness only. preview/vite.config.ts aliases this file
// over src/lib/supabase.ts. The production app never imports it, and this
// client never opens a network connection.
//
// Every name, amount, and phone below is invented example data.

type Row = Record<string, unknown>

const OWNER_ID = '11111111-1111-4111-8111-111111111101'
const STAFF_ID = '33333333-3333-4333-8333-333333333303'
const AGENT_USER_ID = '22222222-2222-4222-8222-222222222202'

const A = {
  gold: 'a1111111-1111-4111-8111-111111111111',
  gold2: 'a2222222-2222-4222-8222-222222222222',
  white: 'a3333333-3333-4333-8333-333333333333',
  white2: 'a4444444-4444-4444-8444-444444444444',
  black: 'a5555555-5555-4555-8555-555555555555',
  zero: 'a6666666-6666-4666-8666-666666666666',
  closed: 'a7777777-7777-4777-8777-777777777777',
} as const

function yangonToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yangon' }).format(new Date())
}

const today = yangonToday()

function agent(partial: Row): Row {
  return {
    address: 'ဥပမာ လမ်း',
    deposit_per_bottle: 500,
    default_unit_price: 400,
    bottle_limit: 100,
    credit_limit: 200000,
    closed_at: null,
    closed_by: null,
    active: true,
    trip_qty: 20,
    notes: null,
    updated_at: `${today}T02:00:00.000Z`,
    ...partial,
  }
}

const agents: Row[] = [
  agent({
    id: A.gold,
    code: 'EX-01',
    name: 'ဥပမာ-ရွှေ',
    created_at: '2026-01-01T00:00:00.000Z',
    phone_hint: '09-000-0001',
  }),
  agent({
    id: A.gold2,
    code: 'EX-02',
    name: 'ဥပမာ-ရွှေနှစ်',
    created_at: '2026-01-02T00:00:00.000Z',
  }),
  agent({
    id: A.white,
    code: 'EX-03',
    name: 'ဥပမာ-ငွေ',
    created_at: '2026-01-03T00:00:00.000Z',
  }),
  agent({
    id: A.white2,
    code: 'EX-04',
    name: 'ဥပမာ-အလယ်',
    created_at: '2026-01-04T00:00:00.000Z',
  }),
  agent({
    id: A.black,
    code: 'EX-05',
    name: 'ဥပမာ-အောက်',
    created_at: '2026-01-05T00:00:00.000Z',
  }),
  agent({
    id: A.zero,
    code: 'EX-06',
    name: 'ဥပမာ-သုည',
    created_at: '2026-01-06T00:00:00.000Z',
  }),
  agent({
    id: A.closed,
    code: 'EX-07',
    name: 'ဥပမာ-ပိတ်',
    created_at: '2026-01-07T00:00:00.000Z',
    closed_at: '2026-10-01T00:00:00.000Z',
    closed_by: OWNER_ID,
    active: false,
  }),
]

const sales: Record<string, number> = {
  [A.closed]: 900000,
  [A.gold]: 800000,
  [A.gold2]: 500000,
  [A.white]: 200000,
  [A.white2]: 80000,
  [A.black]: 10000,
  [A.zero]: 0,
}

const outstanding: Record<string, number> = {
  [A.gold]: 45000,
  [A.gold2]: 12000,
  [A.white]: 0,
  [A.white2]: 8000,
  [A.black]: 3000,
  [A.zero]: 0,
  [A.closed]: 0,
}

const profiles: Row[] = [
  {
    id: OWNER_ID,
    username: 'example_owner',
    display_name: 'ဥပမာ ပိုင်ရှင်',
    role: 'owner',
    agent_id: null,
    active: true,
  },
  {
    id: STAFF_ID,
    username: 'example_staff',
    display_name: 'ဥပမာ ဝန်ထမ်း',
    role: 'staff',
    agent_id: null,
    active: true,
  },
  {
    id: AGENT_USER_ID,
    username: 'example_agent',
    display_name: 'ဥပမာ ကိုယ်စားလှယ်',
    role: 'agent',
    agent_id: A.gold,
    active: true,
  },
]

const entries: Row[] = [
  {
    id: 'e1111111-1111-4111-8111-111111111111',
    entry_date: today,
    agent_id: A.gold,
    agent_name: 'ဥပမာ-ရွှေ',
    delivered_qty: 40,
    returned_qty: 10,
    unit_price: 400,
    amount: 16000,
    amount_collected: 10000,
    change_reason: null,
    notes: 'ဥပမာ မှတ်တမ်း',
    created_by: OWNER_ID,
    created_at: `${today}T01:00:00.000Z`,
    updated_at: `${today}T01:00:00.000Z`,
  },
  {
    id: 'e2222222-2222-4222-8222-222222222222',
    entry_date: today,
    agent_id: A.white,
    agent_name: 'ဥပမာ-ငွေ',
    delivered_qty: 20,
    returned_qty: 5,
    unit_price: 400,
    amount: 8000,
    amount_collected: 8000,
    change_reason: null,
    notes: null,
    created_by: STAFF_ID,
    created_at: `${today}T03:00:00.000Z`,
    updated_at: `${today}T03:00:00.000Z`,
  },
]

const payments: Row[] = [
  {
    id: 'p1111111-1111-4111-8111-111111111111',
    payment_date: today,
    agent_id: A.gold,
    agent_name: 'ဥပမာ-ရွှေ',
    amount: 20000,
    method: 'cash',
    kind: 'regular',
    change_reason: null,
    notes: 'ဥပမာ ကောက်ခံမှု',
    created_by: OWNER_ID,
    created_at: `${today}T04:00:00.000Z`,
    updated_at: `${today}T04:00:00.000Z`,
  },
  {
    id: 'p2222222-2222-4222-8222-222222222222',
    payment_date: today,
    agent_id: A.white2,
    agent_name: 'ဥပမာ-အလယ်',
    amount: 5000,
    method: 'kpay',
    kind: 'old_debt',
    change_reason: null,
    notes: null,
    created_by: STAFF_ID,
    created_at: `${today}T05:00:00.000Z`,
    updated_at: `${today}T05:00:00.000Z`,
  },
]

const expenses: Row[] = [
  {
    id: 'x1111111-1111-4111-8111-111111111111',
    expense_date: today,
    amount: 3000,
    created_at: `${today}T06:00:00.000Z`,
  },
]

const contacts: Row[] = [
  { agent_id: A.gold, phone: '09-000-0001' },
  { agent_id: A.gold2, phone: '09-000-0002' },
  { agent_id: A.white, phone: '09-000-0003' },
]

const settings: Row[] = [
  { key: 'factory_name', value: 'ဥပမာ ရေသန့်စက်ရုံ' },
  { key: 'refresh_seconds', value: 3600 },
  { key: 'default_price_per_bottle', value: 400 },
  { key: 'default_deposit_per_bottle', value: 500 },
]

const tables: Record<string, Row[]> = {
  agents,
  profiles,
  user_roles: [],
  daily_entries: entries,
  agent_payments: payments,
  expenses,
  expense_categories: [{ id: 'cat-1', name: 'ဥပမာ အသုံးစရိတ်' }],
  agent_contacts: contacts,
  app_settings: settings,
  month_locks: [],
  notifications: [],
  agent_deposits: [{ agent_id: A.gold, amount: 20000, bottles: 40 }],
  write_offs: [],
  disputes: [],
  inventory_movements: [],
}

const summaries = agents.map((a) => ({
  agent_id: a.id,
  sales: sales[String(a.id)] ?? 0,
  cash: 10000,
  payments: 5000,
  write_offs: 0,
  outstanding: outstanding[String(a.id)] ?? 0,
}))

function asAgent(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('as') === 'agent'
}

function currentProfile(): Row {
  return profiles.find((p) => p.id === (asAgent() ? AGENT_USER_ID : OWNER_ID))!
}

class Query {
  private filters: { op: string; col: string; val: unknown }[] = []
  private from = 0
  private to = 1_000_000
  private head = false
  private write = false

  constructor(private table: string) {}

  select(_columns?: string, opts?: { count?: string; head?: boolean }) {
    this.head = Boolean(opts?.head)
    return this
  }
  eq(col: string, val: unknown) {
    this.filters.push({ op: 'eq', col, val })
    return this
  }
  gte(col: string, val: unknown) {
    this.filters.push({ op: 'gte', col, val })
    return this
  }
  lt(col: string, val: unknown) {
    this.filters.push({ op: 'lt', col, val })
    return this
  }
  lte(col: string, val: unknown) {
    this.filters.push({ op: 'lte', col, val })
    return this
  }
  in(col: string, vals: unknown[]) {
    this.filters.push({ op: 'in', col, val: vals })
    return this
  }
  is(col: string, val: unknown) {
    this.filters.push({ op: 'is', col, val })
    return this
  }
  order() {
    return this
  }
  limit(n: number) {
    this.from = 0
    this.to = n - 1
    return this
  }
  range(from: number, to: number) {
    this.from = from
    this.to = to
    return this
  }
  insert() {
    this.write = true
    return this
  }
  update() {
    this.write = true
    return this
  }
  delete() {
    this.write = true
    return this
  }
  upsert() {
    this.write = true
    return this
  }

  private matched(): Row[] {
    const rows = tables[this.table] ?? []
    return rows.filter((row) =>
      this.filters.every((f) => {
        const v = row[f.col]
        if (f.op === 'eq' || f.op === 'is') return v === f.val
        if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(v)
        const left = String(v ?? '')
        const right = String(f.val ?? '')
        if (f.op === 'gte') return left >= right
        if (f.op === 'lt') return left < right
        if (f.op === 'lte') return left <= right
        return true
      }),
    )
  }

  private payload() {
    if (this.write) return { data: null, error: null, count: 0 }
    const all = this.matched()
    if (this.head) return { data: null, error: null, count: all.length }
    return { data: all.slice(this.from, this.to + 1), error: null, count: null }
  }

  maybeSingle() {
    if (this.write) return Promise.resolve({ data: null, error: null })
    return Promise.resolve({ data: this.matched()[0] ?? null, error: null })
  }

  then<T>(
    resolve: (value: { data: Row[] | null; error: null; count: number | null }) => T,
    reject?: (reason: unknown) => T,
  ) {
    return Promise.resolve(this.payload()).then(resolve, reject)
  }
}

function sessionFor(profile: Row) {
  return {
    access_token: 'example-token',
    user: { id: profile.id, email: `${profile.username}@waterfactory.local` },
  }
}

export const isConfigured = true

export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@waterfactory.local`
}

export const supabase = {
  from(table: string) {
    return new Query(table)
  },
  rpc(name: string, args?: Record<string, unknown>) {
    if (name === 'public_factory_name') {
      return Promise.resolve({ data: 'ဥပမာ ရေသန့်စက်ရုံ', error: null })
    }
    if (name === 'collections_summary') {
      return Promise.resolve({ data: summaries, error: null })
    }
    if (name === 'agent_outstanding') {
      const id = String(args?.p_agent ?? '')
      return Promise.resolve({ data: outstanding[id] ?? 0, error: null })
    }
    if (name === 'agent_held_totals') {
      return Promise.resolve({
        data: agents.map((a) => ({ agent_id: a.id, held: a.id === A.gold ? 30 : 8 })),
        error: null,
      })
    }
    if (name === 'my_card_tier') {
      return Promise.resolve({
        data: [{ tier: 'gold', sales_rank: 2, agent_count: agents.length }],
        error: null,
      })
    }
    if (name === 'login_lock_status' || name === 'log_failed_login') {
      return Promise.resolve({ data: null, error: null })
    }
    return Promise.resolve({ data: [], error: null })
  },
  auth: {
    async getSession() {
      return { data: { session: sessionFor(currentProfile()) }, error: null }
    },
    onAuthStateChange(cb: (event: string, session: ReturnType<typeof sessionFor> | null) => void) {
      queueMicrotask(() => cb('INITIAL_SESSION', sessionFor(currentProfile())))
      return { data: { subscription: { unsubscribe() {} } } }
    },
    async signInWithPassword() {
      const profile = currentProfile()
      return { data: { user: { id: profile.id }, session: sessionFor(profile) }, error: null }
    },
    async signOut() {
      return { error: null }
    },
    async updateUser() {
      return { data: { user: { id: currentProfile().id } }, error: null }
    },
  },
}
