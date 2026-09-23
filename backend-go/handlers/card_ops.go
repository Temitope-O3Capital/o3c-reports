package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
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
		// Card sale attribution (migration 241). Repeated here because this bootstrap is
		// what a fresh environment runs -- without it the two paths drift and a new box
		// comes up with an issuance table that cannot record who sold the card.
		`ALTER TABLE card_issuance_requests
		  ADD COLUMN IF NOT EXISTS sales_officer_id BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
		  ADD COLUMN IF NOT EXISTS introducer       TEXT NOT NULL DEFAULT '',
		  ADD COLUMN IF NOT EXISTS account_no       TEXT,
		  ADD COLUMN IF NOT EXISTS card_pan         TEXT`,
		`CREATE INDEX IF NOT EXISTS idx_card_iss_officer
		  ON card_issuance_requests(sales_officer_id) WHERE sales_officer_id IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_card_iss_account
		  ON card_issuance_requests(account_no) WHERE account_no IS NOT NULL`,
		`CREATE TABLE IF NOT EXISTS card_sale_attributions (
		  id               BIGSERIAL PRIMARY KEY,
		  account_no       TEXT NOT NULL UNIQUE,
		  cif              TEXT,
		  sales_officer_id BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
		  introducer       TEXT NOT NULL DEFAULT '',
		  basis_source     TEXT NOT NULL DEFAULT 'manual',
		  issuance_id      BIGINT REFERENCES card_issuance_requests(id) ON DELETE SET NULL,
		  note             TEXT NOT NULL DEFAULT '',
		  attributed_by    BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
		  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_card_sale_attr_officer
		  ON card_sale_attributions(sales_officer_id) WHERE sales_officer_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_card_sale_attr_cif
		  ON card_sale_attributions(cif) WHERE cif IS NOT NULL`,
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
		var req struct {
			Reason string `json:"reason"`
		}
		json.NewDecoder(r.Body).Decode(&req) //nolint:errcheck
		user := core.UserFromCtx(r.Context())
		_, err := db.PGExec(r.Context(),
			`INSERT INTO card_blocks (cif_number, blocked_by, reason) VALUES ($1, $2, $3)`,
			cif, user.ID, req.Reason)
		if err != nil {
			respondErr(w, 500, "block failed")
			return
		}
		aid, aname, ateam := actorOf(user)
		logActivitySafe(r.Context(), db, Activity{
			CIF: cif, ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "decision", Outcome: "blocked", Subject: "Card blocked", Body: req.Reason,
			Source: "card_ops", EntityType: "card", EntityID: cif,
		})
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
		aid, aname, ateam := actorOf(core.UserFromCtx(r.Context()))
		logActivitySafe(r.Context(), db, Activity{
			CIF: cif, ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "decision", Outcome: "unblocked", Subject: "Card unblocked",
			Source: "card_ops", EntityType: "card", EntityID: cif,
		})
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
		from := qstr(r, "from")
		to := qstr(r, "to")
		limit := qint(r, "limit", 100, 1, 500)

		// Columns are qualified with the i. alias now that o3c_users is joined: both
		// tables carry created_at, so an unqualified filter would be ambiguous.
		where := "1=1"
		args := []any{}
		n := 1

		if status != "" {
			where += fmt.Sprintf(" AND i.status=$%d", n)
			args = append(args, status)
			n++
		}
		if from != "" {
			where += fmt.Sprintf(" AND i.created_at::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			where += fmt.Sprintf(" AND i.created_at::date <= $%d::date", n)
			args = append(args, to)
			n++
		}
		args = append(args, limit)

		q := fmt.Sprintf(`SELECT i.id, 'ISS-' || LPAD(i.id::TEXT, 5, '0') AS ref,
		       i.cif_number, i.customer_name, i.card_type, i.status, i.introducer,
		       i.sales_officer_id, COALESCE(u.full_name, '') AS sales_officer_name,
		       TO_CHAR(i.created_at, 'YYYY-MM-DD') AS submitted_date,
		       EXTRACT(EPOCH FROM (NOW() - i.created_at))::INT / 86400 AS days_pending
		      FROM card_issuance_requests i
		      LEFT JOIN o3c_users u ON u.id = i.sales_officer_id
		      WHERE %s ORDER BY i.created_at DESC LIMIT $%d`, where, n)

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
			// Who sold it. Defaults to the person raising the request, which is the
			// common case; ops staff raising one for a walk-in set it explicitly.
			SalesOfficerID *int64 `json:"sales_officer_id"`
			// Free text, mirroring credit_applications.introducer: whoever brought the
			// business when they are not the booking officer. This is how staff outside
			// sales get credited without being handed a sales target.
			Introducer string `json:"introducer"`
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
		officerID := req.SalesOfficerID
		if officerID == nil {
			id := user.ID
			officerID = &id
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO card_issuance_requests
			       (cif_number, customer_name, card_type, notes, submitted_by, sales_officer_id, introducer)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING id, 'ISS-' || LPAD(id::TEXT, 5, '0') AS ref,
			          cif_number, customer_name, card_type, status, introducer,
			          TO_CHAR(created_at, 'YYYY-MM-DD') AS submitted_date, 0 AS days_pending`,
			req.CIFNumber, req.CustomerName, req.CardType, req.Notes, user.ID,
			officerID, req.Introducer)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "create failed")
			return
		}
		aid, aname, ateam := actorOf(user)
		logActivitySafe(r.Context(), db, Activity{
			CIF: req.CIFNumber, ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "note", Outcome: "raised",
			Subject: "Card issuance raised — " + req.CardType, Body: req.Notes,
			Source: "card_ops", EntityType: "card_issuance",
			EntityID: fmt.Sprintf("%v", rows[0]["id"]),
			Metadata: map[string]any{
				"card_type":        req.CardType,
				"sales_officer_id": officerID,
				"introducer":       req.Introducer,
			},
		})
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
		var req struct {
			Status string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		valid := map[string]bool{
			"doc_review": true, "credit_check": true, "risk_review": true,
			"approved": true, "rejected": true, "processing": true, "dispatched": true,
		}
		if !valid[req.Status] {
			respondErr(w, 400, "invalid status")
			return
		}
		// Terminal-state guard: a rejected or dispatched issuance is final and must not be
		// moved backwards; a missing id must 409, not report a phantom success.
		urows, err := db.PGQuery(r.Context(),
			`UPDATE card_issuance_requests SET status=$1, updated_at=NOW()
			 WHERE id=$2 AND status NOT IN ('rejected','dispatched')
			 RETURNING cif_number, card_type`,
			req.Status, id)
		if err != nil {
			respondErr(w, 500, "update failed")
			return
		}
		if len(urows) == 0 {
			respondErr(w, 409, "issuance not found or already in a terminal state")
			return
		}
		aid, aname, ateam := actorOf(core.UserFromCtx(r.Context()))
		logActivitySafe(r.Context(), db, Activity{
			CIF: str(urows[0]["cif_number"]), ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "stage_change", Outcome: req.Status,
			Subject: "Card issuance — " + req.Status, Source: "card_ops",
			EntityType: "card_issuance", EntityID: strconv.FormatInt(id, 10),
			Metadata: map[string]any{"card_type": str(urows[0]["card_type"])},
		})
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
		from := qstr(r, "from")
		to := qstr(r, "to")
		limit := qint(r, "limit", 100, 1, 500)

		where := "1=1"
		args := []any{}
		n := 1

		if status != "" {
			where += fmt.Sprintf(" AND status=$%d", n)
			args = append(args, status)
			n++
		}
		if from != "" {
			where += fmt.Sprintf(" AND filed_at::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			where += fmt.Sprintf(" AND filed_at::date <= $%d::date", n)
			args = append(args, to)
			n++
		}
		args = append(args, limit)

		q := fmt.Sprintf(`SELECT id, 'DSP-' || LPAD(id::TEXT, 4, '0') AS ref,
		       cif_number, customer_name, card_type, amount_kobo,
		       dispute_type, status,
		       TO_CHAR(filed_at, 'YYYY-MM-DD') AS filed_date,
		       EXTRACT(EPOCH FROM (NOW() - filed_at))::INT / 86400 AS days_open
		      FROM card_disputes
		      WHERE %s ORDER BY filed_at DESC LIMIT $%d`, where, n)

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
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()
		// The dispute row and its provisional-credit GL entry must land together: a
		// dispute that inserts but whose journal fails (or vice-versa) leaves the books
		// and the case out of step, with a retry creating a duplicate dispute. One
		// transaction makes it all-or-nothing.
		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "create failed")
			return
		}
		var newID int64
		if err := tx.QueryRowContext(ctx, `
			INSERT INTO card_disputes
			  (cif_number, customer_name, card_type, amount_kobo, dispute_type, notes)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING id`,
			req.CIFNumber, req.CustomerName, req.CardType,
			req.AmountKobo, req.DisputeType, req.Notes).Scan(&newID); err != nil {
			_ = tx.Rollback()
			respondErr(w, 500, "create failed")
			return
		}
		// C5: provisional credit GL entry for the dispute — same transaction.
		if req.AmountKobo > 0 {
			ref := fmt.Sprintf("DSP-%04d", newID)
			if glErr := postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   "Card dispute provisional credit - " + ref,
				Reference:     ref,
				DebitAccount:  "2300", // Card Dispute Suspense
				CreditAccount: "2200", // Card Liability - Customer Float
				AmountKobo:    req.AmountKobo,
				SourceType:    "card_dispute",
				SourceID:      newID,
				PostedBy:      user.ID,
			}); glErr != nil {
				_ = tx.Rollback()
				respondErr(w, 500, "GL entry failed: "+glErr.Error())
				return
			}
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "create failed")
			return
		}
		// Project the persisted row for the response (post-commit; same shape as the list).
		rows, qErr := db.PGQuery(ctx, `
			SELECT id, 'DSP-' || LPAD(id::TEXT, 4, '0') AS ref,
			       cif_number, customer_name, card_type, amount_kobo,
			       dispute_type, status,
			       TO_CHAR(filed_at, 'YYYY-MM-DD') AS filed_date, 0 AS days_open
			FROM card_disputes WHERE id=$1`, newID)
		NotifyRoles(ctx, db, []string{"cards_ops_officer", "cards_ops_head"}, NotifPayload{
			EventType: EvtCardDisputeFiled,
			Title:     "New Card Dispute Filed",
			Body:      fmt.Sprintf("DSP-%d — %s for %s (%s)", newID, req.DisputeType, req.CustomerName, req.CardType),
			ActionURL: "/cards/disputes",
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		if qErr != nil || len(rows) == 0 {
			// The dispute is committed; only the response projection failed.
			json.NewEncoder(w).Encode(map[string]any{"id": newID, "status": "open"}) //nolint:errcheck
			return
		}
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
		var req struct {
			Status string `json:"status"`
		}
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
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		// The status change and the chargeback-outcome journal must commit together. The
		// old code committed the terminal status first, then posted the journal separately;
		// a journal failure returned 500 while the dispute was already 'resolved', and the
		// terminal-state guard then made the retry a no-op — so the customer payout journal
		// (dispute_suspense → cash) was silently never posted. One transaction fixes that.
		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "update failed")
			return
		}
		// Guard: prevent re-advancing already-terminal disputes (race-safe via WHERE).
		var updID, disputeAmount int64
		var cif string
		err = tx.QueryRowContext(ctx,
			fmt.Sprintf(`UPDATE card_disputes SET status=$1%s, updated_at=NOW()
			 WHERE id=$2 AND status NOT IN ('resolved','declined')
			 RETURNING id, amount_kobo, cif_number`, resolvedClause),
			req.Status, id).Scan(&updID, &disputeAmount, &cif)
		if err == sql.ErrNoRows {
			_ = tx.Rollback()
			respondErr(w, 409, "dispute is already in a terminal state")
			return
		}
		if err != nil {
			_ = tx.Rollback()
			respondErr(w, 500, "update failed")
			return
		}
		// C6: GL entry for chargeback outcome — same transaction.
		if disputeAmount > 0 && (req.Status == "resolved" || req.Status == "declined") {
			ref := fmt.Sprintf("DSP-%04d", id)
			var drAcct, crAcct string
			if req.Status == "resolved" {
				// Customer wins: pay out from suspense.
				// 2300 Card Dispute Suspense → 1001 Cash / Bank
				drAcct, crAcct = "2300", "1001"
			} else {
				// Dispute declined (bank wins): reverse the provisional credit.
				// 2200 Card Liability - Customer Float → 2300 Card Dispute Suspense
				drAcct, crAcct = "2200", "2300"
			}
			if glErr := postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   fmt.Sprintf("Card dispute %s - %s", req.Status, ref),
				Reference:     ref,
				DebitAccount:  drAcct,
				CreditAccount: crAcct,
				AmountKobo:    disputeAmount,
				SourceType:    "card_dispute_resolution",
				SourceID:      id,
				PostedBy:      user.ID,
			}); glErr != nil {
				_ = tx.Rollback()
				respondErr(w, 500, "GL entry failed: "+glErr.Error())
				return
			}
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "update failed")
			return
		}
		// Activity log is best-effort and non-critical — record it after the commit.
		aid, aname, ateam := actorOf(user)
		logActivitySafe(ctx, db, Activity{
			CIF: cif, ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "stage_change", Outcome: req.Status, Subject: "Card dispute — " + req.Status,
			Source: "card_ops", EntityType: "card_dispute", EntityID: strconv.FormatInt(id, 10),
			Metadata: map[string]any{"amount_kobo": disputeAmount},
		})
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
		from := qstr(r, "from")
		to := qstr(r, "to")
		limit := qint(r, "limit", 100, 1, 500)

		where := "1=1"
		args := []any{}
		n := 1

		if status != "" {
			where += fmt.Sprintf(" AND status=$%d", n)
			args = append(args, status)
			n++
		}
		if from != "" {
			where += fmt.Sprintf(" AND created_at::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			where += fmt.Sprintf(" AND created_at::date <= $%d::date", n)
			args = append(args, to)
			n++
		}
		args = append(args, limit)

		q := fmt.Sprintf(`SELECT id, 'CLR-' || LPAD(id::TEXT, 4, '0') AS ref,
		       cif_number, customer_name, card_type,
		       current_limit_kobo, proposed_limit_kobo,
		       utilization_pct, eye_score, status, recommended_by,
		       TO_CHAR(created_at, 'YYYY-MM-DD') AS submitted_date
		      FROM card_credit_limit_reviews
		      WHERE %s ORDER BY created_at DESC LIMIT $%d`, where, n)

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
		var req struct {
			Decision string `json:"decision"`
		}
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
			 RETURNING id, customer_name, card_type, proposed_limit_kobo, cif_number`,
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
				EventType: EvtCreditLimitApproved,
				Title:     "Credit Limit Change Approved",
				Body:      fmt.Sprintf("CLR-%d — %s (%s) new limit approved", id, res[0]["customer_name"], res[0]["card_type"]),
				ActionURL: "/cards/credit-limits",
			})
		}
		{
			aid, aname, ateam := actorOf(user)
			logActivitySafe(r.Context(), db, Activity{
				CIF: str(res[0]["cif_number"]), ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
				Type: "decision", Outcome: req.Decision, Subject: "Credit-limit review — " + req.Decision,
				Source: "card_ops", EntityType: "card_limit_review", EntityID: strconv.FormatInt(id, 10),
				Metadata: map[string]any{"proposed_limit_kobo": toInt64(res[0]["proposed_limit_kobo"]), "card_type": str(res[0]["card_type"])},
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
		from := qstr(r, "from")
		to := qstr(r, "to")

		where := "1=1"
		args := []any{}
		n := 1

		if from != "" {
			where += fmt.Sprintf(" AND cycle_start >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			where += fmt.Sprintf(" AND cycle_start <= $%d::date", n)
			args = append(args, to)
			n++
		}
		args = append(args, 60)

		q := fmt.Sprintf(`SELECT id, product,
			       TO_CHAR(cycle_start, 'YYYY-MM-DD') AS cycle_start,
			       TO_CHAR(cycle_end,   'YYYY-MM-DD') AS cycle_end,
			       accounts_count, total_balance_kobo, statements_generated, status
			FROM card_billing_cycles
			WHERE %s
			ORDER BY cycle_start DESC, product ASC
			LIMIT $%d`, where, n)

		rows, err := db.PGQuery(r.Context(), q, args...)
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
		// Anchor the billing month to West Africa Time, not UTC: run just after midnight
		// on the 1st in Lagos and UTC is still on the last day of the prior month, which
		// would generate the wrong period.
		now := time.Now().In(mrWAT)
		cycleStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, mrWAT)
		cycleEnd := cycleStart.AddDate(0, 1, -1)

		// H7: idempotency check — block if cycles for this period already exist
		existRows, _ := db.PGQuery(r.Context(),
			`SELECT COUNT(*) AS cnt FROM card_billing_cycles WHERE cycle_start = $1`,
			cycleStart.Format("2006-01-02"))
		if len(existRows) > 0 && toInt64(existRows[0]["cnt"]) > 0 {
			respondErr(w, 409, "Billing cycles already exist for this period")
			return
		}

		type result struct {
			Product string `json:"product"`
			Count   any    `json:"accounts_count"`
		}
		var results []result

		// Products come from the catalogue, not a literal.
		//
		// This used to iterate {"PREP","Amex Naira","Amex USD","Classic Accounts"}.
		// Two of those (Amex Naira 001, Amex USD 002) are is_active=false legacy
		// system_names, so a cycle was generated every month for dead products
		// while six live ones — BB Classic, Business, Corporate, Financial
		// Inclusion, Platinum, Prestige — got none at all.
		//
		// app.accounts.product_name holds the legacy system_name, so the account
		// count matches on that while the cycle row records the canonical name.
		prodRows, perr := db.PGQuery(r.Context(), `
			SELECT product_name,
			       COALESCE(NULLIF(system_name, ''), product_name) AS match_name
			  FROM app.card_products
			 WHERE is_active
			 ORDER BY product_name`)
		if perr != nil {
			respondErr(w, 500, "product catalogue unavailable: "+perr.Error())
			return
		}
		if len(prodRows) == 0 {
			respondErr(w, 500, "no active card products in the catalogue")
			return
		}

		for _, p := range prodRows {
			product := str(p["product_name"])
			count, _, _ := db.DualScalar(r.Context(), "val",
				`SELECT COUNT(*) AS val FROM app.accounts WHERE product_name = $1`,
				str(p["match_name"]))

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
			EventType: EvtBillingCycleGenerated,
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
