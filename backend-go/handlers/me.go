package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterMe mounts personal-dashboard endpoints under /api/me.
func RegisterMe(r chi.Router, db *core.DB) {
	r.Get("/dashboard", meDashboard(db))
}

// meDashboard returns KPIs and recent activity for the authenticated user.
func meDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := core.UserFromCtx(r.Context())
		if claims == nil {
			respondErr(w, 401, "unauthorized")
			return
		}
		uid := claims.ID
		ctx := r.Context()

		type actRow struct {
			Page   string `json:"page"`
			Action string `json:"action"`
			Detail string `json:"detail"`
			TS     string `json:"ts"`
		}
		type ticketRow struct {
			ID       int64  `json:"id"`
			Ref      string `json:"ref"`
			Subject  string `json:"subject"`
			Status   string `json:"status"`
			Priority string `json:"priority"`
			Created  string `json:"created_at"`
		}
		type applicationRow struct {
			ID            int64   `json:"id"`
			Ref           string  `json:"reference"`
			ApplicantName string  `json:"applicant_name"`
			Stage         string  `json:"stage"`
			Status        string  `json:"status"`
			AmountKobo    float64 `json:"amount_requested_kobo"`
			Created       string  `json:"created_at"`
		}
		type leadRow struct {
			ID       int64   `json:"id"`
			Title    string  `json:"title"`
			Stage    string  `json:"stage"`
			ValueKobo float64 `json:"potential_value_kobo"`
			Created  string  `json:"created_at"`
		}
		type collRow struct {
			ID       int64  `json:"id"`
			CIF      string `json:"account_cif"`
			Name     string `json:"customer_name"`
			DPD      int64  `json:"dpd"`
			Status   string `json:"status"`
		}

		out := map[string]any{
			"user_id":         uid,
			"full_name":       claims.FullName,
			"role":            claims.Role,
			"kpi":             map[string]int{},
			"tickets":         []ticketRow{},
			"applications":    []applicationRow{},
			"leads":           []leadRow{},
			"collections":     []collRow{},
			"activity":        []actRow{},
		}

		// ── KPIs ─────────────────────────────────────────────────────────────

		kpi := map[string]int{
			"open_tickets":    0,
			"my_applications": 0,
			"my_leads":        0,
			"my_queue":        0,
		}

		if rows, err := db.PGQuery(ctx, `
			SELECT
			  (SELECT COUNT(*) FROM helpdesk_tickets WHERE assigned_to=$1 AND status NOT IN ('resolved','closed')) AS open_tickets,
			  (SELECT COUNT(*) FROM loan_applications WHERE assigned_to_user_id=$1 AND status NOT IN ('active','closed','rejected','cancelled')) AS my_apps,
			  (SELECT COUNT(*) FROM bd_leads WHERE assigned_to=$1 AND stage NOT IN ('won','lost')) AS my_leads,
			  (SELECT COUNT(*) FROM collection_assignments WHERE agent_user_id=$1 AND status='active') AS my_queue
		`, uid); err == nil && len(rows) > 0 {
			kpi["open_tickets"]    = int(toInt64(rows[0]["open_tickets"]))
			kpi["my_applications"] = int(toInt64(rows[0]["my_apps"]))
			kpi["my_leads"]        = int(toInt64(rows[0]["my_leads"]))
			kpi["my_queue"]        = int(toInt64(rows[0]["my_queue"]))
		}
		out["kpi"] = kpi

		// ── My helpdesk tickets (open, assigned to me) ────────────────────────

		if rows, err := db.PGQuery(ctx, `
			SELECT id, ticket_ref, subject, status, priority, created_at
			FROM helpdesk_tickets
			WHERE assigned_to=$1 AND status NOT IN ('resolved','closed')
			ORDER BY created_at DESC LIMIT 10
		`, uid); err == nil {
			tickets := make([]ticketRow, 0, len(rows))
			for _, row := range rows {
				tickets = append(tickets, ticketRow{
					ID:       toInt64(row["id"]),
					Ref:      str(row["ticket_ref"]),
					Subject:  str(row["subject"]),
					Status:   str(row["status"]),
					Priority: str(row["priority"]),
					Created:  str(row["created_at"]),
				})
			}
			out["tickets"] = tickets
		}

		// ── My loan applications ──────────────────────────────────────────────

		if rows, err := db.PGQuery(ctx, `
			SELECT id, application_reference, applicant_name, stage, status,
			       amount_requested_kobo, created_at
			FROM loan_applications
			WHERE assigned_to_user_id=$1
			ORDER BY updated_at DESC LIMIT 10
		`, uid); err == nil {
			apps := make([]applicationRow, 0, len(rows))
			for _, row := range rows {
				apps = append(apps, applicationRow{
					ID:            toInt64(row["id"]),
					Ref:           str(row["application_reference"]),
					ApplicantName: str(row["applicant_name"]),
					Stage:         str(row["stage"]),
					Status:        str(row["status"]),
					AmountKobo:    toFloat64(row["amount_requested_kobo"]),
					Created:       str(row["created_at"]),
				})
			}
			out["applications"] = apps
		}

		// ── My BD leads ───────────────────────────────────────────────────────

		if rows, err := db.PGQuery(ctx, `
			SELECT id, title, stage, potential_value_kobo, created_at
			FROM bd_leads
			WHERE assigned_to=$1 AND stage NOT IN ('won','lost')
			ORDER BY updated_at DESC LIMIT 10
		`, uid); err == nil {
			leads := make([]leadRow, 0, len(rows))
			for _, row := range rows {
				leads = append(leads, leadRow{
					ID:        toInt64(row["id"]),
					Title:     str(row["title"]),
					Stage:     str(row["stage"]),
					ValueKobo: toFloat64(row["potential_value_kobo"]),
					Created:   str(row["created_at"]),
				})
			}
			out["leads"] = leads
		}

		// ── My collections queue ──────────────────────────────────────────────

		if rows, err := db.PGQuery(ctx, `
			SELECT ca.id, ca.account_cif,
			       COALESCE(ca.customer_name, ca.account_cif) AS customer_name,
			       COALESCE(ca.days_past_due, 0) AS dpd,
			       COALESCE(ca.status, 'active') AS status
			FROM collection_assignments ca
			WHERE ca.agent_user_id=$1 AND ca.status='active'
			ORDER BY ca.days_past_due DESC LIMIT 10
		`, uid); err == nil {
			queue := make([]collRow, 0, len(rows))
			for _, row := range rows {
				queue = append(queue, collRow{
					ID:     toInt64(row["id"]),
					CIF:    str(row["account_cif"]),
					Name:   str(row["customer_name"]),
					DPD:    toInt64(row["dpd"]),
					Status: str(row["status"]),
				})
			}
			out["collections"] = queue
		}

		// ── Recent activity ───────────────────────────────────────────────────

		if rows, err := db.PGQuery(ctx, `
			SELECT page, action, detail, ts
			FROM o3c_activity_log
			WHERE user_id=$1
			ORDER BY ts DESC LIMIT 20
		`, uid); err == nil {
			activity := make([]actRow, 0, len(rows))
			for _, row := range rows {
				activity = append(activity, actRow{
					Page:   str(row["page"]),
					Action: str(row["action"]),
					Detail: str(row["detail"]),
					TS:     str(row["ts"]),
				})
			}
			out["activity"] = activity
		}

		respond(w, out, "pg")
	}
}
