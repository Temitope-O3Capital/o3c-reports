package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterCollectionsOps(r chi.Router, db *core.DB) {
	base := core.RequirePages("collections")
	head := core.RequirePages("collections_assign")

	r.With(base).Get("/queue", collectionsOpsQueue(db))
	r.With(head).Put("/{id}/assign", collectionsOpsAssign(db))
	r.With(base).Post("/{id}/contact", collectionsOpsContact(db))
	r.With(base).Post("/{id}/promise", collectionsOpsPromise(db))
	r.With(base).Get("/promises", collectionsOpsListPromises(db))
	r.With(base).Put("/promises/{pid}/kept", collectionsOpsHonourPromise(db))
	r.With(base).Put("/promises/{pid}/honour", collectionsOpsHonourPromise(db)) // legacy alias
	r.With(base).Put("/promises/{pid}/broken", collectionsOpsBrokenPromise(db))
	r.With(base).Get("/targets", collectionsOpsTargets(db))
	r.With(head).Put("/targets", collectionsOpsUpsertTarget(db))
	r.With(base).Get("/dashboard", collectionsOpsDashboard(db))
	r.With(base).Get("/agent-dashboard", collectionsOpsAgentDashboard(db))
	r.With(head).Post("/{id}/send-to-recovery", collectionsOpsSendToRecovery(db))

	r.With(base).Get("/repayment-plans", collectionsOpsListPlans(db))
	r.With(base).Post("/repayment-plans", collectionsOpsCreatePlan(db))
	r.With(base).Get("/repayment-plans/{pid}/instalments", collectionsOpsListInstalments(db))
	r.With(base).Put("/repayment-plans/instalments/{iid}/paid", collectionsOpsMarkPaid(db))

	r.With(base).Post("/{id}/payment", collectionsOpsLogPayment(db))
	r.With(base).Get("/{id}/contacts", collectionsOpsGetContacts(db))
	r.With(base).Get("/{id}/payments", collectionsOpsGetPayments(db))
	r.With(head).Post("/payments/reconcile", collectionsOpsReconcilePayments(db))

	r.With(base).Get("/writeoffs", collectionsOpsListWriteoffs(db))
	r.With(head).Post("/writeoffs/{id}/approve", collectionsOpsApproveWriteoff(db))
	r.With(head).Post("/writeoffs/{id}/return-recovery", collectionsOpsReturnWriteoff(db))
	r.With(head).Post("/writeoffs/bulk-approve", collectionsOpsBulkApproveWriteoff(db))

	// Collections-initiated write-off requests
	r.With(base).Post("/writeoff-requests", collectionsOpsCreateWriteoffRequest(db))
	r.With(base).Get("/writeoff-requests", collectionsOpsListWriteoffRequests(db))
	r.With(head).Put("/writeoff-requests/{id}/approve", collectionsOpsApproveWriteoffRequest(db))
	r.With(head).Put("/writeoff-requests/{id}/reject", collectionsOpsRejectWriteoffRequest(db))

	// Bulk operations (head only)
	r.With(head).Post("/bulk/reassign", collectionsOpsBulkReassign(db))
	r.With(head).Post("/bulk/send-to-recovery", collectionsOpsBulkSendToRecovery(db))
	r.With(head).Post("/bulk/assign-by-cif", collectionsOpsBulkAssignByCIF(db))
	r.With(head).Post("/bulk/escalate-by-cif", collectionsOpsBulkEscalateByCIF(db))
	r.With(head).Post("/distribute", collectionsOpsDistribute(db))
}

func collectionsOpsQueue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		bucket := qstr(r, "dpd_bucket")
		agentID := qstr(r, "agent_id")
		stage := qstr(r, "stage")
		q := qstr(r, "q")
		accountCIF := qstr(r, "account_cif")
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `
			SELECT ca.id, ca.account_cif, ca.agent_user_id, u.full_name AS agent_name,
			       ca.assigned_by, ca.assignment_date, ca.dpd_bucket, ca.outstanding_kobo,
			       ca.current_stage, ca.notes, ca.created_at, ca.updated_at,
			       (SELECT MAX(cc.created_at) FROM collection_contacts cc
			        WHERE cc.cif_number = ca.account_cif) AS last_contact_at
			FROM collection_assignments ca
			LEFT JOIN o3c_users u ON ca.agent_user_id = u.id
			WHERE ca.status = 'active'`
		args := []any{}
		n := 1

		// Individual contributors see only their own cases; heads/managers see all.
		if !user.HasPage("collections_assign") {
			query += fmt.Sprintf(" AND ca.agent_user_id = $%d", n)
			args = append(args, user.ID)
			n++
		}

		if accountCIF != "" {
			query += fmt.Sprintf(" AND ca.account_cif = $%d", n)
			args = append(args, accountCIF)
			n++
		}
		if bucket != "" {
			vals := strings.Split(bucket, ",")
			placeholders := make([]string, len(vals))
			for i, v := range vals {
				placeholders[i] = fmt.Sprintf("$%d", n)
				args = append(args, strings.TrimSpace(v))
				n++
			}
			query += " AND ca.dpd_bucket IN (" + strings.Join(placeholders, ",") + ")"
		}
		if agentID != "" {
			query += fmt.Sprintf(" AND ca.agent_user_id = $%d", n)
			args = append(args, agentID)
			n++
		}
		if stage != "" {
			query += fmt.Sprintf(" AND ca.current_stage = $%d", n)
			args = append(args, stage)
			n++
		}
		if q != "" {
			if clause, sargs, nn := buildCustomerSearch(q,
				[]string{"ca.account_cif", "u.full_name"}, "", n); clause != "" {
				query += " AND " + clause
				args = append(args, sargs...)
				n = nn
			}
		}
		if from != "" {
			query += fmt.Sprintf(" AND ca.created_at::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			query += fmt.Sprintf(" AND ca.created_at::date <= $%d::date", n)
			args = append(args, to)
			n++
		}

		query += fmt.Sprintf(" ORDER BY ca.updated_at DESC LIMIT $%d OFFSET $%d", n, n+1)
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

func collectionsOpsAssign(db *core.DB) http.HandlerFunc {
	type body struct {
		AgentID int64  `json:"agent_id"`
		Notes   string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid assignment ID")
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

		rows, err := db.PGQuery(ctx,
			`SELECT id FROM collection_assignments WHERE id = $1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Assignment not found")
			return
		}

		_, err = db.PGExec(ctx, `
			UPDATE collection_assignments
			SET agent_user_id = $1, assigned_by = $2, notes = $3, updated_at = NOW()
			WHERE id = $4`,
			b.AgentID, user.ID, b.Notes, id)
		if err != nil {
			respondErr(w, 500, "Assign failed")
			return
		}

		sendNotification(ctx, db, b.AgentID, "collections_assigned", //nolint:errcheck
			"Collection Case Assigned",
			fmt.Sprintf("A collection account has been assigned to you"),
			"collection_assignment", id)

		respondOK(w, "Assigned successfully")
	}
}

func collectionsOpsGetContacts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		assRows, err := db.PGQuery(r.Context(), `SELECT account_cif FROM collection_assignments WHERE id=$1`, id)
		if err != nil || len(assRows) == 0 {
			respondErr(w, 404, "Assignment not found")
			return
		}
		cif := str(assRows[0]["account_cif"])

		rows, err := db.PGQuery(r.Context(), `
			SELECT cc.id, cc.contact_type, cc.outcome, cc.notes, cc.created_at,
			       u.full_name AS agent_name
			FROM collection_contacts cc
			LEFT JOIN o3c_users u ON u.id = cc.agent_user_id
			WHERE cc.cif_number = $1
			ORDER BY cc.created_at DESC
			LIMIT 20`, cif)
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

// reconcileCollectionPayment marks a single collection payment reconciled when its
// reference matches a settled Paystack transaction — so a logged payment is
// provably backed by money that actually landed. Returns whether it matched.
func reconcileCollectionPayment(ctx context.Context, db *core.DB, payID int64, reference string) bool {
	if strings.TrimSpace(reference) == "" {
		return false
	}
	res, err := db.PGExec(ctx, `
		UPDATE collection_payments cp
		SET reconciled = true, reconciled_at = NOW(),
		    paystack_reference = (SELECT pt.reference FROM paystack_transactions pt
		                          WHERE lower(pt.reference) = lower($2) AND pt.status = 'success' LIMIT 1)
		WHERE cp.id = $1 AND cp.reconciled = false
		  AND EXISTS (SELECT 1 FROM paystack_transactions pt WHERE lower(pt.reference) = lower($2) AND pt.status = 'success')`,
		payID, reference)
	if err != nil || res == nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n > 0
}

// collectionsOpsReconcilePayments sweeps all unreconciled collection payments and
// matches them to settled Paystack transactions by reference.
func collectionsOpsReconcilePayments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		res, err := db.PGExec(ctx, `
			UPDATE collection_payments cp
			SET reconciled = true, reconciled_at = NOW(), paystack_reference = pt.reference
			FROM paystack_transactions pt
			WHERE cp.reconciled = false
			  AND cp.reference IS NOT NULL AND cp.reference <> ''
			  AND lower(cp.reference) = lower(pt.reference)
			  AND pt.status = 'success'`)
		if err != nil {
			respondErr(w, 500, "Reconcile failed: "+err.Error())
			return
		}
		n := int64(0)
		if res != nil {
			n, _ = res.RowsAffected()
		}
		respond(w, map[string]any{"reconciled": n}, "json")
	}
}

func collectionsOpsGetPayments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		assRows, err := db.PGQuery(r.Context(), `SELECT account_cif FROM collection_assignments WHERE id=$1`, id)
		if err != nil || len(assRows) == 0 {
			respondErr(w, 404, "Assignment not found")
			return
		}
		cif := str(assRows[0]["account_cif"])

		// Collections payments ledger (the source of truth) with reconciliation status.
		rows, err := db.PGQuery(r.Context(), `
			SELECT cp.id, cp.amount_kobo, cp.payment_date, cp.channel AS payment_method,
			       cp.reference, cp.created_at, cp.reconciled, cp.paystack_reference,
			       u.full_name AS received_by_name
			FROM collection_payments cp
			LEFT JOIN o3c_users u ON u.id = cp.received_by
			WHERE cp.account_cif = $1
			ORDER BY cp.payment_date DESC, cp.id DESC
			LIMIT 40`, cif)
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

func collectionsOpsLogPayment(db *core.DB) http.HandlerFunc {
	type body struct {
		AmountKobo  int64  `json:"amount_kobo"`
		PaymentDate string `json:"payment_date"`
		Channel     string `json:"channel"`
		Reference   string `json:"reference"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid assignment ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AmountKobo <= 0 || b.PaymentDate == "" || b.Channel == "" {
			respondErr(w, 422, "amount_kobo, payment_date and channel are required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Resolve CIF from the assignment.
		assRows, err := db.PGQuery(ctx, `SELECT account_cif FROM collection_assignments WHERE id=$1`, id)
		if err != nil || len(assRows) == 0 {
			respondErr(w, 404, "Assignment not found")
			return
		}
		cif := str(assRows[0]["account_cif"])

		tx, err := db.PG.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
		if err != nil {
			respondErr(w, 500, "Transaction start failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// CIF-keyed collections payments ledger — works across the whole delinquency
		// book (card arrears + loans), not just the near-empty native loan table.
		var payID int64
		err = tx.QueryRowContext(ctx,
			`INSERT INTO collection_payments
			 (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
			id, cif, b.AmountKobo, b.PaymentDate, b.Channel, b.Reference, user.ID,
		).Scan(&payID)
		if err != nil {
			respondErr(w, 500, "Payment log failed")
			return
		}

		glRef := fmt.Sprintf("COL-PAY-%d", payID)
		if glErr := postJournalTx(ctx, tx, glEntry{
			Date:          time.Now(),
			Description:   fmt.Sprintf("Collections payment received — CIF %s", cif),
			Reference:     glRef,
			DebitAccount:  "1001",
			CreditAccount: "1100",
			AmountKobo:    b.AmountKobo,
			SourceType:    "collections_payment",
			SourceID:      payID,
			PostedBy:      user.ID,
		}); glErr != nil {
			respondErr(w, 500, "GL journal failed")
			return
		}
		if _, e := tx.ExecContext(ctx, `UPDATE collection_payments SET gl_reference=$1 WHERE id=$2`, glRef, payID); e != nil {
			respondErr(w, 500, "GL link failed")
			return
		}

		// Legacy parity: also record loan_repayments when the CIF maps to a booked
		// loan, so downstream loan-book views stay consistent.
		if lr, lErr := db.PGQuery(ctx,
			`SELECT id FROM loan_applications WHERE applicant_cif=$1 AND status IN ('active','booked') ORDER BY created_at DESC LIMIT 1`, cif); lErr == nil && len(lr) > 0 {
			if _, e := tx.ExecContext(ctx,
				`INSERT INTO loan_repayments (application_id, amount_kobo, payment_date, payment_method, reference, received_by)
				 VALUES ($1,$2,$3,$4,$5,$6)`,
				toInt64(lr[0]["id"]), b.AmountKobo, b.PaymentDate, b.Channel, b.Reference, user.ID); e != nil {
				respondErr(w, 500, "Repayment record failed")
				return
			}
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		// Best-effort auto-reconcile against a settled Paystack transaction by reference.
		reconciled := reconcileCollectionPayment(ctx, db, payID, b.Reference)

		logCreditEvent(ctx, db, r, "collections", "payment", fmt.Sprint(payID), cif, "payment_logged",
			fmt.Sprintf("Collection payment of ₦%s logged via %s", fmtKoboStr(b.AmountKobo), b.Channel), nil, map[string]any{"amount_kobo": b.AmountKobo, "channel": b.Channel, "reconciled": reconciled})
		slog.Info("collections payment logged", "pay_id", payID, "cif", cif, "amount_kobo", b.AmountKobo, "by", user.ID, "reconciled", reconciled)
		respond(w, map[string]any{"id": payID, "amount_kobo": b.AmountKobo, "reconciled": reconciled}, "json")
	}
}

func collectionsOpsContact(db *core.DB) http.HandlerFunc {
	type body struct {
		ContactType string `json:"contact_type"`
		Outcome     string `json:"outcome"`
		Notes       string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid assignment ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ContactType == "" || b.Outcome == "" {
			respondErr(w, 422, "contact_type and outcome are required")
			return
		}

		user := core.UserFromCtx(r.Context())

		// Resolve cif_number from the assignment before logging the contact
		assRows, aErr := db.PGQuery(r.Context(), `SELECT account_cif FROM collection_assignments WHERE id = $1`, id)
		if aErr != nil || len(assRows) == 0 {
			respondErr(w, 404, "Assignment not found")
			return
		}
		cif := str(assRows[0]["account_cif"])
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO collection_contacts (cif_number, agent_user_id, contact_type, outcome, notes, created_at)
			VALUES ($1, $2, $3, $4, $5, NOW())
			RETURNING id, contact_type, outcome, notes, created_at`,
			cif, user.ID, b.ContactType, b.Outcome, b.Notes)
		if err != nil {
			respondErr(w, 500, "Log contact failed")
			return
		}
		logCreditEvent(r.Context(), db, r, "collections", "contact", fmt.Sprint(rows[0]["id"]), cif, "contact_logged",
			fmt.Sprintf("Contact logged via %s — outcome: %s", b.ContactType, b.Outcome), nil, map[string]any{"contact_type": b.ContactType, "outcome": b.Outcome, "notes": b.Notes})
		respond(w, rows[0], "pg")
	}
}

func collectionsOpsPromise(db *core.DB) http.HandlerFunc {
	type body struct {
		PromiseDate string `json:"promise_date"`
		AmountKobo  int64  `json:"amount_kobo"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid assignment ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.PromiseDate == "" || b.AmountKobo == 0 {
			respondErr(w, 422, "promise_date and amount_kobo are required")
			return
		}

		// Resolve cif_number and agent from the assignment
		passRows, pErr := db.PGQuery(r.Context(), `SELECT account_cif, agent_user_id FROM collection_assignments WHERE id = $1`, id)
		if pErr != nil || len(passRows) == 0 {
			respondErr(w, 404, "Assignment not found")
			return
		}
		pCif := str(passRows[0]["account_cif"])
		pAgent := toInt64(passRows[0]["agent_user_id"])
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO collection_promises (cif_number, agent_user_id, promised_amount_kobo, promised_date, created_at)
			VALUES ($1, $2, $3, $4, NOW())
			RETURNING id, promised_date, promised_amount_kobo, is_kept, created_at`,
			pCif, pAgent, b.AmountKobo, b.PromiseDate)
		if err != nil {
			respondErr(w, 500, "Log promise failed")
			return
		}
		logCreditEvent(r.Context(), db, r, "collections", "promise", fmt.Sprint(rows[0]["id"]), pCif, "promise_created",
			fmt.Sprintf("Promise to pay ₦%s by %s created", fmtKoboStr(b.AmountKobo), b.PromiseDate), nil, map[string]any{"amount_kobo": b.AmountKobo, "promised_date": b.PromiseDate})
		respond(w, rows[0], "pg")
	}
}

func collectionsOpsHonourPromise(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pid, err := strconv.ParseInt(chi.URLParam(r, "pid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid promise ID")
			return
		}

		user := core.UserFromCtx(r.Context())
		var res []core.Row
		if user.HasPage("collections_assign") {
			// Supervisors can honour any agent's promise.
			res, err = db.PGQuery(r.Context(), `
				UPDATE collection_promises
				SET is_kept = TRUE, actual_date = CURRENT_DATE
				WHERE id = $1
				RETURNING id`, pid)
		} else {
			res, err = db.PGQuery(r.Context(), `
				UPDATE collection_promises
				SET is_kept = TRUE, actual_date = CURRENT_DATE
				WHERE id = $1 AND agent_user_id = $2
				RETURNING id`, pid, user.ID)
		}
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		if len(res) == 0 {
			respondErr(w, 403, "Promise not found or does not belong to you")
			return
		}
		cif := ""
		if cifRows, _ := db.PGQuery(r.Context(), `SELECT cif_number FROM collection_promises WHERE id = $1`, pid); len(cifRows) > 0 {
			cif = str(cifRows[0]["cif_number"])
		}
		logCreditEvent(r.Context(), db, r, "collections", "promise", fmt.Sprint(pid), cif, "promise_honoured",
			"Promise to pay marked as kept", nil, map[string]any{"honoured": true})
		respondOK(w, "Promise marked as honoured")
	}
}

func collectionsOpsBrokenPromise(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pid, err := strconv.ParseInt(chi.URLParam(r, "pid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid promise ID")
			return
		}

		user := core.UserFromCtx(r.Context())

		pRows, _ := db.PGQuery(r.Context(),
			`SELECT agent_user_id, cif_number, promised_amount_kobo, promised_date
			 FROM collection_promises WHERE id=$1`, pid)
		if len(pRows) == 0 {
			respondErr(w, 404, "Promise not found")
			return
		}
		if !user.HasPage("collections_assign") {
			if toInt64(pRows[0]["agent_user_id"]) != user.ID {
				respondErr(w, 403, "Promise does not belong to you")
				return
			}
		}

		_, err = db.PGExec(r.Context(), `
			UPDATE collection_promises
			SET is_kept = FALSE
			WHERE id = $1`, pid)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}

		logCreditEvent(r.Context(), db, r, "collections", "promise", fmt.Sprint(pid), str(pRows[0]["cif_number"]), "promise_broken",
			"Promise to pay marked as broken", nil, map[string]any{"broken": true})

		if len(pRows) > 0 {
			p := pRows[0]
			agentID := toInt64(p["agent_user_id"])
			cif := str(p["cif_number"])
			// Use context.Background() so the notification goroutine outlives the HTTP handler.
			go Notify(context.Background(), db, NotifPayload{
				EventType: EvtPTPBroken,
				UserID:    agentID,
				Title:     "PTP broken — " + cif,
				Body:      fmt.Sprintf("Customer %s missed their promise-to-pay due %v.", cif, p["promised_date"]),
				ActionURL: "/collections",
				EntityRef: fmt.Sprint(pid),
			})
			go NotifyRole(context.Background(), db, "collections_head", NotifPayload{
				EventType: EvtPTPBroken,
				Title:     "PTP broken — " + cif,
				Body:      fmt.Sprintf("Customer %s missed their promise-to-pay due %v.", cif, p["promised_date"]),
				ActionURL: "/collections",
				EntityRef: fmt.Sprint(pid),
			})
		}

		respondOK(w, "Promise marked as broken")
	}
}

func collectionsOpsTargets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		agentID := qstr(r, "agent_id")

		query := `
			SELECT ct.id, ct.agent_user_id, u.full_name AS agent_name,
			       ct.kpi_date AS target_date, ct.target_amount_kobo, ct.amount_collected_kobo,
			       ct.contacts_made, ct.promises_obtained, ct.created_at
			FROM collections_daily_kpi ct
			LEFT JOIN o3c_users u ON ct.agent_user_id = u.id
			WHERE 1=1`
		args := []any{}
		n := 1

		if dateFrom != "" {
			query += fmt.Sprintf(" AND ct.kpi_date >= $%d", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			query += fmt.Sprintf(" AND ct.kpi_date <= $%d", n)
			args = append(args, dateTo)
			n++
		}
		if agentID != "" {
			query += fmt.Sprintf(" AND ct.agent_user_id = $%d", n)
			args = append(args, agentID)
			n++
		}

		query += " ORDER BY ct.kpi_date DESC"

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

func collectionsOpsUpsertTarget(db *core.DB) http.HandlerFunc {
	type body struct {
		AgentUserID         int64  `json:"agent_user_id"`
		TargetDate          string `json:"target_date"`
		TargetAmountKobo    int64  `json:"target_amount_kobo"`
		ContactsMade        int    `json:"contacts_made"`
		PromisesObtained    int    `json:"promises_obtained"`
		CollectedAmountKobo int64  `json:"collected_amount_kobo"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AgentUserID == 0 || b.TargetDate == "" {
			respondErr(w, 422, "agent_user_id and target_date are required")
			return
		}

		// Write to the same table that collectionsOpsTargets reads from.
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO collections_daily_kpi
				(agent_user_id, kpi_date, target_amount_kobo, amount_collected_kobo,
				 contacts_made, promises_obtained, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
			ON CONFLICT (agent_user_id, kpi_date) DO UPDATE SET
				target_amount_kobo    = EXCLUDED.target_amount_kobo,
				amount_collected_kobo = EXCLUDED.amount_collected_kobo,
				contacts_made         = EXCLUDED.contacts_made,
				promises_obtained     = EXCLUDED.promises_obtained,
				updated_at            = NOW()
			RETURNING id, agent_user_id, kpi_date AS target_date, target_amount_kobo,
			          amount_collected_kobo AS collected_amount_kobo, contacts_made, promises_obtained`,
			b.AgentUserID, b.TargetDate, b.TargetAmountKobo, b.CollectedAmountKobo,
			b.ContactsMade, b.PromisesObtained)
		if err != nil {
			respondErr(w, 500, "Upsert failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func collectionsOpsDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		type stat struct {
			key, sql string
		}
		stats := []stat{
			{"total_assigned", `SELECT COUNT(*) AS val FROM collection_assignments`},
			{"overdue_promises", `
				SELECT COUNT(*) AS val FROM collection_promises
				WHERE is_kept IS NULL
				  AND promised_date < CURRENT_DATE`},
			{"honoured_today", `
				SELECT COUNT(*) AS val FROM collection_promises
				WHERE is_kept = TRUE
				  AND actual_date = CURRENT_DATE`},
			{"collected_today_kobo", `
				SELECT COALESCE(SUM(amount_kobo), 0) AS val
				FROM collection_payments
				WHERE payment_date = CURRENT_DATE`},
			{"contacts_today", `
				SELECT COUNT(*) AS val FROM collection_contacts
				WHERE created_at::date = CURRENT_DATE`},
			{"target_kobo", `
				SELECT COALESCE(SUM(target_amount_kobo), 0) AS val
				FROM collections_daily_kpi
				WHERE kpi_date = CURRENT_DATE`},
			// PTP Kept Rate: promises resolved this month that were honoured / total resolved
			{"ptp_kept_rate_pct", `
				SELECT CASE WHEN COUNT(*) = 0 THEN 0
				            ELSE ROUND(100.0 * SUM(CASE WHEN is_kept = TRUE THEN 1 ELSE 0 END) / COUNT(*), 1)
				       END AS val
				FROM collection_promises
				WHERE is_kept IS NOT NULL
				  AND DATE_TRUNC('month', actual_date) = DATE_TRUNC('month', CURRENT_DATE)`},
			// Contact Rate: contacts logged today / total assigned active accounts
			{"contact_rate_pct", `
				SELECT CASE WHEN (SELECT COUNT(*) FROM collection_assignments WHERE status = 'active') = 0 THEN 0
				            ELSE ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM collection_assignments WHERE status = 'active'), 1)
				       END AS val
				FROM collection_contacts
				WHERE created_at::date = CURRENT_DATE`},
			// Cure Rate: active accounts currently at DPD 0 / total active accounts
			{"cure_rate_pct", `
				SELECT CASE WHEN COUNT(*) = 0 THEN 0
				            ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE dpd_bucket = '0') / COUNT(*), 1)
				       END AS val
				FROM collection_assignments
				WHERE status = 'active'`},
		}

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

// openRecoveryCase creates a recovery_cases row and returns its ref + id.
// Shared by every collections→recovery escalation path (single/bulk assignment
// handoff and watchlist escalation) so they all reach the recovery system with a
// consistent, valid row. total_outstanding_kobo is NOT NULL with no default, so
// it must be set alongside outstanding_kobo.
func openRecoveryCase(ctx context.Context, db *core.DB, cif, dpd string, outstanding int64, sourceAssignmentID *int64) (string, int64, error) {
	refRows, err := db.PGQuery(ctx, `SELECT LPAD(NEXTVAL('sar_ref_seq')::TEXT,6,'0') AS ref`)
	if err != nil || len(refRows) == 0 {
		return "", 0, fmt.Errorf("failed to generate case reference")
	}
	caseRef := "RC-" + str(refRows[0]["ref"])
	rows, err := db.PGQuery(ctx, `
		INSERT INTO recovery_cases
		  (case_ref, cif_number, account_cif, outstanding_kobo, total_outstanding_kobo, source_assignment_id, dpd_at_handoff, status, opened_at, created_at, updated_at)
		VALUES ($1,$2,$2,$3,$3,$4,$5,'open',NOW(),NOW(),NOW())
		RETURNING id`,
		caseRef, cif, outstanding, sourceAssignmentID, dpd)
	if err != nil || len(rows) == 0 {
		return "", 0, err
	}
	return caseRef, toInt64(rows[0]["id"]), nil
}

func collectionsOpsSendToRecovery(db *core.DB) http.HandlerFunc {
	type body struct {
		Notes string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid assignment ID")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		rows, err := db.PGQuery(ctx,
			`SELECT account_cif, outstanding_kobo, dpd_bucket FROM collection_assignments WHERE id=$1 AND status='active'`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Assignment not found or not active")
			return
		}
		a := rows[0]
		accountCIF := str(a["account_cif"])
		outstanding := int64(0)
		if v, ok := a["outstanding_kobo"].(int64); ok {
			outstanding = v
		}
		dpd := str(a["dpd_bucket"])

		// Generate case ref (NEXTVAL is non-transactional by design)
		refRows, refErr := db.PGQuery(ctx, `SELECT LPAD(NEXTVAL('sar_ref_seq')::TEXT,6,'0') AS ref`)
		if refErr != nil || len(refRows) == 0 {
			respondErr(w, 500, "Failed to generate case reference")
			return
		}
		caseRef := "RC-" + str(refRows[0]["ref"])

		tx, txErr := db.PG.BeginTx(ctx, nil)
		if txErr != nil {
			respondErr(w, 500, "Failed to start transaction")
			return
		}

		var caseID any
		if err = tx.QueryRowContext(ctx,
			`INSERT INTO recovery_cases
			   (case_ref, cif_number, account_cif, outstanding_kobo, total_outstanding_kobo, source_assignment_id, dpd_at_handoff, status, opened_at, created_at, updated_at)
			 VALUES ($1,$2,$2,$3,$3,$4,$5,'open',NOW(),NOW(),NOW())
			 RETURNING id`,
			caseRef, accountCIF, outstanding, id, dpd).Scan(&caseID); err != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "Failed to create recovery case")
			return
		}

		// Close the collection assignment atomically with case creation
		if _, err = tx.ExecContext(ctx,
			`UPDATE collection_assignments SET status='sent_to_recovery', updated_at=NOW() WHERE id=$1`, id); err != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "Failed to update assignment")
			return
		}
		if err = tx.Commit(); err != nil {
			respondErr(w, 500, "Failed to commit")
			return
		}

		logCreditEvent(ctx, db, r, "collections", "assignment", fmt.Sprint(id), accountCIF, "sent_to_recovery",
			fmt.Sprintf("Account escalated to recovery — case %s created", caseRef), nil, map[string]any{"case_ref": caseRef})

		// Notify collections head
		sendNotification(ctx, db, user.ID, "sent_to_recovery", //nolint:errcheck
			fmt.Sprintf("Account %s sent to recovery", accountCIF),
			fmt.Sprintf("Case %s created", caseRef),
			"recovery_case", toInt64(caseID))

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"case_id":  caseID,
			"case_ref": caseRef,
		})
	}
}

/* ── Per-agent dashboard ──────────────────────────────────────────────────── */

func collectionsOpsAgentDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		// Individual contributors only see themselves; heads see all agents
		agentFilter := ""
		args := []any{}
		if !user.HasPage("collections_assign") {
			agentFilter = "WHERE ca.agent_user_id = $1"
			args = append(args, user.ID)
		}

		agents, err := db.PGQuery(ctx, fmt.Sprintf(`
			WITH contacts_today AS (
				SELECT agent_user_id, COUNT(*) AS cnt
				FROM collection_contacts
				WHERE created_at::date = CURRENT_DATE
				GROUP BY agent_user_id
			),
			ptps_today AS (
				SELECT agent_user_id,
				       COUNT(*) FILTER (WHERE promised_date = CURRENT_DATE)                  AS cnt,
				       COUNT(*) FILTER (WHERE is_kept = TRUE AND actual_date = CURRENT_DATE) AS honoured
				FROM collection_promises
				GROUP BY agent_user_id
			)
			SELECT
				u.id,
				u.full_name,
				COUNT(ca.id)                          AS assigned,
				COALESCE(ct.cnt, 0)                   AS contacts_today,
				COALESCE(pt.cnt, 0)                   AS ptps_today,
				COALESCE(pt.honoured, 0)              AS ptps_honoured_today,
				COALESCE(SUM(ca.outstanding_kobo), 0) AS portfolio_kobo
			FROM o3c_users u
			LEFT JOIN collection_assignments ca ON ca.agent_user_id = u.id AND ca.status = 'active'
			LEFT JOIN contacts_today ct ON ct.agent_user_id = u.id
			LEFT JOIN ptps_today     pt ON pt.agent_user_id = u.id
			%s
			GROUP BY u.id, u.full_name, ct.cnt, pt.cnt, pt.honoured
			ORDER BY contacts_today DESC, assigned DESC`, agentFilter), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if agents == nil {
			agents = []core.Row{}
		}
		respond(w, agents, "pg")
	}
}

/* ── Repayment Plans ──────────────────────────────────────────────────────── */

func collectionsOpsListPlans(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		status := qstr(r, "status")
		q := qstr(r, "q")
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `
			SELECT rp.id, rp.account_cif, rp.customer_name, rp.total_kobo, rp.paid_kobo,
			       rp.instalment_count, rp.paid_count, rp.next_payment_date, rp.status,
			       rp.notes, rp.created_at, u.full_name AS agent_name
			FROM repayment_plans rp
			LEFT JOIN o3c_users u ON rp.agent_user_id = u.id
			WHERE 1=1`
		args := []any{}
		n := 1

		if !user.HasPage("collections_assign") {
			query += fmt.Sprintf(" AND rp.agent_user_id = $%d", n)
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
			query += " AND rp.status IN (" + strings.Join(placeholders, ",") + ")"
		}
		if q != "" {
			if clause, sargs, nn := buildCustomerSearch(q,
				[]string{"rp.account_cif", "rp.customer_name"}, "", n); clause != "" {
				query += " AND " + clause
				args = append(args, sargs...)
				n = nn
			}
		}
		if from != "" {
			query += fmt.Sprintf(" AND rp.created_at::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			query += fmt.Sprintf(" AND rp.created_at::date <= $%d::date", n)
			args = append(args, to)
			n++
		}
		query += fmt.Sprintf(" ORDER BY rp.created_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(ctx, query, args...)
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

func collectionsOpsCreatePlan(db *core.DB) http.HandlerFunc {
	type instalment struct {
		DueDate    string `json:"due_date"`
		AmountKobo int64  `json:"amount_kobo"`
	}
	type body struct {
		AccountCIF   string `json:"account_cif"`
		CustomerName string `json:"customer_name"`
		Notes        string `json:"notes"`
		// Flat form: frontend sends total + count + first date; backend generates monthly dates.
		TotalKobo        int64  `json:"total_kobo"`
		InstalmentCount  int    `json:"instalment_count"`
		FirstPaymentDate string `json:"first_payment_date"`
		// Explicit form: caller may send a pre-built instalment schedule.
		Instalments []instalment `json:"instalments"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.AccountCIF == "" {
			respondErr(w, 400, "account_cif is required")
			return
		}

		// Build instalment schedule from flat form when no explicit list is provided.
		instalments := b.Instalments
		if len(instalments) == 0 {
			if b.TotalKobo == 0 || b.InstalmentCount < 1 || b.FirstPaymentDate == "" {
				respondErr(w, 400, "total_kobo, instalment_count, and first_payment_date are required when instalments list is omitted")
				return
			}
			firstDate, err := time.Parse("2006-01-02", b.FirstPaymentDate)
			if err != nil {
				respondErr(w, 400, "invalid first_payment_date: use YYYY-MM-DD")
				return
			}
			base := b.TotalKobo / int64(b.InstalmentCount)
			remainder := b.TotalKobo - base*int64(b.InstalmentCount)
			instalments = make([]instalment, b.InstalmentCount)
			for i := range instalments {
				amt := base
				if i == len(instalments)-1 {
					amt += remainder // last instalment absorbs the rounding remainder
				}
				instalments[i] = instalment{
					DueDate:    firstDate.AddDate(0, i, 0).Format("2006-01-02"),
					AmountKobo: amt,
				}
			}
		}

		// Guard: reject if an active plan already exists for this account.
		existing, _ := db.PGQuery(ctx,
			`SELECT id FROM repayment_plans WHERE account_cif=$1 AND status='Active' LIMIT 1`,
			b.AccountCIF)
		if len(existing) > 0 {
			respondErr(w, 409, "An active repayment plan already exists for this account")
			return
		}

		total := int64(0)
		for _, i := range instalments {
			total += i.AmountKobo
		}

		ns := func(s string) any {
			if s == "" {
				return nil
			}
			return s
		}

		// Wrap plan + all instalments in one transaction so we never leave a
		// plan without its instalment rows (M36).
		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "Plan creation failed")
			return
		}
		var planID any
		if err = tx.QueryRowContext(ctx,
			`INSERT INTO repayment_plans
			   (account_cif, customer_name, agent_user_id, total_kobo, instalment_count, next_payment_date, notes)
			 VALUES ($1,$2,$3,$4,$5,$6::date,$7) RETURNING id`,
			b.AccountCIF, ns(b.CustomerName), user.ID, total, len(instalments), instalments[0].DueDate, ns(b.Notes),
		).Scan(&planID); err != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "Plan creation failed")
			return
		}
		for i, inst := range instalments {
			if _, iErr := tx.ExecContext(ctx,
				`INSERT INTO repayment_instalments (plan_id, instalment_number, due_date, amount_kobo)
				 VALUES ($1,$2,$3::date,$4)`,
				planID, i+1, inst.DueDate, inst.AmountKobo); iErr != nil {
				tx.Rollback() //nolint:errcheck
				slog.Error("repayment instalment insert failed", "num", i+1, "err", iErr)
				respondErr(w, 500, "Plan creation failed")
				return
			}
		}
		if err = tx.Commit(); err != nil {
			respondErr(w, 500, "Plan creation failed")
			return
		}

		logCreditEvent(ctx, db, r, "collections", "repayment_plan", fmt.Sprint(planID), b.AccountCIF, "plan_created",
			fmt.Sprintf("Repayment plan created with %d instalments", len(instalments)), nil, map[string]any{"account_cif": b.AccountCIF})

		// Notify the creating agent that their plan is live.
		go Notify(context.Background(), db, NotifPayload{
			EventType: EvtRepaymentPlanCreated,
			UserID:    user.ID,
			Title:     "Repayment plan created — " + b.AccountCIF,
			Body:      fmt.Sprintf("Account %s: %d-instalment plan for ₦%.2f created.", b.AccountCIF, len(instalments), float64(total)/100),
			ActionURL: "/collections/repayment-plans",
			EntityRef: fmt.Sprint(planID),
		})

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{"id": planID}) //nolint:errcheck
	}
}

func collectionsOpsListInstalments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pid := chi.URLParam(r, "pid")
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, instalment_number, due_date, amount_kobo, status, paid_at
			 FROM repayment_instalments WHERE plan_id=$1 ORDER BY instalment_number`, pid)
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

func collectionsOpsMarkPaid(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		iid := chi.URLParam(r, "iid")
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		// Fetch instalment + plan info (including account_cif for GL reference) in one query.
		instRows, err := db.PGQuery(ctx, `
			SELECT ri.plan_id, ri.status, ri.amount_kobo, rp.account_cif
			FROM repayment_instalments ri
			JOIN repayment_plans rp ON rp.id = ri.plan_id
			WHERE ri.id=$1`, iid)
		if err != nil || len(instRows) == 0 {
			respondErr(w, 404, "Instalment not found")
			return
		}
		if str(instRows[0]["status"]) == "Paid" {
			respondErr(w, 422, "Already marked paid")
			return
		}
		planID := instRows[0]["plan_id"]
		amountKobo := toInt64(instRows[0]["amount_kobo"])
		accountCIF := str(instRows[0]["account_cif"])

		// Wrap instalment update, plan aggregate update, and GL entry in a single transaction.
		tx, txErr := db.PG.BeginTx(ctx, nil)
		if txErr != nil {
			respondErr(w, 500, "Transaction failed")
			return
		}

		if _, err = tx.ExecContext(ctx,
			`UPDATE repayment_instalments SET status='Paid', paid_at=NOW() WHERE id=$1`, iid); err != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "Mark paid failed")
			return
		}

		if _, err = tx.ExecContext(ctx, `
			UPDATE repayment_plans SET
			   paid_count    = (SELECT COUNT(*) FROM repayment_instalments WHERE plan_id=$1 AND status='Paid'),
			   paid_kobo     = (SELECT COALESCE(SUM(amount_kobo),0) FROM repayment_instalments WHERE plan_id=$1 AND status='Paid'),
			   next_payment_date = (SELECT MIN(due_date) FROM repayment_instalments WHERE plan_id=$1 AND status='Pending'),
			   status = CASE
			     WHEN (SELECT COUNT(*) FROM repayment_instalments WHERE plan_id=$1 AND status != 'Paid') = 0
			     THEN 'Completed' ELSE status END,
			   updated_at = NOW()
			 WHERE id=$1`, planID); err != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "Plan update failed")
			return
		}

		// Record a loan_repayments row too (parity with single/batch payments) so
		// the instalment shows in the payments tab and CIF paid totals — not only
		// in the GL. Best-effort: only when the CIF maps to a booked loan.
		if amountKobo > 0 && accountCIF != "" {
			if lr, lErr := db.PGQuery(ctx,
				`SELECT id FROM loan_applications WHERE applicant_cif=$1 AND status IN ('active','booked') ORDER BY created_at DESC LIMIT 1`, accountCIF); lErr == nil && len(lr) > 0 {
				if _, e := tx.ExecContext(ctx,
					`INSERT INTO loan_repayments (application_id, amount_kobo, payment_date, payment_method, reference, received_by)
					 VALUES ($1,$2,CURRENT_DATE,$3,$4,$5)`,
					toInt64(lr[0]["id"]), amountKobo, "repayment_plan", fmt.Sprintf("RP-INST-%s", iid), user.ID); e != nil {
					tx.Rollback() //nolint:errcheck
					respondErr(w, 500, "Repayment record failed")
					return
				}
			}
		}

		// Post GL entry: Dr Cash (1001) / Cr Loan Receivable (1100).
		if amountKobo > 0 {
			iidInt, _ := strconv.ParseInt(iid, 10, 64)
			ref := fmt.Sprintf("RP-INST-%s", iid)
			if glErr := postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   fmt.Sprintf("Repayment plan instalment paid - CIF %s", accountCIF),
				Reference:     ref,
				DebitAccount:  "1001", // Cash/Bank
				CreditAccount: "1100", // Loan Receivable
				AmountKobo:    amountKobo,
				SourceType:    "repayment_instalment",
				SourceID:      iidInt,
				PostedBy:      user.ID,
			}); glErr != nil {
				tx.Rollback() //nolint:errcheck
				respondErr(w, 500, "GL entry failed")
				return
			}
		}

		if err = tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}
		logCreditEvent(ctx, db, r, "collections", "repayment_plan", iid, accountCIF, "instalment_paid",
			fmt.Sprintf("Repayment plan instalment of ₦%s marked as paid", fmtKoboStr(amountKobo)), nil, map[string]any{"amount_kobo": amountKobo})
		respond(w, map[string]any{"status": "paid"}, "json")
	}
}

/* ── Promise list ─────────────────────────────────────────────────────────── */

func collectionsOpsListPromises(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _ := validDate(r, "date_to")
		status := qstr(r, "status")
		q := qstr(r, "q")
		limit := qint(r, "limit", 100, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `
			SELECT
				cp.id,
				cp.cif_number                                        AS account_cif,
				ca.customer_name,
				COALESCE(ca.outstanding_kobo, 0)                    AS outstanding_kobo,
				cp.promised_amount_kobo                             AS promise_amount_kobo,
				cp.promised_date                                     AS promise_date,
				CASE
					WHEN cp.is_kept IS NULL  THEN 'Pending'
					WHEN cp.is_kept = TRUE   THEN 'Kept'
					ELSE 'Broken'
				END                                                  AS status,
				u.full_name                                          AS agent_name,
				cp.created_at
			FROM collection_promises cp
			LEFT JOIN o3c_users u ON cp.agent_user_id = u.id
			LEFT JOIN LATERAL (
				SELECT outstanding_kobo, customer_name
				FROM collection_assignments
				WHERE account_cif = cp.cif_number
				ORDER BY updated_at DESC LIMIT 1
			) ca ON TRUE
			WHERE 1=1`
		args := []any{}
		n := 1

		if dateFrom != "" {
			query += fmt.Sprintf(" AND cp.promised_date >= $%d", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			query += fmt.Sprintf(" AND cp.promised_date <= $%d", n)
			args = append(args, dateTo)
			n++
		}
		if status != "" {
			vals := strings.Split(status, ",")
			parts := make([]string, 0, len(vals))
			for _, v := range vals {
				switch strings.TrimSpace(v) {
				case "Pending":
					parts = append(parts, "cp.is_kept IS NULL")
				case "Kept":
					parts = append(parts, "cp.is_kept = TRUE")
				case "Broken":
					parts = append(parts, "cp.is_kept = FALSE")
				}
			}
			if len(parts) > 0 {
				query += " AND (" + strings.Join(parts, " OR ") + ")"
			}
		}
		if q != "" {
			if clause, sargs, nn := buildCustomerSearch(q,
				[]string{"cp.cif_number", "u.full_name"}, "", n); clause != "" {
				query += " AND " + clause
				args = append(args, sargs...)
				n = nn
			}
		}

		query += fmt.Sprintf(" ORDER BY cp.promised_date ASC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(ctx, query, args...)
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

/* ── Write-off queue ─────────────────────────────────────────────────────── */

func collectionsOpsListWriteoffs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _ := validDate(r, "date_to")
		dpdRange := qstr(r, "dpd_range")
		limit := qint(r, "limit", 100, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `
			SELECT
				wo.id,
				rc.account_cif,
				(SELECT ca.customer_name FROM collection_assignments ca
				 WHERE ca.account_cif = rc.account_cif
				 ORDER BY ca.updated_at DESC LIMIT 1)         AS customer_name,
				rc.outstanding_kobo,
				CAST(REGEXP_REPLACE(COALESCE(rc.dpd_at_handoff,'0'),'\D','','g') AS INT)
				                                              AS dpd,
				(SELECT MAX(rp.payment_date) FROM recovery_payments rp
				 WHERE rp.case_id = rc.id AND rp.status = 'approved') AS last_payment_date,
				(SELECT COUNT(*) FROM recovery_field_visits rfv WHERE rfv.case_id = rc.id)
				                                              AS recovery_attempts,
				req.full_name                                 AS recommended_by
			FROM recovery_write_off_approvals wo
			JOIN recovery_cases rc ON wo.case_id = rc.id
			LEFT JOIN o3c_users req ON wo.requested_by = req.id
			WHERE wo.status = 'pending'`
		args := []any{}
		n := 1

		if dateFrom != "" {
			query += fmt.Sprintf(" AND wo.created_at::date >= $%d", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			query += fmt.Sprintf(" AND wo.created_at::date <= $%d", n)
			args = append(args, dateTo)
			n++
		}
		if dpdRange != "" {
			vals := strings.Split(dpdRange, ",")
			parts := make([]string, 0, len(vals))
			dpd := "CAST(REGEXP_REPLACE(COALESCE(rc.dpd_at_handoff,'0'),'\\D','','g') AS INT)"
			for _, v := range vals {
				switch strings.TrimSpace(v) {
				case "181-360":
					parts = append(parts, dpd+" BETWEEN 181 AND 360")
				case "361-720":
					parts = append(parts, dpd+" BETWEEN 361 AND 720")
				case "720+":
					parts = append(parts, dpd+" > 720")
				}
			}
			if len(parts) > 0 {
				query += " AND (" + strings.Join(parts, " OR ") + ")"
			}
		}

		query += fmt.Sprintf(" ORDER BY wo.created_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(ctx, query, args...)
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

func collectionsOpsApproveWriteoff(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid write-off ID")
			return
		}
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		tx, txErr := db.PG.BeginTx(ctx, nil)
		if txErr != nil {
			respondErr(w, 500, "Transaction failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Lock the row inside the transaction to prevent concurrent approval (TOCTOU).
		var woStatus string
		var amountKobo, caseID int64
		if err = tx.QueryRowContext(ctx,
			`SELECT status, amount_kobo, case_id FROM recovery_write_off_approvals WHERE id=$1 FOR UPDATE`,
			id).Scan(&woStatus, &amountKobo, &caseID); err != nil {
			respondErr(w, 404, "Write-off not found")
			return
		}
		if woStatus != "pending" {
			respondErr(w, 422, "Write-off already processed")
			return
		}

		if _, err = tx.ExecContext(ctx,
			`UPDATE recovery_write_off_approvals
			 SET status='approved', approved_by=$1, approved_at=NOW()
			 WHERE id=$2`,
			user.ID, id); err != nil {
			respondErr(w, 500, "Approve failed")
			return
		}

		// Close the underlying recovery case so a written-off loan stops resurfacing
		// in the recovery/collections queues (previously GL was posted but the case
		// stayed 'open').
		if _, err = tx.ExecContext(ctx,
			`UPDATE recovery_cases
			 SET status='written_off', write_off_status='approved', write_off_amount_kobo=$1, closed_at=NOW(), updated_at=NOW()
			 WHERE id=$2`, amountKobo, caseID); err != nil {
			respondErr(w, 500, "Failed to close recovery case")
			return
		}

		// Post GL entry: Dr Loan Loss Provision (5200) / Cr Loan Receivable (1100).
		if amountKobo > 0 {
			if glErr := postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   fmt.Sprintf("Loan write-off approved — case #%d", caseID),
				Reference:     fmt.Sprintf("WO-%d", id),
				DebitAccount:  "5200", // Loan Loss Provision
				CreditAccount: "1100", // Loan Receivable
				AmountKobo:    amountKobo,
				SourceType:    "write_off_approval",
				SourceID:      id,
				PostedBy:      user.ID,
			}); glErr != nil {
				respondErr(w, 500, "GL entry failed")
				return
			}
		}

		if err = tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		go NotifyRole(context.Background(), db, "finance_head", NotifPayload{
			EventType: EvtWriteoffApproved,
			Title:     "Write-off approved",
			Body:      fmt.Sprintf("Write-off #%d approved by %s. GL entry posted.", id, user.FullName),
			ActionURL: "/collections/writeoff-queue",
			EntityRef: fmt.Sprint(id),
		})
		respondOK(w, "Write-off approved")
	}
}

func collectionsOpsReturnWriteoff(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid write-off ID")
			return
		}
		ctx := r.Context()

		caseRows, err := db.PGQuery(ctx,
			`SELECT case_id FROM recovery_write_off_approvals WHERE id=$1`, id)
		if err != nil || len(caseRows) == 0 {
			respondErr(w, 404, "Write-off not found")
			return
		}

		// Reject the write-off and reopen the recovery case atomically.
		tx, txErr := db.PG.BeginTx(ctx, nil)
		if txErr != nil {
			respondErr(w, 500, "Transaction failed")
			return
		}
		if _, txErr = tx.ExecContext(ctx,
			`UPDATE recovery_write_off_approvals SET status='rejected' WHERE id=$1`, id); txErr != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "Return failed")
			return
		}
		if _, txErr = tx.ExecContext(ctx,
			`UPDATE recovery_cases SET status='open', updated_at=NOW() WHERE id=$1`,
			caseRows[0]["case_id"]); txErr != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "Return failed")
			return
		}
		if txErr = tx.Commit(); txErr != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		respondOK(w, "Returned to recovery")
	}
}

func collectionsOpsBulkApproveWriteoff(db *core.DB) http.HandlerFunc {
	type body struct {
		IDs []int64 `json:"ids"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || len(b.IDs) == 0 {
			respondErr(w, 400, "ids array required")
			return
		}
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		tx, txErr := db.PG.BeginTx(ctx, nil)
		if txErr != nil {
			respondErr(w, 500, "Transaction failed")
			return
		}

		// Fetch pending rows first so we have amount_kobo for each GL entry.
		pendingRows, err := db.PGQuery(ctx,
			`SELECT id, amount_kobo, case_id FROM recovery_write_off_approvals
			 WHERE id = ANY($1) AND status='pending'`, b.IDs)
		if err != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "Query failed")
			return
		}

		if len(pendingRows) == 0 {
			tx.Rollback() //nolint:errcheck
			respond(w, map[string]any{"approved": 0}, "json")
			return
		}

		// Approve all pending rows in one statement.
		pendingIDs := make([]int64, len(pendingRows))
		for i, row := range pendingRows {
			pendingIDs[i] = toInt64(row["id"])
		}
		if _, err = tx.ExecContext(ctx,
			`UPDATE recovery_write_off_approvals
			 SET status='approved', approved_by=$1, approved_at=NOW()
			 WHERE id = ANY($2)`,
			user.ID, pendingIDs); err != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "Update failed")
			return
		}

		// Close each underlying recovery case so written-off loans stop resurfacing
		// (previously only GL was posted; the case stayed open).
		for _, row := range pendingRows {
			if cid := toInt64(row["case_id"]); cid > 0 {
				if _, err = tx.ExecContext(ctx,
					`UPDATE recovery_cases SET status='written_off', write_off_status='approved', write_off_amount_kobo=$1, closed_at=NOW(), updated_at=NOW() WHERE id=$2`,
					toInt64(row["amount_kobo"]), cid); err != nil {
					tx.Rollback() //nolint:errcheck
					respondErr(w, 500, "Failed to close recovery case")
					return
				}
			}
		}

		// Post a GL entry for each approved write-off.
		for _, row := range pendingRows {
			amountKobo := toInt64(row["amount_kobo"])
			woID := toInt64(row["id"])
			caseID := toInt64(row["case_id"])
			if amountKobo <= 0 {
				continue
			}
			if glErr := postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   fmt.Sprintf("Loan write-off approved — case #%d", caseID),
				Reference:     fmt.Sprintf("WO-%d", woID),
				DebitAccount:  "5200", // Loan Loss Provision
				CreditAccount: "1100", // Loan Receivable
				AmountKobo:    amountKobo,
				SourceType:    "write_off_approval",
				SourceID:      woID,
				PostedBy:      user.ID,
			}); glErr != nil {
				tx.Rollback() //nolint:errcheck
				respondErr(w, 500, "GL entry failed")
				return
			}
		}

		if err = tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		count := len(pendingRows)
		go NotifyRole(context.Background(), db, "finance_head", NotifPayload{
			EventType: EvtWriteoffApproved,
			Title:     fmt.Sprintf("%d write-off(s) bulk approved", count),
			Body:      fmt.Sprintf("%d write-off(s) approved by %s. GL entries posted.", count, user.FullName),
			ActionURL: "/collections/writeoff-queue",
		})
		respond(w, map[string]any{"approved": count}, "json")
	}
}

/* ── Collections-initiated write-off requests ────────────────────────────── */

func collectionsOpsCreateWriteoffRequest(db *core.DB) http.HandlerFunc {
	type body struct {
		AccountCIF      string  `json:"account_cif"`
		WriteoffType    string  `json:"writeoff_type"` // full|partial_amount|percentage|principal_only|interest_only
		Reason          string  `json:"reason"`        // bad_debt|deceased|fraud|natural_disaster|regulatory|other
		ReasonNotes     string  `json:"reason_notes"`
		AmountKobo      int64   `json:"amount_kobo"` // for partial_amount
		Percentage      float64 `json:"percentage"`  // for percentage
		OutstandingKobo int64   `json:"outstanding_kobo"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AccountCIF == "" || b.WriteoffType == "" || b.Reason == "" {
			respondErr(w, 422, "account_cif, writeoff_type and reason are required")
			return
		}
		validTypes := map[string]bool{
			"full": true, "partial_amount": true, "percentage": true,
			"principal_only": true, "interest_only": true,
		}
		if !validTypes[b.WriteoffType] {
			respondErr(w, 422, "invalid writeoff_type")
			return
		}
		switch b.WriteoffType {
		case "partial_amount", "principal_only", "interest_only":
			if b.AmountKobo <= 0 {
				respondErr(w, 422, "amount_kobo must be greater than zero for this writeoff_type")
				return
			}
		case "percentage":
			if b.Percentage <= 0 || b.Percentage > 100 {
				respondErr(w, 422, "percentage must be between 0 and 100")
				return
			}
		}
		user := core.UserFromCtx(r.Context())

		// Find loan for CIF
		loanRows, _ := db.PGQuery(r.Context(), `
			SELECT id FROM loan_applications WHERE applicant_cif = $1 AND status IN ('active','booked')
			ORDER BY created_at DESC LIMIT 1`, b.AccountCIF)
		var loanID *int64
		if len(loanRows) > 0 {
			if v, ok := loanRows[0]["id"].(int64); ok {
				loanID = &v
			}
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO collections_writeoff_requests
			    (account_cif, loan_application_id, requested_by, writeoff_type, reason, reason_notes,
			     amount_kobo, percentage, outstanding_kobo, status, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', NOW())
			RETURNING id, account_cif, writeoff_type, reason, status, created_at`,
			b.AccountCIF, loanID, user.ID, b.WriteoffType, b.Reason, b.ReasonNotes,
			b.AmountKobo, b.Percentage, b.OutstandingKobo)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		logCreditEvent(r.Context(), db, r, "collections", "writeoff_request", fmt.Sprint(rows[0]["id"]), b.AccountCIF, "writeoff_requested",
			fmt.Sprintf("Write-off request submitted — type: %s, reason: %s", b.WriteoffType, b.Reason), nil, map[string]any{"writeoff_type": b.WriteoffType, "reason": b.Reason, "amount_kobo": b.AmountKobo})
		respond(w, rows[0], "pg")
	}
}

func collectionsOpsListWriteoffRequests(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		if status == "" {
			status = "pending"
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    wr.id, wr.account_cif, wr.writeoff_type, wr.reason, wr.reason_notes,
			    wr.amount_kobo, wr.percentage, wr.outstanding_kobo, wr.status,
			    wr.review_notes, wr.reviewed_at, wr.created_at,
			    req.full_name AS requested_by_name,
			    rev.full_name AS reviewed_by_name
			FROM collections_writeoff_requests wr
			LEFT JOIN o3c_users req ON req.id = wr.requested_by
			LEFT JOIN o3c_users rev ON rev.id = wr.reviewed_by
			WHERE wr.status = $1
			ORDER BY wr.created_at DESC
			LIMIT 200`, status)
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

func collectionsOpsApproveWriteoffRequest(db *core.DB) http.HandlerFunc {
	type body struct {
		ReviewNotes string `json:"review_notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid ID")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Fetch the request
		wrRows, err := db.PGQuery(ctx, `
			SELECT id, account_cif, loan_application_id, writeoff_type,
			       amount_kobo, percentage, outstanding_kobo, status
			FROM collections_writeoff_requests WHERE id = $1`, id)
		if err != nil || len(wrRows) == 0 {
			respondErr(w, 404, "Request not found")
			return
		}
		wr := wrRows[0]
		if wr["status"] != "pending" {
			respondErr(w, 422, "Request already reviewed")
			return
		}

		// Determine write-off amount in kobo
		writeoffType, _ := wr["writeoff_type"].(string)
		outstandingKobo, _ := wr["outstanding_kobo"].(int64)
		amtKobo, _ := wr["amount_kobo"].(int64)
		pct, _ := wr["percentage"].(float64)

		var glAmountKobo int64
		switch writeoffType {
		case "full":
			glAmountKobo = outstandingKobo
		case "partial_amount":
			glAmountKobo = amtKobo
		case "percentage":
			glAmountKobo = int64(float64(outstandingKobo) * pct / 100.0)
		case "principal_only", "interest_only":
			// Use stored amount_kobo which caller should set to the principal/interest portion
			glAmountKobo = amtKobo
		default:
			glAmountKobo = outstandingKobo
		}

		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "Transaction start failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Mark request approved
		_, err = tx.ExecContext(ctx, `
			UPDATE collections_writeoff_requests
			SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), review_notes = $2
			WHERE id = $3`,
			user.ID, b.ReviewNotes, id)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}

		// Post GL entry (Dr Loan Loss Provision / Cr Loan Receivable)
		if glAmountKobo > 0 {
			if glErr := postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   fmt.Sprintf("Collections write-off approved — CIF %s (%s)", wr["account_cif"], writeoffType),
				Reference:     fmt.Sprintf("COL-WO-%d", id),
				DebitAccount:  "5200", // Loan Loss Provision / Bad Debt Expense
				CreditAccount: "1100", // Loan Receivable
				AmountKobo:    glAmountKobo,
				SourceType:    "collections_writeoff",
				SourceID:      id,
				PostedBy:      user.ID,
			}); glErr != nil {
				respondErr(w, 500, "GL post failed")
				return
			}
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}
		// A full write-off closes the exposure: mark the loan written-off and drop
		// any active collection assignment for the CIF from the work queue (GL was
		// posted above but the loan previously stayed active and kept resurfacing).
		// Partial/percentage write-offs leave the account open.
		if writeoffType == "full" {
			if laID := toInt64(wr["loan_application_id"]); laID > 0 {
				db.PGExec(ctx, `UPDATE loan_applications SET status='written_off' WHERE id=$1`, laID) //nolint:errcheck
			}
			db.PGExec(ctx, `UPDATE collection_assignments SET status='written_off', updated_at=NOW() WHERE account_cif=$1 AND status='active'`, str(wr["account_cif"])) //nolint:errcheck
		}
		logCreditEvent(ctx, db, r, "collections", "writeoff_request", fmt.Sprint(id), str(wr["account_cif"]), "writeoff_request_approved",
			"Write-off request approved by collections head", nil, map[string]any{"notes": b.ReviewNotes, "writeoff_type": writeoffType})
		respond(w, map[string]any{"id": id, "status": "approved", "gl_amount_kobo": glAmountKobo}, "json")
	}
}

func collectionsOpsRejectWriteoffRequest(db *core.DB) http.HandlerFunc {
	type body struct {
		ReviewNotes string `json:"review_notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid ID")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			UPDATE collections_writeoff_requests
			SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), review_notes = $2
			WHERE id = $3 AND status = 'pending'
			RETURNING id, status, account_cif`,
			user.ID, b.ReviewNotes, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Request not found or already reviewed")
			return
		}
		logCreditEvent(r.Context(), db, r, "collections", "writeoff_request", fmt.Sprint(id), str(rows[0]["account_cif"]), "writeoff_request_rejected",
			fmt.Sprintf("Write-off request rejected — reason: %s", b.ReviewNotes), nil, map[string]any{"notes": b.ReviewNotes})
		respond(w, rows[0], "pg")
	}
}

/* ── Bulk operations ─────────────────────────────────────────────────────── */

func collectionsOpsBulkReassign(db *core.DB) http.HandlerFunc {
	type body struct {
		AssignmentIDs []int64 `json:"assignment_ids"`
		AgentUserID   int64   `json:"agent_user_id"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AgentUserID == 0 || len(b.AssignmentIDs) == 0 {
			respondErr(w, 422, "assignment_ids and agent_user_id are required")
			return
		}
		ctx := r.Context()
		_, err := db.PG.ExecContext(ctx, `
			UPDATE collection_assignments
			SET agent_user_id = $1, updated_at = NOW()
			WHERE id = ANY($2)`, b.AgentUserID, b.AssignmentIDs)
		if err != nil {
			respondErr(w, 500, "Bulk reassign failed")
			return
		}
		logCreditEvent(ctx, db, r, "collections", "assignment", fmt.Sprintf("%d", len(b.AssignmentIDs)), "", "bulk_reassigned",
			fmt.Sprintf("Bulk reassigned %d accounts to agent %d", len(b.AssignmentIDs), b.AgentUserID),
			nil, map[string]any{"agent_user_id": b.AgentUserID, "count": len(b.AssignmentIDs)})
		// Notify the agent the accounts were reassigned to (both channels).
		go Notify(context.Background(), db, NotifPayload{
			EventType: "collections_assigned",
			UserID:    b.AgentUserID,
			Title:     "Collection accounts assigned to you",
			Body:      fmt.Sprintf("%d collection account(s) have been assigned to you.", len(b.AssignmentIDs)),
			ActionURL: "/collections/ops",
		})
		respond(w, map[string]any{"updated": len(b.AssignmentIDs)}, "json")
	}
}

// collectionsOpsDistribute round-robins all currently-unassigned active
// assignments across a head-chosen pool of agents (biggest balances spread first).
// The head picks who is on shift, which sidesteps depending on a fixed
// collections-agent role.
func collectionsOpsDistribute(db *core.DB) http.HandlerFunc {
	type body struct {
		AgentIDs []int64 `json:"agent_ids"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if len(b.AgentIDs) == 0 {
			respondErr(w, 422, "agent_ids is required")
			return
		}
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		var assignedBy any
		if user != nil {
			assignedBy = user.ID
		}
		res, err := db.PGExec(ctx, `
			WITH pool AS (
				SELECT id, ROW_NUMBER() OVER (ORDER BY ord) - 1 AS rn
				FROM (SELECT unnest($1::bigint[]) AS id, generate_subscripts($1::bigint[], 1) AS ord) p
			),
			n AS (SELECT COUNT(*)::int AS c FROM pool),
			todo AS (
				SELECT id, ROW_NUMBER() OVER (ORDER BY outstanding_kobo DESC, id) - 1 AS seq
				FROM collection_assignments
				WHERE status = 'active' AND agent_user_id IS NULL
			)
			UPDATE collection_assignments ca
			SET agent_user_id = pool.id, assigned_by = $2, updated_at = NOW()
			FROM todo, pool, n
			WHERE ca.id = todo.id AND pool.rn = (todo.seq % n.c)`,
			b.AgentIDs, assignedBy)
		if err != nil {
			respondErr(w, 500, "Distribute failed: "+err.Error())
			return
		}
		distributed := int64(0)
		if res != nil {
			distributed, _ = res.RowsAffected()
		}
		logCreditEvent(ctx, db, r, "collections", "assignment", "distribute", "", "queue_distributed",
			fmt.Sprintf("Distributed %d unassigned accounts across %d agents", distributed, len(b.AgentIDs)),
			nil, map[string]any{"distributed": distributed, "agents": len(b.AgentIDs)})
		for _, aid := range b.AgentIDs {
			go Notify(context.Background(), db, NotifPayload{ //nolint:errcheck
				EventType: "collections_assigned", UserID: aid,
				Title:     "Collection accounts assigned to you",
				Body:      "New accounts from the collections queue have been assigned to you.",
				ActionURL: "/collections/queue",
			})
		}
		respond(w, map[string]any{"distributed": distributed, "agents": len(b.AgentIDs)}, "json")
	}
}

// cifAccount is the portfolio-row shape the CIF-keyed bulk actions accept. The
// Portfolio page works off the loan book (CIF-grained) and may not yet have a
// collection_assignments row, so these endpoints take CIF + amount/dpd directly.
type cifAccount struct {
	CIF             string `json:"cif"`
	OutstandingKobo int64  `json:"outstanding_kobo"`
	DPDBucket       string `json:"dpd_bucket"`
}

// collectionsOpsBulkAssignByCIF assigns delinquent accounts (by CIF) to an agent
// from the Portfolio page, creating a collection_assignments row where none
// exists yet (manual counterpart to the assignment-generation job) or reassigning
// the active one.
func collectionsOpsBulkAssignByCIF(db *core.DB) http.HandlerFunc {
	type body struct {
		AgentUserID int64        `json:"agent_user_id"`
		Accounts    []cifAccount `json:"accounts"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AgentUserID == 0 || len(b.Accounts) == 0 {
			respondErr(w, 422, "agent_user_id and accounts are required")
			return
		}
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		var assignedBy any
		if user != nil {
			assignedBy = user.ID
		}
		assigned := 0
		for _, acc := range b.Accounts {
			if acc.CIF == "" {
				continue
			}
			// Reassign an existing active row, else create one.
			res, uErr := db.PGExec(ctx,
				`UPDATE collection_assignments SET agent_user_id=$1, assigned_by=$2, updated_at=NOW()
				 WHERE account_cif=$3 AND status='active'`, b.AgentUserID, assignedBy, acc.CIF)
			affected := int64(0)
			if uErr == nil && res != nil {
				affected, _ = res.RowsAffected()
			}
			if affected == 0 {
				if _, iErr := db.PGExec(ctx,
					`INSERT INTO collection_assignments
					   (cif_number, account_cif, agent_user_id, assigned_by, dpd_bucket, outstanding_kobo, status, assignment_date, created_at, updated_at)
					 VALUES ($1,$1,$2,$3,$4,$5,'active',CURRENT_DATE,NOW(),NOW())`,
					acc.CIF, b.AgentUserID, assignedBy, acc.DPDBucket, acc.OutstandingKobo); iErr != nil {
					continue
				}
			}
			assigned++
		}
		logCreditEvent(ctx, db, r, "collections", "assignment", fmt.Sprint(assigned), "", "bulk_assigned",
			fmt.Sprintf("Bulk assigned %d accounts to agent %d", assigned, b.AgentUserID),
			nil, map[string]any{"agent_user_id": b.AgentUserID, "count": assigned})
		go Notify(context.Background(), db, NotifPayload{
			EventType: "collections_assigned",
			UserID:    b.AgentUserID,
			Title:     "Collection accounts assigned to you",
			Body:      fmt.Sprintf("%d collection account(s) have been assigned to you.", assigned),
			ActionURL: "/collections/queue",
		})
		respond(w, map[string]any{"assigned": assigned, "requested": len(b.Accounts)}, "json")
	}
}

// collectionsOpsBulkEscalateByCIF opens recovery cases for accounts (by CIF)
// straight from the Portfolio page, closing any active assignment. Skips a CIF
// that already has an open recovery case so it can't double-open.
func collectionsOpsBulkEscalateByCIF(db *core.DB) http.HandlerFunc {
	type body struct {
		Accounts []cifAccount `json:"accounts"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if len(b.Accounts) == 0 {
			respondErr(w, 422, "accounts is required")
			return
		}
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		escalated := 0
		refs := make([]string, 0, len(b.Accounts))
		for _, acc := range b.Accounts {
			if acc.CIF == "" {
				continue
			}
			if dup, _ := db.PGQuery(ctx, `SELECT 1 FROM recovery_cases WHERE account_cif=$1 AND status='open' LIMIT 1`, acc.CIF); len(dup) > 0 {
				continue // already in recovery
			}
			// Close any active assignment so it leaves the collections queue.
			db.PGExec(ctx, `UPDATE collection_assignments SET status='sent_to_recovery', updated_at=NOW() WHERE account_cif=$1 AND status='active'`, acc.CIF) //nolint:errcheck
			caseRef, caseID, cErr := openRecoveryCase(ctx, db, acc.CIF, acc.DPDBucket, acc.OutstandingKobo, nil)
			if cErr != nil {
				continue
			}
			escalated++
			refs = append(refs, caseRef)
			logCreditEvent(ctx, db, r, "collections", "assignment", acc.CIF, acc.CIF, "sent_to_recovery",
				fmt.Sprintf("Account escalated to recovery from portfolio — case %s created", caseRef), nil, map[string]any{"case_ref": caseRef})
			if user != nil {
				sendNotification(ctx, db, user.ID, "sent_to_recovery", //nolint:errcheck
					fmt.Sprintf("Account %s sent to recovery", acc.CIF), fmt.Sprintf("Case %s created", caseRef),
					"recovery_case", caseID)
			}
		}
		respond(w, map[string]any{"escalated": escalated, "requested": len(b.Accounts), "case_refs": refs}, "json")
	}
}

func collectionsOpsBulkSendToRecovery(db *core.DB) http.HandlerFunc {
	type body struct {
		AssignmentIDs []int64 `json:"assignment_ids"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if len(b.AssignmentIDs) == 0 {
			respondErr(w, 422, "assignment_ids is required")
			return
		}
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		// Each account must genuinely hand off: open a recovery case and flip the
		// assignment to sent_to_recovery (same semantics as the single path), not
		// just stamp current_stage. Process per-id so one failure doesn't abort all.
		handedOff := 0
		refs := make([]string, 0, len(b.AssignmentIDs))
		for _, aid := range b.AssignmentIDs {
			rows, qErr := db.PGQuery(ctx,
				`SELECT account_cif, COALESCE(outstanding_kobo,0) AS outstanding_kobo, dpd_bucket
				 FROM collection_assignments WHERE id=$1 AND status='active'`, aid)
			if qErr != nil || len(rows) == 0 {
				continue // already handed off / not active — skip
			}
			cif := str(rows[0]["account_cif"])
			outstanding := toInt64(rows[0]["outstanding_kobo"])
			dpd := str(rows[0]["dpd_bucket"])
			aidCopy := aid
			caseRef, caseID, cErr := openRecoveryCase(ctx, db, cif, dpd, outstanding, &aidCopy)
			if cErr != nil {
				continue
			}
			if _, uErr := db.PGExec(ctx,
				`UPDATE collection_assignments SET status='sent_to_recovery', updated_at=NOW() WHERE id=$1`, aid); uErr != nil {
				continue
			}
			handedOff++
			refs = append(refs, caseRef)
			logCreditEvent(ctx, db, r, "collections", "assignment", fmt.Sprint(aid), cif, "sent_to_recovery",
				fmt.Sprintf("Account escalated to recovery — case %s created", caseRef), nil, map[string]any{"case_ref": caseRef})
			if user != nil {
				sendNotification(ctx, db, user.ID, "sent_to_recovery", //nolint:errcheck
					fmt.Sprintf("Account %s sent to recovery", cif), fmt.Sprintf("Case %s created", caseRef),
					"recovery_case", caseID)
			}
		}
		respond(w, map[string]any{"handed_off": handedOff, "requested": len(b.AssignmentIDs), "case_refs": refs}, "json")
	}
}
