package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
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
	r.With(access).Post("/nip/bulk-resolve", nipBulkResolve(db))
	r.With(access).Get("/nip-recon", soaNIPRecon(db))
	r.With(access).Post("/nip-recon/exceptions/{id}/resolve", soaNIPReconResolve(db))

	// Overview dashboard
	r.With(access).Get("/overview", soaOverview(db))

	// Failed transactions
	r.With(access).Get("/failed", soaFailedList(db))
	r.With(access).Post("/failed/{id}/retry", soaFailedRetry(db))
	r.With(access).Post("/failed/{id}/resolve", soaFailedResolve(db))
	r.With(access).Post("/failed/{id}/escalate", soaFailedEscalate(db))

	// Manual postings — 3-step: raise → approve → post (+ reject / return)
	r.With(access).Get("/manual-postings", soaManualPostingsList(db))
	r.With(access).Post("/manual-postings", soaManualPostingsCreate(db))
	r.With(access).Put("/manual-postings/{id}/approve", soaManualPostingsApprove(db))
	r.With(access).Put("/manual-postings/{id}/reject", soaManualPostingsReject(db))
	r.With(access).Put("/manual-postings/{id}/post", soaManualPostingsPost(db))
	r.With(access).Put("/manual-postings/{id}/return", soaManualPostingsReturn(db))
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
			parts := strings.Split(status, ",")
			phs := make([]string, len(parts))
			for i, p := range parts { phs[i] = fmt.Sprintf("LOWER($%d)", n+i); args = append(args, strings.TrimSpace(p)) }
			n += len(parts)
			if len(parts) == 1 {
				where += fmt.Sprintf(" AND LOWER(status)=%s", phs[0])
			} else {
				where += fmt.Sprintf(" AND LOWER(status) IN (%s)", strings.Join(phs, ","))
			}
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
		// Map frontend match_status values to DB status values.
		// Accepts a comma-separated list (multi-select).
		if statusRaw != "" {
			statusMap := map[string]string{"matched": "resolved", "exception": "escalated", "unmatched": "open"}
			var placeholders []string
			for _, part := range strings.Split(statusRaw, ",") {
				if dbv, ok := statusMap[strings.ToLower(strings.TrimSpace(part))]; ok {
					placeholders = append(placeholders, fmt.Sprintf("$%d", n))
					args = append(args, dbv)
					n++
				}
			}
			if len(placeholders) > 0 {
				where += " AND status IN (" + strings.Join(placeholders, ",") + ")"
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
		// reason accepts a comma-separated list (multi-select) → OR'd substring match.
		if reason != "" {
			var ors []string
			for _, part := range strings.Split(reason, ",") {
				p := strings.TrimSpace(part)
				if p == "" {
					continue
				}
				ors = append(ors, fmt.Sprintf("description ILIKE $%d", n))
				args = append(args, "%"+p+"%")
				n++
			}
			if len(ors) > 0 {
				where += " AND (" + strings.Join(ors, " OR ") + ")"
			}
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
	// Map a frontend stage token → the DB status value.
	stageToStatus := map[string]string{
		"pending_approval": "pending",
		"approved":         "approved",
		"posted":           "posted",
		"rejected":         "rejected",
		"returned":         "returned",
	}
	return func(w http.ResponseWriter, r *http.Request) {
		stageRaw    := qstr(r, "stage")
		search      := qstr(r, "q")
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _   := validDate(r, "date_to")
		limit       := qint(r, "limit", 100, 1, 500)

		where := "1=1"
		var args []any
		n := 1

		// Stage filter — accepts a comma-separated list (multi-select) of stage tokens.
		if stageRaw != "" {
			var placeholders []string
			for _, part := range strings.Split(stageRaw, ",") {
				if st, ok := stageToStatus[strings.ToLower(strings.TrimSpace(part))]; ok {
					placeholders = append(placeholders, fmt.Sprintf("$%d", n))
					args = append(args, st)
					n++
				}
			}
			if len(placeholders) > 0 {
				where += " AND mp.status IN (" + strings.Join(placeholders, ",") + ")"
			}
		}
		if search != "" {
			where += fmt.Sprintf(" AND (mp.initiated_by_name ILIKE $%d OR mp.narrative ILIKE $%d)", n, n)
			args = append(args, "%"+search+"%")
			n++
		}
		if dateFrom != "" {
			where += fmt.Sprintf(" AND mp.created_at::date >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND mp.created_at::date <= $%d::date", n); args = append(args, dateTo); n++
		}
		args = append(args, limit)

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			  mp.id,
			  'MP-' || LPAD(mp.id::text, 5, '0') AS ref,
			  CASE WHEN mp.dr_account='SUSPENSE' THEN 'Credit' ELSE 'Debit' END AS type,
			  mp.amount_kobo,
			  CASE WHEN mp.dr_account='SUSPENSE' THEN mp.cr_account ELSE mp.dr_account END AS account,
			  mp.narrative AS description,
			  COALESCE(mp.initiated_by_name, '') AS initiated_by,
			  CASE mp.status WHEN 'pending' THEN 'pending_approval' ELSE mp.status END AS stage,
			  mp.workflow_template_id,
			  wt.name AS workflow_template_name,
			  COALESCE(wt.approver_roles, '{}') AS approver_roles,
			  COALESCE(wt.poster_roles,   '{}') AS poster_roles,
			  mp.approved_by_name AS approved_by,
			  mp.approved_at,
			  mp.posted_by_name   AS posted_by,
			  mp.posted_at,
			  mp.rejected_by_name AS rejected_by,
			  mp.rejected_at,
			  COALESCE(mp.rejection_reason, mp.return_reason) AS rejection_reason,
			  mp.created_at
			FROM manual_postings mp
			LEFT JOIN workflow_templates wt ON wt.id = mp.workflow_template_id
			WHERE %s
			ORDER BY mp.created_at DESC
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
			WorkflowTemplateID *int64 `json:"workflow_template_id"`
			Type               string `json:"type"`
			AmountKobo         int64  `json:"amount_kobo"`
			Account            string `json:"account"`
			Description        string `json:"description"`
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
			  (initiated_by, initiated_by_name, dr_account, cr_account, amount_kobo, narrative, status, workflow_template_id)
			VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
			RETURNING id, 'MP-'||LPAD(id::text,5,'0') AS ref, amount_kobo, created_at`,
			user.ID, user.FullName, drAccount, crAccount, b.AmountKobo, b.Description, b.WorkflowTemplateID)
		if err != nil {
			respondErr(w, 500, "Create failed: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

// soaManualPostingsApprove — step 2 of the 3-step workflow. Marks a pending
// posting 'approved'. NOTE: approval no longer writes the GL entry — that now
// happens at the separate "post" step (soaManualPostingsPost).
func soaManualPostingsApprove(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id   := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			UPDATE manual_postings
			SET status='approved', approved_by=$1, approved_by_name=$2,
			    approved_at=NOW(), updated_at=NOW()
			WHERE id=$3 AND status='pending'
			RETURNING id`,
			user.ID, user.FullName, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Posting not found or not pending")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "approved"}) //nolint:errcheck
	}
}

// soaManualPostingsPost — step 3. Transitions an approved posting to 'posted'
// and writes the double-entry GL journal. This is the only step that touches
// the ledger.
func soaManualPostingsPost(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id   := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())

		existing, err := db.PGQuery(r.Context(),
			`SELECT id, dr_account, cr_account, amount_kobo, narrative
			 FROM manual_postings WHERE id=$1 AND status='approved'`, id)
		if err != nil || len(existing) == 0 {
			respondErr(w, 404, "Posting not found or not approved")
			return
		}
		mp := existing[0]

		tx, err := db.PG.BeginTx(r.Context(), nil)
		if err != nil {
			respondErr(w, 500, "Transaction start failed")
			return
		}

		if _, err = tx.ExecContext(r.Context(), `
			UPDATE manual_postings
			SET status='posted', posted_by=$1, posted_by_name=$2,
			    posted_at=NOW(), updated_at=NOW()
			WHERE id=$3`,
			user.ID, user.FullName, id); err != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "Posting update failed")
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
		json.NewEncoder(w).Encode(map[string]string{"status": "posted"}) //nolint:errcheck
	}
}

// soaManualPostingsReturn — sends an approved posting back to the maker for
// revision (no GL impact).
func soaManualPostingsReturn(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id   := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		var b struct {
			Reason string `json:"reason"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		rows, err := db.PGQuery(r.Context(), `
			UPDATE manual_postings
			SET status='returned', returned_by=$1, returned_by_name=$2,
			    return_reason=$3, returned_at=NOW(), updated_at=NOW()
			WHERE id=$4 AND status='approved'
			RETURNING id`,
			user.ID, user.FullName, b.Reason, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Posting not found or not approved")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "returned"}) //nolint:errcheck
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
			SET status='rejected', rejected_by=$1, rejected_by_name=$2,
			    rejection_reason=$3, rejected_at=NOW(), updated_at=NOW()
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
			"interswitch": map[string]any{"configured": iswConfiguredWith(ctx, db)},
		}

		// Paystack channel — reflect real config, and when configured pull the live
		// wallet balance + open-dispute count (best-effort, short timeout so a slow
		// Paystack never blocks the settlements dashboard).
		if resolvePaystackKey(ctx, db) != "" {
			ps := map[string]any{
				"configured":          true,
				"wallet_balance_kobo": 0,
				"last_sync_at":        time.Now().UTC().Format(time.RFC3339),
				"open_disputes":       0,
			}
			pctx, cancel := context.WithTimeout(ctx, 8*time.Second)
			if bal, err := paystackFetch(pctx, db, "/balance", nil); err == nil {
				if data, ok := bal["data"].([]any); ok && len(data) > 0 {
					if m0, ok := data[0].(map[string]any); ok {
						ps["wallet_balance_kobo"] = toInt64(m0["balance"])
					}
				}
			}
			if dsp, err := paystackFetch(pctx, db, "/dispute", url.Values{"status": {"awaiting-merchant-feedback"}, "perPage": {"1"}}); err == nil {
				if meta, ok := dsp["meta"].(map[string]any); ok {
					ps["open_disputes"] = toInt64(meta["total"])
				}
			}
			cancel()
			out["paystack"] = ps
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
		// NOTE: statusP is an exception-status filter (open/resolved/…); it is
		// intentionally NOT applied to the batch query — settlement batches use a
		// different vocabulary (settled/pending/failed), so applying it here left
		// the Batch Summary tab empty by default.
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
		// Exception status filter — accepts a comma-separated list (multi-select).
		if statusP != "" {
			emap := map[string]string{"matched": "resolved", "exception": "escalated", "unmatched": "open"}
			var ph []string
			for _, part := range strings.Split(statusP, ",") {
				v := strings.ToLower(strings.TrimSpace(part))
				if v == "" {
					continue
				}
				if mapped, ok := emap[v]; ok {
					v = mapped
				}
				ph = append(ph, fmt.Sprintf("LOWER(e.status) = LOWER($%d)", en))
				eargs = append(eargs, v)
				en++
			}
			if len(ph) > 0 {
				ewhere += " AND (" + strings.Join(ph, " OR ") + ")"
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

/* ── NIP Bulk Resolve ────────────────────────────────────────────────────── */

func nipBulkResolve(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			IDs            []int64 `json:"ids"`
			ResolutionType string  `json:"resolution_type"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if len(b.IDs) == 0 {
			respondErr(w, 422, "ids must not be empty")
			return
		}
		user := core.UserFromCtx(r.Context())

		// Build a parameterized IN clause — pgx stdlib doesn't support slice args.
		phs := make([]string, len(b.IDs))
		args := make([]any, 0, len(b.IDs)+2)
		args = append(args, user.ID, b.ResolutionType)
		for i, id := range b.IDs {
			phs[i] = fmt.Sprintf("$%d", i+3)
			args = append(args, id)
		}
		updatedRows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			UPDATE settlement_exceptions
			SET status='resolved', resolved_by=$1, resolved_at=NOW(),
			    resolution_note=$2, updated_at=NOW()
			WHERE id IN (%s) AND status != 'resolved'
			RETURNING id`, strings.Join(phs, ",")), args...)
		if err != nil {
			respondErr(w, 500, "Bulk resolve failed: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"resolved": len(updatedRows)}) //nolint:errcheck
	}
}

/* ── NIP Recon Exception Resolve ─────────────────────────────────────────── */

func soaNIPReconResolve(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id   := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		var b struct {
			Note string `json:"note"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		rows, err := db.PGQuery(r.Context(), `
			UPDATE settlement_exceptions
			SET status='resolved', resolved_by=$1, resolved_at=NOW(),
			    resolution_note=$2, updated_at=NOW()
			WHERE id=$3 AND status != 'resolved'
			RETURNING id`, user.ID, b.Note, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Exception not found or already resolved")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true}) //nolint:errcheck
	}
}

// ensure sql import is used (BeginTx returns *sql.Tx)
var _ *sql.Tx
