# Water Factory Management System — Business Rules (SPEC)

Myanmar-language water-delivery business management app (ရေသန့်စက်ရုံ).
This system is the rebuild of Aqua Crate Ledger: same functions, bugs fixed, structure systematized.

- **Database:** the business's OWN Supabase project (Postgres + RLS). Data must stay in the owner's Supabase — NEVER move the database into Lovable Cloud.
- **Code:** this GitHub repo is the source of truth.
- **Push notifications (later phase):** Firebase Cloud Messaging, project `water-delivery-noti`.

## Roles (4)
- Owner, Manager, Staff, Agent. Owner manages accounts.
- Server-side enforcement is mandatory for every rule below. A UI-only restriction is a bug, not a rule.

## Non-negotiable rules
1. **Agent data isolation (server-side RLS):** an Agent sees ONLY their own data — never another agent's deliveries, collections, or records.
2. **Phone numbers:** Owner and Manager may see all phone numbers. Staff see agent names/codes but NOT phone numbers. An Agent sees only their own phone number. (In the old app, a policy let Staff read all agent phone numbers — that leak is fixed here by design: phone numbers live in a separate `agent_contacts` table with its own strict RLS.)
3. **Delivery entry is done by Staff** (Owner/Manager may also enter, subject to the same edit rules).
4. **Same-day edit/delete only — for EVERY role, Owner included:** a record may be edited or deleted ONLY on the same calendar day (Asia/Yangon) it was created. Enforced server-side by trigger, not just by hiding buttons. (The old app silently exempted Owner/Manager; that deviation is removed.)
5. **Audit log is immutable:** every create/edit/delete on business tables is logged with the FULL before-image (`old_data`) and after-image (`new_data`). Log entries can never be edited or deleted by any role, including Owner. There is NO purge function. (The old app had an Owner-only purge; removed here.)
6. **Month lock:** a locked month cannot be edited by ANY role, Owner included — enforced by trigger on all business tables. Locking/unlocking is itself audited. (Who may lock/unlock: see TBD.)
7. **Per-agent bottle-deposit settings:** the agent record carries its own deposit settings. Never apply one agent's deposit settings to another agent.
8. **Push notifications cover:** collections, disputes, data-quality alerts.

## Phase 1 scope (this build)
Login with 4 roles (username + PIN), agent list with per-agent bottle-deposit settings, staff delivery entry page, collections (agent payments), expenses, same-day edit/delete, immutable audit log + change-history view, month locks, Owner one-tap backup export with last-backup tracking, agent-only-own-data isolation.

## Phase 2 scope (NOT yet specified — ask the owner before building)
Salary calculation, accounting reports, Excel/PDF/CSV export, dashboard charts, FCM push wiring.
- **Reports requirement (owner, 2026-11-03):** a per-year view for EVERY year since the business started, showing all 12 months with each month's profit/loss (income vs expenses). The owner must be able to open any past year at any time — this is why business data is never deleted (see Backups).

## TBD — owner must fill in before any Phase 2 build
- Salary formula: [TBD]
- Bottle-deposit amounts / pricing per agent type: [TBD]
- Delivery pricing: [TBD]
- Who may lock/unlock a month, and the unlock procedure: [TBD — interim default in code: Owner and Manager may lock; only Owner may unlock; both actions audited]
- Dispute workflow steps: [TBD — Phase 1 keeps the old app's simple flow: agent raises → manager replies → notification]

## Backups and data safety (decided 2026-11-03)
- Foundation: Path A — the business's own Supabase project (Postgres), Free plan. Verified: Supabase Free has NO automatic backups and no point-in-time recovery — backups are OUR system, not Supabase's.
- The app MUST include an Owner-only "Download backup" button, prominent on the Owner's home screen: one tap exports all business tables to one file (JSON/CSV) the Owner saves outside Supabase (Google Drive + phone — 2 copies in 2 places). Rhythm: **weekly minimum** (daily is one tap and safer). The app records the last backup time and visibly reminds the Owner when a backup is overdue.
- The audit log stores the FULL before-image of every changed/deleted row, so ordinary app-level mistakes can be restored from the log even without a backup file.
- Retention for the Owner's files: keep daily backups for the last 30 days only; beyond that keep ONE backup per month (the month's last) long-term. Files are auto-named by date (e.g. `backup-2026-11-03.json`).
- Database structure (schema, RLS policies, triggers) lives as migrations in this repo — GitHub is the structure backup.
- Recovery contract: latest data export + repo migrations must be enough to rebuild the whole system on a fresh Supabase project. Exports stay in standard formats — no vendor lock-in.
- **Business data is NEVER deleted from the database to save space:** full history stays live and queryable forever. If storage ever tightens years from now, archive ONLY old audit-log years out to files (kept and restorable) — delivery/business records always stay in the database.

## How to work on this codebase (builder rules)
- Only ONE builder at a time (a human, Lovable, Codex, or Muse) — never two editing simultaneously.
- Work on a branch + Pull Request for anything non-trivial; merge only after the diff is reviewed.
- Keep each change small; build and test before merging.
- Never edit the live database directly to "fix" app data — change code, then verify.
- If a requested change conflicts with a non-negotiable rule above, stop and say so instead of silently weakening the rule.
- In names and titles write "ရေသန့်စက်ရုံ" generically — do not hard-code a specific factory brand name in code or docs; the display name is an app setting.
