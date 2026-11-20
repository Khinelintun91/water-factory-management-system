-- 0046_staff_own_visibility.sql — a staff member sees ONLY their own
-- records (owner decision 2026-11-20, variant 2: own-created rows plus
-- rows where they are the named receiver).
--
-- PROBLEM (owner's report, verified in code): migration 0045 (Rule A)
-- stopped a staff member from EDITING another staff member's records,
-- but the SELECT policies from 0002 still let every staff account READ
-- every other staff member's entries and payments — the lists showed
-- everyone's records to everyone, so one staff member's record still
-- sat in another staff member's account looking like their own.
--
-- BEFORE (both from 0002; no later migration replaced them):
--   entries_select   using (is_staff_plus() or agent_id = app_agent_id())
--   payments_select  using (is_staff_plus() or agent_id = app_agent_id())
--
-- AFTER (same expression on both tables):
--   is_owner_manager()
--   or (has_role('staff')
--       and (created_by = auth.uid() or received_by = auth.uid()))
--   or agent_id = app_agent_id()
--   * Owner / manager / co_owner (is_owner_manager(), the 0006 helper;
--     co_owner counts as manager) keep reading ALL rows, unchanged.
--   * A non-OM staff user reads only rows they created OR rows where
--     they are the receiver (received_by, 0041). The receiver branch
--     is the owner's chosen variant: the receiver is accountable for
--     the cash (the 0041 rule), so a record naming them must be
--     visible to them; the typist who created it sees it too.
--     created_by is stamped by force_insert_attribution (0005) on
--     every insert, and received_by was backfilled = created_by in
--     0041, so every production row carries both attributions. A row
--     with created_by NULL (only possible from before 0005) falls to
--     OM-only visibility.
--   * The agent branch `agent_id = app_agent_id()` is preserved
--     VERBATIM from 0002. A pure agent satisfies neither the OM nor
--     the staff branch, so an agent's visible set is exactly what it
--     was: their own agent's rows, nothing else (proven in
--     tests/sql/19_staff_own_visibility.sql against the fixture).
--   * A multi-role staff+agent user gets the union of the staff
--     branch (own created/received rows) and the agent branch (their
--     agent's rows) — the same composition the old OR produced,
--     minus the staff-read-all this migration removes.
--
-- UNCHANGED, deliberately:
--   * INSERT / UPDATE / DELETE policies (0045 Rule A stands as-is).
--   * expenses: SELECT stays is_owner_manager() — staff never read
--     expenses; nothing to scope.
--   * Every SECURITY DEFINER RPC (agent_outstanding,
--     collections_summary, agent_held_totals, report_*, agent
--     detail stats, my_card_tier, data_quality_scan): they bypass
--     RLS and keep returning factory-wide figures to their existing
--     callers. Pages that mix direct reads with RPC figures can
--     therefore show a staff user an RPC total that is wider than
--     their (now own-only) row list — inventoried in the PR body
--     and flagged for the owner, NOT changed here.
--   * The same-day guard and month-lock triggers: they govern
--     writes, not reads, and still bind every role.

drop policy entries_select on daily_entries;
create policy entries_select on daily_entries for select to authenticated
  using (
    is_owner_manager()
    or (has_role('staff')
        and (created_by = auth.uid() or received_by = auth.uid()))
    or agent_id = app_agent_id()
  );

drop policy payments_select on agent_payments;
create policy payments_select on agent_payments for select to authenticated
  using (
    is_owner_manager()
    or (has_role('staff')
        and (created_by = auth.uid() or received_by = auth.uid()))
    or agent_id = app_agent_id()
  );
