-- 0029_agent_outstanding_caller_check.sql — agent_outstanding(uuid)
-- caller gate (Item 4 leftover from the 2026-11-06 audit; the residual
-- 0026 §C and 0028 both recorded but deliberately did not fix).
--
-- BEFORE: agent_outstanding (0006, its only definition) is SECURITY
-- DEFINER with NO caller check. 0026/0028 removed the anon/PUBLIC
-- execute grants, so the exposure narrowed to signed-in users — but
-- ANY authenticated user, including an agent login, could still call
-- it with any other agent's id and read that agent's exact outstanding
-- balance, bypassing SPEC rule 1 (agent data isolation) through the
-- RPC door while RLS kept the table door shut.
--
-- CALLER INVENTORY (grep of src/ + supabase/migrations/, 2026-11-06)
--   Direct RPC callers in src/ — all behind staff-plus route guards:
--     AgentsPage.tsx, AgentDetailPage.tsx, CloseoutPage.tsx.
--   DB-internal callers (all SECURITY DEFINER; auth.uid() inside them
--   is still the ORIGINAL caller's JWT subject, so the gate below sees
--   the real user, not the function owner):
--     entries_before_write() (0006, replaced 0007) — calls it ONLY in
--       the credit-limit branch, which runs ONLY when
--       app_role() = 'staff'. A primary-staff caller always satisfies
--       is_staff_plus(), so staff entry insertion cannot break. A
--       hypothetical multi-role caller whose PRIMARY role is 'agent'
--       never reaches the call at all (the branch is keyed on the
--       primary role — pre-existing behaviour, unchanged here).
--     finalize_closeout() (0006) — calls it only AFTER its own
--       is_owner_manager() gate; owner/manager ⊂ staff-plus. Safe.
--     collections_summary() (0021) — same: is_owner_manager() gate
--       precedes the internal call. Safe.
--   No agent-context path calls it today (MyPage does not RPC it), but
--   the gate deliberately ALLOWS an agent asking for their OWN id
--   (app_agent_id() = p_agent) so a future agent-facing balance call
--   stays possible without weakening isolation.
--   No pg_cron job, policy, view or other trigger calls it (grep of
--   0001–0028: only the three internal callers above).
--
-- THE GATE
--   if auth.uid() is not null
--      and not is_staff_plus()
--      and app_agent_id() is distinct from p_agent
--   then raise 'forbidden' (the codebase's gate wording: 0021, 0023).
--
--   The auth.uid() IS NOT NULL condition scopes the gate to JWT
--   (REST/API) callers. A direct database session (SQL Editor,
--   service_role maintenance, restore tooling) has no JWT subject;
--   those paths are already fully privileged and are NOT reachable by
--   anon — anon holds no EXECUTE grant on this function since 0026.
--   Without this condition the gate would break legitimate owner SQL
--   maintenance and the drill/test rig, for zero API-side gain.
--
-- Body is otherwise byte-equivalent to 0006: same three sums, same
-- coalesce, same return type. Language changes sql → plpgsql solely
-- to host the gate; the function stays STABLE SECURITY DEFINER with
-- search_path pinned. Grants are re-asserted (idempotent; CREATE OR
-- REPLACE preserves the ACL set by 0026/0028, these lines just make
-- the end state explicit in filename order).

create or replace function agent_outstanding(p_agent uuid) returns bigint
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and not is_staff_plus()
     and app_agent_id() is distinct from p_agent then
    raise exception 'forbidden';
  end if;

  return coalesce((
           select sum(delivered_qty::bigint * unit_price - amount_collected)
           from daily_entries where agent_id = p_agent), 0)
       - coalesce((select sum(amount) from agent_payments where agent_id = p_agent), 0)
       - coalesce((select sum(amount) from write_offs    where agent_id = p_agent), 0);
end $$;

revoke all on function public.agent_outstanding(uuid) from public, anon;
grant execute on function public.agent_outstanding(uuid) to authenticated;
