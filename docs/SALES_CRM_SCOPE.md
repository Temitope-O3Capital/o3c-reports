# Sales & CRM — audit, rebuild, and what remains

_Audited and rebuilt 2026-08-10 against the live `o3_workspace` database._

**Who it is for:** the Sales Team, who also act as **Account Officers** — they acquire
the customer and then own that customer's book for life.

---

## 1. The workflow it now serves

```
   Lead in                Qualify            Convert              Own the book
┌──────────────┐      ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
│ Business Dev │      │ new →        │   │ Customer     │   │ Officer = Account│
│ Campaign     │ ───▶ │ contacted →  │──▶│ exists with  │──▶│ Officer for life │
│ Call centre  │      │ qualified    │   │ a real CIF   │   │                  │
│ Walk-in      │      │              │   │ (from feed)  │   │ Cross-sell       │
│ Referral     │      │ or           │   │              │   │ Applications     │
│ Officer      │      │ disqualified │   │ Officer      │   │ Monitor & retain │
└──────────────┘      └──────────────┘   │ inherited    │   └──────────────────┘
                                          └──────────────┘            │
                              ┌───────────────────────────────────────┤
                              ▼                ▼               ▼      ▼
                           Loans/LOS    Fixed Deposits      Cards   Collections
                            → Risk                                  & Recovery
```

---

## 2. Root cause, and what it was hiding

`core/db.go` — `DualQuery` took an MSSQL query and a Postgres query and **discarded the
MSSQL one** (`_ = msQ`). Every caller still passed a fully-formed live query that never
executed: **133 dead `dbo.*` queries across 18 handler files.**

Two things were hiding behind that:

**Acquisition looked like it had collapsed.** Reported 167 / 65 / 161 new customers for
2023–2025 against 6,236 in 2021. It was an artefact — 3,717 of 21,012 customers (18%)
carry a NULL `account_created`, and they are the most recent ones: every CIF above
00037038 is undated. Bucketing by that column silently dropped them.

**Account-officer ownership was silently deleted.** It lived in the retired card
system's `dbo.Account.Account_Manager_txt`. That field is **not carried by the feed**
(the `acct_file` map has 20 fields, none an officer) and was **never backfilled** —
`app."Products"."Account Manager"` is NULL on all 20,474 rows. The data no longer
exists anywhere.

### The corrected acquisition picture

| Year | Was reported | Actual | Recovered from first account |
|---|---|---|---|
| 2021 | 6,231 | **6,895** | 664 |
| 2022 | 3,240 | **3,261** | 21 |
| 2023 | 166 | **388** | 222 |
| 2024 | 65 | **720** | 655 |
| 2025 | 159 | **749** | 590 |
| 2026 | 0 | **352** | 352 |

2024 was understated by a factor of eleven.

---

## 3. What was built

### 3.1 MSSQL removed entirely
- `DualQuery`/`DualScalar` collapsed to Postgres-only; the dead argument removed from
  **79 call sites** and **40 `{key, ms, pg}` spec-struct literals** via two `go/ast`
  transformers (hand-editing ~120 sites with multi-line SQL was not safe).
- `dbo.*` references: **133 → 0**.
- `isTableMissing` now matches SQLSTATE `42P01` only. It previously accepted any error
  containing "does not exist", which swallowed `column "x" does not exist` (42703) — so
  a typo'd column returned an empty table instead of failing.

### 3.2 Customer feed ingestion — `backend-go/custfeed/`
Customers are **not** created in Udara (Udara holds only the loan and FD books). They
arrive in the 15-minute `cust_file` drops.

- Tail-anchored parser: the files are unquoted CSV, so a comma inside an address widens
  the row; reading by fixed index would shift the tail and write the city into the state
  column. Name is anchored at the head, contact details and CIF at the tail.
- **Verified against production**: 2,517 files, 27 non-empty, 28 rows, **0 rejected**,
  all exactly 12 fields.
- Idempotent — `customer_feed_files.filename` is UNIQUE; a second run reads zero files.
  Asserted in `TestLiveIngest`.
- Blank field in a delta means "no change", not "clear it" — every column upserts via
  `COALESCE(NULLIF(new,''), old)`.
- Runs every `CUSTOMER_FEED_INTERVAL` (default 15m); no-op when `DATA_FEED_DIR` is unset.

### 3.3 Acquisition date — `app.customer_acquisition`
`cust_file` carries no date, so acquisition date is derived with explicit precedence:
`account_created` → first account opened → `first_seen_at`. `acquired_on_source` travels
with it so a report can disclose how firm each date is (17,296 recorded, 2,507 derived,
1,210 still unknown) rather than presenting inference as fact.

### 3.4 Account-officer ownership — the permanent fix
Ownership is now **workspace-owned**, in `customer_officers` keyed on CIF, with
`customer_officer_history` for the audit trail. Deliberately not a column on
`app.customers`: that table is feed-owned and upserted on every ingest, whereas an
assignment is a human decision that must survive re-ingest and never be overwritten by
a file drop. `ON DELETE RESTRICT` stops an officer being deleted while holding a book.

### 3.5 Lead lifecycle
`crm_contacts` gained `lead_stage` (new → contacted → qualified → converted /
disqualified, CHECK-constrained), owner, value, next action, and conversion fields.
`crm_lead_events` records every move. `crm_lead_sources` seeds nine sources including
**Business Development** and **Sales Officer**.

Conversion requires a **real CIF that already exists** in `app.customers` — customers
are created in the card system and arrive through the feed, not invented here. On
conversion the lead's owner becomes the customer's account officer.

### 3.6 Applications to Risk
`POST /api/sales/applications` raises a loan or credit-card application for a customer
**on the officer's own book** (heads may raise for any), submits straight to
`risk_review`, and notifies `risk_officer` + `risk_head`. It writes the same
`loan_applications` row the LOS queue works from — no parallel workflow.

`GET /api/sales/applications/{id}/booking` answers *"did this actually book in Udara?"*,
matching on customer and approved amount.

### 3.7 Pages
| Page | Change |
|---|---|
| **Overview** | Rebuilt for the Team Lead: acquisition trend (stacked confirmed vs derived), team league table, lead sources, attention worklist, feed freshness. Was a credit-origination page reading a 0-row table. |
| **My Book** (new) | Replaces My Accounts. Reads the customer master, paginated, links to C360 **by CIF**. Bulk assignment for heads. |
| **Leads** (new) | Capture, funnel filter strip, advance / convert / disqualify. |
| **My Accounts** | Deleted; `/sales/accounts` redirects to `/sales/book`. |
| Sidebar | 9 entries → 8, ordered book → leads → pipeline → tasks → applications → targets → reports. |

### 3.8 Audit bugs fixed
| # | Bug | Fix |
|---|---|---|
| 2.1 | 133 dead MSSQL queries | removed |
| 2.2 | Missing table returned empty | SQLSTATE-only match |
| 2.3 | "View C360" passed row id to a `:cif` route | Book links by CIF |
| 2.4 | Officer book filtered on an always-NULL column | `customer_officers` |
| 2.5 | `isHead` covered only 2 roles | admin/cfo/head_ops included |
| 2.6 | Book built on `crm_contacts` (1,794 of 29,663) | customer master (21,013) |
| 2.7 | `listAccounts` had no LIMIT | paginated, 50/page |
| 2.9 | Overview was credit origination | rebuilt |

---

## 3.9 Defect found in this build and fixed

Live logs showed repeated `500 Query failed` from 10:36 onwards. Cause: the new
handlers passed the raw `?officer_id=` / `?owner_id=` query **string** straight into a
comparison against a **bigint** column, so Postgres evaluated `bigint = text` — an
operator that does not exist — and the whole request died with a bare 500.

Affected: the officer filter on the book and its summary, the owner filter on the lead
queue and funnel, and the officer filter on applications. Anything unfiltered was fine,
which is why the first round of verification missed it — the SQL was only ever exercised
without those parameters.

Fixed by parsing the parameter in Go (`parseUserID`), so a bad value now returns a 400
saying what is wrong instead of a 500 saying nothing. Covered by `sales_scope_test.go`,
which also pins the `isSalesHead` role set since that governs data scope.

## 4. Corrections to the first audit

- **`crm_pipeline_stages` was NOT empty.** It holds six stages (Lead, Qualified,
  Proposal, Negotiation, Won, Lost). The original count came from `pg_stat_user_tables.
  n_live_tup`, an estimate that was stale. Every other zero was re-verified with a real
  `COUNT(*)` and confirmed. The seed in migration 128 is guarded and left them alone.

---

## 5. What remains — and what is blocking it

### 5.1 No sales officers exist (blocking, not code)
`o3c_users` holds **zero** users with `sales_officer`, `sales_head` or `head_sales`.
Everything per-officer is structurally empty until those accounts are created in
Admin → Users. The Overview says so on the page rather than rendering a silent zero.

### 5.2 The backend is live on the new build — one restart still needed
The keep-alive task consumed the `RESTART.flag` and the server came up at **09:25:31**
on the new binary. Proof is in `logs/backend-20260810.log`: it logs
`customer feed worker disabled (DATA_FEED_DIR unset or not a directory)`, a line that
exists only in this build. Migrations 127 and 128 were applied manually beforehand, so
the restart had nothing pending.

That log line also exposed a real gap: **`DATA_FEED_DIR` was never set in `.env`**, so
the customer-feed worker started disabled. The successful ingest earlier ran through the
test harness with the variable passed explicitly, not through the server.

`DATA_FEED_DIR` and `CUSTOMER_FEED_INTERVAL` have now been appended to
`backend-go/.env` (a timestamped `.env.bak-*` was taken first). Forward slashes are used
deliberately — Go's `os.Stat`/`filepath` accept them on Windows and they avoid
backslash-escaping surprises in dotenv parsing; the exact value was verified against the
live folder. **The worker only picks this up on the next restart.**

### 5.3 Udara returns no loans and no FDs
`cbs_sync_runs` has 9,933 successful runs, and every one returns **7 products, 0 loans,
0 FDs**. `cbs_loans` and `cbs_fixed_deposits` are empty. The book's loan and FD columns
and the Udara booking check are written against the real schema and will fill the moment
that sync returns data — but somebody needs to find out why it returns nothing.

### 5.4 21,013 customers have no account officer
Expected: assignment is new and there is nobody to assign to yet (5.1). Bulk assignment
is built and waiting.

### 5.5 Still open
- 1,210 customers have no acquisition date from any source.
- `call_center_contacts` (13,568) remains a strict phone-subset of `crm_contacts` —
  merging it was scoped but not done.
- `acct_file` and `txn_file` ingestion (the accounts and transaction streams) remain
  part of the separate data-feed project; only the customer stream was in scope here.

---

## 6. Files

**New:** `custfeed/{parse,ingest,parse_test,live_test,ingest_live_test}.go` ·
`handlers/{customer_feed,sales_book,sales_leads,sales_overview,sales_applications}.go` ·
`migrations/{127_customer_feed_and_officers,128_sales_acquisition_and_leads}.sql` ·
`pages/sales/{Book,Leads}.tsx`

**Rewritten:** `pages/sales/Overview.tsx` · `core/db.go`

**Deleted:** `pages/sales/MyAccounts.tsx`

**Mechanically edited:** 18 handler files (MSSQL removal)
