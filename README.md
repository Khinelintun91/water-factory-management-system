# Water Factory Management System

ရေသန့်စက်ရုံ လုပ်ငန်းစီမံခန့်ခွဲမှု စနစ် — Myanmar-language management app for a water-delivery business (rebuild of *Aqua Crate Ledger*, with its known bugs fixed and its structure systematized).

**Factory display name inside the app is a setting, not code.** Write "ရေသန့်စက်ရုံ" generically in code and docs.

## Why this repo exists
The previous app runs on Lovable Cloud (a Lovable-managed database the owner cannot see or control directly). This rebuild puts the database back under the owner's control:

- **Database:** the owner's own **Supabase** project (Postgres + Row Level Security) — Path A, decided 2026-11-03.
- **Code:** this repo. GitHub is the source of truth.
- **Hosting (planned):** Cloudflare Pages (free) — a static build of this app.
- **Rules:** `SPEC.md` is the contract. If code and SPEC disagree, SPEC wins and the code is the bug.

## Stack
- React 19 + Vite + TypeScript + Tailwind CSS v4 (single-page app, mobile-first, PWA)
- Supabase JS client (Auth + Postgres + RLS)
- Login: username + PIN (synthetic email `<username>@waterfactory.local`), same pattern as the old app

## Repo layout
```
SPEC.md                  business rules (the contract)
AGENTS.md                rules for any AI builder working here
docs/ARCHITECTURE.md     design decisions and security model
supabase/migrations/     database schema + RLS, applied in filename order
src/                     app source
```

## Setup (owner, once)
1. Create a free Supabase project at supabase.com (any region near Myanmar, e.g. Singapore).
2. In the Supabase SQL Editor, run each file in `supabase/migrations/` in order.
3. Copy `.env.example` to `.env` and fill in the project's URL + publishable (anon) key.
4. `npm install` then `npm run dev` to run locally; `npm run build` for production.

## Data safety (summary — full rules in SPEC.md)
- Business data is **never deleted**; full history stays queryable, with a per-year view of all 12 months' profit/loss.
- The Owner's home screen has a one-tap **Download backup** export of all business tables. Weekly minimum; the app tracks the last backup and warns when overdue.
- Every create/edit/delete is written to an immutable audit log with the full before-image of the row.
