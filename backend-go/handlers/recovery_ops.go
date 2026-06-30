package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterRecoveryOps(r chi.Router, db *core.DB) {
	base := core.RequirePages("recovery")
	assign := core.RequirePages("recovery_assign")
	writeOff := core.RequirePages("recovery_write_off")

	r.With(base).Get("/cases", recoveryOpsCases(db))
	r.With(base).Get("/cases/{id}", recoveryOpsCaseDetail(db))
	r.With(assign).Put("/cases/{id}/assign", recoveryOpsAssign(db))
	r.With(base).Post("/cases/{id}/payment", recoveryOpsPayment(db))
	r.With(base).Post("/cases/{id}/legal", recoveryOpsAddLegal(db))
	r.With(base).Put("/legal/{lid}/status", recoveryOpsUpdateLegal(db))
	r.With(base).Get("/visits", recoveryOpsVisitsList(db))
	r.With(base).Post("/cases/{id}/visit", recoveryOpsVisit(db))
	r.With(base).Post("/cases/{id}/write-off", recoveryOpsWriteOff(db))
	r.With(writeOff).Put("/write-off/{wid}/approve", recoveryOpsApproveWriteOff(db))
	r.With(writeOff).Put("/write-off/{wid}/reject", recoveryOpsRejectWriteOff(db))
	r.With(base).Get("/dashboard", recoveryOpsDashboard(db))
}

func recoveryOpsCases(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		legalStage := qstr(r, "legal_stage")
		agentID := qstr(r, "agent_id")
		q := qstr(r, "q")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `
			SELECT rc.id, rc.case_ref, rc.account_cif, rc.assigned_agent_id,
			       u.full_name AS agent_name, rc.assigned_by, rc.legal_stage,
			       rc.outstanding_kobo, rc.recovered_kobo, rc.write_off_amount_kobo,
			       rc.status, rc.opened_at, rc.closed_at, rc.created_at, rc.updated_at
			FROM recovery_cases rc
			LEFT JOIN o3c_users u ON rc.assigned_agent_id = u.id
			WHERE 1=1`
		args := []any{}
		n := 1

		if status != "" {
			query += fmt.Sprintf(" AND rc.status = $%d", n)
			args = append(args, status)
			n++
		}
		if legalStage != "" {
			query += fmt.Sprintf(" AND rc.legal_stage = $%d", n)
			args = append(args, legalStage)
			n++
		}
		if agentID != "" {
			query += fmt.Sprintf(" AND rc.assigned_agent_id = $%d", n)
			args = append(args, agentID)
			n++
		}
		if q != "" {
			query += fmt.Sprintf(" AND rc.account_cif ILIKE $%d", n)
			args = append(args, "%"+q+"%")
			n++
		}

		query += fmt.Sprintf(" ORDER BY rc.updated_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func recoveryOpsCaseDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		ctx := r.Context()

		cases, err := db.PGQuery(ctx, `
			SELECT rc.*, u.full_name AS agent_name
			FROM recovery_cases rc
			LEFT JOIN o3c_users u ON rc.assigned_agent_id = u.id
			WHERE rc.id = $1`, id)
		if err != nil || len(cases) == 0 {
			respondErr(w, 404, "Case not found")
			return
		}

		payments, _ := db.PGQuery(ctx, `
			SELECT * FROM recovery_payments WHERE case_id = $1 ORDER BY payment_date DESC`, id)
		proceedings, _ := db.PGQuery(ctx, `
			SELECT * FROM legal_proceedings WHERE case_id = $1 ORDER BY filing_date DESC`, id)
		visits, _ := db.PGQuery(ctx, `
			SELECT rfv.*, u.full_name AS agent_name
			FROM recovery_field_visits rfv
			LEFT JOIN o3c_users u ON rfv.agent_user_id = u.id
			WHERE rfv.case_id = $1 ORDER BY rfv.visit_date DESC`, id)
		writeoffs, _ := db.PGQuery(ctx, `
			SELECT * FROM recovery_write_off_approvals WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`, id)

		nilToEmpty := func(rows []core.Row) []core.Row {
			if rows == nil {
				return []core.Row{}
			}
			return rows
		}

		result := map[string]any{
			"case":        cases[0],
			"payments":    nilToEmpty(payments),
			"proceedings": nilToEmpty(proceedings),
			"visits":      nilToEmpty(visits),
		}
		if len(writeoffs) > 0 {
			result["write_off_approval"] = writeoffs[0]
		} else {
			result["write_off_approval"] = nil
		}

		respond(w, result, "pg")
	}
}

func recoveryOpsAssign(db *core.DB) http.HandlerFunc {
	type body struct {
		AgentID int64  `json:"agent_id"`
		Notes   string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AgentID == 0 {
			respondErr(w, 422, "agent_id is required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		rows, err := db.PGQuery(ctx, `SELECT id FROM recovery_cases WHERE id = $1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Case not found")
			return
		}

		_, err = db.PGExec(ctx, `
			UPDATE recovery_cases
			SET assigned_agent_id = $1, assigned_by = $2, updated_at = NOW()
			WHERE id = $3`,
			b.AgentID, user.ID, id)
		if err != nil {
			respondErr(w, 500, "Assign failed")
			return
		}

		sendNotification(ctx, db, b.AgentID, "recovery_assigned", //nolint:errcheck
			"Recovery Case Assigned",
			fmt.Sprintf("A recovery case has been assigned to you"),
			"recovery_case", id)

		respondErr(w, 200, "Assigned successfully")
	}
}

func recoveryOpsPayment(db *core.DB) http.HandlerFunc {
	type body struct {
		AmountKobo  int64  `json:"amount_kobo"`
		PaymentDate string `json:"payment_date"`
		Channel     string `json:"channel"`
		Reference   string `json:"reference"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AmountKobo == 0 || b.PaymentDate == "" || b.Channel == "" {
			respondErr(w, 422, "amount_kobo, payment_date and channel are required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Wrap INSERT + UPDATE in a transaction so neither can succeed without the other
		tx, err := db.PG.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
		if err != nil {
			respondErr(w, 500, "Transaction start failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		var payID int64
		var payDate, payChannel, payRef, createdAt any
		err = tx.QueryRowContext(ctx, `
			INSERT INTO recovery_payments (case_id, amount_kobo, payment_date, channel, reference, posted_by, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, NOW())
			RETURNING id, amount_kobo, payment_date, channel, reference, created_at`,
			id, b.AmountKobo, b.PaymentDate, b.Channel, b.Reference, user.ID,
		).Scan(&payID, &b.AmountKobo, &payDate, &payChannel, &payRef, &createdAt)
		if err != nil {
			respondErr(w, 500, "Log payment failed")
			return
		}

		_, err = tx.ExecContext(ctx, `
			UPDATE recovery_cases
			SET total_recovered_kobo = total_recovered_kobo + $1, updated_at = NOW()
			WHERE id = $2`,
			b.AmountKobo, id)
		if err != nil {
			respondErr(w, 500, "Update recovered total failed")
			return
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		respond(w, core.Row{
			"id":          payID,
			"amount_kobo": b.AmountKobo,
			"payment_date": payDate,
			"channel":     payChannel,
			"reference":   payRef,
			"created_at":  createdAt,
		}, "pg")
	}
}

func recoveryOpsAddLegal(db *core.DB) http.HandlerFunc {
	type body struct {
		ProceedingType  string `json:"proceeding_type"`
		CourtName       string `json:"court_name"`
		CaseNumber      string `json:"case_number"`
		FilingDate      string `json:"filing_date"`
		NextHearingDate string `json:"next_hearing_date"`
		Notes           string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ProceedingType == "" || b.FilingDate == "" {
			respondErr(w, 422, "proceeding_type and filing_date are required")
			return
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO legal_proceedings
				(case_id, proceeding_type, court_name, case_number, filing_date, next_hearing_date, status, notes, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, NOW())
			RETURNING id, proceeding_type, court_name, case_number, filing_date, next_hearing_date, status, created_at`,
			id, b.ProceedingType, b.CourtName, b.CaseNumber, b.FilingDate, b.NextHearingDate, b.Notes)
		if err != nil {
			respondErr(w, 500, "Add legal proceeding failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func recoveryOpsUpdateLegal(db *core.DB) http.HandlerFunc {
	type body struct {
		Status          string `json:"status"`
		NextHearingDate string `json:"next_hearing_date"`
		Notes           string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		lid, err := strconv.ParseInt(chi.URLParam(r, "lid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid proceeding ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Status == "" {
			respondErr(w, 422, "status is required")
			return
		}

		_, err = db.PGExec(r.Context(), `
			UPDATE legal_proceedings
			SET status = $1, next_hearing_date = $2, notes = $3
			WHERE id = $4`,
			b.Status, b.NextHearingDate, b.Notes, lid)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		respondErr(w, 200, "Legal proceeding updated")
	}
}

func recoveryOpsVisitsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		visitType := qstr(r, "visit_type")
		outcome   := qstr(r, "outcome")
		agentID   := qstr(r, "agent_id")
		dateFrom  := qstr(r, "date_from")
		dateTo    := qstr(r, "date_to")
		limit     := qint(r, "limit", 50, 1, 200)
		offset    := qint(r, "offset", 0, 0, 1<<30)

		query := `
			SELECT rfv.id, rfv.case_id, rc.case_ref, rfv.agent_user_id,
			       u.full_name AS agent_name, rfv.visit_date, rfv.visit_type,
			       rfv.outcome, rfv.notes, rfv.created_at
			FROM recovery_field_visits rfv
			LEFT JOIN recovery_cases rc ON rfv.case_id = rc.id
			LEFT JOIN o3c_users u ON rfv.agent_user_id = u.id
			WHERE 1=1`
		args := []any{}
		n := 1

		if visitType != "" {
			query += fmt.Sprintf(" AND rfv.visit_type = $%d", n)
			args = append(args, visitType)
			n++
		}
		if outcome != "" {
			query += fmt.Sprintf(" AND rfv.outcome = $%d", n)
			args = append(args, outcome)
			n++
		}
		if agentID != "" {
			query += fmt.Sprintf(" AND rfv.agent_user_id = $%d", n)
			args = append(args, agentID)
			n++
		}
		if dateFrom != "" {
			query += fmt.Sprintf(" AND rfv.visit_date >= $%d", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			query += fmt.Sprintf(" AND rfv.visit_date <= $%d", n)
			args = append(args, dateTo)
			n++
		}

		query += fmt.Sprintf(" ORDER BY rfv.visit_date DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func recoveryOpsVisit(db *core.DB) http.HandlerFunc {
	type body struct {
		VisitDate string `json:"visit_date"`
		VisitType string `json:"visit_type"`
		Outcome   string `json:"outcome"`
		Notes     string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.VisitDate == "" || b.VisitType == "" {
			respondErr(w, 422, "visit_date and visit_type are required")
			return
		}

		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO recovery_field_visits (case_id, agent_user_id, visit_date, visit_type, outcome, notes, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, NOW())
			RETURNING id, visit_date, visit_type, outcome, notes, created_at`,
			id, user.ID, b.VisitDate, b.VisitType, b.Outcome, b.Notes)
		if err != nil {
			respondErr(w, 500, "Log visit failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func recoveryOpsWriteOff(db *core.DB) http.HandlerFunc {
	type body struct {
		AmountKobo int64  `json:"amount_kobo"`
		Reason     string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AmountKobo == 0 || b.Reason == "" {
			respondErr(w, 422, "amount_kobo and reason are required")
			return
		}

		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO recovery_write_off_approvals
				(case_id, amount_kobo, reason, requested_by, status, created_at, updated_at)
			VALUES ($1, $2, $3, $4, 'pending_recovery_head', NOW(), NOW())
			RETURNING id, case_id, amount_kobo, reason, status, created_at`,
			id, b.AmountKobo, b.Reason, user.ID)
		if err != nil {
			respondErr(w, 500, "Create write-off request failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// stageProgressions maps current status → next status and the role required to advance it.
var stageProgressions = map[string]struct {
	next     string
	roleCol  string
	required string
}{
	"pending_recovery_head": {
		next:     "pending_finance",
		roleCol:  "recovery_head_approved_by",
		required: "recovery_head",
	},
	"pending_finance": {
		next:     "pending_md",
		roleCol:  "finance_approved_by",
		required: "finance_head",
	},
	"pending_md": {
		next:     "approved",
		roleCol:  "md_approved_by",
		required: "md",
	},
}

func recoveryOpsApproveWriteOff(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		wid, err := strconv.ParseInt(chi.URLParam(r, "wid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid write-off ID")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		wrows, err := db.PGQuery(ctx, `SELECT status FROM recovery_write_off_approvals WHERE id = $1`, wid)
		if err != nil || len(wrows) == 0 {
			respondErr(w, 404, "Write-off request not found")
			return
		}

		currentStatus := str(wrows[0]["status"])
		prog, ok := stageProgressions[currentStatus]
		if !ok {
			respondErr(w, 422, fmt.Sprintf("Write-off is already '%s' and cannot be advanced", currentStatus))
			return
		}
		if user.Role != prog.required {
			respondErr(w, 403, fmt.Sprintf("This approval stage requires the '%s' role", prog.required))
			return
		}

		// Conditional UPDATE: only advances if status still matches what we read (prevents double-approval race).
		updated, err := db.PGQuery(ctx,
			fmt.Sprintf(`UPDATE recovery_write_off_approvals
				SET status = $1, %s = $2, updated_at = NOW()
				WHERE id = $3 AND status = $4 RETURNING id`, prog.roleCol),
			prog.next, user.ID, wid, currentStatus)
		if err != nil {
			respondErr(w, 500, "Approval failed")
			return
		}
		if len(updated) == 0 {
			respondErr(w, 409, "Write-off status changed concurrently — please refresh and try again")
			return
		}

		// If fully approved, stamp the write-off amount on the case
		if prog.next == "approved" {
			db.PGExec(ctx, `
				UPDATE recovery_cases rc
				SET write_off_amount_kobo = wa.amount_kobo, status = 'closed', closed_at = NOW(), updated_at = NOW()
				FROM recovery_write_off_approvals wa
				WHERE wa.id = $1 AND rc.id = wa.case_id`,
				wid) //nolint:errcheck
		}

		respondErr(w, 200, fmt.Sprintf("Write-off advanced to '%s'", prog.next))
	}
}

func recoveryOpsRejectWriteOff(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		wid, err := strconv.ParseInt(chi.URLParam(r, "wid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid write-off ID")
			return
		}

		wrows, err := db.PGQuery(r.Context(), `SELECT status FROM recovery_write_off_approvals WHERE id = $1`, wid)
		if err != nil || len(wrows) == 0 {
			respondErr(w, 404, "Write-off request not found")
			return
		}
		currentSt := str(wrows[0]["status"])
		if currentSt == "approved" || currentSt == "rejected" {
			respondErr(w, 422, "Write-off is already finalised")
			return
		}

		_, err = db.PGExec(r.Context(),
			`UPDATE recovery_write_off_approvals SET status = 'rejected', updated_at = NOW() WHERE id = $1`, wid)
		if err != nil {
			respondErr(w, 500, "Reject failed")
			return
		}
		respondErr(w, 200, "Write-off rejected")
	}
}

func recoveryOpsDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		type stat struct {
			key, sql string
		}
		stats := []stat{
			{"total_open_cases", `SELECT COUNT(*) AS val FROM recovery_cases WHERE status = 'open'`},
			{"total_outstanding_kobo", `SELECT COALESCE(SUM(outstanding_kobo), 0) AS val FROM recovery_cases WHERE status = 'open'`},
			{"total_recovered_kobo", `SELECT COALESCE(SUM(recovered_kobo), 0) AS val FROM recovery_cases`},
			{"pending_write_offs", `
				SELECT COUNT(*) AS val FROM recovery_write_off_approvals
				WHERE status NOT IN ('approved', 'rejected')`},
			{"visits_this_month", `
				SELECT COUNT(*) AS val FROM recovery_field_visits
				WHERE DATE_TRUNC('month', visit_date::date) = DATE_TRUNC('month', CURRENT_DATE)`},
		}

		result := map[string]any{}
		for _, s := range stats {
			rows, err := db.PGQuery(ctx, s.sql)
			if err != nil {
				respondErr(w, 500, "Dashboard query failed: "+s.key)
				return
			}
			if len(rows) > 0 {
				result[s.key] = rows[0]["val"]
			} else {
				result[s.key] = 0
			}
		}

		respond(w, result, "pg")
	}
}
