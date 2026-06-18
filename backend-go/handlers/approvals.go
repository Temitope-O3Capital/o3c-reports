package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterApprovals wires the central approvals queue endpoints.
// Returns pending items across LOS, write-offs, and leave requests
// relevant to the authenticated user's role.
func RegisterApprovals(r chi.Router, db *core.DB) {
	r.Get("/pending", approvalsPending(db))
	r.Get("/summary", approvalsSummary(db))
}

// approvalsPending returns all items pending the user's approval action,
// aggregated across LOS, write-offs, and leave, based on role.
func approvalsPending(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		type item struct {
			Module      string `json:"module"`
			ItemID      int64  `json:"item_id"`
			Reference   string `json:"reference"`
			Title       string `json:"title"`
			Description string `json:"description"`
			Stage       string `json:"stage"`
			Amount      *int64 `json:"amount_kobo,omitempty"`
			RequestedBy string `json:"requested_by"`
			WaitingDays int64  `json:"waiting_days"`
			Priority    string `json:"priority"`
		}

		var items []item

		// ── LOS applications waiting for this user's stage ───────────────────
		var losStages []string
		switch user.Role {
		case "sales_head":
			losStages = []string{"submitted"}
		case "risk_officer":
			losStages = []string{"risk_review"}
		case "risk_head":
			losStages = []string{"risk_head_review"}
		case "finance_officer", "finance_head", "cfo":
			losStages = []string{"finance_approval"}
		case "md", "coo":
			losStages = []string{"risk_head_review", "finance_approval", "pending_conditions", "booking"}
		}

		if len(losStages) > 0 {
			for _, stage := range losStages {
				rows, err := db.PGQuery(ctx, `
					SELECT
						la.id,
						la.reference,
						COALESCE(la.borrower_name, 'Unknown') AS title,
						la.stage,
						la.amount_requested_kobo,
						COALESCE(u.full_name, 'Unknown') AS requested_by,
						EXTRACT(DAY FROM NOW() - la.updated_at)::int AS waiting_days,
						CASE WHEN EXTRACT(DAY FROM NOW() - la.updated_at) > 2 THEN 'high'
						     WHEN EXTRACT(DAY FROM NOW() - la.updated_at) > 1 THEN 'medium'
						     ELSE 'normal' END AS priority
					FROM loan_applications la
					LEFT JOIN users u ON u.id = la.created_by
					WHERE la.stage = $1
					  AND la.status NOT IN ('declined','active','written_off')
					ORDER BY la.updated_at ASC
					LIMIT 50`, stage)
				if err == nil {
					for _, row := range rows {
						amt := toInt64(row["amount_requested_kobo"])
						items = append(items, item{
							Module:      "LOS",
							ItemID:      toInt64(row["id"]),
							Reference:   str(row["reference"]),
							Title:       str(row["title"]),
							Description: "Loan application awaiting " + str(row["stage"]) + " review",
							Stage:       str(row["stage"]),
							Amount:      &amt,
							RequestedBy: str(row["requested_by"]),
							WaitingDays: toInt64(row["waiting_days"]),
							Priority:    str(row["priority"]),
						})
					}
				}
			}
		}

		// ── Write-off approvals ───────────────────────────────────────────────
		var wofLevel string
		switch user.Role {
		case "recovery_head":
			wofLevel = "pending_recovery_head"
		case "finance_head", "cfo":
			wofLevel = "pending_finance"
		case "md":
			wofLevel = "pending_md"
		}

		if wofLevel != "" {
			rows, err := db.PGQuery(ctx, `
				SELECT
					wo.id,
					la.reference,
					la.borrower_name                            AS title,
					wo.amount_kobo,
					COALESCE(u.full_name, 'Unknown')            AS requested_by,
					EXTRACT(DAY FROM NOW() - wo.requested_at)::int AS waiting_days
				FROM write_off_requests wo
				JOIN loan_applications la ON la.id = wo.case_id
				LEFT JOIN users u ON u.id = wo.requested_by
				WHERE wo.status = $1
				ORDER BY wo.requested_at ASC
				LIMIT 50`, wofLevel)
			if err == nil {
				for _, row := range rows {
					days := toInt64(row["waiting_days"])
					priority := "normal"
					if days > 7 {
						priority = "high"
					} else if days > 3 {
						priority = "medium"
					}
					amt := toInt64(row["amount_kobo"])
					items = append(items, item{
						Module:      "Write-off",
						ItemID:      toInt64(row["id"]),
						Reference:   str(row["reference"]),
						Title:       str(row["title"]),
						Description: "Write-off request pending approval",
						Stage:       wofLevel,
						Amount:      &amt,
						RequestedBy: str(row["requested_by"]),
						WaitingDays: days,
						Priority:    priority,
					})
				}
			}
		}

		// ── Leave requests ────────────────────────────────────────────────────
		if user.Role == "hr_manager" || user.Role == "hr_officer" {
			rows, err := db.PGQuery(ctx, `
				SELECT
					lr.id,
					lr.id::text                                  AS reference,
					e.full_name                                  AS title,
					lr.leave_type || ' — ' || lr.start_date::text || ' to ' || lr.end_date::text AS description,
					EXTRACT(DAY FROM NOW() - lr.requested_at)::int AS waiting_days
				FROM leave_requests lr
				JOIN employees e ON e.id = lr.employee_id
				WHERE lr.status = 'pending'
				ORDER BY lr.requested_at ASC
				LIMIT 50`)
			if err == nil {
				for _, row := range rows {
					days := toInt64(row["waiting_days"])
					items = append(items, item{
						Module:      "Leave",
						ItemID:      toInt64(row["id"]),
						Reference:   "LV-" + str(row["reference"]),
						Title:       str(row["title"]),
						Description: str(row["description"]),
						Stage:       "pending",
						RequestedBy: str(row["title"]),
						WaitingDays: days,
						Priority:    "normal",
					})
				}
			}
		}

		// ── Compliance findings needing acknowledgment ────────────────────────
		if user.Role == "internal_control_head" || user.Role == "compliance_head" {
			rows, err := db.PGQuery(ctx, `
				SELECT
					f.id,
					f.reference,
					f.title,
					f.severity,
					EXTRACT(DAY FROM NOW() - f.raised_at)::int AS waiting_days
				FROM compliance_findings f
				WHERE f.status = 'open'
				  AND f.acknowledged_at IS NULL
				ORDER BY
					CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
					f.raised_at ASC
				LIMIT 30`)
			if err == nil {
				for _, row := range rows {
					days := toInt64(row["waiting_days"])
					priority := "normal"
					sev := str(row["severity"])
					if sev == "critical" {
						priority = "high"
					} else if sev == "high" {
						priority = "medium"
					}
					items = append(items, item{
						Module:      "Compliance",
						ItemID:      toInt64(row["id"]),
						Reference:   str(row["reference"]),
						Title:       str(row["title"]),
						Description: "Finding requires acknowledgment (" + sev + ")",
						Stage:       "open",
						RequestedBy: "Compliance Team",
						WaitingDays: days,
						Priority:    priority,
					})
				}
			}
		}

		if items == nil {
			items = []item{}
		}
		respond(w, items, "pg")
	}
}

// approvalsSummary returns counts by module for the badge display.
func approvalsSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		summary := map[string]any{
			"los":        0,
			"write_offs": 0,
			"leave":      0,
			"compliance": 0,
			"total":      0,
		}

		// LOS count
		switch user.Role {
		case "sales_head":
			if rows, err := db.PGQuery(ctx, `SELECT COUNT(*) AS c FROM loan_applications WHERE stage='submitted' AND status NOT IN ('declined','active')`); err == nil && len(rows) > 0 {
				summary["los"] = toInt64(rows[0]["c"])
			}
		case "risk_officer":
			if rows, err := db.PGQuery(ctx, `SELECT COUNT(*) AS c FROM loan_applications WHERE stage='risk_review' AND status NOT IN ('declined','active')`); err == nil && len(rows) > 0 {
				summary["los"] = toInt64(rows[0]["c"])
			}
		case "risk_head":
			if rows, err := db.PGQuery(ctx, `SELECT COUNT(*) AS c FROM loan_applications WHERE stage='risk_head_review' AND status NOT IN ('declined','active')`); err == nil && len(rows) > 0 {
				summary["los"] = toInt64(rows[0]["c"])
			}
		case "finance_head", "cfo", "finance_officer":
			if rows, err := db.PGQuery(ctx, `SELECT COUNT(*) AS c FROM loan_applications WHERE stage='finance_approval' AND status NOT IN ('declined','active')`); err == nil && len(rows) > 0 {
				summary["los"] = toInt64(rows[0]["c"])
			}
		case "md", "coo":
			if rows, err := db.PGQuery(ctx, `SELECT COUNT(*) AS c FROM loan_applications WHERE stage IN ('risk_head_review','finance_approval','pending_conditions','booking') AND status NOT IN ('declined','active')`); err == nil && len(rows) > 0 {
				summary["los"] = toInt64(rows[0]["c"])
			}
		}

		// Write-off count
		wofMap := map[string]string{
			"recovery_head": "pending_recovery_head",
			"finance_head":  "pending_finance",
			"cfo":           "pending_finance",
			"md":            "pending_md",
		}
		if wofLevel, ok := wofMap[user.Role]; ok {
			if rows, err := db.PGQuery(ctx, `SELECT COUNT(*) AS c FROM write_off_requests WHERE status=$1`, wofLevel); err == nil && len(rows) > 0 {
				summary["write_offs"] = toInt64(rows[0]["c"])
			}
		}

		// Leave count
		if user.Role == "hr_manager" || user.Role == "hr_officer" {
			if rows, err := db.PGQuery(ctx, `SELECT COUNT(*) AS c FROM leave_requests WHERE status='pending'`); err == nil && len(rows) > 0 {
				summary["leave"] = toInt64(rows[0]["c"])
			}
		}

		// Compliance count
		if user.Role == "internal_control_head" || user.Role == "compliance_head" {
			if rows, err := db.PGQuery(ctx, `SELECT COUNT(*) AS c FROM compliance_findings WHERE status='open' AND acknowledged_at IS NULL`); err == nil && len(rows) > 0 {
				summary["compliance"] = toInt64(rows[0]["c"])
			}
		}

		los := toInt64(summary["los"])
		wo := toInt64(summary["write_offs"])
		lv := toInt64(summary["leave"])
		co := toInt64(summary["compliance"])
		summary["total"] = los + wo + lv + co

		respond(w, summary, "pg")
	}
}
