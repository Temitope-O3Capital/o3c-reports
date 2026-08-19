# Reports & BI

The module that produces every report and **every data file** the workspace emits.

---

## The decision that shapes this module

**All data extraction happens here, and nowhere else.** O3's decision (2026-08-17)
is that the ability to pull raw data out of the workspace belongs to the BI team,
not to every operational screen.

So the `reports` page key is a security boundary, not a nav entry. It is held by
`bi_analyst`, `bi_head` and `admin` only, and `core/exportaccess_test.go` fails the
build if that ever silently widens.

Before this, roughly fifty pages each had their own Export button — about forty-five
of them building CSV in the browser with `.join(',')` and no quoting at all, none of
them recorded anywhere, and each with its own idea of who was allowed to press it.

Moved out of the module, deliberately:

| Page | Where it went | Why |
|---|---|---|
| **CBN Complaints Report** | `/compliance/cbn-complaints`, under Compliance | A statutory return, not a report anyone browses. It sat under `/reports` by URL accident. Gated on `cbn_reports`. |
| **KPI Tracker** | Stays at `/reports/kpi`, gated on `kpi_dashboard` | A dashboard every operational head uses daily. Narrowing this module must not take their KPIs away. |

Kept where they are, because they are not data extracts:

| Kept | Why |
|---|---|
| **Credit bureau submission**, **statements**, **board pack**, **upload templates** | Fixed external formats and input aids, not data extracts. A CRC/FirstCentral file has a 40-field spec; it is a deliverable, not a report. |

---

## Pages

| Page | Route | What it is |
|---|---|---|
| **Reports Library** | `/reports` | The standing operational and regulatory reports |
| **Data Export** | `/reports/export` | Ad-hoc extraction from any registered dataset |
| **Report Builder** | `/bi/builder` | Build and save a report definition |
| **Saved Reports** | `/bi` | Run, edit, export and schedule saved definitions |
| **Scheduled Reports** | `/bi/scheduled` | Recurring delivery by email |
| **My Dashboard** | `/reports/my-dashboard` | The analyst's own station |

---

## The export engine

```
POST /api/reports/datasets/{key}/preview    → confirm the rows before pulling a file
POST /api/reports/datasets/{key}/download   → the file (csv | xlsx | json)
GET  /api/reports/datasets                  → the registry, drives the whole UI
GET  /api/reports/exports/log               → who extracted what, and when
```

### Adding a dataset

Add an entry to `exportDatasets` in `backend-go/handlers/export_datasets.go`. That
is the entire change — the API, the column picker, the filters, the formats, the
row cap and the audit trail all follow. There is no frontend work.

```go
{
    Key: "my_dataset", Label: "My Dataset", Module: "Credit",
    Desc:    "One sentence an operator can act on.",
    From:    "app.my_table t",
    OrderBy: "t.created_at DESC",
    DateCol: "t.created_at::date", DateLabel: "Created",
    Cols: []exportCol{
        {Key: "ref",    Label: "Reference",   Type: colText, Expr: "t.reference"},
        {Key: "amount", Label: "Amount (NGN)", Type: colKobo, Expr: "t.amount_kobo"},
    },
    Filters: []exportFilter{
        {Key: "status", Label: "Status", Kind: filterText, Expr: "t.status = ?"},
    },
},
```

Then run the live test — it executes every dataset and every filter against the
real database:

```bash
cd backend-go && EXPORT_LIVE_TEST=1 go test ./handlers -run TestExportDatasetsRunLive -v
```

**Do this.** The module's original failure mode was shipping SQL nobody ran: four of
the seven BI modules referenced tables or columns that do not exist in this database
(`financial_transactions`, `compliance_findings`, `campaign_analytics`,
`crm_deals.value_kobo`) and failed only when a user clicked.

### Column types

`colText` `colInt` `colKobo` `colMoney` `colPct` `colDate` `colDateTime` `colBool`

`colKobo` divides by 100 — use it for `*_kobo` columns. **`colMoney` is for columns
already in major units**: `app.accounts` and `app.transactions` store `numeric`
naira, not kobo, which is a genuine trap in a codebase where everything else is
minor units.

### What the engine guarantees

- **No request value ever reaches the SQL string.** Columns and filters are selected
  *by key* from the registry; an unknown key is a 422, not an interpolation. Filter
  values are bound parameters.
- **Deterministic column order**, taken from the registry — not from the request, so
  a caller cannot reorder the file, and not from Go map iteration, which randomises.
- **Formula injection is neutralised** in CSV: a cell starting `=` `+` `-` `@` is
  prefixed with an apostrophe. Excel executes such a cell on open, which turns any
  customer-controlled field into code execution on whoever opens the file. XLSX
  writes typed inline strings, which are never evaluated, so it needs no escaping.
- **Every export is capped** and logged *before* the bytes stream — a download that
  dies halfway is still an attempt to move data out. A capped file sets
  `X-Export-Truncated`, and the UI warns; a truncated extract must never pass for
  the whole book.
- **PII is masked at the source.** Card PAN and BVN are last-4 only; encrypted ID
  numbers are not exportable at all. `TestExportNeverExposesRawPANorBVNorEncryptedID`
  enforces this across the whole registry.

### Formats

CSV, XLSX and JSON. The XLSX writer is `archive/zip` + `encoding/xml` in
`exportwriter.go` — about 120 lines and no third-party dependency, which matters for
an on-prem financial backend where every added module is another thing to audit and
patch. The sheet is streamed, so a 250k-row transaction export is not materialised
in memory.

---

## Reports Library

Eight fixed reports: Monthly Business, Loan Portfolio, Collections Performance,
Settlement Reconciliation, Agent Performance, Customer Statement, CBN NPL Return,
Audit Trail.

All eight already existed and worked. **No page in the workspace reached any of
them** — the module's front door was a "cross-module report builder" whose eleven
modules mapped to nothing in the backend.

The renderer is generic by design: scalars become figures, arrays become tables,
nested objects recurse. Eight hand-written layouts would drift from the handlers;
this way a report that gains a field shows it immediately instead of dropping it.

### CBN NPL Return — read this before filing

Provisions use the **CBN prudential classification**: 1% up to 90 days, 10% at
91–180, 50% at 181–360, 100% beyond 360. The report states this on its face.

This differs from what the code did before, which provisioned 1/10/50/100% on
1-30 / 31-60 / 61-90 / 90+ — treating a 61-day-late loan as Doubtful when CBN still
classifies it as Performing. Nothing has been filed on the old basis, because it read
`loan_dpd_daily_snapshot`, a table that has never had a row in it: the return printed
a correct headline NPL ratio beside ₦0 of provisions and an empty bucket table.

Buckets and provisions now derive from the live CBS book using the schedule-derived
DPD from migration 151. **Confirm the rates with Finance/Compliance against the
facility class O3 reports under before submitting.**

---

## Saved reports and scheduled delivery

Definitions live in `bi_report_definitions`; runs in `bi_report_runs`; schedules in
`bi_scheduled_reports`. Delivery runs as step 13 of the nightly batch.

Scheduled delivery had **never run once**: the runner selected `d.query_template`,
a column that does not exist, so it failed on its first query every night. Fixed in
migration 156 and `bi.go`.

There used to be a second, incompatible copy of all this — `report_configs`,
`report_schedules` and its own endpoints under `/api/reports`, with no runner behind
the schedules. It has been removed. One stack.

---

## Known gaps

- The nightly batch writes no portfolio snapshot, so all portfolio figures are
  computed live off `cbs_loans` on each request. Fine at 25 loans; revisit if the
  book grows.

---

## The empty-table review (2026-08-17)

Five tables that reports depended on were empty. Each turned out to be a different
problem, and only one was a missing job.

| Table | What was actually wrong | Fix |
|---|---|---|
| `fee_income` | Never fed. Meanwhile 1.1m card transactions carried every fee, interest and penalty posting O3 has ever made. | Retired from the reporting path. Revenue now derives from `app.income_daily`. **Revenue went from ₦0 to ₦2.93bn.** |
| `crm_deals` | Not empty by accident — the workspace never adopted the deal model. The real pipeline is `crm_contacts.lead_stage` (29,663 rows). | CRM report repointed. |
| `collections_daily_kpi` | Its own sources are empty too: no agent has logged a contact, promise or payment. Nothing to back-fill. | Built `app.rebuild_collections_daily_kpi()`, wired nightly. Runs clean, returns 0 — correct until the team starts working the queue. |
| `gl_journal_entries` | A genuine GL with no postings. Used by compliance/events/executive. | Left alone. Not something to fake. |
| `kpi_targets` | No way to enter targets, and the query couldn't have matched anyway — it compared a *window* (`this_month`) against a stored *cadence* (`monthly`). | Editor on the KPI Tracker; window→cadence mapping in the handler. |

### The income model

`app.card_txn_codes` classifies every CCS transaction code by the description the
book already carries — no invention. `app.income_daily` aggregates the fee,
interest and penalty categories.

**The trap it guards:** code `604 Total Interest` is a rollup of `600` + `601` +
`603`. Measured on this book, 604 equals the sum of its components on 85,618 of the
95,553 account-days where both appear. Summing all four nearly doubles interest
income. `counts_in_total = FALSE` on the components keeps them visible as a
breakdown without letting them into any total.

New codes auto-register as `unclassified` — visible on the rollup status endpoint,
never silently dropped from revenue. One code (`654`, blank description, 3 postings,
₦150k) is deliberately left unclassified pending confirmation from CCS.

### Two data-quality findings worth acting on

- **The card feed has gaps.** Nov 2025 has 1 transaction, Dec 2025 none, May 2026
  five. Any card figure for those months understates reality. The KPI history now
  returns `data_complete` per month and the tracker charts a gap rather than a zero
  — a revenue chart plotting ₦0 says "we earned nothing" when the truth is "we have
  no data".
- **`customers.account_created` stopped being populated on 2025-07-09.** New
  customers are now counted from `accounts.opened_date` (current to 2026-08-25),
  grouped by each CIF's *earliest* account, so a customer taking a second card is
  not counted twice.
- **No CSAT responses exist at all** (36k tickets, 0 scores). The CSAT KPI is
  honest about this rather than showing 0.0.

## Reports (13)

Grouped by product line: Revenue · Cards · Customers · Credit · Fixed Deposits ·
Collections · Service · Operations · Compliance.

Five were added in this review because O3 is a three-product business and the
library only covered credit: **Income & Revenue**, **Card Portfolio** (20,620
accounts — the largest product line, previously with no report at all), **Customer
Acquisition**, **Service Performance** (36k tickets, 110k calls), and the **Fixed
Deposit Book** with the maturity ladder treasury needs.

Every one is executed against the live database by `TestBusinessReportsRunLive`,
which asserts on values rather than shape — a report reading a missing table and a
report reading an empty one both render as a blank page, and only value assertions
tell them apart.
