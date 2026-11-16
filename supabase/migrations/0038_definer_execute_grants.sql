-- 0038: execute grants for the 25 SECURITY DEFINER functions that
-- authenticated can call (the RPC matrix through admin_reset_pin).
--
-- Review result: authenticated must KEEP execute on all 25.
--   * The five helpers (app_role, app_agent_id, has_role,
--     is_owner_manager, is_staff_plus) are evaluated as the signed-in
--     user inside RLS policies. Revoking authenticated would break
--     every policy.
--   * The other twenty are called from the React app. Postgres has one
--     role, `authenticated`, for owner, manager, co-owner, staff and
--     agent. The business-role check stays in the function body
--     (forbidden / owner_only / the 0029 outstanding gate). Revoking
--     authenticated would take the screens down; it would not draw a
--     finer line between those app roles.
--   * anon keeps execute only on the four pre-login functions:
--     public_factory_name, login_lock_status, log_failed_login,
--     log_login_attempt. clear_login_failures stays authenticated-only.
--   * PUBLIC does not need any of them. login_lock_status was the one
--     still executable by PUBLIC, because 0006 granted anon and
--     authenticated and 0026 left that function's grants unchanged, so
--     the default PUBLIC grant survived. This file revokes PUBLIC and
--     re-grants anon and authenticated.
--   * service_role grants are not touched (0028).
--
-- In-function role checks are not removed.
-- Does not depend on 0030 or 0031. 0035 adds no client RPC.

-- Pre-login four: no PUBLIC, anon + authenticated kept.
revoke all on function public.public_factory_name() from public;
grant execute on function public.public_factory_name() to anon, authenticated;

revoke all on function public.login_lock_status(text) from public;
grant execute on function public.login_lock_status(text) to anon, authenticated;

revoke all on function public.log_failed_login(text, text) from public;
grant execute on function public.log_failed_login(text, text) to anon, authenticated;

revoke all on function public.log_login_attempt(text, boolean, text) from public;
grant execute on function public.log_login_attempt(text, boolean, text) to anon, authenticated;

-- Signed-in only. anon and PUBLIC do not need these. Body gates stay.
revoke all on function public.clear_login_failures() from public, anon;
grant execute on function public.clear_login_failures() to authenticated;

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

revoke all on function public.agent_outstanding(uuid) from public, anon;
grant execute on function public.agent_outstanding(uuid) to authenticated;

revoke all on function public.agent_held_totals() from public, anon;
grant execute on function public.agent_held_totals() to authenticated;

revoke all on function public.agent_detail_stats(uuid) from public, anon;
grant execute on function public.agent_detail_stats(uuid) to authenticated;

revoke all on function public.collections_summary(date, date) from public, anon;
grant execute on function public.collections_summary(date, date) to authenticated;

revoke all on function public.inventory_totals() from public, anon;
grant execute on function public.inventory_totals() to authenticated;

revoke all on function public.report_range(date, date) from public, anon;
grant execute on function public.report_range(date, date) to authenticated;

revoke all on function public.report_months(text, integer, date, date) from public, anon;
grant execute on function public.report_months(text, integer, date, date) to authenticated;

revoke all on function public.report_aging(date) from public, anon;
grant execute on function public.report_aging(date) to authenticated;

revoke all on function public.data_quality_scan() from public, anon;
grant execute on function public.data_quality_scan() to authenticated;

revoke all on function public.my_card_tier() from public, anon;
grant execute on function public.my_card_tier() to authenticated;

revoke all on function public.finalize_closeout(uuid, integer, integer, text) from public, anon;
grant execute on function public.finalize_closeout(uuid, integer, integer, text) to authenticated;

revoke all on function public.hard_delete_agent(uuid) from public, anon;
grant execute on function public.hard_delete_agent(uuid) to authenticated;

revoke all on function public.pay_month(uuid, text) from public, anon;
grant execute on function public.pay_month(uuid, text) to authenticated;

revoke all on function public.admin_create_user(text, text, text, uuid, text) from public, anon;
grant execute on function public.admin_create_user(text, text, text, uuid, text) to authenticated;

revoke all on function public.admin_reset_pin(uuid, text) from public, anon;
grant execute on function public.admin_reset_pin(uuid, text) to authenticated;
