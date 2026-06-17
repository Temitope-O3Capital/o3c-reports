package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

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
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS calls_today,
				COUNT(*) FILTER (WHERE status = 'open') AS open_tickets,
				COUNT(*) FILTER (WHERE status = 'resolved' AND created_at > NOW() - INTERVAL '30 days') AS resolved_mtd,
				ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/60)
					FILTER (WHERE resolved_at IS NOT NULL)::numeric, 1) AS avg_handle_minutes
			FROM cs_interactions`)
		if err != nil {
			// Table may not exist — return zeroed KPIs gracefully
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, map[string]any{
					"calls_today":        0,
					"open_tickets":       0,
					"resolved_mtd":       0,
					"avg_handle_minutes": 0,
				}, "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if len(rows) == 0 {
			respond(w, map[string]any{
				"calls_today":        0,
				"open_tickets":       0,
				"resolved_mtd":       0,
				"avg_handle_minutes": 0,
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func csCalls(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := qstr(r, "cif")
		q := `SELECT * FROM cs_interactions`
		var args []any
		if cif != "" {
			q += ` WHERE cif_number = $1`
			args = append(args, cif)
		}
		q += ` ORDER BY created_at DESC LIMIT 100`

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				jsonRows(w, []core.Row{})
				return
			}
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

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO cs_interactions
				(cif_number, agent_id, call_type, duration_seconds, outcome, notes, status, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, 'open', NOW())
			RETURNING id`,
			b.CIFNumber, user.ID, b.CallType, b.Duration, b.Outcome, b.Notes)
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
