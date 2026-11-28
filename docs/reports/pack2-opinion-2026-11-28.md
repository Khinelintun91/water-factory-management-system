# Independent Design Opinion — Proposed "Pack 2" Plan (Migration 0052)

- **Date:** 2026-11-28
- **Repo / Base:** `Khinelintun91/water-factory-management-system` @ `main` (`d6102de`, migrations `0001`–`0051`)
- **Branch:** `docs/pack2-opinion-2026-11-28`
- **Reference Audit:** `docs/reports/staff-account-review-2026-11-28.md` (`docs/staff-review-2026-11-28` @ `ca30d6f`)
- **Mode:** READ-ONLY opinion — no code, migration, or test changes made.

---

## Q1 — SCOPE

**Assessment:** Grouping **M5 + D3 + D4 + L2** into one security/access-boundary migration (`0052`) is conceptually coherent — every item tightens identity, role, or visibility boundaries in Postgres (plus small targeted UI hooks for `AuthContext` and `HandoverPage`). However, three small, exact-same-class DB items from the original review are currently left stranded if excluded here, while one sub-item (`D4(c)`) should be decoupled so it does not stall the migration:

1. **Move IN `D5` (`expense_categories` `categories_select`):**
   - `supabase/migrations/0002_rls.sql` still sets `categories_select` to `is_staff_plus()` even though `expenses` and `/expenses` are OM-only. Pack 2 is already editing `expenses` RLS (`L2`: `expenses_update` / `expenses_delete`); changing `categories_select` to `is_owner_manager()` is a 3-line policy fix with zero UI impact and closes the last `expenses`-area leak in the same file.
2. **Move IN `M9` (`entries_before_write()` `active = false` + `not is_owner_manager()` credit-limit fix):**
   - In `supabase/migrations/0051_staff_hole_fixes.sql:185-210`, `entries_before_write()` still checks `v_agent.closed_at is not null` only (not `v_agent.active`), AND line 206 still checks `if app_role() = 'staff' and v_agent.credit_limit > 0` (primary role only, unlike `payments_before_write` / `payments_before_delete` in `0051:287,325` which use `not is_owner_manager()`). A dual-role `agent` (primary) + `staff` (extra in `user_roles`) user therefore skips `credit_limit` on deliveries. Because Pack 2 already touches `daily_entries` triggers for M5, folding in M9 (~6 lines) avoids leaving a proven `money loss` hole unscheduled across Pack 2, Package B, and Package C.
3. **Consider moving IN `L1` (`notifications` `noti_update` / `noti_delete` lock):**
   - D4(b) is already rewriting `noti_select`, `noti_update`, and `noti_delete` (`0011_phase_c_notifications.sql:47-52`). `src/components/NotificationBell.tsx:165-184` only ever updates `read_at` and **never deletes notifications**. Dropping `noti_delete` and adding a small `BEFORE UPDATE` trigger restricting client updates on `notifications` to `read_at` only takes ~10 lines and closes notification tampering in the exact same migration touch.
4. **Keep M7 and M8 OUT of Pack 2 (stay in Package B):**
   - M7 (atomic entry+payment creation RPC + offline-queue stale-drop recovery) and M8 (real-time OM edit/delete alerts + overpayment sanity checks) are transactional workflow and notification-pipeline changes, not pure RLS/access-boundary fixes. Keeping them together in Package B is cleaner and avoids bloating `0052`.
5. **Decouple `D4(c)` (`auth.users` ban RPC) unless live schema/permissions are verified first:**
   - Do not hold up `0052` (M5 + D3 + D4(a)/(b) + L2 + D5 + M9) waiting on `auth.users` / `auth.sessions` live verification (see Q5).

**Verdict: AGREE WITH CHANGES**

---

## Q2 — ORDER

**Assessment:** Pack 2 before **Package C** (form hardening + minors) is clearly right: DB-enforced access boundaries outrank UI polish.

Pack 2 before **Package B** (unified receipt + edit/delete notifications + M7 + M8) is acceptable **only on one condition**: that Pack 2 stays small and ships quickly (one tight PR), without getting bogged down in `D4(c)` (`auth.users` ban mechanics).

Here is the honest operational counterpoint to consider:
- Pack 1 (`0051`) already closed every catastrophic direct-API money-manipulation hole (M1, M2, M3, M4, M6).
- What remains in Pack 2 (M5 `received_by` spoofing, D3 `staff_directory` roster leak, D4 deactivated-user lingering reads on `app_settings`/`month_locks`/`damage_items`, L2 unreachable `expenses` policy) is mostly **insider-misuse hardening and hygiene**.
- Meanwhile, under the owner's standing principle (*"humans make mistakes"* — prompted by the real U Aye Myint incident), **M8** (zero immediate OM alert on same-day edits/deletes, especially the 19:00–23:59 Yangon blind window after `send_daily_digest()` runs) and **M7** (silent next-day deletion of offline-queued entries in `EntriesPage.tsx:271-275` + non-atomic entry/payment split in `EntriesPage.tsx:446-522`) are **everyday human-error failure modes** that can lose money without any malicious API call.
- Because Pack 2 is compact and touches clean, isolated DB guards (and M5's `received_by` validation is a nice foundation before Package B builds unified receipts that name the receiver!), running **slim Pack 2 (without blocking on `auth.users` ban) → Package B → Package C** is the best sequence. If Pack 2 were to grow or stall on `D4(c)`, Package B should jump ahead of it.

**Verdict: AGREE WITH CHANGES**

---

## Q3 — M5 DESIGN

### 1. Table trigger vs. write RPCs only
**Strongly agree with a table trigger on `daily_entries` and `agent_payments`.**
- Today, only `daily_entries` edits go through an RPC (`edit_daily_entry()`). Direct `INSERT` on `daily_entries` (`src/pages/EntriesPage.tsx:264, 395, 447`), direct `INSERT` on `agent_payments` (`src/pages/EntriesPage.tsx:500`, `src/pages/PaymentsPage.tsx:315`, `src/pages/CloseoutPage.tsx:246`), and direct `UPDATE` on `agent_payments` (`src/pages/PaymentsPage.tsx:379`) all hit PostgREST table endpoints directly.
- Per `SPEC.md`, enforcing `received_by` only inside RPCs would leave direct table inserts/updates wide open.
- Putting a shared `BEFORE INSERT OR UPDATE` trigger function (`guard_received_by()`) on both `daily_entries` and `agent_payments` automatically protects direct `INSERT`, direct `UPDATE`, offline-queue replay, AND `edit_daily_entry()` in one place. Inside `edit_daily_entry()` (`0049_bottle_only_collection.sql:228-231`), the weaker `exists (select 1 from profiles where id = v_receiver)` check should be aligned with the same rule (or deferred to the table trigger) so the error code is identical everywhere.
- **Role check detail:** Must check BOTH `profiles.role` AND `user_roles.role` (matching `0041_received_by.sql`'s `staff_directory()` query: `roles.r in ('owner', 'manager', 'co_owner', 'staff')` AND `p.active = true`), so multi-role accounts behave identically in dropdown and DB trigger.

### 2. NOT banning the Owner as `received_by` + which surface to use
**Agree with NOT banning Owner as `received_by`.** The Owner legitimately collects cash at the factory (`0041_received_by.sql` intentionally includes `'owner'` in `staff_directory()`).

**Which surface: BOTH — and `HandoverPage` is the one actually missing today:**
- **Daily digest (`0050_same_day_detection.sql:96-125`):** `v_rec_line` (`လက်ခံသူအလိုက်: ...`) **already** aggregates `coalesce(received_by, created_by)` across **all** profiles (no role filter), so Owner-named totals are already shown in the 19:00 Yangon digest! (Only `v_mismatch_line` at lines 191–202 excludes `owner`, which makes sense because the Owner does not hand cash over to themselves.)
- **`HandoverPage` (`src/pages/HandoverPage.tsx:50, 90, 102, 127-138`):** This is the real blind spot. `HandoverPage` computes `expected` for every `holder` (lines 127–138), then renders cards ONLY for active profiles in `STAFF_ROLES = ['staff', 'manager', 'co_owner']` (lines 50, 90, 102). Any cash attributed to an `owner` — or to a staff member deactivated earlier the same day — is **completely invisible on `HandoverPage`**, even during blind handover reconciliation!
- **Recommended design:**
  1. Add a read-only **"Direct / Other Receivers Today"** summary block on `HandoverPage` displaying every `holder_id` with `expected > 0` who is NOT in the active `STAFF_ROLES` list (i.e., Owner-received cash, plus any staff deactivated that day), without turning it into a self-handover input form (and without spoiling the blind count for uncounted staff cards — keep it visually separate from the blind-count staff totals).
  2. Keep `send_daily_digest()`'s existing `v_rec_line` as the 19:00 safety net.
  3. **Extra anti-spoofing detail (tiny, high value):** In `notify_on_entry()` (`0049`) / `notify_on_payment()` (`0044`) — or in Package B's notifications — when `new.received_by is distinct from new.created_by`, explicitly show **both** typist and receiver (e.g., `မှတ်တမ်းတင်သူ X · လက်ခံသူ Y`). Right now, if Staff A names Owner (or Staff B) as `received_by`, OM's notice only prints `လက်ခံသူ: Owner` without revealing that Staff A typed it.

**Verdict: AGREE WITH CHANGES**

---

## Q4 — NULL `received_by`

**Yes — `NULL` IS a legitimate value in multiple live code paths and existing SQL tests, and a NOT-NULL validation WOULD BREAK them:**

1. **`src/pages/CloseoutPage.tsx:246-251` (`onAddPayment`):**
   ```ts
   const { error } = await supabase.from('agent_payments').insert({
     agent_id: id,
     payment_date: payDate,
     amount: Number(payAmount) || 0,
     notes: payNote.trim() || null,
   })
   ```
   `received_by` is **completely omitted** (`NULL`) when OM records a closeout-settlement payment. A NOT-NULL trigger would break closeout payments immediately.
2. **`src/lib/offlineQueue.ts:23-27`:**
   Explicitly documents `received_by?: string | null` so older payloads queued in `localStorage` without `received_by` still flush with `NULL` and fall back to `created_by`.
3. **Existing SQL test suite:**
   - `tests/sql/12_received_by.sql:4, 62-64, 108-109, 132-134` explicitly allows `received_by IS NULL` and tests that it falls back to `created_by`.
   - `tests/sql/17_om_notify_receiver_name.sql:8, 43-59, 117-134` explicitly inserts rows with `received_by NULL` and asserts the OM notification falls back to `created_by`.
   - `tests/sql/18`, `19`, `20`, `21`, `22`, `24` all omit `received_by` on multiple inserts.
4. **Zero security downside to allowing `NULL`:**
   Every reader and aggregator in the codebase already derives the accountable holder as `coalesce(received_by, created_by)`:
   - `src/pages/HandoverPage.tsx:129, 134` (`e.received_by ?? e.created_by`)
   - `supabase/migrations/0050_same_day_detection.sql:100, 106, 148, 154`
   - `supabase/migrations/0044_om_notify_receiver_name.sql` & `0049_bottle_only_collection.sql` (`notify_on_entry`, `notify_on_payment`, `edit_daily_entry:227`)
   - `src/lib/staffDirectory.ts:55`
   - `supabase/migrations/0046_staff_own_visibility.sql` (`created_by = auth.uid() or received_by = auth.uid()`)
   Because `force_insert_attribution()` (`0005`/`0037`) stamps `created_by := auth.uid()` on every `INSERT` and `0045` locks `created_by` on `UPDATE`, leaving `received_by = NULL` attributes 100% of the cash to the authenticated creator — it **cannot** be used to dodge handover or hide cash.

**Design rule for `0052`:** Validate `received_by` **only when `new.received_by is not null`** (and on `UPDATE`, only when `new.received_by is distinct from old.received_by`). Keep `NULL` allowed.

**Verdict: AGREE WITH CHANGES** (explicitly allow `NULL`; do NOT enforce NOT NULL)

---

## Q5 — D4 APPROACH

### 1. Is UI sign-out + RLS active-profile checks the right enforcement?
**Yes — DB RLS active-profile checks are the ONLY immediate cutoff.**
- Supabase access tokens (JWTs) are stateless and verified locally by PostgREST until `exp` (typically 1 hour on hosted Supabase; exact live TTL is **UNVERIFIED** from code). Even if GoTrue bans a user, an already-issued JWT keeps working against PostgREST until it expires!
- Therefore, **D4(b) (RLS `active` checks)** is what stops a deactivated user's existing JWT on the very next millisecond, and **D4(a) (`AuthContext.loadProfile()` sign-out)** closes the UI bug where `src/context/AuthContext.tsx:103-146` restores an existing session without checking `outcome.profile.active` (unlike `signIn()` at line 185).
- **Table-by-table caller verification for D4(b):**
  - `app_settings` (`settings_select`, `0002`): Pre-login `LoginPage.tsx:23` uses `public_factory_name()` RPC (`SECURITY DEFINER`), NOT `app_settings`. Post-login callers (`App.tsx:41`, `HomePage.tsx:354`, `AgentsPage.tsx:91`, `SettingsPage.tsx:128`, `backup.ts:118`) are all active authenticated users. Safe to tighten to `exists (select 1 from profiles where id = auth.uid() and active)`.
  - `month_locks` (`locks_select`, `0002`): Only queried by OM (`HomePage.tsx:127`, `ReportsPage.tsx:221`). Safe to tighten to active authenticated users (or `is_owner_manager()`).
  - `damage_items` (`damage_items_select`, `0042`): Queried by OM (`DamageItemsPage.tsx:41`, `AgentDetailPage.tsx:175`) and active agents (`HomePage.tsx:673`). Safe to tighten to `is_owner_manager() or (active and exists (select 1 from profiles where id = auth.uid() and active))`.
  - `notifications`, `notify_prefs`, `push_tokens`: Only used by active signed-in users (`NotificationBell.tsx`, `SettingsPage.tsx`). Safe to add `and exists (select 1 from profiles where id = auth.uid() and active)` to all policies.
  - **CRITICAL EXCEPTION — DO NOT gate `profiles_select` on `active = true`:** `AuthContext.tsx:61-68, 178-189` signs in via GoTrue first, then reads the caller's own `profiles` row to check `outcome.profile.active` and display `"ဒီအကောင့် ပိတ်ထားပါတယ်"`. Keeping `profiles_select` (`is_owner_manager() or id = auth.uid()`) allows that check to work cleanly.

### 2. Is an `auth.users` ban RPC feasible without `service_role`?
**Yes in principle, using the repo's existing pattern — with live-DB verification required first:**
- `0030_co_owner_create_user.sql` (`admin_create_user`, `admin_reset_pin`) already writes directly to `auth.users` inside `SECURITY DEFINER` functions with `set search_path = public, auth, extensions` and **no `service_role`**.
- `0035_owner_only_pin_reset.sql:66-68` triggers fire `before/after update of encrypted_password on auth.users` only, so updating `auth.users.banned_until` will **not** collide with `0035`.
- **Three important caveats (all `UNVERIFIED` against live DB):**
  1. **Never use `'infinity'::timestamptz` for `banned_until`:** Supabase GoTrue scans `banned_until` into Go `time.Time`, which fails on PostgreSQL `'infinity'`. Use a finite far-future timestamp (e.g., `timestamptz '2999-12-31 00:00:00+00'`) when deactivating, and `NULL` when reactivating.
  2. **Live permissions on `auth.users.banned_until` and `auth.sessions` are `UNVERIFIED`:** While `postgres` updates `auth.users.encrypted_password` in `0030`, whether live `postgres` can `DELETE FROM auth.sessions` (to kill refresh tokens immediately) and whether `banned_until` matches the live GoTrue version must be checked against the live DB first. Also `tests/scaffold.sql:22-37` does not currently include `banned_until` or `auth.sessions`.
  3. **Wiring to UI:** `src/pages/UsersPage.tsx:149` currently toggles active via `supabase.from('profiles').update({ active: !p.active })`. Either `UsersPage.tsx` must switch to the new RPC, **or** (even cleaner — zero UI bypass!) an `AFTER UPDATE OF active ON public.profiles` `SECURITY DEFINER` trigger can sync `auth.users.banned_until` automatically whenever the Owner updates `profiles.active`.

### 3. Residual risk either way
- **With D4(a) + D4(b) only (no `auth.users` ban):** All business tables, RPCs, `app_settings`, `month_locks`, `damage_items`, `notifications`, `notify_prefs`, `push_tokens`, and `staff_directory()` are immediately blocked in Postgres. The residual risk is narrow: a deactivated user who still knows their old PIN can mint fresh GoTrue JWTs via raw HTTP and read their own `profiles` / `user_roles` row, call `clear_login_failures()`, and call anon-accessible login RPCs (`public_factory_name`, `login_lock_status`, `log_failed_login`).
- **With D4(c) (`banned_until` + `auth.sessions` delete) added:** Blocks re-login and token refresh too; residual risk shrinks to (a) any already-minted JWT until its ~1-hour `exp` (already neutralized by D4(b) RLS checks) and (b) anon-callable login RPCs (same as any unauthenticated internet user).

**Verdict: AGREE WITH CHANGES** (ship D4(a)+(b) in Pack 2 now; verify live `auth.users`/`auth.sessions` permissions before shipping D4(c) via `profiles` trigger or owner RPC with finite `banned_until`, and never gate `profiles_select` on `active`)

---

## Q6 — RISKS & SEVERITY REASSESSMENT

### Unmentioned Regressions & Edge Cases

1. **`tests/sql/12_received_by.sql:155-166` WILL BREAK under D3:**
   - `12_received_by.sql` sets JWT to `agentA` (`4444…`) and asserts `(select count(*) from staff_directory()) = 5` (all 5 non-agent fixture users, even though Agent A's fixture entries have `created_by = NULL, received_by = NULL`).
   - Scoping `staff_directory()` for agents will immediately fail `12_received_by.sql` unless that test is updated intentionally in the same PR.
   - **Subtle query trap inside D3:** When scoping `staff_directory()` for agent callers, you MUST match `coalesce(received_by, created_by)` across **both** `daily_entries` AND `agent_payments` for `agent_id = app_agent_id()` — **NOT** `received_by` alone! Otherwise, any historical or `CloseoutPage` row where `received_by IS NULL` and `created_by` is set will lose its receiver name on `HomePage.tsx:723`, `MyPage.tsx:480,557`, `EntriesPage.tsx:1352`, and `PaymentsPage.tsx:793`.
2. **Deactivated-today receiver breaks `edit_daily_entry()` payment rewrite (`0049:299-325`):**
   - `EntriesPage.tsx:760-772` and `PaymentsPage.tsx:526-536` explicitly keep a deactivated receiver in the edit dropdown so a same-day row recorded for Staff B (who is deactivated later that afternoon) can still have its quantity or notes corrected.
   - Even if the M5 `UPDATE` trigger uses `tg_op = 'INSERT' or new.received_by is distinct from old.received_by`, when `edit_daily_entry()` rewrites linked payments (`v_need_rewrite = true` at `0049:299-325`), it runs `DELETE` + **`INSERT`** on `agent_payments` with `v_receiver = Staff B (inactive)`! That `INSERT` WILL fail the M5 `INSERT` trigger unless either (a) `edit_daily_entry()` requires selecting an active receiver whenever cash changes, or (b) the trigger detects `edit_daily_entry()` preserving an unchanged `v_entry.received_by`.
3. **Concurrent `signIn()` vs `onAuthStateChange` flicker on deactivated user (`AuthContext.tsx:135-144, 178-189` + `App.tsx:132-183`):**
   - During `signIn()` for a deactivated user, `signInWithPassword` fires `onAuthStateChange('SIGNED_IN', s)` -> `loadProfile()` concurrently with `signIn()`'s own check. When `session` briefly becomes non-null, `App.tsx:132-183` unmounts `<LoginPage>` to show `<LoadingState>`, then remounts a fresh `<LoginPage>` after `signOut()` — which can drop the local `error` state (`"ဒီအကောင့် ပိတ်ထားပါတယ်"`) if `loadProfile()` signs out before `signIn()` finishes! Test deactivated sign-in AND deactivated session-restore in browser/unit tests when implementing D4(a).
4. **Dual-role `agent + staff` user calling `staff_directory()`:**
   - Under D3, make sure the `staff_directory()` agent-narrowing branch applies ONLY when `not is_staff_plus()` (i.e., pure agents), NOT whenever `app_agent_id() is not null`, otherwise a dual-role `staff + agent` user would lose their full receiver dropdown on `EntriesPage` / `PaymentsPage`.
5. **`HandoverPage` blind-count interaction if Owner summary is added (M5):**
   - `src/lib/handoverCount.ts` (`summarizeHandoverTotals`) powers the top 3 summary cards (`မျှော်မှန်း စုစုပေါင်း`, `လက်ခံ စုစုပေါင်း`, `ကွာခြားချက်`). Owner-received cash must be displayed in a **separate** read-only card/section so it does not mix into the blind-count `diff` calculation for employees.
6. **`tests/sql/10_api_gap_fixes.sql` grant assertions:**
   - Verify any replaced function (`staff_directory()`, `edit_daily_entry()`) preserves exact `REVOKE ALL ... FROM PUBLIC, anon; GRANT EXECUTE ... TO authenticated;` and any new trigger function pins `set search_path = public` and revokes from `public, anon, authenticated`.

### Severity Reassessment of Original Review Findings
- **Rate HIGHER operationally (human-error priority):** **M8** (no immediate OM notification on same-day edit/delete, 19:00–23:59 blind spot) and **M7** (silent next-day drop of offline-queued entries + non-atomic split). Both trigger from ordinary human/network errors without any malicious API access.
- **Keep as rated:** **M5** (`money loss`), **D3/D4/D5** (`data leak`), **M9** (`money loss`).
- **Rate LOWER in practical urgency:** **L2** (`expenses_update`/`expenses_delete` latent clause) is completely unreachable today because `expenses_select` is OM-only — still worth cleaning up in `0052` since it takes 4 lines, just not an active exploit.

**Verdict: AGREE WITH CHANGES**

---

## Q7 — GAPS

**No — there ARE explicit holes from the original review that NEITHER Pack 1 (`0051`), the proposed Pack 2 (`0052`), NOR Packages B/C (as described) would close:**

| Finding | Severity | Status | Why It Falls Through the Cracks |
| --- | --- | --- | --- |
| **M9** — `daily_entries` allows inserts for `agents.active = false` via direct API, AND dual-role `agent + staff` skips `credit_limit` (`0051:185-210` uses `app_role() = 'staff'` instead of `not is_owner_manager()`, inconsistent with `payments_before_write`/`payments_before_delete`) | `money loss` | `PROVEN FROM CODE` | Omitted from Pack 1 (`0051`) and Pack 2 (`0052`); Package B (receipts/notifications) and Package C (UI form hardening) do not mention `entries_before_write()`. **Best fix: pull into Pack 2 (`0052`).** |
| **D5** — `expense_categories` `categories_select` (`0002_rls.sql`) still uses `is_staff_plus()` instead of `is_owner_manager()` | `data leak` | `PROVEN FROM CODE` | Omitted from Pack 1, Pack 2 (which fixes `expenses` `L2` right beside it!), and Packages B/C. **Best fix: pull into Pack 2 (`0052`).** |
| **L1** — `notifications` `noti_update` allows modifying any column (`title`/`body`/`link`) and `noti_delete` allows erasing own notifications without audit trail; `notify_prefs` & `push_tokens` unaudited; `log_failed_login` (`0036`) allows 15-min Owner lockout DoS | `minor` | `PROVEN FROM CODE` | D4(b) adds `active` checks to `noti_*`, `prefs_*`, `tokens_*`, but does not drop `noti_delete` or restrict `noti_update` to `read_at`. **Best fix: lock `noti_update`/`noti_delete` inside Pack 2 (`0052`) while already touching `noti_*` policies.** |
| **L4 & L5 (DB layer)** — `change_reason` is not DB-enforced on direct `UPDATE` (`agent_payments`) or direct `DELETE` (`daily_entries` / `agent_payments`), and `agent_payments.method` has no DB `CHECK` constraint (`0001_schema.sql`) | `minor` | `PROVEN FROM CODE` | Package C ("form hardening + minors") may be UI-only unless DB constraints are explicitly included in Package C's scope. |
| **L6** — `0035_owner_only_pin_reset.sql` live GoTrue DB-role vs `admin_reset_pin` owner split | `minor` (high if broken live) | `UNVERIFIED` (`NEEDS LIVE-DB CHECK`) | Operational live-DB verification, not a code migration; must be explicitly run on production (SQL query + test-staff `auth.updateUser` check). |
| **M5 residual (coworker framing)** — Staff A picking active Staff B as `received_by` | `money loss` (social/error) | `PROVEN FROM CODE` | Validating `received_by` to active staff/OM still allows Staff A to pick active Staff B by error or malice; mitigated operationally if OM notifications + `HandoverPage` flag rows where `created_by <> received_by`. |

**Verdict: DISAGREE** (there are concrete gaps — most importantly **M9** and **D5** — that should not be left unscheduled; pulling M9, D5, and `notifications` `noti_update`/`noti_delete` hardening into Pack 2 closes all of them cleanly in the same migration)
