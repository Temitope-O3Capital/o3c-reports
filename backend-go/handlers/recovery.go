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
	"github.com/o3c/workspace/core"
)

func RegisterRecovery(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("recovery"))
	r.Get("/kpis", recoveryKPIs(db))
	r.Get("/by-method", recoveryByMethod(db))
	r.Get("/by-channel", recoveryByChannel(db))
	r.Get("/by-agent", recoveryByAgent(db))
	r.Get("/monthly-trend", recoveryMonthlyTrend(db))
	r.Get("/cases", recoveryCases(db))
	r.Get("/legal", recoveryLegal(db))
	r.Get("/legal-kpis", recoveryLegalKPIs(db))
	r.Get("/solicitors", recoverySolicitors(db))
	r.Put("/cases/{id}/solicitor", recoverySetSolicitor(db))
	r.Get("/cases/{id}/legal-milestones", recoveryLegalMilestones(db))
	r.Post("/cases/{id}/legal-milestone", recoveryAddLegalMilestone(db))
	r.Get("/debt-sales", recoveryDebtSales(db))
	r.Get("/debt-sales/pending", recoveryDebtSalesPending(db))
	r.Post("/debt-sales", recoveryCreateDebtSale(db))
	r.Put("/debt-sales/{id}/approve", recoveryApproveDebtSale(db))
	r.Put("/debt-sales/{id}/reject", recoveryRejectDebtSale(db))
	r.Delete("/debt-sales/{id}", recoveryDeleteDebtSale(db))
}

// recoveryKPIs — the Overview headline, off the LIVE recovery book. This used to read
// a phantom "Recovery Master Sheet" table that no migration ever created, so every KPI
// silently returned zero. It is now computed from recovery_cases (the book handed over
// from Collections) + recovery_payments (the approved-recovery ledger), mirroring the
// Collections/Risk rebuilds.
func recoveryKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		from := qstr(r, "from")
		to := qstr(r, "to")

		kpis := map[string]any{
			"total_in_recovery_kobo": 0, "recovered_mtd_kobo": 0, "success_rate_pct": 0.0,
			"avg_days_in_recovery": 0, "total_recovered_kobo": 0, "open_cases": 0,
			"accounts_in_legal": 0, "total_cases": 0,
		}

		// Book metrics are point-in-time — "in recovery" means the current open book,
		// not "cases opened in the date range". So these are NOT date-filtered; the
		// date filter drives the recovery-ACTIVITY figures (recovered / trend / channel
		// / agent) instead, which is what makes the whole Overview move together.
		if rows, err := db.PGQuery(ctx, `SELECT
			COALESCE(SUM(GREATEST(outstanding_kobo - recovered_kobo, 0)) FILTER (WHERE status NOT IN ('closed','recovered','written_off')),0) AS total_in_recovery_kobo,
			COALESCE(SUM(recovered_kobo),0)                                                                       AS total_recovered_kobo,
			COALESCE(SUM(outstanding_kobo),0)                                                                     AS total_handoff_kobo,
			COUNT(*) FILTER (WHERE status NOT IN ('closed','recovered','written_off'))                            AS open_cases,
			COUNT(*) FILTER (WHERE legal_stage IS NOT NULL AND legal_stage <> '')                                 AS accounts_in_legal,
			COUNT(*)                                                                                              AS total_cases,
			COALESCE(ROUND(AVG(EXTRACT(DAY FROM NOW() - opened_at)) FILTER (WHERE status NOT IN ('closed','recovered','written_off')))::int, 0) AS avg_days_in_recovery
			FROM recovery_cases`); err == nil && len(rows) > 0 {
			row := rows[0]
			kpis["total_in_recovery_kobo"] = row["total_in_recovery_kobo"]
			// Opening portfolio handed to recovery (Σ outstanding at handoff, before any
			// recovery). This is the fixed reference the shrinking "in recovery" figure is
			// measured against — surfaced as an opening-balance card on the Overview.
			kpis["total_handoff_kobo"] = row["total_handoff_kobo"]
			kpis["total_recovered_kobo"] = row["total_recovered_kobo"]
			kpis["open_cases"] = row["open_cases"]
			kpis["accounts_in_legal"] = row["accounts_in_legal"]
			kpis["total_cases"] = row["total_cases"]
			kpis["avg_days_in_recovery"] = row["avg_days_in_recovery"]
			handoff := toFloat(row["total_handoff_kobo"])
			if handoff > 0 {
				kpis["success_rate_pct"] = round1(toFloat(row["total_recovered_kobo"]) / handoff * 100)
			}
		}

		// Recovered in the SELECTED PERIOD from the payments ledger. Recovery payments
		// carry status 'posted' (or 'approved' once the pending-approval flow is used),
		// never 'approved'-only — filtering to 'approved' alone silently zeroed this.
		pw, pargs := recoveryPaymentPeriod(from, to)
		if rows, _ := db.PGQuery(ctx, `SELECT COALESCE(SUM(amount_kobo),0) AS v
			FROM recovery_payments WHERE status IN ('approved','posted')`+pw, pargs...); len(rows) > 0 {
			kpis["recovered_mtd_kobo"] = rows[0]["v"]
		}
		kpis["total_npl_balance"] = kpis["total_in_recovery_kobo"]

		// Card vs loan split of the open book — loans are now in the recovery book too,
		// so the Overview should show what share of it they are.
		if rows, err := db.PGQuery(ctx, `SELECT
			COALESCE(product_type,'card') AS product,
			COUNT(*) FILTER (WHERE status NOT IN ('closed','recovered','written_off'))                                   AS open_cases,
			COALESCE(SUM(GREATEST(outstanding_kobo - recovered_kobo,0)) FILTER (WHERE status NOT IN ('closed','recovered','written_off')),0) AS in_recovery_kobo,
			COALESCE(SUM(recovered_kobo),0)                                                                              AS recovered_kobo
			FROM recovery_cases GROUP BY 1 ORDER BY in_recovery_kobo DESC`); err == nil {
			kpis["by_product"] = rows
		}

		respond(w, kpis, "pg")
	}
}

// recoveryPaymentPeriod builds a " AND payment_date::date BETWEEN ..." clause for the
// recovery-activity date filter, shared by the KPI, trend, channel and agent handlers
// so the whole Overview responds to one filter consistently.
func recoveryPaymentPeriod(from, to string) (string, []any) {
	where := ""
	args := []any{}
	n := 1
	if from != "" && dateRE.MatchString(from) {
		where += fmt.Sprintf(" AND payment_date::date >= $%d::date", n)
		args = append(args, from)
		n++
	}
	if to != "" && dateRE.MatchString(to) {
		where += fmt.Sprintf(" AND payment_date::date <= $%d::date", n)
		args = append(args, to)
		n++
	}
	return where, args
}

func recoveryByMethod(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT "Recovery Method", COALESCE(SUM("Recovery Amount"),0) AS total, COUNT(*) AS count
			 FROM "Recovery Master Sheet" GROUP BY "Recovery Method" ORDER BY total DESC`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

// recoveryMonthlyTrend — recovered amount per month across the SELECTED date range
// (defaults to a trailing 12 months), off the live payments ledger. The month spine
// is generated from the range so the area chart never renders a ragged axis, and it
// moves with the Overview date filter like every other panel. Counts 'posted' and
// 'approved' payments (the terminal money-received states).
func recoveryMonthlyTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")
		startExpr := "DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months'"
		endExpr := "DATE_TRUNC('month',CURRENT_DATE)"
		args := []any{}
		n := 1
		if from != "" && dateRE.MatchString(from) {
			startExpr = fmt.Sprintf("DATE_TRUNC('month',$%d::date)", n)
			args = append(args, from)
			n++
		}
		if to != "" && dateRE.MatchString(to) {
			endExpr = fmt.Sprintf("DATE_TRUNC('month',$%d::date)", n)
			args = append(args, to)
			n++
		}
		query := fmt.Sprintf(`
			WITH months AS (SELECT GENERATE_SERIES(%s, %s, INTERVAL '1 month') AS m),
			p AS (
				SELECT DATE_TRUNC('month', payment_date::date) AS m, COALESCE(SUM(amount_kobo),0) AS amount_kobo
				FROM recovery_payments WHERE status IN ('approved','posted')
				GROUP BY 1
			)
			SELECT TO_CHAR(months.m,'Mon YYYY') AS month, COALESCE(p.amount_kobo,0) AS amount_kobo
			FROM months LEFT JOIN p ON p.m = months.m ORDER BY months.m`, startExpr, endExpr)
		data, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if data == nil {
			data = []core.Row{}
		}
		respond(w, data, "pg")
	}
}

func recoveryCases(db *core.DB) http.HandlerFunc {
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
		limit := qint(r, "limit", 200, 1, 1000)

		var f Filter
		f.Date("r.[Recovery Date]", `r."Recovery Date"`, dateFrom, dateTo)

		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT r."CIF Number", a.first_name AS "First Name", a.last_name AS "Last Name",
			        r."Recovery Amount", r."Recovery Method", r."Legal Stage",
			        r."Agent", r."Status", r."Recovery Date"
			 FROM "Recovery Master Sheet" r
			 LEFT JOIN app.customers a ON r."CIF Number"=a.cif
			 WHERE 1=1%s ORDER BY r."Recovery Date" DESC LIMIT %d`, f.PG(), limit),
			f.Args()...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

// ── New endpoints ─────────────────────────────────────────────────────────────

// recoveryByChannel aggregates recovered amounts by payment channel for the selected
// period. Counts posted/approved payments and uses the shared period filter so it
// moves with the rest of the Overview.
func recoveryByChannel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where, args := recoveryPaymentPeriod(qstr(r, "from"), qstr(r, "to"))
		rows, err := db.PGQuery(r.Context(), `
			SELECT COALESCE(NULLIF(TRIM(channel),''),'Unspecified') AS channel,
			       COALESCE(SUM(amount_kobo), 0) AS amount_kobo,
			       ROUND(100.0 * SUM(amount_kobo) / NULLIF(SUM(SUM(amount_kobo)) OVER (), 0), 1) AS pct
			FROM recovery_payments
			WHERE status IN ('approved','posted')`+where+`
			GROUP BY 1
			ORDER BY amount_kobo DESC`, args...)
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

// recoveryByAgent — agent performance for the selected period. case_count is the
// agent's CURRENT assigned load; recovered_kobo is what they actually collected in the
// period (posted/approved payments on their cases), so the table reflects recovery
// activity and moves with the date filter. Was previously keyed off rc.opened_at +
// rc.recovered_kobo, which put all recovery on whoever the case is now assigned to and
// didn't respond to the activity window.
func recoveryByAgent(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where, args := recoveryPaymentPeriod(qstr(r, "from"), qstr(r, "to"))
		// The period clause targets rp.payment_date; qualify it for the LEFT JOIN.
		payWhere := strings.ReplaceAll(where, "payment_date", "rp.payment_date")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    COALESCE(u.full_name, 'Unassigned') AS agent_name,
			    COUNT(DISTINCT rc.id) AS case_count,
			    COALESCE(SUM(rp.amount_kobo), 0) AS recovered_kobo,
			    ROUND(100.0 * COUNT(DISTINCT rc.id) FILTER (WHERE rc.status IN ('closed','recovered'))
			          / NULLIF(COUNT(DISTINCT rc.id), 0), 1) AS success_rate_pct
			FROM recovery_cases rc
			LEFT JOIN o3c_users u ON rc.assigned_agent_id = u.id
			LEFT JOIN recovery_payments rp
			       ON rp.case_id = rc.id AND rp.status IN ('approved','posted')`+payWhere+`
			GROUP BY u.full_name
			ORDER BY recovered_kobo DESC, case_count DESC`, args...)
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

// recoveryLegal lists recovery cases that have entered the legal stage.
func recoveryLegal(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 200, 1, 1000)
		from := qstr(r, "from")
		to := qstr(r, "to")
		milestone := qstr(r, "milestone")
		q := qstr(r, "q")
		var extraWhere string
		var args []any
		n := 1
		if from != "" {
			extraWhere += fmt.Sprintf(" AND rc.opened_at::date >= $%d", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			extraWhere += fmt.Sprintf(" AND rc.opened_at::date <= $%d", n)
			args = append(args, to)
			n++
		}
		if milestone != "" {
			vals := strings.Split(milestone, ",")
			placeholders := make([]string, len(vals))
			for i, v := range vals {
				placeholders[i] = fmt.Sprintf("$%d", n)
				args = append(args, strings.TrimSpace(v))
				n++
			}
			extraWhere += " AND rc.legal_stage IN (" + strings.Join(placeholders, ",") + ")"
		}
		if q != "" {
			if clause, sargs, nn := buildCustomerSearch(q,
				[]string{"rc.account_cif", "rc.customer_name", "rc.solicitor"}, "", n); clause != "" {
				extraWhere += " AND " + clause
				args = append(args, sargs...)
				n = nn
			}
		}
		args = append(args, limit)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			    rc.id,
			    rc.id AS case_id,
			    rc.account_cif,
			    COALESCE(NULLIF(TRIM(rc.customer_name),''), NULLIF(TRIM(CONCAT(c.first_name,' ',c.last_name)),''), rc.account_cif) AS customer_name,
			    rc.outstanding_kobo,
			    rc.legal_stage AS current_milestone,
			    rc.solicitor AS solicitor,
			    lp.next_hearing_date AS next_court_date,
			    EXTRACT(DAY FROM NOW() - rc.opened_at)::int AS days_in_legal
			FROM recovery_cases rc
			LEFT JOIN app.customers c ON c.cif = rc.account_cif
			LEFT JOIN LATERAL (
			    SELECT court_name, next_hearing_date
			    FROM legal_proceedings
			    WHERE case_id = rc.id
			    ORDER BY filing_date DESC
			    LIMIT 1
			) lp ON true
			WHERE rc.legal_stage IS NOT NULL%s
			ORDER BY rc.updated_at DESC
			LIMIT $%d`, extraWhere, n), args...)
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

// recoverySolicitors returns the distinct solicitor / law-firm names already present on
// the recovery book (the case's own solicitor column plus any firm captured as a legal
// proceeding's court_name), so the Legal page can offer pick-or-type suggestions.
func recoverySolicitors(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT DISTINCT TRIM(name) AS solicitor FROM (
			    SELECT solicitor  AS name FROM recovery_cases    WHERE COALESCE(TRIM(solicitor),'')  <> ''
			    UNION
			    SELECT court_name AS name FROM legal_proceedings WHERE COALESCE(TRIM(court_name),'') <> ''
			) s
			ORDER BY 1`)
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

// recoverySetSolicitor maps a recovery case to the solicitor / law firm handling it.
func recoverySetSolicitor(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var body struct {
			Solicitor string `json:"solicitor"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		sol := strings.TrimSpace(body.Solicitor)
		if _, err := db.PGExec(r.Context(),
			`UPDATE recovery_cases SET solicitor = NULLIF($1,''), updated_at = NOW() WHERE id = $2`,
			sol, id); err != nil {
			respondErrLog(w, 500, "Update failed", err)
			return
		}
		respond(w, core.Row{"ok": true, "solicitor": sol}, "pg")
	}
}

// recoveryLegalKPIs returns aggregate KPIs for cases in legal.
func recoveryLegalKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    COUNT(DISTINCT rc.id) AS total_cases,
			    COUNT(DISTINCT rc.id) FILTER (WHERE rc.status IN ('active','legal')) AS active,
			    COUNT(*) FILTER (WHERE lp.outcome = 'won') AS won,
			    ROUND(AVG(
			        EXTRACT(DAY FROM COALESCE(rc.closed_at, NOW()) - rc.opened_at)
			    ))::int AS avg_days,
			    COALESCE(SUM(rc.recovered_kobo), 0) AS total_debt_recovered_kobo
			FROM recovery_cases rc
			LEFT JOIN legal_proceedings lp ON lp.case_id = rc.id
			WHERE rc.legal_stage IS NOT NULL`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		kpis := core.Row{"total_cases": 0, "active": 0, "won": 0, "avg_days": 0, "total_debt_recovered_kobo": 0}
		if len(rows) > 0 {
			kpis = rows[0]
		}
		respond(w, kpis, "pg")
	}
}

// recoveryLegalMilestones lists legal proceedings for a case, shaped as milestones.
func recoveryLegalMilestones(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    id,
			    proceeding_type AS milestone_type,
			    filing_date AS milestone_date,
			    notes,
			    (status NOT IN ('active', 'pending') OR status IS NULL) AS completed
			FROM legal_proceedings
			WHERE case_id = $1
			ORDER BY filing_date ASC`, id)
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

// recoveryAddLegalMilestone inserts a new legal proceeding milestone for a case.
func recoveryAddLegalMilestone(db *core.DB) http.HandlerFunc {
	type body struct {
		MilestoneType string `json:"milestone_type"`
		MilestoneDate string `json:"milestone_date"`
		Notes         string `json:"notes"`
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
		if b.MilestoneType == "" || b.MilestoneDate == "" {
			respondErr(w, 422, "milestone_type and milestone_date are required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO legal_proceedings
			    (case_id, proceeding_type, filing_date, notes, status, created_at)
			VALUES ($1, $2, $3, $4, 'active', NOW())
			RETURNING id,
			          proceeding_type AS milestone_type,
			          filing_date AS milestone_date,
			          notes,
			          status`,
			id, b.MilestoneType, b.MilestoneDate, b.Notes)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		if len(rows) == 0 {
			respondErr(w, 500, "Insert returned no result")
			return
		}
		cif := ""
		if cifRows, _ := db.PGQuery(r.Context(), `SELECT account_cif FROM recovery_cases WHERE id = $1`, id); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(r.Context(), db, r, "recovery", "legal_milestone", fmt.Sprint(rows[0]["id"]), cif, "legal_milestone_added",
			fmt.Sprintf("Legal milestone: %s", b.MilestoneType), nil, map[string]any{"milestone": b.MilestoneType})
		go NotifyRoles(context.Background(), db, []string{"recovery_head", "compliance_officer"}, NotifPayload{
			EventType: EvtRecoveryLegalMilestone,
			Title:     "Legal Milestone Recorded",
			Body:      fmt.Sprintf("Milestone '%s' has been added to recovery case #%d", b.MilestoneType, id),
			ActionURL: "/recovery/legal",
			EntityRef: fmt.Sprintf("recovery_case:%d", id),
		})
		respond(w, rows[0], "pg")
	}
}

func recoveryDebtSales(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")
		var where string
		var args []any
		n := 1
		if from != "" {
			where += fmt.Sprintf(" AND sale_date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			where += fmt.Sprintf(" AND sale_date <= $%d::date", n)
			args = append(args, to)
			n++
		}
		_ = n
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, buyer_name, sale_date, account_count,
			       face_value_kobo, sale_price_kobo, recovery_post_sale_kobo,
			       notes, created_at, COALESCE(status,'approved') AS status
			FROM debt_sales
			WHERE deleted_at IS NULL`+where+`
			ORDER BY sale_date DESC`, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		for _, row := range rows {
			st := str(row["status"])
			row["stage_label"] = writeOffStageLabel(st)
			if prog, ok := stageProgressions[st]; ok {
				row["required_role"] = prog.required
			} else {
				row["required_role"] = ""
			}
		}
		respond(w, rows, "pg")
	}
}

func recoveryCreateDebtSale(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			BuyerName            string `json:"buyer_name"`
			SaleDate             string `json:"sale_date"`
			AccountCount         int    `json:"account_count"`
			FaceValueKobo        int64  `json:"face_value_kobo"`
			SalePriceKobo        int64  `json:"sale_price_kobo"`
			RecoveryPostSaleKobo int64  `json:"recovery_post_sale_kobo"`
			Notes                string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if body.BuyerName == "" || body.SaleDate == "" {
			respondErr(w, 422, "buyer_name and sale_date are required")
			return
		}
		if body.FaceValueKobo <= 0 {
			respondErr(w, 422, "face_value_kobo must be greater than zero")
			return
		}
		if body.SalePriceKobo > body.FaceValueKobo {
			respondErr(w, 422, "sale_price_kobo cannot exceed face_value_kobo")
			return
		}
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		tx, txErr := db.PG.BeginTx(ctx, nil)
		if txErr != nil {
			respondErr(w, 500, "Transaction start failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		var saleID int64
		var buyerName, saleDate, notes string
		var accountCount int
		var faceValueKobo, salePriceKobo, recoveryPostSaleKobo int64
		var createdAt any
		// Enters the HOP → COO → CFO chain as 'pending_hop'. The GL is NOT posted here —
		// it posts only at the final (CFO) approval (recoveryApproveDebtSale).
		if err := tx.QueryRowContext(ctx, `
			INSERT INTO debt_sales
			    (buyer_name, sale_date, account_count, face_value_kobo,
			     sale_price_kobo, recovery_post_sale_kobo, notes, requested_by, status)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			RETURNING id, buyer_name, sale_date, account_count,
			          face_value_kobo, sale_price_kobo, recovery_post_sale_kobo,
			          notes, created_at`,
			body.BuyerName, body.SaleDate, body.AccountCount,
			body.FaceValueKobo, body.SalePriceKobo, body.RecoveryPostSaleKobo,
			nullStr(body.Notes), user.ID, writeOffChainStart).Scan(
			&saleID, &buyerName, &saleDate, &accountCount,
			&faceValueKobo, &salePriceKobo, &recoveryPostSaleKobo,
			&notes, &createdAt,
		); err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		logCreditEvent(ctx, db, r, "recovery", "debt_sale", fmt.Sprint(saleID), "", "debt_sale_created",
			fmt.Sprintf("Debt sale to %s (sale price ₦%s) submitted — pending approval", body.BuyerName, fmtKoboStr(body.SalePriceKobo)), nil, map[string]any{"buyer_name": body.BuyerName, "sale_price_kobo": body.SalePriceKobo})

		row := core.Row{
			"id": saleID, "buyer_name": buyerName, "sale_date": saleDate,
			"account_count": accountCount, "face_value_kobo": faceValueKobo,
			"sale_price_kobo": salePriceKobo, "recovery_post_sale_kobo": recoveryPostSaleKobo,
			"notes": notes, "created_at": createdAt, "status": writeOffChainStart,
		}
		if firstStage, ok := stageProgressions[writeOffChainStart]; ok {
			go NotifyRole(context.Background(), db, firstStage.required, NotifPayload{
				EventType: EvtRecoveryDebtSale,
				Title:     "Debt sale awaiting approval",
				Body:      fmt.Sprintf("A debt sale to %s (₦%s) needs %s sign-off.", body.BuyerName, fmtKoboStr(body.SalePriceKobo), firstStage.label),
				ActionURL: "/recovery/debt-sales",
				EntityRef: fmt.Sprintf("debt_sale:%d", saleID),
			})
		}
		respond(w, row, "pg")
	}
}

// recoveryDebtSalesPending lists debt sales still moving through the approval chain,
// annotated with the stage + role due to sign next.
func recoveryDebtSalesPending(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT ds.id, ds.buyer_name, ds.sale_date, ds.account_count,
			       ds.face_value_kobo, ds.sale_price_kobo, ds.recovery_post_sale_kobo,
			       ds.status, ds.created_at, u.full_name AS requested_by_name
			FROM debt_sales ds
			LEFT JOIN o3c_users u ON u.id = ds.requested_by
			WHERE ds.deleted_at IS NULL AND ds.status NOT IN ('approved','rejected')
			ORDER BY ds.created_at ASC LIMIT 200`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		for _, row := range rows {
			st := str(row["status"])
			row["stage_label"] = writeOffStageLabel(st)
			if prog, ok := stageProgressions[st]; ok {
				row["required_role"] = prog.required
			} else {
				row["required_role"] = ""
			}
		}
		respond(w, rows, "pg")
	}
}

// recoveryApproveDebtSale advances a debt sale along HOP → COO → CFO; the GL posts only at
// the final (CFO) stage (Dr Cash / Cr Loan Receivable on the sale price).
func recoveryApproveDebtSale(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid debt sale ID")
			return
		}
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()
		drows, derr := db.PGQuery(ctx, `SELECT status, sale_price_kobo, buyer_name, requested_by FROM debt_sales WHERE id=$1 AND deleted_at IS NULL`, id)
		if derr != nil || len(drows) == 0 {
			respondErr(w, 404, "Debt sale not found")
			return
		}
		cur := str(drows[0]["status"])
		prog, ok := stageProgressions[cur]
		if !ok {
			respondErr(w, 422, fmt.Sprintf("Debt sale is already '%s' and cannot be advanced", cur))
			return
		}
		if user.Role != prog.required && user.Role != "admin" {
			respondErr(w, 403, fmt.Sprintf("This approval stage requires the '%s' (%s) role", prog.required, prog.label))
			return
		}
		salePrice := toInt64(drows[0]["sale_price_kobo"])
		buyer := str(drows[0]["buyer_name"])
		isFinal := prog.next == "approved"

		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "Transaction start failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		var updatedID int64
		var scanErr error
		if isFinal {
			scanErr = tx.QueryRowContext(ctx, `UPDATE debt_sales SET status=$1, approved_by=$2, approved_at=NOW(), updated_at=NOW() WHERE id=$3 AND status=$4 RETURNING id`,
				prog.next, user.ID, id, cur).Scan(&updatedID)
		} else {
			scanErr = tx.QueryRowContext(ctx, `UPDATE debt_sales SET status=$1, updated_at=NOW() WHERE id=$2 AND status=$3 RETURNING id`,
				prog.next, id, cur).Scan(&updatedID)
		}
		if scanErr == sql.ErrNoRows {
			respondErr(w, 409, "Debt sale status changed concurrently — please refresh")
			return
		}
		if scanErr != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		if isFinal && salePrice > 0 {
			if glErr := postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   fmt.Sprintf("Debt sale to %s", buyer),
				Reference:     fmt.Sprintf("DS-%d", id),
				DebitAccount:  "1001",
				CreditAccount: "1100",
				AmountKobo:    salePrice,
				SourceType:    "debt_sale",
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
		logCreditEvent(ctx, db, r, "recovery", "debt_sale", fmt.Sprint(id), "", "debt_sale_approved",
			fmt.Sprintf("Debt sale to %s — %s", buyer, writeOffStageLabel(prog.next)), nil, map[string]any{"stage": prog.next})
		if nextStage, ok := stageProgressions[prog.next]; ok {
			NotifyRole(ctx, db, nextStage.required, NotifPayload{
				EventType: EvtRecoveryDebtSale, Title: "Debt sale awaiting approval",
				Body:      fmt.Sprintf("A debt sale to %s (₦%s) now needs %s sign-off.", buyer, fmtKoboStr(salePrice), nextStage.label),
				ActionURL: "/recovery/debt-sales", EntityRef: fmt.Sprintf("debt_sale:%d", id), Priority: "high",
			})
		} else if isFinal {
			if rb := toInt64(drows[0]["requested_by"]); rb > 0 {
				NotifyUsers(ctx, db, []int64{rb}, NotifPayload{
					EventType: EvtRecoveryDebtSale, Title: "Debt sale approved",
					Body:      fmt.Sprintf("The debt sale to %s was fully approved and posted.", buyer),
					ActionURL: "/recovery/debt-sales", EntityRef: fmt.Sprintf("debt_sale:%d", id), Priority: "normal",
				})
			}
		}
		respond(w, map[string]any{"id": id, "status": prog.next}, "json")
	}
}

// recoveryRejectDebtSale rejects a debt sale at its current stage.
func recoveryRejectDebtSale(db *core.DB) http.HandlerFunc {
	type body struct {
		RejectionReason string `json:"rejection_reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid debt sale ID")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()
		drows, derr := db.PGQuery(ctx, `SELECT status, requested_by, buyer_name FROM debt_sales WHERE id=$1 AND deleted_at IS NULL`, id)
		if derr != nil || len(drows) == 0 {
			respondErr(w, 404, "Debt sale not found")
			return
		}
		cur := str(drows[0]["status"])
		prog, ok := stageProgressions[cur]
		if !ok {
			respondErr(w, 422, "Debt sale is already finalised")
			return
		}
		if user.Role != prog.required && user.Role != "admin" {
			respondErr(w, 403, fmt.Sprintf("This stage requires the '%s' (%s) role", prog.required, prog.label))
			return
		}
		rows, err := db.PGQuery(ctx, `UPDATE debt_sales SET status='rejected', approved_by=$1, approved_at=NOW(), rejection_reason=$2, updated_at=NOW() WHERE id=$3 AND status=$4 RETURNING id, status`,
			user.ID, b.RejectionReason, id, cur)
		if err != nil || len(rows) == 0 {
			respondErr(w, 409, "Debt sale status changed — please refresh")
			return
		}
		if rb := toInt64(drows[0]["requested_by"]); rb > 0 {
			NotifyUsers(ctx, db, []int64{rb}, NotifPayload{
				EventType: EvtRecoveryDebtSale, Title: "Debt sale rejected",
				Body:      fmt.Sprintf("The debt sale to %s was rejected.", str(drows[0]["buyer_name"])),
				ActionURL: "/recovery/debt-sales", EntityRef: fmt.Sprintf("debt_sale:%d", id), Priority: "normal",
			})
		}
		respond(w, rows[0], "pg")
	}
}

// M3: recoveryDeleteDebtSale performs a soft delete so the sale record is
// preserved for audit purposes.
//
// Columns added by migration 073_debt_sales_soft_delete.sql
func recoveryDeleteDebtSale(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if _, err := strconv.Atoi(id); err != nil {
			respondErr(w, 400, "Invalid id")
			return
		}
		user := core.UserFromCtx(r.Context())
		if _, err := db.PGExec(r.Context(),
			`UPDATE debt_sales SET deleted_at=NOW(), deleted_by=$1 WHERE id=$2 AND deleted_at IS NULL`,
			user.ID, id); err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		respond(w, map[string]any{"ok": true}, "pg")
	}
}
