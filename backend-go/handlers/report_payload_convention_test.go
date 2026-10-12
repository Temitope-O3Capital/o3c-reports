package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

// THE REPORT PAYLOAD CONVENTION, AND WHY IT IS ENFORCED BY A TEST RATHER THAN A REGISTRY.
//
// The 14 library reports each return their own shape: named blocks of rows, plus some
// scalars. One generic page renders all of them, which means the page has to know how to
// format each value — is 1094578699 naira, or kobo, or a count of tickets?
//
// The obvious way to tell it would be a metadata registry: a table declaring each
// report's blocks and column types. That was rejected deliberately. A registry is a
// SECOND place the same fact lives, and this module has been bitten by exactly that
// repeatedly — a column added to a query and not to its description, or described as
// money when the writer stores kobo. The 100x overstatement on the retention export
// (export_datasets.go: colMoney over a kobo column) was one place; "Last Active Year" as
// the label on a money column was another, on the same line.
//
// So the payload describes ITSELF, by the name of each key, and this test is what keeps
// that true. A money value must end _kobo (or _ngn if it really is major units), a
// percentage _pct, a basis point figure _bps, a timestamp _at, a date _date.
//
// This was affordable to impose because of a fact that will not hold again: measured
// 2026-10-07, NOTHING consumed any of these 14 payloads. All 14 had zero frontend
// callers (the two apparent hits were /api/cbs/reports/fd-book and
// /api/crm/reports/agent-performance — different modules entirely), so renaming output
// keys broke nothing. The moment a page reads them, that freedom is gone, which is
// precisely why the convention went in alongside the page rather than after it.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestReportPayloadsDescribeThemselves -v
//
// Live-gated: the convention is about what the handlers actually EMIT, and a fixture
// would only tell us what we expected them to emit.

// reportPayloadPlainKeys are keys that legitimately carry no type suffix: labels,
// identifiers, statuses and counts, all of which render as text or a bare integer.
//
// Add to this ONLY for a value that is genuinely not money, not a percentage and not a
// date. If you are reaching for it to silence a failure on a money column, rename the
// column instead — that is the whole point of the test.
var reportPayloadPlainKeys = map[string]bool{
	// Grouping labels and dimensions.
	"product_name": true, "product_type": true, "product_line": true, "category": true,
	"status": true, "stage": true, "source": true, "state": true, "channel": true,
	"band": true, "bucket": true, "risk_band": true, "dpd_bucket": true, "component": true,
	"family": true, "provision_band": true,
	"direction": true, "currency": true, "period_label": true, "entity_type": true,
	"agent_name": true, "officer_name": true, "customer_name": true, "full_name": true,
	"first_name": true, "last_name": true, "role": true, "action": true, "detail": true,
	"reference": true, "case_ref": true, "ticket_ref": true, "cif": true, "cif_number": true,
	"applicant_cif": true, "account_cif": true, "cbs_customer_id": true, "email": true,
	"phone": true, "job_title": true, "city": true, "name_on_card": true,
	"account_manager": true, "merchant_name": true, "description": true, "amount": true,
	"cbs_account_number": true, "reference_number": true, "account_no": true,
	"account_number": true, "provision_basis": true, "basis": true, "balance_basis": true,
	"repayments_captured_from": true,

	// Counts. Integers, rendered as integers.
	"loan_count": true, "loans_booked": true, "payment_count": true, "new_accounts": true,
	"new_customers": true, "accounts": true, "active_accounts": true, "total_accounts": true,
	"distinct_cifs": true, "cards_held": true, "parties": true, "deposits": true,
	"customers": true, "leads": true, "converted": true, "disqualified": true,
	"owned": true, "open_leads": true, "tickets": true, "tickets_created": true,
	"resolved": true, "sla_breached": true, "csat_responses": true, "calls": true,
	"contact_attempts": true, "promises_total": true, "promises_broken": true,
	"contacts_total": true, "active_days": true, "assigned_count": true, "count": true,
	"total_loans": true, "active_loans": true, "legs": true, "payments": true,
	"cases": true, "active_cases": true, "legal_cases": true, "snaps": true,
	"npl_snapshots": true, "txn_count": true, "open_products": true, "dpd": true,
	"tenor_days": true, "tenor_months": true, "avg_tenor_days": true,
	"avg_tenor_months": true, "targets_set": true, "limit": true, "offset": true,
	"total": true, "id": true, "user_id": true, "agent_user_id": true,

	// Booleans and flags.
	"data_complete": true, "measured": true, "contactable": true, "reconciled": true,

	// Durations and averages that are explicitly unit-labelled in their own name.
	"avg_duration_sec": true, "avg_first_response_min": true, "avg_resolution_hours": true,
	"total_hours": true, "avg_csat": true, "csat": true, "csat_score": true,
	"avg_cards_per_party": true, "avg_rate": true, "interest_rate": true,
	"avg_utilisation_pct": true,
}

// reportPayloadTypeSuffixes are the suffixes that make a value self-describing. A
// PREFIX counts too: date_booked says what it is as plainly as booked_date would, and
// renaming a column just to move the word would be churn for its own sake — see
// payloadKeyIsSelfDescribing.
var reportPayloadTypeSuffixes = []string{
	"_kobo", // minor units — divide by 100 to display
	"_ngn",  // major units already
	"_pct", "_bps",
	"_at", "_date", "_start", "_end",
	"_name", "_id", "_ref", "_count", "_rate_pct",
}

// reportUnderTest is one library report and how to reach its handler.
type reportUnderTest struct {
	key   string
	query string
	h     func(*core.DB) http.HandlerFunc
}

func libraryReportsUnderTest() []reportUnderTest {
	// A wide window, so a report is not judged empty merely because this month is quiet.
	w := "?date_from=2026-01-01&date_to=2026-12-31"
	return []reportUnderTest{
		{"income", w, reportIncome},
		{"card-portfolio", w, reportCardPortfolio},
		{"customer-acquisition", w, reportCustomerAcquisition},
		{"service-performance", w, reportServicePerformance},
		{"fd-book", w, reportFDBook},
		{"monthly-business", w, reportMonthlyBusiness},
		{"loan-portfolio", w, reportLoanPortfolio},
		{"collections-performance", w, reportCollectionsPerformance},
		{"settlement-recon", w, reportSettlementRecon},
		{"agent-performance", w, reportAgentPerformance},
		{"npl-return", w, reportNPLReturn},
		{"sales-pipeline", w, reportSalesPipeline},
	}
}

func TestReportPayloadsDescribeThemselves(t *testing.T) {
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

	for _, rep := range libraryReportsUnderTest() {
		t.Run(rep.key, func(t *testing.T) {
			rec := httptest.NewRecorder()
			rep.h(db)(rec, httptest.NewRequest("GET", "/"+rep.query, nil))
			if rec.Code != 200 {
				t.Fatalf("%s returned %d: %s", rep.key, rec.Code, rec.Body.String())
			}
			var body struct {
				Data map[string]any `json:"data"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("%s: decode: %v", rep.key, err)
			}
			bad := []string{}
			for _, k := range collectPayloadKeys(body.Data) {
				if !payloadKeyIsSelfDescribing(k) {
					bad = append(bad, k)
				}
			}
			sort.Strings(bad)
			if len(bad) > 0 {
				t.Errorf("%s emits keys that do not say what they are: %s\n"+
					"Rename the SQL alias to carry its type (_kobo for minor units, _pct, "+
					"_at, _date), or — only if it is genuinely a label or a count — add it "+
					"to reportPayloadPlainKeys. Do NOT add a money column to that list: the "+
					"page formats on the name, so a bare money key renders kobo as naira.",
					rep.key, strings.Join(bad, ", "))
			}
		})
	}
}

// collectPayloadKeys walks a report payload and returns every leaf key a renderer would
// have to format. Blocks are arrays of row objects or bare scalars, and both nest.
func collectPayloadKeys(v any) []string {
	seen := map[string]bool{}
	var walk func(any, int)
	walk = func(n any, depth int) {
		if depth > 6 {
			return
		}
		switch t := n.(type) {
		case map[string]any:
			for k, inner := range t {
				switch inner.(type) {
				case map[string]any, []any:
					// A block name is structure, not a value to format.
					walk(inner, depth+1)
				default:
					seen[k] = true
				}
			}
		case []any:
			for _, inner := range t {
				walk(inner, depth+1)
			}
		}
	}
	walk(v, 0)
	out := make([]string, 0, len(seen))
	for k := range seen {
		// The envelope's own fields are not report values.
		if k == "date_from" || k == "date_to" {
			continue
		}
		out = append(out, k)
	}
	return out
}

func payloadKeyIsSelfDescribing(k string) bool {
	if reportPayloadPlainKeys[k] {
		return true
	}
	if strings.HasPrefix(k, "date_") {
		return true
	}
	for _, s := range reportPayloadTypeSuffixes {
		if strings.HasSuffix(k, s) {
			return true
		}
	}
	return false
}

// reportKeyKind is the single place the display type of a payload key is decided, so the
// frontend renderer and this test cannot disagree about what a column is. Exposed as a
// string the frontend mirrors in one small function; see Library.tsx.
func reportKeyKind(k string) string {
	switch {
	case strings.HasSuffix(k, "_kobo"):
		return "kobo"
	case strings.HasSuffix(k, "_ngn"):
		return "money"
	case strings.HasSuffix(k, "_pct"):
		return "pct"
	case strings.HasSuffix(k, "_bps"):
		return "bps"
	case strings.HasSuffix(k, "_at"):
		return "datetime"
	case strings.HasSuffix(k, "_date"), strings.HasPrefix(k, "date_"),
		strings.HasSuffix(k, "_start"), strings.HasSuffix(k, "_end"):
		return "date"
	}
	return "text"
}

func TestReportKeyKindCoversEveryDeclaredSuffix(t *testing.T) {
	// Every suffix the convention admits must map to a kind, or a column could pass the
	// naming rule and still render as raw text — the quiet half of the same bug.
	for _, s := range []string{"_kobo", "_ngn", "_pct", "_bps", "_at", "_date", "_start", "_end"} {
		if got := reportKeyKind(fmt.Sprintf("x%s", s)); got == "text" {
			t.Errorf("suffix %s is accepted by the convention but reportKeyKind returns text", s)
		}
	}
}

// TestUndatedReportsReallyIgnoreTheirDatesLive pins the catalogue's Undated flag to the
// handlers' actual behaviour.
//
// reportsList declares card-portfolio and fd-book as undated so the Report Library stops
// offering a date filter that changes nothing. That declaration is a SECOND place the
// same fact lives, and the first place is a handler nobody will remember to check. So
// this asserts it empirically: run each undated report over two wildly different
// windows, and the DATA must be the same.
//
// COMPARED AS A MULTISET, NOT AS BYTES. The first version of this test compared the raw
// JSON and failed on card-portfolio, which reads no date at all — several of its blocks
// have no deterministic ORDER BY, so Postgres is free to return the same rows in a
// different sequence between two calls. Comparing bytes would have had this test
// reporting a date dependency that does not exist, which is exactly the kind of false
// alarm that gets a test deleted rather than believed.
func TestUndatedReportsReallyIgnoreTheirDatesLive(t *testing.T) {
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

	undated := map[string]func(*core.DB) http.HandlerFunc{
		"card-portfolio": reportCardPortfolio,
		"fd-book":        reportFDBook,
	}
	for key, h := range undated {
		t.Run(key, func(t *testing.T) {
			fingerprint := func(q string) string {
				rec := httptest.NewRecorder()
				h(db)(rec, httptest.NewRequest("GET", "/"+q, nil))
				if rec.Code != 200 {
					t.Fatalf("%s returned %d: %s", key, rec.Code, rec.Body.String())
				}
				var body struct {
					Data map[string]any `json:"data"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatalf("decode: %v", err)
				}
				return canonicalJSON(body.Data)
			}
			a := fingerprint("?date_from=2019-01-01&date_to=2019-01-31")
			b := fingerprint("?date_from=2026-01-01&date_to=2026-12-31")
			if a != b {
				t.Errorf("%s is declared Undated in reportsList, but a 2019 window and a "+
					"2026 window return different DATA — so it does read its dates.\n"+
					"Remove Undated from its catalogue entry, or the Report Library will "+
					"hide a date filter the report actually honours.", key)
			}
		})
	}
}

// canonicalJSON renders a decoded payload so that two payloads holding the same data
// compare equal regardless of the order rows arrived in. Arrays are sorted by their
// own serialisation; object keys are sorted at every level.
func canonicalJSON(v any) string {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			parts = append(parts, k+":"+canonicalJSON(t[k]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	case []any:
		parts := make([]string, 0, len(t))
		for _, e := range t {
			parts = append(parts, canonicalJSON(e))
		}
		sort.Strings(parts)
		return "[" + strings.Join(parts, ",") + "]"
	default:
		return fmt.Sprintf("%v", v)
	}
}
