package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// ── Schema ────────────────────────────────────────────────────────────────────

func ensureCardOpsSchema(ctx context.Context, db *core.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS card_blocks (
		  id BIGSERIAL PRIMARY KEY,
		  cif_number TEXT NOT NULL,
		  blocked_by BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
		  reason TEXT NOT NULL DEFAULT '',
		  is_blocked BOOLEAN NOT NULL DEFAULT TRUE,
		  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  unblocked_at TIMESTAMPTZ
		)`,
		`CREATE INDEX IF NOT EXISTS idx_card_blocks_cif ON card_blocks(cif_number, is_blocked)`,
		`CREATE TABLE IF NOT EXISTS card_issuance_requests (
		  id BIGSERIAL PRIMARY KEY,
		  cif_number TEXT NOT NULL DEFAULT '',
		  customer_name TEXT NOT NULL DEFAULT '',
		  card_type TEXT NOT NULL DEFAULT '',
		  notes TEXT NOT NULL DEFAULT '',
		  status TEXT NOT NULL DEFAULT 'pending',
		  submitted_by BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
		  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_card_iss_status ON card_issuance_requests(status, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS card_disputes (
		  id BIGSERIAL PRIMARY KEY,
		  cif_number TEXT NOT NULL DEFAULT '',
		  customer_name TEXT NOT NULL DEFAULT '',
		  card_type TEXT NOT NULL DEFAULT '',
		  amount_kobo BIGINT NOT NULL DEFAULT 0,
		  dispute_type TEXT NOT NULL DEFAULT '',
		  notes TEXT NOT NULL DEFAULT '',
		  status TEXT NOT NULL DEFAULT 'filed',
		  filed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  resolved_at TIMESTAMPTZ
		)`,
		`CREATE INDEX IF NOT EXISTS idx_card_dsp_status ON card_disputes(status, filed_at DESC)`,
		`CREATE TABLE IF NOT EXISTS card_credit_limit_reviews (
		  id BIGSERIAL PRIMARY KEY,
		  cif_number TEXT NOT NULL DEFAULT '',
		  customer_name TEXT NOT NULL DEFAULT '',
		  card_type TEXT NOT NULL DEFAULT '',
		  current_limit_kobo BIGINT NOT NULL DEFAULT 0,
		  proposed_limit_kobo BIGINT NOT NULL DEFAULT 0,
		  utilization_pct INT NOT NULL DEFAULT 0,
		  eye_score INT NOT NULL DEFAULT 0,
		  notes TEXT NOT NULL DEFAULT '',
		  status TEXT NOT NULL DEFAULT 'pending_review',
		  recommended_by TEXT NOT NULL DEFAULT '',
		  decided_by BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
		  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_card_clr_status ON card_credit_limit_reviews(status, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS card_billing_cycles (
		  id BIGSERIAL PRIMARY KEY,
		  product TEXT NOT NULL,
		  cycle_start DATE NOT NULL,
		  cycle_end DATE NOT NULL,
		  accounts_count INT NOT NULL DEFAULT 0,
		  total_balance_kobo BIGINT NOT NULL DEFAULT 0,
		  statements_generated INT NOT NULL DEFAULT 0,
		  status TEXT NOT NULL DEFAULT 'open',
		  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  UNIQUE(product, cycle_start)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_card_billing ON card_billing_cycles(cycle_start DESC)`,
	}
	for _, stmt := range stmts {
		if _, err := db.PGExec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

// writeJSON encodes v directly with no wrapper — frontend reads it as-is.
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

// ── Block / Unblock ───────────────────────────────────────────────────────────

func cardBlockCardholder(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		var req struct{ Reason string `json:"reason"` }
		json.NewDecoder(r.Body).Decode(&req) //nolint:errcheck
		user := core.UserFromCtx(r.Context())
		_, err := db.PGExec(r.Context(),
			`INSERT INTO card_blocks (cif_number, blocked_by, reason) VALUES ($1, $2, $3)`,
			cif, user.ID, req.Reason)
		if err != nil {
			respondErr(w, 500, "block failed")
			return
		}
		writeJSON(w, map[string]any{"blocked": true, "cif": cif})
	}
}

func cardUnblockCardholder(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		_, err := db.PGExec(r.Context(),
			`UPDATE card_blocks SET is_blocked = FALSE, unblocked_at = NOW()
			 WHERE cif_number = $1 AND is_blocked = TRUE`, cif)
		if err != nil {
			respondErr(w, 500, "unblock failed")
			return
		}
		writeJSON(w, map[string]any{"blocked": false, "cif": cif})
	}
}

// ── Issuance ──────────────────────────────────────────────────────────────────

func cardListIssuance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		status := qstr(r, "status")
		limit := qint(r, "limit", 100, 1, 500)

		q := `SELECT id, 'ISS-' || LPAD(id::TEXT, 5, '0') AS ref,
		       cif_number, customer_name, card_type, status,
		       TO_CHAR(created_at, 'YYYY-MM-DD') AS submitted_date,
		       EXTRACT(EPOCH FROM (NOW() - created_at))::INT / 86400 AS days_pending
		      FROM card_issuance_requests`
		args := []any{}
		if status != "" {
			q += ` WHERE status = $1 ORDER BY created_at DESC LIMIT $2`
			args = append(args, status, limit)
		} else {
			q += ` ORDER BY created_at DESC LIMIT $1`
			args = append(args, limit)
		}

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "query failed")
			return
		}
		writeJSON(w, rows)
	}
}

func cardCreateIssuance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		var req struct {
			CIFNumber    string `json:"cif_number"`
			CustomerName string `json:"customer_name"`
			CardType     string `json:"card_type"`
			Notes        string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		if req.CustomerName == "" {
			respondErr(w, 400, "customer_name required")
			return
		}
		if req.CardType == "" {
			respondErr(w, 400, "card_type required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO card_issuance_requests (cif_number, customer_name, card_type, notes, submitted_by)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, 'ISS-' || LPAD(id::TEXT, 5, '0') AS ref,
			          cif_number, customer_name, card_type, status,
			          TO_CHAR(created_at, 'YYYY-MM-DD') AS submitted_date, 0 AS days_pending`,
			req.CIFNumber, req.CustomerName, req.CardType, req.Notes, user.ID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func cardAdvanceIssuance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "invalid id")
			return
		}
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		var req struct{ Status string `json:"status"` }
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		valid := map[string]bool{"approved": true, "rejected": true, "processing": true, "dispatched": true}
		if !valid[req.Status] {
			respondErr(w, 400, "invalid status")
			return
		}
		if _, err := db.PGExec(r.Context(),
			`UPDATE card_issuance_requests SET status=$1, updated_at=NOW() WHERE id=$2`,
			req.Status, id); err != nil {
			respondErr(w, 500, "update failed")
			return
		}
		writeJSON(w, map[string]any{"id": id, "status": req.Status})
	}
}

// ── Disputes ──────────────────────────────────────────────────────────────────

func cardListDisputes(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		status := qstr(r, "status")
		limit := qint(r, "limit", 100, 1, 500)

		q := `SELECT id, 'DSP-' || LPAD(id::TEXT, 4, '0') AS ref,
		       cif_number, customer_name, card_type, amount_kobo,
		       dispute_type, status,
		       TO_CHAR(filed_at, 'YYYY-MM-DD') AS filed_date,
		       EXTRACT(EPOCH FROM (NOW() - filed_at))::INT / 86400 AS days_open
		      FROM card_disputes`
		args := []any{}
		if status != "" {
			q += ` WHERE status = $1 ORDER BY filed_at DESC LIMIT $2`
			args = append(args, status, limit)
		} else {
			q += ` ORDER BY filed_at DESC LIMIT $1`
			args = append(args, limit)
		}

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "query failed")
			return
		}
		writeJSON(w, rows)
	}
}

func cardCreateDispute(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		var req struct {
			CIFNumber    string `json:"cif_number"`
			CustomerName string `json:"customer_name"`
			CardType     string `json:"card_type"`
			AmountKobo   int64  `json:"amount_kobo"`
			DisputeType  string `json:"dispute_type"`
			Notes        string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		if req.CustomerName == "" || req.DisputeType == "" {
			respondErr(w, 400, "customer_name and dispute_type required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO card_disputes
			  (cif_number, customer_name, card_type, amount_kobo, dispute_type, notes)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING id, 'DSP-' || LPAD(id::TEXT, 4, '0') AS ref,
			          cif_number, customer_name, card_type, amount_kobo,
			          dispute_type, status,
			          TO_CHAR(filed_at, 'YYYY-MM-DD') AS filed_date, 0 AS days_open`,
			req.CIFNumber, req.CustomerName, req.CardType,
			req.AmountKobo, req.DisputeType, req.Notes)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "create failed")
			return
		}
		NotifyRoles(r.Context(), db, []string{"cards_ops_officer", "cards_ops_head"}, NotifPayload{
			EventType: "card_dispute_filed",
			Title:     "New Card Dispute Filed",
			Body:      fmt.Sprintf("DSP-%v — %s for %s (%s)", rows[0]["id"], req.DisputeType, req.CustomerName, req.CardType),
			ActionURL: "/cards/disputes",
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func cardAdvanceDispute(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "invalid id")
			return
		}
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		var req struct{ Status string `json:"status"` }
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		valid := map[string]bool{
			"investigating": true, "provisional_credit": true, "resolved": true, "declined": true,
		}
		if !valid[req.Status] {
			respondErr(w, 400, "invalid status")
			return
		}
		resolvedClause := ""
		if req.Status == "resolved" || req.Status == "declined" {
			resolvedClause = ", resolved_at = NOW()"
		}
		// Guard: prevent re-advancing already-terminal disputes (race-safe via WHERE).
		res, err := db.PGQuery(r.Context(),
			fmt.Sprintf(`UPDATE card_disputes SET status=$1%s, updated_at=NOW()
			 WHERE id=$2 AND status NOT IN ('resolved','declined')
			 RETURNING id`, resolvedClause),
			req.Status, id)
		if err != nil {
			respondErr(w, 500, "update failed")
			return
		}
		if len(res) == 0 {
			respondErr(w, 409, "dispute is already in a terminal state")
			return
		}
		writeJSON(w, map[string]any{"id": id, "status": req.Status})
	}
}

// ── Credit Limit Reviews ──────────────────────────────────────────────────────

func cardListCreditLimits(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		status := qstr(r, "status")
		limit := qint(r, "limit", 100, 1, 500)

		q := `SELECT id, 'CLR-' || LPAD(id::TEXT, 4, '0') AS ref,
		       cif_number, customer_name, card_type,
		       current_limit_kobo, proposed_limit_kobo,
		       utilization_pct, eye_score, status, recommended_by,
		       TO_CHAR(created_at, 'YYYY-MM-DD') AS submitted_date
		      FROM card_credit_limit_reviews`
		args := []any{}
		if status != "" {
			q += ` WHERE status = $1 ORDER BY created_at DESC LIMIT $2`
			args = append(args, status, limit)
		} else {
			q += ` ORDER BY created_at DESC LIMIT $1`
			args = append(args, limit)
		}

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "query failed")
			return
		}
		writeJSON(w, rows)
	}
}

func cardCreateCreditLimit(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		var req struct {
			CIFNumber         string `json:"cif_number"`
			CustomerName      string `json:"customer_name"`
			CardType          string `json:"card_type"`
			CurrentLimitKobo  int64  `json:"current_limit_kobo"`
			ProposedLimitKobo int64  `json:"proposed_limit_kobo"`
			UtilizationPct    int    `json:"utilization_pct"`
			EyeScore          int    `json:"eye_score"`
			Notes             string `json:"notes"`
			RecommendedBy     string `json:"recommended_by"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		if req.CustomerName == "" {
			respondErr(w, 400, "customer_name required")
			return
		}
		recommendedBy := req.RecommendedBy
		if recommendedBy == "" {
			if u := core.UserFromCtx(r.Context()); u != nil {
				recommendedBy = u.FullName
			}
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO card_credit_limit_reviews
			  (cif_number, customer_name, card_type, current_limit_kobo, proposed_limit_kobo,
			   utilization_pct, eye_score, notes, recommended_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			RETURNING id, 'CLR-' || LPAD(id::TEXT, 4, '0') AS ref,
			          cif_number, customer_name, card_type,
			          current_limit_kobo, proposed_limit_kobo,
			          utilization_pct, eye_score, status, recommended_by,
			          TO_CHAR(created_at, 'YYYY-MM-DD') AS submitted_date`,
			req.CIFNumber, req.CustomerName, req.CardType,
			req.CurrentLimitKobo, req.ProposedLimitKobo,
			req.UtilizationPct, req.EyeScore, req.Notes, recommendedBy)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func cardDecideCreditLimit(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "invalid id")
			return
		}
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		var req struct{ Decision string `json:"decision"` }
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		valid := map[string]bool{"recommended": true, "approved": true, "declined": true}
		if !valid[req.Decision] {
			respondErr(w, 400, "decision must be recommended, approved, or declined")
			return
		}
		user := core.UserFromCtx(r.Context())
		// Guard: prevent overwriting an already-decided review (race-safe via WHERE).
		res, err := db.PGQuery(r.Context(),
			`UPDATE card_credit_limit_reviews SET status=$1, decided_by=$2, updated_at=NOW()
			 WHERE id=$3 AND status NOT IN ('approved','declined')
			 RETURNING id, customer_name, card_type, proposed_limit_kobo`,
			req.Decision, user.ID, id)
		if err != nil {
			respondErr(w, 500, "update failed")
			return
		}
		if len(res) == 0 {
			respondErr(w, 409, "review has already been decided")
			return
		}
		if req.Decision == "approved" {
			NotifyRoles(r.Context(), db, []string{"cards_ops_officer", "cards_ops_head"}, NotifPayload{
				EventType: "credit_limit_approved",
				Title:     "Credit Limit Change Approved",
				Body:      fmt.Sprintf("CLR-%d — %s (%s) new limit approved", id, res[0]["customer_name"], res[0]["card_type"]),
				ActionURL: "/cards/credit-limits",
			})
		}
		writeJSON(w, map[string]any{"id": id, "status": req.Decision})
	}
}

// ── Billing Cycles ────────────────────────────────────────────────────────────

func cardListBilling(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, product,
			       TO_CHAR(cycle_start, 'YYYY-MM-DD') AS cycle_start,
			       TO_CHAR(cycle_end,   'YYYY-MM-DD') AS cycle_end,
			       accounts_count, total_balance_kobo, statements_generated, status
			FROM card_billing_cycles
			ORDER BY cycle_start DESC, product ASC
			LIMIT 60`)
		if err != nil {
			respondErr(w, 500, "query failed")
			return
		}
		writeJSON(w, rows)
	}
}

func cardGenerateBilling(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		now := time.Now().UTC()
		cycleStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
		cycleEnd := cycleStart.AddDate(0, 1, -1)

		type result struct {
			Product string `json:"product"`
			Count   any    `json:"accounts_count"`
		}
		var results []result

		for _, product := range []string{"PREP", "Amex Naira", "Amex USD", "Classic Accounts"} {
			var f Filter
			f.Eq(" AND Product_Name=?", ` AND "Product Name"=?`, product)
			count, _, _ := db.DualScalar(r.Context(), "val",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE 1=1%s", f.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Products" WHERE 1=1%s`, f.PG()),
				f.Args()...)

			_, err := db.PGExec(r.Context(), `
				INSERT INTO card_billing_cycles (product, cycle_start, cycle_end, accounts_count)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (product, cycle_start) DO UPDATE
				  SET accounts_count = EXCLUDED.accounts_count, updated_at = NOW()`,
				product,
				cycleStart.Format("2006-01-02"),
				cycleEnd.Format("2006-01-02"),
				count)
			if err != nil {
				respondErr(w, 500, "create cycle failed: "+err.Error())
				return
			}
			results = append(results, result{Product: product, Count: count})
		}
		NotifyRole(r.Context(), db, "finance_head", NotifPayload{
			EventType: "billing_cycle_generated",
			Title:     "Billing Cycles Generated",
			Body:      fmt.Sprintf("Card billing cycles for %s generated across %d products", cycleStart.Format("January 2006"), len(results)),
			ActionURL: "/cards/billing",
		})
		writeJSON(w, results)
	}
}

// ── Block log ─────────────────────────────────────────────────────────────────

func cardBlockLog(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT cb.id, cb.cif_number, cb.reason, cb.is_blocked,
			       cb.created_at, cb.unblocked_at,
			       u.full_name AS blocked_by_name
			FROM card_blocks cb
			LEFT JOIN o3c_users u ON u.id = cb.blocked_by
			WHERE cb.cif_number = $1
			ORDER BY cb.created_at DESC
			LIMIT 50`, cif)
		if err != nil {
			respondErr(w, 500, "query failed")
			return
		}
		writeJSON(w, map[string]any{"data": rows})
	}
}
