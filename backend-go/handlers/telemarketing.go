package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterTelemarketing(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("telemarketing"))

	// Campaigns
	r.Get("/campaigns", tmListCampaigns(db))
	r.Post("/campaigns", tmCreateCampaign(db))

	// Leads
	r.Get("/leads", tmListLeads(db))
	r.Post("/leads", tmCreateLead(db))
	r.Patch("/leads/{id}", tmUpdateLead(db))
	r.Post("/leads/{id}/disposition", tmLogDisposition(db))

	// Stats
	r.Get("/stats", tmStats(db))

	// DNC
	r.Get("/dnc", tmListDNC(db))
	r.Post("/dnc", tmAddDNC(db))
	r.Delete("/dnc/{id}", tmRemoveDNC(db))
}

func tmListCampaigns(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT c.id, c.name, c.status, c.target_segment, c.start_date, c.end_date,
			       c.created_at,
			       COUNT(l.id)                                      AS total_leads,
			       COUNT(l.id) FILTER (WHERE l.status = 'converted') AS converted
			FROM telemarketing_campaigns c
			LEFT JOIN telemarketing_leads l ON l.campaign_id = c.id
			GROUP BY c.id
			ORDER BY c.created_at DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func tmCreateCampaign(db *core.DB) http.HandlerFunc {
	type body struct {
		Name          string  `json:"name"`
		Status        string  `json:"status"`
		TargetSegment *string `json:"target_segment"`
		StartDate     *string `json:"start_date"`
		EndDate       *string `json:"end_date"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Name == "" {
			respondErr(w, 400, "name is required")
			return
		}
		if b.Status == "" {
			b.Status = "active"
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO telemarketing_campaigns (name, status, target_segment, start_date, end_date, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
			b.Name, b.Status, b.TargetSegment, b.StartDate, b.EndDate, user.ID)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func tmListLeads(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		campaignID := qstr(r, "campaign_id")
		status := qstr(r, "status")
		agentID := qstr(r, "agent_id")
		search := qstr(r, "search")
		limit := qint(r, "limit", 50, 1, 500)

		q := `SELECT l.id, l.campaign_id, l.customer_cif, l.customer_name,
		             l.customer_phone, l.employer, l.lead_score, l.status,
		             l.assigned_to, l.last_called_at, l.callback_at, l.notes,
		             l.created_at, l.updated_at,
		             u.full_name AS agent_name,
		             c.name AS campaign_name,
		             (SELECT outcome FROM telemarketing_dispositions d WHERE d.lead_id = l.id ORDER BY d.created_at DESC LIMIT 1) AS last_outcome
		      FROM telemarketing_leads l
		      LEFT JOIN o3c_users u ON u.id = l.assigned_to
		      LEFT JOIN telemarketing_campaigns c ON c.id = l.campaign_id
		      WHERE 1=1`
		var args []any
		n := 1

		if campaignID != "" {
			q += fmt.Sprintf(" AND l.campaign_id=$%d", n)
			args = append(args, campaignID)
			n++
		}
		if status != "" {
			q += fmt.Sprintf(" AND l.status=$%d", n)
			args = append(args, status)
			n++
		}
		if agentID != "" {
			q += fmt.Sprintf(" AND l.assigned_to=$%d", n)
			args = append(args, agentID)
			n++
		}
		if search != "" {
			q += fmt.Sprintf(" AND (l.customer_name ILIKE $%d OR l.customer_phone ILIKE $%d OR l.employer ILIKE $%d)", n, n, n)
			args = append(args, "%"+search+"%")
			n++
		}
		args = append(args, limit)
		q += fmt.Sprintf(" ORDER BY l.updated_at DESC LIMIT $%d", n)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func tmCreateLead(db *core.DB) http.HandlerFunc {
	type body struct {
		CampaignID   *int64  `json:"campaign_id"`
		CustomerCIF  *string `json:"customer_cif"`
		CustomerName string  `json:"customer_name"`
		CustomerPhone *string `json:"customer_phone"`
		Employer     *string `json:"employer"`
		LeadScore    int     `json:"lead_score"`
		AssignedTo   *int64  `json:"assigned_to"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.CustomerName == "" {
			respondErr(w, 400, "customer_name is required")
			return
		}
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO telemarketing_leads
			 (campaign_id, customer_cif, customer_name, customer_phone, employer, lead_score, assigned_to)
			 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
			b.CampaignID, b.CustomerCIF, b.CustomerName, b.CustomerPhone,
			b.Employer, b.LeadScore, b.AssignedTo)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func tmUpdateLead(db *core.DB) http.HandlerFunc {
	type body struct {
		Status     *string `json:"status"`
		Notes      *string `json:"notes"`
		CallbackAt *string `json:"callback_at"`
		AssignedTo *int64  `json:"assigned_to"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		q := `UPDATE telemarketing_leads SET updated_at = NOW()`
		var args []any
		n := 1
		if b.Status != nil {
			q += fmt.Sprintf(", status=$%d", n)
			args = append(args, *b.Status)
			n++
		}
		if b.Notes != nil {
			q += fmt.Sprintf(", notes=$%d", n)
			args = append(args, *b.Notes)
			n++
		}
		if b.CallbackAt != nil {
			q += fmt.Sprintf(", callback_at=$%d", n)
			args = append(args, *b.CallbackAt)
			n++
		}
		if b.AssignedTo != nil {
			q += fmt.Sprintf(", assigned_to=$%d", n)
			args = append(args, *b.AssignedTo)
			n++
		}
		args = append(args, id)
		q += fmt.Sprintf(" WHERE id=$%d RETURNING *", n)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Lead not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func tmLogDisposition(db *core.DB) http.HandlerFunc {
	type body struct {
		Outcome     string  `json:"outcome"`
		Notes       *string `json:"notes"`
		DurationSec *int    `json:"duration_sec"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Outcome == "" {
			respondErr(w, 400, "outcome is required")
			return
		}
		user := core.UserFromCtx(r.Context())

		// Map outcome to lead status
		statusMap := map[string]string{
			"interested":      "called",
			"not_interested":  "called",
			"callback":        "callback",
			"no_answer":       "no_answer",
			"voicemail":       "no_answer",
			"dnc":             "dnc",
			"converted":       "converted",
		}
		leadStatus := "called"
		if s, ok := statusMap[b.Outcome]; ok {
			leadStatus = s
		}

		db.PGExec(r.Context(), //nolint:errcheck
			`UPDATE telemarketing_leads SET status=$1, last_called_at=NOW(), updated_at=NOW() WHERE id=$2`,
			leadStatus, id)

		// If marked DNC, add to dnc_list
		if b.Outcome == "dnc" {
			rows, _ := db.PGQuery(r.Context(), `SELECT customer_phone FROM telemarketing_leads WHERE id=$1`, id)
			if len(rows) > 0 && rows[0]["customer_phone"] != nil {
				db.PGExec(r.Context(), //nolint:errcheck
					`INSERT INTO dnc_list (phone, reason, added_by) VALUES ($1, 'Customer requested', $2) ON CONFLICT (phone) DO NOTHING`,
					rows[0]["customer_phone"], user.ID)
			}
		}

		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO telemarketing_dispositions (lead_id, agent_id, outcome, notes, duration_sec)
			 VALUES ($1,$2,$3,$4,$5) RETURNING *`,
			id, user.ID, b.Outcome, b.Notes, b.DurationSec)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func tmStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		totals, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(*)                                                AS total_leads,
			  COUNT(*) FILTER (WHERE status='converted')             AS converted,
			  COUNT(*) FILTER (WHERE status='pending')               AS pending,
			  COUNT(*) FILTER (WHERE status='callback')              AS callbacks,
			  COUNT(*) FILTER (WHERE status='dnc')                   AS dnc_count,
			  COUNT(*) FILTER (WHERE last_called_at::date = CURRENT_DATE) AS called_today
			FROM telemarketing_leads`)

		agents, _ := db.PGQuery(ctx, `
			SELECT u.id, u.full_name,
			       COUNT(d.id)                                        AS calls_made,
			       COUNT(d.id) FILTER (WHERE d.outcome='converted')   AS conversions,
			       COUNT(d.id) FILTER (WHERE d.created_at::date = CURRENT_DATE) AS calls_today
			FROM o3c_users u
			JOIN telemarketing_dispositions d ON d.agent_id = u.id
			WHERE u.deleted_at IS NULL
			GROUP BY u.id, u.full_name
			ORDER BY calls_made DESC
			LIMIT 20`)

		outcomes, _ := db.PGQuery(ctx, `
			SELECT outcome, COUNT(*) AS count
			FROM telemarketing_dispositions
			GROUP BY outcome
			ORDER BY count DESC`)

		totalsRow := map[string]any{"total_leads": 0, "converted": 0, "pending": 0, "callbacks": 0, "dnc_count": 0, "called_today": 0}
		if len(totals) > 0 {
			totalsRow = totals[0]
		}
		if agents == nil {
			agents = []map[string]any{}
		}
		if outcomes == nil {
			outcomes = []map[string]any{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"totals":   totalsRow,
			"agents":   agents,
			"outcomes": outcomes,
		})
	}
}

func tmListDNC(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 100, 1, 500)
		search := qstr(r, "search")

		q := `SELECT d.id, d.phone, d.reason, d.added_at, u.full_name AS added_by_name
		      FROM dnc_list d LEFT JOIN o3c_users u ON u.id = d.added_by WHERE 1=1`
		var args []any
		n := 1
		if search != "" {
			q += fmt.Sprintf(" AND d.phone ILIKE $%d", n)
			args = append(args, "%"+search+"%")
			n++
		}
		args = append(args, limit)
		q += fmt.Sprintf(" ORDER BY d.added_at DESC LIMIT $%d", n)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func tmAddDNC(db *core.DB) http.HandlerFunc {
	type body struct {
		Phone  string  `json:"phone"`
		Reason *string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Phone == "" {
			respondErr(w, 400, "phone is required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO dnc_list (phone, reason, added_by)
			 VALUES ($1,$2,$3)
			 ON CONFLICT (phone) DO UPDATE SET reason=$2, added_by=$3, added_at=NOW()
			 RETURNING *`,
			b.Phone, b.Reason, user.ID)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func tmRemoveDNC(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		_, err := db.PGExec(r.Context(), `DELETE FROM dnc_list WHERE id=$1`, id)
		if err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		w.WriteHeader(204)
	}
}
