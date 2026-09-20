# Data quality — known issues register

Findings from the September 2026 audit of the workspace data pipeline. Each entry
records what was found, the evidence, and the decision taken. Entries marked
**Documented, not fixed** were deliberately left as-is; the reason is recorded so
the next person does not rediscover the same thing and wonder whether anyone saw it.

Evidence figures come from the `o3_workspace` dump taken 2026-09-12 01:30 unless
stated otherwise.

---

## 1. Impossible interest on one USD card — ONGOING, not historical

**Status:** Open — upstream (CCS). Reclassified 2026-09-20: this was recorded as two
2023 spikes and set aside as historical. It is neither. It is monthly, it runs to
**2026-08-14**, and it accounts for **99.5% of all USD "income" the book has ever
recorded**.

**What the numbers are.** One account — product Amex USD, **card limit $1,000**,
balance $2,633.25 — has taken **29 "Total Interest" (604) postings over $1,000,
totalling $7,677,337.68**, between 2023-04-14 and 2026-08-14:

| Year | Postings | Total |
|---|---|---|
| 2023 | 7 | 6,763,602.28 |
| 2024 | 11 | 317,371.67 |
| 2025 | 7 | 337,222.89 |
| 2026 (to Aug) | 5 | 259,140.84 |

All-time USD income is **$7,715,339.91**. Remove these and what is left is
**$2,845.68 across 591 postings** — dollar-scale, plausible, and the real number.
Every USD revenue figure in the app is therefore meaningless until this is corrected
at source; the split by currency (migration 243) makes the corruption visible but
does not remove it.

Monthly interest of $43k–$69k on a $1,000 limit is impossible as dollars. These are
naira amounts posted to a dollar account, and the mechanism is still running.

**Do not fix this downstream.** Deleting or rescaling the rows would put the
workspace out of agreement with CCS, which is the system of record. It needs the
card team to correct the posting at source.

CCS posts USD-card amounts **in dollars** (confirmed by the business, and by the data:
fixed fees on USD cards are $5 joining / $10 maintenance / $5 re-issue, against
₦5,000 / ₦15,650 / ₦2,500 on naira cards). Against that, four postings are
impossible as dollar amounts:

| Date | Code | Description | Amount |
|---|---|---|---|
| 2023-07-14 | 604 | Total Interest | 6,113,408.69 |
| 2023-07-14 | 603 | Overdue Interest | 6,113,408.69 |
| 2023-09-14 | 604 | Total Interest | 553,720.86 |
| 2023-09-14 | 603 | Overdue Interest | 553,720.86 |

The median interest posting on a USD card is **$0.33**. These are almost certainly
naira amounts booked onto dollar accounts.

Notes for anyone revisiting:

- Each spike appears on both 604 and 603 with an identical amount. 603 has
  `counts_in_total = false` in `app.card_txn_codes`, so only the 604 row reaches
  `app.income_daily`. The revenue impact is therefore ~6.67m, not the ~13.3m a naive
  sum of both codes gives.
- Across all time there are **63** fee/interest/penalty postings over 1,000 on USD
  cards, totalling 14,905,439.13 of the 14,927,440.78 on those cards. Excluding the
  top 50 rows leaves **$94,831** — dollar-scale and plausible.
- The recurring $47k–$70k postings once listed here as "not investigated" are the
  same account and the same defect — that is what the table above measures.
- Correction belongs at source (CCS), not downstream.

## 2. USD revenue was summed into a column labelled naira

**Status:** Fixed (migration 243).

`app.income_daily.amount_ngn` and `app.interest_components_daily.amount_ngn` summed
every currency. `app.transactions` had no currency until migration 233. Now resolved
per row by `app.resolve_currency()`, and both views are naira-only; USD is reported
separately through `app.income_daily_by_currency`. No conversion is applied — a
combined figure needs a dated FX rate, and the choice of rate (official CBN vs the
parallel-market rate already scraped into `fx_parallel_rates`) is a finance decision.

The same defect sat in the Interswitch card pages (`handlers/interswitch.go`): every
volume, channel, product, trend and merchant figure, and every month of the channel
report, summed dollar-card postings into naira. Those figures are now naira cards
only (`iswIsUSD`), and dollar-card volume is returned alongside in cents
(`usd_volume_cents`, `usd_channel_breakdown`, and a `usd` column on the report).

The report also moved from four columns to the summary page's categories — ATM,
POS, web transfer, bills, repayment, fees and Other. Its old fourth column,
"Transfer", was a residual that silently carried bills, repayments and charges.

## 3. Future-dated transactions

**Status:** Documented, not fixed.

`MAX(app.transactions.txn_date)` and `MAX(app.ccs_transactions.txn_date)` are both
**2026-09-23** in a dump taken 2026-09-12. Business dates supplied by the source are
therefore not safe as a freshness signal. `app.v_pipeline_freshness` measures ingest
timestamps only for this reason.

## 4. Feed files that failed and were never retried (2021–2023)

**Status:** Fixed (2026-09-20). No rows were lost, and the cause — which was still
live — is gone.

Twelve `txn_file` drops are recorded in `app.feed_files` with `status='failed'` and
the error `insert N txns: extended protocol limited to 65535 parameters` — a batch
too large for a single parameterised insert. Around 47,000 rows in total. Failed
files are recorded and never reprocessed.

**Now verified (2026-09-20):** every one of those twelve dates is fully present in
the ledger from the `mssql_baseline` load — e.g. 2021-11-14 holds 5,114 rows, 5,112
of them baseline. Nothing was lost.

**But the cause was still live.** All twelve are the monthly bulk drop (sequence 94,
the 14th of the month) carrying 3,700–4,800 transactions. `txnfeed` binds 20
parameters per row, so 65,535 / 20 caps a single statement at **3,276 rows** — every
future bulk drop would have failed the same way. The insert is now chunked at 2,000
rows per statement inside the same transaction, so a file is still all-or-nothing.
`txnfeed/batch_test.go` locks the invariant so it cannot regress.

The twelve recorded failures are left in `app.feed_files` as history; their rows are
already in the ledger, so reprocessing them would achieve nothing.

## 5. CCS feed intermittent from 2026-09-08

**Status:** Open — upstream. Monitoring added (migration 238).

The push to `\\10.1.2.30\E$\{acct,txn,cust,cardfam}_file` (the `E:` drive on this
server) went quiet at 08:38 on 2026-09-08, at sequence 33–34 of ~96 daily windows,
after two tiny non-empty drops (198 and 136 bytes). Directory owner is
`O3CARDS\oolajide`. Every existing signal stayed green; see
`handlers/pipeline_monitor.go` for why and for the monitor that now catches it.

**Correction (2026-09-14 12:14):** it had not stopped outright. In the seven days to
that check, `app.feed_files` recorded 61 non-empty account drops (1,402 rows) and 73
non-empty transaction drops (215 rows), the newest at 09:08 and 08:38 that morning,
and files kept landing until 08:49. The feed is thin and irregular rather than dead —
which is exactly the case the volume-taper check exists for.

## 6. The legacy PowerShell ingester has never loaded a row

**Status:** Open — needs the task repointed or retired.

`C:\Users\tbabatunde\o3c-db\52_ingest.ps1` defaults `-Landing` to
`C:\Users\tbabatunde\Desktop\Data Dump`, which holds only April 2026 files, and
`run_ingest.ps1` passes no override. `ingest.file_log` has zero `loaded` rows;
`ingest.v_health.hours_since_last_drop` was frozen at ~3,272h. The task
`O3C-CCS-Ingest` returns exit code 0 every 15 minutes regardless.

## 7. Manual-upload sources months stale

**Status:** Open — operational. Now visible on the Data Freshness page.

| Source | Newest import | Newest business date |
|---|---|---|
| Interswitch settlement (`interswitch_legs`) | 2026-08-05 | settlement 2026-07-01 |
| CCS EODTXN (`ccs_transactions`) | 2026-08-05 | — |
| Card cycle (`card_cycle_data`) | 2026-08-04 | cycle 2026-07-14 |

## 8. Duplicate customer rows per CIF

**Status:** Documented, not fixed.

Joining the 2026-07-14 `cust_file` export to `app.customers` on zero-padded CIF, 21,057
matched CIFs produced 21,442 rows while the export itself had no duplicate CIFs — so
**~385 customer rows share a CIF** in `app.customers`. Any upsert keyed on CIF must
dedupe first. A diagnostic view is the recommended next step; no rows should be
deleted without review.

## 9. Field-map corrections to `docs/DATA_FEED_INGESTION.md`

**Status:** Fixed in code (migrations 233); the doc itself still carries the old guesses.

| File | Field | Doc says | Actually |
|---|---|---|---|
| `acct_file` | 7 | branch code | **ISO-4217 currency** — 566 NGN / 840 USD (every 840 row is Amex USD) |
| `acct_file` | 4 | code/count | status code (1,2,3,4,6); does **not** map onto `accounts.status` |
| `txn_file` | 8 | flag/code | code class, 1:1 with `txn_code`; **not** a channel |
| `txn_file` | 14 | processing code | processing code — confirmed; **not** a transaction time (`000000` on ~99.4% of rows) |

## 10. False-green worker signals

**Status:** Fixed.

- `care_mail` and `graph_inbox` beat `ok` with "Graph not configured" (44,869 and
  14,888 runs) — now `idle`.
- `batch_log.status` recorded `success` while steps failed (32 of 57 runs) — now
  derived from the steps.
- Sync hub fleet banner excluded `stale` — now counted as a fault.
- Five workers beat heartbeats with no registry row and were invisible on the hub —
  now registered.

## 11. "Merchant" rankings were mostly not merchants

**Status:** Fixed (migration 244).

`merchant_name` is the feed's narrative field (`txn_file` field 11), and its meaning
depends on the transaction type: a transfer narrative on transfers, the username of
the staff member who posted it on payments, the ATM location on cash advances, and
the merchant only on purchases. Top-merchant lists ranked all of them together.
They are now purchase-only; cash-advance narratives are surfaced separately as
withdrawal locations.

The field is also truncated at ~21 characters, so one merchant appears under
several spellings. `app.clean_merchant()` normalises case, punctuation and company
suffixes, and `app.merchant_alias` maps truncated spellings onto their fuller form.
Aliases found automatically (`source = 'auto_prefix'`) are applied at once but are
marked `reviewed = false` for someone to check.

## 12. Upload history was an empty page

**Status:** Fixed (migration 245).

The Uploads audit page queried `app.upload_audit_log`, a table no migration had
created, so it always failed. The table now exists. The card cycle, CC statement and
CCS EODTXN importers write a row per upload, and Interswitch settlement runs are
read from `interswitch_imports`. The EODTXN importer also used to discard insert
errors (`//nolint:errcheck`) and report every parsed row as imported; failures are
now counted, returned and recorded. Uploads made before this change have no history.

## 14. Alerts that reached nobody who could act

**Status:** Fixed (migration 256), 2026-09-20.

The freshness monitor notified a hardcoded `it_admin` + `admin`. Six days after it
shipped, **no user held `it_admin`** and two held `admin` — while the three sources
that were actually broken (CCS EODTXN 46 days stale, Interswitch settlement 45, card
cycle 47) belong to Cards ops and Settlement ops, who were never told.

`app.pipeline_source.notify_roles` now carries the recipients per source, seeded
from the `owner` each source already had. Checked against who holds each role:
`it_admin`, `finance_head`, `cmo` and `bi_head` have no holders at all, so every
source that would otherwise reach only admins is paired with a role that has a
person in it (`head_ops`, `cfo`, `bi_analyst`). The Data Freshness page shows the
recipient count per source and says **"reaches nobody"** in red when a source's
roles resolve to no one, so this cannot rot silently again. `NotifyRoles` always
copies admins, so the list can narrow who else hears but can never silence an alert.

## 15. Merchant-name merges had nowhere to be reviewed

**Status:** Fixed, 2026-09-20.

Migration 244 flagged its 597 automatic merges `reviewed = false` "so a person can
veto any of them" — and there was no screen on which to do it, so all 597 sat
unreviewed. **Reports → Merchant Names** now lists each merge with the transaction
count and spend on both sides, and offers Keep, Separate, or a hand-written mapping
(which the daily job never overwrites). Rejecting an automatic merge removes it, but
the job may propose it again — it returns unreviewed, never silently confirmed.

## 16. The uploads page showed only what HAD been uploaded

**Status:** Fixed, 2026-09-20.

Data Management listed upload history and the importers, so three datasets sitting
45–47 days stale looked exactly like three healthy ones. It now opens with an upload
status panel per manual source — how overdue, the owning team, the last upload and
who did it — from the same thresholds the alerts use, so the page and the alert can
never disagree.

## 17. The customer feed alerted stale when it was healthy

**Status:** Fixed (migration 257).

On 2026-09-20 the monitor reported the customer feed stale, with the taper check
firing first. It was wrong. The drops were arriving on time — 96 files that day,
newest at 17:19 — but none carried rows:

| Date | Files | Non-empty |
|---|---|---|
| 2026-09-15 | 96 | 33 |
| 2026-09-16 | 96 | 1 |
| 2026-09-17 | 96 | 5 |
| 2026-09-18 | 96 | 3 |
| 2026-09-19 | 96 | 0 |
| 2026-09-20 | 96 | 0 |

Two consecutive days with no customer changes is ordinary. The seeded note claimed
"~27 non-empty drops/day", which was never measured and is wrong by an order of
magnitude. Thresholds are now warn 48h / stale 120h, and taper detection is off for
this source: with a median of 1–3 rows a day, a ratio test is noise. The account and
transaction feeds keep their tight thresholds — they really do deliver ~1,090
non-empty drops a day.

## 18. A rejected merchant merge came back the next day

**Status:** Fixed (migration 258).

`app.refresh_merchant_aliases()` inserts `ON CONFLICT (clean_name) DO NOTHING`, which
protects an alias that exists. A rejected one does not exist — it was deleted — so
the job re-proposed it and the reviewer had to reject it again, indefinitely. The
only durable escape was to write an opposing mapping by hand, which is not what
"reject" should mean. Rejections are now recorded in `app.merchant_alias_rejected`
and the refresh skips them. Deleting a row there lets the job propose that merge
again.

## 19. Every push to main reported failure

**Status:** Fixed (2026-09-20).

Two separate causes, both unrelated to the code being pushed:

- **govulncheck** — GO-2026-6348 in `google.golang.org/grpc@v1.82.1`, reachable
  through the OpenTelemetry OTLP exporter, the only thing that pulls grpc in. Bumped
  to v1.83.1.
- **The on-prem deploy job** — `SERVER_HOST` and `SSH_PRIVATE_KEY` have never been
  set on this repository (its only secret is `CF_ACCOUNT_ID`), so the job wrote an
  empty key file and called `ssh-keyscan` with no host. It now runs only when both
  secrets exist, and otherwise skips with a warning saying so. A permanently red main
  teaches everyone to ignore it, which hides the failures that matter.

Note the workflow deploys to a Linux server at `/opt/o3c`; the Windows box that
actually serves the workspace builds from its own working tree and is unaffected.

## 20. The monitor alerted on ordinary quiet

**Status:** Fixed (migration 259).

Migration 238 seeded every threshold from judgement. Measured on 2026-09-20 over the
preceding 90 days, three of them fire on normal behaviour:

| Source | Reality | Was | Now |
|---|---|---|---|
| `paystack` | settlements land daily (Mon 37 … Sat 15, Sun 19) but the p95 gap is **1d 17h** and the worst is **3d** | warn 6h / stale 24h | warn 48h / stale 96h |
| `zoho_calls` | Mon–Fri **20,548–25,745** calls; **Sat 24, Sun 13** | warn 4h / stale 12h | warn 18h / stale 36h, weekends excluded |
| `appsflyer` | `activity_date` is a DATE, so the newest row reads as midnight — it warned at 17h while holding **that same day's** data | warn 12h / stale 48h | warn 36h / stale 72h |

The call centre does not work weekends, so no fixed threshold serves it: anything
tight enough to catch a Monday-morning outage alerts every Saturday, and anything
wide enough to cover a 62-hour Friday-to-Monday silence leaves that outage
undetected until Thursday. `app.pipeline_source.business_days_only` now marks such a
source, and the verdict subtracts whole weekend days from its age. Partial days are
not subtracted, so a Monday-morning gap is still measured honestly.

`v_pipeline_data_age` stays raw and `data_age` remains true wall-clock age;
`effective_data_age` is what the verdict tests. Measurement and policy stay separate,
which is why the weekend rule lives in the verdict view alone.

An alert that fires every weekend is worse than no alert: it teaches everyone to
ignore the one that matters, which is the failure this whole feature exists to catch.

## 13. Backfill of the migration 233 columns — run log

**Status:** Done, 2026-09-14 12:20:58–12:23:27, with `go run ./cmd/feedbackfill -apply`.

Before the run every new column was 100% NULL (checked 12:14). The tool re-read the
drops retained on `E:` and only filled NULL columns; it inserted and deleted nothing.

| Target | Rows filled | Source |
|---|---|---|
| `app.accounts` currency_code, status_code, interest_rate, card_issue_date | 20,623 (214 USD) | newest non-empty value per account across 92,174 `acct_file` drops |
| `app.customers` phone_2 | 4,712 | newest non-empty cell number per CIF across 5,092 `cust_file` drops |
| `app.customers` address_3 | 0 | no drop carries a third address line |
| `app.transactions` pcc, code_class | 19,811 | `txn_file` rows matched on `row_hash` (feed and catch-up rows only) |
| `app.transactions` currency_code | 1,033,229 (4,896 USD) | `app.resolve_currency` through the owning account |

Left NULL, deliberately: 71 accounts that appear in no drop, and 78 transactions whose
`account_no` matches no account (not defaulted to naira — that would be a guess). The
1.01M `mssql_baseline` transactions never carried pcc or code_class, so those stay
NULL permanently.

Checked after the run: all 214 USD accounts are Amex USD products and no USD-product
account resolved to naira; all 4,896 USD transactions sit on those accounts. Of the
4,712 `phone_2` values, 3,762 are identical to `phone` — the feed's cell field often
repeats the main number, so `phone_2` is a second number for only ~950 customers.

To undo: for accounts and customers, set the columns back to NULL where `last_seen` is
before 2026-09-14 12:20:58 (later rows were written by the live feed, which fills these
columns itself). For transactions there is no reliable insert timestamp to split on, so
resetting `currency_code`/`pcc`/`code_class` also clears what the live feed wrote after
the run — re-run the tool straight after, since the drops are still on `E:`. The tool
only fills NULLs, so repeating it is safe.
