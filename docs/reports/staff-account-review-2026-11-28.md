# Staff Account Security & Weakness Review (Code-Only Audit)

- **Date:** 2026-11-28
- **Repo / Base Commit:** `Khinelintun91/water-factory-management-system` @ `main` (`3252a6d`, migrations `0001`–`0050`)
- **Branch:** `docs/staff-review-2026-11-28`
- **Scope:** READ-ONLY code audit of the `staff` role (no live database access, no code changes, no PR opened).
- **Standing Design Principle:** *"လူဆိုတာ မှားတက်တယ် — လူ့အမှားကို စနစ်က ကာကွယ်ပေးရမယ်"* (humans make mistakes, and a dishonest insider is the extreme case). Per `SPEC.md`, server-side enforcement in Postgres is mandatory; **a UI-only restriction is a bug, not a rule**.

---

## Executive Summary

| Severity | Count | PROVEN FROM CODE | NEEDS LIVE-DB CHECK |
| --- | ---: | ---: | ---: |
| **money loss** | **9** | 9 | 0 |
| **data leak** | **5** | 5 | 0 |
| **minor** | **6** | 5 | 1 |
| **Total** | **20** | **19** | **1** |

### Verification of Context Claims Against Actual Code

| Claim in Review Brief | Code Verdict | Citation |
| --- | --- | --- |
| "Staff record daily entries, payments and **handovers**" | **FALSE for handovers.** Staff **cannot view or record `cash_handovers`** in either UI or DB. `/handover` is `<Guard roles={['owner', 'manager']}>`, and all four `cash_handovers` policies (`handover_select/write/update/delete`) require `is_owner_manager()`. Staff only influence the `expected` handover figure indirectly via `received_by` on `daily_entries` and `agent_payments`. | `src/App.tsx:351-357`, `0009_phase_b_payroll_handover.sql` |
| "Staff are named as လက်ခံသူ (`received_by`) on records" | **TRUE** — and unvalidated beyond FK to any `profiles(id)` (including Owner, agents, inactive users). | `0041_received_by.sql`, `0049_bottle_only_collection.sql:227-231` |
| "Rule A (`0045`): staff edit/delete own rows only, same-day only, on `daily_entries` + `agent_payments` + `expenses`" | **PARTIALLY TRUE with critical bypasses.** `0045` scopes UPDATE/DELETE to `created_by = auth.uid()` on those three tables, **but** (1) `inventory_movements` was missed and stays `is_staff_plus()` for all rows, (2) legacy cascade bypass in `guard_same_day_edit` + `guard_month_lock` lets staff null `agent_payments.agent_id` on **past/locked** rows, (3) `created_at`/`entry_date`/`payment_date`/`unit_price` are mutable on direct UPDATE. | `0002_rls.sql`, `0037_pin_function_search_path.sql`, `0045_edit_own_rows_only.sql`, `0049_bottle_only_collection.sql` |
| "Staff visibility (`0046`): own rows only (`created_by = me OR received_by = me`) on `daily_entries`/`agent_payments`; `expenses` OM-only" | **TRUE on table SELECT**, **but leaked via RPCs**: `agent_detail_stats(p_agent)` and `inventory_totals()` remain `is_staff_plus()` and return factory-wide totals (including `agent_deposits` totals!). | `0046_staff_own_visibility.sql`, `0023_agent_stats_inventory_rpc.sql` |
| "Owner-only: user admin, PIN set/reset (`0035`), backdated inserts (`0018`), damage charges, write-offs, month lock" | **TRUE for INSERT/RPC paths** (with `0035` GoTrue role split requiring live-DB check), **but staff can backdate on same-day direct `UPDATE`** by mutating `entry_date` / `payment_date` to an unlocked past date. | `0018_owner_backdate_exception.sql`, `0035_owner_only_pin_reset.sql`, `0037_pin_function_search_path.sql` |
| "Staff have NO disputes page; `audit_log` is insert-only" | **TRUE in both UI and DB.** | `src/App.tsx:375-380`, `0002_rls.sql`, `0005_access_hardening.sql` |
| "Owner-accepted exception: Agents page per-agent totals are factory-wide for staff" | **TRUE for `agent_held_totals()` + `agent_outstanding(uuid)`** — **exceeded** by `agent_detail_stats(uuid)` and `inventory_totals()`. | `src/pages/AgentsPage.tsx:125-150`, `0021_collections_aggregation.sql`, `0023_agent_stats_inventory_rpc.sql`, `0042_damage_charges.sql` |

---

## Step 1 — Full Inventory (Verified From Code)

### 1(a) Pages & Routes Reachable by `staff` (`src/App.tsx`)

Navigation filtering (`src/App.tsx:53-71, 189-198`) and `<Routes>` (`src/App.tsx:268-408`) use effective roles (`profile.role` + `user_roles`). For a pure `staff` login:

| Route | Nav Visible? | Route Guard | Component | Staff Access Summary |
| --- | :---: | --- | --- | --- |
| `/` | Yes (tab 1) | None (branches on `role === 'agent'`) | `HomePage` (`<Dashboard />`) | Own daily totals (via `0046` RLS), date picker, employee summary card, quick links to `/entries` & `/payments`. No Backup / Month Lock cards. |
| `/entries` | Yes (tab 2) | `<Guard roles={['owner','manager','staff','agent']}>` | `EntriesPage` | Create delivery or bottle-only entry (today only), offline queue, view own/received entries, edit/delete own same-day entries. |
| `/payments` | Yes (tab 4) | `<Guard roles={['owner','manager','staff','agent']}>` | `PaymentsPage` | Record standalone payment (today only), view own/received payments, edit/delete own same-day standalone payments. |
| `/agents` | Yes (tab 3) | `<Guard roles={['owner','manager','staff']}>` | `AgentsPage` | Read-only search + wallet cards showing all non-archived agents' name, code, address, `held`, `outstanding`, `deposit_per_bottle`, `default_unit_price`, `credit_limit`. Phone shows `—` (RLS blocks `agent_contacts`). |
| `/settings` | Yes ("More") | None | `SettingsPage` | Own notification preferences (`notify_prefs`), push token count, device theme & Burmese/English language. No factory settings form. |

**Routes blocked by `<Guard>` (redirect to `/` for pure `staff`):**
- OM-only (`['owner', 'manager']`): `/agents/:id` (`AgentDetailPage`), `/closeout/:id` (`CloseoutPage`), `/collections` (`CollectionsPage`), `/inventory` (`InventoryPage`), `/expenses` (`ExpensesPage`), `/payroll` (`PayrollPage`), `/reports` (`ReportsPage`), `/handover` (`HandoverPage`), `/data-quality` (`DataQualityPage`), `/history` (`HistoryPage`).
- OM + Agent (`['owner', 'manager', 'agent']`): `/disputes` (`DisputesPage`).
- Owner-only (`['owner']`): `/damage-items` (`DamageItemsPage`), `/users` (`UsersPage`).
- Agent-only (`['agent']`): `/my` (`MyPage`).

---

### 1(b) All Tables (30 `public` Tables + `auth.users`) — Staff DB Rights

All 30 `public` tables have `ENABLE ROW LEVEL SECURITY` (`RLS=True`). Base table privileges grant `SELECT, INSERT, UPDATE, DELETE` to `authenticated` (Supabase default / `tests/post-grants.sql`), so RLS policies + triggers are the sole boundary.

| # | Table | SELECT (Staff) | INSERT (Staff) | UPDATE (Staff) | DELETE (Staff) | Active Policies & Key Triggers (Migrations) |
| -: | --- | --- | --- | --- | --- | --- |
| 1 | `advance_repayments` | Denied | Denied | Denied | Denied | `repayments_select` (`is_owner_manager()`, `0009`); no write policies |
| 2 | `advances` | Denied | Denied | Denied | Denied | `advances_*` (`is_owner_manager()`, `0009`) |
| 3 | `agent_contacts` | Denied | Denied | Denied | Denied | `contacts_select/update` (`is_owner_manager() or agent_id = app_agent_id()`, `0002`); `contacts_insert` (`is_owner_manager()`, `0002`) |
| 4 | `agent_damage_charges` | Denied | Denied | Denied | Denied | `damage_charges_select` (`is_owner_manager() or agent_id = app_agent_id()`, `0042`); insert/delete owner-only (`0042`) |
| 5 | `agent_deposits` | Denied | Denied | Denied | Denied | `deposits_select` (`is_owner_manager() or agent_id = app_agent_id()`, `0006`); I/U/D OM-only (`0006`) |
| 6 | `agent_payments` | **Own created OR received** | **Allowed** (today; any `agent_id`, even NULL/closed) | **Own `created_by` rows** (same-day trigger, **bypassable via `agent_id=NULL`!**) | **Own `created_by` rows** (same-day trigger; **even if `source_entry_id IS NOT NULL`**) | `payments_select` (`0046`), `payments_insert` (`0002`), `payments_update/delete` (`0045`); triggers: `payments_attribution` (`0005`), `payments_fill_name` (`0006`), `payments_guard_source_entry` (`0049`), `payments_insert_today` (`0004`), `payments_month_lock` (`0003`), `payments_same_day` (`0003`), `payments_audit` (`0003`), `payments_notify` (`0011`/`0044`) |
| 7 | `agent_settlements` | Denied | Denied | Denied | Denied | `settlements_select` (`is_owner_manager()`, `0006`); `settlements_via_closeout` (`0034`) |
| 8 | `agents` | **All rows** (incl. archived/closed/inactive) | Denied | Denied | Denied | `agents_select` (`is_staff_plus() or id = app_agent_id()`, `0002`); I/U OM-only (`0002`); `agents_never_delete` (`0032`) |
| 9 | `app_settings` | **All rows** (`using (true)` — even inactive!) | Denied | Denied | Denied | `settings_select` (`true`, `0002`); I/U owner-only (`0002`) |
| 10 | `audit_log` | Denied | Denied (DB triggers only) | Denied | Denied | `audit_select` (`is_owner_manager()`, `0002`); no client I/U/D policies (`0002`, `0005`) |
| 11 | `bonuses` | Denied | Denied | Denied | Denied | `bonuses_*` (`is_owner_manager()`, `0009`) |
| 12 | `cash_handovers` | Denied | Denied | Denied | Denied | `handover_*` (`is_owner_manager()`, `0009`) |
| 13 | `daily_entries` | **Own created OR received** | **Allowed** (today; **allows `agent_id=NULL` or `active=false`**) | **Own `created_by` rows** (same-day; **direct UPDATE can mutate `unit_price`, `entry_date`, `created_at`**) | **Own `created_by` rows** (same-day; cascades linked payments) | `entries_select` (`0046`), `entries_insert` (`0002`), `entries_update/delete` (`0045`); triggers: `entries_agent_immutable` (`0048`), `entries_attribution` (`0005`), `entries_before_write` (`0049`), `entries_fill_name` (`0006`), `entries_insert_today` (`0004`), `entries_month_lock` (`0003`), `entries_same_day` (`0003`), `entries_audit` (`0003`), `entries_notify` (`0049`) |
| 14 | `damage_items` | **All active rows** (even inactive staff!) | Denied | Denied | Denied | `damage_items_select` (`is_owner_manager() or active`, `0042`); I/U owner-only (`0042`) |
| 15 | `disputes` | Denied | Denied | Denied | Denied | `disputes_select/insert` (`is_owner_manager() or agent_id = app_agent_id()`, `0002`); `disputes_update` OM-only (`0005`) |
| 16 | `dq_seen` | Denied | Denied | Denied | Denied | RLS enabled (`0015`), zero policies (default-deny) |
| 17 | `expense_categories` | **All rows** (`is_staff_plus()`) | Denied | Denied | Denied | `categories_select` (`is_staff_plus()`, `0002`); I/U OM-only (`0002`) |
| 18 | `expenses` | Denied | Denied | Policy includes `is_staff_plus() and created_by = auth.uid()` (**unreachable** today because `expenses_select` is OM-only) | Same latent clause (`0045`) | `expenses_select/insert` (`is_owner_manager()`, `0002`); `expenses_update/delete` (`0045`) |
| 19 | `inventory_movements` | **ALL rows** (`is_staff_plus()`) | **Allowed** (today) | **ALL same-day rows (incl. OM's!)** + cascade bypass on `agent_id=NULL` | **ALL same-day rows (incl. OM's!)** | `inventory_select/insert/update/delete` (`is_staff_plus()`, `0002` — **never restricted to OM or own-rows!**); triggers: `inventory_attribution` (`0005`), `inventory_insert_today` (`0004`), `inventory_month_lock` (`0003`), `inventory_same_day` (`0003`), `inventory_audit` (`0003`) |
| 20 | `login_logs` | Denied | Denied directly (`login_logs_insert` dropped `0026`); indirect via rate-limited RPC | Denied | Denied | `login_logs_select` (`app_role() = 'owner'`, `0002`); `login_logs_insert` dropped (`0026`) |
| 21 | `month_locks` | **All rows** (`using (true)` — even inactive!) | Denied | Denied | Denied | `locks_select` (`true`, `0002`); `locks_insert` OM-only (`0002`); `locks_delete` owner-only (`0002`) |
| 22 | `notifications` | **Own rows** (`user_id = auth.uid()`, even inactive!) | Denied (triggers only) | **Own rows — ANY column** (no audit trigger!) | **Own rows** (no audit trigger!) | `noti_select/update/delete` (`user_id = auth.uid()`, `0011`); Realtime enabled (`0043`); **no audit trigger** |
| 23 | `notify_prefs` | **Own row** (even inactive!) | **Own row** (even inactive!) | **Own row** (even inactive!) | Denied | `prefs_select/write/update` (`user_id = auth.uid()`, `0011`); **no audit trigger** |
| 24 | `payroll_runs` | Denied | Denied | Denied | Denied | `runs_select` (`is_owner_manager()`, `0009`); writes via `pay_month()` RPC only |
| 25 | `pin_attempts` | Denied | Denied directly; indirect via `log_failed_login` | Denied | Denied directly; own row via `clear_login_failures` | RLS enabled (`0006`), zero policies |
| 26 | `profiles` | **Own row** (`id = auth.uid()`, even inactive!) | Denied | Denied | Denied | `profiles_select` (`is_owner_manager() or id = auth.uid()`, `0002`); I/U owner-only (`0002`) |
| 27 | `push_tokens` | **Own rows** (even inactive!) | **Own rows** (even inactive!) | **Own rows** (even inactive!) | **Own rows** (even inactive!) | `tokens_*` (`profile_id = auth.uid()`, `0002`); **no audit trigger** |
| 28 | `salary_settings` | Denied | Denied | Denied | Denied | `salary_*` (`is_owner_manager()`, `0009`) |
| 29 | `user_roles` | **Own rows** (even inactive!) | Denied | Denied | Denied | `user_roles_select` (`profile_id = auth.uid() or is_owner_manager()`, `0006`); I/D owner-only (`0006`) |
| 30 | `write_offs` | Denied | Denied | Denied | Denied | `writeoffs_select` (`is_owner_manager() or agent_id = app_agent_id()`, `0006`); I/U/D OM-only (`0006`) |
| — | `auth.users` | N/A | N/A | Password change blocked by `auth_password_owner_only` trigger (`0035`, live split to verify) | N/A | `guard_auth_password_change` + `audit_pin_reset` (`0035`) |

---

### 1(c) All Non-Trigger SQL Functions / RPCs (33 Functions)

Execute grants reflect `0026`, `0028`, `0038`, `0040`, `0041`, `0042`, `0048`, `0049`, `0050`.

| Function | Mode | Granted to `authenticated`? | Caller Gate Inside Body | Usable by Active Staff? | Usable by Inactive Staff? | What It Lets Staff Do / See |
| --- | --- | :---: | --- | :---: | :---: | --- |
| `app_role()` (`0005`) | DEFINER | Yes (`0038`) | `profiles.active` | Yes | Returns `NULL` | Reads own primary role |
| `app_agent_id()` (`0005`) | DEFINER | Yes (`0038`) | `profiles.active` | Yes (returns `NULL`) | Returns `NULL` | Reads own linked `agent_id` |
| `has_role(user_role)` (`0006`) | DEFINER | Yes (`0038`) | `profiles.active` | Yes | Returns `false` | Checks own effective role |
| `is_owner_manager()` (`0006`) | DEFINER | Yes (`0038`) | via `has_role` | Yes (`false`) | `false` | Role predicate |
| `is_staff_plus()` (`0006`) | DEFINER | Yes (`0038`) | via `has_role` | Yes (`true`) | `false` | Role predicate |
| `agent_outstanding(uuid)` (`0042`) | DEFINER | Yes (`0042`) | `is_staff_plus()` or own agent | **Yes** | Denied | Factory-wide balance for ANY agent (accepted Agents-page exception) |
| `agent_held_totals()` (`0021`) | DEFINER | Yes (`0038`) | `is_staff_plus()` | **Yes** | Denied | Factory-wide held bottles for ALL agents (accepted Agents-page exception) |
| `agent_detail_stats(uuid)` (`0023`) | DEFINER | Yes (`0038`) | `is_staff_plus()` or own agent | **Yes (LEAK!)** | Denied | **Factory-wide lifetime `sales`, `collectedEntries`, `paymentsTotal`, `depBottles`, `depAmount` for ANY agent** (bypasses `agent_deposits` RLS & `/agents/:id` guard) |
| `inventory_totals()` (`0023`) | DEFINER | Yes (`0038`) | `is_staff_plus()` | **Yes (LEAK!)** | Denied | **Factory-wide `produced`, `purchased`, `damaged`, `adjustments`, cumulative `outQty`, `inQty`** (bypasses `/inventory` guard) |
| `staff_directory()` (`0041`) | DEFINER | Yes (`0041`) | **NONE** | **Yes** | **Yes (LEAK!)** | Lists `id, name, active` of EVERY owner/manager/co_owner/staff (callable even when `active=false` or `agent`) |
| `edit_daily_entry(...)` (`0049`) | DEFINER | Yes (`0049`) | `is_staff_plus()` + Rule A (`created_by = auth.uid()`) + same-day + month-lock | **Yes** | Denied | Atomically edits own same-day entry & rewrites linked payments; accepts any `profiles.id` as `p_received_by` & unbounded `p_total_cash` |
| `public_factory_name()` (`0015`) | DEFINER | Yes (`0038`, +anon) | None | Yes | Yes | Returns `app_settings.factory_name` |
| `login_lock_status(text)` (`0006`) | DEFINER | Yes (`0038`, +anon) | None | Yes | Yes | Checks if any username is currently locked |
| `log_failed_login(text, text)` (`0036`) | DEFINER | Yes (`0038`, +anon) | Rate limit (30/min global) | Yes | Yes | Increments failure counter for any real username (5 calls = 15-min lockout) |
| `log_login_attempt(text, bool, text)` (`0036`) | DEFINER | Yes (`0038`, +anon) | `p_success=true` requires active own username; `false` rate-limited | Yes | `false` only | Writes `login_logs` rows (rate-limited 20/min/user, 300/min global) |
| `clear_login_failures()` (`0006`) | DEFINER | Yes (`0038`) | `profiles.id = auth.uid()` (no `active` check) | Yes | Yes (own row) | Deletes own `pin_attempts` row |
| `my_card_tier()` (`0040`) | DEFINER | Yes (`0040`) | `profiles.active` + `agent_id` | Returns empty | Returns empty | Agent-only tier lookup (harmless for pure staff) |
| `collections_summary(date, date)` (`0021`) | DEFINER | Yes (`0038`) | `is_owner_manager()` | Denied | Denied | Blocked (`forbidden`) |
| `report_range(date, date)` (`0020`) | DEFINER | Yes (`0038`) | `is_owner_manager()` | Denied | Denied | Blocked (`owner_manager_only`) |
| `report_months(...)` (`0020`) | DEFINER | Yes (`0038`) | `is_owner_manager()` | Denied | Denied | Blocked (`owner_manager_only`) |
| `report_aging(date)` (`0020`) | DEFINER | Yes (`0038`) | `is_owner_manager()` | Denied | Denied | Blocked (`owner_manager_only`) |
| `data_quality_scan()` (`0039`) | DEFINER | Yes (`0038`) | `is_owner_manager()` | Denied | Denied | Blocked (`42501`) |
| `finalize_closeout(...)` (`0031`) | DEFINER | Yes (`0038`) | `is_owner_manager()` | Denied | Denied | Blocked (`forbidden`) |
| `hard_delete_agent(uuid)` (`0032`) | DEFINER | Yes (`0038`) | `app_role() = 'owner'` | Denied | Denied | Blocked (`forbidden`) |
| `pay_month(uuid, text)` (`0009`) | DEFINER | Yes (`0038`) | `is_owner_manager()` | Denied | Denied | Blocked (`forbidden`) |
| `admin_create_user(...)` (`0030`) | DEFINER | Yes (`0038`) | Active primary `owner` | Denied | Denied | Blocked (`owner_only`) |
| `admin_reset_pin(uuid, text)` (`0030`) | DEFINER | Yes (`0038`) | Active primary `owner` | Denied | Denied | Blocked (`owner_only`) |
| `_report_aging_rows(date)` (`0020`) | DEFINER | **Revoked** (`0028`) | N/A | Denied | Denied | Internal helper |
| `insert_notification(...)` (`0011`) | DEFINER | **Revoked** (`0026`) | N/A | Denied | Denied | Internal trigger helper |
| `om_recipients(uuid)` (`0011`) | DEFINER | **Revoked** (`0026`) | N/A | Denied | Denied | Internal trigger helper |
| `record_login_failure(text)` (`0006`) | DEFINER | **Revoked** (`0026`) | N/A | Denied | Denied | Internal helper |
| `send_daily_digest()` (`0050`) | DEFINER | **Revoked** (`0050`) | N/A | Denied | Denied | Cron-only |
| `run_data_quality_alerts()` (`0050`) | DEFINER | **Revoked** (`0050`) | N/A | Denied | Denied | Cron-only |

All 25 trigger functions have `REVOKE ALL ... FROM PUBLIC, anon, authenticated` (`0028`, `0031`–`0035`, `0042`, `0048`, `0049`).

---

### 1(d) Every UI Action Visible to `staff`

| Location | Visible Controls / Forms / Actions | Exports Visible? |
| --- | --- | :---: |
| **Global Header** (`App.tsx:249-265`, `NotificationBell.tsx`) | Notification bell (open list, mark single read, mark all read), Theme toggle, Sign-out (`ထွက်ရန်`), Sidebar / Bottom tabs + "More" sheet (`/`, `/entries`, `/payments`, `/agents`, `/settings`). | None |
| **`/` (`HomePage.tsx` — `<Dashboard />`)** | Date picker (`<input type="date">`, can view any past date of own/received rows), 9 stat cards (trips, delivered, returned, charges, entry cash, payments, total cash, expenses [always 0], net cash), quick links to `/entries` and `/payments`, per-employee summary card (`ဝန်ထမ်းအလိုက် အကျဉ်းချုပ်`). *BackupCard & MonthLockCard are hidden (`role === 'owner' \|\| role === 'manager'`).* | **None** (`exportBackup`, `monthlyBackupCsv/Xlsx` are Owner-only inside `BackupCard`; `dailySummaryCsv` is on OM-only `HandoverPage`) |
| **`/entries` (`EntriesPage.tsx`)** | Mode toggle (`ရေပို့ + ဗူးခွံယူ` vs `ဗူးခွံသီးသန့် ပြန်ယူ`), Agent dropdown (active agents), Receiver dropdown (`လက်ခံသူ` — includes all active staff/managers/**owners** from `staff_directory()`), delivered/returned/cash/notes inputs, live balance/split preview, 2-step confirmation panel (`သိမ်းရန်` → `အတည်ပြု သိမ်းမည်` / `ပြန်ပြင်မည်`), Offline queue banner (`အခု တင်မယ်`), Month filter (`all` + 2020-01 to next month), "Load more 200" button, and on own same-day rows (`created_by === profile.id && isTodayYangon`): `ပြင်ရန်` (calls `edit_daily_entry` RPC with required reason) and `ဖျက်ရန်` (stamps `change_reason` then deletes row). *Date picker is hidden (`isOwner`).* | **None** |
| **`/payments` (`PaymentsPage.tsx`)** | Standalone payment form: Agent dropdown (active agents), Receiver dropdown (`လက်ခံသူ` — includes all active staff/managers/**owners**), amount, payment method (`cash`/`kbzpay`/`wavepay`/`bank`), notes, live split preview, `သိမ်းရန်` button (no confirmation step!). Month filter, "Load more 200", and on own same-day **standalone** rows (`!r.source_entry_id`): `ပြင်ရန်` (direct `UPDATE agent_payments`) and `ဖျက်ရန်` (stamps `change_reason` then direct `DELETE`). Linked rows (`r.source_entry_id`) hide edit/delete buttons in UI only. *Date picker is hidden (`isOwner`).* | **None** |
| **`/agents` (`AgentsPage.tsx`)** | Search box (`name`/`code`/`phone`), expandable wallet cards for open and closed (non-archived) agents showing `held`, `outstanding`, `deposit_per_bottle`, `default_unit_price`, `credit_limit`, `address`, and `phone: —`. *Add-agent form, inline number editors, active toggle, and `/agents/:id` detail link are all hidden (`canManage`).* | **None** |
| **`/settings` (`SettingsPage.tsx`)** | Notification prefs card (mode `all`/`important`, 5 toggles, `သိမ်းမည်` upserting own `notify_prefs`), Push device count display, Theme switcher (`light`/`dark`/`system`, localStorage), Language switcher (`မြန်မာ`/`English`, localStorage). *Factory settings card is hidden (`isOwner`).* | **None** |

---

## Step 2 — Mandatory Enforcement Matrix

| Action | Allowed for Staff? | Enforced Where | Citation (File + Migration + Policy / Function) |
| --- | :---: | --- | --- |
| View own/received `daily_entries` & `agent_payments` | Yes | **Both** | `EntriesPage.tsx`, `PaymentsPage.tsx`, `0046_staff_own_visibility.sql` (`entries_select`, `payments_select`) |
| View another staff member's unreceived `daily_entries` / `agent_payments` | No | **DB** | `0046_staff_own_visibility.sql` (`entries_select`, `payments_select`) |
| Insert today's `daily_entries` (delivery or bottle-only) | Yes | **Both** | `EntriesPage.tsx:365-536`, `0002_rls.sql` (`entries_insert`), `0004`/`0018` (`entries_insert_today`), `0049` (`entries_before_write`) |
| Insert backdated `daily_entries` / `agent_payments` | No | **Both** | `EntriesPage.tsx:151`, `PaymentsPage.tsx:152`, `0018_owner_backdate_exception.sql` (`guard_insert_today`) |
| **Backdate own same-day `daily_entries` / `agent_payments` via direct `UPDATE` (`entry_date`/`payment_date`)** | **No (defect)** | **UI only** | `EntriesPage.tsx` uses `edit_daily_entry`, `PaymentsPage.tsx` omits date, **DB allows `UPDATE` of `entry_date`/`payment_date` to any unlocked past date** (`0045`, `0037` `guard_insert_today` is `BEFORE INSERT` only) |
| **Alter `unit_price` (e.g. to `0`) on same-day `daily_entries` via direct `UPDATE`** | **No (defect)** | **UI only** | `EntriesPage.tsx:634` uses `edit_daily_entry`; **DB `entries_before_write` (`0049:86-89`) only sets `unit_price` on `INSERT`, NOT `UPDATE`** |
| **Extend same-day edit window by mutating `created_at` on direct `UPDATE`** | **No (defect)** | **UI only** | `0037_pin_function_search_path.sql` (`guard_same_day_edit` checks `old.created_at` only; no `created_at` immutability trigger) |
| Edit/delete another staff member's `daily_entries` / `agent_payments` | No | **Both** | `EntriesPage.tsx:109`, `PaymentsPage.tsx:105`, `0045_edit_own_rows_only.sql` (`entries_update/delete`, `payments_update/delete`), `0049` (`edit_daily_entry:203`) |
| Edit/delete own `daily_entries` on a later day or locked month | No | **Both** | `EntriesPage.tsx:696`, `0037` (`guard_same_day_edit`, `guard_month_lock`), `0048` (`entries_agent_immutable`), `0049` (`edit_daily_entry:209-220`) |
| **Detach `agent_id = NULL` on ANY historical / locked `agent_payments` row** | **No (defect)** | **UI only** | `0006` (`agent_payments.agent_id drop not null`), `0037` (`guard_same_day_edit` & `guard_month_lock` cascade bypass), `0045` (`payments_update`), missing `payments_agent_immutable` trigger |
| **Edit/delete entry-linked payment (`source_entry_id IS NOT NULL`) directly** | **No (defect)** | **UI only** | `PaymentsPage.tsx:451-457,487` hides buttons; **DB `payments_update/delete` (`0045`) and `guard_payment_source_entry` (`0049`) allow it** |
| **Switch `agent_id` on same-day `agent_payments` via direct `UPDATE`** | **No (defect)** | **UI only** | `PaymentsPage.tsx:545` ("ပြောင်း၍ မရပါ"); **DB has NO `payments_agent_immutable` trigger** |
| **Insert `daily_entries` or `agent_payments` with `agent_id = NULL`** | **No (defect)** | **UI only** | `EntriesPage.tsx:351`, `PaymentsPage.tsx:278`; **DB dropped `NOT NULL` in `0006`, and `entries_before_write` (`0049:74-76`) skips all checks when `agent_id IS NULL`** |
| **Insert `daily_entries` for `agents.active = false` or `agent_payments` for closed/archived/inactive agent** | **No (defect)** | **UI only** | `EntriesPage.tsx:1037`, `PaymentsPage.tsx:658` filter `a.active`; **DB `entries_before_write` (`0049:82`) checks `closed_at` only (not `active`); `agent_payments` checks neither** |
| **Spoof `created_by` on INSERT / UPDATE** | No | **DB** | `0005`/`0037` (`force_insert_attribution` overwrites `created_by := auth.uid()` on INSERT); `0045` `WITH CHECK` prevents staff changing `created_by` on UPDATE |
| **Spoof `received_by` (onto another staff, Owner, inactive user, or Agent)** | **Partially allowed in UI; unvalidated in DB** | **Neither** | `EntriesPage.tsx:1059`, `PaymentsPage.tsx:675`, `0041_received_by.sql` (plain FK to `profiles(id)`), `0049` (`edit_daily_entry:228` checks `profiles` existence only) |
| Switch bottle-only ↔ delivery or attach cash/linked payment to bottle-only row | No | **Both** | `EntriesPage.tsx`, `0049_bottle_only_collection.sql` (`entries_before_write`, `guard_payment_source_entry`, `edit_daily_entry`) |
| Enforce `change_reason` (≥2 chars) on edits/deletes | Yes (intent) | **DB for `edit_daily_entry` RPC; UI only for direct `UPDATE`/`DELETE`** | `0049` (`edit_daily_entry:222`), `EntriesPage.tsx:660`, `PaymentsPage.tsx:368,404`; `0006` (`change_reason` nullable) |
| **Read/Insert/Update/Delete `inventory_movements` (incl. OM rows)** | **No (defect)** | **UI only** | `src/App.tsx:319-324` (`<Guard roles={['owner','manager']}>`); **DB `0002_rls.sql` (`inventory_select/insert/update/delete`) ALL use `is_staff_plus()`** |
| **Read factory-wide `inventory_totals()` RPC** | **No (defect)** | **UI only** | `0023_agent_stats_inventory_rpc.sql` (`inventory_totals()` allows `is_staff_plus()`) |
| **Read factory-wide `agent_detail_stats(uuid)` (incl. `agent_deposits` totals & lifetime sales)** | **No (defect)** | **UI only** | `src/App.tsx:295-300` (`/agents/:id` OM-only), `0006` (`deposits_select` OM/self-agent), **DB `0023` (`agent_detail_stats` allows `is_staff_plus()`)** |
| Read `agent_held_totals()` & `agent_outstanding(uuid)` | Yes (owner-accepted exception) | **Both** | `AgentsPage.tsx:127,147`, `0021_collections_aggregation.sql`, `0042_damage_charges.sql` |
| Read `agent_contacts` (agent phone numbers) | No | **Both** | `AgentsPage.tsx:120-126`, `0002_rls.sql` (`contacts_select`: `is_owner_manager() or agent_id = app_agent_id()`) |
| Read/Write `cash_handovers` | No | **Both** | `src/App.tsx:351-357`, `0009_phase_b_payroll_handover.sql` (`handover_*`: `is_owner_manager()`) |
| Read/Insert `expenses` | No | **Both** | `src/App.tsx:327-333`, `0002_rls.sql` (`expenses_select/insert`: `is_owner_manager()`) |
| Read `expense_categories` | **No (minor leak)** | **UI only** | `0002_rls.sql` (`categories_select`: `is_staff_plus()`) |
| Read/Write `disputes`, `write_offs`, `agent_damage_charges`, `agent_deposits`, `agent_settlements`, `advances`, `bonuses`, `payroll_runs`, `salary_settings` | No | **Both** | `src/App.tsx`, `0002`, `0005`, `0006`, `0009`, `0034`, `0042` |
| Read/Modify/Delete `audit_log` | No | **Both** | `src/App.tsx:367-373`, `0002_rls.sql` (`audit_select` OM-only; zero write policies) |
| Call OM/Owner RPCs (`collections_summary`, `report_*`, `data_quality_scan`, `finalize_closeout`, `hard_delete_agent`, `pay_month`, `admin_create_user`, `admin_reset_pin`) | No | **Both** | `0009`, `0020`, `0021`, `0030`, `0031`, `0032`, `0038`, `0039` |
| Change own PIN (self-service `auth.updateUser`) | No (SPEC Rule 9) | **Both** (live role split to verify) | `HomePage.tsx:990`, `SettingsPage.tsx`, `0035_owner_only_pin_reset.sql` (`auth_password_owner_only`) |
| Deactivated staff (`profiles.active = false`) blocked from core business tables/RPCs | Yes | **DB** (UI sign-in only; **UI session restore omits `active` check**) | `AuthContext.tsx:103-145,185`, `0005`/`0006` (`app_role`, `has_role`, `is_staff_plus` check `active`) |
| **Deactivated staff blocked from `staff_directory()`, `app_settings`, `month_locks`, `damage_items`, own `notifications`/`notify_prefs`/`push_tokens`** | **No (defect)** | **Neither** | `0041` (`staff_directory`), `0002` (`settings_select`, `locks_select`, `tokens_*`), `0011` (`noti_*`, `prefs_*`), `0042` (`damage_items_select`) |
| **Tamper/delete own `notifications` or edit `notify_prefs`/`push_tokens` without audit trail** | **Unintended for `notifications` body/delete** | **Neither** | `0011_phase_c_notifications.sql` (`noti_update/delete` unrestricted on own rows; no `audit_row_change()` trigger on `notifications`, `notify_prefs`, `push_tokens`) |
| Lock out other accounts via `log_failed_login()` | No (abuse risk) | **Rate-limited in DB (30/min global)** | `0036_login_lockout_abuse.sql`, `0038_definer_execute_grants.sql` |

---

## Step 2 — Findings List

### Severity: `money loss` (9 Findings)

#### [M1] Direct `UPDATE daily_entries` lets staff zero out `unit_price` (wiping charge to 0 MMK) and mutate `entry_date` / `created_at`
- **Severity:** `money loss`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `supabase/migrations/0045_edit_own_rows_only.sql` (`entries_update`), `0049_bottle_only_collection.sql` (`entries_before_write` lines 86–89), `0037_pin_function_search_path.sql` (`guard_insert_today`, `guard_same_day_edit`).
- **Root Cause:** `EntriesPage` edits via `edit_daily_entry()`, which preserves `unit_price`, `entry_date`, and `created_at`. However, `entries_update` RLS still grants staff direct `UPDATE` on their own `daily_entries` rows (used by `onDelete` to stamp `change_reason`), and `entries_before_write()` only overwrites `new.unit_price := v_agent.default_unit_price` when `tg_op = 'INSERT'`. Neither `unit_price`, `entry_date`, nor `created_at` is locked on `UPDATE`.
- **Misuse Path:**
  1. Staff delivers 200 bottles to Agent A (price 1,000 MMK → 200,000 MMK) and collects 200,000 MMK cash in person.
  2. Staff saves the delivery normally (or inserts via PostgREST), then issues a direct PostgREST `PATCH` on their own row setting `unit_price = 0` and `amount_collected = 0` (leaving `delivered_qty = 200`).
  3. `entries_before_write()` computes `amount = 200 × 0 = 0`, skips `credit_limit` violation (0 due), and commits. Agent A gets 200 bottles with 0 MMK charge and 0 MMK balance (so Agent A never disputes), while staff pockets 200,000 MMK cash and their handover expected drops to 0.
  4. Variant (same-day / backdate bypass): on the same day, staff `PATCH`es `entry_date` to an unlocked past date (bypassing Owner-only backdating `0018`), or `PATCH`es `created_at` to a future Yangon date so `guard_same_day_edit()` allows editing the row on that future date.
- **Current Detection:** `entries_audit` logs the update in `audit_log` (OM-visible on `/history` and counted in the 19:00 digest), and `data_quality_scan()` checks `amount <> delivered_qty * unit_price` (which STILL PASSES because `0 = 200 * 0`!). No real-time alert fires.
- **Recommended DB Fix:** In `entries_before_write()` on `UPDATE`, force `new.unit_price := old.unit_price`, `new.entry_date := old.entry_date`, `new.created_at := old.created_at` (or reject changes to them), and consider restricting direct `UPDATE` on `daily_entries` in favour of RPCs for edit and delete.

#### [M2] Legacy hard-delete cascade bypass lets staff detach `agent_id = NULL` on ANY historical or LOCKED-MONTH `agent_payments` row (violating SPEC Rules 4 & 6)
- **Severity:** `money loss`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `0006_phase_a_parity.sql` (`alter table agent_payments alter column agent_id drop not null`), `0037_pin_function_search_path.sql` (`guard_same_day_edit`, `guard_month_lock` cascade-nulling bypass), `0045_edit_own_rows_only.sql` (`payments_update`), `0048_edit_entries_expenses.sql` (added `entries_agent_immutable` on `daily_entries` only — NOT on `agent_payments` or `inventory_movements`).
- **Root Cause:** `0032` stopped hard-deleting agents (switching to `archived_at`), but `guard_same_day_edit()` and `guard_month_lock()` kept a bypass that returns `new` immediately whenever an `UPDATE` changes ONLY `agent_id` from non-null to `NULL`. Because `agent_payments` has no `agent_immutable` trigger and `payments_update` admits any row where `created_by = auth.uid()`, staff can trigger this bypass directly.
- **Misuse Path:**
  1. Staff picks any historical `agent_payments` row they created weeks or months ago — even inside a **locked month**.
  2. Staff sends a direct PostgREST `PATCH` on `agent_payments` changing ONLY `agent_id = null`.
  3. `payments_update` passes (`created_by = auth.uid()`), `payments_same_day` takes the cascade-bypass early return, and `payments_month_lock` takes the exact same early return.
  4. Result: The payment is silently detached from the agent in a locked historical period. `agent_outstanding(agent_id)` immediately jumps upward by that payment's full amount (double-charging an honest agent, or corrupting closed-month financial reports). (The identical bypass also works on `inventory_movements.agent_id` for **any** row — even OM's!)
- **Current Detection:** Logged in `audit_log`, but no alert fires and `0050` evening digest only checks today's `audit_log` (if done after 19:00 it is missed that evening; agent only notices later).
- **Recommended DB Fix:** Add `payments_agent_immutable` (`BEFORE UPDATE` rejecting `new.agent_id is distinct from old.agent_id`) on `agent_payments` (and `inventory_movements`), and remove the obsolete `agent_id -> NULL` cascade bypass from `guard_same_day_edit()` and `guard_month_lock()` (since `0032` forbids deleting agents).

#### [M3] `inventory_movements` is wide open to staff in DB (SELECT / INSERT / UPDATE / DELETE on ALL rows, including OM's) — UI-only restriction
- **Severity:** `money loss` (asset/stock loss — bottles are factory capital)
- **Status:** `PROVEN FROM CODE`
- **Citations:** `src/App.tsx:319-324` (`<Guard roles={['owner', 'manager']}>`), `0002_rls.sql` (`inventory_select`, `inventory_insert`, `inventory_update`, `inventory_delete` all use `is_staff_plus()`), `0045_edit_own_rows_only.sql` (did not cover `inventory_movements`), `0046_staff_own_visibility.sql` (did not cover `inventory_movements`).
- **Root Cause:** `/inventory` was restricted to Owner/Manager in `App.tsx`, but its `0002` RLS policies were never tightened from `is_staff_plus()` to `is_owner_manager()`.
- **Misuse Path:**
  1. Staff calls PostgREST directly against `/rest/v1/inventory_movements` with their normal JWT.
  2. Staff inserts fake `kind = 'damage'` or `kind = 'adjust'` movements (masking stolen bottles) OR edits/deletes **Owner/Manager's** same-day `produce`/`purchase` entries (not even own-row restricted!).
  3. Factory bottle inventory totals (`InventoryPage`, `inventory_totals()`) are silently falsified with zero notification to OM.
- **Current Detection:** Written to `audit_log`, but `0050` daily digest only counts edits/deletes on `('daily_entries', 'agent_payments', 'expenses')` — `inventory_movements` edits/deletes are NOT even counted in the evening digest!
- **Recommended DB Fix:** Replace all four `inventory_movements` policies with `is_owner_manager()` (matching `/inventory` guard), and restrict `inventory_totals()` to `is_owner_manager()`.

#### [M4] Direct `UPDATE`/`DELETE` on `agent_payments` breaks entry-linked payment invariants, allows switching `agent_id`, backdating `payment_date`, mutating `created_at`, inserting `amount = 0` or closed-agent payments, and bypassing `credit_limit`
- **Severity:** `money loss`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `src/pages/PaymentsPage.tsx:451-457, 487, 545`, `0001_schema.sql` (`amount bigint not null check (amount >= 0)`), `0045_edit_own_rows_only.sql` (`payments_update`, `payments_delete`), `0047_entry_payment_link.sql` (`source_entry_id`), `0049_bottle_only_collection.sql` (`guard_payment_source_entry`, `entries_before_write:109-117`).
- **Root Cause:** Several rules shown in `PaymentsPage` are UI-only:
  1. Linked payments (`source_entry_id IS NOT NULL`) hide edit/delete buttons in UI, but DB `payments_update`/`payments_delete` allow modifying or deleting them directly — desyncing the visit's entry/payment pair.
  2. `agent_payments` has no `agent_immutable` trigger, so on same-day direct `UPDATE` staff can reassign a payment to a different agent (moving cash credit from Agent A to Agent B).
  3. `payment_date` and `created_at` are mutable on `UPDATE` (same backdating / future-unlock bug as M1).
  4. `agent_payments` has no trigger rejecting `amount = 0` (only `amount >= 0`), no trigger rejecting `closed_at IS NOT NULL` / `archived_at IS NOT NULL` / `active = false` agents, and no upper-bound sanity guard.
  5. **Credit-limit bypass:** Staff can insert a temporary same-day `agent_payments` row to artificially lower `agent_outstanding(agent_id)`, insert a large delivery on credit that now passes `entries_before_write()` `credit_limit`, and immediately delete the temporary same-day `agent_payments` row (`payments_delete` does not re-check `credit_limit`).
- **Misuse Path:**
  1. Staff records a delivery + old-debt cash payment (`source_entry_id` set) so the agent gets a receipt notification, then directly `DELETE`s (or reduces `amount` on) the linked `agent_payments` row via PostgREST — keeping the cash while the delivery row looks untouched.
  2. Or: staff delivers past an agent's `credit_limit` by inserting a temporary payment, saving the delivery, then deleting the temporary payment.
- **Current Detection:** Logged in `audit_log`; `0050` evening digest reports count of edits/deletes up to 19:00 only.
- **Recommended DB Fix:** Add a `BEFORE INSERT OR UPDATE` trigger on `agent_payments` enforcing `amount > 0`, `agent_id IS NOT NULL` (and open/active agent), immutable `agent_id`/`payment_date`/`created_at`/`source_entry_id`, and blocking direct client `UPDATE`/`DELETE` on rows where `source_entry_id IS NOT NULL` (allow only via `edit_daily_entry()` or FK `ON DELETE CASCADE`).

#### [M5] Unvalidated `received_by` lets staff shift cash handover liability onto another staff member, the Owner, an inactive user, or an Agent — making cash vanish from `HandoverPage` and evening mismatch alerts
- **Severity:** `money loss`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `0041_received_by.sql` (`received_by uuid references profiles(id)`, `staff_directory()`), `0049_bottle_only_collection.sql` (`edit_daily_entry:227-231`), `src/pages/EntriesPage.tsx:1059-1074`, `src/pages/PaymentsPage.tsx:675-687`, `src/pages/HandoverPage.tsx:50, 90, 127-138`, `0050_same_day_detection.sql:191-202`.
- **Root Cause:** Both UI forms let any staff user freely choose ANY active staff, manager, or **Owner** as `received_by` with zero confirmation from that person. Worse, in the DB `received_by` has only a plain FK to `profiles(id)` — no check that the target is active or even a staff/manager role. Meanwhile, `HandoverPage` only renders cards for `active = true` profiles with role `staff | manager | co_owner`, and `0050` `send_daily_digest()`'s unrecorded-handover alert (`v_mismatch_line`) only checks `staff | manager | co_owner`.
- **Misuse Path:**
  1. Dishonest Staff A collects 300,000 MMK from Agent X.
  2. **In normal UI:** Staff A picks the **Owner** (listed in the `လက်ခံသူ` dropdown) as `received_by`. Staff A's `HandoverPage` expected cash drops by 300,000 MMK, and **no** handover card or unrecorded-handover mismatch appears for the Owner!
  3. **Via direct API (or `edit_daily_entry`):** Staff A sets `received_by` to a deactivated staff UUID or an `agent` profile UUID — the cash vanishes from BOTH `HandoverPage` AND `v_mismatch_line`!
  4. **Or blaming a coworker (human error OR malice):** Staff A picks Staff B as `received_by`; Staff B's handover now shows a 300,000 MMK shortage unless caught.
- **Current Detection:** `notify_on_entry`/`notify_on_payment` names `လက်ခံသူ` in OM's notification, and `0050` evening digest includes per-receiver totals (`v_rec_line`) — so an attentive Owner reading every notice or the 19:00 digest can spot their own name or an unexpected receiver, **provided** it wasn't switched via `edit_daily_entry` after 19:00 (which sends no notification!).
- **Recommended DB Fix:** Validate `received_by` in a DB trigger (must be an active `staff`/`manager`/`co_owner`/`owner`), consider restricting non-OM staff from naming an `owner` (or triggering a high-priority OM alert whenever `created_by <> received_by`), and surface non-employee `received_by` totals on `HandoverPage`.

#### [M6] Direct `INSERT` of `daily_entries` or `agent_payments` with `agent_id = NULL` bypasses price snapshotting, `agent_closed`, `deposit_limit`, and `credit_limit`
- **Severity:** `money loss`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `0006_phase_a_parity.sql` (`drop not null` on `daily_entries.agent_id` & `agent_payments.agent_id`), `0049_bottle_only_collection.sql` (`entries_before_write:74-76`).
- **Root Cause:** `agent_id` was made nullable in `0006` solely for the legacy `ON DELETE SET NULL` agent hard-delete cascade (removed in `0032`). `entries_before_write()` returns `new` immediately when `new.agent_id is null`, skipping `unit_price` lookup, `amount` calculation, `agent_closed`, `deposit_limit`, and `credit_limit`.
- **Misuse Path:**
  1. Staff sends a direct PostgREST `POST` to `daily_entries` with `agent_id: null, delivered_qty: 500, unit_price: 0, amount: 0, amount_collected: 0` (or `agent_payments` with `agent_id: null, amount: 500000`).
  2. DB accepts the row; it affects factory-wide `inventory_totals()`, `report_range()` (as `(ဖျက်ပြီး)`), and `send_daily_digest()` cash/delivery totals, while charging **no agent** (`agent_outstanding()` ignores `agent_id IS NULL`).
- **Current Detection:** `audit_log` records the insert; `notify_on_entry` sends an OM notice with blank agent name.
- **Recommended DB Fix:** Reject `new.agent_id is null` on `INSERT` in `entries_before_write()` and a new `payments_before_write()` trigger (preserving existing historical NULL rows if any exist).

#### [M7] Non-atomic multi-row saves + offline queue stale-drop and unsplit replay cause silent cash/ledger drift
- **Severity:** `money loss`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `src/pages/EntriesPage.tsx:249-290, 386-522, 544-557`, `src/lib/offlineQueue.ts:15-28`, `src/pages/PaymentsPage.tsx:314-341`.
- **Root Cause (Human-Error Lens):**
  1. **Offline queue next-day drop:** If a staff member records an entry offline (e.g., late afternoon/evening with poor signal) and reconnects after midnight (Asia/Yangon), `flushQueue()` hits `same_day_only` and **permanently deletes** the queued entry from `localStorage` (`removeAt(i)`). Only an ephemeral in-memory red banner (`droppedStale`) is shown — if the user refreshes or closes the tab, the entry and cash collected disappear with **zero DB audit trail**. (If queued during a month that gets locked before reconnect, `month_locked` halts the entire queue behind that item.)
  2. **Offline queue unsplit cash replay:** When an offline delivery with cash exceeding today's charge replays the same day, `flushQueue()` inserts the full cash straight into `daily_entries.amount_collected` (`amount_collected > amount`), bypassing the `old_debt`/`regular` split (`agent_payments` is never created) and skipping payment notifications.
  3. **Non-atomic online split:** `EntriesPage.doInsert` inserts `daily_entries` first, then loops to insert spawned `agent_payments` rows in separate HTTP requests; `PaymentsPage.onAdd` similarly inserts `old_debt` then `regular` in separate requests. A mid-save network blip leaves half the visit's cash missing (only a client-side `partialMsg` warning is displayed; no DB rollback).
- **Misuse / Failure Path:**
  1. Staff delivers 100 bottles and collects 100,000 MMK while offline at 9:30 PM; phone only regains signal at 7:00 AM next day.
  2. `EntriesPage` auto-flushes → Postgres rejects with `same_day_only` → `flushQueue()` deletes the item from `localStorage`.
  3. Staff closes browser/tab before noticing the banner → 100 bottles and 100,000 MMK vanish from the system with no server trace.
- **Current Detection:** Only the transient client banner (`droppedStale` / `partialMsg`); nothing on the server knows a dropped offline entry ever existed.
- **Recommended Fix:** Move delivery+split creation and standalone payment creation into atomic `SECURITY DEFINER` RPCs (like `edit_daily_entry`), and persist dropped/failed offline items in a visible "Failed / Needs Owner Entry" recovery list in `localStorage` rather than deleting them silently.

#### [M8] Same-day edits and deletes fire ZERO immediate OM notifications (blind spot from 19:01–23:59 Yangon), and `edit_daily_entry` allows unbounded `p_total_cash`
- **Severity:** `money loss`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `0011_phase_c_notifications.sql:117,139` (`AFTER INSERT` triggers only), `0049_bottle_only_collection.sql` (`edit_daily_entry`), `0050_same_day_detection.sql:133-140, 227-238` (digest runs once at 19:00 Yangon).
- **Root Cause:** OM receives live notifications on `INSERT` of entries and payments, **never** on `UPDATE` or `DELETE`. Migration `0050` added an edit/delete count to the 19:00 Yangon digest, leaving a **5-hour blind window (19:00–23:59 Yangon)** where a same-day edit/delete is NOT surfaced before the midnight lock! Additionally, `edit_daily_entry` has no upper bound on `p_total_cash` (a typo adding an extra zero, e.g. `2,000,000` instead of `200,000`, creates a massive fake overpayment that silently auto-absorbs future charges).
- **Misuse Path:**
  1. Staff records a legitimate 200-bottle delivery + 200,000 MMK cash at 10:00 AM (OM sees the normal notice; 19:00 digest looks normal; handover passes if done earlier or cash is shifted).
  2. At 8:30 PM (after the 19:00 digest), staff edits the entry via `edit_daily_entry` (changing `p_total_cash` to `0` or `delivered_qty` down, or switching `received_by`), or deletes the entry.
  3. Zero notification goes to OM or the agent; at 12:00 AM midnight the record locks permanently, and OM only discovers it if they manually inspect `/history`.
- **Current Detection:** Recorded in `audit_log` (`/history`), but no push/in-app alert fires on edit/delete.
- **Recommended DB Fix:** Add `AFTER UPDATE / DELETE` notification triggers on `daily_entries` and `agent_payments` alerting OM immediately (high priority if cash decreased or row deleted), and add a sanity threshold / confirmation warning on unusually large `p_total_cash` or overpayments.

#### [M9] `daily_entries` permits inserts for `agents.active = false` via direct API, and multi-role `agent + staff` skips `credit_limit`
- **Severity:** `money loss`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `0049_bottle_only_collection.sql` (`entries_before_write:82-84, 109`), `src/pages/EntriesPage.tsx:1037`.
- **Root Cause:** `EntriesPage` filters the dropdown to `agents.filter(a => a.active)`, but `entries_before_write()` only checks `v_agent.closed_at is not null` — an inactive (paused) agent with `active = false, closed_at IS NULL` can still receive deliveries via direct API. Also line 109 checks `if app_role() = 'staff'` (primary role only) instead of `if not is_owner_manager()`, so a user whose primary role is `agent` with extra role `staff` in `user_roles` bypasses `credit_limit`.
- **Misuse Path:**
  1. Owner pauses a delinquent agent (`agents.active = false`) without closing out their account yet.
  2. Staff sends a direct PostgREST `INSERT` into `daily_entries` for that agent's UUID; DB accepts it.
  3. Or a dual-role `agent` (primary) + `staff` (extra) inserts deliveries past `credit_limit`.
- **Current Detection:** Standard entry notification & `audit_log`.
- **Recommended DB Fix:** In `entries_before_write()`, reject `not v_agent.active` on delivery inserts (decide whether bottle-only returns should still be allowed for paused agents), and change `app_role() = 'staff'` to `not is_owner_manager()`.

---

### Severity: `data leak` (5 Findings)

#### [D1] `agent_detail_stats(p_agent)` RPC leaks factory-wide lifetime sales, collected totals, and `agent_deposits` MMK for EVERY agent to staff
- **Severity:** `data leak`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `src/App.tsx:295-300` (`/agents/:id` OM-only), `0006_phase_a_parity.sql` (`deposits_select`: `is_owner_manager() or agent_id = app_agent_id()`), `0023_agent_stats_inventory_rpc.sql` (`agent_detail_stats`), `0038_definer_execute_grants.sql`.
- **Root Cause:** `agent_detail_stats(p_agent uuid)` is `SECURITY DEFINER`, granted to `authenticated`, and gates on `public.is_staff_plus() or own agent`. Even though `/agents/:id` is OM-only and `agent_deposits` RLS deliberately blocks staff, calling this RPC returns `{ held, sales, collectedEntries, paymentsTotal, depBottles, depAmount }` across ALL history and ALL staff for any agent UUID (which staff can read from `agents`).
- **Misuse Path:**
  1. Staff lists all `agents.id` from `agents` (permitted).
  2. Staff calls `POST /rest/v1/rpc/agent_detail_stats` for every agent ID.
  3. Staff obtains total factory lifetime revenue (`sum(sales)`), total collections (`sum(collectedEntries + paymentsTotal)`), and total bottle deposit liabilities (`sum(depBottles)`, `sum(depAmount)`) — data that `0046` and `agent_deposits` RLS deliberately hide from staff.
- **Current Detection:** None (read-only RPC calls are not audited).
- **Recommended DB Fix:** Tighten `agent_detail_stats` caller check from `is_staff_plus()` to `is_owner_manager()` (keeping the `p.agent_id = p_agent` branch for agents). Confirm `AgentsPage.tsx` does not call `agent_detail_stats` (verified: it does not; only `AgentDetailPage.tsx` / `CloseoutPage.tsx` use it).

#### [D2] `inventory_movements` RLS + `inventory_totals()` RPC leak full factory production, purchases, damage, adjustments, and cumulative bottle volume to staff
- **Severity:** `data leak`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `0002_rls.sql` (`inventory_select`: `is_staff_plus()`), `0023_agent_stats_inventory_rpc.sql` (`inventory_totals`: `is_staff_plus()`), `src/App.tsx:319-324` (`/inventory` OM-only).
- **Root Cause:** Both the table policy and the aggregate RPC still use `is_staff_plus()` even though inventory is an OM-only management page.
- **Misuse Path:**
  1. Staff queries `GET /rest/v1/inventory_movements` and `POST /rest/v1/rpc/inventory_totals`.
  2. Staff reads every factory production run, bottle purchase, damage log, stock adjustment, and total cumulative factory `outQty`/`inQty` across all staff.
- **Current Detection:** None.
- **Recommended DB Fix:** Restrict `inventory_select` and `inventory_totals()` to `is_owner_manager()` (keep `agent_id = app_agent_id()` on `inventory_select` only if agents need it).

#### [D3] `staff_directory()` RPC has NO caller gate — deactivated staff (`active = false`) and any `agent` can enumerate all owner/manager/staff IDs, names, and active flags
- **Severity:** `data leak`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `0041_received_by.sql` (`staff_directory()` `SECURITY DEFINER`, `grant execute ... to authenticated`, zero `where`/role/`active` check on caller).
- **Root Cause:** `staff_directory()` was written so UI screens (including Agent receipts on `HomePage`/`EntriesPage`/`PaymentsPage`) can resolve receiver names without granting `SELECT` on `profiles`. However, it has no `active` check on the caller, and it returns ALL internal staff/manager/owner UUIDs + active flags even to a deactivated account.
- **Misuse Path:**
  1. A deactivated staff member (`profiles.active = false`) with a still-valid JWT (or fresh sign-in token via raw GoTrue API) calls `POST /rest/v1/rpc/staff_directory`.
  2. Returns the complete live roster of every owner, manager, co-owner, and staff member (`id`, `name`, `active`), even after the employee was fired and deactivated.
- **Current Detection:** None.
- **Recommended DB Fix:** Require `exists (select 1 from profiles where id = auth.uid() and active)` inside `staff_directory()` (blocking deactivated accounts). For `agent` callers, consider returning only receiver names referenced by their own entries/payments rather than the full active/inactive employee roster.

#### [D4] Deactivated staff (`profiles.active = false`) keep an active UI shell on session restore and retain DB read/write access to non-role-gated tables
- **Severity:** `data leak` (plus persistence/session-revocation weakness)
- **Status:** `PROVEN FROM CODE`
- **Citations:** `src/context/AuthContext.tsx:93-146, 185-189`, `0002_rls.sql` (`settings_select`, `locks_select`, `profiles_select`, `tokens_*`), `0006_phase_a_parity.sql` (`user_roles_select`), `0011_phase_c_notifications.sql` (`noti_*`, `prefs_*`), `0042_damage_charges.sql` (`damage_items_select`).
- **Root Cause:**
  1. **UI bug:** `AuthContext.signIn()` checks `!outcome.profile.active` and signs out, **but** `loadProfile()` (called on `getSession()` and `onAuthStateChange()`) calls `applyProfile(outcome.profile)` without checking `active`! An already-logged-in staff member stays inside the app shell after the Owner disables them.
  2. **DB gap:** Deactivating sets `profiles.active = false` only (it does NOT ban `auth.users` or revoke refresh tokens). While core tables/RPCs correctly block via `is_staff_plus()` (`p.active = true`), any table whose RLS uses `true` or `auth.uid()` directly remains readable/writable: `app_settings`, `month_locks`, `damage_items` (active price list), `profiles` (own), `user_roles` (own), `notifications` (own read/update/delete), `notify_prefs` (own read/write), `push_tokens` (own CRUD), plus `staff_directory()` (D3).
- **Misuse Path:**
  1. Owner deactivates a departed staff member (`profiles.active = false`).
  2. The staff member's existing phone session refreshes — `AuthContext` keeps them signed in (or they authenticate directly against Supabase Auth with their old PIN, because GoTrue does not check `profiles.active`).
  3. Using their JWT, they continue reading `app_settings` (factory phone/address, last backup timestamp, thresholds), `month_locks` (which months are still unlocked), `damage_items` prices, `staff_directory()`, and their historical `notifications` (which they can also delete).
- **Current Detection:** None.
- **Recommended Fix:** (1) Check `!outcome.profile.active` inside `AuthContext.loadProfile()` and call `supabase.auth.signOut()`; (2) add `exists (select 1 from profiles where id = auth.uid() and active)` to `settings_select`, `locks_select`, `damage_items_select`, `noti_*`, `prefs_*`, `tokens_*`, and `staff_directory()`; (3) ideally ban `auth.users` (`banned_until`) in an Owner RPC when deactivating a user so GoTrue refuses new tokens too.

#### [D5] `expense_categories` SELECT policy allows `is_staff_plus()` despite `/expenses` and `expenses` being OM-only
- **Severity:** `data leak`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `0002_rls.sql` (`categories_select` uses `is_staff_plus()`, whereas `expenses_select` uses `is_owner_manager()`).
- **Misuse Path:**
  1. Staff calls `GET /rest/v1/expense_categories` directly.
  2. Staff reads all internal management expense category names (no amounts, since `expenses` is blocked).
- **Current Detection:** None.
- **Recommended DB Fix:** Tighten `categories_select` to `is_owner_manager()`.

---

### Severity: `minor` (6 Findings)

#### [L1] Unaudited staff-writable tables (`notifications` body tampering & deletion, `notify_prefs`, `push_tokens`) + `log_failed_login` lockout harassment
- **Severity:** `minor`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `0011_phase_c_notifications.sql` (`noti_update`, `noti_delete`, `prefs_*`), `0002_rls.sql` (`tokens_*`), `0036_login_lockout_abuse.sql` (`log_failed_login`).
- **Details:**
  - `notifications`, `notify_prefs`, and `push_tokens` have **no `audit_row_change()` trigger**. Staff can `DELETE` their own notifications or `UPDATE` any column (even `title`/`body`/`created_at`) on own notifications with zero audit trail (pure staff rarely receive notifications today because `om_recipients` excludes staff, unless they have a dual role or receive future staff notices).
  - `log_failed_login(p_username)` is intentionally anon-callable for pre-auth lockout tracking and rate-limited to 30/min globally (`0036`), meaning a disgruntled staff member (or anyone with the publishable key and an Owner's username) can still invoke it 5 times to impose a 15-minute lockout on the Owner's account (denial of service, no money/data loss; logged in `login_logs` only, not `audit_log`).
- **Misuse Path:**
  1. Staff calls `PATCH`/`DELETE` on `/rest/v1/notifications` for own rows → alters/erases own notification history without audit log.
  2. Or staff calls `log_failed_login('owner_username')` 5 times → locks Owner out for 15 minutes (Owner must wait 15 min or reset via SQL).
- **Recommended Fix:** Restrict `noti_update` via a `BEFORE UPDATE` trigger to only allow changing `read_at` (and drop `noti_delete` if not needed in UI — `NotificationBell.tsx` never deletes notifications!).

#### [L2] Latent `is_staff_plus()` clause on `expenses_update` / `expenses_delete` (`0045`)
- **Severity:** `minor`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `0045_edit_own_rows_only.sql:19-27, 70-76`, `0002_rls.sql` (`expenses_select`).
- **Details:** `0045` deliberately mirrored `is_staff_plus() and (is_owner_manager() or created_by = auth.uid())` onto `expenses_update` and `expenses_delete`. Today staff cannot exploit it ONLY because `expenses_select` is `is_owner_manager()` (and PostgreSQL requires `SELECT` visibility to target a row for `UPDATE`/`DELETE`). If `expenses_select` is ever widened, or if a manager creates a same-day expense and is demoted to staff and visibility changes, this becomes immediately active.
- **Misuse Path:**
  1. Currently blocked by `expenses_select` (0 rows visible).
  2. If any future migration grants staff `SELECT` on `expenses`, staff (or a demoted manager) immediately gains `UPDATE`/`DELETE` on matching `created_by` expense rows.
- **Recommended DB Fix:** Change `expenses_update` and `expenses_delete` back to `is_owner_manager()` (since `expenses` is OM-only by design).

#### [L3] `HomePage` Dashboard shows misleading "အသုံးစရိတ်: 0 ကျပ်" and `'—'` author names to staff
- **Severity:** `minor`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `src/pages/HomePage.tsx:323-338, 400-416, 471-476`.
- **Details:** `Dashboard` queries `expenses` (RLS returns `[]` for staff → renders `0 ကျပ်` expense card, making staff think expenses are zero rather than hidden) and resolves `empRows` names via `profiles` (RLS returns only own profile → if another staff member recorded an entry with `received_by = this staff`, that coworker's `created_by` renders as `'—'`).
- **Misuse Path (Human-Error Lens):**
  1. Staff B checks `/` to see how much cash they must hand over today.
  2. Because `Dashboard` groups `empRows` by `created_by` (not `received_by`) and includes rows where Staff A created an entry naming Staff B as receiver under `'—'`, Staff B misreads their own handover total.
- **Recommended Fix:** Hide the expense/net-after-expense cards for non-OM staff, and resolve names with `fetchStaffDirectory()` + group/label by `received_by` where appropriate.

#### [L4] `change_reason` is UI-only on direct `UPDATE` / `DELETE` of `daily_entries` and `agent_payments`
- **Severity:** `minor`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `src/pages/EntriesPage.tsx:660-671`, `src/pages/PaymentsPage.tsx:368, 404`, `0006_phase_a_parity.sql`, `0049_bottle_only_collection.sql:222`.
- **Details:** `edit_daily_entry()` enforces `char_length(v_reason) >= 2` in Postgres, but direct `UPDATE` on `agent_payments` and direct `DELETE` on both `daily_entries` and `agent_payments` do not require `change_reason` at the DB layer — a staff user calling PostgREST directly can edit a payment or delete an entry/payment without recording a reason.
- **Misuse Path:**
  1. Staff sends direct `DELETE /rest/v1/daily_entries?id=eq.<id>` (or `PATCH /rest/v1/agent_payments?id=eq.<id>`).
  2. Succeeds with `change_reason = NULL` (still captured in `audit_log`, just without reason text).

#### [L5] `agent_payments.method` has no DB `CHECK` constraint
- **Severity:** `minor`
- **Status:** `PROVEN FROM CODE`
- **Citations:** `0001_schema.sql` (`method text not null default 'cash'`), `src/pages/PaymentsPage.tsx:35-42, 576-579`.
- **Details:** UI restricts `method` to `cash | kbzpay | wavepay | bank`, but Postgres accepts any arbitrary string on direct API writes.
- **Misuse Path:** Staff sends `method: "other"` or garbage text via PostgREST → stored verbatim and rendered raw in `PaymentsPage` (`METHOD_LABELS[r.method] ?? r.method`).

#### [L6] Own-PIN lock (`0035_owner_only_pin_reset.sql`) depends on live Supabase GoTrue role split — and policy assessment
- **Severity:** `minor` (escalates to **high** if live role split fails!)
- **Status:** `NEEDS LIVE-DB CHECK`
- **Citations:** `supabase/migrations/0035_owner_only_pin_reset.sql:14-27, 43-68`, `SPEC.md` Rule 9.
- **How `0035` works:** Trigger `auth_password_owner_only` on `auth.users` (`BEFORE UPDATE OF encrypted_password`) allows a password change ONLY when `current_user` equals `pg_get_userbyid(proowner)` of `public.admin_reset_pin(uuid,text)`. On standard hosted Supabase, GoTrue (`supabase.auth.updateUser({ password })`) connects as `supabase_auth_admin`, whereas SQL migrations create functions owned by `postgres` — so self-service PIN change is blocked in DB for staff (and everyone else). **However, `0035` itself warns (lines 23–27) that if GoTrue runs as the same DB role that owns `admin_reset_pin`, the trigger cannot distinguish `updateUser` from `admin_reset_pin`!**
- **Misuse Path (if live role split fails or trigger not attached):**
  1. Staff calls `supabase.auth.updateUser({ password: '9999' })` from browser devtools using their JWT.
  2. If GoTrue's DB role equals `admin_reset_pin`'s owner (or if `0035` was not applied on live `auth.users`), staff changes their own PIN (even to a non-digit string, bypassing the digit rule!), violating SPEC Rule 9.
- **Is Owner-only PIN change sensible?** **Yes, for this product's threat model.** Because accounts use short numeric PINs (4–12 digits) on shared/field phones with synthetic emails and no email recovery, letting staff self-change PINs invites lockouts, unapproved sharing, or locking out an account before quitting. The two operational safeguards to keep in place: (a) ensure `0035` is verified live, and (b) keep the `guard_last_owner` (`0026`) invariant + a documented break-glass recovery path if the single Owner ever forgets their PIN (or maintain a trusted backup Owner / Supabase Dashboard access).
- **Exact Live-DB Verification Query (run read-only in Supabase SQL Editor):**
  ```sql
  -- 1. Confirm auth.users triggers from 0035 exist and are enabled
  select tgname, tgenabled, pg_get_triggerdef(oid)
    from pg_trigger
   where tgrelid = 'auth.users'::regclass
     and tgname in ('auth_password_owner_only', 'auth_password_audit');

  -- 2. Confirm admin_reset_pin owner is NOT supabase_auth_admin
  select p.proname, pg_get_userbyid(p.proowner) as func_owner
    from pg_proc p
   where p.oid = 'public.admin_reset_pin(uuid,text)'::regprocedure;
  ```
  Plus safe functional test: sign in as a test staff account and call `supabase.auth.updateUser({ password: '9999' })` — it MUST fail with `pin_change_owner_only`.

---

## Correctly Locked Down

The following controls are **properly enforced in Postgres** (not just UI) and verified from the migration code:

1. **Agent phone numbers (`agent_contacts`, SPEC Rule 2):** Separate table with `contacts_select` = `is_owner_manager() or agent_id = app_agent_id()` (`0002`). Staff cannot read or write any phone numbers via table query or RPC.
2. **Audit log immutability & isolation (`audit_log`, SPEC Rule 5):** `audit_select` is `is_owner_manager()` (`0002`); zero `INSERT`/`UPDATE`/`DELETE` client policies (`0002`, `0005`); no purge function exists. Every business table write (including cascaded payment deletes from `0047`) logs full `old_data`/`new_data` via `audit_row_change()` (`0003`/`0010`).
3. **`created_by` insert & update attribution:** `force_insert_attribution()` (`0005`/`0037`) stamps `created_by := auth.uid()` and `created_at := now()` on every `INSERT` (cannot be spoofed on insert). `0045` `WITH CHECK` prevents staff from reassigning `created_by` on `UPDATE`.
4. **Staff cross-staff isolation on `daily_entries` & `agent_payments`:**
   - **Reads (`0046`):** Staff sees only rows where `created_by = auth.uid() OR received_by = auth.uid()`.
   - **Edits/Deletes (`0045` Rule A + `0049` `edit_daily_entry`):** Staff can edit/delete only rows where `created_by = auth.uid()` (not even rows created by someone else naming them as `received_by`).
5. **Bottle-only collection invariants (`0049`):** Both-zero rejected; `delivered_qty = 0` forces `amount = 0` and rejects non-zero `amount_collected`; entry type (delivery ↔ bottle-only) is immutable on both direct `UPDATE` and `edit_daily_entry`; `payments_guard_source_entry` blocks linking any `agent_payments` row to a bottle-only entry.
6. **`daily_entries.agent_id` immutability (`0048`):** `entries_agent_immutable` blocks changing `agent_id` (including to `NULL`) on `daily_entries` — closing the M2 cascade bypass on `daily_entries` specifically.
7. **Cash handovers (`cash_handovers`):** Fully locked to `is_owner_manager()` on all four operations (`0009`) + `<Guard roles={['owner', 'manager']}>` in UI (`App.tsx:351`).
8. **All management & financial-admin tables:** `expenses` (SELECT/INSERT), `agent_deposits`, `agent_damage_charges`, `agent_settlements`, `write_offs`, `disputes`, `advances`, `advance_repayments`, `bonuses`, `payroll_runs`, `salary_settings`, `login_logs`, `pin_attempts`, `dq_seen`, `month_locks` (write), `app_settings` (write), `profiles` (other users & writes), `user_roles` (writes), `damage_items` (writes), `agents` (writes & delete) are all DB-blocked for staff.
9. **All OM/Owner `SECURITY DEFINER` RPCs:** `collections_summary`, `report_range`, `report_months`, `report_aging`, `data_quality_scan`, `finalize_closeout`, `hard_delete_agent`, `pay_month`, `admin_create_user`, `admin_reset_pin` all check `is_owner_manager()` or active primary `owner` inside the function body, and all internal/cron/trigger functions are revoked from `PUBLIC`, `anon`, and `authenticated` (`0026`, `0028`, `0038`, `0048`–`0050`).
10. **Deactivated staff blocked from all core business data:** `app_role()`, `app_agent_id()`, `has_role()`, `is_owner_manager()`, and `is_staff_plus()` all filter `profiles.active = true` (`0005`, `0006`), immediately cutting off `daily_entries`, `agent_payments`, `agents`, `inventory_movements`, `edit_daily_entry`, `agent_outstanding`, `agent_held_totals`, `agent_detail_stats`, and `inventory_totals`.
11. **Zero UI export surface for staff:** Full JSON backup, monthly Excel/CSV backups, and daily summary CSV are all gated behind Owner/OM-only components (`HomePage` `BackupCard`, `HandoverPage`).

---

## Live-DB Verification Checklist (Read-Only Queries)

Because this review has no live database access, run these read-only checks on production Supabase to confirm live state matches repo migrations `0001`–`0050`:

```sql
-- A. Confirm latest migrations (0045–0050) are applied live
select version from supabase_migrations.schema_migrations
 where version >= '0045'
 order by version;

-- B. Confirm no unexpected extra/legacy RLS policies exist on public tables
select tablename, policyname, cmd, qual, with_check
  from pg_policies
 where schemaname = 'public'
 order by tablename, policyname;

-- C. Confirm every public function's effective EXECUTE grants match 0028/0038/0050
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef as security_definer,
       array_agg(distinct coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC')) as grantees
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 where n.nspname = 'public'
   and a.privilege_type = 'EXECUTE'
 group by p.oid, p.proname
 order by p.proname;

-- D. Confirm 0035 auth.users PIN guard triggers & role split (see L6)
select tgname, tgenabled, pg_get_triggerdef(oid)
  from pg_trigger
 where tgrelid = 'auth.users'::regclass
   and tgname in ('auth_password_owner_only', 'auth_password_audit');

select p.proname, pg_get_userbyid(p.proowner) as func_owner
  from pg_proc p
 where p.oid = 'public.admin_reset_pin(uuid,text)'::regprocedure;

-- E. Check for dual-role agent+staff accounts (M9) or deactivated users with active auth sessions (D4)
select p.id, p.username, p.role, p.active,
       array_agg(ur.role) filter (where ur.role is not null) as extra_roles
  from public.profiles p
  left join public.user_roles ur on ur.profile_id = p.id
 group by p.id
 order by p.role, p.username;
```
