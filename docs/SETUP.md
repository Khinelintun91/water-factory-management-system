# Setup — from zero to a working system

## 1. Create the Supabase project (owner, ~3 minutes)
1. supabase.com → sign in → **New project**.
2. Organization: your own org. Name: anything (e.g. `water-factory`). Region: **Singapore (ap-southeast-1)**. Set a database password and keep it in your password manager — the app never needs it, but recovery might.
3. Wait until the project status is **Healthy**.

Free plan note: a free account may already hold an older paused/unused project. If Supabase refuses a second active project, either resume-and-keep the old one paused (paused projects don't count as active) or delete the unused one first. The 3-table project `fxvvafuffwkodkdpmtus` (categories/expenses/profiles) is NOT this system — do not apply these migrations to it unless you intend to retire it; a clean, separate project is recommended.

## 2. Apply the database migrations
Supabase dashboard → **SQL Editor** → paste and run each file in order:
1. `supabase/migrations/0001_schema.sql`
2. `supabase/migrations/0002_rls.sql`
3. `supabase/migrations/0003_triggers.sql`

Each must finish with "Success". If a file errors, stop and fix that file first — do not skip ahead.

## 3. Create the first Owner account
Creating login accounts needs Supabase Auth. For the very first owner:
1. Dashboard → **Authentication → Users → Add user**: email `owner@waterfactory.local`, password = the owner's chosen PIN (6+ digits), confirm the user.
2. Copy the new user's UUID, then in SQL Editor run (replace the UUID):
```sql
insert into profiles (id, username, role) values ('PASTE-UUID-HERE', 'owner', 'owner');
```
3. The owner can now log in to the app with username `owner` + that PIN.

Later accounts (manager/staff/agent) will be created from the app's Users page once the `admin-create-user` Edge Function is deployed (next build step — it uses the service_role key server-side, never in the browser).

## 4. Wire the app
1. Dashboard → **Settings → API**: copy the Project URL and the publishable (anon) key.
2. Locally: `cp .env.example .env` and paste the two values.
3. `npm install && npm run dev` — log in as the owner and sanity-check: add an agent, add today's entry, download a backup.

## 5. Deploy (trial)
Build is a static site: `npm run build` → deploy `dist/` to Cloudflare Pages with the same two `VITE_*` env vars set in the Pages project. Keep the Lovable app running untouched until the trial passes real-phone checks (login, entry, backup export), per the agreed switch-over rule.
