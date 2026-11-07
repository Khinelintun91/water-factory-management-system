# HANDOVER — Water Factory Management System (for the next AI / developer)

_Written 2026-11-07 for the project owner, ခိုင်လင်းထွန်း (Khine Lin Tun), to hand this
project to another AI (e.g. Grok) or developer **without starting over**.
Everything needed lives in the owner's own accounts — nothing is locked inside any AI._

**If you are the AI receiving this:** read this file fully, then read `SPEC.md` (the
contract), `AGENTS.md` (builder rules), `docs/ARCHITECTURE.md` and `docs/SETUP.md`
in the repository, in that order, before touching anything. Where this file and
`SPEC.md` disagree, `SPEC.md` wins.

---

## 1. What this project is

A Myanmar-language (Burmese UI) management app for the owner's water-delivery
factory business (ရေသန့်စက်ရုံ): daily bottle entries, agent deposits & outstanding
balances, payments/collections, expenses, payroll, inventory, disputes, reports,
notifications, and an immutable audit log.

It is a **rebuild** of an older Lovable app ("Aqua Crate Ledger"), built because the
owner needs full control of his own code, database and hosting, and prompt-only
maintenance: he describes a feature or an error in one prompt and expects it fixed
or built in one go.

Business facts: the factory produces **only ဗူး** (plastic bottles/containers) —
never ပုလင်း (glass bottles). Currency is MMK, integers only. Timezone Asia/Yangon.

## 2. Where everything lives (owner's own accounts)

| Piece | Location |
|---|---|
| Source code | GitHub repo **`Khinelintun91/water-factory-management-system`**, branch `main` |
| Database + Auth | Supabase project **"water-factory"**, ref `mliiwrwbbxzhjegyivfz`, region ap-northeast-2, Postgres 17, **Free plan** |
| Live site | https://water-factory-management-system.khinelintun91.workers.dev (Cloudflare Workers static assets; a push to `main` triggers the deploy) |
| Old app (reference only) | `aqua-crate-ledger.lovable.app` + GitHub repo `Khinelintun91/aqua-crate-ledger` — **READ-ONLY, never edit, never merge its open PR #1** |
| Design reference for features | The old Lovable app is the parity reference ("everything it has, nothing left behind") |

⚠️ As of 2026-11-07 the GitHub repo is still **PUBLIC** (no secrets are in it — the
Supabase publishable key is public-by-design, `.env` was never committed, there is no
service_role key anywhere in the repo). The owner has been asked to make it private
(GitHub → repo → Settings → Danger Zone → Change repository visibility).

## 3. Stack & architecture (short version — details in `docs/ARCHITECTURE.md`)

- React 19 + Vite + TypeScript + Tailwind CSS v4, client-only SPA.
- Supabase JS client; **all** data access from the browser. Security lives in the
  database: Row Level Security + triggers + `SECURITY DEFINER` RPCs. There is no
  other backend. User management runs through the migration-0014 RPCs: after the
  one-time bootstrapped first Owner (SETUP.md §3), the Owner creates all later
  accounts and resets PINs from the app's **Users page** via `admin_create_user()`
  / `admin_reset_pin()` (SETUP.md §4). The `supabase/functions/admin-create-user/`
  Edge Function in the repo is a superseded reference implementation only — it is
  **not** the live path and must not be wired back.
- Login is **username + PIN/password only**. Internally each username maps to a
  synthetic email `username@waterfactory.local` for Supabase Auth — that address is
  an internal identifier and must **never** be shown in the UI.
- Roles: `owner`, `manager`, `staff`, `agent` (plus `primary_agent`: an agent who is
  also staff — enters own bottles like staff, collects only own money).
- Migrations `0001`–`0029` in `supabase/migrations/`; `supabase/apply_all.sql` is the
  regenerated concatenation (0001–0029) used for fresh installs and tests.

## 4. Non-negotiable rules (owner's firm decisions — never weaken silently)

From `SPEC.md` §3 plus decisions the owner made during the build. If a request
conflicts with one of these, stop and flag it to the owner first.

1. **Data isolation** — an agent sees ONLY their own data; staff-plus see all.
   Enforced in RLS/RPCs, never only in the UI.
2. **Privacy** — staff must NOT be able to read agent phone numbers
   (`agent_contacts` is owner/manager only).
3. **Same-day edit/delete** — entries, payments and expenses can be edited/deleted
   only on the day they were created, by ALL roles including owner. Exception
   (owner-approved, migration 0018): the **owner** may create backdated records;
   month lock still binds the owner.
4. **Audit log is insert-only FOREVER** — never deletable by anyone, including the
   owner (decided 2026-11-03). Never build a purge/delete feature for it.
5. **Month lock** — a locked month rejects all writes for every role.
6. **Per-agent prices & deposits** — no global price; each order keeps a price
   snapshot; bottle deposits are per-agent (no default 10,000).
7. **Close-outs are immutable** — reopening is owner-only, with a mandatory reason.
8. **Words** — bottle word is always **ဗူး**, never ပုလင်း. The classifier လုံး was
   replaced by ဗူး in all bottle contexts (deliberate exceptions: device counts
   like "စက်: N လုံး", and unrelated words like အားလုံး).
9. **Times** — every time shown in the app is **12-hour with AM/PM**
   ("9:27 AM", "4/11/2026 · 5:27 PM"), Asia/Yangon. Never 24-hour, never Burmese
   daypart words (မနက်/နေ့လယ်/ညနေ/ည). Use the shared `fmtTime12`/`fmtDateTime12`
   helpers in `src/lib/types.ts`.
10. **Naming** — write "ရေသန့်စက်ရုံ" only; no brand prefix. The displayed factory
    name comes from `app_settings.factory_name`.
11. **Design the owner loves — do not redesign away**: the Collections/Agents lists
    are a **wallet card stack** (full-colour card faces overlapping so only the
    name strip shows; tap a face to open its details). Face colour = sales tier:
    top third by lifetime sales GOLD, middle WHITE/silver, bottom BLACK; zero-sales
    agents black; **closed/settled agents are always black**. Reuse this style when
    the owner asks for "this style". **Glassmorphism was tried and rejected twice —
    never propose glass/frosted designs for this app.**
12. **Login UX** — username + PIN/password only; no email-based login screens.

## 5. Current state (verified 2026-11-06/07)

- **Feature parity with the old Lovable app is achieved**, and the UI was iterated
  with the owner on his phone (wallet stacks, scroll-jump buttons, owner backdating,
  disputes ordering, overpayment wording ပိုပေးထားငွေ, login history, etc.).
  `docs/GAP-ANALYSIS.md` is the 2026-11-03 document and is **historical only** — it
  is badly stale; do not treat its "missing" list as current.
- Migrations **0001–0029 are ALL applied to the live database** and verified.
- The live database is **CLEAN AND EMPTY**: all test/seed data was purged on
  2026-11-07 (with a verified backup taken first). Only the owner's account exists.
  **No real staff/agent accounts and no real business data yet** — creating the real
  accounts needs the owner's list of names/usernames; ask him when you start the pilot.
- The **old Lovable app is still the business's live system**. The rebuild replaces
  it only after a real-data pilot (parallel run + reconciliation) earns the switch.
  Do not press the owner to switch early, and never modify the old app.
- pg_cron jobs run daily on the DB: digest at 19:00 and data-quality alerts at
  08:30 (Yangon).

## 6. Security state after the 2026-11-06 P0 hardening

- Anonymous callers can execute only 4 deliberate functions
  (`log_login_attempt`, `log_failed_login`, `login_lock_status`,
  `public_factory_name`); direct client INSERT into `login_logs` is closed.
  Login lockout logic moved into gateway RPCs (0026).
- Same-day guards now cover all money tables symmetrically (0027), including
  deposits, write-offs, advances, bonuses and cash handovers.
- A **last-owner guard** prevents deactivating/re-roling/deleting the final active
  owner (0026). `agent_outstanding` rejects callers who are neither staff-plus nor
  the agent themself (0029). **Signup is disabled** (`disable_signup = true`).
- Known platform limits (verified, not bugs): session time-box / inactivity
  timeouts are **Pro-plan only** on Supabase (the Free plan rejects them with 402).
  Supabase **Free has no automatic backups** — see §7.
- PINs are short by design for staff usability; the compensating controls are the
  lockout gateways above. The owner has been advised to use an 8–12 digit owner PIN
  and to enable MFA on his Supabase/GitHub/Cloudflare accounts (his action, pending).

## 7. Backup & restore (proven, not theoretical)

- Backup = the app's Owner-only one-tap export (JSON of all business tables).
  Owner's rhythm: at least weekly, daily is safer; the app tracks `last_backup_at`
  and reminds when today's backup is missing. Retention: daily files 30 days, then
  one per month long-term. **Business data is never deleted.**
- Auth accounts are **not** in the backup (Supabase Auth is separate) — SETUP.md
  and the RESTORE-RUNBOOK document how accounts are recreated after a restore:
  bootstrap the first Owner, then recreate everyone else from the app's Users
  page (PINs are re-issued, never restored).
- A full **restore drill passed on 2026-11-06**: a backup file was restored into a
  clean Postgres 17 and every table matched the live snapshot exactly, with role
  simulation and trigger checks green. Tooling: `scripts/restore-import.mjs`;
  procedure: `docs/RESTORE-RUNBOOK.md`. Restoring into a *fresh Supabase project*
  additionally needs the owner to create that project in the dashboard first.

## 8. Testing & how changes ship

- Permanent test suite in `tests/`: 9 SQL assertion files (same-day guards incl.
  all 0027 tables, month lock incl. owner, insert-today + owner exception, agent
  isolation + staff phone privacy, login gateway + lockout, last-owner guard,
  0029 outstanding gate with golden values, `pay_month` goldens 320,000 and
  290,000, `finalize_closeout` golden) plus Vitest unit tests.
- **Before pushing, always** (repo `AGENTS.md` rule):
  `tests/run-sql-tests.sh`, `npm test`, `npm run build` — and show the real output.
- New UI string ⇒ add its `src/lib/i18nDict.ts` entry in the same commit.
- Repo convention: branch + PR for non-trivial work, small reviewable commits;
  one builder at a time. A push to `main` deploys the live site, so never push
  untested work to `main`.
- CI: `.github/workflows/ci.yml` runs on pull requests targeting `main`, on
  pushes to `main`, and on manual dispatch. Permission is `contents: read`
  only. One job runs `npm ci`, `npm test`, and `npm run build` on Node
  22.23.4 (the lockfile rejects Node 20: Vitest 5 requires `^22.12`, and
  Rollup's optional Linux lzma package requires `^22.20`). A second job
  starts a throwaway `postgres:17` service, installs `postgresql-17-cron`
  into that container, preloads `pg_cron`, and runs `tests/run-sql-tests.sh`
  in place on that container's `postgres` database. No deploy step and no
  production secrets. AGENTS.md still requires the same three commands
  locally before pushing.

## 9. Repo ↔ live sync state

The Item-4 batch (migration `0029`, the whole `tests/` suite, `vitest.config.ts`
and package.json test wiring, regenerated `apply_all.sql` to 0001–0029, SETUP.md
ranges, the `AGENTS.md` "Before pushing" section, RESTORE-RUNBOOK range fixes,
and this HANDOVER.md) **was pushed on 2026-11-07** at commit **`3c0f1b7`**.
`main` later moved to **`adeb7e7`** (docs accuracy). Live migrations remain
0001–0029.

Honest remainders, neither of which changes the running app:

- `.github/workflows/ci.yml` is in the repo (see §8). It does not deploy.
  A push to `main` still ships the live site through the existing host
  setup, which is separate from this workflow.
- Icon PNGs are not committed. Git tracks `public/manifest.webmanifest` and
  `scripts/gen-icons.mjs`. `npm run build` runs that script first and writes
  `public/favicon.png` (64), `public/apple-touch-icon.png` (180),
  `public/icons/icon-192.png`, `public/icons/icon-512.png`, and
  `public/icons/maskable-512.png`; Vite copies them into `dist/`. A clean
  checkout can regenerate them. Do not commit the generated PNGs.

## 10. Open work, in the owner's priority order

1. **Pilot preparation** (the next real phase): create the real staff/agent
   accounts (needs the owner's name/username list), write a pilot plan — 1–2 weeks
   parallel-running with the Lovable app and daily reconciliation — plus a short
   Burmese quickstart for staff/agents. Do not start entering real data before the
   owner agrees the pilot start date.
2. **FCM push notifications**: blocked on the owner providing the Firebase
   service-account JSON (Firebase project `water-delivery-noti`). It must go into
   a Supabase Edge Function secret — **never commit it to the repo**.
3. P1 hardening from the 2026-11-06 professional audit: error tracking / React
   Error Boundary, incident runbook, PWA service worker (offline is currently an
   entries-only queue), replacing the `xlsx` dependency (known advisories, no fix
   released).
4. Owner-only account hygiene (reminded, pending): make the GitHub repo private,
   enable MFA on Supabase/GitHub/Cloudflare, lengthen the owner PIN to 8–12 digits
   via the in-app PIN change.

**Consultation only — do NOT build unless the owner explicitly says go:**
two AI features were discussed and liked on 2026-11-03: (1) Burmese natural-language
Q&A over business data (numbers always computed by the app from the DB; AI only
phrases the answer; owner/manager only), and (2) an AI-worded daily evening summary
built from DB figures. Also: a second water-factory owner once showed interest in
this app — the owner decided **not** to give it to him for now; if ever, only as a
new separate instance (this app is single-tenant).

## 11. How the owner works (follow this and you will get along)

- He communicates in **Burmese**; explain and report in Burmese by default.
- **He does nothing on build/test work.** The AI builds, tests (clicking through
  every page like a first-time phone user, at phone/tablet/desktop widths — not
  just DB checks), fixes, re-verifies, and reports. Only ask him for steps that are
  technically impossible to delegate (creating accounts on new services, approvals,
  his own PIN/MFA) — and batch those into ONE ask.
- Show a short **step-by-step plan BEFORE building** anything non-trivial, and
  report results as a **per-item checklist**, not a verdict. If he describes a
  design in words only, restate your understanding briefly and get his OK first —
  a reference photo/video from him is the fastest spec.
- **Verify before claiming.** He has corrected confident-but-wrong answers before
  and values honesty over polish: check official docs/live state, mark what is
  uncertain, say "I don't know" when you don't.
- Money: he is on **free tiers** by necessity — a $20/month subscription is too
  expensive for him. Default to free options and small one-off purchases; never
  push recurring USD plans. Explain interest in ကျပ်တိုး / per-month terms, not
  annual percentages.

## 12. What is deliberately NOT in this document

No passwords, PINs, tokens, API keys or the owner's personal details — they live
in the owner's own password storage and accounts, and he will grant access himself
(GitHub/Supabase/Cloudflare logins). If you need a credential, ask him; never ask
him to paste a secret into a shared document, and never commit one to the repo.

— End of handover. Good luck; the owner is fair, direct, and notices quality. —
