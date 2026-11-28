# Human-Error Protection — Understanding Check & Codebase Gap Review

- **Date:** 2026-11-28
- **Repo baseline:** `main` at `939c410` (through PR #36 / migration `0049`)
- **Scope:** Read-only architectural & UX review prompted by the U Aye Myint (`2026-11-20`) `20,000` MMK under-recording incident (`docs/reports/uam-balance-audit-2026-11-28.md`). No code modified; no PR opened.
- **Assumptions:**
  1. Most daily data entry happens on phones by non-technical staff under time pressure (SPEC: phone-first, end-user convenience outranks visual cleverness).
  2. Not every agent checks the app in real time (some agents have active accounts, some may check infrequently or rely on verbal confirmation), so protection cannot depend *solely* on agents noticing mistakes — evening physical cash reconciliation by Owner/Manager remains essential.
  3. All SPEC non-negotiable rules remain fixed: same-day edit/delete only (`Asia/Yangon`, ALL roles including Owner), month lock (ALL roles), immutable insert-only `audit_log`, server-side enforcement.

---

## Part 1 — Understanding of the Owner's Design Principle

### 1. What this principle means for how we build in this repo
Up to now, this codebase has been strong on **security rules** (RLS isolation, same-day guards, month locks, immutable audit log) and **arithmetic exactness** (`allocateCash()`, `edit_daily_entry()`, `agent_outstanding()`). The U Aye Myint incident exposed a third pillar that matters just as much: **human-input defence**.

Treating human-error protection as a standing design rule changes how every feature is designed and reviewed:
- **Correct arithmetic is necessary but insufficient.** A clean split of a mistyped `300,000` instead of `320,000` silently corrupts the next day's automatic allocation because `allocateCash()` trusts the stored balance.
- **Every screen must be stress-tested against realistic human failure modes**, not just malicious bypasses: mistyping a zero in 6-digit MMK numbers, tapping Save twice on patchy cellular data, forgetting to change a sticky agent/receiver dropdown, forgetting to clear an auto-filled field, or rubber-stamping a pre-filled handover total.
- **Usability and safety must work together, never against each other.** Putting heavy friction on every routine action creates *alert fatigue*: staff stop reading and tap through on muscle memory, which actually **weakens** error detection. Good human-error defence keeps routine, safe entries effortless while concentrating clear visual formatting, targeted confirmation, independent second-party receipts, and physical-cash reconciliation on high-impact or abnormal events.

### 2. The three moments to catch a human error — and why timing is critical in THIS app

| Moment | Mechanism | What it catches best |
|---|---|---|
| **1. Before save** | Clear number formatting while typing, smart resets (no sticky wrong agent), duplicate check, live balance/split preview, targeted confirmation with highlighted anomalies | Extra/missing zeros, wrong agent, double-tap duplicates, forgetting to change auto-filled cash or receiver |
| **2. At save** | Postgres triggers/constraints, atomic RPCs (entry + linked payments in one transaction), server-side validation | Impossible states (both-zero qty, cash on bottle-only, type switch, over-deposit/over-credit, partial-write orphans) |
| **3. After save (same day)** | Unified real-time agent receipt (second pair of eyes), real-time OM notices (including edits/deletes), blind physical-cash handover count, 19:00 reconciliation digest | Plausible-but-wrong facts (`300,000` vs `320,000`, `90` vs `80` bottles, uncollected auto-filled cash) that look completely valid to software |

**Why timing is uniquely decisive in THIS app:**
1. **SPEC Rule 4 — Strict midnight cutoff (same-day edit/delete only, ALL roles including Owner, `Asia/Yangon`):** Every record is editable/deletable ONLY until `23:59:59` Yangon time on the day it was created. Catching a mistake at `15:15` (via an agent receipt) or `19:00` (via cash handover + evening digest) means a clean 10-second same-day edit or delete-and-reenter. Catching the *exact same mistake* at `08:30` the next morning (when `wfms-data-quality` currently runs!) means the row is permanently frozen — the Owner must fall back to backdated compensating entries, and a wrong-agent delivery can no longer be removed at all.
2. **SPEC Rule 6 — Month lock (ALL roles, Owner included):** Once a month is locked, even Owner backdated compensating inserts are blocked without an audited unlock.
3. **Next-morning allocation cascade (proven by the Nov 20–21 incident):** Because `allocateCash()` and `splitStandalonePayment()` read live `agent_outstanding()` on the very next visit, an uncaught Day-1 cash error immediately poisons Day-2's `old_debt`/`regular` split (at `05:31 AM` the next morning in U Aye Myint's case). Errors must be surfaced **before midnight AND before the next morning's truck rolls out**.

### 3. Honest limits — what software CANNOT protect against even in the best build
No software design can eliminate every human mistake:
- **Plausible single-source miscounts with no physical or second-party check:** If staff delivers `90` bottles and enters `80`, or counts `320,000` cash as `300,000` in their head, both numbers are mathematically valid and pass every database rule. Software cannot count banknotes or bottles on a truck.
- **Shared silence across both humans:** If the staff member enters the wrong amount, the agent does not read their receipt (or has no login), and Owner/Manager does not count physical cash against the app before midnight, the error will survive.
- **Autopilot overrides:** Any warning or confirmation screen can be clicked through blindly if users are rushed or fatigued.
- **Real-world reconciliation is still a human act:** The best software can make discrepancies impossible to miss (unified receipt to the agent + blind cash handover count + 19:00 reconciliation digest), but humans still have to count the cash and read the screen.

---

## Part 2 — Codebase Gap Audit (Ordered by Damage Potential)

Walked in actual code: `src/pages/EntriesPage.tsx`, `src/pages/PaymentsPage.tsx`, `src/pages/ExpensesPage.tsx`, `src/pages/HandoverPage.tsx`, `supabase/migrations/0017_collection_anomaly_prefs.sql`, `0039_drop_agent_bottle_limit_trip_qty.sql`, `0044_om_notify_receiver_name.sql`, `0048_edit_entries_expenses.sql`, and `0049_bottle_only_collection.sql`.

### Gap 1 (Highest damage) — 19:00 Evening Digest omits `agent_payments`, omits per-receiver cash & same-day edits/deletes, and miscalculates total outstanding
- **Where:** `supabase/migrations/0017_collection_anomaly_prefs.sql` (`send_daily_digest()`, lines 18–64).
- **(a) Human mistake:** Staff under-records or over-records cash (e.g., `300,000` vs `320,000`, or leaves PR #35 auto-filled cash on an unpaid delivery), or deletes/edits a cash row without OM noticing before midnight.
- **(b) What happens today:**
  1. `v_cash` sums **only `daily_entries.amount_collected`** (lines 30–33) — it **completely omits today's `agent_payments`** (both entry-spawned `old_debt`/`regular` rows and standalone Payments page collections). On Nov 20, the digest missed `280,000` MMK of cash on Entry #3 alone and inflated "today's debt increase" (`v_sales - v_cash`).
  2. `v_outstanding` (lines 36–38) omits both `write_offs` and `agent_damage_charges` (migration `0042`), so the digest total does not match the app's real outstanding balance.
  3. It shows no per-receiver cash totals (cannot compare against cash envelopes from each driver), no list/count of same-day edits or deletes (`audit_log`), and skips OM users who set `notify_prefs.mode = 'important'` (lines 49–51).
- **(c) Proposed protection (Moment: After save, 19:00 Yangon — 5 hours before midnight cutoff):** Fix `send_daily_digest()` to sum `daily_entries.amount_collected + agent_payments.amount` for today's cash and include `write_offs` + `agent_damage_charges` in total outstanding; add per-receiver cash totals for the day, standalone payment count/sum, same-day edit/delete count, and unrecorded/mismatched handovers; send unless `alert_digest = false` explicitly (do not silently drop it under `mode = 'important'`).

### Gap 2 (Very high damage) — `HandoverPage` pre-fills "Received Cash" with `expected`, defeating physical cash count reconciliation
- **Where:** `src/pages/HandoverPage.tsx` (lines 136–147).
- **(a) Human mistake:** Any cash recording error (like U Aye Myint's `20,000` shortfall on Nov 20, or staff leaving auto-filled cash on a credit delivery) should surface as an immediate **Over/Short cash discrepancy** when staff hands over physical money to Owner/Manager at the end of the day.
- **(b) What happens today:** When no handover exists yet for an employee, `HandoverPage` **pre-fills the "received" input with `expected`** (the app's recorded total). A busy manager/owner sees the box already filled and taps "Receive" (`လက်ခံမည်`) instead of counting cash blind — turning the strongest physical reconciliation check into a rubber stamp.
- **(c) Proposed protection (Moment: After save, same-day evening):** Start the `received` input **blank** for unsaved handovers so OM must type the actual counted physical cash (blind count), then immediately highlight any short/over difference in red/amber with a direct link to that receiver's day records while the same-day edit window is still open.

### Gap 3 (Very high damage) — Fragmented agent receipts hide total cash & new balance; edits and deletes send NO updated receipt (and entry edits fire spurious "new payment" receipts)
- **Where:** `supabase/migrations/0044_om_notify_receiver_name.sql` (`notify_on_payment`), `0049_bottle_only_collection.sql` (`notify_on_entry`), `0048`/`0049` (`edit_daily_entry`), and `src/pages/EntriesPage.tsx` (lines 384–459).
- **(a) Human mistake:** Staff enters wrong visit cash (`300,000` vs `320,000`), wrong bottle qty, or later edits/deletes a row.
- **(b) What happens today:**
  1. When visit cash covers today + old debt + overpayment, `EntriesPage.tsx` performs 1 `daily_entries` insert + up to 2 separate `agent_payments` inserts, firing **up to 3 disconnected receipts** (`20,000`, `200,000`, `80,000`) with **no visit total** and **no resulting agent balance**. The agent would have to sum 3 messages in their head to catch a `20,000` discrepancy.
  2. `notify_on_entry` and `notify_on_payment` are `AFTER INSERT` only. Editing or deleting an entry/payment sends **no** "updated/cancelled" notice to the agent or OM.
  3. Worse: inside `edit_daily_entry()` (`0049`, lines 295–319), when `v_need_rewrite` is true, deleting and re-inserting linked `agent_payments` fires `payments_notify` (`AFTER INSERT`) — sending **false duplicate "new payment received" notifications** to both OM and the agent for money that was only being re-allocated!
- **(c) Proposed protection (Moment: At save + immediately after save):**
  1. Move delivery creation + linked-payment creation into a single atomic Postgres RPC (mirroring `edit_daily_entry`), suppress `notify_on_payment` for `source_entry_id IS NOT NULL` rows, and emit **ONE unified visit receipt** to the agent (and OM) showing delivered/returned bottles, **total cash handed over**, split breakdown (today / old debt / overpayment), receiver, and **new resulting balance** (`ကျန်ပေးရန်` or `ပိုပေးထားငွေ`).
  2. Emit an explicit "Updated / Cancelled" notice on same-day edits and deletes (and suppress fake "new payment" notices during `edit_daily_entry` rewrites).

### Gap 4 (High damage) — `PaymentsPage` and `ExpensesPage` save immediately on single tap with ZERO confirmation step (and `ExpensesPage` accepts `0` MMK)
- **Where:** `src/pages/PaymentsPage.tsx` (`onAdd`, lines 269–349; form lines 636–745) and `src/pages/ExpensesPage.tsx` (`onAdd`, lines 170–193; form lines 445–508).
- **(a) Human mistake:** Typing an extra/missing zero (`50,000` → `500,000`), choosing the wrong payment method (`cash` vs `kbzpay`), or accidentally submitting while scrolling on a phone.
- **(b) What happens today:** Unlike `EntriesPage` (which has a confirmation panel), both `PaymentsPage` and `ExpensesPage` write straight to Postgres on the first tap of `သိမ်းရန်`. On `PaymentsPage`, if the mistyped amount exceeds current debt, it immediately writes **two unlinked `agent_payments` rows** (`old_debt` + `regular`) and fires two agent receipts. On `ExpensesPage`, `onAdd` does not even reject `amount <= 0` (`amount: Number(amount) || 0`), silently saving a `0` MMK expense.
- **(c) Proposed protection (Moment: Before save + at save):** Add an in-app confirmation panel to `PaymentsPage` (showing agent, formatted amount, method, receiver, split, resulting balance, and amber highlight if creating overpayment or backdated) and to `ExpensesPage` (requiring `amount > 0`, formatted amount, category, and date highlight if backdated).

### Gap 5 (High damage) — Sticky `agentId` after save on `EntriesPage` and `PaymentsPage` + silent wrong-receiver defaults
- **Where:** `src/pages/EntriesPage.tsx` (`doInsert` lines 479–488, `afterQueued` lines 499–508), `src/pages/PaymentsPage.tsx` (`onAdd` lines 342–346).
- **(a) Human mistake:** Staff finishes Agent A, gets handed Agent B's bottles/cash, and starts typing without changing the agent dropdown — charging or crediting Agent A instead of Agent B. Or a manager/office worker enters a driver's trip and forgets to change `လက်ခံသူ` (which silently defaults to the typist), misassigning cash accountability on `HandoverPage`.
- **(b) What happens today:** Both `EntriesPage` and `PaymentsPage` clear qty/cash/notes after saving, **but leave `agentId` pointing at the previous agent**! Because `agent_id` is immutable on edit (`0048`), a wrong-agent entry noticed after midnight can never be edited or deleted.
- **(c) Proposed protection (Moment: Before save):** Reset `agentId` to `''` after every successful save (or queue) on both `EntriesPage` and `PaymentsPage` so the next visit *always* requires consciously picking the agent. On the confirmation card, display the agent name and receiver prominently at the top (highlighting when `receivedBy` differs from the typist, or for OM typists reminding who physically holds the cash).

### Gap 6 (High damage) — Raw unformatted digit inputs (`300000` vs `3000000`) & no anomaly warning on huge/unusual cash or quantity inputs
- **Where:** `src/pages/EntriesPage.tsx` (lines 960–970, 933–946), `src/pages/PaymentsPage.tsx` (lines 689–697, 562–569), `src/pages/ExpensesPage.tsx` (lines 468–476, 364–371).
- **(a) Human mistake:** Adding or dropping a zero on 5–7 digit MMK numbers (`30000` vs `300000` vs `3000000`), or mistyping `300000` instead of `320000` on a small phone keypad, or typing `2000` bottles instead of `200`.
- **(b) What happens today:** Every money input displays raw digits without commas (`300000`), so a 10× typo (`3000000`) is easy to miss while typing. Neither `EntriesPage` nor `PaymentsPage` nor `ExpensesPage` flags unusually large amounts (e.g., `cash > 3 × due`, large overpayment, or `delivered_qty > 500`) before save. (`data_quality_scan` only checks `delivered_qty > 2000`, and only passively.)
- **(c) Proposed protection (Moment: Before save):** Render live formatted MMK (`320,000 ကျပ်`) immediately beside/under every money input (in both add and edit forms), and show a prominent amber confirmation callout when: (i) cash creates a new overpayment (`advance > 0`), (ii) manually edited cash differs from `due` and is ≥ `500,000` MMK (or ≥ 3× `due`), or (iii) `delivered_qty` is abnormally large (e.g. > `500`).

### Gap 7 (Medium-high damage) — Zero duplicate-submission guard across all 3 add forms (and offline queue)
- **Where:** `src/pages/EntriesPage.tsx`, `src/pages/PaymentsPage.tsx`, `src/pages/ExpensesPage.tsx`.
- **(a) Human mistake:** Staff loses signal or gets interrupted, isn't sure the first save landed, and submits the exact same delivery, payment, or expense a second time 1–3 minutes later.
- **(b) What happens today:** Every add form inserts a duplicate row silently. Even `run_data_quality_alerts()` (`0017`) does **not** alert on duplicates (only manual visits to `/data-quality` surface them).
- **(c) Proposed protection (Moment: Before save):** Check recently loaded today rows (and `offlineQueue.peekAll()` on `EntriesPage`) for a matching record saved within the last 10–15 minutes (`agent_id` + `delivered_qty` + `returned_qty` + `cash` on entries; `agent_id` + `amount` + `method` on payments; `title` + `amount` on expenses). If found, surface a clear amber warning inside the confirmation panel requiring explicit acknowledgement before saving (soft block, never preventing genuine repeat trips).

### Gap 8 (Medium-high damage) — All three Edit Forms lack a before-vs-after diff & confirmation, `PaymentsPage` edit lacks balance preview & DB `agent_immutable` / sibling-row link
- **Where:** `src/pages/EntriesPage.tsx` (lines 756–875), `src/pages/PaymentsPage.tsx` (lines 525–619, `saveEdit` 365–399), `src/pages/ExpensesPage.tsx` (lines 346–423, `saveEdit` 207–245).
- **(a) Human mistake:** While fixing a mistake same-day, staff/OM mistypes the corrected amount (e.g., tries to change `300,000` → `320,000` and accidentally enters `32,000` or `3,200,000`), or edits only one half of a split standalone payment (`old_debt` row) while forgetting its companion `regular` row.
- **(b) What happens today:**
  - All 3 edit forms commit immediately on a single click of `သိမ်းမည်` with no before → after summary (`300,000 → 320,000`).
  - `PaymentsPage` edit shows **no** resulting agent balance preview at all (unlike `EntriesPage` edit).
  - `agent_payments` has no DB `agent_immutable` trigger (only `daily_entries` received one in `0048`), and split standalone payments (`PaymentsPage.tsx` lines 314–324) are two independent rows with no group/pair link.
- **(c) Proposed protection (Moment: Before save + at save):** Show a compact inline before → after diff (`300,000 ကျပ် → 320,000 ကျပ်`) and live new balance preview in `PaymentsPage` edit (matching `EntriesPage` edit); require a 2-step confirm when an edit changes cash by a large delta; add `payments_agent_immutable` trigger in DB to match `daily_entries`.

### Gap 9 (Medium damage) — `run_data_quality_alerts()` runs at 08:30 AM the NEXT morning (after the midnight edit lock) and skips key checks
- **Where:** `supabase/migrations/0012_scheduled_jobs.sql` (line 108: `'0 2 * * *'` = 08:30 Yangon), `0017_collection_anomaly_prefs.sql` (`run_data_quality_alerts()`, lines 66–236).
- **(a) Human mistake:** Duplicate entry, negative held bottles (`returned` typo), huge delivery qty (`> 2,000`), or unpaid large delivery (`>= 20` bottles, `0` cash) entered during the day.
- **(b) What happens today:** The cron job fires at `08:30 AM` the *next* day — **8.5 hours after SPEC Rule 4 permanently locked yesterday's rows**! Worse, `run_data_quality_alerts()` does not even check same-day duplicates, negative held bottles, or `> 2,000` qty (those only exist in manual `data_quality_scan()`).
- **(c) Proposed protection (Moment: After save, same-day ~18:30–19:00 Yangon):** Run a same-day anomaly check **before** midnight (e.g., 18:30 Yangon, paired with or folded into the 19:00 digest) covering today's duplicates, negative held bottles, extreme quantities, and collector anomalies — while OM and staff can still edit or delete today's rows cleanly.

### Gap 10 (Medium damage) — Owner backdating has no non-today warning, and offline-queue cash > `due` replays unsplit
- **Where:** `src/pages/EntriesPage.tsx` (lines 868–880, 227–268), `src/pages/PaymentsPage.tsx` (lines 639–649), `src/pages/ExpensesPage.tsx` (lines 447–457).
- **(a) Human mistake:** (1) Owner types a wrong backdate (e.g., wrong month or year `2025-11-20`) — it saves silently if that month isn't locked. (2) Staff saves an entry offline with `cash > due` (today + old debt); on reconnect `flushQueue` writes the entire cash directly into `daily_entries.amount_collected` without splitting into `agent_payments`.
- **(b) What happens today:** (1) No visual callout warns the Owner that `date !== todayYangon()`. (2) Offline replay leaves `amount_collected > amount` on `daily_entries` (displaying negative `ကျန်ပေးရန်` on that row and skipping `notify_on_payment`), even though `agent_outstanding()` stays numerically right.
- **(c) Proposed protection (Moment: Before save + at save):** (1) Show a bright amber banner whenever Owner picks a date other than today (`ရက်စွဲဟောင်း 2026-11-20 ဖြင့် သိမ်းပါမည်`), and warn extra loudly if the date is > 30 days old. (2) Once the atomic save RPC from Gap 3 exists, let `flushQueue` call that same RPC so offline replays split cash and emit unified receipts identically to online saves.

### Gap 11 (Lower-medium damage) — PR #35 auto-filled cash left untouched on a credit (unpaid) visit
- **Where:** `src/pages/EntriesPage.tsx` (lines 303–305, 933–970).
- **(a) Human mistake:** Agent takes 100 bottles on credit (`0` cash), but because PR #35 auto-fills `cash = 100,000`, rushed staff taps Save → Confirm without changing cash to `0`, recording `100,000` cash they never collected.
- **(b) What happens today:** Saves cleanly as paid in full. Because the agent didn't pay cash, they may or may not complain if they see a receipt saying "paid 100,000", and if `HandoverPage` pre-fills `expected`, even handover might miss it.
- **(c) Proposed protection (Moment: Before save + after save):** Add a single-tap **"ငွေမရ (0)"** quick-clear button right next to the cash input on `EntriesPage` (so setting cash to `0` is one thumb tap instead of select-all + backspace + type 0), and rely on **blind `HandoverPage` counting (Gap 2)** + **19:00 per-receiver digest (Gap 1)** so any phantom auto-filled cash immediately shows up as a `100,000` physical cash shortage that evening.

---

## Part 3 — Evaluation of the Other Reviewer's 4 Proposals

### Proposal 1: Cash totals of `100,000` MMK or more must be typed twice (entry + payments forms); mismatch blocks saving.
- **Verdict:** **DISAGREE (as a flat `100,000` MMK rule) / CAN-BE-BETTER**
- **Reasons:**
  1. **`100,000` MMK is a routine everyday trip in MMK.** Look at U Aye Myint's own 7 trips: **6 of 7** were `100,000`–`200,000` MMK (any 100-bottle delivery at `1,000`/bottle hits `100,000`). Forcing staff to type cash twice on almost every normal visit directly contradicts PR #35 (cash auto-fill, built specifically so staff don't have to re-type routine full-payment cash!) and violates SPEC's phone-first usability rule.
  2. **It invites copy-paste / muscle-memory bypasses and misses mental miscounts.** If a staff member miscounted banknotes as `300,000` in their head, typing `300000` twice will match and still save `300,000`.
- **What to build instead:**
  - Show live comma-formatted MMK (`320,000 ကျပ်`) while typing on every money input (catches 10× zero typos with zero extra taps).
  - Add a proper confirmation panel to `PaymentsPage` and `ExpensesPage` (currently missing completely).
  - Reserve **re-type / extra friction** strictly for **genuinely abnormal high-risk cash** — e.g., manually entered cash that **both** differs from `due` **and** either exceeds a higher threshold (e.g., `≥ 500,000` MMK) or creates a new overpayment (`advance > 0`) or exceeds `3×` the visit charge. Never force double-typing on routine auto-filled deliveries.

### Proposal 2: Duplicate guard — warn when a near-identical record (same agent, qty, cash) is saved within a few minutes.
- **Verdict:** **AGREE (with two refinements)**
- **Reasons:** Zero friction on normal work, high protection against phone double-taps, flaky-network retries, and sticky-agent accidents.
- **Refinements to make it complete:**
  1. Cover all three add forms — `EntriesPage` (including bottle-only rows by `returned_qty` + `offlineQueue.peekAll()`), `PaymentsPage` (`agent_id` + `amount` + `method`), and `ExpensesPage` (`title` + `amount`) — within a ~10–15 minute window.
  2. Make it a **soft warning with explicit confirm** (never a hard block, since legitimate repeat trips happen), AND pair it with **clearing `agentId` after save** (Gap 5) so staff don't accidentally enter Agent B's record under Agent A.

### Proposal 3: The 19:00 digest gains a reconciliation section — per-receiver cash totals for the day + that day's edits, deletes, and standalone payments.
- **Verdict:** **AGREE — CAN-BE-BETTER (must fix existing digest bugs + pair with blind `HandoverPage` count)**
- **Reasons:** This is the single strongest Owner-side defence because `19:00` Yangon gives 5 hours before midnight (SPEC Rule 4) to match physical cash in hand against app totals.
- **What must be added so it actually works in this codebase:**
  1. First fix the **existing bugs in `send_daily_digest()` (`0017`)**: today's cash currently excludes `agent_payments`, total outstanding excludes `write_offs` and `agent_damage_charges`, and `mode = 'important'` skips the digest completely.
  2. Include **unrecorded / mismatched cash handovers** in the 19:00 summary, and **stop pre-filling `received = expected` on `HandoverPage.tsx` (Gap 2)**. Together, blind physical cash count + 19:00 per-receiver digest would have caught U Aye Myint's `+20,000` surplus on the evening of Nov 20 — 8 days earlier, while same-day editing was still open.

### Proposal 4: Agent notifications show the full split (today / old debt / overpayment / new balance) so the agent becomes a second checker the same day.
- **Verdict:** **AGREE — CAN-BE-BETTER (must unify the 3 receipts into 1 atomic receipt + notify on edits/deletes)**
- **Reasons:** Turning the agent into a same-day second checker is the **only** mechanism that can catch a plausible-but-wrong cash figure (`300,000` vs `320,000`) within minutes of the visit, before the next morning's allocation cascades the error.
- **Crucial codebase architecture detail:**
  - Simply editing `notify_on_entry()` cannot show the full split or true new balance because `EntriesPage.tsx` inserts `daily_entries` *first* (carrying only `toToday = 20,000`) and then inserts linked `agent_payments` in separate round-trips — producing **3 fragmented notifications** (`20,000`, `200,000`, `80,000`).
  - **What to build:** Combine entry + linked payments into one atomic Postgres RPC (just like `edit_daily_entry`), suppress `notify_on_payment` for `source_entry_id IS NOT NULL` rows, and send **ONE clear receipt** showing: delivered/returned bottles, **total cash received (`300,000`)**, split (today / old debt / overpayment), receiver, and **new resulting balance** (`ပိုပေးထားငွေ 80,000` or `ကျန်ပေးရန် …`).
  - Also emit clear **"Updated / Cancelled" receipts** on same-day edits and deletes (and stop `edit_daily_entry`'s linked-payment rewrite from firing misleading duplicate "new payment" notices).
