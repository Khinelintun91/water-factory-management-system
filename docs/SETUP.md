# Setup — from zero to a working system

_Updated 2026-11-07 to match the current repo (migrations 0001–0030)._

## 1. Create the Supabase project (owner, ~3 minutes)
1. supabase.com → sign in → **New project**.
2. Organization: your own org. Name: anything (e.g. `water-factory`). Region: **Singapore (ap-southeast-1)**. Set a database password and keep it in your password manager — the app never needs it, but recovery might.
3. Wait until the project status is **Healthy**.

Free plan note: a free account may already hold an older paused/unused project. If Supabase refuses a second active project, either keep the old one paused (paused projects don't count as active) or delete the unused one first. Do NOT apply these migrations to an unrelated project; a clean, separate project is required. (The live project for this system is the owner's `water-factory` project.)

## 2. Apply the database migrations — ALL of them, in order
Apply **every** migration `0001`–`0030`. Running only the first few files produces an incomplete database the current app cannot run on.

Two equivalent ways (pick one):
- **Fast way:** Supabase dashboard → **SQL Editor** → paste the whole of `supabase/apply_all.sql` (a generated concatenation of 0001–0030, in order) and Run once.
- **Step-by-step way:** SQL Editor → paste and run each file in `supabase/migrations/` in filename order, `0001_schema.sql` through `0030_co_owner_create_user.sql`. Each must finish with "Success". If a file errors, stop and fix that file first — do not skip ahead.

The individual files in `migrations/` remain the source of truth; `apply_all.sql` is regenerated from them, never edited by hand.

## 3. Create the first Owner account
The very first owner is bootstrapped manually (later accounts are created inside the app — see §4):
1. Dashboard → **Authentication → Users → Add user**: email `owner@waterfactory.local`, password = the owner's chosen PIN (owner/manager: 6–12 digits), confirm the user.
2. Copy the new user's UUID, then in SQL Editor run `supabase/bootstrap_owner.sql` with that UUID (it inserts the `profiles` row: username `owner`, role `owner`).
3. The owner can now log in to the app with username `owner` + that PIN.

## 4. Later accounts — created in the app, via database RPCs
All later accounts (manager / co-owner / staff / agent) and PIN resets are done by the Owner from the app's **Users page**, which calls the security-definer RPCs from migration **0014**, as replaced by **0030** for the co-owner case: `admin_create_user()` and `admin_reset_pin()`. Both check inside the database that the caller is an active owner (`profiles.role = 'owner'`); a co-owner does not gain that power. `0030` accepts `co_owner` as a primary role. Its PIN minimum is the manager minimum: 6 digits, maximum 12, digits only. Owner and manager stay at 6; staff and agent stay at 4. The same minimum applies when the Owner resets a co-owner PIN. The browser never holds a `service_role` key.

> **Superseded — do not use:** `supabase/functions/admin-create-user/` is an old Edge Function that could not be deployed and is **NOT the live path**. It is kept in the repo as a reference implementation only. Account creation does not wait for, and must not be wired back to, that Edge Function.

## 5. Wire the app
1. Dashboard → **Settings → API**: copy the Project URL and the publishable (anon) key.
2. Locally: `cp .env.example .env` and paste the two values (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`). These two are public by design; RLS is the security boundary. The `service_role` key must never appear in the repo, in `.env`, or in client code.
3. `npm install && npm run dev` — log in as the owner and sanity-check: add an agent, add today's entry, download a backup.

## 6. Deploy — Cloudflare Workers (static assets)
Hosting is **Cloudflare Workers static assets**, configured in `wrangler.jsonc` — not Cloudflare Pages.
1. `npm run build` (runs icon generation + `tsc --noEmit` + Vite; output is `dist/`).
2. Deploy with Wrangler (`npx wrangler deploy`): it serves `dist/` with SPA fallback, so client-side routes work on direct loads. Set the same two `VITE_*` values at build time.
3. Live site: https://water-factory-management-system.khinelintun91.workers.dev

Keep the old Lovable app running untouched until a real-data pilot passes and earns the switch-over, per the agreed rule.

## 7. Backups (SPEC rule — not optional)
Supabase Free has **no** automatic backups and no point-in-time recovery; the backup system is the app's own:
- The Owner's home screen has a one-tap **Download backup** button (all business tables → one JSON file). Save **2 copies in 2 places** (e.g. phone + Google Drive). Files are date-named (`backup-YYYY-MM-DD.json`).
- **Rhythm: weekly minimum; daily is one tap and safer.** The app records the last backup time and warns when one is overdue (7 days).
- Retention: keep daily files for the last 30 days; beyond that keep one per month (the month's last) long-term.
- Auth accounts/PINs are **not** in the backup file — after a restore, accounts are re-issued by the Owner (see the restore runbook). Database structure is backed up as the migrations in this repo; latest export + migrations must be enough to rebuild the system on a fresh Supabase project.
