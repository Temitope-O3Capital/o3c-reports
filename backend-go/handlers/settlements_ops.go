package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterSettlementOps wires NIP/NIBSS reconciliation, failed-transaction queue,
// settlement batch management, and manual posting workflow.
func RegisterSettlementOps(r chi.Router, db *core.DB) {
	access := core.RequirePages("settlement")

	// Settlement batches
	r.With(access).Get("/", soaBatchList(db))
	r.With(access).Post("/", soaBatchCreate(db))
	r.With(access).Get("/kpis", soaKPIs(db))
	r.With(access).Get("/{id}/transactions", soaBatchTxns(db))
	r.With(access).Get("/{id}/export", soaBatchExport(db)) // M2: CSV export

	// NIP reconciliation
	r.With(access).Get("/nip", soaNIPList(db))
	r.With(access).Put("/nip/{id}/resolve", soaNIPResolveHandler(db))
	r.With(access).Get("/nip-recon", soaNIPRecon(db))

	// Overview dashboard
	r.With(access).Get("/overview", soaOverview(db))

	// Failed transactions
	r.With(access).Get("/failed", soaFailedList(db))
	r.With(access).Post("/failed/{id}/retry", soaFailedRetry(db))
	r.With(access).Post("/failed/{id}/resolve", soaFailedResolve(db))
	r.With(access).Post("/failed/{id}/escalate", soaFailedEscalate(db))

	// Manual postings
	r.With(access).Get("/manual-postings", soaManualPostingsList(db))
	r.With(access).Post("/manual-postings", soaManualPostingsCreate(db))
	r.With(access).Put("/manual-postings/{id}/approve", soaManualPostingsApprove(db))
	r.With(access).Put("/manual-postings/{id}/reject", soaManualPostingsReject(db))
}

/* ── Settlement KPIs ─────────────────────────────────────────────────────── */

func soaKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  COALESCE(SUM(CASE WHEN status='settled' AND batch_date=CURRENT_DATE THEN total_credits ELSE 0 END),0) AS settled_today_kobo,
			  COALESCE(SUM(CASE WHEN status='pending' THEN total_credits ELSE 0 END),0)                           AS pending_kobo,
			  COUNT(*) FILTER (WHERE status='failed')                                                             AS failed_count,
			  CASE WHEN COUNT(*) > 0 THEN
			    ROUND(100.0 * COUNT(*) FILTER (WHERE status='settled') / COUNT(*), 2)
			  ELSE 0 END                                                                                          AS success_rate_pct
			FROM settlement_batches`)
		if err != nil || len(rows) == 0 {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
				"data": map[string]any{
					"settled_today_kobo": 0,
					"pending_kobo":       0,
					"failed_count":       0,
					"success_rate_pct":   0,
				},
			})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows[0]}) //nolint:errcheck
	}
}

/* ── Settlement Batch List ───────────────────────────────────────────────── */

func soaBatchList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _   := validDate(r, "date_to")
		status      := qstr(r, "status")
		limit       := qint(r, "limit", 100, 1, 500)

		where := "1=1"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND batch_date >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND batch_date <= $%d::date", n); args = append(args, dateTo); n++
		}
		if status != "" {
			where += fmt.Sprintf(" AND LOWER(status)=LOWER($%d)", n); args = append(args, status); n++
		}
		args = append(args, limit)

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			  id, batch_ref, batch_date, txn_count,
			  total_credits AS total_amount_kobo,
			  status,
			  NULL::TEXT AS generated_by,
			  created_at
			FROM settlement_batches
			WHERE %s
			ORDER BY batch_date DESC, id DESC
			LIMIT $%d`, where, n), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

func soaBatchCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			BatchDate    string `json:"batch_date"`
			BatchRef     string `json:"batch_ref"`
			BatchType    string `json:"batch_type"`
			TotalCredits int64  `json:"total_credits"`
			TotalDebits  int64  `json:"total_debits"`
			TxnCount     int    `json:"txn_count"`
			Notes        string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.BatchDate == "" {
			respondErr(w, 422, "batch_date is required")
			return
		}
		if b.BatchType == "" {
			b.BatchType = "NIP"
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO settlement_batches
			    (batch_date, batch_ref, batch_type, total_credits, total_debits, txn_count, notes)
			VALUES ($1::date,$2,$3,$4,$5,$6,$7)
			RETURNING id, batch_ref, batch_date, txn_count,
			          total_credits AS total_amount_kobo, status,
			          NULL::TEXT AS generated_by, created_at`,
			b.BatchDate, b.BatchRef, b.BatchType, b.TotalCredits, b.TotalDebits, b.TxnCount, b.Notes)
		if err != nil {
			respondErr(w, 500, "Create failed: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

/* ── Batch Transaction Drill-down ────────────────────────────────────────── */

func soaBatchTxns(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  id, txn_ref,
			  amount_kobo,
			  NULL::TEXT AS customer_name,
			  status,
			  created_at
			FROM settlement_exceptions
			WHERE batch_id = $1
			ORDER BY created_at DESC
			LIMIT 200`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

/* ── M2: Settlement Batch CSV Export ─────────────────────────────────────── */

func soaBatchExport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  id,
			  txn_ref         AS reference,
			  amount_kobo,
			  status,
			  TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
			FROM settlement_exceptions
			WHERE batch_id = $1
			ORDER BY created_at`, id)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		streamCSV(w, fmt.Sprintf("settlement-batch-%s.csv", id), rows)
	}
}

/* ── NIP Reconciliation ──────────────────────────────────────────────────── */

func soaNIPList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		date       := qstr(r, "date")
		statusRaw  := qstr(r, "status")
		limit      := qint(r, "limit", 100, 1, 500)

		where := "1=1"
		var args []any
		n := 1
		if date != "" {
			where += fmt.Sprintf(" AND txn_date = $%d::date", n); args = append(args, date); n++
		}
		// Map frontend match_status values to DB status values
		if statusRaw != "" {
			switch strings.ToLower(statusRaw) {
			case "matched":
				where += fmt.Sprintf(" AND status = $%d", n); args = append(args, "resolved"); n++
			case "exception":
				where += fmt.Sprintf(" AND status = $%d", n); args = append(args, "escalated"); n++
			case "unmatched":
				where += fmt.Sprintf(" AND status = $%d", n); args = append(args, "open"); n++
			}
		}
		args = append(args, limit)

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			  id,
			  COALESCE(txn_ref, 'NIP-' || id) AS nip_ref,
			  amount_kobo,
			  txn_date AS value_date,
			  NULL::TEXT AS customer_name,
			  (status = 'resolved') AS core_banking_credited,
			  CASE status
			    WHEN 'resolved'  THEN 'Matched'
			    WHEN 'escalated' THEN 'Exception'
			    ELSE 'Unmatched'
			  END AS match_status,
			  exception_type
			FROM settlement_exceptions
			WHERE %s
			ORDER BY txn_date DESC, id DESC
			LIMIT $%d`, where, n), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

func soaNIPResolveHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id   := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		var b struct {
			ResolutionType string `json:"resolution_type"`
			Notes          string `json:"notes"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		note := b.Notes
		if b.ResolutionType != "" && note == "" {
			note = b.ResolutionType
		} else if b.ResolutionType != "" {
			note = b.ResolutionType + ": " + note
		}

		rows, err := db.PGQuery(r.Context(), `
			UPDATE settlement_exceptions
			SET status='resolved', resolved_by=$1, resolved_at=NOW(),
			    resolution_note=$2, updated_at=NOW()
			WHERE id=$3 AND status != 'resolved'
			RETURNING id, COALESCE(txn_ref,'NIP-'||id) AS nip_ref, amount_kobo,
			          txn_date AS value_date, NULL::TEXT AS customer_name,
			          TRUE AS core_banking_credited, 'Matched' AS match_status, exception_type`,
			user.ID, note, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Exception not found or already resolved")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

/* ── Failed Transactions ─────────────────────────────────────────────────── */

func soaFailedList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reason   := qstr(r, "reason")
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _   := validDate(r, "date_to")
		limit    := qint(r, "limit", 100, 1, 500)

		where := "status IN ('open','escalated')"
		var args []any
		n := 1
		if reason != "" {
			where += fmt.Sprintf(" AND description ILIKE $%d", n)
			args = append(args, "%"+reason+"%")
			n++
		}
		if dateFrom != "" {
			where += fmt.Sprintf(" AND txn_date >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND txn_date <= $%d::date", n); args = append(args, dateTo); n++
		}
		args = append(args, limit)

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			  id,
			  COALESCE(txn_ref, 'TXN-' || id) AS txn_ref,
			  amount_kobo,
			  NULL::TEXT AS customer_name,
			  COALESCE(exception_type, 'NIP') AS channel,
			  COALESCE(description, 'Unknown error') AS failure_reason,
			  txn_date::timestamptz AS failed_at,
			  0 AS retry_count
			FROM settlement_exceptions
			WHERE %s
			ORDER BY txn_date DESC, id DESC
			LIMIT $%d`, where, n), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

func soaFailedRetry(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		existing, err := db.PGQuery(r.Context(),
			`SELECT id FROM settlement_exceptions WHERE id=$1`, id)
		if err != nil || len(existing) == 0 {
			respondErr(w, 404, "Transaction not found")
			return
		}
		// H6: surface update errors; set status='open' so batch processor picks it up
		if _, err = db.PGExec(r.Context(),
			`UPDATE settlement_exceptions SET status='open', updated_at=NOW() WHERE id=$1`, id); err != nil {
			respondErr(w, 500, "Retry queue failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(202)
		json.NewEncoder(w).Encode(map[string]string{"status": "retry_queued"}) //nolint:errcheck
	}
}

func soaFailedResolve(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id   := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		var b struct {
			Notes string `json:"notes"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		rows, err := db.PGQuery(r.Context(), `
			UPDATE settlement_exceptions
			SET status='resolved', resolved_by=$1, resolved_at=NOW(),
			    resolution_note=$2, updated_at=NOW()
			WHERE id=$3 AND status IN ('open','escalated')
			RETURNING id`, user.ID, b.Notes, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Transaction not found or already resolved")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "resolved"}) //nolint:errcheck
	}
}

func soaFailedEscalate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		existing, err := db.PGQuery(r.Context(),
			`SELECT id FROM settlement_exceptions WHERE id=$1 AND status IN ('open','escalated')`, id)
		if err != nil || len(existing) == 0 {
			respondErr(w, 404, "Transaction not found or already resolved")
			return
		}
		db.PGExec(r.Context(), //nolint:errcheck
			`UPDATE settlement_exceptions SET status='escalated', updated_at=NOW() WHERE id=$1`, id)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(202)
		json.NewEncoder(w).Encode(map[string]string{"status": "escalated"}) //nolint:errcheck
	}
}

/* ── Manual Postings ─────────────────────────────────────────────────────── */

func soaManualPostingsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		statusRaw    := qstr(r, "status")
		search       := qstr(r, "q")
		dateFrom, _  := validDate(r, "date_from")
		dateTo, _    := validDate(r, "date_to")
		limit        := qint(r, "limit", 100, 1, 500)

		where := "1=1"
		var args []any
		n := 1

		if statusRaw != "" {
			// Map frontend label → DB value
			dbStatus := statusRaw
			switch strings.ToLower(statusRaw) {
			case "pending approval":
				dbStatus = "pending"
			case "approved":
				dbStatus = "approved"
			case "rejected":
				dbStatus = "rejected"
			}
			where += fmt.Sprintf(" AND status=$%d", n); args = append(args, dbStatus); n++
		}
		if search != "" {
			where += fmt.Sprintf(" AND (initiated_by_name ILIKE $%d OR narrative ILIKE $%d)", n, n)
			args = append(args, "%"+search+"%")
			n++
		}
		if dateFrom != "" {
			where += fmt.Sprintf(" AND created_at::date >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND created_at::date <= $%d::date", n); args = append(args, dateTo); n++
		}
		args = append(args, limit)

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			  id,
			  'MP-' || LPAD(id::text, 5, '0') AS ref,
			  CASE WHEN dr_account='SUSPENSE' THEN 'Credit' ELSE 'Debit' END AS type,
			  amount_kobo,
			  CASE WHEN dr_account='SUSPENSE' THEN cr_account ELSE dr_account END AS account,
			  narrative AS description,
			  COALESCE(initiated_by_name, '') AS initiated_by,
			  CASE status
			    WHEN 'pending'  THEN 'Pending Approval'
			    WHEN 'approved' THEN 'Approved'
			    WHEN 'rejected' THEN 'Rejected'
			    ELSE status
			  END AS status,
			  created_at
			FROM manual_postings
			WHERE %s
			ORDER BY created_at DESC
			LIMIT $%d`, where, n), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

func soaManualPostingsCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		var b struct {
			Type        string `json:"type"`
			AmountKobo  int64  `json:"amount_kobo"`
			Account     string `json:"account"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AmountKobo <= 0 || b.Account == "" || b.Description == "" {
			respondErr(w, 422, "amount_kobo, account and description are required")
			return
		}

		drAccount := b.Account
		crAccount := "SUSPENSE"
		if strings.EqualFold(b.Type, "Credit") {
			drAccount = "SUSPENSE"
			crAccount = b.Account
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO manual_postings
			  (initiated_by, initiated_by_name, dr_account, cr_account, amount_kobo, narrative, status)
			VALUES ($1,$2,$3,$4,$5,$6,'pending')
			RETURNING id, 'MP-'||LPAD(id::text,5,'0') AS ref, amount_kobo, created_at`,
			user.ID, user.FullName, drAccount, crAccount, b.AmountKobo, b.Description)
		if err != nil {
			respondErr(w, 500, "Create failed: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func soaManualPostingsApprove(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id   := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())

		existing, err := db.PGQuery(r.Context(),
			`SELECT id, dr_account, cr_account, amount_kobo, narrative
			 FROM manual_postings WHERE id=$1 AND status='pending'`, id)
		if err != nil || len(existing) == 0 {
			respondErr(w, 404, "Posting not found or not pending")
			return
		}
		mp := existing[0]

		tx, err := db.PG.BeginTx(r.Context(), nil)
		if err != nil {
			respondErr(w, 500, "Transaction start failed")
			return
		}

		_, err = tx.ExecContext(r.Context(), `
			UPDATE manual_postings
			SET status='approved', approved_by=$1, approved_by_name=$2,
			    approved_at=NOW(), updated_at=NOW()
			WHERE id=$3`,
			user.ID, user.FullName, id)
		if err != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "Approval update failed")
			return
		}

		ref := fmt.Sprintf("MP-%05s", fmt.Sprint(mp["id"]))
		if jerr := postJournalTx(r.Context(), tx, glEntry{
			Date:          time.Now(),
			Description:   fmt.Sprint(mp["narrative"]),
			Reference:     ref,
			DebitAccount:  fmt.Sprint(mp["dr_account"]),
			CreditAccount: fmt.Sprint(mp["cr_account"]),
			AmountKobo:    toInt64(mp["amount_kobo"]),
			SourceType:    "manual_posting",
			SourceID:      toInt64(mp["id"]),
			PostedBy:      user.ID,
		}); jerr != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "GL journal entry failed: "+jerr.Error())
			return
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "approved"}) //nolint:errcheck
	}
}

func soaManualPostingsReject(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id   := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		var b struct {
			Reason string `json:"reason"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		rows, err := db.PGQuery(r.Context(), `
			UPDATE manual_postings
			SET status='rejected', approved_by=$1, approved_by_name=$2,
			    rejection_reason=$3, approved_at=NOW(), updated_at=NOW()
			WHERE id=$4 AND status='pending'
			RETURNING id`,
			user.ID, user.FullName, b.Reason, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Posting not found or not pending")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "rejected"}) //nolint:errcheck
	}
}

func soaOverview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		out := map[string]any{
			"settled_today_kobo": 0, "pending_kobo": 0, "failed_count": 0, "success_rate_pct": 0,
			"nip": map[string]any{
				"total": 0, "matched": 0, "unmatched": 0,
				"exception_count": 0, "exception_value_kobo": 0, "reconciliation_rate_pct": 0,
			},
			"paystack":    map[string]any{"configured": false, "wallet_balance_kobo": 0, "last_sync_at": nil, "open_disputes": 0},
			"interswitch": map[string]any{"configured": false},
		}

		if batchRows, _ := db.PGQuery(ctx, `
			SELECT
			  COALESCE(SUM(CASE WHEN status='settled' AND batch_date=CURRENT_DATE THEN total_credits ELSE 0 END),0) AS settled_today_kobo,
			  COALESCE(SUM(CASE WHEN status='pending' THEN total_credits ELSE 0 END),0)                            AS pending_kobo,
			  COUNT(*) FILTER (WHERE status='failed')                                                              AS failed_count,
			  CASE WHEN COUNT(*) > 0 THEN
			    ROUND(100.0 * COUNT(*) FILTER (WHERE status='settled') / COUNT(*), 2)
			  ELSE 0 END                                                                                            AS success_rate_pct
			FROM settlement_batches`); len(batchRows) > 0 {
			out["settled_today_kobo"] = batchRows[0]["settled_today_kobo"]
			out["pending_kobo"]       = batchRows[0]["pending_kobo"]
			out["failed_count"]       = batchRows[0]["failed_count"]
			out["success_rate_pct"]   = batchRows[0]["success_rate_pct"]
		}

		if nipRows, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(*)                                                        AS total,
			  COUNT(*) FILTER (WHERE status = 'resolved')                    AS matched,
			  COUNT(*) FILTER (WHERE status = 'open')                        AS unmatched,
			  COUNT(*) FILTER (WHERE status = 'escalated')                   AS exception_count,
			  COALESCE(SUM(amount_kobo) FILTER (WHERE status='escalated'),0) AS exception_value_kobo,
			  CASE WHEN COUNT(*) > 0 THEN
			    ROUND(100.0 * COUNT(*) FILTER (WHERE status='resolved') / COUNT(*), 2)
			  ELSE 0 END                                                      AS reconciliation_rate_pct
			FROM settlement_exceptions`); len(nipRows) > 0 {
			out["nip"] = nipRows[0]
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out) //nolint:errcheck
	}
}

func soaNIPRecon(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx     := r.Context()
		date    := qstr(r, "date")
		statusP := qstr(r, "status")

		// Batches
		bwhere := "1=1"
		var bargs []any
		bn := 1
		if date != "" {
			bwhere += fmt.Sprintf(" AND b.batch_date = $%d::date", bn)
			bargs = append(bargs, date)
			bn++
		}
		if statusP != "" {
			bwhere += fmt.Sprintf(" AND LOWER(b.status) = LOWER($%d)", bn)
			bargs = append(bargs, statusP)
			bn++
		}
		_ = bn

		batchRows, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT
			  b.id,
			  b.batch_date,
			  b.batch_ref,
			  COALESCE(b.batch_type, 'NIP')  AS batch_type,
			  b.total_credits,
			  COALESCE(b.total_debits, 0)    AS total_debits,
			  b.txn_count,
			  COUNT(e.id)                    AS exception_count,
			  b.status
			FROM settlement_batches b
			LEFT JOIN settlement_exceptions e ON e.batch_id = b.id
			WHERE %s
			GROUP BY b.id, b.batch_date, b.batch_ref, b.batch_type,
			         b.total_credits, b.total_debits, b.txn_count, b.status
			ORDER BY b.batch_date DESC, b.id DESC
			LIMIT 200`, bwhere), bargs...)

		// Exceptions
		ewhere := "1=1"
		var eargs []any
		en := 1
		if date != "" {
			ewhere += fmt.Sprintf(" AND e.txn_date = $%d::date", en)
			eargs = append(eargs, date)
			en++
		}
		if statusP != "" {
			switch strings.ToLower(statusP) {
			case "matched":
				ewhere += fmt.Sprintf(" AND e.status = $%d", en); eargs = append(eargs, "resolved"); en++
			case "exception":
				ewhere += fmt.Sprintf(" AND e.status = $%d", en); eargs = append(eargs, "escalated"); en++
			case "unmatched":
				ewhere += fmt.Sprintf(" AND e.status = $%d", en); eargs = append(eargs, "open"); en++
			default:
				ewhere += fmt.Sprintf(" AND LOWER(e.status) = LOWER($%d)", en); eargs = append(eargs, statusP); en++
			}
		}
		_ = en

		excRows, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT
			  e.id,
			  COALESCE(e.batch_id, 0)                    AS batch_id,
			  e.txn_date,
			  COALESCE(e.txn_ref, 'NIP-' || e.id)       AS txn_ref,
			  e.amount_kobo,
			  COALESCE(e.exception_type, 'unknown')      AS exception_type,
			  COALESCE(e.description, '')                AS description,
			  e.status,
			  COALESCE(b.batch_ref, '')                  AS batch_ref,
			  COALESCE(u.full_name, '')                  AS resolved_by_name,
			  e.resolved_at,
			  COALESCE(e.resolution_note, '')            AS resolution_note
			FROM settlement_exceptions e
			LEFT JOIN settlement_batches b ON b.id = e.batch_id
			LEFT JOIN o3c_users u ON u.id = e.resolved_by
			WHERE %s
			ORDER BY e.txn_date DESC, e.id DESC
			LIMIT 500`, ewhere), eargs...)

		if batchRows == nil { batchRows = []map[string]any{} }
		if excRows == nil   { excRows   = []map[string]any{} }

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"batches":    batchRows,
			"exceptions": excRows,
		})
	}
}

// ensure sql import is used (BeginTx returns *sql.Tx)
var _ *sql.Tx
