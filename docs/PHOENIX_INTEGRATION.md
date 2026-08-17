# Phoenix ↔ Workspace Integration

Phoenix is O3's **credit decisioning** system. The workspace originates, reviews and
reports; Phoenix decides.

This document is the contract. The workspace side is built and inert until configured —
Phoenix's side should be built against what is written here.

---

## The model

An application can start in either system.

```
                    ┌──────────────────────────────────────────┐
  raised in         │  POST {PHOENIX_BASE_URL}/applications    │
  workspace  ──────▶│  (queued + retried by a background       │──────▶  Phoenix
                    │   worker, never called inline)           │
                    └──────────────────────────────────────────┘

                    ┌──────────────────────────────────────────┐
  raised in         │  POST {WORKSPACE}/api/phoenix/webhook    │
  Phoenix    ──────▶│  HMAC-SHA256 signed, idempotent by       │──────▶  Workspace
  or decided        │  event_id                                │         risk queue
                    └──────────────────────────────────────────┘
```

**Ownership.** Phoenix owns an application once it has been submitted. After hand-off
the workspace mirrors decision and status; it does not re-decide locally.

**A decision is not an approval.** `phoenixApplyDecision` deliberately does **not**
advance the LOS stage. Stage transitions are role-gated in `handlers/los.go`, and
Phoenix recommending `approve` is not the same as a risk head approving it. The
decision informs the human review; it does not replace it.

---

## Configuration

Set in `backend-go/.env`. The integration is completely inert until these exist, so it
ships safely before Phoenix is deployed.

| Variable | Purpose |
|---|---|
| `PHOENIX_BASE_URL` | Outbound API root, e.g. `http://127.0.0.1:9200/api/v1` |
| `PHOENIX_API_KEY` | Sent as `Authorization: Bearer …` on outbound calls |
| `PHOENIX_WEBHOOK_SECRET` | HMAC-SHA256 key Phoenix signs inbound events with |
| `PUBLIC_BASE_URL` | Used to build the `callback_url` we hand Phoenix |

> **Editing `.env` on this server:** use `sed`, never PowerShell `Set-Content -Encoding utf8`.
> That writes a BOM and the backend refuses to start.

Behaviour when unset:

- No `PHOENIX_BASE_URL` / `PHOENIX_API_KEY` → the outbox still **fills**, the worker
  idles. Nothing is lost; it drains once configured.
- No `PHOENIX_WEBHOOK_SECRET` → the webhook returns **503**, rather than accepting
  unauthenticated writes into the risk queue.

---

## Outbound: workspace → Phoenix

**Trigger.** An application advancing into the `risk_review` stage. Documents have been
collected by then, so it is the first point the application is complete enough to
decide on. Phoenix-originated applications are skipped.

**Delivery.** Queued in `app.phoenix_outbox` and drained by `StartPhoenixOutboxWorker`
every 30s. Never called inline — a Phoenix restart or a slow decision must not fail a
risk officer's click.

- One live job per application (partial unique index), so a double-click cannot submit twice.
- Backoff `2^attempts` minutes, capped at 1 hour, max 6 attempts.
- **4xx is abandoned immediately** — a rejected payload will never succeed on retry, and
  burning six attempts just delays the operator finding out. 408/429/5xx retry.
- `Idempotency-Key: wsapp-{application_id}` so Phoenix can collapse a retried submission.

### `POST {PHOENIX_BASE_URL}/applications`

```json
{
  "external_id": "1234",
  "reference": "LA-1234",
  "applicant_name": "Ada Obi",
  "applicant_cif": "00000420",
  "phone": "08010000000",
  "email": "ada@example.com",
  "employer": "Acme Ltd",
  "product_type": "SME LOAN",
  "amount_requested_kobo": 5000000000,
  "tenor_months": 6,
  "monthly_income_kobo": 900000000,
  "monthly_obligation_kobo": 120000000,
  "interest_rate_bps": 2400,
  "sector_code": "41000",
  "purpose": "Working capital",
  "callback_url": "https://workspace.o3ccards.com/api/phoenix/webhook"
}
```

`external_id` is the workspace `loan_applications.id`. Amounts are **kobo** (integers).

**Response.** Either decide synchronously and return a decision body (below), or
acknowledge with just `{"phoenix_id": "..."}` and send `decision.completed` later.
Both paths are supported and converge on the same code.

---

## Inbound: Phoenix → workspace

### `POST {WORKSPACE}/api/phoenix/webhook`

Headers:

```
Content-Type: application/json
X-Phoenix-Signature: sha256=<hex HMAC-SHA256 of the RAW request body, keyed with PHOENIX_WEBHOOK_SECRET>
```

The `sha256=` prefix is optional; the hex digest is compared case-insensitively in
constant time. The signature is over the **raw body bytes** — sign before any
re-serialisation.

Envelope:

```json
{
  "event_id": "evt_01H…",
  "event_type": "application.created",
  "phoenix_id": "PHX-9001",
  "data": { }
}
```

**`event_id` must be unique and stable across retries.** It is recorded in
`app.phoenix_events` before processing; a redelivery is acknowledged with
`{"ok":true,"duplicate":true}` and not reprocessed, so a replayed decision cannot
overwrite a newer one.

**Responses:** `200` processed · `401` bad signature · `422` malformed ·
`500` processing failed — **retry this one**, the event ledger entry is rolled back so
the retry is not treated as a duplicate · `503` webhook not configured.

### `event_type: application.created` / `application.updated`

`data` is the application. Sparse payloads are safe — every field is COALESCEd, so an
`updated` event carrying only what changed will not blank fields already held.

```json
{
  "phoenix_id": "PHX-9001",
  "reference": "PHX-9001",
  "applicant_name": "Ada Obi",
  "applicant_cif": "00000420",
  "phone": "08010000000",
  "email": "ada@example.com",
  "employer": "Acme Ltd",
  "product_type": "SME LOAN",
  "amount_requested_kobo": 5000000000,
  "tenor_months": 6,
  "monthly_income_kobo": 900000000,
  "sector_code": "41000",
  "purpose": "Working capital",
  "status": "submitted",
  "stage": "risk_review",
  "submitted_at": "2026-08-17T09:00:00Z",
  "decision": null
}
```

Defaults when omitted: `reference` → `PHX-{phoenix_id}`, `status` → `submitted`,
`stage` → `risk_review`, `product_type` → `Unspecified`.

`decision` may be embedded to create-and-decide in one event.

A genuinely new application notifies `risk_officer` / `risk_head`, **grouped** under
`phoenix_new_applications` so a batch push is one alert rather than one per row. An
`updated` event for a row already held does not re-alert.

### `event_type: decision.completed`

```json
{
  "phoenix_id": "PHX-9001",
  "decision": "decline",
  "score": 412,
  "rating": "High-Risk",
  "dti_pct": 61.4,
  "bureau_summary": "3 active facilities, 1 in arrears",
  "report_id": "PHXR-77",
  "decline_reason": "DTI above policy",
  "reasons": [{ "factor": "DTI", "impact": -22 }],
  "decided_at": "2026-08-17T09:05:00Z"
}
```

| Field | Notes |
|---|---|
| `decision` | `approve` \| `decline` \| `refer` \| `pending` |
| `score` | The **Eye Score**. Bureau-style scale (the App Review UI colours on 700/500). |
| `rating` | `Prime` \| `Near-Prime` \| `Sub-Prime` \| `High-Risk` |
| `reasons` | Free-form JSON, stored verbatim so a decline can be explained without a round-trip |

A `decision.completed` for an unknown `phoenix_id` returns **500** rather than being
dropped — Phoenix should send `application.created` first, and a decision falling on
the floor is worse than a retry.

> **Two scales, do not merge them.** The Eye Score above is bureau-style. The workspace
> *also* derives a 0–100 risk score from repayment behaviour on the live Udara book
> (`app.cbs_risk_score_dpd`, bands A–E). Different things, different pages —
> `frontend/src/lib/riskScale.ts` covers only the CBS-derived one.

---

## Where the data lands

Phoenix decisions populate columns the origination schema **already had** for exactly
this purpose (they were present and unused long before Phoenix): `eye_score`,
`eye_rating`, `dti_pct`, `bureau_summary`, `eye_report_id`, `decline_reason`. So
**App Review** and the **Eye Score** page are already the Phoenix front-end — no new
screens were needed.

Added by migration 153 for provenance and sync state only:

| Column | Meaning |
|---|---|
| `source_system` | `workspace` \| `phoenix` |
| `phoenix_id` | Phoenix's id — the correlation key (partial unique index) |
| `phoenix_sync_state` | `pending` \| `sent` \| `decided` \| `failed` \| `not_required` |
| `phoenix_submitted_at`, `phoenix_synced_at`, `phoenix_error` | Submission audit |
| `decision`, `decision_at`, `decision_reasons` | The verdict and its factor breakdown |

Tables: `app.phoenix_outbox` (outbound queue), `app.phoenix_events` (inbound
idempotency ledger).

> **Schema gotcha for anyone editing the upsert:** `idx_loan_applications_phoenix_id` is
> a **partial** unique index, so `ON CONFLICT (phoenix_id)` must repeat the predicate
> `WHERE phoenix_id IS NOT NULL` or it fails at runtime. Also `product_type`,
> `amount_requested_kobo` and `tenor_months` are `NOT NULL` with no default.

---

## Operating it

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/phoenix/status` | risk read | Config flags (never the key), outbox counts, unprocessed events |
| `POST /api/phoenix/applications/{id}/submit` | risk read | Queue a submission by hand |
| `POST /api/phoenix/retry` | `risk_head` | Requeue everything failed/abandoned |

The worker reports into **Admin → Sync & Workers** as `phoenix_outbox`, with the retry
endpoint wired to its "Sync now" button.

Notification events, tunable in **Admin → Notification Settings** (migration 154):
`loan_application_received` (in-app on, email off — grouped) and
`loan_decision_received` (in-app + email on; declines and referrals raised to high
priority).

---

## Testing before Phoenix exists

`handlers/phoenix_test.go` covers signature verification (including tampered bodies and
the prefix forms), the retry-permanence policy, and config gating.

To exercise the webhook end to end:

```bash
SECRET='your-webhook-secret'
BODY='{"event_id":"evt-test-1","event_type":"application.created","phoenix_id":"PHX-TEST-1","data":{"phoenix_id":"PHX-TEST-1","applicant_name":"Test Borrower","product_type":"SME LOAN","amount_requested_kobo":5000000000,"tenor_months":6}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')

curl -sS -X POST http://localhost:8000/api/phoenix/webhook \
  -H 'Content-Type: application/json' \
  -H "X-Phoenix-Signature: sha256=$SIG" \
  -d "$BODY"
```

Send it twice — the second must return `"duplicate": true`.
