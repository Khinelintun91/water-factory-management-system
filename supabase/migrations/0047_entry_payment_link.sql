-- 0047_entry_payment_link.sql — link an entry-spawned old-debt payment
-- to the entry that spawned it, so deleting the entry deletes the
-- payment with it.
--
-- PROBLEM (live incident, 2026-11-20): saving a delivery entry with a
-- ကြွေးကောက် (old-debt) amount makes EntriesPage insert a SEPARATE
-- agent_payments row (kind 'old_debt', note 'ရေပို့မှတ်တမ်းနှင့်အတူ
-- ပေးချေသည်') with no reference back to the entry. When that entry
-- was later deleted — same day, by its own creator, entirely
-- legitimately — the payment survived as an orphan: it kept counting
-- in the Home received-cash totals (400,000 shown for 200,000 really
-- received) and pushed the agent's agent_outstanding() to -200,000,
-- a phantom ပိုပေးထားငွေ (overpaid) balance for money the factory
-- never received.
--
-- FIX: agent_payments.source_entry_id points at the spawning
-- daily_entries row, ON DELETE CASCADE. EntriesPage sets it on the
-- one insert that spawns such a payment (the online save path in
-- doInsert, which now reads the new entry's id back). Standalone
-- payments — recorded directly on the Payments page, and every
-- pre-0047 row — keep source_entry_id NULL and are never cascaded.
--
-- OFFLINE QUEUE: deliberately nothing to link there. The queue
-- (lib/offlineQueue) stores daily_entries payloads ONLY; a
-- ကြွေးကောက် amount never enters it (EntriesPage tells the user to
-- record it separately on the Payments page after reconnecting), so
-- a replayed entry never spawns a payment and there is no payment
-- row to carry a link for.
--
-- BEHAVIOUR NOTES:
--   * The cascade performs a plain row DELETE on agent_payments, so
--     the payments_audit trigger (0003) writes its usual before-image
--     to audit_log for the cascaded row with the deleting user as
--     actor — the SPEC rule-5 trail covers BOTH rows of the pair
--     (asserted in tests/sql/20_entry_payment_link.sql).
--   * The payments same-day guard and month-lock BEFORE DELETE
--     triggers fire on the cascaded delete too. Entry and payment
--     are created in the same save (same created_at day; the payment
--     carries the entry's date), so any entry delete those guards
--     allow also passes for its payment — the pair still moves
--     together, and a locked month still blocks both.
--   * Rule A (0045) is unaffected: a referential cascade is not a
--     policy-checked delete, so it fires for whoever legitimately
--     deletes the entry (its creator, or owner/manager/co_owner).
--   * Editing an entry does NOT touch its payment (no ON UPDATE
--     action, and the app edit path never writes payments) —
--     unchanged behaviour.

alter table agent_payments
  add column if not exists source_entry_id uuid
  constraint agent_payments_source_entry_fkey
    references daily_entries (id) on delete cascade;

-- FK columns carry an index elsewhere in this schema (0001, 0006,
-- 0009): the cascade's child-row lookup uses it on every entry delete.
create index if not exists payments_source_entry_idx
  on agent_payments (source_entry_id);
