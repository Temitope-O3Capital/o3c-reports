package handlers

import (
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterExecutive(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("executive"))
	r.Get("/summary", executiveSummary(db))
}

// periodDates returns (currentStart, currentEnd, prevStart, prevEnd) for the given period.
func periodDates(period, startStr, endStr string) (cs, ce, ps, pe time.Time, err error) {
	today := time.Now().UTC().Truncate(24 * time.Hour)

	switch period {
	case "month":
		cs = today.AddDate(0, 0, -today.Day()+1)
		ce = today
		prev := cs.AddDate(0, -1, 0)
		ps = prev
		pe = ps.AddDate(0, 0, int(ce.Sub(cs).Hours()/24))

	case "quarter":
		q := (int(today.Month()) - 1) / 3
		cs = time.Date(today.Year(), time.Month(q*3+1), 1, 0, 0, 0, 0, time.UTC)
		ce = today
		var pqStart time.Time
		if q == 0 {
			pqStart = time.Date(today.Year()-1, 10, 1, 0, 0, 0, 0, time.UTC)
		} else {
			pqStart = time.Date(today.Year(), time.Month((q-1)*3+1), 1, 0, 0, 0, 0, time.UTC)
		}
		ps = pqStart
		pe = ps.AddDate(0, 0, int(ce.Sub(cs).Hours()/24))

	case "year":
		cs = time.Date(today.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
		ce = today
		ps = time.Date(today.Year()-1, 1, 1, 0, 0, 0, 0, time.UTC)
		pe = ps.AddDate(0, 0, int(ce.Sub(cs).Hours()/24))

	case "custom":
		if startStr == "" || endStr == "" {
			return cs, ce, ps, pe, fmt.Errorf("start and end required for custom period")
		}
		cs, err = time.Parse("2006-01-02", startStr)
		if err != nil {
			return cs, ce, ps, pe, fmt.Errorf("invalid start date")
		}
		ce, err = time.Parse("2006-01-02", endStr)
		if err != nil {
			return cs, ce, ps, pe, fmt.Errorf("invalid end date")
		}
		if ce.Before(cs) {
			return cs, ce, ps, pe, fmt.Errorf("end must be >= start")
		}
		delta := int(ce.Sub(cs).Hours()/24) + 1
		pe = cs.AddDate(0, 0, -1)
		ps = pe.AddDate(0, 0, -(delta - 1))
	default:
		return cs, ce, ps, pe, fmt.Errorf("unknown period: %s", period)
	}
	return
}

func periodLabel(period string, cs, ce time.Time) string {
	switch period {
	case "month":
		return cs.Format("January 2006")
	case "quarter":
		q := (int(cs.Month())-1)/3 + 1
		return fmt.Sprintf("Q%d %d", q, cs.Year())
	case "year":
		return fmt.Sprintf("%d", cs.Year())
	default:
		return fmt.Sprintf("%s – %s", cs.Format("2006-01-02"), ce.Format("2006-01-02"))
	}
}

func pctChange(curr, prev float64) any {
	if prev == 0 {
		return nil
	}
	return round1((curr-prev)/abs64(prev)*100)
}

func abs64(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}

func d(t time.Time) string { return t.Format("2006-01-02") }

func executiveSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		period := qstr(r, "period")
		if period == "" {
			period = "month"
		}
		cs, ce, ps, pe, err := periodDates(period, qstr(r, "start"), qstr(r, "end"))
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}

		var sources []string
		// scalar helper
		sc := func(msQ, pgQ string) float64 {
			val, src, e := db.DualScalar(r.Context(), "val", msQ, pgQ)
			if e == nil {
				sources = append(sources, src)
				return toFloat(val)
			}
			return 0
		}
		// query helper
		qh := func(msQ, pgQ string) []core.Row {
			rows, src, e := db.DualQuery(r.Context(), msQ, pgQ)
			if e == nil {
				sources = append(sources, src)
				return rows
			}
			return nil
		}

		// ── Collections ───────────────────────────────────────────────────────
		collCurr := sc(
			fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE Repayment_Date BETWEEN '%s' AND '%s'", d(cs), d(ce)),
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		collPrev := sc(
			fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment WHERE Repayment_Date BETWEEN '%s' AND '%s'", d(ps), d(pe)),
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Date" BETWEEN '%s' AND '%s'`, d(ps), d(pe)))
		collCountCurr := sc(
			fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.o3_loan_Repayment WHERE Repayment_Date BETWEEN '%s' AND '%s'", d(cs), d(ce)),
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Collections Log" WHERE "Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))

		// ── Recovery ─────────────────────────────────────────────────────────
		recCurr := sc(
			fmt.Sprintf("SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet WHERE [Recovery Date] BETWEEN '%s' AND '%s'", d(cs), d(ce)),
			fmt.Sprintf(`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE "Recovery Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		recPrev := sc(
			fmt.Sprintf("SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet WHERE [Recovery Date] BETWEEN '%s' AND '%s'", d(ps), d(pe)),
			fmt.Sprintf(`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet" WHERE "Recovery Date" BETWEEN '%s' AND '%s'`, d(ps), d(pe)))

		// ── Transactions ──────────────────────────────────────────────────────
		txnVolCurr := sc(
			fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transaction_Listing WHERE Transaction_Date BETWEEN '%s' AND '%s'", d(cs), d(ce)),
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions" WHERE "Transaction Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		txnVolPrev := sc(
			fmt.Sprintf("SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.Transaction_Listing WHERE Transaction_Date BETWEEN '%s' AND '%s'", d(ps), d(pe)),
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Transactions" WHERE "Transaction Date" BETWEEN '%s' AND '%s'`, d(ps), d(pe)))
		txnCntCurr := sc(
			fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Transaction_Listing WHERE Transaction_Date BETWEEN '%s' AND '%s'", d(cs), d(ce)),
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Transactions" WHERE "Transaction Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		txnCntPrev := sc(
			fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Transaction_Listing WHERE Transaction_Date BETWEEN '%s' AND '%s'", d(ps), d(pe)),
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Transactions" WHERE "Transaction Date" BETWEEN '%s' AND '%s'`, d(ps), d(pe)))
		var avgTxn float64
		if txnCntCurr > 0 {
			avgTxn = round1(txnVolCurr / txnCntCurr)
		}

		// ── Customer acquisition ──────────────────────────────────────────────
		newCurr := sc(
			fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Contact WHERE Account_Created BETWEEN '%s' AND '%s'", d(cs), d(ce)),
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Accounts" WHERE "Account Created Date" BETWEEN '%s' AND '%s'`, d(cs), d(ce)))
		newPrev := sc(
			fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Contact WHERE Account_Created BETWEEN '%s' AND '%s'", d(ps), d(pe)),
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Accounts" WHERE "Account Created Date" BETWEEN '%s' AND '%s'`, d(ps), d(pe)))
		totalCustomers := sc(
			"SELECT COUNT(*) AS val FROM dbo.Contact",
			`SELECT COUNT(*) AS val FROM "Accounts"`)
		activeCards := sc(
			"SELECT COUNT(*) AS val FROM dbo.Account WHERE Status IN ('Open','Active')",
			`SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status" IN ('Open','Active')`)
		totalCards := sc(
			"SELECT COUNT(*) AS val FROM dbo.Account",
			`SELECT COUNT(*) AS val FROM "Products"`)
		var activationRate float64
		if totalCards > 0 {
			activationRate = round1(activeCards / totalCards * 100)
		}

		// ── All-time recovery rate ─────────────────────────────────────────────
		totalRecoveredAll := sc(
			"SELECT ISNULL(SUM([Recovery Amount]),0) AS val FROM dbo.RecoveryMasterSheet",
			`SELECT COALESCE(SUM("Recovery Amount"),0) AS val FROM "Recovery Master Sheet"`)
		totalCollectedAll := sc(
			"SELECT ISNULL(SUM(Amount),0) AS val FROM dbo.o3_loan_Repayment",
			`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log"`)
		var recoveryRatePct float64
		if totalCollectedAll > 0 {
			recoveryRatePct = round1(totalRecoveredAll / totalCollectedAll * 100)
		}

		statesCount := sc(
			"SELECT COUNT(DISTINCT State_) AS val FROM dbo.Contact WHERE State_ IS NOT NULL AND State_!=''",
			`SELECT COUNT(DISTINCT "State") AS val FROM "Accounts" WHERE "State" IS NOT NULL AND "State"!=''`)

		// ── Trends (last 12 months) ───────────────────────────────────────────
		collTrend := qh(
			`SELECT FORMAT(Repayment_Date,'MMM yyyy') AS month, DATEFROMPARTS(YEAR(Repayment_Date),MONTH(Repayment_Date),1) AS sort_key, ISNULL(SUM(Amount),0) AS collections, COUNT(*) AS count FROM dbo.o3_loan_Repayment WHERE Repayment_Date >= DATEADD(MONTH,-11,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) GROUP BY DATEFROMPARTS(YEAR(Repayment_Date),MONTH(Repayment_Date),1), FORMAT(Repayment_Date,'MMM yyyy') ORDER BY sort_key`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Date"),'Mon YYYY') AS month, DATE_TRUNC('month',"Date") AS sort_key, COALESCE(SUM("Amount"),0) AS collections, COUNT(*) AS count FROM "Collections Log" WHERE "Date" >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months' GROUP BY DATE_TRUNC('month',"Date") ORDER BY sort_key`)
		recTrend := qh(
			`SELECT FORMAT([Recovery Date],'MMM yyyy') AS month, DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1) AS sort_key, ISNULL(SUM([Recovery Amount]),0) AS recovery FROM dbo.RecoveryMasterSheet WHERE [Recovery Date] >= DATEADD(MONTH,-11,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) GROUP BY DATEFROMPARTS(YEAR([Recovery Date]),MONTH([Recovery Date]),1), FORMAT([Recovery Date],'MMM yyyy') ORDER BY sort_key`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Recovery Date"),'Mon YYYY') AS month, DATE_TRUNC('month',"Recovery Date") AS sort_key, COALESCE(SUM("Recovery Amount"),0) AS recovery FROM "Recovery Master Sheet" WHERE "Recovery Date" >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months' GROUP BY DATE_TRUNC('month',"Recovery Date") ORDER BY sort_key`)
		txnTrend := qh(
			`SELECT FORMAT(Transaction_Date,'MMM yyyy') AS month, DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1) AS sort_key, ISNULL(SUM(Amount),0) AS volume, COUNT(*) AS txn_count FROM dbo.Transaction_Listing WHERE Transaction_Date >= DATEADD(MONTH,-11,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) GROUP BY DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1), FORMAT(Transaction_Date,'MMM yyyy') ORDER BY sort_key`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Transaction Date"),'Mon YYYY') AS month, DATE_TRUNC('month',"Transaction Date") AS sort_key, COALESCE(SUM("Amount"),0) AS volume, COUNT(*) AS txn_count FROM "Transactions" WHERE "Transaction Date" >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months' GROUP BY DATE_TRUNC('month',"Transaction Date") ORDER BY sort_key`)
		acqTrend := qh(
			`SELECT FORMAT(Account_Created,'MMM yyyy') AS month, DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1) AS sort_key, COUNT(*) AS new_accounts FROM dbo.Contact WHERE Account_Created >= DATEADD(MONTH,-11,DATEFROMPARTS(YEAR(GETDATE()),MONTH(GETDATE()),1)) GROUP BY DATEFROMPARTS(YEAR(Account_Created),MONTH(Account_Created),1), FORMAT(Account_Created,'MMM yyyy') ORDER BY sort_key`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS month, DATE_TRUNC('month',"Account Created Date") AS sort_key, COUNT(*) AS new_accounts FROM "Accounts" WHERE "Account Created Date" >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months' GROUP BY DATE_TRUNC('month',"Account Created Date") ORDER BY sort_key`)

		// ── Breakdowns ────────────────────────────────────────────────────────
		topStates := qh(
			"SELECT TOP 10 State_, COUNT(*) AS count FROM dbo.Contact WHERE State_ IS NOT NULL AND State_!='' GROUP BY State_ ORDER BY count DESC",
			`SELECT "State", COUNT(*) AS count FROM "Accounts" WHERE "State" IS NOT NULL AND "State"!='' GROUP BY "State" ORDER BY count DESC LIMIT 10`)
		productMix := qh(
			"SELECT Product_Name, COUNT(*) AS count FROM dbo.Account WHERE Product_Name IS NOT NULL GROUP BY Product_Name ORDER BY count DESC",
			`SELECT "Product Name", COUNT(*) AS count FROM "Products" WHERE "Product Name" IS NOT NULL GROUP BY "Product Name" ORDER BY count DESC`)
		topAgents := qh(
			fmt.Sprintf("SELECT TOP 10 Rn_Create_User AS Agent, ISNULL(SUM(Amount),0) AS total, COUNT(*) AS count FROM dbo.o3_loan_Repayment WHERE Repayment_Date BETWEEN '%s' AND '%s' AND Rn_Create_User IS NOT NULL AND Rn_Create_User!='' GROUP BY Rn_Create_User ORDER BY total DESC", d(cs), d(ce)),
			fmt.Sprintf(`SELECT "Agent", COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count FROM "Collections Log" WHERE "Date" BETWEEN '%s' AND '%s' AND "Agent" IS NOT NULL AND "Agent"!='' GROUP BY "Agent" ORDER BY total DESC LIMIT 10`, d(cs), d(ce)))

		// ── Merge trends by month ─────────────────────────────────────────────
		collByMonth := map[string]core.Row{}
		for _, row := range collTrend {
			collByMonth[str(row["month"])] = row
		}
		recByMonth := map[string]core.Row{}
		for _, row := range recTrend {
			recByMonth[str(row["month"])] = row
		}
		txnByMonth := map[string]core.Row{}
		for _, row := range txnTrend {
			txnByMonth[str(row["month"])] = row
		}
		// Build month→ISO-date-string index for chronological sorting.
		// sort_key from SQL is the first-of-month date; "2006-01-02" sorts correctly as string.
		monthSortKey := map[string]string{}
		for _, src := range [][]core.Row{collTrend, recTrend, txnTrend} {
			for _, row := range src {
				m := str(row["month"])
				if _, seen := monthSortKey[m]; seen {
					continue
				}
				switch v := row["sort_key"].(type) {
				case time.Time:
					monthSortKey[m] = v.Format("2006-01-02")
				case string:
					monthSortKey[m] = v
				}
			}
		}
		allMonths := make(map[string]bool)
		for m := range collByMonth {
			allMonths[m] = true
		}
		for m := range recByMonth {
			allMonths[m] = true
		}
		for m := range txnByMonth {
			allMonths[m] = true
		}
		monthKeys := make([]string, 0, len(allMonths))
		for m := range allMonths {
			monthKeys = append(monthKeys, m)
		}
		sort.Slice(monthKeys, func(i, j int) bool {
			return monthSortKey[monthKeys[i]] < monthSortKey[monthKeys[j]]
		})

		mergedTrend := make([]map[string]any, 0, len(monthKeys))
		for _, m := range monthKeys {
			mergedTrend = append(mergedTrend, map[string]any{
				"month":       m,
				"collections": toFloat(collByMonth[m]["collections"]),
				"recovery":    toFloat(recByMonth[m]["recovery"]),
				"volume":      toFloat(txnByMonth[m]["volume"]),
				"txn_count":   toInt64(txnByMonth[m]["txn_count"]),
			})
		}

		acqList := make([]map[string]any, 0, len(acqTrend))
		for _, row := range acqTrend {
			acqList = append(acqList, map[string]any{
				"month":        str(row["month"]),
				"new_accounts": toInt64(row["new_accounts"]),
			})
		}

		overallSource := pickSource(sources)
		respond(w, map[string]any{
			"period": map[string]any{
				"type":       period,
				"label":      periodLabel(period, cs, ce),
				"start":      d(cs),
				"end":        d(ce),
				"prev_start": d(ps),
				"prev_end":   d(pe),
			},
			"financial": map[string]any{
				"collections":          collCurr,
				"collections_prev":     collPrev,
				"collections_change":   pctChange(collCurr, collPrev),
				"collections_count":    int(collCountCurr),
				"recovery":             recCurr,
				"recovery_prev":        recPrev,
				"recovery_change":      pctChange(recCurr, recPrev),
				"txn_volume":           txnVolCurr,
				"txn_volume_prev":      txnVolPrev,
				"txn_volume_change":    pctChange(txnVolCurr, txnVolPrev),
				"txn_count":            int(txnCntCurr),
				"txn_count_prev":       int(txnCntPrev),
				"txn_count_change":     pctChange(txnCntCurr, txnCntPrev),
				"avg_txn_value":        avgTxn,
				"recovery_rate":        recoveryRatePct,
				"total_collected_all":  totalCollectedAll,
				"total_recovered_all":  totalRecoveredAll,
			},
			"growth": map[string]any{
				"new_customers":        int(newCurr),
				"new_customers_prev":   int(newPrev),
				"new_customers_change": pctChange(newCurr, newPrev),
				"total_customers":      int(totalCustomers),
				"active_cards":         int(activeCards),
				"total_cards":          int(totalCards),
				"activation_rate":      activationRate,
				"states_covered":       int(statesCount),
			},
			"trends": map[string]any{
				"monthly":     mergedTrend,
				"acquisition": acqList,
			},
			"breakdowns": map[string]any{
				"top_states":  topStates,
				"product_mix": productMix,
				"top_agents":  topAgents,
			},
		}, overallSource)
	}
}
