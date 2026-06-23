package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterCustomerService(r chi.Router, db *core.DB) {
	access := core.RequirePages("customer_service", "call_center")
	r.With(access).Get("/overview", csOverview(db))
	r.With(access).Get("/calls", csCalls(db))
	r.With(access).Post("/calls", csLogCall(db))
}

func csOverview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCallLogSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Call log setup failed")
			return
		}
		callRows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*) FILTER (WHERE started_at::date = CURRENT_DATE) AS calls_today,
				COUNT(*) FILTER (WHERE outcome = 'resolved' AND started_at > NOW() - INTERVAL '30 days') AS resolved_mtd,
				ROUND((AVG(duration_sec) FILTER (WHERE duration_sec IS NOT NULL) / 60.0)::numeric, 1) AS avg_handle_minutes
			FROM helpdesk_calls`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		openTickets := int64(0)
		if rows, _ := db.PGQuery(r.Context(), `
			SELECT COUNT(*) AS n FROM helpdesk_tickets
			WHERE status NOT IN ('resolved','closed')`); len(rows) > 0 {
			openTickets = toInt64(rows[0]["n"])
		}
		data := map[string]any{
			"calls_today":        0,
			"open_tickets":       openTickets,
			"resolved_mtd":       0,
			"avg_handle_minutes": 0,
		}
		if len(callRows) > 0 {
			data["calls_today"] = toInt64(callRows[0]["calls_today"])
			data["resolved_mtd"] = toInt64(callRows[0]["resolved_mtd"])
			data["avg_handle_minutes"] = callRows[0]["avg_handle_minutes"]
		}
		respond(w, data, "pg")
	}
}

func csCalls(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCallLogSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Call log setup failed")
			return
		}
		cif := qstr(r, "cif")
		q := `
			SELECT id, customer_cif AS cif_number, agent_id,
			       direction AS call_type, duration_sec AS duration_seconds,
			       outcome, notes, outcome AS status, started_at AS created_at
			FROM helpdesk_calls`
		var args []any
		if cif != "" {
			q += ` WHERE customer_cif = $1`
			args = append(args, cif)
		}
		q += ` ORDER BY started_at DESC LIMIT 100`

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func csLogCall(db *core.DB) http.HandlerFunc {
	type callBody struct {
		CIFNumber string `json:"cif_number"`
		AgentName string `json:"agent_name"`
		CallType  string `json:"call_type"`
		Duration  int    `json:"duration_seconds"`
		Outcome   string `json:"outcome"`
		Notes     string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b callBody
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.CIFNumber == "" {
			respondErr(w, 422, "cif_number is required")
			return
		}
		if b.CallType != "inbound" && b.CallType != "outbound" {
			respondErr(w, 422, "call_type must be 'inbound' or 'outbound'")
			return
		}

		user := core.UserFromCtx(r.Context())
		var agentID *int64
		agentName := b.AgentName
		if user != nil {
			agentID = &user.ID
			agentName = user.FullName
		}

		if err := ensureCallLogSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Call log setup failed")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO helpdesk_calls
				(customer_cif, agent_id, agent_name, direction, duration_sec, outcome, notes)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING id`,
			b.CIFNumber, agentID, agentName, b.CallType, b.Duration, b.Outcome, b.Notes)
		if err != nil {
			respondErr(w, 500, "Insert failed: "+err.Error())
			return
		}
		newID := int64(0)
		if len(rows) > 0 {
			newID = toInt64(rows[0]["id"])
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{"id": newID}) //nolint:errcheck
	}
}
