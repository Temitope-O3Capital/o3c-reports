# Customer / Contact Data Model — Source of Truth

_Last audited: 2026-08-04. Purpose: there are ~8 tables/views whose names mention
contact/customer/account. This document records which is authoritative so we stop
re-litigating it and stop pulling identity from the wrong (dirtier) store._

## TL;DR

- **Customer identity → `app."Accounts"` (view).** ~19.6k real customers. This is
  the single source of truth for name / phone / email / state / employer / DOB.
- **Cards & product holdings → `app."Products"` (view).** ~20k rows; also carries
  `Name On Card` (a useful name fallback).
- **CRM / leads → `crm_contacts` (table).** ~29.6k rows — a **superset** that
  includes prospects/leads and is **dirtier** (some rows have the phone number
  stuffed into the name field). Use it for CRM/BD/leads context **only**, never as
  the identity master. When augmenting a customer with CRM data, fill gaps —
  do not overwrite `Accounts` identity. (See `handlers/contacts.go`.)
- **Transactions → `transaction` (table).** Imported from MSSQL (`mssql_baseline`).
  Credits are stored as NEGATIVE amounts with `money_in = true`; trust `money_in`
  for direction, not the sign.

## The pipeline (do NOT drop — it feeds the app views)

```
src.contact ─┐
             ├─► core.customer ─┬─► app."Accounts"   (identity)
src.account ─┤                 └─► app."CIF Table"   (cohort dates; used in helpdesk.go)
             └─► core.account ───► app."Products"    (cards)
```

`src.*` = raw import (staging) · `core.*` = cleaned/canonical · `app.*` = views the
Go backend reads. Dropping any `src`/`core` layer breaks the `app` views.

## Retirement audit (backend usage as of 2026-08-04)

| Object | Rows | Referenced in repo? | Verdict |
|---|---|---|---|
| `app."Accounts"` (view) | 19,578 | yes (16 files) | **keep — identity SoT** |
| `app."Products"` (view) | 19,994 | yes | **keep — cards** |
| `app."CIF Table"` (view) | 19,578 | yes (helpdesk.go) | keep |
| `crm_contacts` | 29,663 | yes (21 files) | **keep — CRM/leads only** |
| `src.contact`, `src.account` | ~20k | via views | **keep — ETL input** |
| `core.customer`, `core.account` | ~20k | via views | **keep — feeds app views** |
| `zoho_customer_master` | 19,614 | **no references anywhere** | orphan — likely fed by an external Zoho sync; archive (rename) rather than hard-drop if retiring |
| `core.v_customer`, `core.v_account` | views | no | unused convenience views — droppable |
| `core.v_data_quality`, `core.v_orphan`, `core.v_transaction` | views | no | unused by app but useful data-QA views — keep |
| `campaign_contacts`, `collection_contacts`, `telemarketing_contacts` | 0–3 | yes | keep — wired, just no data yet |

**Decision (2026-08-04):** document only; no schema changes. The redundancy is
mostly a legitimate `src → core → app` pipeline, and `zoho_customer_master` may
have an external writer, so nothing was dropped.
