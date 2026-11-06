-- 0027_guard_symmetry.sql — Same-day / insert-date guards reach the
-- Phase A/B money tables (P0 audit Item 3, 2026-11-06; owner decision:
-- EXTEND the guards, do not document an exception).
--
-- BASIS — SPEC rule 4: a record may be edited or deleted ONLY on the
-- same Asia/Yangon calendar day it was created, for EVERY role, Owner
-- included, enforced by trigger. 0003 enforced that on daily_entries,
-- agent_payments, expenses and inventory_movements only. The tables
-- added later — agent_deposits + write_offs (0006), advances + bonuses +
-- cash_handovers (0009) — received month-lock triggers but NO same-day
-- guard, and (except deposits, fixed in 0019) no insert-date guard. So
-- until now a write-off (which directly reduces an agent's debt), a
-- deposit, an advance, a bonus or a handover could be edited or deleted
-- on any later day in an unlocked month, and write-offs / advances /
-- handovers could be INSERTED backdated by any owner/manager — silently
-- rewriting balances that reports had already shown. This migration
-- reuses the EXISTING guard functions unchanged:
--   guard_same_day_edit()  — current definition is 0008 (created_at based;
--                            includes the agent hard-delete cascade pass)
--   guard_insert_today()   — current definition is 0018 (business-date
--                            based; primary-Owner backdate exception built
--                            in; month lock still binds the Owner)
--
-- INCLUSION MATRIX (columns checked against 0006 / 0009)
--   table           same-day  insert-today          why
--   --------------  --------  --------------------  ------------------------------
--   agent_deposits  ADD       already in 0019       deposit_date is a real
--                                                   transaction date
--   write_offs      ADD       ADD 'writeoff_date'   same; every app insert
--                                                   (Closeout/AgentDetail/
--                                                   Reports) omits the date,
--                                                   so the today default applies
--   advances        ADD       ADD 'advance_date'    real date, defaults to
--                                                   today in the UI picker
--                                                   (PayrollPage advDate)
--   bonuses         ADD       EXCLUDED              no date column at all: the
--                                                   `month` text ('YYYY-MM') is
--                                                   a TARGET payroll month the
--                                                   UI freely selects (past
--                                                   months included — paying
--                                                   last month's salary early
--                                                   this month is the normal
--                                                   flow), so a date guard is
--                                                   incoherent here; controls
--                                                   stay guard_month_lock_text
--                                                   (0009) + pay_month's
--                                                   already-paid check
--   cash_handovers  ADD       ADD 'handover_date'   real date, defaults today
--   (not in scope)  —         —                     salary_settings is in-place
--                                                   configuration (editable-
--                                                   until-paid by design), and
--                                                   payroll_runs / advance_
--                                                   repayments / agent_
--                                                   settlements are already
--                                                   immutable RPC-only /
--                                                   no-update-policy tables
--
-- CLOSE-OUT / PAYROLL INTERACTION ANALYSIS (checked line by line)
--   (a) finalize_closeout (0006 — its only definition) writes exactly
--       three things: INSERT agent_settlements (NOT guarded here;
--       settle_date is set to today anyway), a conditional INSERT into
--       expenses (already insert-guarded since 0004, dated today, so it
--       passes), and UPDATE agents.closed_at (agents has no same-day
--       guard). It performs NO insert/update/delete on ANY table this
--       migration touches — in particular it never writes write_offs;
--       it only requires agent_outstanding() <= 0 first. UNAFFECTED.
--   (b) The write-off that clears a receivable before finalize is a
--       SEPARATE client insert (CloseoutPage.onAddWriteOff; also
--       AgentDetailPage and ReportsPage) whose payload carries no
--       writeoff_date, so the column default (today, Yangon) applies
--       and the new insert guard passes for every role. The same-day
--       guard never fires on INSERT at all. UNAFFECTED.
--   (c) hard_delete_agent (0008 version) deletes the agents row; the
--       ON DELETE SET NULL foreign keys then fire BEFORE UPDATE
--       triggers on agent_deposits / write_offs rows — including the
--       two same-day triggers added here. That is safe BY DESIGN:
--       guard_same_day_edit's current (0008) definition passes an
--       UPDATE whose only change is agent_id -> null before it ever
--       looks at created_at — the exact cascade shape. This is the
--       same mechanism that already lets hard-delete detach old
--       daily_entries / agent_payments rows today. advances, bonuses
--       and cash_handovers reference profiles, not agents, so agent
--       deletion never touches them. UNAFFECTED.
--   (d) pay_month (0009) INSERTs payroll_runs + advance_repayments and
--       only SELECTs advances / bonuses — no trigger added here fires.
--       UNAFFECTED. (Its deduction reads span past months by design;
--       nothing in this migration restricts reads.)
--   (e) Cash-handover save is an UPSERT on (handover_date, employee_id)
--       (HandoverPage.onSave) for the viewed date, which defaults to
--       today. New-row path = INSERT: the insert guard requires the
--       viewed date to be today for staff/manager; the Owner keeps the
--       0018 backfill exception for a missed day. Existing-row path =
--       UPDATE: insert guards do not fire on UPDATE; the new same-day
--       guard keys on created_at, so a row created today can be
--       re-saved all day, and no row can be rewritten on a later day —
--       identical to entries/payments behaviour since 0003.
--
-- KNOWN BEHAVIOUR CHANGES (intended — SPEC rule 4 applied uniformly;
-- the edit/delete guard has NO owner exception, by 0003 design):
--   * PayrollPage's delete buttons for advances / bonuses created
--     before today will now raise 'same_day_only' (already surfaced via
--     the page's onError) instead of succeeding in an unlocked month.
--   * The advances date picker becomes effectively today-only for
--     staff/manager; past dates are owner-only (mirrors deposits, 0019).
--   * A handover for a past date can only be newly created by the Owner.
--   * Correction path after the creation day is the same as it has
--     always been for entries: no edit/delete — use a compensating
--     record where the domain has one, or an owner backdated INSERT of
--     a new record (insert path keeps the 0018 exception).
--
-- ROLLBACK (comment only): dropping these eight triggers fully undoes
-- this migration; the guard functions are shared with 0003/0004/0018/
-- 0019 and must NOT be dropped.
--   drop trigger deposits_same_day   on agent_deposits;
--   drop trigger writeoffs_same_day  on write_offs;
--   drop trigger advances_same_day   on advances;
--   drop trigger bonuses_same_day    on bonuses;
--   drop trigger handovers_same_day  on cash_handovers;
--   drop trigger writeoffs_insert_today on write_offs;
--   drop trigger advances_insert_today  on advances;
--   drop trigger handovers_insert_today on cash_handovers;

-- ---------------------------------------------------------------------------
-- Same-day edit/delete (SPEC rule 4) — UPDATE and DELETE, all roles.
-- guard_same_day_edit() is created_at-based and needs no argument.
-- ---------------------------------------------------------------------------
create trigger deposits_same_day before update or delete on agent_deposits
  for each row execute function guard_same_day_edit();
create trigger writeoffs_same_day before update or delete on write_offs
  for each row execute function guard_same_day_edit();
create trigger advances_same_day before update or delete on advances
  for each row execute function guard_same_day_edit();
create trigger bonuses_same_day before update or delete on bonuses
  for each row execute function guard_same_day_edit();
create trigger handovers_same_day before update or delete on cash_handovers
  for each row execute function guard_same_day_edit();

-- ---------------------------------------------------------------------------
-- Insert-date guard — business date must be today (Asia/Yangon) for
-- everyone except the primary Owner (0018 exception, built into the
-- function). agent_deposits was already covered in 0019; bonuses are
-- deliberately excluded (see the header matrix).
-- ---------------------------------------------------------------------------
create trigger writeoffs_insert_today before insert on write_offs
  for each row execute function guard_insert_today('writeoff_date');
create trigger advances_insert_today before insert on advances
  for each row execute function guard_insert_today('advance_date');
create trigger handovers_insert_today before insert on cash_handovers
  for each row execute function guard_insert_today('handover_date');
