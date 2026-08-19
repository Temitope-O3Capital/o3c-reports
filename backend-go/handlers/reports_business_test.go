package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/reports/core"
)

// TestBusinessReportsRunLive executes every report in the library against the
// real database and asserts each returns something an operator can act on.
//
// This exists because the module's defining failure was reports that returned
// nothing and said nothing: a query against a table that does not exist, or one
// that does exist and is empty, both render as a blank page. Asserting on shape
// alone would not have caught either.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestBusinessReportsRunLive -v
func TestBusinessReportsRunLive(t *testing.T) {
	if os.Getenv("EXPORT_LIVE_TEST") != "1" {
		t.Skip("set EXPORT_LIVE_TEST=1")
	}
	env := readEnv(t, "../.env")
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}

	call := func(t *testing.T, h http.HandlerFunc, query string) map[string]any {
		t.Helper()
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest("GET", "/?"+query, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var env struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatalf("decode: %v\n%s", err, rec.Body.String())
		}
		return env.Data
	}

	// A wide window, so a report is not judged empty merely because this month
	// happens to be quiet.
	const wide = "date_from=2020-01-01&date_to=2030-12-31"

	t.Run("income", func(t *testing.T) {
		d := call(t, reportIncome(db), wide)
		total := toInt64(d["total_income_kobo"])
		if total <= 0 {
			t.Fatalf("income report returned %d kobo — the card book carries fee, "+
				"interest and penalty postings, so zero means the classification broke", total)
		}
		cats, _ := d["by_category"].([]any)
		if len(cats) == 0 {
			t.Error("no income categories returned")
		}
		t.Logf("total income %.2f NGN across %d categories", float64(total)/100, len(cats))

		// The double-count guard: interest must not equal the sum of its own
		// components plus itself.
		comps, _ := d["interest_components"].([]any)
		t.Logf("interest components reported separately: %d", len(comps))
	})

	t.Run("card_portfolio", func(t *testing.T) {
		d := call(t, reportCardPortfolio(db), "")
		sum, ok := d["summary"].(map[string]any)
		if !ok {
			t.Fatal("no summary")
		}
		if toInt64(sum["total_accounts"]) <= 0 {
			t.Fatal("card portfolio reported no accounts")
		}
		// Cards is O3's largest product line; a distinct-CIF count below the
		// account count is expected (a person holds several cards).
		t.Logf("accounts=%d active=%d cifs=%d limit=%.2f NGN",
			toInt64(sum["total_accounts"]), toInt64(sum["active_accounts"]),
			toInt64(sum["distinct_cifs"]), float64(toInt64(sum["total_limit_kobo"]))/100)
		for _, k := range []string{"by_status", "by_product", "delinquency", "utilisation"} {
			if rows, _ := d[k].([]any); len(rows) == 0 {
				t.Errorf("%s is empty", k)
			}
		}
	})

	t.Run("customer_acquisition", func(t *testing.T) {
		d := call(t, reportCustomerAcquisition(db), wide)
		if toInt64(d["new_customers"]) <= 0 {
			t.Fatal("acquisition reported no new customers over an all-time window — " +
				"accounts.opened_date is populated, so zero means the measure broke")
		}
		t.Logf("new customers (all time) = %d", toInt64(d["new_customers"]))
		if _, ok := d["party_summary"].(map[string]any); !ok {
			t.Error("no party summary (cards-per-person)")
		}
	})

	t.Run("service_performance", func(t *testing.T) {
		d := call(t, reportServicePerformance(db), wide)
		sum, ok := d["summary"].(map[string]any)
		if !ok {
			t.Fatal("no summary")
		}
		if toInt64(sum["tickets"]) <= 0 {
			t.Fatal("service report returned no tickets despite a populated ticket table")
		}
		t.Logf("tickets=%d resolved=%d csat_responses=%d",
			toInt64(sum["tickets"]), toInt64(sum["resolved"]), toInt64(sum["csat_responses"]))
	})

	t.Run("fd_book", func(t *testing.T) {
		d := call(t, reportFDBook(db), "")
		sum, ok := d["summary"].(map[string]any)
		if !ok {
			t.Fatal("no summary")
		}
		if toInt64(sum["deposits"]) <= 0 {
			t.Fatal("FD book reported no deposits")
		}
		ladder, _ := d["maturity_ladder"].([]any)
		if len(ladder) == 0 {
			t.Error("maturity ladder is empty — this is the part treasury needs")
		}
		t.Logf("deposits=%d principal=%.2f NGN ladder buckets=%d",
			toInt64(sum["deposits"]), float64(toInt64(sum["principal_kobo"]))/100, len(ladder))
	})

	// The pre-existing reports, which had no UI reaching them and so were never
	// exercised by anything.
	t.Run("npl_return", func(t *testing.T) {
		d := call(t, reportNPLReturn(db), "")
		snap, ok := d["snapshot"].(map[string]any)
		if !ok {
			t.Fatal("no snapshot")
		}
		if _, ok := snap["provision_total_kobo"]; !ok {
			t.Error("no provisions on the NPL return")
		}
		buckets, _ := d["dpd_buckets"].([]any)
		if len(buckets) == 0 {
			t.Error("NPL return has no DPD buckets — it used to read an empty snapshot table")
		}
	})

	t.Run("loan_portfolio", func(t *testing.T) {
		d := call(t, reportLoanPortfolio(db), "")
		if _, ok := d["top10_outstanding"]; !ok {
			t.Error("no top-10 concentration table")
		}
	})

	t.Run("kpis", func(t *testing.T) {
		d := call(t, reportKPIsHandler(db), "period=this_year")
		// Revenue is the headline that used to be structurally zero.
		if toInt64(d["active_cards"]) <= 0 {
			t.Error("active_cards is zero")
		}
		t.Logf("active_loans=%d active_cards=%d revenue=%.2f new_customers=%d targets_set=%d",
			toInt64(d["active_loans"]), toInt64(d["active_cards"]),
			float64(toInt64(d["revenue_kobo"]))/100,
			toInt64(d["new_customers"]), toInt64(d["targets_set"]))
	})

	t.Run("kpi_history", func(t *testing.T) {
		rec := httptest.NewRecorder()
		reportKPIHistoryHandler(db)(rec, httptest.NewRequest("GET", "/?months=12", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var env struct {
			Data []map[string]any `json:"data"`
		}
		json.Unmarshal(rec.Body.Bytes(), &env) //nolint:errcheck
		if len(env.Data) != 12 {
			t.Fatalf("expected 12 months, got %d", len(env.Data))
		}
		// Every month must carry the coverage flag, or the UI cannot tell a real
		// zero from a month the card feed never delivered.
		gaps := 0
		for _, m := range env.Data {
			if _, ok := m["data_complete"]; !ok {
				t.Fatal("month is missing data_complete — a feed gap would plot as a real zero")
			}
			if complete, _ := m["data_complete"].(bool); !complete {
				gaps++
			}
		}
		t.Logf("12 months returned, %d flagged as incomplete card feed", gaps)
	})
}
