package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterRecoveryOps(r chi.Router, db *core.DB) {
	base := core.RequirePages("recovery")
	assign := core.RequirePages("recovery_assign")
	writeOff := core.RequirePages("recovery_write_off")

	r.With(base).Get("/cases", recoveryOpsCases(db))
	r.With(base).Get("/cases/{id}", recoveryOpsCaseDetail(db))
	r.With(base).Get("/cases/{id}/full", recoveryOpsCaseDetailFull(db))
	r.With(assign).Put("/cases/{id}/assign", recoveryOpsAssign(db))
	r.With(base).Post("/cases/{id}/payment", recoveryOpsPayment(db))
	r.With(base).Post("/cases/{id}/legal", recoveryOpsAddLegal(db))
	r.With(base).Put("/legal/{lid}/status", recoveryOpsUpdateLegal(db))
	r.With(base).Get("/visits", recoveryOpsVisitsList(db))
	r.With(base).Post("/cases/{id}/visit", recoveryOpsVisit(db))
	r.With(base).Post("/cases/{id}/write-off", recoveryOpsWriteOff(db))
	r.With(writeOff).Put("/write-off/{wid}/approve", recoveryOpsApproveWriteOff(db))
	r.With(writeOff).Put("/write-off/{wid}/reject", recoveryOpsRejectWriteOff(db))
	r.With(base).Get("/payments/pending", recoveryOpsPendingPayments(db))
	r.With(base).Put("/payments/{pid}/approve", recoveryOpsApprovePayment(db))
	r.With(base).Put("/payments/{pid}/reject", recoveryOpsRejectPayment(db))
	r.With(base).Get("/dashboard", recoveryOpsDashboard(db))
	r.With(base).Get("/agent-dashboard", recoveryOpsAgentDashboard(db))
}

func recoveryOpsCases(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		status := qstr(r, "status")
		legalStage := qstr(r, "legal_stage")
		agentID := qstr(r, "agent_id")
		q := qstr(r, "q")
		from := qstr(r, "from")
		to := qstr(r, "to")
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

		// Individual agents see only their own cases; heads/managers see all.
		if !user.HasPage("recovery_assign") {
			query += fmt.Sprintf(" AND rc.assigned_agent_id = $%d", n)
			args = append(args, user.ID)
			n++
		}

		if status != "" {
			vals := strings.Split(status, ",")
			placeholders := make([]string, len(vals))
			for i, v := range vals {
				placeholders[i] = fmt.Sprintf("$%d", n)
				args = append(args, strings.TrimSpace(v))
				n++
			}
			query += " AND rc.status IN (" + strings.Join(placeholders, ",") + ")"
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
			if clause, sargs, nn := buildCustomerSearch(q,
				[]string{"rc.account_cif"}, "", n); clause != "" {
				query += " AND " + clause
				args = append(args, sargs...)
				n = nn
			}
		}
		if from != "" {
			query += fmt.Sprintf(" AND rc.opened_at::date >= $%d", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			query += fmt.Sprintf(" AND rc.opened_at::date <= $%d", n)
			args = append(args, to)
			n++
		}

		query += fmt.Sprintf(" ORDER BY rc.updated_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
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
			SELECT * FROM recovery_payments WHERE case_id = $1 AND status = 'approved' ORDER BY payment_date DESC`, id)
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

// recoveryOpsCaseDetailFull returns everything recoveryOpsCaseDetail returns, plus
// the full cross-team credit_activity_log for the account CIF so agents can see
// the complete lifecycle including the collections phase.
func recoveryOpsCaseDetailFull(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		ctx := r.Context()

		cases, err := db.PGQuery(ctx, `
			SELECT rc.*, u.full_name AS agent_name, au.full_name AS assigned_by_name
			FROM recovery_cases rc
			LEFT JOIN o3c_users u  ON rc.assigned_agent_id = u.id
			LEFT JOIN o3c_users au ON rc.assigned_by = au.id
			WHERE rc.id = $1`, id)
		if err != nil || len(cases) == 0 {
			respondErr(w, 404, "Case not found")
			return
		}

		cif := fmt.Sprint(cases[0]["account_cif"])

		payments, _ := db.PGQuery(ctx, `SELECT rp.*, u.full_name AS agent_name FROM recovery_payments rp LEFT JOIN o3c_users u ON rp.agent_user_id = u.id WHERE rp.case_id = $1 ORDER BY rp.payment_date DESC`, id)
		proceedings, _ := db.PGQuery(ctx, `SELECT * FROM legal_proceedings WHERE case_id = $1 ORDER BY filing_date DESC`, id)
		visits, _ := db.PGQuery(ctx, `
			SELECT rfv.*, u.full_name AS agent_name
			FROM recovery_field_visits rfv
			LEFT JOIN o3c_users u ON rfv.agent_user_id = u.id
			WHERE rfv.case_id = $1 ORDER BY rfv.visit_date DESC`, id)
		writeoffs, _ := db.PGQuery(ctx, `
			SELECT rwo.*, u.full_name AS approver_name
			FROM recovery_write_off_approvals rwo
			LEFT JOIN o3c_users u ON rwo.approved_by = u.id
			WHERE rwo.case_id = $1 ORDER BY rwo.created_at DESC LIMIT 1`, id)

		// Full cross-team activity log for this CIF (collections + recovery phases)
		activityLog, _ := db.PGQuery(ctx, `
			SELECT cal.id, cal.module, cal.entity_type, cal.entity_id, cal.account_cif,
			       cal.action, cal.detail, cal.created_at, u.full_name AS actor_name
			FROM credit_activity_log cal
			LEFT JOIN o3c_users u ON cal.actor_user_id = u.id
			WHERE cal.account_cif = $1
			ORDER BY cal.created_at DESC
			LIMIT 200`, cif)

		// Collections-phase contacts and promises for context
		contacts, _ := db.PGQuery(ctx, `
			SELECT cc.*, u.full_name AS agent_name
			FROM collection_contacts cc
			LEFT JOIN o3c_users u ON cc.agent_user_id = u.id
			WHERE cc.cif_number = $1 ORDER BY cc.created_at DESC LIMIT 50`, cif)
		promises, _ := db.PGQuery(ctx, `
			SELECT cp.*, u.full_name AS agent_name
			FROM collection_promises cp
			LEFT JOIN o3c_users u ON cp.agent_user_id = u.id
			WHERE cp.cif_number = $1 ORDER BY cp.promised_date DESC LIMIT 20`, cif)

		nilToEmpty := func(rows []core.Row) []core.Row {
			if rows == nil {
				return []core.Row{}
			}
			return rows
		}

		result := map[string]any{
			"case":          cases[0],
			"payments":      nilToEmpty(payments),
			"proceedings":   nilToEmpty(proceedings),
			"visits":        nilToEmpty(visits),
			"activity_log":  nilToEmpty(activityLog),
			"coll_contacts": nilToEmpty(contacts),
			"coll_promises": nilToEmpty(promises),
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

		go NotifyRole(context.Background(), db, "recovery_head", NotifPayload{
			EventType: EvtRecoveryCaseAssigned,
			Title:     "Recovery Case Assigned",
			Body:      fmt.Sprintf("Case #%d has been assigned to an agent", id),
			ActionURL: fmt.Sprintf("/recovery/cases/%d", id),
			EntityRef: fmt.Sprintf("recovery_case:%d", id),
		})

		respondOK(w, "Assigned successfully")
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

		// Recovery payments are logged as pending — a collections officer must approve
		// before the GL is posted and the case recovered_kobo is updated.
		var payID int64
		var payDate, payChannel, payRef, createdAt any
		err = tx.QueryRowContext(ctx, `
			INSERT INTO recovery_payments (case_id, amount_kobo, payment_date, channel, reference, posted_by, status, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
			RETURNING id, amount_kobo, payment_date, channel, reference, created_at`,
			id, b.AmountKobo, b.PaymentDate, b.Channel, b.Reference, user.ID,
		).Scan(&payID, &b.AmountKobo, &payDate, &payChannel, &payRef, &createdAt)
		if err != nil {
			respondErr(w, 500, "Log payment failed")
			return
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		cif := ""
		if cifRows, _ := db.PGQuery(ctx, `SELECT account_cif FROM recovery_cases WHERE id = $1`, id); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(ctx, db, r, "recovery", "recovery_payment", fmt.Sprint(payID), cif, "payment_logged",
			fmt.Sprintf("Recovery payment of ₦%s submitted via %s — pending approval", fmtKoboStr(b.AmountKobo), b.Channel), nil, map[string]any{"amount_kobo": b.AmountKobo, "channel": b.Channel})

		respond(w, core.Row{
			"id":           payID,
			"amount_kobo":  b.AmountKobo,
			"payment_date": payDate,
			"channel":      payChannel,
			"reference":    payRef,
			"status":       "pending",
			"created_at":   createdAt,
		}, "pg")
	}
}

func recoveryOpsPendingPayments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    rp.id, rp.case_id, rc.account_cif,
			    rp.amount_kobo, rp.payment_date, rp.channel, rp.reference,
			    rp.status, rp.created_at,
			    u.full_name AS posted_by_name
			FROM recovery_payments rp
			JOIN recovery_cases rc ON rc.id = rp.case_id
			LEFT JOIN o3c_users u ON u.id = rp.posted_by
			WHERE rp.status = 'pending'
			ORDER BY rp.created_at ASC
			LIMIT 200`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func recoveryOpsApprovePayment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pid, err := strconv.ParseInt(chi.URLParam(r, "pid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid payment ID")
			return
		}
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Fetch the pending payment
		pmtRows, err := db.PGQuery(ctx,
			`SELECT id, case_id, amount_kobo, status, posted_by FROM recovery_payments WHERE id = $1`, pid)
		if err != nil || len(pmtRows) == 0 {
			respondErr(w, 404, "Payment not found")
			return
		}
		pmt := pmtRows[0]
		if pmt["status"] != "pending" {
			respondErr(w, 422, "Payment already processed")
			return
		}
		// Self-approval prevention
		postedBy, _ := pmt["posted_by"].(int64)
		if postedBy == user.ID {
			respondErr(w, 403, "Cannot approve a payment you submitted")
			return
		}
		caseID, _ := pmt["case_id"].(int64)
		amtKobo, _ := pmt["amount_kobo"].(int64)

		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "Transaction start failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		_, err = tx.ExecContext(ctx, `
			UPDATE recovery_payments
			SET status = 'approved', approved_by = $1, approved_at = NOW()
			WHERE id = $2`,
			user.ID, pid)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}

		_, err = tx.ExecContext(ctx, `
			UPDATE recovery_cases
			SET recovered_kobo = COALESCE(recovered_kobo, 0) + $1,
			    total_recovered_kobo = COALESCE(total_recovered_kobo, 0) + $1,
			    updated_at = NOW()
			WHERE id = $2`,
			amtKobo, caseID)
		if err != nil {
			respondErr(w, 500, "Update case totals failed")
			return
		}

		if glErr := postJournalTx(ctx, tx, glEntry{
			Date:          time.Now(),
			Description:   fmt.Sprintf("Recovery payment approved — payment %d", pid),
			Reference:     fmt.Sprintf("RCOV-PAY-%d", pid),
			DebitAccount:  "1001",
			CreditAccount: "1100",
			AmountKobo:    amtKobo,
			SourceType:    "recovery_payment",
			SourceID:      pid,
			PostedBy:      user.ID,
		}); glErr != nil {
			respondErr(w, 500, "GL post failed")
			return
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}
		cif := ""
		if cifRows, _ := db.PGQuery(ctx, `SELECT account_cif FROM recovery_cases WHERE id = $1`, caseID); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(ctx, db, r, "recovery", "recovery_payment", fmt.Sprint(pid), cif, "payment_approved",
			fmt.Sprintf("Recovery payment of ₦%s approved", fmtKoboStr(amtKobo)), nil, map[string]any{"approved": true})
		respond(w, map[string]any{"id": pid, "status": "approved"}, "json")
	}
}

func recoveryOpsRejectPayment(db *core.DB) http.HandlerFunc {
	type body struct {
		RejectionReason string `json:"rejection_reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		pid, err := strconv.ParseInt(chi.URLParam(r, "pid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid payment ID")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			UPDATE recovery_payments
			SET status = 'rejected', approved_by = $1, approved_at = NOW(), rejection_reason = $2
			WHERE id = $3 AND status = 'pending'
			RETURNING id, status`,
			user.ID, b.RejectionReason, pid)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Payment not found or already processed")
			return
		}
		cif := ""
		if cifRows, _ := db.PGQuery(r.Context(), `SELECT rc.account_cif FROM recovery_payments rp JOIN recovery_cases rc ON rc.id = rp.case_id WHERE rp.id = $1`, pid); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(r.Context(), db, r, "recovery", "recovery_payment", fmt.Sprint(pid), cif, "payment_rejected",
			fmt.Sprintf("Recovery payment rejected — reason: %s", b.RejectionReason), nil, map[string]any{"reason": b.RejectionReason})
		respond(w, rows[0], "pg")
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
		cif := ""
		if cifRows, _ := db.PGQuery(r.Context(), `SELECT account_cif FROM recovery_cases WHERE id = $1`, id); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(r.Context(), db, r, "recovery", "legal_milestone", fmt.Sprint(rows[0]["id"]), cif, "legal_milestone_added",
			fmt.Sprintf("Legal milestone added: %s", b.ProceedingType), nil, map[string]any{"milestone": b.ProceedingType})
		go NotifyRoles(context.Background(), db, []string{"recovery_head", "compliance_officer"}, NotifPayload{
			EventType: EvtRecoveryLegalMilestone,
			Title:     "Legal Proceeding Filed",
			Body:      fmt.Sprintf("New '%s' proceeding filed for recovery case #%d", b.ProceedingType, id),
			ActionURL: "/recovery/legal",
			EntityRef: fmt.Sprintf("recovery_case:%d", id),
		})
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
		respondOK(w, "Legal proceeding updated")
	}
}

func recoveryOpsVisitsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		visitType := qstr(r, "visit_type")
		outcome := qstr(r, "outcome")
		agentID := qstr(r, "agent_id")
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

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
			respondErrLog(w, 500, "Query failed", err)
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
		cif := ""
		if cifRows, _ := db.PGQuery(r.Context(), `SELECT account_cif FROM recovery_cases WHERE id = $1`, id); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(r.Context(), db, r, "recovery", "recovery_visit", fmt.Sprint(rows[0]["id"]), cif, "field_visit_logged",
			fmt.Sprintf("Field visit logged — outcome: %s", b.Outcome), nil, map[string]any{"outcome": b.Outcome, "notes": b.Notes})
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
		cif := ""
		if cifRows, _ := db.PGQuery(r.Context(), `SELECT account_cif FROM recovery_cases WHERE id = $1`, id); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(r.Context(), db, r, "recovery", "writeoff_request", fmt.Sprint(rows[0]["id"]), cif, "writeoff_requested",
			fmt.Sprintf("Write-off request submitted for ₦%s", fmtKoboStr(b.AmountKobo)), nil, map[string]any{"amount_kobo": b.AmountKobo})
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

		wrows, err := db.PGQuery(ctx, `SELECT status, amount_kobo FROM recovery_write_off_approvals WHERE id = $1`, wid)
		if err != nil || len(wrows) == 0 {
			respondErr(w, 404, "Write-off request not found")
			return
		}

		currentStatus := str(wrows[0]["status"])
		writeOffKobo := toInt64(wrows[0]["amount_kobo"])
		prog, ok := stageProgressions[currentStatus]
		if !ok {
			respondErr(w, 422, fmt.Sprintf("Write-off is already '%s' and cannot be advanced", currentStatus))
			return
		}
		if user.Role != prog.required {
			respondErr(w, 403, fmt.Sprintf("This approval stage requires the '%s' role", prog.required))
			return
		}

		// Wrap the status UPDATE (and any final-approval side-effects) in a transaction
		// so the status never changes without the GL entry being posted.
		tx, txErr := db.PG.BeginTx(ctx, nil)
		if txErr != nil {
			respondErr(w, 500, "Transaction failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		var updatedID int64
		updateErr := tx.QueryRowContext(ctx,
			fmt.Sprintf(`UPDATE recovery_write_off_approvals
				SET status = $1, %s = $2, updated_at = NOW()
				WHERE id = $3 AND status = $4 RETURNING id`, prog.roleCol),
			prog.next, user.ID, wid, currentStatus).Scan(&updatedID)
		if updateErr == sql.ErrNoRows {
			respondErr(w, 409, "Write-off status changed concurrently — please refresh and try again")
			return
		}
		if updateErr != nil {
			respondErr(w, 500, "Approval failed")
			return
		}

		// If fully approved, update the case and post GL entry inside the same transaction.
		if prog.next == "approved" {
			tx.ExecContext(ctx, `
				UPDATE recovery_cases rc
				SET write_off_amount_kobo = wa.amount_kobo,
				    outstanding_kobo      = GREATEST(0, rc.outstanding_kobo - wa.amount_kobo),
				    status = 'closed', closed_at = NOW(), updated_at = NOW()
				FROM recovery_write_off_approvals wa
				WHERE wa.id = $1 AND rc.id = wa.case_id`,
				wid) //nolint:errcheck
			postJournalTx(ctx, tx, glEntry{ //nolint:errcheck
				Date:          time.Now(),
				Description:   fmt.Sprintf("Loan write-off approved — request %d", wid),
				Reference:     fmt.Sprintf("WO-%d", wid),
				DebitAccount:  "5200", // Loan Loss Provision
				CreditAccount: "1100", // Loan Receivable
				AmountKobo:    writeOffKobo,
				SourceType:    "recovery_write_off",
				SourceID:      wid,
				PostedBy:      user.ID,
			})
		}

		if commitErr := tx.Commit(); commitErr != nil {
			respondErr(w, 500, "Write-off commit failed — please retry")
			return
		}

		cif := ""
		if cifRows, _ := db.PGQuery(ctx, `SELECT rc.account_cif FROM recovery_write_off_approvals wa JOIN recovery_cases rc ON rc.id = wa.case_id WHERE wa.id = $1`, wid); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(ctx, db, r, "recovery", "writeoff_approval", fmt.Sprint(wid), cif, "writeoff_approved",
			fmt.Sprintf("Write-off of ₦%s approved", fmtKoboStr(writeOffKobo)), nil, map[string]any{"approved": true})

		respondOK(w, fmt.Sprintf("Write-off advanced to '%s'", prog.next))
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
		respondOK(w, "Write-off rejected")
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

		// H9: individual stat failures return 0 rather than aborting the whole dashboard.
		result := map[string]any{}
		for _, s := range stats {
			rows, err := db.PGQuery(ctx, s.sql)
			if err != nil || len(rows) == 0 {
				result[s.key] = 0
				continue
			}
			result[s.key] = rows[0]["val"]
		}

		respond(w, result, "pg")
	}
}

func recoveryOpsAgentDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		var assignedCases, closedMTD, callsMTD int
		var collectedMTD int64

		db.PG.QueryRowContext(ctx, `SELECT COUNT(*) FROM recovery_cases WHERE assigned_agent_id = $1 AND status = 'open'`, user.ID).Scan(&assignedCases)                                                                                                                                                                       //nolint:errcheck
		db.PG.QueryRowContext(ctx, `SELECT COUNT(*) FROM recovery_cases WHERE assigned_agent_id = $1 AND status = 'closed' AND DATE_TRUNC('month', closed_at) = DATE_TRUNC('month', CURRENT_DATE)`, user.ID).Scan(&closedMTD)                                                                                                  //nolint:errcheck
		db.PG.QueryRowContext(ctx, `SELECT COUNT(*) FROM recovery_field_visits WHERE agent_user_id = $1 AND DATE_TRUNC('month', visit_date::date) = DATE_TRUNC('month', CURRENT_DATE)`, user.ID).Scan(&callsMTD)                                                                                                               //nolint:errcheck
		db.PG.QueryRowContext(ctx, `SELECT COALESCE(SUM(rp.amount_kobo),0) FROM recovery_payments rp JOIN recovery_cases rc ON rc.id = rp.case_id WHERE rc.assigned_agent_id = $1 AND rp.status = 'approved' AND DATE_TRUNC('month', rp.payment_date::date) = DATE_TRUNC('month', CURRENT_DATE)`, user.ID).Scan(&collectedMTD) //nolint:errcheck

		caseRows, _ := db.PGQuery(ctx, `
			SELECT
				rc.id, rc.case_ref,
				COALESCE((SELECT ca.customer_name FROM collection_assignments ca
				          WHERE ca.account_cif = rc.account_cif
				          ORDER BY ca.updated_at DESC LIMIT 1), rc.account_cif) AS debtor_name,
				rc.outstanding_kobo,
				CAST(REGEXP_REPLACE(COALESCE(rc.dpd_at_handoff,'0'),'\D','','g') AS INT) AS dpd,
				'' AS next_action, NULL::date AS next_action_date,
				rc.status
			FROM recovery_cases rc
			WHERE rc.assigned_agent_id = $1 AND rc.status = 'open'
			ORDER BY rc.outstanding_kobo DESC
			LIMIT 50`, user.ID)

		visitRows, _ := db.PGQuery(ctx, `
			SELECT
				v.id, rc.case_ref,
				COALESCE((SELECT ca.customer_name FROM collection_assignments ca
				          WHERE ca.account_cif = rc.account_cif
				          ORDER BY ca.updated_at DESC LIMIT 1), rc.account_cif) AS debtor_name,
				v.outcome, v.visit_date AS visited_at,
				0 AS amount_promised_kobo
			FROM recovery_field_visits v
			JOIN recovery_cases rc ON rc.id = v.case_id
			WHERE v.officer_id = $1
			ORDER BY v.created_at DESC
			LIMIT 10`, user.ID)

		trendRows, _ := db.PGQuery(ctx, `
			SELECT
				TO_CHAR(gs, 'Mon YYYY') AS month,
				COALESCE(SUM(rp.amount_kobo) FILTER (WHERE rp.status = 'approved'), 0) AS collected,
				COUNT(DISTINCT v.id)                                                    AS calls
			FROM GENERATE_SERIES(
				DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months',
				DATE_TRUNC('month', CURRENT_DATE),
				'1 month'
			) AS gs
			LEFT JOIN recovery_payments rp
				ON DATE_TRUNC('month', rp.payment_date::date) = gs
				AND rp.case_id IN (SELECT id FROM recovery_cases WHERE assigned_agent_id = $1)
			LEFT JOIN recovery_field_visits v
				ON DATE_TRUNC('month', v.visit_date::date) = gs
				AND v.agent_user_id = $1
			GROUP BY gs
			ORDER BY gs`, user.ID)

		if caseRows == nil {
			caseRows = []core.Row{}
		}
		if visitRows == nil {
			visitRows = []core.Row{}
		}
		if trendRows == nil {
			trendRows = []core.Row{}
		}

		respond(w, core.Row{
			"assigned_cases":            assignedCases,
			"cases_closed_mtd":          closedMTD,
			"calls_made_mtd":            callsMTD,
			"amount_collected_mtd_kobo": collectedMTD,
			"cases":                     caseRows,
			"recent_visits":             visitRows,
			"monthly_trend":             trendRows,
		}, "pg")
	}
}
