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
			       ca.current_stage, ca.notes, ca.created_at, ca.updated_at
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
