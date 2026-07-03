package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

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
	r.With(base).Put("/promises/{pid}/honour", collectionsOpsHonourPromise(db))
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
}

func collectionsOpsQueue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		bucket := qstr(r, "dpd_bucket")
		agentID := qstr(r, "agent_id")
		stage := qstr(r, "stage")
		q := qstr(r, "q")
		accountCIF := qstr(r, "account_cif")
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
			WHERE 1=1`
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
			query += fmt.Sprintf(" AND ca.dpd_bucket = $%d", n)
			args = append(args, bucket)
			n++
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
			query += fmt.Sprintf(" AND ca.account_cif ILIKE $%d", n)
			args = append(args, "%"+q+"%")
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

		respondErr(w, 200, "Assigned successfully")
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
		// Scope to promises logged by this agent or by someone the user manages.
		res, err := db.PGQuery(r.Context(), `
			UPDATE collection_promises
			SET is_kept = TRUE, actual_date = CURRENT_DATE
			WHERE id = $1 AND agent_user_id = $2
			RETURNING id`, pid, user.ID)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		if len(res) == 0 {
			respondErr(w, 403, "Promise not found or does not belong to you")
			return
		}
		respondErr(w, 200, "Promise marked as honoured")
	}
}

func collectionsOpsBrokenPromise(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pid, err := strconv.ParseInt(chi.URLParam(r, "pid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid promise ID")
			return
		}

		_, err = db.PGExec(r.Context(), `
			UPDATE collection_promises
			SET is_kept = FALSE
			WHERE id = $1`, pid)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		respondErr(w, 200, "Promise marked as broken")
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
		AgentUserID        int64  `json:"agent_user_id"`
		TargetDate         string `json:"target_date"`
		TargetAmountKobo   int64  `json:"target_amount_kobo"`
		ContactsMade       int    `json:"contacts_made"`
		PromisesObtained   int    `json:"promises_obtained"`
		CollectedAmountKobo int64 `json:"collected_amount_kobo"`
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

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO collection_targets
				(agent_user_id, target_date, target_amount_kobo, collected_amount_kobo,
				 contacts_made, promises_obtained, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
			ON CONFLICT (agent_user_id, target_date) DO UPDATE SET
				target_amount_kobo   = EXCLUDED.target_amount_kobo,
				collected_amount_kobo = EXCLUDED.collected_amount_kobo,
				contacts_made        = EXCLUDED.contacts_made,
				promises_obtained    = EXCLUDED.promises_obtained,
				updated_at           = NOW()
			RETURNING id, agent_user_id, target_date, target_amount_kobo,
			          collected_amount_kobo, contacts_made, promises_obtained`,
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
				SELECT COALESCE(SUM(amount_collected_kobo), 0) AS val
				FROM collections_daily_kpi
				WHERE kpi_date = CURRENT_DATE`},
			{"contacts_today", `
				SELECT COUNT(*) AS val FROM collection_contacts
				WHERE created_at::date = CURRENT_DATE`},
			{"target_kobo", `
				SELECT COALESCE(SUM(target_amount_kobo), 0) AS val
				FROM collection_targets
				WHERE target_date = CURRENT_DATE`},
			// PTP Kept Rate: promises resolved this month that were honoured / total resolved
			{"ptp_kept_rate_pct", `
				SELECT CASE WHEN COUNT(*) = 0 THEN 0
				            ELSE ROUND(100.0 * SUM(CASE WHEN is_kept = TRUE THEN 1 ELSE 0 END) / COUNT(*), 1)
				       END AS val
				FROM collection_promises
				WHERE is_kept IS NOT NULL
				  AND DATE_TRUNC('month', actual_date) = DATE_TRUNC('month', CURRENT_DATE)`},
			// Contact Rate: contacts logged today / total assigned accounts
			{"contact_rate_pct", `
				SELECT CASE WHEN (SELECT COUNT(*) FROM collection_assignments) = 0 THEN 0
				            ELSE ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM collection_assignments), 1)
				       END AS val
				FROM collection_contacts
				WHERE created_at::date = CURRENT_DATE`},
			// Cure Rate: accounts that moved from DPD>0 to DPD=0 this month
			{"cure_rate_pct", `
				SELECT CASE WHEN COUNT(*) = 0 THEN 0
				            ELSE ROUND(100.0 * SUM(CASE WHEN dpd_bucket = '0' THEN 1 ELSE 0 END) / COUNT(*), 1)
				       END AS val
				FROM collection_assignments
				WHERE updated_at >= DATE_TRUNC('month', CURRENT_DATE)`},
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

		// Generate case ref
		refRows, _ := db.PGQuery(ctx, `SELECT LPAD(NEXTVAL('sar_ref_seq')::TEXT,6,'0') AS ref`)
		caseRef := "RC-" + str(refRows[0]["ref"])

		caseRows, err := db.PGQuery(ctx,
			`INSERT INTO recovery_cases
			   (case_ref, cif_number, account_cif, outstanding_kobo, source_assignment_id, dpd_at_handoff, status, opened_at, created_at, updated_at)
			 VALUES ($1,$2,$2,$3,$4,$5,'open',NOW(),NOW(),NOW())
			 RETURNING id`,
			caseRef, accountCIF, outstanding, id, dpd)
		if err != nil {
			respondErr(w, 500, "Failed to create recovery case")
			return
		}
		caseID := caseRows[0]["id"]

		// Close the collection assignment
		db.PGExec(ctx, //nolint:errcheck
			`UPDATE collection_assignments SET status='sent_to_recovery', updated_at=NOW() WHERE id=$1`, id)

		// Notify collections head
		sendNotification(ctx, db, user.ID, "sent_to_recovery", //nolint:errcheck
			fmt.Sprintf("Account %s sent to recovery", accountCIF),
			fmt.Sprintf("Case %s created", caseRef),
			"recovery_case", int64(caseID.(int64)))

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
			SELECT
				u.id,
				u.full_name,
				COUNT(ca.id)                                                          AS assigned,
				COUNT(cc.id) FILTER (WHERE cc.created_at::date = CURRENT_DATE)       AS contacts_today,
				COUNT(cp.id) FILTER (WHERE cp.created_at::date = CURRENT_DATE)       AS ptps_today,
				COUNT(cp.id) FILTER (WHERE cp.is_kept = TRUE
					AND cp.actual_date::date = CURRENT_DATE)                          AS ptps_honoured_today,
				COALESCE(SUM(ca.outstanding_kobo), 0)                                AS portfolio_kobo
			FROM o3c_users u
			LEFT JOIN collection_assignments ca ON ca.agent_user_id = u.id AND ca.status = 'active'
			LEFT JOIN collection_contacts   cc ON cc.agent_user_id = u.id
			LEFT JOIN collection_promises   cp ON cp.agent_user_id = u.id
			%s
			GROUP BY u.id, u.full_name
			ORDER BY contacts_today DESC, assigned DESC`, agentFilter), args...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
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
			args = append(args, user.ID); n++
		}
		if status != "" {
			query += fmt.Sprintf(" AND rp.status = $%d", n)
			args = append(args, status); n++
		}
		if q != "" {
			query += fmt.Sprintf(" AND (rp.account_cif ILIKE $%d OR rp.customer_name ILIKE $%d)", n, n)
			args = append(args, "%"+q+"%"); n++
		}
		query += fmt.Sprintf(" ORDER BY rp.created_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(ctx, query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, map[string]any{"data": rows}, "pg")
	}
}

func collectionsOpsCreatePlan(db *core.DB) http.HandlerFunc {
	type instalment struct {
		DueDate    string `json:"due_date"`
		AmountKobo int64  `json:"amount_kobo"`
	}
	type body struct {
		AccountCIF   string       `json:"account_cif"`
		CustomerName string       `json:"customer_name"`
		Notes        string       `json:"notes"`
		Instalments  []instalment `json:"instalments"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.AccountCIF == "" || len(b.Instalments) == 0 {
			respondErr(w, 400, "account_cif and at least one instalment required"); return
		}

		total := int64(0)
		for _, i := range b.Instalments {
			total += i.AmountKobo
		}

		var nextDate any
		if len(b.Instalments) > 0 {
			nextDate = b.Instalments[0].DueDate
		}
		ns := func(s string) any {
			if s == "" { return nil }
			return s
		}

		planRows, err := db.PGQuery(ctx,
			`INSERT INTO repayment_plans
			   (account_cif, customer_name, agent_user_id, total_kobo, instalment_count, next_payment_date, notes)
			 VALUES ($1,$2,$3,$4,$5,$6::date,$7) RETURNING id`,
			b.AccountCIF, ns(b.CustomerName), user.ID, total, len(b.Instalments), nextDate, ns(b.Notes))
		if err != nil {
			respondErr(w, 500, "Plan creation failed"); return
		}
		planID := planRows[0]["id"]

		for i, inst := range b.Instalments {
			db.PGExec(ctx, //nolint:errcheck
				`INSERT INTO repayment_instalments (plan_id, instalment_number, due_date, amount_kobo)
				 VALUES ($1,$2,$3::date,$4)`,
				planID, i+1, inst.DueDate, inst.AmountKobo)
		}

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
			respondErr(w, 500, "Query failed"); return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, map[string]any{"data": rows}, "pg")
	}
}

func collectionsOpsMarkPaid(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		iid := chi.URLParam(r, "iid")
		ctx := r.Context()

		instRows, err := db.PGQuery(ctx, `SELECT plan_id, status FROM repayment_instalments WHERE id=$1`, iid)
		if err != nil || len(instRows) == 0 {
			respondErr(w, 404, "Instalment not found"); return
		}
		if str(instRows[0]["status"]) == "Paid" {
			respondErr(w, 422, "Already marked paid"); return
		}
		planID := instRows[0]["plan_id"]

		db.PGExec(ctx, //nolint:errcheck
			`UPDATE repayment_instalments SET status='Paid', paid_at=NOW() WHERE id=$1`, iid)

		// Update plan totals
		db.PGExec(ctx, //nolint:errcheck
			`UPDATE repayment_plans SET
			   paid_count    = (SELECT COUNT(*) FROM repayment_instalments WHERE plan_id=$1 AND status='Paid'),
			   paid_kobo     = (SELECT COALESCE(SUM(amount_kobo),0) FROM repayment_instalments WHERE plan_id=$1 AND status='Paid'),
			   next_payment_date = (SELECT MIN(due_date) FROM repayment_instalments WHERE plan_id=$1 AND status='Pending'),
			   status = CASE
			     WHEN (SELECT COUNT(*) FROM repayment_instalments WHERE plan_id=$1 AND status != 'Paid') = 0
			     THEN 'Completed' ELSE status END,
			   updated_at = NOW()
			 WHERE id=$1`, planID)

		respond(w, map[string]any{"status": "paid"}, "json")
	}
}
