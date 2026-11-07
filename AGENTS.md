# AGENTS.md — for any AI builder working in this repo

Read `SPEC.md` first. It is the contract; this file is only working conventions.

## Ground rules
- SPEC wins. If a request conflicts with a non-negotiable rule in SPEC, stop and flag it — never silently weaken a rule.
- Every access rule must be enforced in the database (RLS policies / triggers), not only in UI code. Assume the UI will be bypassed.
- One builder at a time. Branch + PR for non-trivial work; small, reviewable commits.
- Never commit secrets. Client-side Supabase URL + publishable key are public by design and live in `.env` (git-ignored) / host env vars. The `service_role` key must NEVER appear in this repo or in client code.
- Do not edit the old repo (`aqua-crate-ledger`) — it is a read-only reference.

## Conventions
- Language: UI text in Burmese (Myanmar), code identifiers and comments in English.
- Currency: Myanmar Kyat (MMK), integer amounts, no decimals.
- Timezone for all business-day logic: `Asia/Yangon`. "Same day" always means the Yangon calendar day.
- Names/titles: write "ရေသန့်စက်ရုံ" generically; the factory display name is the `app_settings.factory_name` value, never a hard-coded string.
- Migrations: one file per change in `supabase/migrations/`, named `NNNN_description.sql`, applied in order, never edited after merge (write a new migration instead).

## Before pushing

- Run `tests/run-sql-tests.sh` (database rules suite) **and** `npm test` (unit tests) **and** `npm run build`; show the actual output in your report — never just claim they pass. A change that touches migrations, RPCs, or money logic is not done while any suite is red.
- New UI string? Add its `src/lib/i18nDict.ts` entry in the **same commit** — English mode is a dictionary-driven DOM translator, so an unlisted Burmese string silently stays Burmese in English mode.

## Security checklist for every change
- [ ] New table? RLS enabled + policies written + audit trigger attached if it holds business data.
- [ ] New query path? Agent role still sees only their own rows; Staff still cannot read `agent_contacts`.
- [ ] Edit/delete path? Same-day trigger and month-lock trigger still apply to ALL roles.
- [ ] Anything touching `audit_log`? It must stay insert-only for everyone.
