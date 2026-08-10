# Data Feed Ingestion — Design (Sage as decoder, feed folder as source)

**Status:** design for sign-off — *no code, no DB changes yet* · **Date:** 2026-08-06 · **Owner:** Temitope

This is the design doc requested before any build. It describes how the workspace
Postgres becomes the owned system of record for **customers, accounts (cards), and
transactions**, fed by the 15-minute file drops — with the Sage database used only to
(a) decode the headerless feed files and (b) pull historical backfill. **We do not
connect to Sage at runtime going forward.**

Everything in §1–§4 is *verified* — read directly from the live feed folder
(`C:\Users\tbabatunde\Desktop\Data Dump`) and cross-checked against the Sage database
(`dbsvr01` / `Production_ED`) on 2026-08-06. §5 onward is the proposed build.

---

## 1. The two roles, and why Sage is only a decoder

| System | Role going forward |
|---|---|
| **Feed folder** (15-min drops) | **The live source.** Everything new arrives here. |
| **Sage** (`Production_ED`, SalesLogix on SQL Server 2014) | **Reference only** — (1) the *dictionary* that tells us what each column in the headerless feed files means, and (2) a one-time *historical backfill* to seed the tables. Not queried at runtime. |
| **Workspace Postgres** | **The owned system of record** we are building. |

Why Sage matters at all: **the feed files have no header row.** The first line of every
file is already data. Column meaning is *positional only*, and that position order is
defined by the Sage export query — so Sage is the single authority that lets us read them.

---

## 2. The feed folder — structure, cadence, naming

```
Data Dump/
├── cust_file/      customers      (cust_file.<DDMMYYYY>.<seq>.csv)
├── acct_file/      accounts/cards (acct_file.<DDMMYYYY>.<seq>.csv)
├── txn_file/       transactions   (txnlist_file.<DDMMYYYY>.<seq>.csv)
└── cardfam_file/   card families  (cardfam_file.<DDMMYYYY>.<seq>.csv)
```

- **Cadence:** one file per stream every **~15 minutes** (observed timestamps `…00:19,
  …00:34, …00:49, …01:03`). `seq` increments through the day; the date is **DD MM YYYY**.
- **Most files are 0 bytes** — an empty file means *no change in that window*, not an error.
  In one day's sample: non-empty counts were `cust 27`, `acct 1090`, `txn 1062`,
  `cardfam 0` out of ~2,500 windows each. Customers rarely change; accounts and
  transactions change constantly; card-families almost never.
- **These are deltas, not snapshots** — each non-empty file carries only the rows that
  changed in that 15-minute window. *(One thing to confirm with whoever generates the
  export — see §9.)*

---

## 3. Decoded column maps (feed position → meaning → Sage source)

Format is **headerless CSV, comma-delimited, no quoting**. Positions below are 1-indexed.
✓ = confirmed by matching an actual feed value back to a Sage row. ⁇ = inferred from
shape/context, **to confirm** (§9).

### 3.1 `cust_file` → customers (Sage `dbo.Contact`)
Sample: `JAMELAH,SANDA,7TH FLOOR SUIT 2 PLOT 117 NUSIBA,TOWERS MABUSHI ABUJA,,NIGERIA,8060777721,amelahsanda@yahoo.com,FCT,ABUJA,8060777721,00039966`

| # | Value | Meaning | Sage column |
|---|---|---|---|
| 1 | JAMELAH | First name | `First_Name` ✓ |
| 2 | SANDA | Last name | `Last_Name` ✓ |
| 3 | 7TH FLOOR SUIT 2 PLOT 117 NUSIBA | Address line 1 | `Address_1` ⁇ |
| 4 | TOWERS MABUSHI ABUJA | Address line 2 | `Address_2` ⁇ |
| 5 | *(empty)* | Address line 3 | `Address_3` ⁇ |
| 6 | NIGERIA | Country | `Country` ⁇ |
| 7 | 8060777721 | Phone | `Phone` ⁇ |
| 8 | amelahsanda@yahoo.com | Email | `Email` ✓ |
| 9 | FCT | State | `State_` ✓ |
| 10 | ABUJA | City | `City` ✓ |
| 11 | 8060777721 | Cell (dup of phone here) | `Cell` ⁇ |
| 12 | **00039966** | **Customer CIF** (8-digit) | `CIF` ✓ |

### 3.2 `acct_file` → accounts/cards (Sage `dbo.Account`)
Sample: `004009548566,PREP,0.00, 1,0.00,0.000,566,07/12/2021,0.00,0.00,31/12/2023,0.00, ,14/04/2026,CR,00000001,30/04/2026,506124*********0579,UA 457,07/12/2021`

| # | Value | Meaning | Sage column |
|---|---|---|---|
| 1 | **004009548566** | **Account number** (13-digit) | `Number_` ✓ |
| 2 | PREP | Product name | `Product_Name` ✓ |
| 3 | 0.00 | amount (limit/balance) | ⁇ |
| 4 | ` 1` | code/count (leading space) | ⁇ |
| 5 | 0.00 | amount | ⁇ |
| 6 | 0.000 | interest rate | ⁇ |
| 7 | 566 | branch code | ⁇ |
| 8 | 07/12/2021 | account created / issue date | ⁇ |
| 9–12 | 0.00 … 31/12/2023 … | balances + expiry | ⁇ |
| 14 | 14/04/2026 | extract/run date | ⁇ |
| 15 | CR | Dr/Cr indicator | `account_indicator` ⁇ |
| 16 | **00000001** | **Customer CIF** (8-digit) | `CIF_Number` ✓ |
| 17 | 30/04/2026 | payment due date | `Payment_Due_Date` ⁇ |
| 18 | 506124*********0579 | masked card PAN | `Card_Number_Masked` ✓ |
| 19 | UA 457 | name on card | `Name_On_Card` ✓ |
| 20 | 07/12/2021 | card issue date | `Card_Issue_Date` ⁇ |

*"Cards" is a filter on this stream, not a separate one:* `Product_Name` discriminates
`PREP` (prepaid Blink, 12,484), `Amex Naira/USD`, `Classic/Prestige/Platinum/Charge`
(credit cards), and the `…COOP`/`MEMCOS` cooperative **deposit** accounts.

### 3.3 `txn_file` (`txnlist_file.*`) → transactions (Sage `dbo.Transaction_Listing`)
Sample: `14/04/2026,14/04/2026,604,11827.61,Total Interest,0001073486566,,2,60477, 0,,,,000000,-1,1`

| # | Value | Meaning | Sage column |
|---|---|---|---|
| 1 | 14/04/2026 | post date | `Post_Date` ✓ |
| 2 | 14/04/2026 | transaction date | `Transaction_Date` ✓ |
| 3 | 604 | transaction code | `Transaction_Code` ✓ |
| 4 | 11827.61 | amount | `Amount` ✓ |
| 5 | Total Interest | description | `Description` ✓ |
| 6 | **0001073486566** | **Account number** (13-digit, *not* the customer CIF) | ties to `Account.Number_` ✓ |
| 7 | *(empty)* | PAN / trace | ⁇ |
| 8 | 2 | flag/code | ⁇ |
| 9 | 60477 | trace / sequence | `Trace` ⁇ |
| 10 | ` 0` | fees | `Fees_Amount` ⁇ |
| 11–13 | *(empty)* | merchant / MCC / city | `Merchant_Name`/`Merchant_Catergory_Code`/`City` ⁇ |
| 14 | 000000 | processing code | `Pr_Code`/`PCC` ⁇ |
| 15 | -1 | money-in flag (`-1` = true) | `Money_In` ⁇ |
| 16 | 1 | row sequence | ⁇ |

### 3.4 `cardfam_file` → card families
**No non-empty file in the sample window** — this stream almost never changes. It is a
low-frequency reference of card program/family definitions (relates to Sage
`Account.Card_Program` / `Card_Product` / `Card_Code`). We decode its layout the same way
— against Sage — the first time it produces a non-empty file. Treated as a reference/
lookup table, not a core entity.

---

## 4. The identity & join model (the important part)

The feed uses **two different keys**, and mixing them up is the main integrity risk:

- **Customer CIF** — 8 digits (`00039966`, `00000001`). Lives in `cust_file[12]` and
  `acct_file[16]`.
- **Account number** — 13 digits ending in branch `566` (`004009548566`,
  `0001073486566`). Lives in `acct_file[1]` and is the key `txn_file[6]` points to.

```
cust_file.CIF (00039966)
      ▲
      │  acct_file[16] CIF_Number  →  cust_file[12] CIF
      │
acct_file.Number_ (004009548566)
      ▲
      │  txn_file[6] account_no  →  acct_file[1] Number_
      │
txn_file.account_no (0001073486566)
```

> **A transaction cannot be joined directly to a customer.** You must go
> `transaction → account → customer`. (Note: Sage's *internal* `Transaction_Listing`
> keys on the 8-digit customer CIF instead — but the **feed** keys on the account number,
> so the feed is what our schema follows.)

Verified example: `txn_file` account `0001073486566` → `Account.Number_ 0001073486566`
→ `CIF_Number 00007369` (LIRS COOP, "VITTU T SEYON").

---

## 5. Proposed target schema (Postgres, owned)

Only meaningful columns; the ~80 SalesLogix junk fields on `Contact` are dropped. All money
stored as **kobo integer** per the workspace rule (feed amounts are naira decimals → ×100).

**`feed.customers`** — PK `cif`. first/middle/last/full name, address_1/2/3, country,
phone, cell, email, state, city, `source_updated_at`, `ingested_at`, `source_file`.

**`feed.accounts`** — PK `account_no`. `cif` (FK → customers), product_name,
product_line (derived: card / prepaid / deposit / loc), card_number_masked, name_on_card,
status, card_limit_kobo, cycle_balance_kobo, balances…, payment_due_date, card_issue_date,
expiry_date, `source_updated_at`, `ingested_at`, `source_file`.

**`feed.transactions`** — PK `txn_key` (natural dedup key — see §10.2). `account_no`
(FK → accounts), post_date, txn_date, transaction_code, description, amount_kobo,
fees_kobo, money_in, trace, merchant_name, mcc, city, `ingested_at`, `source_file`.

**`feed.card_families`** — reference lookup, loaded when `cardfam_file` first has data.

*Relationship to what exists:* the current `core.transaction` (1.02M rows) and
`app."Accounts"` are the **historical Sage snapshot**. The backfill (§7) reconciles the
new `feed.*` tables against them; downstream dashboards/recon repoint to `feed.*` once it
is proven at parity. **No downstream table is dropped until then.**

---

## 6. Ingestion pipeline (15-min loop, idempotent)

A Go worker on a 15-minute ticker (or file-close watcher) runs the same loop per stream:

1. **Detect** — list new `*.csv` since last run; **skip 0-byte files** (no-delta windows).
2. **Stage** — `COPY` the raw file into an unlogged `stg_<stream>` table of all-text columns,
   split strictly by position (§3).
3. **Validate** — required key present (CIF / account_no), field count matches the expected
   column count, dates parse as **DD/MM/YYYY**. Bad rows/files → `quarantine/`, logged,
   **never silently dropped**.
4. **Transform** — trim leading spaces, naira→kobo (×100), `-1`→true, day-first dates,
   derive `product_line`.
5. **Upsert** — `INSERT … ON CONFLICT (natural_key) DO UPDATE`. **Idempotent** —
   re-processing the same file is always safe.
6. **Archive** — move file to `archive/YYYY/MM/DD/`.
7. **Record** — one row in `feed.ingestions(stream, file, rows_seen, upserted, rejected,
   window_ts, status, error, started_at, finished_at)`. Nothing swept under the carpet.

Order safety: because upserts key on natural keys, files can be reprocessed or arrive out
of order without corruption. `customers`/`accounts` upsert last-write-wins on
`source_updated_at`; `transactions` are append/idempotent on `txn_key`.

---

## 7. Historical backfill (one-time, from Sage)

Seed each table once from Sage, then let the feed take over:
- `feed.customers` ← `dbo.Contact` (19,671)
- `feed.accounts` ← `dbo.Account` (20,592)
- `feed.transactions` ← `dbo.Transaction_Listing` (1,020,472) — but keyed by **account_no**
  to match the feed, resolving `Transaction_Listing.CIF (customer)` → account via `Account`.

Run read-only, off-hours. After backfill, the first live feed files continue from the last
change — verify row counts match Sage before cutting over.

---

## 8. Data-quality gotchas already observed (handle explicitly)

1. **No header row** — positional; the order is the Sage export's SELECT order and must be
   pinned in config, not assumed to equal Sage table definition order.
2. **Unquoted commas** — addresses split cleanly only because they map to Address_1/2/3; a
   comma inside a *name* or *merchant* would shift every later column. Parser must validate
   field count per row and quarantine mismatches.
3. **Corrupt values** — a CIF field appeared as `0000000\`` (backtick instead of a digit).
   Reject to quarantine, don't coerce.
4. **Leading spaces** (` 1`, ` 0`) — trim before typing.
5. **Dates are DD/MM/YYYY** — must parse day-first, never US month-first.
6. **Booleans as `-1`** (`Money_In`) — SalesLogix bit convention.
7. **Masked-PAN format differs** from Sage (`506124*********0579` in feed vs
   `XXXXXXXXX*0579` in Sage).
8. **Two account-number formats** — `Number_` (13-digit …566, the feed key) vs
   `Account_Number_txt` (12-digit `4009…`). Don't conflate.
9. **Empty files are normal** — 0-byte = no delta; treat as success, not failure.

---

## 9. Transaction channels & Paystack ↔ ledger reconciliation

Every row in `txn_file` belongs to a payment channel, and the settlement module has to
reconcile the card-scheme (**Interswitch**) and gateway (**Paystack**) feeds against it.
`Transaction_Code` (field 3) is the master classifier — it is 1:1 with `Description` and
counts match the ledger exactly.

### 9.1 Three channel families (read from `Transaction_Code`)

| Family | What it is | Codes | Tell-tale |
|---|---|---|---|
| **Interswitch** (card-switch) | Spend + switch-routed payments | 300, 200, 423, 903, 303, 202, 422, 302 + reversals (250/252/350/352/353/472/473) | **MCC/merchant populated** |
| **Collections** (where **Paystack** lands) | Customer repayments, money-in (CR) | 402, 400, 401, 403, 405, 411–416, 452 | money-in, mostly no MCC |
| **Internal** (neither channel) | Interest, fees, adjustments the card system posts itself | 6xx, 1xx, 8xx | no merchant, no external feed |

Note `402` straddles two families: ~8.8k card-channel payments (with MCC, in the
Interswitch feed) vs ~93k bank/gateway payments (no MCC). Split it by MCC presence.

### 9.2 Reference keys — the asymmetry that drives the design

- **Interswitch = clean key.** The STAN is stored in Sage `Trace` (100% populated) and
  arrives in the feed as `txn_file` field 9. Reconciles 1:1 on `cif + trace + amount + date`
  (the existing recon engine). Note `Trace` is **not globally unique** (1.02M rows share
  ~505k traces) — it keys a match *with* CIF, never alone.
- **Paystack = no key in Sage.** Exhaustively searched all of `Production_ED` (named,
  numeric, reference-sized, and blob columns) plus `Production_BM` — the Paystack
  reference/ARN appears **nowhere**. It is lost when O3 posts the collection into Sage.
- **Sage has a unique txn id** (`Transaction_Listing_Id`, unique bigint ~8.99M) but it is
  **not** the Paystack ref and is **not** carried in the feed.
- **The CMS front-end holds `transaction_id = Paystack reference`** — but the CMS is a
  *separate system* from the Sage SQL Server, so that key isn't reachable from Sage or the
  feed today. Getting it emitted into the feed is the permanent fix (§9.4).

Paystack collections land in the ledger as code **`422` "Web Transfer In"** (verified: three
of one customer's Paystack payments matched `422` rows on exact amount + date).

### 9.3 Paystack matching without a shared key — 3 layers

Runs entirely on the **owned DB fed by the folder** (`paystack_transactions` mirror ⟷
`feed.transactions` code `422`); Sage is never queried at runtime.

- **Layer 1 — customer crosswalk (`feed.paystack_customer_map`), built once, kept fresh by
  `cust_file`.** Resolve each Paystack customer → CIF by cascade: `customer_email` →
  email (primary); `customer_phone` → phone/cell **normalized to last-10-digits**
  (secondary); name + card `auth_last4` to break duplicate-contact ties; residual resolved
  manually once. This fixes the identity gap that caps everything (18% missing email +
  duplicate contacts).
- **Layer 2 — within-customer tiered match** (strict 1:1, never auto-pick among candidates,
  like the Interswitch engine). Match on **gross** amount (the `422` value = customer gross;
  net-of-fees adds nothing):
  - T1: CIF + `422` + exact amount + same date → 0.99
  - T2: CIF + `422` + exact amount + date ±2 business days (payout lag) → 0.95
  - T3: CIF + exact amount + ±3 days across `422`/`402`/`41x` → 0.85
  - \>1 candidate → `ambiguous` exception; 0 → unmatched exception.
- **Layer 3 — settlement-batch backstop.** Reconcile each Paystack payout
  (`paystack_settlements`) against that day's total Sage/feed `422` inflow, so **100% of
  value is accounted for** even when individual lines don't tie out. Residuals age in an
  exception queue.

**Expected:** line-level auto-match ~**60–75%** (a real slice of Paystack payments post to
*other* ledgers — loans/deposits — not the card `422`); Layer 3 covers the remainder by
value. The historical Sage pull provides a large labelled set to **tune and validate** the
matcher before it goes live on the folder.

### 9.4 The permanent fix

Since the CMS already holds `transaction_id = Paystack reference`, piping that reference into
the feed's transaction stream (or a spare Sage field) collapses Layers 1–3 into a **clean
1:1 join like Interswitch's STAN**. Same ask as the transaction id below: get the export to
emit the keys it already has.

---

## 10. Open questions to confirm before building

1. **Delta vs cumulative** — confirm each non-empty file is *only* that window's changes
   (assumed), not a growing cumulative dump.
2. **Transaction dedup key** — Sage *has* a unique id (`Transaction_Listing_Id`, unique
   bigint) but the feed omits it. Until the export emits it, dedup uses the composite
   `account_no + post_date + txn_date + transaction_code + amount + trace + row-seq`
   (`Trace` is not globally unique). Validate against real duplicates.
3. **Inferred positions (⁇ in §3)** — resolve the middle money/date/flag columns of
   `acct_file` and `txn_file` by matching same-day feed rows to a same-day Sage snapshot
   (Sage is live-current, so its balances have since drifted from the 14/04 sample).
4. **`cardfam_file` layout** — decode when it first produces a non-empty file.
5. **Who owns the export — and can it emit the keys it already has?** Getting three columns
   added to the drop would remove most guesswork: (a) a header row, (b)
   `Transaction_Listing_Id` as a stable unique txn id, (c) the **CMS Paystack reference**
   on collection rows (turns §9.3's 60–75% into a clean 1:1).
6. **Cutover policy** — how long `feed.*` runs in parallel with `core.transaction` /
   `app."Accounts"` before downstream repoints.

---

## 10b. repo → app.* loader — spec (post-consolidation, verified 2026-08-10)

The old external `raw→src→core` ingest is retired (its `src`/`raw` targets were dropped and
`core.transaction` is now a bridge view). It is currently **idle, not erroring** (no live drops
right now), so nothing is on fire — but `app.*` won't update until this loader is built.

**Target tables & keys (verified):**
- `app.customers` PK = `contact_id` (Sage surrogate). Feed has `cif`, not `contact_id`.
  `cif` is **not unique**: 19,577 distinct / 19,614 rows, 36 null, 1 dup (`00032142`).
- `app.accounts` PK = `account_id` (surrogate). Feed has `account_no` (`Number_`). `account_no`
  19,996 distinct / 19,999 rows → 3 dups, 0 null.
- `app.transactions` PK = `txn_id`; **`row_hash` has a partial UNIQUE index** → dedup-ready.

**Prerequisites before the loader (one-time production DB change):**
1. Dedup the 1 `cif` dup + 3 `account_no` dups (keep the richer row).
2. Add `UNIQUE(cif) WHERE cif<>''` on `app.customers` and `UNIQUE(account_no)` on `app.accounts`
   so the loader can `INSERT … ON CONFLICT (cif|account_no) DO UPDATE`. New feed-only rows get a
   synthetic surrogate id (`contact_id='feed:'||cif`, `account_id='feed:'||account_no`,
   `txn_id='feed:'||row_hash`).

**Loader (custom parser required — headerless/unquoted/embedded-comma CSVs):**
- Parse each stream positionally (§3 maps); validate field count per row; quarantine shifted
  rows (address-comma hazard, §8). Stage → transform (DD/MM/YYYY, naira→kobo, `-1`→bool) →
  upsert on `cif` / `account_no` / `row_hash`. `txn_file` links to a customer via
  `account_no → app.accounts.account_no → cif`.

**Open decision (yours):** where do **live drops** land going forward (still `Desktop\Data Dump`
or a server share?), and is the loader a **Go worker in the backend** (wired into `main.go`,
15-min ticker) or a **standalone scheduled job**? That choice sets where this gets built. Until
then `app.*` holds the Sage baseline (through Sep 2025) — accurate, just not live.

---

## 11. Proposed build order (once signed off)

1. Create `feed.*` schema + `stg_*` staging + `feed.ingestions` (migration, idempotent).
2. Parser + column-map config for the 3 live streams (§3), with validation/quarantine.
3. Backfill from Sage (§7); verify parity vs current tables.
4. 15-min worker + archive + ingestion logging (§6).
5. Channel classification (§9.1) + Paystack matcher: crosswalk → `422` tiers → settlement
   backstop (§9.3), tuned against the Sage backfill.
6. Repoint one dashboard to `feed.*` as a canary; verify; then the rest.
7. Decommission the live Sage dependency (already effectively off).
