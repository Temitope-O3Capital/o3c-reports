package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterRisk(r chi.Router, db *core.DB) {
	access := core.RequirePages("risk_all", "risk_officer", "risk_head")
	r.With(access).Get("/overview", riskOverview(db))
	r.With(access).Get("/portfolio-quality", riskPortfolioQuality(db))
}

func riskOverview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*) AS total_applications,
				COUNT(*) FILTER (WHERE stage IN ('risk_review','risk_head_review')
					AND status NOT IN ('declined','active','written_off')) AS pending_review,
				COUNT(*) FILTER (WHERE (stage='disbursed' OR status='active')
					AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())) AS approved_mtd,
				COUNT(*) FILTER (WHERE status='declined'
					AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())) AS declined_mtd,
				COALESCE(SUM(amount_requested_kobo) FILTER (WHERE status='active'), 0) AS total_portfolio_kobo,
				COUNT(*) FILTER (WHERE status='active' AND dpd > 90) AS npl_count
			FROM loan_applications`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if len(rows) == 0 {
			respond(w, core.Row{}, "pg")
			return
		}
		row := rows[0]

		// Compute approval rate
		approved := toInt64(row["approved_mtd"])
		declined := toInt64(row["declined_mtd"])
		total := approved + declined
		approvalRate := 0.0
		if total > 0 {
			approvalRate = float64(approved) / float64(total) * 100
		}
		row["approval_rate"] = approvalRate

		respond(w, row, "pg")
	}
}

func riskPortfolioQuality(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Applications by stage
		stageRows, err := db.PGQuery(r.Context(),
			`SELECT stage, COUNT(*) AS count FROM loan_applications GROUP BY stage ORDER BY count DESC`)
		if err != nil {
			// Table may not exist — return empty gracefully
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, map[string]any{"by_stage": []core.Row{}, "by_product": []core.Row{}}, "pg")
				return
			}
			respondErr(w, 500, "Query failed")
			return
		}
		if stageRows == nil {
			stageRows = []core.Row{}
		}

		// Product breakdown of active loans (best-effort)
		productRows, _ := db.PGQuery(r.Context(), `
			SELECT loan_type AS product, COUNT(*) AS count,
			       COALESCE(SUM(amount_requested_kobo), 0) AS total_kobo
			FROM loan_applications
			WHERE status='active'
			GROUP BY loan_type ORDER BY count DESC`)
		if productRows == nil {
			productRows = []core.Row{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data_source": "pg",
			"data": map[string]any{
				"by_stage":   stageRows,
				"by_product": productRows,
			},
		})
	}
}
