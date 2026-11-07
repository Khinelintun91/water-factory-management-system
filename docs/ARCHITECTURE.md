# Architecture

## Shape
Single-page React app (Vite build, static hosting) talking directly to the owner's Supabase project. There is no custom server: Postgres + RLS is the security boundary, the same two-layer model as the old app but with the old app's policy mistakes fixed.

```
Phone browser (PWA) ──► static app (Cloudflare Workers static assets)
                            │  Supabase JS (publishable key)
                            ▼
                     Owner's Supabase project
                     Auth (username+PIN via synthetic email)
                     Postgres + RLS + triggers (rules live here)
```

## Auth model
- Each user has a `profiles` row: `id` (auth user id), `username`, `role` (`owner|manager|staff|agent`), `agent_id` (set only for agent logins), `active`.
- Login is username + PIN. The client maps username → `<username>@waterfactory.local` and uses Supabase Auth email/password sign-in, exactly like the old app. PIN strength is enforced at creation (6 digits) and repeated failures are recorded in `login_logs`.
- `app_role()` (SQL helper, reads the caller's profile) is the single source every RLS policy uses. `app_agent_id()` does the same for agent scoping.

## How each SPEC rule is enforced in the database
| SPEC rule | Mechanism |
|---|---|
| 1. Agent isolation | RLS: rows carry `agent_id`; agent role matches `agent_id = app_agent_id()` |
| 2. Phone privacy | Phone numbers are NOT a column of `agents`. They live in `agent_contacts` with RLS: owner/manager = all rows, agent = own row only, staff = no access at all |
| 4. Same-day edit/delete (all roles) | `BEFORE UPDATE/DELETE` trigger on business tables: rejects when `created_at` (Yangon date) <> today (Yangon). Applies to every role incl. owner; service-role maintenance is the only bypass and is never shipped in the client |
| 5. Immutable audit | Trigger writes `audit_log` (old_data/new_data full row images) on INSERT/UPDATE/DELETE. RLS on `audit_log`: SELECT for owner/manager only; no INSERT/UPDATE/DELETE policies for any client role (triggers run as definer). No purge function exists |
| 6. Month lock (no exemptions) | `BEFORE INSERT/UPDATE/DELETE` trigger checks `month_locks` for the row's business month; locked ⇒ raise. No role check — nobody is exempt |
| 7. Per-agent deposits | `agents.deposit_per_bottle` + `agents.deposit_bottle_price` columns on each agent row; write policies owner/manager only |

## Tables (Phase 1)
`profiles`, `agents`, `agent_contacts`, `daily_entries` (deliveries), `agent_payments` (collections), `expenses`, `expense_categories`, `inventory_movements` (bottle stock in/out), `month_locks`, `audit_log`, `login_logs`, `app_settings` (factory name, last_backup_at), `push_tokens` (Phase 2 FCM, created now so the shape is stable).

## Backups
- In-app export (Owner only): the client reads all business tables through the owner's RLS access and downloads one JSON file. Owner stores 2 copies in 2 places.
- Structure backup = `supabase/migrations/` in this repo.
- Recovery = new Supabase project → run migrations → import latest export → recreate auth users (usernames/PINs are re-issued by Owner; password hashes are not carried by the in-app export).

## Deliberate deviations from the old app (fixes, not regressions)
1. Staff can no longer read agent phone numbers (old policy leak).
2. Owner/Manager no longer exempt from same-day edit/delete.
3. Month lock has no Owner exemption.
4. Audit log purge function removed; audit is insert-only for everyone.
5. Database owned by the business (own Supabase) instead of Lovable Cloud; app host is a static host instead of Lovable.
