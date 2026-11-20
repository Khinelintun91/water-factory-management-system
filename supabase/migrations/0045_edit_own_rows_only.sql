-- 0045_edit_own_rows_only.sql — Rule A: a staff member may edit or
-- delete ONLY the records they created; owner / manager / co_owner may
-- edit or delete anyone's (owner decision 2026-11-20).
--
-- PROBLEM (owner's screenshot, verified in code): the UPDATE/DELETE
-- policies written in 0002 for daily_entries and agent_payments are
-- `is_staff_plus()` alone — ANY staff account could edit or delete ANY
-- other staff member's same-day entry or payment, and the app showed
-- them the ပြင်/ဖျက် buttons for it. One staff member's record was
-- indistinguishable from, and editable by, every other staff member.
--
-- BEFORE (all from 0002; no later migration replaced them):
--   entries_update   using + with check (is_staff_plus())
--   entries_delete   using (is_staff_plus())
--   payments_update  using + with check (is_staff_plus())
--   payments_delete  using (is_staff_plus())
--   expenses_update  using + with check (is_owner_manager())
--   expenses_delete  using (is_owner_manager())
-- Expenses differed in shape: owner/manager ONLY — staff could not
-- read, create, or edit expenses at all. The same expression is
-- applied below for consistency, with one precision: expenses_select
-- deliberately STAYS is_owner_manager() (SPEC: expenses are
-- management data; no read access is widened by this migration), and
-- because an UPDATE must read the row it targets, a staff member
-- still cannot reach even their own expense rows today — the own-row
-- clause is in place, governing immediately if expense visibility is
-- ever widened, and OM behaviour is unchanged meanwhile.
--
-- AFTER (same expression on all three tables):
--   is_staff_plus() and (is_owner_manager() or created_by = auth.uid())
--   * is_owner_manager() is the 0006 helper: has_role('owner') or
--     has_role('manager'), and has_role('manager') is true for
--     co_owner — so owner / manager / co_owner keep full edit rights.
--   * A non-OM staff user passes only on rows whose created_by is
--     their own id. created_by is stamped by force_insert_attribution
--     (0005) on every insert, so it always names the real author.
--   * The WITH CHECK repeats the expression: a staff user editing
--     their own row cannot hand it to someone else by rewriting
--     created_by in the same update.
--   * The is_staff_plus() wrapper keeps AGENT rights exactly as they
--     were: a pure agent satisfies neither branch (agents create no
--     rows on these tables — INSERT stays staff+ / OM only), so
--     agents still cannot update or delete anything here.
--
-- UNCHANGED, deliberately:
--   * SELECT and INSERT policies on all three tables.
--   * The same-day guard and month-lock TRIGGERS (0003/0008/0027):
--     they fire after the policy admits a row and still bind EVERY
--     role, the owner included — Rule A narrows WHO, the triggers
--     still govern WHEN.
--   * SECURITY DEFINER flows (e.g. the 0007 agent-delete cascade)
--     run as the function owner and are unaffected by RLS.

drop policy entries_update on daily_entries;
create policy entries_update on daily_entries for update to authenticated
  using (is_staff_plus() and (is_owner_manager() or created_by = auth.uid()))
  with check (is_staff_plus() and (is_owner_manager() or created_by = auth.uid()));
drop policy entries_delete on daily_entries;
create policy entries_delete on daily_entries for delete to authenticated
  using (is_staff_plus() and (is_owner_manager() or created_by = auth.uid()));

drop policy payments_update on agent_payments;
create policy payments_update on agent_payments for update to authenticated
  using (is_staff_plus() and (is_owner_manager() or created_by = auth.uid()))
  with check (is_staff_plus() and (is_owner_manager() or created_by = auth.uid()));
drop policy payments_delete on agent_payments;
create policy payments_delete on agent_payments for delete to authenticated
  using (is_staff_plus() and (is_owner_manager() or created_by = auth.uid()));

drop policy expenses_update on expenses;
create policy expenses_update on expenses for update to authenticated
  using (is_staff_plus() and (is_owner_manager() or created_by = auth.uid()))
  with check (is_staff_plus() and (is_owner_manager() or created_by = auth.uid()));
drop policy expenses_delete on expenses;
create policy expenses_delete on expenses for delete to authenticated
  using (is_staff_plus() and (is_owner_manager() or created_by = auth.uid()));
