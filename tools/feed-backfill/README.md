# Sage → `feed.*` backfill (one-time historical seed)

Seeds the owned `feed.*` schema in Postgres from Sage (`Production_ED`), after which the
repo/folder drops feed it and Sage is no longer read. See `docs/DATA_FEED_INGESTION.md`.

## What was ported (2026-08-06)

| Table | Rows | Source | Notes |
|---|--:|---|---|
| `feed.customers` | 21,006 | `dbo.Contact` | 19,663 real (numeric CIF, deduped, trimmed, emails lowercased) + **1,343 inferred stubs** (`source='sage_inferred'`) for CIFs referenced by accounts/txns but absent from Contact (mostly prepaid/Blink CIF space) |
| `feed.accounts` | 20,589 | `dbo.Account` | keyed by `Number_`; `product_line` derived; balances → kobo |
| `feed.card_products` | 25 | derived | distinct product → line + account_count |
| `feed.transactions` | 56,586 | `dbo.Transaction_Listing` | **Jan 1 – Sep 30 2025 only**; Oct 2025→ comes from the repo |

## Transaction cutoff — why Sept 2025

Sage transaction data has **complete daily coverage Jan 1 → Oct 26 2025** then falls off a
cliff (Nov–Dec 2025 ≈ empty — the card system cut over off Sage). We port through
**Sep 30 2025** (clean month-end) and take Oct-onward from the repo/folder feed.
Verified: **273/273 days present, 0 gaps.**

## Cleaning applied

- Dropped non-numeric / empty CIF rows (junk, e.g. the `0000000\`` corruption).
- Trimmed all text; emails lowercased; 35 malformed emails (no `@`) nulled.
- Amounts naira → **kobo** (bigint); dates parsed as ISO.
- `channel` derived from `Transaction_Code` (interswitch / collection / internal).
- Own key: `id` identity + `dedup_key='sage:<Transaction_Listing_Id>'` (unique) +
  `sage_txn_id` cross-ref. (`Transaction_Listing_Id` is 100% unique; the composite
  `cif+dates+code+amount+trace` is NOT — 156 collisions — so it can't be the key alone.)
- FKs enforced: `accounts.cif` and `transactions.cif` → `customers.cif` (0 orphans).

## Post-load verification (all pass)

0 null amounts · 0 non-numeric CIFs · 0 null dates · 0 invalid channels · 0 duplicate
`dedup_key` · unique `sage_txn_id` · 0 orphan CIFs · 0 malformed emails · 273/273 days.

## Files

- `schema.sql` — the `feed.*` DDL (idempotent).
- `extract.ps1` — reads Sage read-only, writes cleaned CSVs (one-time; Sage decommissioned after).
- Load = `\copy` CSVs, then stub/email/FK cleanup.

## Reproduce / extend

1. `psql "$DATABASE_URL" -f schema.sql`
2. `powershell -File extract.ps1` (needs LAN access to `dbsvr01`, read-only)
3. `\copy` each CSV into `feed.*`; run the stub + FK cleanup.
