# OLD APP — COMPLETE FEATURE & UI INVENTORY ("Aqua Crate Ledger")

Purpose: parity checklist for the rebuild. Everything below was read directly from the source code of
GitHub repo `Khinelintun91/aqua-crate-ledger` at HEAD commit `8b54734` (read-only; nothing was modified).
Method: every route, component, server-function file, migration (37 SQL files), the generated Supabase
types, package.json, public assets and repo docs (README / AGENTS.md / ARCHITECTURE.md / roadmap.md)
were fetched and read. Items that could not be verified from code are flagged **UNKNOWN** at the end.

> IMPORTANT CONTEXT: the old app is NOT a plain Supabase SPA. It is a **TanStack Start** full-stack app
> (React 19 + TanStack Router file routes + server functions via `createServerFn`, Nitro server) using
> **Lovable Cloud** (managed Supabase, project ref `ikxvscflufaiajunjdcg` per `supabase/config.toml`).
> Almost all business reads/writes go through **server functions** (`src/lib/*.functions.ts`), with
> Postgres RLS as a second layer. There are **no Supabase Edge Functions** in `supabase/functions/`
> (the folder does not exist); server-side HTTP endpoints live in `src/routes/api/public/**`.

Stack: React 19, TanStack Router/Start/Query, Tailwind CSS v4, shadcn-style Radix UI, Recharts,
SheetJS `xlsx`, Firebase JS SDK (FCM web push), Supabase JS, Drizzle-named migrations folder
(`drizzle/migrations/*.sql` are plain Postgres SQL applied to the Supabase DB), Vitest + Playwright e2e.

---

## 1. Routes / Pages

Auth guard: everything under `src/routes/_authenticated/` requires a Supabase session (client-side
`beforeLoad` redirect to `/auth`); `/` redirects to `/home` when signed in, else `/auth`.
Each page additionally re-checks roles client-side AND every server function re-checks server-side.

| Route | Page | Roles | Purpose in one line |
|---|---|---|---|
| `/auth` | Login | public | Username + password/PIN sign-in |
| `/` | redirect | — | → `/home` or `/auth` |
| `/home` (nav label ပင်မ, linked as `/`) | Dashboard | owner, manager, employee (agent auto-redirected to `/my`) | Daily totals + per-employee summary |
| `/entries` | နေ့စဉ်မှတ်တမ်း (Daily entries) | owner, manager, employee | Delivery entry + collections + dispute inbox + change history + audit log |
| `/collections` | ကြွေးကောက်ငွေ (Collections report) | owner, manager | Agent debt balances + collection report |
| `/handover` | ငွေအပ်စာရင်း (Cash handover) | owner, manager | Daily staff cash reconciliation |
| `/inventory` | ဘူးလက်ကျန် (Bottle stock) | owner, manager | Factory full/empty bottle stock |
| `/agents` | ကိုယ်စားလှယ် (Agents) | owner, manager | Agent CRUD, pricing, limits, close-out links |
| `/agent/$agentId` | Agent detail | owner, manager | One agent: stats, entries, payments, deposits |
| `/closeout/$agentId` | စာရင်းပိတ်ရန် (Close-out) | owner, manager (hard delete: owner only) | 4-step agent settlement |
| `/expenses` | ကုန်ကျစရိတ် (Expenses) | owner, manager | Expense entry + list |
| `/payroll` | လစာ (Payroll) | owner, manager | Salaries, advances, bonuses, monthly pay |
| `/reports` | စာရင်းရှင်းတမ်း (Reports) | owner, manager | Accounting report, trend chart, write-off, exports |
| `/data-quality` | စာရင်းစစ် (Data quality) | owner, manager | Automated bookkeeping-error scan |
| `/users` | အကောင့်များ (Users) | owner only | Accounts, roles, password/PIN reset, login log |
| `/my` | ကျွန်ုပ်၏မှတ်တမ်း (My records) | agent only | Agent self-view (read-only) + dispute filing |
| `/settings` | ဆက်တင် (Settings) | all roles (parts owner-only) | Theme, language, push, backup/month-lock (owner), factory settings (owner) |

### 1.1 `/auth` — Login
- Username field + password/PIN field with show/hide eye toggle.
- If the secret is exactly 4 digits → PIN login path (server fn `pinSignIn`, returns a session that the
  client applies via `supabase.auth.setSession`); otherwise normal Supabase email+password where the
  email is synthetic: `<username>@waterfactory.local` (never shown to users). Legacy fallback: if the
  typed username contains `@`, it also tries signing in with it as a real email.
- "Login မှတ်ထားမည်" (remember username) checkbox, default on; stores username in localStorage.
- Errors in Myanmar: wrong credentials; banned account → "ဤအကောင့်ကို ပိတ်ထားပါသည် — Owner ထံ ဆက်သွယ်ပါ".
- Every successful login is recorded (`recordLogin` → `login_logs` with user-agent, best-effort).
- Factory/app name shown on the card comes from `app_settings` (readable pre-login via RPC
  `public_app_name`); language toggle sits in the top-right corner even on the login page.
- Footer note: "အကောင့်မရှိသေးပါက Owner ထံ ဆက်သွယ်ပါ" (no self-signup).

### 1.2 `/home` — Dashboard (owner/manager/employee; agents redirected to `/my`)
- Date picker (defaults today, Yangon). All data auto-refreshes every 30 s.
- Stat cards (animated CountUp, 400 ms): bottles out (ထွက်သွားသော ဘူး), empties returned
  (ပြန်ဝင်သော ဘူးခွံ), cash collected at delivery (ကောက်ငွေ), plus owner/manager-only: debt collections
  (ကြွေးကောက်ငွေ) and expenses (ကုန်ကျစရိတ်).
- Net card (owner/manager): အသားတင် = collected + debtCollected − expenses, green/red by sign.
- "နေ့စဉ် CSV ထုတ်မည်" button (owner/manager): downloads that day's CSV (see §8).
- Per-employee daily summary table (owner/manager): employee, trips count (အကြိမ်), bottles out,
  empties in, delivery cash, debt-collection cash.
- If the signed-in user has NO role: a "Role မသတ်မှတ်ရသေးပါ" card with a one-time
  "Owner အဖြစ် စတင်မည်" bootstrap button (`claimOwnerIfNone` — works only while no owner exists).

### 1.3 `/entries` — Daily entries (the main data-entry page)
Layout: entry form card + month list; dispute inbox on top and change-history + audit log below
(owner/manager). Contains THREE record types on one page:
- **Delivery form** (big touch inputs, h-12/text-lg): agent select (active agents only), bottles out
  (ပို့သော ဘူး), empties in (ပြန်ယူသော ဘူးခွံ), cash collected (လက်ခံငွေ), date (defaults today), note.
  Validation: agent required; negatives rejected; all-zero rejected. A pre-save **confirmation dialog**
  summarises agent/bottles/empties/cash; if cash = 0 with bottles > 0 it warns
  "⚠ ငွေ ၀ ကျပ် … အကြွေးအဖြစ် မှတ်ပါမည်". Multiple trips per agent per day allowed (each = own row).
  **Offline**: if offline or the save hits a network error, the entry is queued in localStorage
  (`offline-entries`) with a warning toast and auto-sent later (see Offline sync, §2).
- **Entries table** for the selected month (month dropdown covering the last 36 months):
  date, agent, bottles out, empties in, cash, note, actions.
  Inline row editing (bottles/empties/cash/note) with Save/Cancel.
  Edit AND delete both require a typed **reason** (prompt dialog, min 2 chars) that lands in the audit log.
  Employees may edit/delete only records created the same Yangon day; owner/manager any day
  (UI shows "ပိတ်ထား" when locked for the user; server enforces the same rule + RLS).
- **Collections section** (component, §2): record later payment of old debt (agent, amount, date, note)
  with its own confirm dialog, month list, and edit/delete-with-reason. Explicitly NOT a delivery.
- **Dispute inbox** (owner/manager only, §2).
- **Change history** (owner/manager only, §2) and **Audit log table** (owner/manager): time, actor,
  action (အသစ်/ပြင်/ဖျက်), table (ရေပို့မှတ်တမ်း/ကုန်ကျစရိတ်/ကိုယ်စားလှယ်), detail with old→new values for
  bottles and cash; last 200 rows; caption states the log cannot be edited/deleted.

### 1.4 `/collections` — Collections & agent balances (owner/manager)
- **Agent balance card**: every agent with owed ≠ 0 — name, price/bottle, bottles delivered, sales
  value, owed (ကြွေးကျန်, red) or overpaid (ပိုပေးထား, green); grand total owed header.
  Rows expand to a **day-by-day ledger**: each delivery/payment/write-off event in plain language
  ("ရေ N ဘူး ပို့ (X ကျပ်ဖိုး)၊ Y ကျပ် ပေးခဲ့") with the running balance after each event.
  Phone gets a card list, ≥sm gets the table (two separate markups).
- **Collections report**: filters from-date, to-date (default: this month), employee (collector),
  agent. Stat cards: total collected, record count, agent count. Table (or phone cards): date, agent,
  collected-by, amount, note. Negative amounts shown red/bold (write-off adjustments appear in the
  underlying data set used by `listAgentBalances`).

### 1.5 `/handover` — Staff cash handover (owner/manager)
- Date picker. Summary cards: expected cash (အပ်ရမည့်ငွေ), received (လက်ခံပြီးငွေ), difference
  (ကွာဟချက်), staff not yet handed over (မအပ်ရသေး N ဦး).
- Per-employee rows: delivery cash, debt-collection cash, expected total (server-recomputed from
  entries + payments, never trusted from the client), received-amount input, note input, status badge
  (မအပ်ရသေး / ကိုက်ညီ match / လို short N / ပို over N; tolerance 0.5), Save/Edit button.
- If the day's entries changed after a handover was saved, the row warns
  "စာရင်းပြောင်းသွားသည် — ပြန်သိမ်းပါ" (saved expected ≠ current expected).

### 1.6 `/inventory` — Bottle stock (owner/manager)
- Summary cards: factory full bottles (စက်ရုံ ရေဖြည့်ပြီးဘူး), factory empties (စက်ရုံ ဘူးခွံ),
  bottles with agents (ကိုယ်စားလှယ်လက်ထဲ), total bottles. Negative stock shows a warning telling the
  user to record opening stock as purchases/production.
- Stock-move form: date, kind — **produce** (ရေဖြည့်ပြီး: empties→full), **purchase** (ဘူးအသစ်ဝယ်),
  **damage** (ပျက်စီး/ပျောက်) — bottle count, note. Moves list (latest 300) with delete (AlertDialog
  confirm; stock recomputes). Deliveries/returns from daily entries feed the summary automatically:
  full = produced − bottlesOut; empty = purchased + emptiesIn − produced − damaged;
  withAgents = bottlesOut − emptiesIn.

### 1.7 `/agents` — Agent list (owner/manager)
- **Add-agent form**: name, phone, address, deposit per bottle (prefilled from settings default),
  optional initial deposit bottles (creates a deposit record on save, with confirm dialog showing
  bottles × price = total), sale price per bottle (settings default), bottle limit (0 = unlimited),
  credit limit in MMK (0 = unlimited), and (owner only) link to an existing agent login account —
  picking an account auto-fills name/phone from it.
- **Agent table**: name (link to detail; address under it), phone, and **inline-editable** (on-blur)
  price/bottle, deposit/bottle, bottle limit, credit limit; active badge (လှုပ်ရှားနေ/ရပ်ထား);
  actions: activate/deactivate toggle, အသေးစိတ် (detail), ဘူးအပေါင် (detail#deposit),
  စာရင်းပိတ်ရန် (close-out). Closed agents are excluded from this table.
- **Closed agents card**: name + closed date + link to close-out record.

### 1.8 `/agent/$agentId` — Agent detail (owner/manager; auto-refresh per settings interval)
- Header: name, phone, address, price/bottle, bottle limit.
- "Today" stat grid: bottles out today, empties in today, cash today, current bottles held.
- "Totals" stat grid: total out, total in, bottles still held, **"can still deliver"** = min(bottle
  limit if set, deposit bottles if deposit price set) − held (or "—" when uncapped).
- "Money" stat grid: sales value (Σ bottles × per-entry unit_price snapshot), cash at delivery,
  later payments + write-offs, amount owed.
- Entries table: date, time (Yangon HH:MM), entered-by name, out, in, cash, per-trip debt
  (red when > 0), note.
- Payments table: date, amount, note + total.
- Deposit card (component, §2) anchored at `#deposit`.

### 1.9 `/closeout/$agentId` — Agent close-out / settlement (owner/manager)
Four numbered steps with a live settlement preview:
1. **Bottle check**: book-held bottles; input for actually-returned bottles.
2. **Receivable**: outstanding amount; record a final collection (amount + note) OR a write-off
   (amount + mandatory reason, destructive confirm). Close-out is blocked until receivable = 0.
3. **Deposit refund**: enter today's market deposit price/bottle; shows original price → today's
   price delta (ဈေးတက်/ဈေးကျ); computes refund for returned bottles, price-difference amount,
   forfeiture income for missing bottles (missing × current price), net refund to agent, or amount
   the agent still owes. Math in `src/lib/settlement.ts` (see §7).
4. **Finalize**: confirm → writes `agent_settlements`, books the price difference as an expense in
   category "ဗူးအပေါင် ဈေးကွာ", marks the agent closed (closed_at/closed_by, inactive).
   Afterwards read-only; **Owner-only hard delete** button (`hard_delete_agent` RPC) with a warning
   that historical sales/report numbers survive via name snapshots.

### 1.10 `/expenses` — Expenses (owner/manager)
- Form: date, category (fixed list of 7: ကားဆီဖိုး, ကား, ရေသန့်စက်, စက်ရုံ, ဆက်သွယ်ရေး,
  ပြုပြင်ထိန်းသိမ်းမှု, အခြား), amount, note. List of all expenses (date, category, amount, note).
  No edit/delete UI on this page (expenses appear in the audit log).

### 1.11 `/payroll` — Payroll (owner/manager)
- Month picker (YYYY-MM). Table per staff user (roles employee/manager/co_owner; hidden accounts
  excluded): name, monthly salary (**inline-editable** until paid), bonus total for the month,
  advance deduction for the month, net pay, advance outstanding balance, Pay button
  (confirm dialog) → writes an immutable `payroll_runs` row + `advance_repayments` rows; paid rows
  show a ပေးပြီး badge and lock.
- Net = base salary + bonuses − advance deduction. Advance deduction plan: for each advance,
  remaining = amount − repayments in other months; deduction = installment if set (capped at
  remaining) else the whole remaining; advances dated after the payroll month don't deduct yet
  but count into outstanding.
- **Advance form**: staff select, amount, repayment mode (နောက်လစာမှ တစ်ခါတည်းဖြတ် one-shot /
  လစဉ် အရစ်ကျဖြတ် monthly installment + installment amount), note. Advance history table.
- **Bonus form**: staff select, amount (for the selected month), reason/note.

### 1.12 `/reports` — Accounting reports (owner/manager)
- **Daily brief card** on top (component, §2).
- Date-range inputs (default: current month). Buttons: **Excel ထုတ်မည်** (SheetJS) and
  **PDF ထုတ်မည်** (= `window.print()`, print stylesheet hides nav/header).
- Stat groups (icon cards):
  - အရောင်းနှင့် အမြတ်: Sales, Collected, Net profit (green/red).
  - ကုန်ကျငွေ: Expenses total, Payroll + Bonus, Write-offs.
  - ရရန်ငွေနှင့် အပေါင်ငွေ: Receivable, Deposit liability, Forfeiture income, Refunds paid.
  - Footnote states the formula: Profit = Sales + Forfeiture − Expenses − Payroll/Bonus − Write-offs;
    deposits are a liability, never profit.
- **Monthly trend chart** (Recharts, §2/§10): 6/12/24-month toggle.
- Expense-by-category table.
- **Receivable aging** table: ≤30 days / 30–60 / >60 (oldest bucket red); each row opens a dialog
  listing per-agent aged debts (agent, date, days old, amount, total). Aging allocates outstanding
  to the newest sales first.
- Per-agent table: name, sales, collected, receivable, bottles held, deposit held.
- **Write-off form**: agent select (open agents with receivable shown), amount, reason, destructive
  confirm → `write_offs` row (also possible from close-out).

### 1.13 `/data-quality` — Data-quality scan (owner/manager)
- "ပြန်စစ်မည်" re-run button; header line shows how many entries/deposits/payroll/expenses were scanned
  and when. Filter cards (tap to filter): all / debt / duplicate / impossible / mismatch / suspicious
  with live counts (red when > 0). Severity filter chips (all/high/medium/low), "စစ်ပြီးသား"
  (reviewed) toggle — reviewed state is per-device localStorage — and a CSV export of the issue list.
- Issue table (max 500 shown with a note): severity badge, kind, date (+ "ပိတ်ပြီးလ" badge when the
  record's month is locked), table, agent name, problem description, a **fix suggestion in Myanmar**
  (highlighted red), and a "ပြင်ရန်" link to the relevant page/agent + a mark-reviewed button.
- Checks implemented in `src/lib/data-quality.ts` (see §7 for the full rule list).

### 1.14 `/users` — Accounts (owner only)
- **Create account form**: full name, username (3–30 chars, `[a-z0-9_.-]`), phone, role select
  (Owner / Co-Owner / Manager / ဝန်ထမ်း employee / ကိုယ်စားလှယ် agent). For employee/agent the secret
  field becomes a **4-digit PIN** (numeric, exactly 4); for owner/co_owner/manager a password (≥8).
  Duplicate username rejected.
- **Account list**: name, username, and **clickable role badges** — clicking a badge grants/revokes
  that role (multi-role accounts supported). Per-user buttons: reset password/PIN (prompt dialog;
  PIN users get a 4-digit prompt, others ≥8 chars; also clears PIN lockout), and
  "အလုပ်ထွက် — ပိတ်မည်" (deactivate: ban ≈100 years + soft-delete stamp; own account cannot be
  deactivated). Hidden accounts keep all their historical records.
- **Deactivated accounts card**: name, username, who deactivated, when; ပြန်ဖွင့်မည် (restore) button.
- **Login history table** (last 100): time, name, device user-agent.

### 1.15 `/my` — Agent self-view (agent role only, read-only)
- Auto-refresh at the settings interval, refetch on window focus.
- Today grid: bottles delivered to me today, empties I returned today, lifetime out, lifetime in.
- Cards: amount I still owe (အကြွေး, red when > 0), bottles I currently hold, deposit money the
  factory holds for me (via RPC `my_deposit_total`).
- Entries table with month filter (all months / per month): date, time, out, in, cash paid,
  per-trip amount still due (red), and an **"အမှားတင်ပြ" dispute button** per row (changes to
  "စစ်ဆေးနေဆဲ" while a dispute on that record is open).
- Payments table with total + dispute button per payment.
- **My disputes** table: filed time, record, my message, status, owner/manager reply.
- If the account isn't linked to an agent record: a notice to contact the Owner.
- Closed agents see balance/deposit zeroed.

### 1.16 `/settings` — Settings (all roles; sections vary)
- **Theme card**: အလင်း / အမှောင် / စက်အတိုင်း (light/dark/system) — per-device (localStorage),
  system follows the OS live.
- **Language card**: မြန်မာ / English — per-device (see §10 i18n).
- **Push card** (all roles; staff variant has extra prefs): enable/disable phone notifications on
  this device, device count, and for staff: notify mode (every delivery vs important + evening
  digest only) and a quiet-night checkbox (22:00–06:00 non-urgent pushes suppressed; still in bell).
- **Backup + month-lock card (owner only)**: §2.
- **Factory settings (owner only)**: app/factory name (≤60 chars, shown app-wide incl. login page),
  factory phone, factory address, default price/bottle for new agents, default deposit/bottle for
  new agents, auto-refresh seconds (5–300). Non-owners see a note that only the Owner can edit these.

---

## 2. Shared components (user-visible behaviour)

- **App shell** (`routes/_authenticated/route.tsx`): sidebar + header + mobile bottom nav + sheet
  menu (§10), top loading bar while any query/mutation/route is pending, offline banner, per-page
  role gate message ("ဝင်ရောက်ခွင့်မရှိပါ").
- **Notification bell** (`notification-bell.tsx`): header bell with unread badge (99+ cap); popover
  lists the latest 30 notifications with per-kind icon/colour, title, body, Yangon timestamp;
  click marks read and navigates to the notification's link; "အားလုံး ဖတ်ပြီး" marks all read;
  polls every 30 s and on window focus. Kinds/icons: dispute (flag), past_edit (history), receipt /
  delivery (receipt), collection / payment_receipt (banknote), dispute_reply, record_changed
  (pencil), data_quality (shield).
- **Confirm/prompt dialogs** (`confirm-dialog.tsx`): app-styled AlertDialog replacements for
  `confirm()`/`prompt()` — queue-based global host; confirm shows message with သေချာပါသည် / မလုပ်တော့ပါ;
  prompt variant has a big input (optionally numeric), Enter submits, OK disabled while empty;
  destructive variant is red. Used for: entry save summary, deposit taking, edits/deletes (reason
  prompts), payroll pay, write-offs, close-out steps, account deactivate, password reset.
- **Collection section** (`collection-section.tsx`): the old-debt collection form + month list
  embedded in `/entries` (see 1.3).
- **Deposit card** (`deposit-card.tsx`): on agent detail — deposit history lines (date, bottles ×
  price, amount), totals, and an add-deposit form (bottles + per-bottle price defaulting to the
  agent's deposit price; confirm dialog). Hidden form once the agent is closed.
- **Disputes** (`disputes.tsx`): `DisputeButton` (agent), `MyDisputes` (agent), `DisputeInbox`
  (owner/manager; red border + open-count badge when open disputes exist; resolve requires a reply
  text via prompt).
- **Change history** (`change-history.tsx`): owner/manager card on `/entries` — date-range filter,
  table (time, actor, ပြင်/ဖျက် + delivery/collection, agent · date, field-by-field "from → to"
  changes or the deleted record's snapshot, reason), shows 300 rows at a time with "ထပ်ပြမည်" load
  more, **CSV download** of the range, and **Owner-only "မှတ်တမ်းရှင်းမည်" purge** of the selected
  period (AlertDialog confirm; calls `purge_change_history` RPC).
- **Daily brief** (`daily-brief.tsx`): on `/reports` — date picker + focus checkboxes (disputes /
  receivable / sales); renders rule-based action items with severity icons (high/warn/info). Rules in
  `brief.ts`: open disputes first (high); debts aged >60 d (high) / 30–60 d (warn); trips today not
  fully paid (info); today's sales < 80 % of the previous-7-day average (warn) or "normal" (info);
  no sales recorded today (warn); agents active in the last 7 days who haven't delivered today (info);
  a "nothing to do" item when empty.
- **Monthly trend chart** (`monthly-trend-chart.tsx`): Recharts ComposedChart — bars for Sales and
  Costs, line for Profit, 6/12/24-month toggle, current-month vs previous-month % change cards for
  sales and profit, best-profit-month card, K/M axis formatting, MMK tooltip.
- **Backup card** (`backup-card.tsx`, owner, in Settings): month picker (defaults last month);
  shows whether that month is locked; **Excel download** (one sheet per table, §8), **CSV download**
  (single combined file, §8); **lock/unlock month** button with confirm dialogs (lock warns that
  only the Owner can then edit and recommends backing up first); list of currently locked months.
- **Push card** (`push-card.tsx`, in Settings): see 1.16.
- **Language toggle** (`language-toggle.tsx`): compact မြန်မာ/EN button in the header, mobile sheet
  menu and login page.
- **Offline sync** (`offline-sync.tsx`): `useOfflineFlush` — on reconnect (and every 60 s) sends
  queued entries one by one; server-rejected entries are dropped with a long error toast; success
  toast reports how many were sent. `OfflineBanner` — red banner when offline or when the queue is
  non-empty ("အင်တာနက် မရှိပါ / ပို့ရန် စောင့်နေသည် — ဖုန်းထဲ မှတ်ထားသော မှတ်တမ်း N ခု").
- **shadcn/ui set** (`components/ui/`): alert-dialog, badge, button, card, checkbox, dialog, input,
  label, popover, select, sheet, skeleton, sonner (toasts, top-center, rich colours), table.
  Buttons auto-show a spinner and disable themselves while an async onClick is in flight; toasts via
  Sonner for every save/error.

---

## 3. Server functions (TanStack `createServerFn`, `src/lib/*.functions.ts`)

All require a Supabase session (middleware) and re-check roles from `user_roles` server-side.

- **auth.functions.ts**: `getMyRoles`, `claimOwnerIfNone`, `listUsers` (owner), `createUserAccount`
  (owner), `setUserRole` (owner, grant/revoke), `setUserHidden` (owner; bans + soft-delete/restore),
  `resetUserPassword` (owner; PIN-aware), `pinSignIn` (PUBLIC; 4-digit PIN → session, lockout),
  `recordLogin`, `listLoginLogs` (owner, last 100), `usernameToEmail`.
- **data.functions.ts**: `listAgents`, `saveAgent` (create/update; closed agents immutable),
  `listEntries` (range/agent filter; deleted agents shown via name snapshot + "(ဖျက်ပြီး)"),
  `saveEntry` (bottle-limit + credit-limit checks; closed-agent rejected), `updateEntry`,
  `deleteEntry` (both reason-stamped, same-day rule for employees), `getEmployeeSummary`,
  `listExpenses`, `saveExpense`, `getMyAgentData` (agent self-view incl. owed/balance/deposit),
  `exportDailyCsv`, `getAgentDetail`.
- **collections.functions.ts**: `recordCollection`, `listCollections`, `listCollectionsReport`
  (owner/manager), `listAgentBalances` (per-agent owed + full event ledger), `updateCollection`,
  `deleteCollection` (reason + same-day rule).
- **closeout.functions.ts**: `getCloseout`, `addDeposit`, `addPayment`, `closeoutWriteOff`,
  `finalizeCloseout`, `hardDeleteAgent` (owner; RPC).
- **phase2.functions.ts**: `getPayroll`, `setSalary`, `addAdvance`, `addBonus`, `payMonth`,
  `addWriteOff`, `getReport`, `getMonthlyTrend` (all owner/manager).
- **ops.functions.ts**: `getHandoverDay`, `saveHandover`, `getInventory`, `addStockMove`,
  `deleteStockMove` (owner/manager).
- **backup.functions.ts**: `getMonthlyBackup` (owner), `listMonthLocks`, `setMonthLock` (owner).
- **history.functions.ts**: `listAuditLog` (owner/manager, 200), `listChangeHistory`
  (owner/manager), `purgeChangeHistory` (owner).
- **disputes.functions.ts**: `fileDispute` (agent, own records only, one open dispute per record),
  `listDisputes` (agent: own; OM: all, open first, ≤300), `resolveDispute` (OM, reply required).
- **push.functions.ts**: `registerPushToken` (token rebinds to whoever signed in last on the device),
  `pushStatus` (device count), `disablePush` (deletes all my tokens), `getPushWebKey` (Firebase web
  API key served at runtime from env), `getNotifyPrefs` / `saveNotifyPrefs`.
- **brief.functions.ts**: `getDailyBrief` (owner/manager).
- **data-quality.functions.ts**: `runDataQuality` (owner/manager; returns counts + up to 2,000 issues).

### Public HTTP endpoints (`src/routes/api/public/**`, server routes, secret-authenticated)
- `POST /api/public/hooks/push` — called by a Postgres trigger (pg_net) on every notification
  insert; verifies `x-push-secret` against `push_config` (constant-time compare); loads the
  recipient's FCM tokens and sends via the **Lovable connector gateway**
  (`connector-gateway.lovable.dev/firebase_messaging`) with the notification title/body (≤120 chars),
  `data.link`, webpush urgency high, TTL 86400, tag (same tag replaces the previous phone
  notification), icon/badge `/icons/icon-192.png`, `requireInteraction` for high priority; dead
  tokens (404/UNREGISTERED) are deleted.
- `POST /api/public/jobs/daily-digest` — cron-authenticated (see cron-auth.ts); builds today's digest
  (bottles, cash + collections, new debt) and inserts a `digest` notification (priority high, tag
  `digest:<date>`) for owner/manager/co_owner.
- `POST /api/public/jobs/data-quality` — cron-authenticated; runs all data-quality checks, filters
  out issues already in `dq_seen`, stores new issue keys, and inserts one `data_quality`
  notification for owner/manager/co_owner when there are fresh issues.

There are **no Supabase Edge Functions**. `supabase/` contains only `config.toml`
(`project_id = "ikxvscflufaiajunjdcg"`).

---

## 4. Database schema (Postgres on Lovable Cloud; final state after 37 migrations)

27 tables (columns from `src/integrations/supabase/types.ts`; money is `numeric`, dates are `date`,
timestamps `timestamptz`):

| Table | Columns (key ones) | Notes |
|---|---|---|
| `profiles` | id (FK auth.users), full_name, phone, username, deleted_at, deleted_by, created_at | username added 0001; soft-delete 0003 |
| `user_roles` | id, user_id, role (enum) | unique (user_id, role); multi-role |
| `agents` | id, name, phone, address, deposit_per_bottle, price_per_bottle, bottle_limit, credit_limit, active, user_id (linked login), closed_at, closed_by, created_at | address 0009, bottle_limit 0008, credit limit + closeout 0028/0005 |
| `daily_entries` | id, entry_date, agent_id (FK, SET NULL on delete), agent_name (snapshot), bottles_out, empties_in, amount_collected, unit_price (snapshot), note, entered_by, change_reason, updated_at, updated_by, created_at | unit_price snapshot 0006; multiple trips/day 0015 |
| `agent_payments` | id, payment_date, agent_id (SET NULL), agent_name, amount, note, created_by, change_reason, updated_at/by | = later debt collections |
| `agent_deposits` | id, deposit_date, agent_id, agent_name, bottles, price_per_bottle, amount, note, created_by | per-record price at time taken |
| `agent_settlements` | id, settle_date, agent_id, agent_name, held_bottles, returned_bottles, missing_bottles, current_price, deposit_original, refund_amount, price_diff, price_diff_kind, forfeiture_income, net_refund, agent_owes, note, created_by | one per closed agent |
| `write_offs` | id, writeoff_date, agent_id, agent_name, amount, note, created_by | bad-debt write-offs |
| `expenses` | id, expense_date, category (free text from fixed UI list), amount, note, entered_by | close-out auto-adds category "ဗူးအပေါင် ဈေးကွာ" |
| `salary_settings` | user_id (PK), monthly_salary, updated_at | |
| `advances` | id, user_id, advance_date, amount, installment (0 = one-shot), note, created_by | |
| `advance_repayments` | id, advance_id (FK CASCADE), month, amount | written by payMonth |
| `bonuses` | id, user_id, month, amount, note, created_by | |
| `payroll_runs` | id, user_id, month, base, bonus, deduction, net, created_by | unique (user_id, month) — a month can be paid once |
| `cash_handovers` | id, handover_date, employee_id, expected, received, note, received_by | unique per (date, employee) via upsert conflict |
| `stock_moves` | id, move_date, kind ∈ (produce, purchase, damage), bottles, note, created_by | |
| `record_disputes` | id, agent_id, kind ∈ (entry, payment), record_id, record_date, record_summary, message, status (open/resolved), response, created_by, resolved_by, resolved_at | 0020 |
| `audit_log` | id (bigint), table_name, action (INSERT/UPDATE/DELETE), record_id, actor, old_data (jsonb), new_data (jsonb), at | insert-only (see below) |
| `login_logs` | id, user_id, user_agent, at | owner-readable |
| `pin_attempts` | username (PK), fails, locked_until, updated_at | 5 fails → 15-min lock (0010) |
| `month_locks` | month (PK, YYYY-MM), locked_by, locked_at | 0026 |
| `notifications` | id, user_id, kind, title, body, link, priority (normal/high), tag, read_at, created_at | kinds below |
| `notify_prefs` | user_id (PK), mode ∈ (all, important), quiet_night, updated_at | 0036 |
| `push_tokens` | token, user_id, user_agent, created_at | |
| `push_config` | id=1, hook_url, hook_secret | for the push trigger |
| `app_settings` | id=1 (single row), app_name, factory_phone, factory_address, default_price_per_bottle, default_deposit_per_bottle, refresh_seconds, updated_at, updated_by | 0014; reads restricted to signed-in users (0030) except name via RPC |
| `dq_seen` | key (PK), first_seen | dedupe for daily data-quality alerts (0027) |

Enum: `app_role` = owner | manager | employee | agent | co_owner (co_owner added 0011).

**RPC functions**: `has_role(user, role)` (co_owner counts as manager), `my_deposit_total()` (agent's
own deposit sum), `public_app_name()`, `hard_delete_agent(_agent)` (requires settlement; nulls FKs,
keeps snapshots), `purge_change_history(from, to)` (owner-only SECURITY DEFINER; the ONLY way audit
rows are deleted), `agent_outstanding(_agent)`, `notify_staff` / `notify_staff2` (insert notifications
for owner/manager/co_owner except the actor), `fmt_ks(n)` (thousands format), `fmt_day(d)`.

**Triggers**:
- `write_audit` on daily_entries, agent_payments, expenses, agents, agent_deposits,
  agent_settlements, cash_handovers, stock_moves, write_offs → full old/new row images into
  `audit_log` with the acting user; `audit_log_block_change` makes audit_log UPDATE/DELETE-proof.
- `fill_agent_name` — snapshots the agent's current name onto child rows at insert.
- `sync_entry_price` — snapshots the agent's current `price_per_bottle` into `daily_entries.unit_price`.
- `enforce_month_lock` (BEFORE INSERT/UPDATE/DELETE on daily_entries, agent_payments, expenses,
  agent_deposits, write_offs, agent_settlements, advances, bonuses, payroll_runs,
  advance_repayments) — blocks writes whose date falls in a locked month **for everyone except the
  Owner** (owner exempt; service role/null-uid bypass).
- Notification triggers: `notify_on_delivery` (per delivery: staff get "agent — N trips · M bottles",
  body cash/debt, high priority + ⚠ when the agent's outstanding exceeds their credit limit; tag
  `delivery:<agent>:<date>`), `notify_on_collection`, `notify_on_receipt` /
  `notify_on_past_edit` / `notify_owner_of_record` (edits/deletes of past-day records notify),
  `notify_on_dispute` (staff), `notify_on_dispute_reply` (to the agent), plus receipt notifications
  to the agent for their own deliveries/payments (0032 delivery staff notify; 0025 complete set).
  Exact per-trigger recipient lists live in migrations 0021/0023/0025/0032/0036.
- `push_on_notification` — pg_net POST to `push_config.hook_url` on notification insert, honouring
  `notify_prefs` (important-only mode and night-quiet skip normal-priority pushes).

**RLS (representative policies; every table has RLS on)**: users read own profile/roles; OM read all
profiles; employees insert/read/update/delete **own same-day** entries and payments only (0022);
agents read own payments, own write-offs, own disputes and file disputes; OM manage
handovers/stock/agents; owner-only: login_logs read, month lock/unlock, app_settings update;
signed-in users read app_settings + month_locks; notifications: users read/mark own; push_tokens:
own rows only. Trigger functions had anon EXECUTE revoked (0035). Perf indexes added 0034.
Migration 0013 is a one-off "wipe all data, keep owner" reset (already executed historically).

---

## 5. Auth & roles (from code)

- Identity: Supabase Auth. Login identifier is a **username**; the auth email is synthetic
  (`username@waterfactory.local`). No self-registration.
- Roles (multi-role per user, stored in `user_roles`): **owner**, **co_owner** (= manager permissions
  everywhere, expanded at every role read incl. SQL `has_role`), **manager**, **employee** (ဝန်ထမ်း,
  delivery staff), **agent** (ကိုယ်စားလှယ်). Owner/manager/co_owner sign in with a password (≥8 chars);
  employee/agent sign in with a **4-digit PIN**. An account whose roles are exclusively
  employee/agent is a "PIN account".
- PIN mechanics: the real Supabase password is `HMAC-SHA256(PIN_PEPPER, "<userId>:<pin>")` derived
  server-side (`pin.server.ts`) — the PIN itself is never stored. `pinSignIn` checks `pin_attempts`:
  5 consecutive failures → 15-minute lock; success clears attempts; owner password reset also clears.
- Owner powers: create accounts, grant/revoke any role by clicking badges, reset any password/PIN,
  deactivate (auth ban 876000h + `profiles.deleted_at` stamp; records preserved; excluded from
  payroll/lists/totals) and restore; owner cannot deactivate self; only the owner sees `/users`,
  login logs and the backup/month-lock card; owner alone can purge change history and hard-delete a
  settled agent; owner is exempt from month locks.
- First-run bootstrap: if no owner exists, any signed-in role-less user can claim Owner once.
- Session: standard Supabase session; layout invalidates queries on sign-in/out/user-updated;
  banned (deactivated) users get a specific Myanmar error at login.
- Page access matrix: see the table in §1 (nav visibility mirrors it; server fns + RLS enforce it).

## 6. Agents — feature summary
Covered in 1.7–1.9: CRUD with phone + address, per-agent sale price, deposit-per-bottle, bottle
limit, credit limit (MMK), active toggle, optional link to a login account, initial deposit on
creation, inline price/limit editing, closed-agent list, rich detail page, deposit ledger, and the
4-step close-out with settlement math, price-difference expense booking, and owner hard delete.

## 7. Business logic (exact rules from code)

- **Trip value / debt**: trip due = bottles_out × unit_price(snapshot) − amount_collected.
  Agent owed = Σ trip values − cash at delivery − later payments − write-offs (`agent_outstanding`,
  `agentDebt`, `agentOwed`; reports clamp per-agent receivable at ≥ 0 in some views — getReport uses
  `Math.max(0, …)`, agent detail does not clamp).
- **Bottle limit** (`bottle-limit.ts` + `assertBottleLimit`): held-after-this-trip must not exceed
  (a) the agent's bottle_limit when > 0, and (b) the agent's total deposit bottles when a deposit
  price is set — error messages state the overage and the deposit top-up amount needed. Returning
  empties is always allowed. Checked on entry create AND edit.
- **Credit limit** (`ops.ts checkCreditLimit`): for EMPLOYEE saves only — new debt (current debt +
  this trip due) must not exceed the agent's credit_limit (0 = unlimited); owner/manager saving
  counts as approval and bypasses. Exceeding the limit also raises the delivery notification to
  high priority with a ⚠.
- **Stock** (`ops.ts stockSummary`): full = produced − out; empty = purchased + in − produced −
  damaged; withAgents = out − in; total = full + empty + withAgents.
- **Handover** (`ops.ts handoverDiff`): expected = day's delivery cash + day's debt collections per
  employee; |diff| < 0.5 = match, negative = short, positive = over.
- **Payroll**: net = base + bonus − deduction; deduction built from advances (installment capped at
  remaining, else full remaining; only advances dated ≤ payroll month); paying writes payroll_runs +
  advance_repayments and locks the row. Payroll population = users with employee/manager/co_owner
  roles, excluding soft-deleted.
- **Reports**: sales = Σ bottles × unit_price in range; collected = cash at delivery in range + later
  payments in range; expenses by category in range; payroll = Σ(base + bonus) of runs whose month is
  in range; **profit = sales + forfeiture income (settlements in range) − expenses − payroll −
  write-offs**; deposits excluded (liability). Receivable/deposit figures are cumulative up to the
  range end. Aging buckets ≤30 / 31–60 / >60 days, outstanding allocated newest-first.
- **Settlement** (`settlement.ts`): missing = held − returned; refund for returned deposit bottles =
  at today's price if the price rose (extra-pay), else at the original average price (price-drop
  difference booked as factory expense); forfeiture income = missing × current price;
  net = refund + (original deposit held for missing bottles) − forfeiture; netRefund = max(0, net),
  agentOwes = max(0, −net).
- **Edit/delete rules** (`record-edit.ts`): a reason (≥2 chars) is mandatory for editing/deleting
  entries and collections; employees only same-Yangon-day records; OM any day. The reason is stamped
  on the row first so the DELETE audit image carries it.
- **Month lock**: see §4. UI-side, the backup card is the only lock control (owner).
- **Data-quality rules** (`data-quality.ts`): identical duplicate entries same agent+day (different
  numbers are treated as legit multi-trip); negative values; > 2,000 bottles in one entry; future
  dates; all-zero entries; running bottle balance going negative; held > bottle_limit; entry
  unit_price ≠ agent's current price; deposit amount ≠ bottles × price (> 0.5 off); payroll
  net ≠ base + bonus − deduction; negative net pay; expense ≤ 0 or future-dated; FIFO-aged debt
  > 30 d (medium) / > 60 d (high) with call-them suggestions; held bottles > deposit bottles;
  trips with ≥ 20 bottles and 0 cash (suspicious); entries keyed in at 22:00–05:00 Yangon
  (suspicious). Each issue carries a Myanmar fix suggestion.
- **Brief rules**: see §2 (Daily brief).
- **Dates**: ALL business dates use Asia/Yangon (UTC+6:30) — `yangonDate()` adds 6.5 h; times shown
  as HH:MM Yangon; month = YYYY-MM strings. Money displayed with `toLocaleString()` thousands
  separators, unit ကျပ်. Sales in reports use the per-entry price snapshot, so later price changes
  don't rewrite history (except `listAgentBalances`/close-out state, which use the agent's CURRENT
  price — a real inconsistency in the old app worth noting for parity decisions).

## 8. Exports & print
- **Daily CSV** (Home, owner/manager): `daily-<date>.csv`, UTF-8 BOM; section 1 columns
  date, agent, bottles_out, empties_in, amount_collected, note; blank line; section 2 columns
  date, expense_category, amount, note.
- **Monthly backup Excel** (Settings → Backup card, owner): `backup-<YYYY-MM>.xlsx`, 10 sheets named
  ရေပို့, ကြွေးကောက်ငွေ, ကုန်ကျစရိတ်, အပေါင်ငွေ, စာရင်းပိတ်, ကြွေးပယ်ဖျက်, ကြိုတင်ငွေ, ကြိုတင်ငွေပြန်ဆပ်, ဆုကြေး, လစာ —
  each with Myanmar column headers (e.g. ရေပို့: ရက်စွဲ, ကိုယ်စားလှယ်, ပို့ဘူး, ဘူးခွံပြန်, တစ်ဘူးဈေး, လက်ခံငွေ,
  ထည့်သူ, မှတ်ချက်).
- **Monthly backup CSV**: same data as ONE combined CSV with a title line and `## <sheet> (n)`
  section headers, BOM + CRLF.
- **Report Excel** (Reports page): `report-<from>-<to>.xlsx`, 3 sheets: အနှစ်ချုပ် (period, sales,
  collected, expenses, payroll+bonus, write-offs, profit, receivable, deposit liability, forfeiture,
  refunds, aging ×3), ကုန်ကျစရိတ် (category, amount), ကိုယ်စားလှယ် (name, sales, collected, receivable,
  bottles, deposit).
- **Report PDF**: browser print of the reports page (print CSS hides sidebar/header/buttons);
  AGENTS.md states jsPDF was deliberately avoided because it can't render Myanmar script.
- **Change-history CSV** and **data-quality CSV**: see §2 / 1.13 (BOM, Myanmar headers).
- No other export formats exist. **UNKNOWN**: whether any print stylesheet beyond `print:hidden`
  utilities exists — only utility classes were found.

## 9. Notifications
- **In-app**: `notifications` table + bell (§2). Kinds: `delivery`, `collection`, `receipt`,
  `payment_receipt`, `dispute`, `dispute_reply`, `past_edit`, `record_changed`, `digest`,
  `data_quality`. Fields: title, body, link (deep link e.g. `/entries`, `/data-quality`, `/my`),
  priority normal/high, tag (same-tag pushes replace each other on the phone), read_at.
- **Triggers generating them** (recipients exclude the actor): delivery → owner/manager/co_owner;
  collection → staff; dispute filed → staff; dispute resolved → the agent; delivery/payment recorded
  for an agent → that agent (receipt); past-day record edited/deleted → owner (past_edit) and the
  record's agent where applicable (record_changed); evening digest → staff (job); data-quality fresh
  issues → staff (job). Notification text is short, Myanmar, 1–2 numbers, no zero values
  (`notify-text.ts` + SQL fmt_ks/fmt_day).
- **Push (FCM)**: Firebase web app; service worker `public/firebase-messaging-sw.js` (compat SDK
  10.12.0, config passed via query string; notification click opens `data.link`). Registration flow
  handles: not configured, unsupported browser, inside-iframe ("open in new tab"), permission denied,
  and iOS-not-on-home-screen cases with specific Myanmar instructions. Tokens stored per user;
  a token moves to whoever signed in last on that device. Sending goes through the Lovable connector
  gateway (NOT directly to FCM) using env keys (§11). Per-user prefs: mode all/important,
  quiet_night 22:00–06:00 for normal priority (enforced in the DB push trigger).
- **Digest**: daily-digest job (§3) — schedule itself is external (Lovable-managed cron);
  **UNKNOWN**: exact cron times for both jobs (not in the repo).

## 10. UI / UX DESIGN (what the old app actually looks like)

### 10.1 Theme & design tokens (`src/styles.css`, Tailwind v4, CSS-first config)
- shadcn-style token system in **oklch**, single hue family (blue, hue ≈ 230–250): light background
  `oklch(0.985 0.006 230)` (near-white blue-grey), foreground deep navy `oklch(0.22 0.04 245)`,
  primary blue `oklch(0.56 0.15 235)`, ring = primary. **Dark mode is fully defined** (`.dark`:
  background `oklch(0.17 0.025 245)`, primary brightens to `oklch(0.72 0.13 225)`) and user-selectable
  light/dark/system (per-device, no-flash init script in `<head>`).
- Semantic chart colours: chart-1..5 plus dedicated `--chart-sales` (green), `--chart-costs` (red),
  `--chart-profit` (blue), used consistently for money in/out colour-coding across pages.
- Radius base `--radius: 0.75rem` (cards typically rounded-2xl, buttons rounded-md, nav items
  rounded-xl). No custom font family is declared — system font stack; UI text is Myanmar script with
  Latin digits; numbers use tabular-nums in stat/chart contexts.
- Custom depth system: `.app-card` (layered soft shadow with a primary-tinted drop + 2 px lift on
  hover), `.raised` (chunky "physical button" look: inset top highlight + 3 px bottom shadow,
  presses down 2 px on :active with shadow collapse), `.tap` (scale 0.97 on press). Buttons also
  `active:scale-[0.97]`, `touch-manipulation`.
- Motion: page fade/slide-in 180 ms (`animate-page-in` on route change, keyed by pathname), table row
  fade-in 200 ms, top loading bar animation, skeleton pulse for the lazy chart; full
  `prefers-reduced-motion` support; dialog animations capped at 180 ms.
- Print: sidebar/header/bottom-nav/buttons carry `print:hidden`.

### 10.2 Layout structure
- **Desktop/tablet shell**: left sidebar (border-r, card background, sticky, full height) + sticky
  top header (h-14, backdrop-blur, translucent card bg) + content column max-w-7xl, px-6, py-6.
- **Phone shell**: no sidebar; sticky header with hamburger (opens a left Sheet menu, 82 % width,
  max-w-xs) OR a back button on drill-down pages; **fixed bottom navigation bar**; content px-3,
  pt-4, **pb-28** so content clears the bottom bar.
- Header contents: page title (contextual per route; on top-level pages the factory name), user full
  name (≥md), notification bell, language toggle, theme toggle (≥sm; on phone they live in the
  sheet menu footer together with sign-out).
- Sidebar contents: logo block (gradient droplet tile + app name), grouped nav (below), a
  collapse/expand button and sign-out pinned at the bottom.

### 10.3 Navigation pattern & labels (role-filtered)
- Sidebar groups (headings shown only in expanded mode):
  - နေ့စဉ်လုပ်ငန်း (Daily work): ပင်မ `/`, နေ့စဉ်မှတ်တမ်း `/entries`, ကြွေးကောက်ငွေ `/collections`,
    ငွေအပ်စာရင်း `/handover`, ကျွန်ုပ်၏မှတ်တမ်း `/my` (agent)
  - ကိုယ်စားလှယ်/ဘူး (Agents/bottles): ကိုယ်စားလှယ် `/agents`, ဘူးလက်ကျန် `/inventory`
  - ငွေစာရင်း (Money): ကုန်ကျစရိတ် `/expenses`, လစာ `/payroll`, စာရင်းရှင်းတမ်း `/reports`,
    စာရင်းစစ်ဆေး `/data-quality`
  - စီမံခန့်ခွဲ (Admin): အကောင့်များ `/users` (owner), ဆက်တင် `/settings` (all)
- Every item has a Lucide icon; active item = solid primary pill with white text; inactive =
  muted text with accent hover. The active phone bottom-nav item gets a primary-tinted pill behind
  its icon.
- **Phone bottom nav**: up to **4** items chosen from the role-filtered primary list
  ([/, /entries, /collections, /agents, /my, /settings]) with shortened labels (မှတ်တမ်း, ကြွေးကောက်);
  grid columns = item count; `pb-[env(safe-area-inset-bottom)]` for the iPhone home indicator.
- Drill-down pages (`/agent/*`, `/closeout/*`) swap the hamburger for a **back button**
  (history back, fallback to parent) and show a fixed page title.

### 10.4 Responsive behaviour per device class (the acceptance-criteria section)
Breakpoints are Tailwind defaults: **sm 640 px, md 768 px, lg 1024 px, xl 1280 px**, plus one custom
CSS media query at **max-width 639 px**. Concretely:

- **Phone (< 640 px)**
  - Bottom nav (above) + hamburger sheet for the full grouped menu; sidebar hidden entirely.
  - Buttons/inputs are at their LARGEST: default button h-11, small button h-10, inputs h-11
    (they SHRINK at ≥sm to h-9/h-8 — the scale is deliberately inverted for touch).
  - Entry/collection/deposit forms: single column, inputs h-12 text-lg, submit button h-14
    full-width; numeric fields use `inputMode="numeric"`.
  - Tables: most pages wrap tables in `overflow-x-auto` (horizontal scroll); the Collections page
    instead renders a **separate card-list markup** (`sm:hidden`) vs the table (`hidden sm:block`),
    including the expandable agent ledger as cards. A global CSS rule also exists to restyle any
    `table.rtable` into stacked cards with `data-label` pseudo-labels under 640 px — **no current
    page applies the `rtable` class** (found only in CSS).
  - Dashboard stat grid: 2 columns; reports stat groups: 1 column; data-quality filter cards:
    2 columns; settings option cards (theme/language): 2–3 columns of large tap targets.
  - Content bottom padding pb-28; safe-area inset on the bottom nav; dialogs are max-w-md rounded-2xl
    with a 2-column button grid.
- **Tablet (640–1023 px)**
  - Sidebar appears as an **icon rail** (w-16, icons only, tooltips via title attr); labels and
    group headings appear only at lg. Bottom nav and hamburger disappear (≥sm).
  - Buttons/inputs compact (h-9 / h-8); content px-6.
  - Dashboard stats: 3 columns (md); inventory/handover cards 4 across (md); data-quality filters
    3 across (md); reports groups 2–3 across (sm); entries/expenses still single-column stacked
    (the side-by-side form+list layout only starts at xl).
  - Agents table remains a full table with horizontal scroll on overflow.
- **Desktop (≥ 1024 px)**
  - Sidebar expands to w-60 **if** the user left it expanded (persisted in localStorage `nav-wide`;
    on sm–lg widths it stays a rail even when "wide"); group headings visible; collapse toggle in
    the sidebar footer.
  - Dashboard stats 5 across (lg); reports 4-across group; data-quality filters 6 across (lg);
    payroll advance/bonus cards side by side (lg).
  - At **xl (≥1280 px)** the entries and expenses pages switch to a two-pane layout: form card
    380–400 px, **sticky** (top-20), list fills the rest; agent-row action buttons switch from
    stacked to a row (xl:flex-row).
- Device-specific touches: 44 px+ touch targets on phone (h-11/h-12/h-14 controls), numeric
  keyboards via inputMode, tap-scale feedback, safe-area padding, `touch-manipulation` to kill
  double-tap zoom delay, CountUp animation on dashboard numbers, auto-centring of the active item
  in scrollable nav, PWA standalone display (below).

### 10.5 Cards, lists, forms — visual patterns
- Everything lives in white `Card`s (rounded-2xl-ish, border, the .app-card shadow on report stats)
  on the pale blue-grey background; sections separated by 24 px gaps.
- Stat cards pattern: small muted label + Lucide icon right, big bold number (text-xl→2xl);
  money owed = red (destructive or chart-costs), money good = green (chart-sales) / primary.
- Tables: shadcn Table, right-aligned numeric columns, whitespace-nowrap on dates/names,
  muted empty-state row ("မှတ်တမ်း မရှိသေးပါ" etc.) centred in every table/list.
- Forms: Label above input, 16 px gaps, selects are Radix; validation errors are Sonner toasts
  (top-center, rich colours) rather than inline field errors; destructive actions always pass
  through the styled confirm dialog; success = toast.
- Badges: status pills (active/closed/paid/short/over/open-dispute counts).
- Overall character: **dense, operational, card-heavy** — a working tool, not a marketing page;
  colour is restrained (one blue family + semantic green/red/amber), iconography is Lucide line
  icons throughout, depth comes from the raised-button/app-card shadow system rather than gradients
  (the only gradient is the logo tile: primary → chart-2 blue).

### 10.6 Branding & PWA
- App name in code defaults to "ရေသန့်ဘူး Factory" but is **owner-editable** in settings and then
  used in the sidebar, header, login card, document title and manifest-driven surfaces. (The shipped
  PWA manifest name is the factory's configured name; manifest: standalone, portrait, theme/background
  `#1565C0`, lang `my`, icons 192 + 512 incl. maskable; apple-touch-icon present; apple-mobile-web-app
  capable/title meta set; favicon.png.)
- Logo mark: a white Droplets glyph on a blue gradient rounded tile (in-app); PWA icon files in
  `public/icons/` (192, 512, 512-full, apple-touch).
- Page titles follow "<Page> — ရေသန့်ဘူး Factory"; `<html lang="my">`.

### 10.7 Language
- UI is **authored in Myanmar**; numbers are Latin digits with en-US/en-GB formatting
  (`toLocaleString()`, `toLocaleString("en-GB")` for date-times).
- English mode is a **DOM phrase translator**: a ~583-entry Myanmar→English dictionary
  (`i18n-dict.ts`, 51 KB) + a MutationObserver that rewrites visible text nodes, placeholders,
  titles and aria-labels, converts Myanmar digits and punctuation; elements with
  `data-no-translate` (app name, language toggle) are exempt; switching back to Myanmar reloads the
  page. Language is per-device localStorage. Currency/unit words (ကျပ်) come from the dictionary too.

## 11. Integrations & environment
- package.json feature-bearing deps: `firebase` (FCM), `xlsx` via SheetJS CDN tarball
  (xlsx-0.20.3), `recharts`, `@supabase/supabase-js`, TanStack Start/Router/Query, Radix UI set,
  `sonner`, `lucide-react`, `tw-animate-css`, drizzle-orm/drizzle-kit + `postgres` (dev/tooling),
  nitro. **No jspdf** (print-to-PDF instead), **no date library** (hand-rolled Yangon helpers).
- `.env` key NAMES (values never recorded): SUPABASE_PROJECT_ID, SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL, VITE_SUPABASE_PROJECT_ID, VITE_SUPABASE_PUBLISHABLE_KEY, VITE_SUPABASE_URL,
  VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_APP_ID, _PROJECT_ID, _VAPID_KEY, _WEB_API_KEY.
  Server-only env referenced in code: PIN_PEPPER, LOVABLE_API_KEY, FIREBASE_MESSAGING_API_KEY,
  GOOGLE_API_KEY (served to the client at runtime as the Firebase web key), SUPABASE_URL /
  SUPABASE_PUBLISHABLE_KEY (service client also uses the standard Lovable Cloud service key —
  exact var name in client.server.ts not re-verified, see UNKNOWN).
- Error reporting: root error boundary + `reportLovableError` (`lovable-error-reporting.ts`)
  reports crashes to Lovable's tooling; custom error-capture in `src/server.ts`/`error-page.ts`.
- Testing in repo: Vitest unit tests for settlement/ops/bottle-limit/brief/data-quality/i18n/
  backup-csv/notify-text/routing; Playwright e2e (`e2e/roles_e2e.py`, `month_lock_e2e.ts`) with
  fixture accounts.

## 12. UNKNOWN / not verified
- Exact cron schedule times for the daily-digest and data-quality jobs (managed outside the repo).
- The precise recipient list of the `receipt` / `payment_receipt` agent notifications per trigger
  (migrations 0021/0025/0032/0036 were read in part; kinds and the delivery/collection/dispute/
  dispute-reply/digest/data-quality flows are confirmed, the agent-receipt wording is confirmed in
  the bell + push prefs copy but not line-by-line per trigger).
- Service-role env var name inside `src/integrations/supabase/client.server.ts` (file read via
  imports only; standard Lovable Cloud naming assumed — NOT asserted).
- `.lovable/plan/*.md` design-plan documents (9 files, Burmese filenames, dated 2026-10-19) exist
  and describe past UI work (tablet/phone UI, animations, menu redesign, push plans); they were
  listed but not read in full — they document intent, not additional shipped features.
- Whether the deployed live app differs from commit 8b54734 (the repo HEAD given for this audit);
  the live site was not inspected.
