> ⚠️ **HISTORICAL SNAPSHOT — 2026-11-03, SUPERSEDED (banner added 2026-11-06).**
> This document records the gap state as it was on 2026-11-03, early in the rebuild. It is **no longer current**: most items marked MISSING or PARTIAL below have since been built (multi-role accounts, deposits ledger and close-out, payroll, reports, collections ledger, inventory page, notifications, data-quality page, cash handover, exports, offline queue, settings/i18n — migrations 0001–0025). Do NOT plan work from this file. The current gap list is the **2026-11-06 full project audit** (restore drill untested, zero automated tests/CI, login-abuse holes, same-day guard asymmetry on newer money tables, seed-data settlement, plus live-state checks). Kept for history only.

# GAP ANALYSIS — Old Lovable app vs New rebuild

Source of truth for "old": `docs/OLD-APP-INVENTORY.md` (read from source at old repo HEAD 8b54734).
Status key: **HAVE** (equal or better) · **PARTIAL** (exists, missing pieces) · **MISSING** · **CONFLICT** (old app vs rebuild SPEC — decision noted).

## Auth & roles
| Old feature | Status | Notes |
|---|---|---|
| Username login, synthetic `@waterfactory.local` email hidden | HAVE | Same pattern |
| 5 roles, MULTI-role per user (owner, co_owner≡manager, manager, employee, agent) | MISSING | New app: 4 roles, single role per profile → Phase A rework to user_roles |
| Password ≥8 for owner/co_owner/manager; 4-digit PIN for employee/agent | PARTIAL | New app: PIN for everyone → adopt old policy in Phase A |
| PIN stored as HMAC(pepper, userId:PIN), never raw | MISSING | Server-side detail; adopt with Edge Function user creation |
| 5 failed attempts → 15-min lockout (pin_attempts) | MISSING | Phase A |
| Remember-username, show/hide password, banned-account error | PARTIAL | Have show/hide + remember-login (30 d); add banned message parity |
| Every login logged with user-agent | PARTIAL | login_logs exists; add user-agent capture |
| One-time "claim Owner" bootstrap | HAVE (equivalent) | Owner bootstrapped by SQL; in-app claim not needed |
| Owner deactivates others (ban + soft-delete, restorable), never self | PARTIAL | Have active toggle + self-guard; add restore semantics parity |

## Agents
| Old feature | Status |
|---|---|
| CRUD: name, phone, address, sale price, deposit/bottle, bottle limit, credit limit (MMK), active | PARTIAL — missing address, bottle limit, credit limit |
| Inline on-blur edit of price/deposit/limits in list | MISSING |
| Initial deposit taken at creation | MISSING |
| Optional link agent ↔ login account (auto-fill name/phone) | PARTIAL (profiles.agent_id exists; no auto-fill UI) |
| Detail page: stat grids (today/totals/money, "can still deliver"), entries+payments tables, deposit card w/ history + add | MISSING |
| Deposits as separate ledger records (agent_deposits) | MISSING — new app has only a per-bottle setting |
| Closed-agents list | MISSING |
| 4-step close-out: bottle count → collect/write-off receivable → refund at today's price → finalize (books price-diff expense, closes agent) | MISSING |
| Write-offs with reason (write_offs) | MISSING |
| Settlements record (agent_settlements) + forfeiture income | MISSING |
| Owner-only hard delete after close-out; name snapshots keep reports intact | MISSING |

## Delivery entries
| Old feature | Status |
|---|---|
| Form: agent, bottles out, empties in, cash collected, date, note; big inputs | PARTIAL — new model uses delivered/returned + unit_price/amount, no per-entry cash |
| Confirm dialog with summary + "0 cash = debt" warning | MISSING |
| Per-entry unit_price snapshot (trigger) | MISSING (amount computed from current price) |
| Guards: bottle limit (error shows top-up amount), credit limit (employee blocked, OM save = approval), closed agent rejected | MISSING |
| Multiple trips per day | HAVE (no uniqueness constraint) |
| Month-filtered table (36 months), inline edit | PARTIAL — list exists; no month filter, no edit UI |
| Edit/delete require typed reason; employee same-day only, OM any day | PARTIAL — new app: same-day delete for ALL roles (stricter than old for OM — keep? Old allows OM any-day with reason. SPEC for rebuild said same-day ALL roles. CONFLICT-lite: keep rebuild SPEC (stricter) and note it) |
| Offline queue (localStorage, pending banner, auto-flush on reconnect/60 s) | MISSING |

## Payments / Collections
| Old feature | Status |
|---|---|
| Collections as own record type, embedded form+list on /entries, edit/delete with reason | PARTIAL — standalone page exists; no edit, no reason |
| /collections: per-agent balances, expandable day-by-day ledger with running balance | MISSING |
| Collections report: date/employee/agent filters + totals | MISSING |

## Expenses
| Old feature | Status |
|---|---|
| Form + list, 7 fixed categories | PARTIAL — categories table exists (seed parity needed); new app adds same-day delete (old has NO edit/delete UI — keep new delete as improvement) |
| Close-out auto-books "ဗူးအပေါင် ဈေးကွာ" expense | MISSING (comes with close-out) |

## Inventory / Bottles
| Old feature | Status |
|---|---|
| Stock page: produce/purchase/damage moves; summary full/empty/with-agents/total; negative-stock warning; delete with confirm | MISSING UI — inventory_movements table exists unused |

## Disputes
| Old feature | Status |
|---|---|
| Agent flags own entry/payment, one open dispute per record | PARTIAL — standalone disputes w/ optional link; add one-open-per-record rule |
| Agent sees own list with replies | HAVE |
| OM inbox on /entries with open-count badge | PARTIAL — separate page exists; add badge/inbox parity |
| Resolve requires reply text | PARTIAL — reply exists; enforce required-on-resolve |

## Dashboard (/home)
| Old feature | Status |
|---|---|
| Date picker (any day), 30-s auto-refresh, CountUp cards (out, empties, collected; OM: debt collected, expenses), net-cash card | PARTIAL — today-only totals, no auto-refresh/animation |
| Per-employee summary table (trips/out/in/cash/debt cash) | MISSING |
| Daily CSV download button | MISSING |
| Agents auto-redirect to /my | HAVE (route guards) |

## Payroll
| Old feature | Status |
|---|---|
| /payroll: staff list (employee/manager/co_owner), inline-editable monthly salary until paid, bonus totals | MISSING |
| Advances: amount, repayment mode (one-shot next salary / installments) | MISSING |
| Bonuses per month | MISSING |
| Pay month (confirm) → immutable payroll_runs + advance_repayments; net = base + bonus − deduction (installment capped at remaining; advances after month don't deduct) | MISSING |

## Reports
| Old feature | Status |
|---|---|
| Date-range report: sales, collected, profit = sales + forfeiture − expenses − payroll − write-offs; expenses, payroll+bonus, write-offs, receivable, deposit liability, forfeiture, refunds | MISSING |
| Monthly trend chart (bars + profit line, 6/12/24-mo, MoM %, best month) | MISSING |
| Expense by category | MISSING |
| Receivable aging (≤30 / 30–60 / >60) with per-agent drill-down | MISSING |
| Per-agent summary table | MISSING |
| Daily Brief: rule-based action items (open disputes, aged debt, unpaid trips today, sales <80% of 7-day avg, inactive agents) with focus checkboxes | MISSING |

## Exports
| Old feature | Status |
|---|---|
| Daily CSV (entries + expenses, BOM) | MISSING |
| Monthly backup Excel — 10 Myanmar-named sheets — or combined CSV | PARTIAL — JSON backup exists (keep); add Excel/CSV parity |
| Report Excel (3 sheets) | MISSING |
| PDF via browser print view | MISSING |
| Change-history CSV; data-quality CSV | MISSING |

## Notifications
| Old feature | Status |
|---|---|
| In-app bell: latest 30, unread badge, mark-all-read, deep links, 30-s poll | MISSING |
| 10 trigger-generated kinds (delivery, collection, receipt, payment_receipt, dispute, dispute_reply, past_edit, record_changed, digest, data_quality); delivery = high priority when credit limit exceeded | MISSING |
| FCM push: per-device tokens (rebind on sign-in), all vs important-only prefs, quiet hours 22:00–06:00, same-tag replacement, iOS home-screen guidance | MISSING — needs Firebase service-account JSON from the user's Firebase project (water-delivery-noti); the copy uploaded to Lovable is not accessible |
| Scheduled evening digest + daily data-quality alert (dq_seen dedupe) | MISSING — needs a scheduler (pg_cron + Edge Function plan in Phase C) |
| Settings Push card: per-device enable/disable, device count | MISSING |

## Users / Admin
| Old feature | Status |
|---|---|
| /users (owner): create (PIN vs password by role) | BLOCKED — Edge Function deploy route still open |
| Click role badges to grant/revoke roles | MISSING (multi-role, Phase A) |
| Reset password/PIN (clears lockout) | MISSING |
| Deactivate / restore | PARTIAL (toggle exists) |
| Login history (last 100) | MISSING UI (login_logs table exists) |
| Cash handover page: per-employee expected vs received, match/short/over badges, stale warning | MISSING |
| Data-quality page: 5 check families, Myanmar fix suggestions, severity/kind filters, reviewed marking, locked-month badges, fix links | MISSING |

## Settings
| Old feature | Status |
|---|---|
| Theme light/dark/system per device | PARTIAL (dark classes exist; no settings UI) |
| Language မြန်မာ / English toggle | MISSING |
| Push settings card | MISSING |
| Owner: factory name/phone/address; default price + deposit for new agents; auto-refresh seconds (5–300) | PARTIAL — factory_name exists in app_settings; no UI, no phone/address/defaults/refresh |

## Audit / History
| Old feature | Status |
|---|---|
| Trigger audit with full old/new images on 9 tables; UPDATE/DELETE blocked | HAVE (14 tables incl. profiles/app_settings after 0005) |
| Field-level diff view, edit reasons shown, date range, 300-row paging, CSV export | PARTIAL — raw before/after JSON view + load-more; add diffs/reasons/CSV |
| Owner-only purge (RPC) — the sole deletion path | **CONFLICT — RESOLVED by the owner 2026-11-03 ~23:19: NO purge, ever.** The earlier decision in this row (implement owner-only purge, "newest instruction wins") is SUPERSEDED by the owner's explicit choice: the audit log stays insert-only for everyone including the Owner, exactly as SPEC rule 5 states. No purge feature is to be built. |

## UI/UX (redesign targets — must EXCEED old)
Old baseline (from inventory §10): shadcn/Tailwind v4 oklch single-blue theme, full dark palette, .app-card shadow/press system, sidebar + sticky blurred header, 4 grouped nav sections with icons, phone bottom nav (≤4 items, safe-area), tablet icon rail, desktop expandable sidebar + two-pane layouts at xl, h-11→h-14 touch targets (shrink ≥sm), 180 ms transitions, reduced-motion, PWA icons/manifest with editable app name, system font.
New app today: plain Tailwind lists, top nav pills, no design system, no bottom nav, no sidebar, no tablet-specific layout.
→ Phase D: full design system + responsive shell (phone bottom nav / tablet rail / desktop sidebar), cards, charts, animations, verified at 390 / 820 / 1440 px on every screen.

## Build phases
- **Phase A — Core model & agent lifecycle:** multi-role user_roles, login policy + lockout, agent address/limits, deposits ledger, write-offs, settlements + 4-step close-out, hard delete, inventory page, entry model upgrade (cash collected, price snapshot, confirm dialog, limit guards, edit-with-reason), collections ledger + report.
- **Phase B — Money & insight:** payroll (salaries/advances/bonuses/runs), reports (profit formula, trend chart, aging, per-agent, Daily Brief), cash handover, data-quality page, exports (daily CSV, monthly Excel, report Excel, print PDF, history/DQ CSVs), dashboard upgrade (date picker, auto-refresh, per-employee table, daily CSV).
- **Phase C — Notifications, settings, offline:** notification bell + DB triggers, FCM push (needs service-account JSON), scheduled digest + DQ alerts, settings page (theme/language/factory/defaults/push), offline entry queue.
- **Phase D — UI/UX redesign + verification:** design system, responsive shell, polish on every screen, 3-width verification pass, full regression QA, final parity report.
