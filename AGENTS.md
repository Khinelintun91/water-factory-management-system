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

## Working with two AIs
- One builder at a time (Ground rules: "One builder at a time"). Builder Grok/Cursor implements the change on a branch and a PR, and shows the full actual test evidence.
- An independent reviewer, Muse, checks each PR against the code and the live state, and writes PR comments or a review. That writing is technical evidence. It does not authorize a merge, a deploy, or a live apply. The owner alone authorizes merge and live apply.
- The builder does not touch the live Supabase project. A migration in this repo is code only. Applying it to the live database needs a separate explicit approval from the owner.
- A review comment is not authorization for a new task. A correction inside a scope the owner already granted may be implemented. A change outside that scope, or one that conflicts with a rule, is flagged to the owner first.
- A PR with missing test evidence must not enter review. Follow "Before pushing": run `tests/run-sql-tests.sh`, `npm test`, and `npm run build`, and show the actual output. Results from the builder's VM and the PR-head GitHub Actions runs (SQL suite, unit tests, and build) are separate evidence. A suite that was blocked or was not run is reported as blocked or not run, never as passed.
