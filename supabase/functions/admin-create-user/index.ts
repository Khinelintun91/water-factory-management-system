// admin-create-user — Owner-only account creation.
//
// Creating a Supabase Auth user requires the service_role key, which must
// never reach the browser. This Edge Function runs server-side inside the
// owner's Supabase project: it verifies the caller's JWT, checks the
// caller's profile role is 'owner', then creates the auth user + profile.
//
// Deploy: Supabase dashboard -> Edge Functions -> Deploy a new function ->
// name it `admin-create-user` and paste this file (or use the Supabase CLI:
// `supabase functions deploy admin-create-user`).
//
// Request body: { username: string, pin: string, role: 'owner'|'manager'|'staff'|'agent', agent_id?: string }
// Response:     { profile: { id, username, role, agent_id, active } }

// @ts-nocheck — Deno runtime (Supabase Edge Functions), not part of the Vite build.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  // Caller-scoped client (respects RLS) to prove who is calling.
  const authHeader = req.headers.get('Authorization') ?? ''
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userData, error: userErr } = await caller.auth.getUser()
  if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401)

  const admin = createClient(supabaseUrl, serviceKey)

  const { data: callerProfile } = await admin
    .from('profiles')
    .select('role, active')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (!callerProfile || callerProfile.role !== 'owner' || !callerProfile.active) {
    return json({ error: 'owner_only' }, 403)
  }

  const body = await req.json().catch(() => null)
  const username = String(body?.username ?? '').trim().toLowerCase()
  const pin = String(body?.pin ?? '')
  const role = String(body?.role ?? '')
  const agentId = body?.agent_id ? String(body.agent_id) : null

  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) return json({ error: 'invalid_username' }, 400)
  if (!/^\d{6,12}$/.test(pin)) return json({ error: 'pin_must_be_6_to_12_digits' }, 400)
  if (!['owner', 'manager', 'staff', 'agent'].includes(role)) return json({ error: 'invalid_role' }, 400)
  if (role === 'agent' && !agentId) return json({ error: 'agent_id_required' }, 400)

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: `${username}@waterfactory.local`,
    password: pin,
    email_confirm: true,
    user_metadata: { username, role },
  })
  if (createErr || !created?.user) {
    return json({ error: createErr?.message ?? 'create_failed' }, 400)
  }

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .insert({ id: created.user.id, username, role, agent_id: role === 'agent' ? agentId : null })
    .select('id, username, role, agent_id, active')
    .single()
  if (profileErr) {
    // Roll back the auth user so a retry does not collide.
    await admin.auth.admin.deleteUser(created.user.id)
    return json({ error: profileErr.message }, 400)
  }

  return json({ profile }, 201)
})
