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
		pg  string
		key string
	}
	return func(w http.ResponseWriter, r *http.Request) {
		// ?basis=person counts distinct PEOPLE (party); default counts cards (cif).
		person := qstr(r, "basis") == "person"
		var queries []spec
		if person {
			queries = []spec{
				{`SELECT COUNT(DISTINCT COALESCE('p'||c.party_id,'c'||c.contact_id,'x'||a.cif)) AS val
				  FROM app.accounts a LEFT JOIN app.customers c ON c.cif = a.cif WHERE a.opened_date IS NOT NULL`, "cohort_size"},
				{`SELECT COUNT(DISTINCT COALESCE('p'||c.party_id,'c'||c.contact_id,'x'||t.cif)) AS val
				  FROM app.transactions t LEFT JOIN app.customers c ON c.cif = t.cif WHERE t.cif IS NOT NULL`, "activated_cohort"},
				{`SELECT COUNT(*) AS val FROM (
				   SELECT COALESCE('p'||c.party_id,'c'||c.contact_id,'x'||t.cif) AS pk
				   FROM app.transactions t LEFT JOIN app.customers c ON c.cif = t.cif
				   WHERE t.cif IS NOT NULL GROUP BY pk HAVING COUNT(*) >= 5) x`, "power_users"},
			}
		} else {
			queries = []spec{
				{`SELECT COUNT(DISTINCT cif) AS val FROM app.accounts WHERE opened_date IS NOT NULL`, "cohort_size"},
				{`SELECT COUNT(DISTINCT cif) AS val FROM app.transactions WHERE cif IS NOT NULL`, "activated_cohort"},
				{`SELECT COUNT(*) AS val FROM (SELECT cif FROM app.transactions WHERE cif IS NOT NULL GROUP BY cif HAVING COUNT(*) >= 5) x`, "power_users"},
			}
		}
		kpis := map[string]any{"basis": map[bool]string{true: "person", false: "card"}[person]}
		var sources []string
		for _, q := range queries {
			val, src, err := db.DualScalar(r.Context(), "val", q.pg)
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
		// ?basis=person builds cohorts by PERSON (party) — a person's cohort is the
		// month of their FIRST card, activity is any card. Default is card-level (cif).
		q := `WITH cohorts AS (
			    SELECT cif,
			           DATE_TRUNC('month',opened_date) AS cohort_date,
			           TO_CHAR(DATE_TRUNC('month',opened_date),'Mon YYYY') AS cohort_label
			    FROM app.accounts
			    WHERE opened_date IS NOT NULL
			      AND opened_date >= CURRENT_DATE - INTERVAL '2 years'
			),
			monthly_act AS (
			    SELECT cif,
			           DATE_TRUNC('month',txn_date) AS activity_month,
			           COUNT(*) AS txn_count
			    FROM app.transactions
			    WHERE txn_date IS NOT NULL
			    GROUP BY cif, DATE_TRUNC('month',txn_date)
			)
			SELECT c.cohort_label,
			       DATE_PART('year',AGE(ma.activity_month,c.cohort_date))*12
			       + DATE_PART('month',AGE(ma.activity_month,c.cohort_date)) AS age_months,
			       COUNT(DISTINCT ma.cif) AS active_users,
			       COUNT(DISTINCT c.cif) AS cohort_size
			FROM cohorts c
			LEFT JOIN monthly_act ma ON c.cif=ma.cif
			    AND ma.txn_count>0 AND ma.activity_month>=c.cohort_date
			WHERE c.cohort_label IS NOT NULL
			GROUP BY c.cohort_label, age_months
			ORDER BY c.cohort_label, age_months`
		if qstr(r, "basis") == "person" {
			q = `WITH cust AS (
			        SELECT cif, COALESCE('p'||party_id,'c'||contact_id) AS pk
			        FROM app.customers WHERE cif IS NOT NULL AND cif <> ''
			    ),
			    cohorts AS (
			        SELECT cu.pk,
			               DATE_TRUNC('month', MIN(a.opened_date)) AS cohort_date,
			               TO_CHAR(DATE_TRUNC('month', MIN(a.opened_date)),'Mon YYYY') AS cohort_label
			        FROM app.accounts a JOIN cust cu ON cu.cif = a.cif
			        WHERE a.opened_date IS NOT NULL
			        GROUP BY cu.pk
			        HAVING DATE_TRUNC('month', MIN(a.opened_date)) >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '2 years')
			    ),
			    monthly_act AS (
			        SELECT cu.pk, DATE_TRUNC('month',t.txn_date) AS activity_month, COUNT(*) AS txn_count
			        FROM app.transactions t JOIN cust cu ON cu.cif = t.cif
			        WHERE t.txn_date IS NOT NULL
			        GROUP BY cu.pk, DATE_TRUNC('month',t.txn_date)
			    )
			    SELECT c.cohort_label,
			           DATE_PART('year',AGE(ma.activity_month,c.cohort_date))*12
			           + DATE_PART('month',AGE(ma.activity_month,c.cohort_date)) AS age_months,
			           COUNT(DISTINCT ma.pk) AS active_users,
			           COUNT(DISTINCT c.pk) AS cohort_size
			    FROM cohorts c
			    LEFT JOIN monthly_act ma ON c.pk=ma.pk AND ma.txn_count>0 AND ma.activity_month>=c.cohort_date
			    WHERE c.cohort_label IS NOT NULL
			    GROUP BY c.cohort_label, age_months
			    ORDER BY c.cohort_label, age_months`
		}
		rows, src, err := db.DualQuery(r.Context(), q)
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
		q := `SELECT TO_CHAR(DATE_TRUNC('month',txn_date),'Mon YYYY') AS month,
			        DATE_TRUNC('month',txn_date) AS month_sort,
			        COUNT(DISTINCT cif) AS active_users,
			        COALESCE(SUM(amount),0) AS total_spend,
			        CASE WHEN COUNT(DISTINCT cif)=0 THEN 0
			             ELSE COALESCE(SUM(amount),0)/COUNT(DISTINCT cif) END AS avg_spend
			FROM app.transactions
			WHERE txn_date IS NOT NULL
			GROUP BY DATE_TRUNC('month',txn_date)
			ORDER BY month_sort`
		if qstr(r, "basis") == "person" {
			q = `SELECT TO_CHAR(DATE_TRUNC('month',t.txn_date),'Mon YYYY') AS month,
			        DATE_TRUNC('month',t.txn_date) AS month_sort,
			        COUNT(DISTINCT COALESCE('p'||c.party_id,'c'||c.contact_id,'x'||t.cif)) AS active_users,
			        COALESCE(SUM(t.amount),0) AS total_spend,
			        CASE WHEN COUNT(DISTINCT COALESCE('p'||c.party_id,'c'||c.contact_id,'x'||t.cif))=0 THEN 0
			             ELSE COALESCE(SUM(t.amount),0)/COUNT(DISTINCT COALESCE('p'||c.party_id,'c'||c.contact_id,'x'||t.cif)) END AS avg_spend
			FROM app.transactions t LEFT JOIN app.customers c ON c.cif = t.cif
			WHERE t.txn_date IS NOT NULL
			GROUP BY DATE_TRUNC('month',t.txn_date)
			ORDER BY month_sort`
		}
		rows, src, err := db.DualQuery(r.Context(), q)
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
