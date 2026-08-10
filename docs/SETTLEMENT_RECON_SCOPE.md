# Settlement & Reconciliation — Module Scope

**Status:** agreed scope, build in progress · **Date:** 2026-08-05 · **Owner:** Temitope

Sections 1–4 are *what is actually there today*, verified against the running
database, the code on `main`, and the live Paystack account — not against the spec.
Section 5 onward is the agreed build.

---

## 1. The aim, and why it isn't met

The module has to serve **two** jobs. It currently does neither.

**Operations — do the day's work.** Import the feed → match → work the exception
queue → resolve with a reason → sign off the day → escalate what's aged. Today
there is no run log, no sign-off, no reason codes, no aging, no assignment. Nobody
can complete a day's work in this module.

**Reporting — see the position.** In/out by channel, net settlement position,
float, unreconciled value and its age, suspense. Today the Overview reads a table
of zeros.

Ten nav entries, neither job done. The failure isn't "some pages are empty" — it's
that the module was built as a set of screens rather than as a settlement cycle.

---

## 2. Data reality — verified

```
LIVE  Paystack API          transfers out 23,909 · funding in 6,699
                            settlements 561 · float ₦17,957,472 · disputes 1
LIVE  app.interswitch_txns      50,115   uploaded EOD, 99.9% dated 2025
LIVE  app."Transactions"     1,023,947   Sage ledger
LIVE  app.cbs_loans / cbs_fixed_deposits   66 / 189   (Udara)

EMPTY app.settlement_batches         0
EMPTY app.settlement_exceptions      0
EMPTY app.manual_postings            0
EMPTY app.gl_accounts                0    ← no chart of accounts
EMPTY app.gl_journal_entries         0    ← no GL postings, ever
EMPTY app.loan_repayments / repayment_instalments / recovery_payments / cc_statements   0
NONE  app.eod_transactions / eod_uploads   tables do not exist
NONE  any paystack_* table                 no local mirror of the busiest rail
```

**Credentials:** `PAYSTACK_SECRET_KEY` is set in `backend-go/.env` and
`resolvePaystackKey` reads env before the DB — Paystack **is** live. The blank
`api_credentials` row is an unused placeholder. Interswitch has no key in env or
DB, so Interswitch is genuinely **upload-only** (as its code comment states).

### Paystack — the busiest rail, and it is not stored anywhere

| | Count | Detail |
|---|---|---|
| Transfers out (app transfers) | **23,909** | 23,860 success · **49 failed** · 1 reversed |
| Funding in (card / transfer) | **6,699** | 2,957 success · **182 failed** · **3,554 abandoned** · 6 reversed |
| Settlements to bank | 561 | |
| Float held at Paystack | **₦17,957,472** | |
| Disputes | 1 | |
| Paystack customers | 1,014 | |

Two things fall out of this:

1. **55% of funding attempts never complete** (3,554 abandoned vs 2,957 success).
   That is a product and revenue finding sitting in an API nobody reads.
2. **Outbound transfers carry `session.provider = "nip"` and a NIP session ID**,
   and inbound funding arrives on `channel = "bank_transfer"`. A real slice of NIP
   activity is therefore already visible — through Paystack, not NIBSS.

Every Paystack page in the workspace calls the live API with pagination and throws
the result away. No history, no trend, no aging, no queue that survives a refresh,
nothing local to reconcile against — and the Overview makes two blocking API calls
with an 8-second timeout on every load.

### Interswitch ↔ Sage — reconcilable today

Every Interswitch row carries `cif`, `account_no` and `trace_num` (0 blanks) across
1,505 CIFs, so `CIF Number` joins into Sage. On 2025's 50,076 rows:

| Tier | Rule | Rows | % |
|---|---|---|---|
| 1 | Exact — CIF + date + amount | 33,024 | 65.9% |
| 2 | + date tolerance ±3 days | 33,620 | 67.1% |
| — | **Unmatched** | **16,456** | **32.9%** |

Tolerance buys +596 rows, so the unmatched third is not a timing problem. Its
shape: CR/402 alone is 7,086 rows and ₦2.17bn — a systematic booking difference
(netting, suspense, or a different CIF on the ledger side). **Understanding code
402 is the highest-value single question in this module.**

---

## 3. The structural problem

**Nothing in the codebase ever writes a settlement batch or an exception.**
`INSERT INTO settlement_batches` appears once (`soaBatchCreate`), reachable only by
manually POSTing a batch header. There is no `INSERT INTO settlement_exceptions`
anywhere. The tables came from migration `044_finance_ops.sql` and have never been
fed.

**One table backs four pages.** `settlement_exceptions` is read as batch-contents
(`:190`), NIP entries (`:278`), exceptions (`:886`) and failed transactions
(`:375`), with `status` overloaded (`resolved`→"Matched", `escalated`→"Exception")
and UI columns — `customer_name`, `generated_by`, `retry_count` — hardcoded as SQL
literals. Loading data in would show the same rows on four pages under four labels.

This is not a data-loading problem. **The schema does not model the domain.**

---

## 4. Confirmed defects

| # | Sev | Defect |
|---|---|---|
| D1 | High | `App.tsx:937-939` guard the three Interswitch routes with `page="settlements"` (plural). No role has that key — canonical is `"settlement"` (`core/auth.go:470`). `settlement_officer`, `head_of_reconciliation` and `finance_head` are **redirected home** from links the sidebar shows them. Only MGMT bypasses. |
| D2 | High | `/api/cards/interswitch` has **no page guard** (`main.go:404`). Any authenticated user can `POST .../import` and ingest an EOD file. The sidebar restricts the page to `cards_ops_head`; the API does not. |
| D3 | High | `eod_transactions` / `eod_uploads` do not exist. `eodTotalsForPeriod` (`reconciliation.go:198`) swallows the error and returns zeros, so Interswitch recon **silently reports the entire uploaded volume as a delta**. The whole `/api/eod` module (14 queries) hits these missing tables. |
| D4 | Med | Manual Postings writes double-entry to `gl_journal_entries` against a `gl_accounts` table with **zero rows** — accounts are free text validated against nothing. |
| D5 | Med | Credit/Debit derived by string-comparing `dr_account='SUSPENSE'` (`:506`) — magic string, not a column. |
| D6 | Low | `044_finance_ops.sql` constrains `manual_postings.status` to `pending/approved/rejected`, but handlers write `posted` and `returned`. |

D1 and D2 are independent of the redesign and are fixed in Phase A.

---

## 5. Page verdicts

| Page | Verdict | Why |
|---|---|---|
| Batches | **Rebuild as Runs & Imports** | The *concept* is essential — the unit of the settlement cycle and the audit artifact ("who reconciled 4 Aug, what was left open"). The *page* is a manually-typed header with no contents whose drill-down reads exceptions. Your EODTXN import already **is** a batch; it just isn't recorded as one. |
| NIP Reconciliation | **Merge into Workbench** | The need is real — matching inbound credits to obligations, because unmatched inflows are customers who paid but aren't credited. There is no NIBSS feed, but Paystack exposes a genuine NIP slice (`bank_transfer` in, `session.provider=nip` out). Serve that; don't keep an empty page. |
| NIP Batch Exceptions | **Delete** | Exceptions are a *filter* of the recon view, not a second nav item. |
| Failed Transactions | **Keep — and feed it** | Real and live: 49 failed transfers, 182 failed fundings, 6 reversals, 1 dispute. Every one is a customer whose money moved wrong. |
| Processor Reconciliation | **Split** | Paystack is live and belongs in the Workbench + Position. The Interswitch tab is upload-based and stays. |
| Manual Postings | **Move to Finance** | Genuine need, good maker-checker, but it is a Finance tool and it writes GL against an empty chart of accounts. |
| Interswitch / Transaction Report / Import EODTXN | **Keep** | The only three that work today. They live in `pages/cards/` and are mis-guarded (D1). |

**Ten nav entries → six**, every one with data behind it.

### Target structure

**Operations**
1. **Recon Workbench** — source + period → matched / unmatched / exceptions, reason codes, aging, assignment, daily sign-off
2. **Exceptions & Failures** — one queue for failures, reversals and disputes, with retry / refund / escalate
3. **Runs & Imports** — EOD imports + Paystack sync runs: who, when, counts, status

**Reporting**
4. **Settlement Position** — float, settlements to bank, in/out by channel, net, unreconciled value + age
5. **Funding Funnel** — the 55% abandonment, by channel over time
6. **Transaction Report** — exists, works, keep

---

## 6. Wiring — where recon output has to land

Reconciliation that stays inside the settlement module is worthless.

| Destination | What it gets |
|---|---|
| **Helpdesk / Customer Service** | Failed and abandoned fundings — those 182 customers are calling you |
| **Customer 360** | Per-customer funding, transfers and whether they reconciled (join on CIF / email / phone) |
| **Cards** | The Interswitch feed *is* card activity — Cards and Settlement read the same table today unaware of each other |
| **Finance** | Float, settlements to bank, suspense as a balance-sheet item |
| **Collections** | A matched inflow should discharge an obligation, or you chase people who already paid |
| **CBS / Udara** | Ledger of record for anything touching a loan or FD |
| **Executive / Reports** | Daily settlement report |

---

## 7. Build plan

The mobile-app wallet ledger will become readable **later, not now**. The recon
model is therefore built with an explicit *source ↔ counterparty* abstraction so
the wallet ledger drops in as one more counterparty with no rework.

**Build status (2026-08-05):** Phases A–D are built. A: route-guard and API-guard
fixes plus an honest `ledger_available` flag. B: `124_paystack_mirror.sql` +
`paystacksync` + worker + endpoints — 31,171 records mirrored, incremental syncs
running on schedule. C: `125_recon_engine.sql` + `recon` + 9 endpoints — **78.4%
matched** on the 2025 book in ~7s, strict 1:1. D: Recon Workbench, Exceptions &
Failures, Settlement Position, Runs & Imports, sidebar restructured 10 → 8 entries,
and Customer 360 wired to payment history. Remaining: Helpdesk / Cards / Finance
wiring, and the Phase E items below.

**Identity caveat found while wiring Customer 360:** email is NOT unique in the
Accounts master — 855 addresses map to more than one CIF, and the worst are staff
addresses used as onboarding placeholders (`apinheiro@o3cards.com` on 37 CIFs).
`/api/paystack/customer` therefore refuses ambiguous identities and returns
`identity: "ambiguous"` with no rows, rather than attributing one customer's money
to another. Same failure mode as the phone-as-name bug in
`docs/CUSTOMER_DATA_MODEL.md`.

### Phase A — Fixes (independent, first)
- D1: `settlements` → `settlement` in the three route guards
- D2: page guard on `/api/cards/interswitch`, import restricted further
- D3: make the Interswitch delta honest rather than comparing against a phantom table

### Phase B — Paystack mirror (the foundation everything sits on)
- Migration `122_paystack_mirror.sql`: `paystack_transactions`, `paystack_transfers`,
  `paystack_settlements`, `paystack_disputes`, `paystack_sync_runs`
- `backend-go/paystacksync` package, modelled on the proven `cbssync`: newest-first
  pagination with a trailing re-pull window so status transitions
  (pending→success/failed, reversals) land
- Scheduled worker + `POST /api/paystack/sync` / `GET /api/paystack/sync/status`

*Until this exists, nothing else in the module can be built — there is no local
Paystack data to reconcile, age, queue or report on.*

### Phase C — Recon engine
- `recon_runs` / `recon_matches` / `recon_exceptions`, modelled as **one source
  reconciled against one counterparty for one period**
- Tiered matcher (exact → tolerance → fuzzy) recording tier and confidence, so an
  operator can see *why* two rows were paired
- First pair: Interswitch EOD ↔ Sage `Transactions` (66% today). Investigate code
  402 before finalising rules
- Retires the `settlement_exceptions`-serves-four-pages arrangement

### Phase D — Pages
Workbench, Exceptions & Failures, Runs & Imports, Settlement Position, Funding
Funnel — built on Phase B/C, plus the wiring in section 6.

### Phase E — Later / blocked
- **Mobile wallet ledger** ↔ Paystack: plugs into Phase C as a counterparty
- **Bank statement / NIBSS feed**: the third leg (processor ↔ bank ↔ ledger)
- **GL**: seed a chart of accounts, or drop the journal write from Manual Postings

---

## 8. Open questions

1. **Interswitch txn code 402** — ₦2.17bn of unmatched credits turns on this.
2. **GL** — real chart of accounts in the workspace, or management-accounts-only
   reconciled against Udara?
3. **Ledger of record** — Sage `Transactions` now; does it become Udara/CBS once
   card balances sync there?
