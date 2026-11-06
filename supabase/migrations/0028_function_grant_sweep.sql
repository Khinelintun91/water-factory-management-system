-- 0028_function_grant_sweep.sql — PUBLIC/anon EXECUTE sweep for every
-- public-schema function NOT already handled by 0026 (P0 audit follow-up
-- to 0026_login_security.sql, 2026-11-06).
--
-- SOURCE OF THE LIST (authoritative, read-only, taken 2026-11-06 via the
-- Supabase Management API against the live project): every function in
-- schema `public` whose effective ACL — aclexplode(coalesce(proacl,
-- acldefault('f', proowner))) — grants EXECUTE to PUBLIC (grantee 0) or
-- to `anon`. That union returns 32 functions live. Step-0 counted 31;
-- the difference is a counting-method artefact (Step-0 counted PUBLIC
-- executability; this sweep counts PUBLIC *or* anon — e.g.
-- public_factory_name has no PUBLIC grant but an explicit anon grant).
-- 0026 already handled or decided 8 of the 32, leaving the 24 below:
--   handled in 0026 (revoked there — DO NOT duplicate here):
--     record_login_failure(text), clear_login_failures(),
--     insert_notification(uuid,text,text,text,text,text,text),
--     om_recipients(uuid), send_daily_digest(),
--     run_data_quality_alerts(), agent_outstanding(uuid)
--   decided UNCHANGED in 0026 (pre-login lock check must stay anon):
--     login_lock_status(text)
--   (0026's new functions — log_login_attempt, log_failed_login,
--   guard_last_owner — are not live yet and set their own grants.)
--
-- BEFORE state for 23 of the 24: EXECUTE granted to PUBLIC, postgres
-- (owner), anon, authenticated, service_role (verified per function).
-- public_factory_name is the exception: anon, authenticated,
-- service_role, owner — no PUBLIC (0015 revoked it). Explicit
-- service_role grants are left untouched throughout: service_role
-- bypasses RLS by design, is server-side only, and never ships in the
-- client (repo AGENTS.md). The owner keeps its inherent rights.
--
-- CLASSIFICATION (evidence = grep of src/ for .rpc() callers + grep of
-- supabase/migrations/ for policies / triggers / internal calls,
-- 2026-11-06)
--   A = RLS helper evaluated inside policies as the querying user:
--       keep `authenticated`, revoke PUBLIC + anon.
--   B = trigger function: revoke PUBLIC + anon + authenticated
--       (analysis below).
--   C = app-called RPC with a verified in-body caller gate:
--       keep `authenticated`, revoke PUBLIC + anon.
--   D = leave unchanged (deliberate — see the D section).
--
--   function (identity signature)          bucket  after                     evidence
--   -------------------------------------  ------  ------------------------  --------------------------------
--   app_role()                             A       authenticated only        policies throughout 0002/0005/
--                                                                           0006 use it `to authenticated`;
--                                                                           also called inside definer
--                                                                           bodies (hard_delete_agent 0008,
--                                                                           entries_before_write, 0018)
--   app_agent_id()                         A       authenticated only        policies 0002/0006 (`to
--                                                                           authenticated`); no src/ caller
--   has_role(user_role)                    A       authenticated only        0006: backs is_owner_manager /
--                                                                           is_staff_plus (both definer);
--                                                                           no policy uses it directly and
--                                                                           no src/ caller, but it is the
--                                                                           effective-role primitive every
--                                                                           policy chain resolves through —
--                                                                           treated as A per the sweep
--                                                                           brief, conservatively
--   is_owner_manager()                     A       authenticated only        policies 0002/0006 `to
--                                                                           authenticated`; in-body gate in
--                                                                           0009/0020/0021/0022/0025 RPCs
--   is_staff_plus()                        A       authenticated only        policies 0002/0006 `to
--                                                                           authenticated`; in-body gate in
--                                                                           0021/0023 RPCs
--   audit_row_change()                     B       nobody (client roles)     trigger only: 0003/0005/0006/
--                                                                           0009 `execute function` lines
--   entries_before_write()                 B       nobody                    trigger only: 0006 (+0007 note)
--   fill_agent_name()                      B       nobody                    trigger only: 0006 (5 triggers)
--   force_insert_attribution()             B       nobody                    trigger only: 0005/0006/0009
--   guard_insert_today()                   B       nobody                    trigger only: 0004/0018/0019/
--                                                                           0027 (function args are () —
--                                                                           the date column name is a
--                                                                           TRIGGER argument, not a
--                                                                           function argument)
--   guard_month_lock()                     B       nobody                    trigger only: 0003/0006/0009
--   guard_month_lock_text()                B       nobody                    trigger only: 0009
--   guard_same_day_edit()                  B       nobody                    trigger only: 0003/0027
--   notify_on_dispute()                    B       nobody                    trigger only: 0011
--   notify_on_dispute_reply()              B       nobody                    trigger only: 0011
--   notify_on_entry()                      B       nobody                    trigger only: 0011/0015
--   notify_on_payment()                    B       nobody                    trigger only: 0011
--   set_updated_at()                       B       nobody                    trigger only: 0003/0006/0009/
--                                                                           0011
--   agent_held_totals()                    C       authenticated only        src/: AgentsPage.tsx rpc();
--                                                                           body gate: is_staff_plus()
--                                                                           else 'forbidden' (0021)
--   collections_summary(date, date)        C       authenticated only        src/: AgentsPage + Collections-
--                                                                           Page rpc(); body gate:
--                                                                           is_owner_manager() (0021)
--   finalize_closeout(uuid, integer,      C       authenticated only        src/: CloseoutPage rpc(); body
--     integer, text)                                                          gate: is_owner_manager() (0006)
--   hard_delete_agent(uuid)                C       authenticated only        src/: AgentDetailPage rpc();
--                                                                           body gate: app_role()='owner'
--                                                                           (0008, current definition)
--   pay_month(uuid, text)                  C       authenticated only        src/: PayrollPage rpc(); body
--                                                                           gate: is_owner_manager() (0009)
--   public_factory_name()                  D       UNCHANGED                 see D section below
--
-- BUCKET C BODY-FIX FLAGS: NONE. Every bucket-C body's caller gate was
-- read in full for this sweep (0021, 0006, 0008, 0009 — table above);
-- each one rejects callers below its intended role before touching any
-- data, so no C function exposes another user's data to a signed-in
-- caller who passes the new grant but not the gate. (The known
-- agent_outstanding residual from 0026 — definer with NO caller gate,
-- authenticated tightening still owed — is a 0026 function and stays
-- tracked there, not duplicated here.)
--
-- BUCKET B — WHY REVOKING EXECUTE DOES NOT BREAK TRIGGERS (checked,
-- not assumed):
--   * A direct call (SELECT f(...), PostgREST /rpc/f) checks EXECUTE
--     against the CALLING role. That is the path this migration closes.
--   * Trigger firing is not a user call: the executor invokes the
--     function through the trigger manager. PostgreSQL does not check
--     the invoking (DML-writing) user's EXECUTE privilege at fire
--     time — repeatedly confirmed on pgsql-hackers (e.g. "Permissions
--     on a trigger function seem to not be checked", 2006; "Trigger
--     function permissions", 2014: inserts still work after revoking
--     PUBLIC, even for the table owner; a later thread notes the
--     EXECUTE check at CREATE TRIGGER time is done for the trigger
--     OWNER — here the migration role, which as function owner always
--     holds its own rights). What CREATE TRIGGER required was the
--     creator's EXECUTE, and all these triggers already exist.
--   * SECURITY DEFINER trigger functions (audit_row_change,
--     entries_before_write, notify_*) run as their owner regardless.
--     SECURITY INVOKER ones (the guard_* family, fill_agent_name,
--     force_insert_attribution, set_updated_at) run with the invoking
--     user's rights *for the objects their bodies touch* — revoking
--     EXECUTE on the function itself changes none of those object
--     privileges; their bodies only read trigger data (NEW/OLD,
--     month_locks, profiles via helpers) exactly as they do today.
--   * In-repo precedent: 0026 already revokes guard_last_owner() from
--     public/anon/authenticated on exactly this reasoning, and revokes
--     insert_notification from all client roles while definer trigger
--     bodies keep calling it internally.
--   CONSERVATIVE POST-APPLY VERIFICATION (required, because the claim
--   above is behaviour, not a doc guarantee): as staff, agent, and
--   owner on scratch data, exercise one INSERT + UPDATE + same-day
--   DELETE on daily_entries and agent_payments, one expense insert,
--   and confirm: audit_log rows appear, created_by is stamped,
--   month-lock and same-day violations still raise, and a dispute +
--   payment still create notifications. If ANY trigger silently stops
--   firing, roll back section 2 only (rollback comment below) and
--   reclassify that one function to D pending investigation.
--
-- BUCKET D — public_factory_name(): LEAVE UNCHANGED, DELIBERATELY.
--   0015 created it precisely so the LOGIN PAGE can show the factory
--   name BEFORE sign-in: LoginPage.tsx calls supabase.rpc(
--   'public_factory_name') with no session, i.e. as `anon`, and
--   app_settings itself is authenticated-only. It fits no other
--   bucket: A (not a policy helper), B (not a trigger), C (revoking
--   anon would break the pre-login login card — the one designed
--   behaviour). It returns exactly one string — the factory display
--   name, a value printed on the business's own signage/invoices,
--   falling back to the generic factory name — and reads no
--   per-user or money data. No evidence is missing; the anon grant is
--   the product behaviour. If the owner ever decides the factory name
--   must not be visible pre-login, that is a product change (drop the
--   login-card name), not a grant change — do not "fix" it here.
--
-- NOT DONE HERE: no function bodies change; no table/RLS changes; the
-- service_role and owner grants are untouched; 0026/0027 are not
-- modified. This file is drafted locally and must be applied in order
-- (after 0026 and 0027) through the normal migration path.
--
-- ROLLBACK (comment only — restores the exact BEFORE state):
--   -- bucket A + C (grant back to public + anon; authenticated kept):
--   grant execute on function public.app_role() to public, anon;
--   grant execute on function public.app_agent_id() to public, anon;
--   grant execute on function public.has_role(user_role) to public, anon;
--   grant execute on function public.is_owner_manager() to public, anon;
--   grant execute on function public.is_staff_plus() to public, anon;
--   grant execute on function public.agent_held_totals() to public, anon;
--   grant execute on function public.collections_summary(date, date)
--     to public, anon;
--   grant execute on function public.finalize_closeout(uuid, integer,
--     integer, text) to public, anon;
--   grant execute on function public.hard_delete_agent(uuid)
--     to public, anon;
--   grant execute on function public.pay_month(uuid, text)
--     to public, anon;
--   -- bucket B (grant back to public + anon + authenticated):
--   grant execute on function public.audit_row_change()
--     to public, anon, authenticated;
--   grant execute on function public.entries_before_write()
--     to public, anon, authenticated;
--   grant execute on function public.fill_agent_name()
--     to public, anon, authenticated;
--   grant execute on function public.force_insert_attribution()
--     to public, anon, authenticated;
--   grant execute on function public.guard_insert_today()
--     to public, anon, authenticated;
--   grant execute on function public.guard_month_lock()
--     to public, anon, authenticated;
--   grant execute on function public.guard_month_lock_text()
--     to public, anon, authenticated;
--   grant execute on function public.guard_same_day_edit()
--     to public, anon, authenticated;
--   grant execute on function public.notify_on_dispute()
--     to public, anon, authenticated;
--   grant execute on function public.notify_on_dispute_reply()
--     to public, anon, authenticated;
--   grant execute on function public.notify_on_entry()
--     to public, anon, authenticated;
--   grant execute on function public.notify_on_payment()
--     to public, anon, authenticated;
--   grant execute on function public.set_updated_at()
--     to public, anon, authenticated;
--   -- bucket D: nothing to roll back (unchanged).

-- ---------------------------------------------------------------------------
-- 1) Bucket A — RLS policy helpers: authenticated keeps EXECUTE because
--    policies evaluate as the querying (signed-in) user; anon is never a
--    policy subject in this schema (every policy is `to authenticated`)
--    and no pre-login code path calls any of these, so PUBLIC + the
--    explicit anon grant both go.
-- ---------------------------------------------------------------------------
revoke all on function public.app_role() from public, anon;
grant execute on function public.app_role() to authenticated;

revoke all on function public.app_agent_id() from public, anon;
grant execute on function public.app_agent_id() to authenticated;

revoke all on function public.has_role(user_role) from public, anon;
grant execute on function public.has_role(user_role) to authenticated;

revoke all on function public.is_owner_manager() from public, anon;
grant execute on function public.is_owner_manager() to authenticated;

revoke all on function public.is_staff_plus() from public, anon;
grant execute on function public.is_staff_plus() to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Bucket B — trigger functions: no client role needs EXECUTE; direct
--    /rpc access is closed for all of them. Trigger firing does not use
--    the invoking user's EXECUTE grant (see header analysis + the
--    required post-apply trigger smoke tests there).
-- ---------------------------------------------------------------------------
revoke all on function public.audit_row_change()
  from public, anon, authenticated;
revoke all on function public.entries_before_write()
  from public, anon, authenticated;
revoke all on function public.fill_agent_name()
  from public, anon, authenticated;
revoke all on function public.force_insert_attribution()
  from public, anon, authenticated;
revoke all on function public.guard_insert_today()
  from public, anon, authenticated;
revoke all on function public.guard_month_lock()
  from public, anon, authenticated;
revoke all on function public.guard_month_lock_text()
  from public, anon, authenticated;
revoke all on function public.guard_same_day_edit()
  from public, anon, authenticated;
revoke all on function public.notify_on_dispute()
  from public, anon, authenticated;
revoke all on function public.notify_on_dispute_reply()
  from public, anon, authenticated;
revoke all on function public.notify_on_entry()
  from public, anon, authenticated;
revoke all on function public.notify_on_payment()
  from public, anon, authenticated;
revoke all on function public.set_updated_at()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Bucket C — app-called RPCs, each with a verified in-body caller
--    gate (header table): signed-in app pages keep working via
--    `authenticated`; the unauthenticated /rpc surface closes.
-- ---------------------------------------------------------------------------
revoke all on function public.agent_held_totals() from public, anon;
grant execute on function public.agent_held_totals() to authenticated;

revoke all on function public.collections_summary(date, date)
  from public, anon;
grant execute on function public.collections_summary(date, date)
  to authenticated;

revoke all on function public.finalize_closeout(
  uuid, integer, integer, text) from public, anon;
grant execute on function public.finalize_closeout(
  uuid, integer, integer, text) to authenticated;

revoke all on function public.hard_delete_agent(uuid) from public, anon;
grant execute on function public.hard_delete_agent(uuid)
  to authenticated;

revoke all on function public.pay_month(uuid, text) from public, anon;
grant execute on function public.pay_month(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Bucket D — public_factory_name(): intentionally NO statement.
--    Its anon + authenticated grants are the designed pre-login
--    behaviour (0015; LoginPage). See the header D section.
-- ---------------------------------------------------------------------------
