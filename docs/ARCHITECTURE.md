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
- Each user has a `profiles` row: `id` (auth user id), `username`, `role` (one primary role), `agent_id` (set only when that primary role is `agent`), `active`.
- Core roles are four: `owner`, `manager`, `staff`, `agent`. `primary_agent` is not a value of the `user_role` enum (0001: those four; 0006 adds `co_owner` only). A staff-and-agent combination is one account with one primary `profiles.role` and the other role granted in `user_roles` (0006). The owner inserts and deletes `user_roles` rows (`app_role() = 'owner'`). `admin_create_user()` (0014) accepts only the four core roles as primary and writes `profiles.agent_id` only for primary `agent`.
- `co_owner` is that extra enum value, not a fifth core role. `has_role('manager')` is true when the primary role or a `user_roles` row is `co_owner`, so co-owner privileges are manager privileges (SPEC "Roles" states the same rule). The Users page dropdown (`src/lib/types.ts` `ROLE_LABELS`) offers `co_owner` next to the four core roles, including as the create-account primary choice. `admin_create_user()` rejects any primary role outside the four with `invalid_role`. Inserting `co_owner` into `user_roles` fits the column type and the owner insert policy.
- Login is username + PIN. The client maps username → `<username>@waterfactory.local` and uses Supabase Auth email/password sign-in, exactly like the old app. PIN strength is enforced at creation (6 digits) and repeated failures are recorded in `login_logs`.
- `app_role()` returns only the primary `profiles.role`. `has_role()` is the effective-role check: primary role or a `user_roles` row, and `co_owner` counts as manager. `is_owner_manager()` and `is_staff_plus()` are defined on `has_role()`, and the shared RLS policies call those helpers. `app_agent_id()` reads `profiles.agent_id` for agent scoping. Some gates still see only the primary role (`app_role()` or `profiles.role = 'owner'`): owner backdating (0018), `hard_delete_agent`, the staff credit-limit branch in `entries_before_write`, and the caller check inside `admin_create_user` / `admin_reset_pin`.

## How each SPEC rule is enforced in the database
| SPEC rule | Mechanism |
|---|---|
| 1. Agent isolation | RLS: rows carry `agent_id`. `is_staff_plus()` (owner, manager, or staff through `has_role()`, so a `user_roles` staff grant counts, and `co_owner` counts as manager) reads all rows. Any other caller reads only rows with `agent_id = app_agent_id()` |
| 2. Phone privacy | Phone numbers are NOT a column of `agents`. They live in `agent_contacts` with RLS: owner/manager = all rows, agent = own row only, staff = no access at all |
| 4. Same-day edit/delete (all roles) | `BEFORE UPDATE/DELETE` trigger on business tables: rejects when `created_at` (Yangon date) <> today (Yangon). Applies to every role incl. owner; service-role maintenance is the only bypass and is never shipped in the client |
| 5. Immutable audit | Trigger writes `audit_log` (old_data/new_data full row images) on INSERT/UPDATE/DELETE. RLS on `audit_log`: SELECT for owner/manager only; no INSERT/UPDATE/DELETE policies for any client role (triggers run as definer). No purge function exists |
| 6. Month lock (no exemptions) | `BEFORE INSERT/UPDATE/DELETE` trigger checks `month_locks` for the row's business month; locked ⇒ raise. No role check — nobody is exempt |
| 7. Per-agent deposits | `agents.deposit_per_bottle` + `agents.deposit_bottle_price` columns on each agent row; write policies owner/manager only |

## Close-out
Close-out is permanent. The app has no reopen action, and a reason does not reopen a close-out. `finalize_closeout` (owner/manager through `is_owner_manager()`) inserts one `agent_settlements` row (`agent_id` is unique) and sets `agents.closed_at` and `active = false`. When `closed_at` is already set, or a settlement row already exists, the function raises `already_closed`. `p_note` is an optional note stored on that settlement. `agent_settlements` has select and insert policies only (0006 comment: no update or delete policy, on purpose).

`agents` still has the general owner/manager update policy from 0002, and no trigger freezes `closed_at`. Clearing that timestamp is not a reopen feature in the app. The settlement row would still make `finalize_closeout` raise `already_closed`. Audit remains insert-only, month lock still has no role exemption, and same-day edit/delete is unchanged by close-out (0027 notes that `agents` has no same-day guard; close-out does not weaken those rules on the money tables).

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
