# Bottle Stock Tracking — Independent Design Opinion

- **Date:** 2026-11-28
- **Repo state:** `main @ 2aa3204` (migrations `0001`–`0052` live)
- **Branch:** `docs/bottle-stock-opinion-2026-11-28`
- **Scope:** Design opinion only — no code, migration, or PR.
- **Standing principle:** *"Humans make mistakes — that is why this system exists."* Every screen and rule below is judged by what happens when a busy human forgets a step, enters the wrong number, or tries to cover a mistake.
- **Note on verification:** All code/schema findings below were verified directly against `main @ 2aa3204`. Live database figures (0 movement rows, 1,670 delivered, 1,370 returned, 300 with agents) are taken from the reviewer's 2026-11-28 verification; anything about live operational habits (e.g., whether closed agents currently exist in `agent_settlements` or exact factory fleet size) is marked `UNVERIFIED`.

---

## Q1 — DIAGNOSIS

### Why the current model failed in real use

The current design (`inventory_movements` + `inventory_totals()` in `0023`/`0051:374-403` + `src/pages/InventoryPage.tsx:109-131`) computes:

```text
full       = produced - out + adjustments
empty      = purchased + in - produced - damaged
withAgents = out - in
total      = full + empty + withAgents = purchased - damaged + adjustments
```

where `out = SUM(daily_entries.delivered_qty)` and `in = SUM(daily_entries.returned_qty)`.

This failed for **five structural reasons** (not just poor UI):

1. **Perpetual production recording (`produce`) is an unrewarded, high-frequency chore with no natural trigger.** Delivery (`daily_entries`) succeeds because an agent is standing at the gate exchanging bottles and cash — both sides care. Filling bottles happens continuously on the factory floor with no counterparty and no money attached. Every missed `produce` row permanently shifts bottles out of `full` into `empty`, driving `full` negative (`-1,670` today).
2. **No opening fleet baseline.** Because `purchased` starts at `0`, `total` starts at `0` and `full` starts negative on Day 1. The formula assumes the factory began with zero bottles and logged every single purchase since day zero.
3. **Role/workflow mismatch.** Filling is done on the factory floor, yet `inventory_movements` is Owner/Manager-only in both UI (`App.tsx:319`) and DB (`0051:357-372`). Even if staff wanted to log production, they cannot — and letting staff write free-form stock movements would re-open manipulation risk.
4. **Broken `adjust` semantics and weak accountability.** In `InventoryPage.tsx:113-116, 126`, `adjust` blindly adds to **both** `full` and `total`. It cannot express "I counted 20 more filled and 20 fewer empty (fleet unchanged)" without corrupting total fleet, and `inventory_movements.notes` is nullable with no DB check enforcing a reason (`0001_schema.sql:102`). Dead `in`/`out` kinds also remain in `inventory_movements_kind_check` (`0006:518`, `0016:48`) even though `inventory_totals()` ignores them.
5. **Two hidden DB accounting bugs already silently corrupt `withAgents`:**
   - **Closeout bug (`0031_agent_close_columns.sql:138-171`):** `finalize_closeout()` records `returned_bottles` and `missing_bottles` in `agent_settlements` and sets `agents.closed_at`, **without writing to `daily_entries` or `inventory_movements`**. Meanwhile `inventory_totals()` (`0051:387-390`) and `agent_held_totals()` (`0021:111-114`) sum `daily_entries` across **all** agents. Any closed agent's returned and missing bottles remain counted in `withAgents` forever. (`UNVERIFIED` whether any closed agents exist in live DB today.)
   - **Damage-charge disconnect (`0042_damage_charges.sql`):** Whole-bottle damage charges increase `agent_outstanding()` (`0042:198-203`) but never reduce `fleet` or `withAgents` (and `entries_before_write()` in `0051:188-201` still counts destroyed bottles against the agent's deposit cap!).

### Is it salvageable with better UX?

**No.** Better buttons, reminders, or a staff "produce" form cannot fix a perpetual-production ledger. Under the owner's principle, any design where *one forgotten afternoon filling log permanently makes the dashboard lie* is fundamentally the wrong model for a small water factory. Also note `notify_prefs.alert_stock` (`0016:29`, `SettingsPage.tsx:132,166,215`) is currently a dead toggle with no backend emitter (`rg` across `supabase/migrations/` confirms zero references after `0016`).

**Verdict:** Fundamentally wrong model — abandon perpetual `produce` tracking rather than polishing the existing `InventoryPage` UX.

---

## Q2 — YOUR MODEL

### Comparison of options

| Dimension | Option A: Movement-based + better UX | Option B: Fleet total minus agents + periodic physical count | Option C (Recommended): **Hybrid B+ — Owner Fleet Ledger + Canonical Agent Held + Blind Factory Count Snapshots** |
|---|---|---|---|
| **Q1 Total fleet** | `purchased − damaged + adjust` (corrupted by `adjust`) | `opening + purchases − losses` | **Append-only/same-day-guarded fleet ledger** (`opening + purchases − factory_losses − agent_destroyed − closeout_missing ± resolved_count_writeoffs`), Owner-only, mandatory reason in DB |
| **Q2 Out with agents** | `SUM(delivered − returned)` (leaks closed agents + destroyed bottles) | `SUM(delivered − returned)` | **Single canonical DB formula `agent_held_bottles()`**: `daily_entries(delivered − returned) − agent_destroyed_bottles − agent_settlements(returned + missing)` |
| **Q3 At factory (Filled vs Empty)** | Computed from `produce` (drifts whenever filling is forgotten) | `at_factory = fleet − withAgents`; Filled/Empty from physical counts | **`at_factory = fleet − withAgents` always live & exact**; Filled/Empty split from **blind physical count snapshots** (`bottle_counts`) with staleness badge + optional non-authoritative "since count" delivery delta |
| **When a human forgets** | `full` drifts negative silently forever | Fleet & `at_factory` stay exact; split simply shows last count date | Fleet & `at_factory` stay exact; if Owner skips counting for >N days, UI + digest show a gentle stale-count reminder — never a fake number |
| **Extra daily work** | High (must log every filling batch) | Zero daily extra work (only periodic count + rare fleet events) | **Zero mandatory daily extra work**; rare fleet events + 30-second periodic blind count |

### Recommended model (Option C — Hybrid B+) in detail

1. **Question 1 — Total Fleet (`fleet_total`):** Computed strictly from DB ledger rows — **never** a directly editable number on `app_settings`:
   ```text
   fleet_total = opening_fleet
               + SUM(purchases)
               - SUM(factory_losses)
               - SUM(agent_destroyed_bottles)      -- from whole-bottle damage charges + waived agent losses
               - SUM(closeout_missing_bottles)     -- from agent_settlements.missing_bottles
               + SUM(reconciliation_adjustments)   -- Owner-approved write-offs / surplus resolutions from physical counts
   ```
   - **Who records:** **Owner only** (`app_role() = 'owner'`). Purchases and fleet losses are rare (weekly/monthly) capital events, not daily staff tasks.
   - **Where:** `InventoryPage` (for opening, purchases, factory losses, count write-offs) and `AgentDetailPage` (for agent whole-bottle damage charges / closeout).

2. **Question 2 — Out with Agents (`with_agents`):** Derived automatically from existing daily workflows — **zero new daily clicks**:
   ```text
   agent_held(a) = SUM(daily_entries.delivered_qty - returned_qty for a)
                 - SUM(agent_damage_charges.qty for a WHERE destroys_bottle = true)
                 - SUM(fleet_events.qty for a WHERE kind = 'agent_loss_waived')
                 - SUM(agent_settlements.returned_bottles + missing_bottles for a)

   with_agents   = SUM(agent_held(a)) across all agents
   ```
   - **Who records:** Existing actors on existing screens (`EntriesPage` by staff/OM; `AgentDetailPage` damage charges & closeout by Owner).
   - **Bonus safety win:** Reusing one DB helper `agent_held(a)` in `inventory_summary()`, `agent_held_totals()`, `entries_before_write()` (deposit cap), `finalize_closeout()`, and `run_data_quality_alerts()` eliminates all four copies of the raw `delivered - returned` formula and fixes the `0031` closeout leak.

3. **Question 3 — At Factory (`at_factory = fleet_total - with_agents`):**
   - **Total at factory** is live and exact every second of the day because both `fleet_total` and `with_agents` are live and exact.
   - **Filled (`အပြည့်`) vs Empty (`အခွံ`)** comes from periodic **blind physical counts** (`bottle_counts` table, recorded by Owner/Manager on `InventoryPage` — details in Q3 & Q4).

4. **What happens when someone forgets?**
   - **Forgets to log filling:** Nothing breaks — there is no filling log!
   - **Forgets to do a physical count for several days:** `fleet_total`, `with_agents`, and `at_factory` remain 100% live and accurate. Only the Filled/Empty split shows its real timestamp (e.g., *"လွန်ခဲ့သော ၄ ရက်က ရေတွက်ထားသည်"*) with an amber nudge to recount.
   - **Forgets to log a delivery or return (`daily_entries`):** Caught on the next physical count as a non-zero discrepancy (`counted != expected_at_factory`), AND caught same-day by `cash_handovers` blind count + `run_data_quality_alerts()` (`0050`).
   - **Forgets to log a broken bottle:** Caught on the next physical count as a `−N` shortage (Q4 & Q8).

**Verdict:** Adopt **Option C (Hybrid B+)** — Owner fleet ledger + unified `agent_held()` + blind physical-count snapshots for the Filled/Empty split.

---

## Q3 — FULL/EMPTY SPLIT

### Why estimating production between counts is a trap

It is tempting to try to "live-update" Filled/Empty between physical counts by subtracting deliveries from `last_filled` and adding returns to `last_empty`. **Do not present that as the live split:** the moment the factory fills 80 bottles between counts without logging it, `estimated_filled` drops to zero or negative — recreating the exact bug that broke the current page!

### What the Owner should see (phone-first, at a glance)

Top of `InventoryPage` (and a compact summary card on Owner `HomePage`):

1. **Row 1 — 3 Live, Guaranteed-Accurate Numbers (big cards):**
   - **စက်ရုံပိုင် စုစုပေါင်း (Total Fleet):** e.g., `800 ဗူး`
   - **ကိုယ်စားလှယ်များလက်ထဲ (With Agents):** e.g., `300 ဗူး` *(tappable → Agents breakdown)*
   - **စက်ရုံထဲ လက်ကျန် (At Factory):** e.g., `500 ဗူး` *(live: `800 − 300`)*

2. **Row 2 — Factory Split Card (Honest Snapshot, Never Fake):**
   - Shows the **last physical count** with an explicit timestamp and freshness chip:
     - **အပြည့် (Filled):** `320 ဗူး` · **အခွံ (Empty):** `180 ဗူး`
     - Subtitle: `နောက်ဆုံးရေတွက်ချိန်: ယနေ့ 6:00 PM (စုစုပေါင်း 500 ဗူး · ကိုက်ညီ)`
   - **Between counts (when `at_factory` has moved since the last count):** show a single honest reference line — **never** a guessed filled/empty number:
     - e.g., `ရေတွက်ပြီးနောက်ပိုင်း: ပို့ −60 ဗူး · ပြန် +40 ဗူး (လက်ရှိ စက်ရုံထဲ 480 ဗူး)`
     - One-tap button right on the card: **`ဗူးရေတွက်မည်` (Count Now)**.
   - **Staleness nudge:** If the last count is older than a configurable threshold (default e.g. **7 days**, or **3 days** if Owner prefers weekly vs twice-weekly counting — mirrors `isBackupOverdue()` in `HomePage.tsx:78`), highlight the split card in amber with `ရေတွက်ရန် ကျန်နေပါတယ်`.

3. **Optional zero-pressure morning habit (never required):** If the Owner wants an accurate morning Filled/Empty split before dispatch, doing a 30-second count at end-of-day (after the last truck returns, e.g., 6:00 PM alongside `HandoverPage`) gives **both** tomorrow morning's starting Filled/Empty split AND a daily loss check — while skipping a day never corrupts any number.

**Verdict:** Never fabricate live Filled/Empty numbers from unrecorded production — show live `Total / With Agents / At Factory` alongside the timestamped last physical count and a clear staleness nudge.

---

## Q4 — RECONCILIATION

### Blind physical count (reusing the `HandoverPage` pattern)

`src/lib/handoverCount.ts` (`0050` Package A) proved a great human-error defense: hide `expected` until the human types what they physically counted, so nobody lazily copies the system's number and misses a mistake. Apply the **exact same blind-count pattern** to factory bottle counts (`bottle_counts` table):

1. **Step 1 — Blind input:** OM taps `ဗူးရေတွက်မည်` (ideally at end-of-day when trucks are parked). The modal/drawer **hides** `expected_at_factory` and asks for only two integers:
   - `အပြည့် (Filled)`
   - `အခွံ (Empty)`
   *(Live sum shown as `ရေတွက်စုစုပေါင်း = filled + empty`, with optional note.)*
2. **Step 2 — Reveal & compare:** Once both fields are entered and the user taps **စစ်ဆေးမည် (Check)** (or reveals on submit, mirroring `evaluateHandoverRow()`), the system queries live `expected_at_factory = fleet_total - with_agents` at that instant and computes:
   ```text
   counted_total = filled_count + empty_count
   diff          = counted_total - expected_at_factory
   ```
3. **Step 3 — Three explicit outcomes:**
   - **`diff === 0` (`match` — ကိုက်ညီပါတယ်):** Save `bottle_counts` row with `status = 'matched'`. Updates the Filled/Empty split snapshot immediately; `fleet_total` is untouched.
   - **`diff < 0` (`short` — `−N ဗူး လျော့နေသည်`):** **NEVER auto-subtract from fleet.** Save the `bottle_counts` row with `status = 'open'` (recording `filled_count`, `empty_count`, `expected_at_factory`, `diff`), trigger a high-priority OM notification if unresolved, and present two explicit paths (detailed in Q8):
     1. **Investigate first** (check today's `EntriesPage` / unentered returns / parked truck — recount once fixed, which marks the prior open discrepancy `superseded` or `resolved_by_recount`).
     2. **Owner-only write-off** (accept `−N` as unexplained factory loss with mandatory reason → creates linked fleet write-off event and marks count `resolved_writeoff`).
   - **`diff > 0` (`over` — `+N ဗူး ပိုနေသည်`):** **NEVER auto-add to fleet.** Save with `status = 'open'`; prompt OM to check for an unrecorded agent return, unrecorded bottle purchase, or miscount. Owner can either recount after fixing the missing entry, or (Owner-only, mandatory reason) record a `count_surplus` reconciliation event.

4. **Server-side integrity:** The `expected_at_factory` stored on `bottle_counts` is computed **inside Postgres** (via `BEFORE INSERT` trigger or `record_bottle_count()` RPC), never trusted from the client — so nobody can forge a fake "0 diff" count over PostgREST.

**Verdict:** Use a DB-verified **blind physical count** (`bottle_counts`) modeled directly on `HandoverPage`; discrepancies must pause for investigation or explicit Owner resolution and never auto-adjust fleet.

---

## Q5 — STARTING POINT

### Exact Day-1 bootstrap (no history reconstruction required)

We do **not** need to reconstruct past purchases, filling, or historical breakages. Establish the baseline in **3 steps on one quiet evening** (after all trucks are back and today's `daily_entries` are entered):

1. **Step 1 — Verify the current agent-held list (today's ~300 bottles):**
   - Owner opens the per-agent held list (`/agents`).
   - Fix the `0031` closeout leak in the migration first so any already-closed agents (`UNVERIFIED` if any exist live) automatically drop to `0` held.
   - If any active agent's system `held` differs from reality due to historical unrecorded returns or old broken bottles before launch, Owner settles it cleanly **before** Step 3 (either via a bottle-only return entry for unreturned empties, or an Owner opening-reconciliation entry / whole-bottle damage charge). Do not rewrite old rows.
   - Call the resulting verified sum **`A₀`** (e.g., `300 ဗူး`).

2. **Step 2 — Physically count the factory floor once:**
   - Walk the factory floor and count **Filled (`F₀`)** + **Empty (`E₀`)** (exclude permanently broken/unusable bottles sitting in a scrap pile — only count active fleet bottles).

3. **Step 3 — Enter ONE `opening` baseline (guided Owner-only setup card on `InventoryPage`):**
   - While no `opening` event exists yet, `InventoryPage` shows a clean one-time setup card instead of broken negative numbers:
     - Shows read-only live `ကိုယ်စားလှယ်များလက်ထဲ (A₀)` (with link to review `/agents`).
     - Asks Owner for `စက်ရုံထဲ အပြည့် (F₀)` and `စက်ရုံထဲ အခွံ (E₀)`.
     - Displays preview: `စက်ရုံပိုင် စုစုပေါင်း = F₀ + E₀ + A₀`.
   - On confirm, ONE atomic Owner-only RPC (`initialize_bottle_stock(p_filled, p_empty, p_note)`) executes:
     - Inserts a single `fleet_events` row: `kind = 'opening'`, `qty = F₀ + E₀ + A₀`, `reason = 'စတင်သတ်မှတ်ချက် ...'` (DB unique partial index `where kind = 'opening'` ensures this bootstrap can only run once — cannot be abused later to silently inflate fleet!).
     - Inserts the initial `bottle_counts` snapshot: `filled_count = F₀`, `empty_count = E₀`, `expected_at_factory = F₀ + E₀`, `diff = 0`, `status = 'matched'`.
   - Immediately after that single tap, all three Owner questions show true numbers (`Total = F₀ + E₀ + A₀`, `With Agents = A₀`, `At Factory = F₀ + E₀`, split `F₀` / `E₀`).

*(Legacy `inventory_movements` currently has 0 rows in live DB per reviewer verification, so there is zero historical movement data to migrate or preserve.)*

**Verdict:** Bootstrap in 5 minutes via a single one-time Owner-only `initialize_bottle_stock()` RPC using live verified `withAgents` plus one physical factory count (`F₀`, `E₀`) — zero history reconstruction.

---

## Q6 — SCOPE

### Concrete breakdown (files, migrations, rough size)

| Piece | Files / Objects | Size | Phase |
|---|---|---|---|
| **1. Canonical `agent_held()` + closeout & damage-charge link** | New migration `0053_bottle_stock.sql` (+ `apply_all.sql`): add `destroys_bottle boolean` to `damage_items` & snapshot column on `agent_damage_charges` (`damage_charge_snapshot()`); create `agent_held(p_agent)` helper; update `agent_held_totals()`, `entries_before_write()`, `finalize_closeout()`, `run_data_quality_alerts()`. | **Medium** | **MVP (Phase 1)** |
| **2. Fleet ledger + blind physical counts (DB)** | Same migration `0053`: `fleet_events` table (or refactored `inventory_movements` with strict kinds + mandatory reason + `source_damage_charge_id` / `source_count_id` FKs + RLS/audit/same-day/month-lock triggers), `bottle_counts` table, RPCs: `bottle_stock_summary()`, `initialize_bottle_stock()`, `record_bottle_count()`, `resolve_bottle_count()`. SQL test suite additions in `tests/sql/`. | **Medium** | **MVP (Phase 1)** |
| **3. New phone-first `InventoryPage` + `DamageItemsPage` toggle** | `src/pages/InventoryPage.tsx` (rewrite around 3 live KPI cards + Filled/Empty snapshot card + blind count modal + fleet event form + discrepancy resolution + history), `src/pages/DamageItemsPage.tsx` (add `ဗူးပျက်စီး/ပျောက်ဆုံး (စာရင်းလျှော့မည်)` toggle per item), `src/pages/AgentDetailPage.tsx` & `HomePage.tsx` (show canonical `agent_held()` + compact Owner stock card), `src/lib/bottleCount.ts` (pure blind-count helpers + Vitest unit tests), `src/lib/i18nDict.ts`, `src/lib/backup.ts` (include new tables!). | **Medium** | **MVP (Phase 1)** |
| **4. Evening digest + stock/stale-count alerts** | Extend `send_daily_digest()` (`0050`) with a 1-line bottle summary (`ဗူးစုစုပေါင်း / ကိုယ်စားလှယ် / စက်ရုံ`) + wire up the currently dead `notify_prefs.alert_stock` toggle for open count discrepancies and overdue physical counts (>7 days). | **Small** | **Phase 2 (Later)** |
| **5. Printable/exportable stock audit report** | Add fleet events & physical count log tab to `src/lib/exports.ts` monthly Excel/CSV backup. | **Small** | **Phase 2 (Later)** |

### What should NOT be built

- **Do NOT build a production/filling log** (`produce` screen, shift-filling counter, batch numbers) — it will be forgotten within a week.
- **Do NOT build per-bottle barcodes/QR/serial tracking** — massive operational friction for 20L water jars.
- **Do NOT allow staff to record fleet losses or physical count write-offs** — creates a direct theft-hiding channel (see Q8).
- **Do NOT build live "estimated Filled/Empty" math** between counts — fake precision destroys trust faster than an honest timestamp.
- **Do NOT keep `inventory_movements`'s dead `in`/`out`/`produce` kinds** — clean break (0 live rows today makes this painless).

**Verdict:** Medium-sized single-migration MVP (DB + `InventoryPage` + `DamageItemsPage` flag + tests), cleanly split from Phase 2 digest/export polish; explicitly skip production logging and fake live estimates.

---

## Q7 — RISKS

1. **Mid-day counting while trucks are out (Timing Risk — High):**
   - If OM counts factory bottles at 1:00 PM while a staff member has loaded 50 bottles onto a truck *without entering the `daily_entries` row yet*, the blind count will falsely show `−50` short!
   - **Mitigation:** Display a clear pre-count reminder ("ယနေ့ ပို့ပြီး/ပြန်ရပြီး မှတ်တမ်းများ အကုန်သွင်းပြီးမှ ရေတွက်ပါ — ညနေပိုင်း အကောင်းဆုံး"), and **never** auto-write-off a shortage (the default primary action on a discrepancy is "Check today's entries & recount later", not "Write off").
2. **Offline / delayed sync on shared phones (Race Risk — Medium):**
   - If a staff phone has unsynced entries (or two staff share a phone and enter a delivery 10 minutes after leaving the gate), `expected_at_factory` lags behind physical reality at the exact moment of counting.
   - **Mitigation:** Same as above — saving a discrepancy as `open` (without mutating fleet) lets delayed entries sync and clear the difference on a quick recount; show the timestamp of the last `daily_entries` row right on the discrepancy screen ("နောက်ဆုံး ပို့ဆောင်မှု မှတ်တမ်း: 5:42 PM").
3. **Owner stops doing physical counts (Habit Decay — Medium):**
   - Because nothing breaks when counts are skipped, the Owner might stop counting for 2 months — letting unrecorded breakages accumulate silently and letting the Filled/Empty split go stale.
   - **Mitigation:** Honest staleness banner on `InventoryPage` + Owner `HomePage` after 7 days without a count, plus Phase 2 `alert_stock` reminder — gentle, impossible to miss, zero false numbers.
4. **Honest weakest point of this design:**
   - **Between physical counts, the Filled vs Empty split is NOT live.** If the Owner is away from the factory at 2:00 PM and asks "do I have 100 *filled* bottles ready right now for a sudden large order?", the app can tell him "you have 480 bottles at the factory, and at 6:00 PM yesterday 320 were filled" — it cannot know how many empty bottles staff filled at 11:00 AM today without someone either tapping a quick count or checking the floor. That is a deliberate, honest trade-off: **we choose "slightly stale honest split" over "confident wrong negative numbers."**

**Verdict:** Main real-world hazards are counting mid-trip (before entries are logged) and letting counts go stale — mitigated by never auto-adjusting on discrepancy and nudging after 7 days; the honest trade-off is that Filled/Empty is snapshot-based rather than live.

---

## Q8 — LOST & DAMAGED BOTTLES

### 1. Where and how losses are recorded (roles, fields, 3-number impact)

Every bottle that permanently leaves the fleet falls into **one of four mutually exclusive paths**, each with an exact accounting effect:

| Path | Who records | Screen | Required fields | Total Fleet | With Agents | At Factory |
|---|---|---|---|---|---|---|
| **A. Factory-side loss** (dropped/cracked/condemned at factory) | **Owner only** *(Manager may optionally flag a pending note, or Owner records directly — recommend Owner-only write for MVP, matching `write_offs` & `damage_items`)* | `InventoryPage` | `qty > 0`, `reason` (≥ 2 chars), `event_date` (today; backdate Owner-only via `0018` rule) | **−N** | 0 | **−N** |
| **B. Agent-side loss — billed** (agent breaks/loses whole bottle & is charged) | **Owner only** (existing `0042` rule) | `AgentDetailPage` → Damage Charge | `agent_id`, `item_id` (where `destroys_bottle = true`), `qty > 0`, `note` | **−N** | **−N** *(for that agent)* | **0** |
| **C. Agent-side loss — waived / closeout missing** (forgiven defective bottle OR `missing_bottles` forfeited at closeout) | **Owner only** | `AgentDetailPage` (waived loss form or Closeout wizard) | `agent_id`, `qty > 0`, `reason` (≥ 2 chars) | **−N** | **−N** *(for that agent)* | **0** |
| **D. Unrecorded loss found at physical count** (`counted < expected_at_factory`) | **Owner only** (resolving an open `bottle_counts` row) | `InventoryPage` → Open Discrepancy | `count_id`, `qty = abs(diff)`, `reason` (≥ 2 chars) | **−N** | 0 | **−N** *(brings expected down to match physical count)* |
| *(Contrast)* **Parts damage** (cap `အဖုံး`, tap `ရေတပ်ခေါင်း`, etc.) | **Owner only** | `AgentDetailPage` → Damage Charge | `agent_id`, `item_id` (`destroys_bottle = false`), `qty > 0` | **0** | **0** | **0** *(money only)* |

*(Note: Why does Path B leave **At Factory** at `0`? Because those `N` bottles were already out with the agent! Both `Total Fleet` and `With Agents` drop by `N`, so `At Factory = Fleet − With Agents` is unchanged — mathematically exact.)*

---

### 2. Linking agent-side loss with existing `agent_damage_charges` (`0042`)

**Should a bottle-destroying damage charge also reduce fleet AND agent-held in the same atomic action? YES — non-negotiable.**

If money and stock are recorded in two separate screens, humans *will* record one and forget the other — and worse, if `agent_held(a)` doesn't decrease when an agent pays for a destroyed bottle, `entries_before_write()` (`0051:188-201`) will keep blocking them against their deposit cap and `finalize_closeout()` (`0031`) will charge them a second time for the same bottle!

**Clean atomic DB mechanism (reusing the proven `0042` snapshot + `0047`/`0051` FK-link patterns):**

1. **Parts vs Whole-Bottle flag:** Add `destroys_bottle boolean not null default false` to `damage_items` (`0042`).
   - Caps (`အဖုံး`), dispenser taps (`ရေတပ်ခေါင်း`), handles → `destroys_bottle = false` (money only).
   - Cracked/lost whole bottle (`ဗူးကွဲ/ဗူးပျောက်`) → `destroys_bottle = true` (money + stock).
2. **Snapshot at charge time:** Add `destroys_bottle boolean not null default false` to `agent_damage_charges`, populated strictly inside `damage_charge_snapshot()` (`BEFORE INSERT` trigger, ignoring client input — identical to `item_name` and `unit_price` in `0042`). Changing an item later never rewrites historical stock!
3. **Single atomic stock impact (zero drift, zero orphan rows):**
   - **Option 2a (Recommended — Atomic trigger + FK cascade):** An `AFTER INSERT` trigger on `agent_damage_charges` inserts a linked row into `fleet_events` (`kind = 'agent_damage_loss'`, `qty = -new.qty`, `agent_id = new.agent_id`, `source_damage_charge_id = new.id`, `reason = new.item_name || coalesce(': ' || nullif(trim(new.note), ''), '')`) whenever `new.destroys_bottle = true`.
   - `source_damage_charge_id uuid unique references agent_damage_charges(id) on delete cascade`: if Owner deletes a mistaken damage charge same-day (the `0042` correction path), Postgres **atomically deletes the linked `fleet_events` row in the same transaction**!
   - A `BEFORE UPDATE OR DELETE` guard on `fleet_events` rejects direct client edits/deletes on rows where `source_damage_charge_id is not null` (exact same pattern as `0051`'s `linked_payment_immutable`), and rejects direct client `INSERT` of `kind = 'agent_damage_loss'`.
   - Result: **Money and stock can NEVER diverge**, there is ONE unified `fleet_events` ledger for auditing every single bottle that ever entered or left the fleet, and same-day delete cleanly reverses both debt and stock together!
   - *(Note on existing live damage charges before migration `0053`: default `destroys_bottle = false` so historical rows are untouched; any pre-existing lost bottles are naturally excluded when counting `F₀`, `E₀`, and verifying `A₀` during Q5 bootstrap.)*

---

### 3. Unrecorded loss found at physical count (`−N` unexplained) — UI + DB enforcement

When a blind count finishes with `diff = -N` (e.g., counted `495` vs expected `500`, `diff = -5`):

1. **App UI flow:**
   - Count is saved as `bottle_counts(status = 'open', diff = -5)` — **fleet does NOT change yet**.
   - Banner displays: `စက်ရုံထဲ ၅ ဗူး လျော့နေပါတယ် (စာရင်း 500 · ရေတွက် 495)`.
   - **Primary action (recommended first):** **`ယနေ့ မှတ်တမ်းများ စစ်မည်`** (links to `/entries` & `/agents`) + **`ပြန်ရေတွက်မည်` (Recount)**. If an unentered delivery/return is found and a new count matches (`diff = 0`), the open discrepancy is automatically marked `resolved_recount` with zero fleet change.
   - **Secondary action (Owner only, collapsed/deliberate):** **`ပျောက်/ပျက် စာရင်းလျှော့မည် (Write-off −5 ဗူး)`**. Requires typing a non-empty reason (e.g., *"ဂိုဒေါင်ထဲ ဗူးကွဲ ၃ + အကြောင်းရင်းမသိ ၂"*). Calls `resolve_bottle_count(p_count_id, 'writeoff', p_reason)` which atomically:
     1. Inserts `fleet_events(kind = 'count_writeoff', qty = -5, source_count_id = p_count_id, reason = p_reason)`.
     2. Updates `bottle_counts` row to `status = 'resolved_writeoff'`, `resolved_by = auth.uid()`, `resolved_at = now()`, `resolution_note = p_reason`.
   - Manager can perform the blind physical count (flagging the discrepancy honestly), **but cannot approve the write-off** — only Owner (`app_role() = 'owner'`) can reduce the fleet.

2. **Database-level enforcement ("fleet never changes without who/why"):**
   - **No mutable fleet column:** `fleet_total` is computed strictly by summing `fleet_events` (+ `agent_settlements.missing_bottles` or mirrored via trigger into `fleet_events` on `finalize_closeout()`). There is no `fleet_total` column on `app_settings` that anyone can `UPDATE`.
   - **Mandatory who:** `force_insert_attribution()` (`BEFORE INSERT`) overwrites `created_by := auth.uid()` from the JWT (cannot be spoofed or nulled).
   - **Mandatory why:** Table-level `CHECK (char_length(btrim(reason)) >= 2)` on `fleet_events` — PostgREST rejects blank or whitespace-only reasons even if UI is bypassed.
   - **Strict RLS & immutability:**
     - `fleet_events`: `INSERT` & same-day `DELETE` **Owner only** (`app_role() = 'owner'`); **NO `UPDATE` policy** (append-only ledger, same as `agent_damage_charges` & `write_offs`); `audit_row_change()` trigger logs every insert/delete into insert-only `audit_log`; `guard_same_day_edit()` + `guard_month_lock()` apply to **all** roles including Owner.
     - `bottle_counts`: `INSERT` OM (`is_owner_manager()`), `expected_at_factory` and `diff` computed server-side by trigger/RPC, `resolution` transitions restricted to Owner via `SECURITY DEFINER` RPC (`resolve_bottle_count()`), audited in `audit_log`.

---

### 4. Abuse & human-error defenses

| Threat / Error | How the system prevents or catches it |
|---|---|
| **1. Staff blaming "broken/lost bottles" to hide theft** | **Prevented in DB:** Staff have **zero** INSERT/UPDATE/DELETE permission on `fleet_events`, `bottle_counts`, and `agent_damage_charges`. Even Manager cannot approve a `fleet_events` loss or `count_writeoff` — **Owner only**. If staff steal bottles at the factory, the blind physical count exposes a `−N` shortage directly to the Owner; if staff fake a return or delivery, the agent immediately gets a receipt notification (`0011`/`0041`) and sees the wrong held count on `/my`. |
| **2. Agent disputing an attributed loss** | **Already built-in & reused:** Because billed agent losses go through `agent_damage_charges`, the existing `damage_charges_notify` trigger (`0042:143-171`) **immediately sends the agent a receipt notification** naming the item, qty, and total (extend the same receipt notification to `agent_loss_waived` too). The agent sees the charge on `/my` (`HomePage.tsx:674-686`) and can open a `/disputes` ticket (`DisputesPage.tsx`), which goes straight to OM (never staff). If the Owner agrees it was a mistake same-day, deleting the damage charge atomically restores both money and stock; after midnight (same-day lock), Owner corrects via compensating write-off/adjustment with full audit trail. |
| **3. Double-recording the same loss** (damage charge **AND** manual factory write-off) | **Prevented in UX + caught in DB:** (a) When Owner records a `destroys_bottle = true` damage charge, the success banner explicitly states `"စက်ရုံဗူးစုစုပေါင်း နှင့် ကိုယ်စားလှယ်လက်ကျန် -N ဗူး အလိုအလျောက် လျှော့ပြီးပါပြီ — စတော့စာမျက်နှာတွင် ထပ်မံလျှော့ရန် မလိုပါ"`. (b) On `InventoryPage`, the factory-loss form explicitly warns `"စက်ရုံအတွင်း ပျက်စီး/ပျောက်ဆုံးမှုများအတွက်သာ (ကိုယ်စားလှယ် ဗူးပျက်စီးပါက ကိုယ်စားလှယ် စာမျက်နှာ → ပျက်စီးကြေး မှ ထည့်ပါ)"`, and shows today's recent `agent_damage_loss` events right beside the form. (c) If Owner still double-records it, the very next blind physical count immediately shows **`+N` surplus (`over`)**, exposing the double subtraction! (d) On `fleet_events`, `UNIQUE (source_damage_charge_id)` and `UNIQUE (source_count_id)` prevent programmatic/retry duplicates at the DB level. |

**Verdict:** Add `destroys_bottle` (snapshotted) on `damage_items`/`agent_damage_charges` with an atomic FK-cascaded `fleet_events` link, make all fleet reductions Owner-only with DB-enforced non-empty `reason` + `audit_log`, and require explicit Owner resolution (never auto-adjustment) on physical-count shortages.

---

## Final Recommended Design (≤ 10 Lines)

1. **Drop perpetual `produce` tracking**; replace `inventory_movements` with an Owner-only, append-only **`fleet_events`** ledger (`opening`, `purchase`, `factory_loss`, `agent_damage_loss`, `agent_loss_waived`, `closeout_missing`, `count_writeoff`, `count_surplus`) with DB-enforced `reason` (≥ 2 chars), `created_by`, `audit_log`, same-day lock, and month lock.
2. **Create one canonical DB function `agent_held(agent_id)`** = `daily_entries(delivered − returned) − agent_destroyed_bottles − agent_settlements(returned + missing)` and reuse it in stock summary, `/agents`, deposit-cap checks (`entries_before_write`), closeout, and anomaly alerts — fixing the `0031` closeout leak.
3. **Answer all 3 Owner questions at a glance:** Live **Total Fleet** (`SUM(fleet_events)`), Live **With Agents** (`SUM(agent_held)`), Live **At Factory** (`Fleet − With Agents`), plus the timestamped **Filled / Empty** split from the latest physical count (never fabricated between counts).
4. **Add `bottle_counts` blind physical counts** (mirroring `HandoverPage`): OM enters counted Filled + Empty before seeing `expected_at_factory`; DB computes `expected` & `diff`; discrepancies save as `open` (investigate/recount first) and NEVER auto-mutate fleet.
5. **Link agent bottle loss atomically to `agent_damage_charges` (`0042`):** add `destroys_bottle` on `damage_items` (snapshotted on charges) so parts (cap/tap) affect money only, while whole-bottle destruction atomically inserts/cascade-deletes a linked `fleet_events` row (reducing Fleet & Agent Held, leaving At Factory unchanged, notifying the agent for dispute rights).
6. **Prevent theft cover-ups & double-counting:** Staff cannot write stock/losses; Manager can submit blind counts but **only Owner** can record losses or approve `count_writeoff`; `UNIQUE` source FKs block duplicate writes and a next-count `+N` surplus catches manual double-entry.
7. **Bootstrap once in 5 minutes** via an Owner-only `initialize_bottle_stock(filled, empty)` RPC (enforced single-use via partial unique index on `kind = 'opening'`) combining verified live `With Agents` + one physical floor count — zero history reconstruction.
8. **Ship as one medium MVP migration (`0053`) + `InventoryPage`/`DamageItemsPage` UI**; defer evening-digest stock line, `alert_stock` wiring, and Excel export to Phase 2.
