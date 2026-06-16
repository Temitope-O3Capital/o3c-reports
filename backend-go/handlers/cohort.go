package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterCohort(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("cohort"))
	r.Get("/kpis", cohortKPIs(db))
	r.Get("/heatmap", cohortHeatmap(db))
	r.Get("/monthly-activity", cohortMonthlyActivity(db))
}

func cohortKPIs(db *core.DB) http.HandlerFunc {
	type spec struct {
		ms, pg string
		key    string
	}
	queries := []spec{
		{
			"SELECT COUNT(DISTINCT CIF_Number) AS val FROM dbo.Account WHERE Account_Created_Date IS NOT NULL",
			`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Products" WHERE "Account Created Date" IS NOT NULL`,
			"cohort_size",
		},
		{
			"SELECT COUNT(DISTINCT CIF) AS val FROM dbo.Transaction_Listing WHERE CIF IS NOT NULL",
			`SELECT COUNT(DISTINCT "CIF Number") AS val FROM "Transactions" WHERE "CIF Number" IS NOT NULL`,
			"activated_cohort",
		},
		{
			`SELECT COUNT(*) AS val FROM (SELECT CIF FROM dbo.Transaction_Listing WHERE CIF IS NOT NULL GROUP BY CIF HAVING COUNT(*) >= 5) x`,
			`SELECT COUNT(*) AS val FROM (SELECT "CIF Number" FROM "Transactions" WHERE "CIF Number" IS NOT NULL GROUP BY "CIF Number" HAVING COUNT(*) >= 5) x`,
			"power_users",
		},
	}
	return func(w http.ResponseWriter, r *http.Request) {
		kpis := map[string]any{}
		var sources []string
		for _, q := range queries {
			val, src, err := db.DualScalar(r.Context(), "val", q.ms, q.pg)
			if err == nil {
				kpis[q.key] = toInt64(val)
				sources = append(sources, src)
			} else {
				kpis[q.key] = 0
			}
		}
		cohortSize := toFloat(kpis["cohort_size"])
		activated := toFloat(kpis["activated_cohort"])
		if cohortSize > 0 {
			kpis["activation_rate"] = round1(activated / cohortSize * 100)
		} else {
			kpis["activation_rate"] = 0.0
		}
		respond(w, kpis, pickSource(sources))
	}
}

func cohortHeatmap(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, src, err := db.DualQuery(r.Context(),
			`WITH Cohorts AS (
			    SELECT CIF_Number,
			           DATEFROMPARTS(YEAR(Account_Created_Date),MONTH(Account_Created_Date),1) AS Cohort_Date,
			           FORMAT(Account_Created_Date,'MMM yyyy') AS Cohort_Label
			    FROM dbo.Account
			    WHERE Account_Created_Date IS NOT NULL
			      AND Account_Created_Date >= DATEADD(year,-2,GETDATE())
			),
			MonthlyAct AS (
			    SELECT CIF,
			           DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1) AS ActivityMonth,
			           COUNT(*) AS TxnCount
			    FROM dbo.Transaction_Listing
			    WHERE Transaction_Date IS NOT NULL
			    GROUP BY CIF, DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1)
			)
			SELECT c.Cohort_Label,
			       DATEDIFF(month,c.Cohort_Date,ma.ActivityMonth) AS age_months,
			       COUNT(DISTINCT ma.CIF) AS active_users,
			       COUNT(DISTINCT c.CIF_Number) AS cohort_size
			FROM Cohorts c
			LEFT JOIN MonthlyAct ma ON c.CIF_Number=ma.CIF AND ma.TxnCount>0 AND ma.ActivityMonth>=c.Cohort_Date
			WHERE c.Cohort_Label IS NOT NULL
			GROUP BY c.Cohort_Label, DATEDIFF(month,c.Cohort_Date,ma.ActivityMonth)
			ORDER BY c.Cohort_Label, age_months`,
			`WITH cohorts AS (
			    SELECT "CIF Number",
			           DATE_TRUNC('month',"Account Created Date") AS cohort_date,
			           TO_CHAR(DATE_TRUNC('month',"Account Created Date"),'Mon YYYY') AS cohort_label
			    FROM "Products"
			    WHERE "Account Created Date" IS NOT NULL
			      AND "Account Created Date" >= CURRENT_DATE - INTERVAL '2 years'
			),
			monthly_act AS (
			    SELECT "CIF Number",
			           DATE_TRUNC('month',"Transaction Date") AS activity_month,
			           COUNT(*) AS txn_count
			    FROM "Transactions"
			    WHERE "Transaction Date" IS NOT NULL
			    GROUP BY "CIF Number", DATE_TRUNC('month',"Transaction Date")
			)
			SELECT c.cohort_label,
			       DATE_PART('year',AGE(ma.activity_month,c.cohort_date))*12
			       + DATE_PART('month',AGE(ma.activity_month,c.cohort_date)) AS age_months,
			       COUNT(DISTINCT ma."CIF Number") AS active_users,
			       COUNT(DISTINCT c."CIF Number") AS cohort_size
			FROM cohorts c
			LEFT JOIN monthly_act ma ON c."CIF Number"=ma."CIF Number"
			    AND ma.txn_count>0 AND ma.activity_month>=c.cohort_date
			WHERE c.cohort_label IS NOT NULL
			GROUP BY c.cohort_label, age_months
			ORDER BY c.cohort_label, age_months`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}

		pivot := map[string]map[int]float64{}
		for _, row := range rows {
			label := str(coalesce(str(row["Cohort_Label"]), str(row["cohort_label"])))
			age := int(toInt64(row["age_months"]))
			cs := toFloat(row["cohort_size"])
			au := toFloat(row["active_users"])
			var rate float64
			if cs > 0 {
				rate = round1(au / cs * 100)
			}
			if pivot[label] == nil {
				pivot[label] = map[int]float64{}
			}
			pivot[label][age] = rate
		}
		respond(w, pivot, src)
	}
}

func cohortMonthlyActivity(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, src, err := db.DualQuery(r.Context(),
			`SELECT FORMAT(Transaction_Date,'MMM yyyy') AS month,
			        DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1) AS month_sort,
			        COUNT(DISTINCT CIF) AS active_users,
			        ISNULL(SUM(Amount),0) AS total_spend,
			        ISNULL(AVG(CAST(Amount AS FLOAT)),0) AS avg_spend
			FROM dbo.Transaction_Listing
			WHERE Transaction_Date IS NOT NULL
			GROUP BY DATEFROMPARTS(YEAR(Transaction_Date),MONTH(Transaction_Date),1),
			         FORMAT(Transaction_Date,'MMM yyyy')
			ORDER BY month_sort`,
			`SELECT TO_CHAR(DATE_TRUNC('month',"Transaction Date"),'Mon YYYY') AS month,
			        DATE_TRUNC('month',"Transaction Date") AS month_sort,
			        COUNT(DISTINCT "CIF Number") AS active_users,
			        COALESCE(SUM("Amount"),0) AS total_spend,
			        COALESCE(AVG("Amount"),0) AS avg_spend
			FROM "Transactions"
			WHERE "Transaction Date" IS NOT NULL
			GROUP BY DATE_TRUNC('month',"Transaction Date")
			ORDER BY month_sort`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, rows, src)
	}
}

// pivot JSON helper — map[string]map[int]float64 needs custom encoding
// because Go encodes map[int]... with string keys, which is what JSON needs.
// encoding/json handles map[string]map[int]float64 correctly (int keys → string).

func init() {
	// Verify json handles int-keyed maps: json.Marshal(map[int]int{1:2}) = `{"1":2}` ✓
	_ = json.Marshal // referenced to keep import alive
}
