# Credit-Card Cycle Close — GL Posting Design (for sign-off)

**Status:** DESIGN ONLY — no posting code has been written. Nothing posts to the GL until this is approved.
**Author:** Claude (Opus 4.8), 2026-08-03
**Decision requested from:** Finance / whoever owns the chart of accounts

---

## 1. Purpose

When a credit-card billing cycle closes, the four Udara cycle reports
(`cyc_bal / cyc_chg / cyc_int / cyc_loc`) are imported into `card_cycle_data`. The
charge report already tells us, **per account, for that cycle**, how much interest, fees,
penalty, purchases and cash-advance were applied. Today none of this is recognised in the
general ledger — it lives only as a data snapshot. This design defines the double-entry
journal entries that recognise **revenue** (interest, fees, penalty) at cycle close.

Scope of this document: **income recognition only** (interest, fees, penalty). Purchases,
cash-advance settlement and cardholder payments are noted in §6 as out of scope for now.

## 2. The event

- **Trigger:** an operator runs *Cards → Import Cycle Data*, then explicitly clicks
  **Close Cycle & Post** (a separate, gated action — import alone posts nothing).
- **Grain:** one GL posting run per `cycle_date`, aggregated per product (not per account),
  to keep the journal readable — 18,500 accounts → a handful of summary entries.
- **Idempotency:** a `card_gl_postings` ledger records `(cycle_date, product_code, kind)`
  with a UNIQUE constraint. Re-running a already-posted cycle is a no-op (or requires an
  explicit reversal first). This prevents double-posting the same cycle.

## 3. Journal entries (per product, per cycle)

Amounts are summed from `card_cycle_data` for the cycle, filtered to
`card_products.category = 'credit'`.

| # | Economic event | Debit | Credit | Amount (kobo) |
|---|---|---|---|---|
| 1 | Interest earned on card balances | `card_receivable` | `interest_income` | `SUM(interest_charged_kobo)` |
| 2 | Fees billed to cardholders | `card_receivable` | `fee_income` | `SUM(fees_kobo)` |
| 3 | Penalty/late charges billed | `card_receivable` | `penalty_income` | `SUM(penalty_kobo)` |

Rationale: interest/fees/penalty **increase what the cardholder owes** (an asset —
card receivable) and are recognised as **revenue**. This mirrors the existing loan-side
convention (`DR receivable / CR income`) already used elsewhere in `postJournal`.

Each entry carries `source_type = 'card_cycle'`, `source_id = <cycle posting id>`,
`reference = 'CC-<cycle_date>-<product>-<kind>'`, so it is traceable back to the import.

> **Note on which interest field:** `cyc_int_rpt` (`total_interest_kobo`) and
> `cyc_chg_rpt` (`interest_charged_kobo`) matched exactly in the 2026-07-14 sample.
> The design uses `interest_charged_kobo` from the charge report; if they ever diverge,
> the charge report is authoritative for GL. **Please confirm.**

## 4. Account mapping — NEEDS YOUR INPUT

⚠️ **Blocker:** the `gl_accounts` chart-of-accounts table is currently **empty**, and the
existing code posts to a **mix** of numeric codes (`1001`, `1100`, `5200`) and named labels
(`cash`, `fixed_deposits_liability`, `card_liability`, `dispute_suspense`). There is no
single source of truth for account codes.

Before any card-interest posting goes live, I need the **real GL account codes** for:

| Placeholder used above | What it is | Your account code? |
|---|---|---|
| `card_receivable` | Card receivables control (asset) | ? |
| `interest_income` | Card interest income (revenue) | ? |
| `fee_income` | Card fee income (revenue) | ? |
| `penalty_income` | Penalty/late-fee income (revenue) | ? |

Recommended companion cleanup (separate task): seed `gl_accounts` with the full chart so
every posting validates against a real account instead of free-text labels.

## 5. Safety: dry-run preview first

Even after sign-off, the flow will be:

1. **Preview (dry-run):** compute and display the exact journal lines + totals for the
   cycle, **without** writing to `gl_journal_entries`. Operator eyeballs against the report
   totals (the importer already returns per-report sums).
2. **Post:** only on a second explicit confirm; writes entries inside a single transaction
   and records the `card_gl_postings` idempotency row.
3. **Reverse:** a guarded action that posts equal-and-opposite entries and clears the
   idempotency row, for corrections.

## 6. Explicitly out of scope (flag for later decision)

- **Purchases / cash-advance settlement** — these move money to merchants/acquirers; the
  GL treatment depends on how settlement is funded (not in the cycle reports). Deferred.
- **Cardholder payments** — reduce the receivable (`DR cash / CR card_receivable`); belongs
  to a payments feed, not the cycle close. Deferred.
- **Opening the receivable control to equal Σ outstanding balances** — a reconciliation
  concern; worth doing but separate from income recognition.

## 7. What I will build once §4 is answered and this is approved

1. `card_gl_postings` idempotency table (numbered migration).
2. `POST /api/cards-credit/cycle/{cycle_date}/preview` → dry-run journal (no writes).
3. `POST /api/cards-credit/cycle/{cycle_date}/post` → transactional posting + idempotency.
4. `POST /api/cards-credit/cycle/{cycle_date}/reverse` → guarded reversal.
5. UI: a "Close Cycle & Post" panel on the Credit Card Portfolio page with the
   preview → confirm → posted states.

**No code from this list is written yet.** Awaiting: (a) the four account codes in §4,
(b) confirmation of the interest field in §3, (c) go-ahead on the approach.
