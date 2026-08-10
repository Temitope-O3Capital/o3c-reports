// Package paystacksync mirrors the live Paystack account into local snapshot
// tables (paystack_transactions, paystack_transfers, paystack_settlements,
// paystack_disputes).
//
// Paystack is O3's busiest settlement rail — mobile-app funding in, app transfers
// out — but the workspace held no local copy of it: every page called the live API
// with pagination and discarded the result. That left no history, no aging, no
// exception queue surviving a refresh, and nothing local to reconcile against.
//
// Paystack remains the system of record. These tables are written ONLY by this
// worker and refreshed by upsert (never truncated), so historical rows survive
// even when they age out of a sync window. All monetary columns are kobo.
package paystacksync

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/o3c/reports/core"
)

const (
	apiBase = "https://api.paystack.co"
	// perPage is Paystack's practical page ceiling for list endpoints.
	perPage = 100
	// overlapWindow is re-pulled on every incremental run so records whose status
	// changes after creation (pending→success/failed, reversals, dispute updates)
	// are picked up rather than frozen at their first-seen state.
	overlapWindow = 72 * time.Hour
	// pageDelay paces requests so a backfill does not trip Paystack rate limits.
	pageDelay = 120 * time.Millisecond
	// maxPages is a runaway guard, not an expected limit (~240 pages of transfers today).
	maxPages = 2000
)

// Result summarises one sync run.
type Result struct {
	Transactions int
	Transfers    int
	Settlements  int
	Disputes     int
	// Watermark is the oldest record timestamp this run reached back to.
	Watermark time.Time
}

var httpClient = &http.Client{Timeout: 30 * time.Second}

// SyncAll mirrors all four resources, recording an audit row in paystack_sync_runs.
// kind is "scheduled", "manual" or "backfill"; a "backfill" ignores the watermark
// and walks the full history.
func SyncAll(ctx context.Context, db *core.DB, secret, kind string, triggeredBy sql.NullInt64) (Result, error) {
	var res Result
	if secret == "" {
		return res, fmt.Errorf("paystack sync: PAYSTACK_SECRET_KEY not configured")
	}

	var runID int64
	if err := db.PG.QueryRowContext(ctx,
		`INSERT INTO paystack_sync_runs (kind, status, triggered_by) VALUES ($1, 'running', $2) RETURNING id`,
		kind, triggeredBy).Scan(&runID); err != nil {
		return res, fmt.Errorf("paystack sync: open run: %w", err)
	}

	watermark := time.Time{}
	if kind != "backfill" {
		watermark = lastWatermark(ctx, db)
	}
	res.Watermark = watermark

	res, err := doSync(ctx, db, secret, watermark)
	res.Watermark = watermark
	if err != nil {
		_, _ = db.PG.ExecContext(ctx,
			`UPDATE paystack_sync_runs SET finished_at = NOW(), status = 'error', error = $2 WHERE id = $1`,
			runID, err.Error())
		slog.Error("paystack sync failed", "run_id", runID, "err", err)
		return res, err
	}

	_, _ = db.PG.ExecContext(ctx,
		`UPDATE paystack_sync_runs SET finished_at = NOW(), status = 'ok', watermark = $2,
		     transactions_n = $3, transfers_n = $4, settlements_n = $5, disputes_n = $6
		 WHERE id = $1`,
		runID, nullTime(watermark), res.Transactions, res.Transfers, res.Settlements, res.Disputes)
	slog.Info("paystack sync ok", "run_id", runID, "transactions", res.Transactions,
		"transfers", res.Transfers, "settlements", res.Settlements, "disputes", res.Disputes)
	return res, nil
}

// lastWatermark returns the start of the last successful run, less the overlap
// window. Zero time (full history) when there has never been a successful run.
func lastWatermark(ctx context.Context, db *core.DB) time.Time {
	var t sql.NullTime
	err := db.PG.QueryRowContext(ctx,
		`SELECT MAX(started_at) FROM paystack_sync_runs WHERE status = 'ok'`).Scan(&t)
	if err != nil || !t.Valid {
		return time.Time{}
	}
	return t.Time.Add(-overlapWindow)
}

func nullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

func doSync(ctx context.Context, db *core.DB, secret string, watermark time.Time) (Result, error) {
	var res Result
	var err error

	if res.Transactions, err = syncTransactions(ctx, db, secret, watermark); err != nil {
		return res, err
	}
	if res.Transfers, err = syncTransfers(ctx, db, secret, watermark); err != nil {
		return res, err
	}
	// Settlements and disputes are small (hundreds / single digits) — always full.
	if res.Settlements, err = syncSettlements(ctx, db, secret); err != nil {
		return res, err
	}
	if res.Disputes, err = syncDisputes(ctx, db, secret); err != nil {
		return res, err
	}
	return res, nil
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

type envelope struct {
	Status  bool            `json:"status"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
	Meta    struct {
		Total     json.Number `json:"total"`
		PageCount json.Number `json:"pageCount"`
	} `json:"meta"`
}

func fetchPage(ctx context.Context, secret, path string, page int) ([]json.RawMessage, int, error) {
	params := url.Values{
		"perPage": {strconv.Itoa(perPage)},
		"page":    {strconv.Itoa(page)},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiBase+path+"?"+params.Encode(), nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+secret)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("paystack %s page %d: %w", path, page, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("paystack %s page %d: HTTP %d", path, page, resp.StatusCode)
	}

	var env envelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return nil, 0, fmt.Errorf("paystack %s page %d: decode: %w", path, page, err)
	}
	if !env.Status {
		return nil, 0, fmt.Errorf("paystack %s page %d: %s", path, page, env.Message)
	}

	var rows []json.RawMessage
	if len(env.Data) > 0 {
		// A resource with no rows can return `null` rather than `[]`.
		if err := json.Unmarshal(env.Data, &rows); err != nil {
			return nil, 0, fmt.Errorf("paystack %s page %d: data: %w", path, page, err)
		}
	}
	pageCount, _ := strconv.Atoi(env.Meta.PageCount.String())
	return rows, pageCount, nil
}

// walk pages a list endpoint newest-first, calling handle for each raw record.
// handle returns the record's creation time; walking stops once a whole page is
// older than the watermark (zero watermark walks the full history).
func walk(ctx context.Context, secret, path string, watermark time.Time,
	handle func(json.RawMessage) (time.Time, error)) (int, error) {

	seen := 0
	for page := 1; page <= maxPages; page++ {
		rows, pageCount, err := fetchPage(ctx, secret, path, page)
		if err != nil {
			return seen, err
		}
		if len(rows) == 0 {
			return seen, nil
		}

		pageAllOlder := true
		for _, raw := range rows {
			created, err := handle(raw)
			if err != nil {
				return seen, err
			}
			seen++
			if watermark.IsZero() || created.IsZero() || !created.Before(watermark) {
				pageAllOlder = false
			}
		}

		if !watermark.IsZero() && pageAllOlder {
			return seen, nil // reached records older than the window
		}
		// pageCount is per-page-size, so it is the true last page for this walk.
		if pageCount > 0 && page >= pageCount {
			return seen, nil
		}
		select {
		case <-ctx.Done():
			return seen, ctx.Err()
		case <-time.After(pageDelay):
		}
	}
	return seen, nil
}

// ── time helpers ─────────────────────────────────────────────────────────────

// parseTS accepts Paystack's ISO-8601 stamps; returns zero time for null/blank.
func parseTS(vals ...string) time.Time {
	for _, v := range vals {
		if v == "" {
			continue
		}
		for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05.000Z", "2006-01-02 15:04:05"} {
			if t, err := time.Parse(layout, v); err == nil {
				return t
			}
		}
	}
	return time.Time{}
}

func tsOrNil(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// ── Transactions (inbound funding) ───────────────────────────────────────────

type psTransaction struct {
	ID              int64  `json:"id"`
	Reference       string `json:"reference"`
	Status          string `json:"status"`
	Channel         string `json:"channel"`
	Currency        string `json:"currency"`
	Amount          int64  `json:"amount"`
	RequestedAmount int64  `json:"requested_amount"`
	Fees            int64  `json:"fees"`
	GatewayResponse string `json:"gateway_response"`
	PaidAt          string `json:"paid_at"`
	CreatedAt       string `json:"created_at"`
	CreatedAtAlt    string `json:"createdAt"`
	IPAddress       string `json:"ip_address"`
	Customer        struct {
		ID           int64  `json:"id"`
		Email        string `json:"email"`
		Phone        string `json:"phone"`
		CustomerCode string `json:"customer_code"`
	} `json:"customer"`
	Authorization struct {
		Bank     string `json:"bank"`
		CardType string `json:"card_type"`
		Last4    string `json:"last4"`
	} `json:"authorization"`
}

func syncTransactions(ctx context.Context, db *core.DB, secret string, watermark time.Time) (int, error) {
	return walk(ctx, secret, "/transaction", watermark, func(raw json.RawMessage) (time.Time, error) {
		var t psTransaction
		if err := json.Unmarshal(raw, &t); err != nil {
			return time.Time{}, fmt.Errorf("transaction decode: %w", err)
		}
		created := parseTS(t.CreatedAt, t.CreatedAtAlt)
		_, err := db.PG.ExecContext(ctx, `
			INSERT INTO paystack_transactions
			  (id, reference, status, channel, currency, amount_kobo, requested_kobo, fees_kobo,
			   gateway_response, paid_at, created_at_ps, customer_id, customer_code, customer_email,
			   customer_phone, auth_bank, auth_card_type, auth_last4, ip_address, raw, synced_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
			ON CONFLICT (id) DO UPDATE SET
			  reference=EXCLUDED.reference, status=EXCLUDED.status, channel=EXCLUDED.channel,
			  currency=EXCLUDED.currency, amount_kobo=EXCLUDED.amount_kobo,
			  requested_kobo=EXCLUDED.requested_kobo, fees_kobo=EXCLUDED.fees_kobo,
			  gateway_response=EXCLUDED.gateway_response, paid_at=EXCLUDED.paid_at,
			  created_at_ps=EXCLUDED.created_at_ps, customer_id=EXCLUDED.customer_id,
			  customer_code=EXCLUDED.customer_code, customer_email=EXCLUDED.customer_email,
			  customer_phone=EXCLUDED.customer_phone, auth_bank=EXCLUDED.auth_bank,
			  auth_card_type=EXCLUDED.auth_card_type, auth_last4=EXCLUDED.auth_last4,
			  ip_address=EXCLUDED.ip_address, raw=EXCLUDED.raw, synced_at=NOW()`,
			t.ID, t.Reference, t.Status, t.Channel, t.Currency, t.Amount, t.RequestedAmount, t.Fees,
			t.GatewayResponse, tsOrNil(parseTS(t.PaidAt)), tsOrNil(created), t.Customer.ID,
			t.Customer.CustomerCode, t.Customer.Email, t.Customer.Phone,
			t.Authorization.Bank, t.Authorization.CardType, t.Authorization.Last4,
			t.IPAddress, string(raw))
		return created, err
	})
}

// ── Transfers (outbound payouts) ─────────────────────────────────────────────

type psTransfer struct {
	ID            int64           `json:"id"`
	Reference     string          `json:"reference"`
	TransferCode  string          `json:"transfer_code"`
	Status        string          `json:"status"`
	Currency      string          `json:"currency"`
	Amount        int64           `json:"amount"`
	FeeCharged    int64           `json:"fee_charged"`
	Reason        string          `json:"reason"`
	Failures      json.RawMessage `json:"failures"`
	Source        string          `json:"source"`
	CreatedAt     string          `json:"createdAt"`
	UpdatedAt     string          `json:"updatedAt"`
	TransferredAt string          `json:"transferred_at"`
	Recipient     struct {
		RecipientCode string `json:"recipient_code"`
		Name          string `json:"name"`
		Details       struct {
			AccountNumber string `json:"account_number"`
			BankCode      string `json:"bank_code"`
			BankName      string `json:"bank_name"`
		} `json:"details"`
	} `json:"recipient"`
	Session struct {
		Provider string `json:"provider"`
		ID       string `json:"id"`
	} `json:"session"`
}

func syncTransfers(ctx context.Context, db *core.DB, secret string, watermark time.Time) (int, error) {
	return walk(ctx, secret, "/transfer", watermark, func(raw json.RawMessage) (time.Time, error) {
		var t psTransfer
		if err := json.Unmarshal(raw, &t); err != nil {
			return time.Time{}, fmt.Errorf("transfer decode: %w", err)
		}
		created := parseTS(t.CreatedAt)
		failures := ""
		if len(t.Failures) > 0 && string(t.Failures) != "null" {
			failures = string(t.Failures)
		}
		_, err := db.PG.ExecContext(ctx, `
			INSERT INTO paystack_transfers
			  (id, reference, transfer_code, status, currency, amount_kobo, fee_kobo, reason, failures,
			   source, created_at_ps, updated_at_ps, transferred_at, recipient_code, recipient_name,
			   recipient_account, recipient_bank, recipient_bank_code, session_provider, session_id,
			   raw, synced_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
			ON CONFLICT (id) DO UPDATE SET
			  reference=EXCLUDED.reference, transfer_code=EXCLUDED.transfer_code,
			  status=EXCLUDED.status, currency=EXCLUDED.currency, amount_kobo=EXCLUDED.amount_kobo,
			  fee_kobo=EXCLUDED.fee_kobo, reason=EXCLUDED.reason, failures=EXCLUDED.failures,
			  source=EXCLUDED.source, created_at_ps=EXCLUDED.created_at_ps,
			  updated_at_ps=EXCLUDED.updated_at_ps, transferred_at=EXCLUDED.transferred_at,
			  recipient_code=EXCLUDED.recipient_code, recipient_name=EXCLUDED.recipient_name,
			  recipient_account=EXCLUDED.recipient_account, recipient_bank=EXCLUDED.recipient_bank,
			  recipient_bank_code=EXCLUDED.recipient_bank_code,
			  session_provider=EXCLUDED.session_provider, session_id=EXCLUDED.session_id,
			  raw=EXCLUDED.raw, synced_at=NOW()`,
			t.ID, t.Reference, t.TransferCode, t.Status, t.Currency, t.Amount, t.FeeCharged,
			t.Reason, failures, t.Source, tsOrNil(created), tsOrNil(parseTS(t.UpdatedAt)),
			tsOrNil(parseTS(t.TransferredAt)), t.Recipient.RecipientCode, t.Recipient.Name,
			t.Recipient.Details.AccountNumber, t.Recipient.Details.BankName,
			t.Recipient.Details.BankCode, t.Session.Provider, t.Session.ID, string(raw))
		return created, err
	})
}

// ── Settlements (Paystack → O3's bank) ───────────────────────────────────────

type psSettlement struct {
	ID              int64  `json:"id"`
	Status          string `json:"status"`
	Currency        string `json:"currency"`
	TotalAmount     int64  `json:"total_amount"`
	EffectiveAmount int64  `json:"effective_amount"`
	TotalFees       int64  `json:"total_fees"`
	TotalProcessed  int64  `json:"total_processed"`
	SettlementDate  string `json:"settlement_date"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
}

func syncSettlements(ctx context.Context, db *core.DB, secret string) (int, error) {
	return walk(ctx, secret, "/settlement", time.Time{}, func(raw json.RawMessage) (time.Time, error) {
		var s psSettlement
		if err := json.Unmarshal(raw, &s); err != nil {
			return time.Time{}, fmt.Errorf("settlement decode: %w", err)
		}
		created := parseTS(s.CreatedAt)
		_, err := db.PG.ExecContext(ctx, `
			INSERT INTO paystack_settlements
			  (id, status, currency, total_amount_kobo, effective_kobo, total_fees_kobo,
			   total_processed_kobo, settlement_date, created_at_ps, updated_at_ps, raw, synced_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
			ON CONFLICT (id) DO UPDATE SET
			  status=EXCLUDED.status, currency=EXCLUDED.currency,
			  total_amount_kobo=EXCLUDED.total_amount_kobo, effective_kobo=EXCLUDED.effective_kobo,
			  total_fees_kobo=EXCLUDED.total_fees_kobo,
			  total_processed_kobo=EXCLUDED.total_processed_kobo,
			  settlement_date=EXCLUDED.settlement_date, created_at_ps=EXCLUDED.created_at_ps,
			  updated_at_ps=EXCLUDED.updated_at_ps, raw=EXCLUDED.raw, synced_at=NOW()`,
			s.ID, s.Status, s.Currency, s.TotalAmount, s.EffectiveAmount, s.TotalFees,
			s.TotalProcessed, tsOrNil(parseTS(s.SettlementDate)), tsOrNil(created),
			tsOrNil(parseTS(s.UpdatedAt)), string(raw))
		return created, err
	})
}

// ── Disputes / chargebacks ───────────────────────────────────────────────────

type psDispute struct {
	ID           int64  `json:"id"`
	Status       string `json:"status"`
	Resolution   string `json:"resolution"`
	Category     string `json:"category"`
	Currency     string `json:"currency"`
	RefundAmount int64  `json:"refund_amount"`
	DueAt        string `json:"due_at"`
	ResolvedAt   string `json:"resolved_at"`
	CreatedAt    string `json:"createdAt"`
	CreatedAtAlt string `json:"created_at"`
	Transaction  struct {
		ID int64 `json:"id"`
	} `json:"transaction"`
	Customer struct {
		Email string `json:"email"`
	} `json:"customer"`
}

func syncDisputes(ctx context.Context, db *core.DB, secret string) (int, error) {
	return walk(ctx, secret, "/dispute", time.Time{}, func(raw json.RawMessage) (time.Time, error) {
		var d psDispute
		if err := json.Unmarshal(raw, &d); err != nil {
			return time.Time{}, fmt.Errorf("dispute decode: %w", err)
		}
		created := parseTS(firstNonEmpty(d.CreatedAt, d.CreatedAtAlt))
		_, err := db.PG.ExecContext(ctx, `
			INSERT INTO paystack_disputes
			  (id, status, resolution, category, currency, refund_amount_kobo, transaction_id,
			   customer_email, due_at, resolved_at, created_at_ps, raw, synced_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
			ON CONFLICT (id) DO UPDATE SET
			  status=EXCLUDED.status, resolution=EXCLUDED.resolution, category=EXCLUDED.category,
			  currency=EXCLUDED.currency, refund_amount_kobo=EXCLUDED.refund_amount_kobo,
			  transaction_id=EXCLUDED.transaction_id, customer_email=EXCLUDED.customer_email,
			  due_at=EXCLUDED.due_at, resolved_at=EXCLUDED.resolved_at,
			  created_at_ps=EXCLUDED.created_at_ps, raw=EXCLUDED.raw, synced_at=NOW()`,
			d.ID, d.Status, d.Resolution, d.Category, d.Currency, d.RefundAmount,
			d.Transaction.ID, d.Customer.Email, tsOrNil(parseTS(d.DueAt)),
			tsOrNil(parseTS(d.ResolvedAt)), tsOrNil(created), string(raw))
		return created, err
	})
}
