package handlers

import (
	"context"
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
	r.Get("/cases/{id}/legal-milestones", recoveryLegalMilestones(db))
	r.Post("/cases/{id}/legal-milestone", recoveryAddLegalMilestone(db))
	r.Get("/debt-sales", recoveryDebtSales(db))
	r.Post("/debt-sales", recoveryCreateDebtSale(db))
	r.Delete("/debt-sales/{id}", recoveryDeleteDebtSale(db))
}

func recoveryKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		from := qstr(r, "from")
		to := qstr(r, "to")
		var f Filter
		f.Date("[Recovery Date]", `"Recovery Date"`, from, to)

		kpis := map[string]any{}
		var sources []string

		type spec struct{ key, pg string }
		for _, s := range []spec{
			{"total_recovered",
				`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE 1=1` + f.PG()},
			{"accounts_in_legal",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Recovery Master Sheet" WHERE "Legal Stage" IS NOT NULL` + f.PG()},
			{"recovery_mtd",
				`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE DATE_TRUNC('month',"Recovery Date")=DATE_TRUNC('month',CURRENT_DATE)` + f.PG()},
			{"open_cases",
				`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Recovery Master Sheet" WHERE ("Status" IS NULL OR "Status" NOT IN ('Recovered','Paid','Closed'))` + f.PG()},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.pg, f.Args()...)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		// CBN recovery rate = total_recovered / total_npl_book_value * 100
		// (CBN supervisory framework: recoveries as % of gross NPL balance)
		nplBalance, _, _ := db.DualScalar(ctx, "val",
			`SELECT COALESCE(SUM("Outstanding Balance"),0) AS val FROM "Recovery Master Sheet"`)
		if toFloat(nplBalance) > 0 {
			kpis["recovery_rate"] = round1(toFloat(kpis["total_recovered"]) / toFloat(nplBalance) * 100)
		} else {
			kpis["recovery_rate"] = 0.0
		}
		kpis["total_npl_balance"] = nplBalance

		// Aliases expected by the frontend RecoveryKPIs interface
		kpis["total_in_recovery_kobo"] = nplBalance
		kpis["recovered_mtd_kobo"] = kpis["recovery_mtd"]
		kpis["success_rate_pct"] = kpis["recovery_rate"]

		// avg days open — PG-only; falls back to 0 gracefully
		avgArgs := []any{}
		avgWhere := ""
		n := 1
		if from != "" && dateRE.MatchString(from) {
			avgWhere += fmt.Sprintf(" AND opened_at::date >= $%d::date", n)
			avgArgs = append(avgArgs, from)
			n++
		}
		if to != "" && dateRE.MatchString(to) {
			avgWhere += fmt.Sprintf(" AND opened_at::date <= $%d::date", n)
			avgArgs = append(avgArgs, to)
		}
		_ = n
		avgRows, _ := db.PGQuery(ctx, `
			SELECT COALESCE(ROUND(AVG(EXTRACT(DAY FROM NOW() - opened_at)))::int, 0) AS avg_days
			FROM recovery_cases WHERE status = 'open'`+avgWhere, avgArgs...)
		if len(avgRows) > 0 {
			kpis["avg_days_in_recovery"] = avgRows[0]["avg_days"]
		} else {
			kpis["avg_days_in_recovery"] = 0
		}

		respond(w, kpis, pickSource(sources))
	}
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

func recoveryMonthlyTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")
		var f Filter
		f.Date("[Recovery Date]", `"Recovery Date"`, from, to)

		data, src, err := db.DualQuery(r.Context(),
			`SELECT TO_CHAR(DATE_TRUNC('month',"Recovery Date"),'Mon YYYY') AS month,
			        DATE_TRUNC('month',"Recovery Date") AS month_sort,
			        COALESCE(SUM("Recovery Amount"),0) AS amount_kobo
			 FROM "Recovery Master Sheet"
			 WHERE 1=1`+f.PG()+`
			 GROUP BY DATE_TRUNC('month',"Recovery Date") ORDER BY month_sort`,
			f.Args()...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
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

// recoveryByChannel aggregates recovered amounts by payment channel.
// Uses recovery_payments.channel, which is PG-only.
func recoveryByChannel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")
		var where string
		var args []any
		n := 1
		if from != "" {
			where += fmt.Sprintf(" AND payment_date::date >= $%d", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			where += fmt.Sprintf(" AND payment_date::date <= $%d", n)
			args = append(args, to)
			n++
		}
		_ = n
		rows, err := db.PGQuery(r.Context(), `
			SELECT channel,
			       COALESCE(SUM(amount_kobo), 0) AS amount_kobo,
			       ROUND(
			           100.0 * SUM(amount_kobo)
			               / NULLIF(SUM(SUM(amount_kobo)) OVER (), 0),
			           1
			       ) AS pct
			FROM recovery_payments
			WHERE 1=1`+where+`
			GROUP BY channel
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

// recoveryByAgent aggregates case counts and recovered totals per assigned agent.
func recoveryByAgent(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := qstr(r, "from")
		to := qstr(r, "to")
		var where string
		var args []any
		n := 1
		if from != "" {
			where += fmt.Sprintf(" AND rc.opened_at::date >= $%d", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			where += fmt.Sprintf(" AND rc.opened_at::date <= $%d", n)
			args = append(args, to)
			n++
		}
		_ = n
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    COALESCE(u.full_name, 'Unassigned') AS agent_name,
			    COUNT(rc.id) AS case_count,
			    COALESCE(SUM(rc.recovered_kobo), 0) AS recovered_kobo,
			    ROUND(
			        100.0
			            * COUNT(*) FILTER (WHERE rc.status = 'closed')
			            / NULLIF(COUNT(*), 0),
			        1
			    ) AS success_rate_pct
			FROM recovery_cases rc
			LEFT JOIN o3c_users u ON rc.assigned_agent_id = u.id
			WHERE 1=1`+where+`
			GROUP BY u.full_name
			ORDER BY recovered_kobo DESC`, args...)
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
				[]string{"rc.account_cif", "lp.court_name"}, "", n); clause != "" {
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
			    rc.outstanding_kobo,
			    rc.legal_stage AS current_milestone,
			    lp.court_name AS solicitor,
			    lp.next_hearing_date AS next_court_date,
			    EXTRACT(DAY FROM NOW() - rc.opened_at)::int AS days_in_legal
			FROM recovery_cases rc
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

// recoveryLegalKPIs returns aggregate KPIs for cases in legal.
func recoveryLegalKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    COUNT(DISTINCT rc.id) AS total_cases,
			    COUNT(DISTINCT rc.id) FILTER (WHERE rc.status = 'open') AS active,
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
			       notes, created_at
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
		if err := tx.QueryRowContext(ctx, `
			INSERT INTO debt_sales
			    (buyer_name, sale_date, account_count, face_value_kobo,
			     sale_price_kobo, recovery_post_sale_kobo, notes)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			RETURNING id, buyer_name, sale_date, account_count,
			          face_value_kobo, sale_price_kobo, recovery_post_sale_kobo,
			          notes, created_at`,
			body.BuyerName, body.SaleDate, body.AccountCount,
			body.FaceValueKobo, body.SalePriceKobo, body.RecoveryPostSaleKobo,
			nullStr(body.Notes)).Scan(
			&saleID, &buyerName, &saleDate, &accountCount,
			&faceValueKobo, &salePriceKobo, &recoveryPostSaleKobo,
			&notes, &createdAt,
		); err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}

		// Post GL entry atomically with the insert: Dr Cash / Cr Loan Receivable.
		if body.SalePriceKobo > 0 {
			if glErr := postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   fmt.Sprintf("Debt sale to %s", body.BuyerName),
				Reference:     fmt.Sprintf("DS-%d", saleID),
				DebitAccount:  "1001", // Cash/Bank Clearing
				CreditAccount: "1100", // Loan Receivable
				AmountKobo:    body.SalePriceKobo,
				SourceType:    "debt_sale",
				SourceID:      saleID,
				PostedBy:      user.ID,
			}); glErr != nil {
				slog.Error("GL journal post failed for debt sale", "id", saleID, "err", glErr)
				respondErr(w, 500, "GL entry failed")
				return
			}
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		logCreditEvent(ctx, db, r, "recovery", "debt_sale", fmt.Sprint(saleID), "", "debt_sale_created",
			fmt.Sprintf("Debt sale created — buyer: %s, sale price ₦%s", body.BuyerName, fmtKoboStr(body.SalePriceKobo)), nil, map[string]any{"buyer_name": body.BuyerName, "sale_price_kobo": body.SalePriceKobo})

		row := core.Row{
			"id": saleID, "buyer_name": buyerName, "sale_date": saleDate,
			"account_count": accountCount, "face_value_kobo": faceValueKobo,
			"sale_price_kobo": salePriceKobo, "recovery_post_sale_kobo": recoveryPostSaleKobo,
			"notes": notes, "created_at": createdAt,
		}
		go NotifyRole(context.Background(), db, "finance_head", NotifPayload{
			EventType: EvtRecoveryDebtSale,
			Title:     "Debt Sale Recorded",
			Body:      fmt.Sprintf("Debt sale to %s has been recorded (face value: %d kobo)", body.BuyerName, body.FaceValueKobo),
			ActionURL: "/recovery/debt-sales",
			EntityRef: fmt.Sprintf("debt_sale:%d", saleID),
		})
		respond(w, row, "pg")
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
