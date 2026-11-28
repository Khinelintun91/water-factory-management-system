# Independent Balance Audit — U Aye Myint (ဦးအေးမြင့်, Code 02)

- **Audit date:** 2026-11-28
- **Agent:** U Aye Myint (ဦးအေးမြင့်), code `02`, id `7489a25e-d628-470b-bf5d-9a2aa27029b3`
- **Scope:** Read-only code + arithmetic verification against production data extracted 2026-11-28. No application code, migration, or live data modified.
- **Assumptions:**
  1. `write_offs` and `agent_damage_charges` sums for this agent are both `0` (not present in the extract, and confirmed consistent because `daily_entries` + `agent_payments` alone reproduce the exact live `agent_outstanding()` value of `+100,000` MMK).
  2. November 2026 (`2026-11-01`) is not locked in `month_locks` when applying the recommended backdated payment fix.
  3. All other cash figures and charges are exact as extracted; the sole real-world discrepancy is the `2026-11-20 03:09 PM` visit where the agent handed over `320,000` MMK in cash.

---

## Q1. Exact definition of `agent_outstanding(p_agent)` from the codebase

The latest definition lives in `supabase/migrations/0042_damage_charges.sql` (lines 189–204, superseding `0006` and `0029`):

```sql
return coalesce((
         select sum(delivered_qty::bigint * unit_price - amount_collected)
         from daily_entries where agent_id = p_agent), 0)
     - coalesce((select sum(amount) from agent_payments where agent_id = p_agent), 0)
     - coalesce((select sum(amount) from write_offs    where agent_id = p_agent), 0)
     + coalesce((select sum(total)  from agent_damage_charges where agent_id = p_agent), 0);
```

- **Charges (`+`, increase what the agent owes):**
  - `SUM(daily_entries.delivered_qty * daily_entries.unit_price)` — equal to `SUM(daily_entries.amount)` as computed server-side by `entries_before_write()`.
  - `SUM(agent_damage_charges.total)` — any recorded damage charges.
- **Payments / reductions (`−`, decrease what the agent owes):**
  - `SUM(daily_entries.amount_collected)` — the portion of visit cash stored on the delivery entry itself (`toToday` from `src/lib/cashAllocation.ts`).
  - `SUM(agent_payments.amount)` — **every** payment row for the agent, regardless of `kind` (`'old_debt'` or `'regular'`) and regardless of whether `source_entry_id` is linked to a delivery entry or `NULL` (standalone).
  - `SUM(write_offs.amount)` — any written-off debt.
- **Sign convention:**
  - Positive (`> 0`): agent owes the factory (`ရရန်ကျန်`).
  - Zero (`= 0`): settled.
  - Negative (`< 0`): agent overpaid / holds credit with the factory (`ပိုပေးထားငွေ`).

---

## Q2. Visit-by-visit running balance using RECORDED production numbers

| # | Date & Time (Asia/Yangon) | Event / Records | Delivered / Returned | Charge (+) | Entry Cash (−) | Linked / Standalone Payments (−) | Total Cash (−) | Net Delta | Running Balance (Recorded) |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 2026-11-20 11:24 AM | Entry #1 | 200 / 0 | +200,000 | 200,000 | 0 | 200,000 | 0 | **0** |
| 2 | 2026-11-20 02:31 PM | Entry #2 | 200 / 200 | +200,000 | 0 | 0 | 0 | +200,000 | **+200,000** |
| 3 | 2026-11-20 03:09 PM | Entry #3 + Pmt #1 (`old_debt` 200,000, linked) + Pmt #2 (`regular` 80,000, linked) | 20 / 20 | +20,000 | 20,000 | 280,000 | 300,000 | −280,000 | **−80,000** |
| 4 | 2026-11-20 03:10 PM | Entry #4 | 100 / 100 | +100,000 | 0 | 0 | 0 | +100,000 | **+20,000** |
| 5 | 2026-11-21 05:31 AM | Entry #5 + Pmt #3 (`old_debt` 20,000, linked) | 200 / 200 | +200,000 | 200,000 | 20,000 | 220,000 | −20,000 | **0** |
| 6 | 2026-11-21 05:33 AM | Entry #6 + Pmt #4 (`old_debt` 50,000, standalone) | 100 / 100 | +100,000 | 50,000 | 50,000 | 100,000 | 0 | **0** |
| 7 | 2026-11-23 11:42 AM | Entry #7 | 100 / 100 | +100,000 | 0 | 0 | 0 | +100,000 | **+100,000** |

**Aggregate check (recorded):**
- Total charges (`SUM(daily_entries.amount)`): `200,000 + 200,000 + 20,000 + 100,000 + 200,000 + 100,000 + 100,000 = 920,000` MMK
- Total entry cash (`SUM(daily_entries.amount_collected)`): `200,000 + 0 + 20,000 + 0 + 200,000 + 50,000 + 0 = 470,000` MMK
- Total `agent_payments` (`SUM(agent_payments.amount)`): `200,000 + 80,000 + 20,000 + 50,000 = 350,000` MMK
- Total recorded cash: `470,000 + 350,000 = 820,000` MMK
- Recorded `agent_outstanding()`: `(920,000 − 470,000) − 350,000 = +100,000` MMK

**Result:** Yes — the recorded numbers end at exactly **`+100,000` MMK** (`ရရန်ကျန် 100,000`), matching production `agent_outstanding()`.

---

## Q3. Recomputed running balance using the real 320,000 MMK on Nov 20 03:09 PM

At Visit #3 (`2026-11-20 03:09 PM`), prior balance was `+200,000` MMK and the visit charge was `20,000` MMK. Applying `allocateCash(320000, 20000, 200000)` (`src/lib/cashAllocation.ts`):
- `toToday` (`daily_entries.amount_collected`): `20,000` MMK (recorded accurately as `20,000`)
- `toOld` (linked `agent_payments`, `kind = 'old_debt'`): `200,000` MMK (recorded accurately as `200,000`)
- `advance` (linked `agent_payments`, `kind = 'regular'`): **`100,000` MMK** (recorded as **`80,000` MMK**)

| # | Date & Time (Asia/Yangon) | Charge (+) | Real Cash (−) | Net Delta | Running Balance (True) | Running Balance (Recorded) | Difference (Recorded − True) |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | 2026-11-20 11:24 AM | +200,000 | 200,000 | 0 | **0** | 0 | 0 |
| 2 | 2026-11-20 02:31 PM | +200,000 | 0 | +200,000 | **+200,000** | +200,000 | 0 |
| 3 | 2026-11-20 03:09 PM | +20,000 | **320,000** | −300,000 | **−100,000** | −80,000 | +20,000 |
| 4 | 2026-11-20 03:10 PM | +100,000 | 0 | +100,000 | **0** | +20,000 | +20,000 |
| 5 | 2026-11-21 05:31 AM | +200,000 | 220,000 | −20,000 | **−20,000** | 0 | +20,000 |
| 6 | 2026-11-21 05:33 AM | +100,000 | 100,000 | 0 | **−20,000** | 0 | +20,000 |
| 7 | 2026-11-23 11:42 AM | +100,000 | 0 | +100,000 | **+80,000** | +100,000 | +20,000 |

**Aggregate check (true):**
- Total charges: `920,000` MMK
- Total real cash handed over: `820,000 + 20,000 = 840,000` MMK
- **True balance today:** `920,000 − 840,000 = +80,000` MMK (**`ရရန်ကျန် 80,000`** — agent owes the factory `80,000` MMK).

**Recording error identified:**
- **Yes, there is a `20,000` MMK under-recording error.**
- **Exact record:** `agent_payments` row #2 (`2026-11-20 03:09 PM`, `kind = 'regular'`, linked to Entry #3 via `source_entry_id`) — resulting from entering `300,000` instead of `320,000` as total cash on Visit #3.
- **Exact field:** `agent_payments.amount`.
- **Amount:** recorded as `80,000` MMK instead of `100,000` MMK (**short by `20,000` MMK**).

---

## Q4. Plain-language explanation: why the card shows `ရရန်ကျန်` (owes) today instead of `ပိုပေးငွေ` (overpaid)

Even though U Aye Myint overpaid on Nov 20 at 03:09 PM (`100,000` MMK credit in reality; `80,000` MMK as recorded), later unpaid deliveries completely used up that credit:

1. **One minute later (Nov 20 at 03:10 PM)**, he received 100 bottles (`100,000` MMK) and paid `0` cash. That trip alone consumed his entire `100,000` real overpayment (bringing his true balance back to `0`, and his recorded balance from `−80,000` to `+20,000`).
2. **On Nov 21**, his two deliveries totalled `300,000` MMK while he handed over `320,000` MMK (`220,000` at 05:31 AM + `100,000` at 05:33 AM). That moved his true balance to `−20,000` credit (and his recorded balance to `0`).
3. **On Nov 23 at 11:42 AM**, he received another 100 bottles (`100,000` MMK) and paid `0` cash. That `100,000` unpaid delivery turned his `−20,000` real credit into **`+80,000` owed** (and his `0` recorded balance into **`+100,000` owed**).

In short: his Nov 20 overpayment was already spent on later water deliveries (Nov 20 03:10 PM and Nov 23 11:42 AM), so he is no longer in overpayment — he genuinely owes **`80,000` MMK** today.

---

## Q5. Minimal fix for the owner in the app

Because of SPEC rule 4 (same-day edit/delete only for **all** roles, Owner included), the `2026-11-20` entry and linked payment rows cannot be edited or deleted on `2026-11-28`. However, under migration `0018` (`guard_insert_today()`), the primary **Owner** (`app_role() = 'owner'`) may insert backdated records (assuming November 2026 is not locked in `month_locks`).

**Minimal in-app fix:**
1. Log in as the **Owner** account (primary role `owner`; staff, managers, and co-owners cannot backdate).
2. Open **ငွေကောက်ခံမှုများ (Payments)** (`/payments`).
3. Select agent **ဦးအေးမြင့် (code 02)**.
4. Set **ရက်စွဲ (Date)** to **`2026-11-20`**.
5. Enter **ပမာဏ (Amount)** = **`20000`** (`20,000` MMK), **နည်းလမ်း (Method)** = `ငွေသား (cash)`, and select **လက်ခံသူ (Receiver)** = the staff member/person who physically received the Nov 20 03:09 PM cash.
6. Add an audit note in **မှတ်ချက်**, e.g.: `2026-11-20 03:09 PM ငွေလက်ခံ 320,000 အနက် 300,000 သာ မှတ်တမ်းဝင်၍ ကျန် 20,000 ဖြည့်စွက်မှတ်တမ်း`.
7. Save.

**Result of this single action:**
- `PaymentsPage` runs `splitStandalonePayment(20000, 100000)` and inserts one standalone `agent_payments` row of `20,000` MMK dated `2026-11-20` (`kind = 'old_debt'`, `source_entry_id = NULL`).
- Because `agent_outstanding()` subtracts `SUM(agent_payments.amount)` regardless of `kind`, U Aye Myint's balance immediately changes from `+100,000` to **`+80,000` MMK (`ရရန်ကျန် 80,000`)**, matching reality.
- Backdating to `2026-11-20` also attributes the missing `20,000` MMK cash to the exact day it was received (`2026-11-20` total cash becomes `200,000 + 320,000 = 520,000` MMK), while preserving the immutable `audit_log`.

---

## Independent Verification of the Other Reviewer's Claim

| Part of Claim | Verdict | Proof from Independent Arithmetic |
|---|---|---|
| *"The Nov 20 03:09 PM cash was recorded as 300,000 instead of the real 320,000"* | **AGREE** | Recorded Visit #3 cash = `20,000` (Entry #3 `amount_collected`) + `200,000` (linked `old_debt`) + `80,000` (linked `regular`) = `300,000` MMK vs real `320,000` MMK. |
| *"the linked 'regular' portion is 80,000 where it should be 100,000; a 20,000 MMK recording error."* | **AGREE** | `allocateCash(320000, 20000, 200000)` yields `toToday = 20,000`, `toOld = 200,000`, `advance ('regular') = 100,000`. Recorded linked `'regular'` payment #2 is `80,000` — under-recorded by exactly `20,000` MMK. |
| *"The card's current +100,000 is otherwise explained by later trips, above all the unpaid Nov 23 trip of 100,000."* | **AGREE** | After Nov 20 03:09 PM (`−80,000` recorded / `−100,000` true), the unpaid Nov 20 03:10 PM trip (`+100,000`) erased the credit (`+20,000` / `0`), Nov 21 visits netted `−20,000` (`0` / `−20,000`), and the unpaid Nov 23 11:42 AM trip (`+100,000`) brought the balance to `+100,000` recorded / `+80,000` true. |
| *"After correcting the record, the true balance is ရရန်ကျန် 80,000 — the agent still owes 80,000; he is NOT in overpayment anymore."* | **AGREE** | `920,000` total charges − `840,000` total real cash = **`+80,000` MMK (`ရရန်ကျန် 80,000`)**. |

**Overall Verdict:** **AGREE** (on every point).
