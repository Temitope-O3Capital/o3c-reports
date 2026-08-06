# Database Consolidation Plan — one clean model, proper names

**Status:** plan for sign-off — *nothing dropped until each phase is approved & verified* · **Date:** 2026-08-06 · **Owner:** Temitope

Goal (Temitope): **one clean, properly-named set of tables** — `customers`, `accounts`,
`card_products`, `transactions` — that the repo syncs into. No `core.`/`feed.`/`src.`/`raw.`
prefixes, no compatibility views. Merge everything into it, then remove the rest.

---

## 1. What exists today (the mess, verified 2026-08-06)

The same customer/account/transaction data lives in **4+ layers**, and the app reads it
through **renamed views**:

| Layer | Holds | Rows (cust / acct / txn) | Notes |
|---|---|---|---|
| `raw.*` (acct/cust/txn/reject) | landing (bronze) | acct 231k · txn 4.3k | file drops land here |
| `src.*` (contact/account/transaction) | typed source (silver) | 19,614 / 19,999 / 1,024,025 | 1:1 copy of core |
| **`core.*`** (customer/account/transaction/product) | **clean canonical (gold)** | 19,614 / 19,999 / **1,024,025** | full history 2014→2026, live-fed, clean snake_case |
| `app."…"` views | serving | — | rename core.* → old Sage column names for legacy handlers |
| `feed.*` (mine) | partial port | 21,006 / 20,589 / **56,586** | Jan–Sep 2025 only, static, **wired to nothing** |
| `hist.account_snapshot`, `ingest.*` | history + run/file logs | — | ingest.file_log = 10,070 files, run_log = 1,995 |

**Key facts that drive the plan:**
- A **live 15-minute ingest pipeline already runs** (`ingest.run_log` entries every 15 min,
  today), consuming the same repo drops (`txnlist_file`/`cust_file`/`acct_file`), deduped by
  SHA-256, on top of an MSSQL baseline. This is *not* in the Go app — it runs externally.
- `core.*` is already the clean, complete, live set. **`feed.*` is the redundant duplicate**
  (a strict subset), so it is discarded, not adopted.
- The view names are **misleading** and are themselves a reason to clean up:
  - `app."Accounts"`  → is actually **customers** (`FROM core.customer`)
  - `app."Products"`   → is actually **accounts/cards** (`FROM core.account`)
  - `app."Transactions"` → transactions (`FROM core.transaction`)
  - `app."CIF Table"` → customer + first-account cohort (reporting)
  - `app."Monthly Activity"` → txn aggregate — **0 code references (unused)**
  - `app."Recovery Master Sheet"` → stub (`SELECT NULL… WHERE false`), 3 files
  - `app.interswitch_txns`, `app.interswitch_transactions` → settlement views

---

## 2. Target — one clean schema, proper names

Canonical tables (proposed in **`app`** so the app's existing `search_path=app,public`
finds them unprefixed; final schema is a sign-off item):

| Table | From | Clean columns |
|---|---|---|
| `customers` | core.customer (+ inferred stubs, email fix) | cif (PK), first_name, last_name, full_name, email, phone, address_1..3, city, state, country, gender, nationality, bvn, account_created, account_status |
| `accounts` | core.account | account_no (PK), cif (FK), product_name, product_line, status, card_number_masked, name_on_card, card_limit_kobo, balances, card_issue_date, card_expiry_date, payment_due_date, opened_date |
| `card_products` | core.product | product_name (PK), product_line, account_count |
| `transactions` | core.transaction (full history) | id (PK), cif, account_no, post_date, txn_date, txn_code, description, channel, amount_kobo, fees_kobo, trace, merchant_name, mcc, city |

- **Names carry over from `core.*`** (already snake_case) + the enrichments `feed.*` added
  (`product_line`, `channel`, inferred customer stubs) recomputed here.
- Collision: an empty legacy `app.card_products` (0 rows, app-native) exists — rename/drop it first.
- The repo ingest writes **only** to these four tables going forward.

---

## 3. View → clean-column translation (for repointing handlers)

The ~35 handlers query the views with Sage-style quoted names. Repointing = swap the view
for the canonical table and translate columns:

**`"Accounts"` → `customers`:** `"CIF Number"`→cif · `"First Name"`→first_name ·
`"Last Name"`→last_name · `"Email"`→email · `"Phone Number"`→phone · `"Full Address"`→full_address ·
`"State"`→state · `"City"`→city · `"Account Created Date"`→account_created

**`"Products"` → `accounts`:** `"CIF Number"`→cif · `"Name On Card"`→name_on_card ·
`"Product Name"`→product_name · `"Account Status"`→status · `"Card Product"`→product_line ·
`"Account Created Date"`→opened_date

**`"Transactions"` → `transactions`:** `"Transaction Date"`→txn_date · `"Amount"`→amount_kobo (÷100 for display) ·
`"Description"`→description · `"Merchant_Name"`→merchant_name · `"CIF Number"`→cif

**Files to repoint (35):** card_ops, card_trends, cards, cards_credit, care_mail, cbs_reports,
cc_statements, cohort, collections, contacts, crm, customer360, engine, executive, helpdesk,
income, interswitch, interswitch_settle, overview, parse, paystack_ops, recon_ops, reconcile,
reconciliation, recovery, reports, risk, sales, search, settlement_overview, settlements_ops,
statement_emails, stubs, transactions, voice.

---

## 4. The one blocker — the external ingest job

The 15-minute pipeline that fills `raw→src→core` is **not in the app repo and not a visible
scheduled task on the app server** — it runs from elsewhere (the DB host, or another team's
setup). **We must locate it before Phase 3**, because it has to be redirected to write to the
new canonical tables (or `core.*` renamed into place). Options once found:
- **(a) Rename-in-place:** rename `core.customer/account/transaction/product` → the canonical
  tables and update the job's target names. Least data movement.
- **(b) Repoint the job** to load the four canonical tables directly (drop the src/core hops).

**Action needed from you/ops:** where does the 15-min ingest run from (server + script/cron)?

---

## 5. Phased execution (nothing dropped until verified)

- **P0 — Backup.** `pg_dump` the whole DB (and specifically feed/core/src/raw/app views) to a
  restore point.
- **P1 — Locate the ingest job** (§4). *Blocker.*
- **P2 — Build canonical tables** in `app` from `core.*` + enrichments (product_line, channel,
  stubs); add PKs/FKs/indexes. Verify counts vs `core.*`.
- **P3 — Redirect the ingest job** to the canonical tables (rename-in-place or repoint); run one
  15-min cycle; confirm new rows land.
- **P4 — Repoint handlers** off the views onto the canonical tables (§3), module by module;
  `go build` + `tsc` clean each step.
- **P5 — Verify parity:** row counts, key dashboards (overview, cards, sales, recon), spot-checks
  vs the old views. Canary one dashboard first.
- **P6 — Drop, in order:** the 8 `app."…"` views → `feed.*` → `src.*` → `raw.*` → `hist.*` →
  redundant `core.*` remnants (keep `ingest.run_log`/`file_log` as the ingest audit trail) →
  the 3 orphan tables (`crm_contacts_name_backup_20260804`, `helpdesk_ticket_cif_backfill_20260804`,
  `zoho_customer_master`) → the empty legacy `app.card_products`.
- **P7 — Deploy & monitor** one full day of ingest + dashboards before removing the backup.

---

## 6. Data scope decision

`core.transaction` carries **full history (2014→2026, 1.02M)**. Confirm the canonical
`transactions` keeps all of it (recommended — dashboards/reports currently show full history),
rather than the 2025-only scope we used for the `feed.*` port.

---

## 7. What this deletes (final state)

Gone: schemas `raw`, `src`, `hist`, most of `core` (logic folded in), all 8 `app` compat views,
`feed.*`, and 3 orphan tables. Kept: the four clean canonical tables, `ingest.*` audit logs, and
every genuine app feature table. Result: **one clean, repo-fed model with proper names, no views.**
