package handlers

import (
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/workspace/core"
)

func callLog(t *testing.T) exportDataset {
	t.Helper()
	d, ok := exportDatasetByKey("helpdesk_calls")
	if !ok {
		t.Fatal("helpdesk_calls dataset missing")
	}
	return d
}

// ── Table view query: the injection boundary ─────────────────────────────────

func TestTableQueryRejectsUnknownColumnsAndSorts(t *testing.T) {
	d := callLog(t)
	for _, bad := range []string{"hc.direction; DROP TABLE app.helpdesk_calls", "nonexistent"} {
		if _, err := buildTableQuery(d, tableSpec{Columns: []tableColumn{{Key: bad}}}); err == nil {
			t.Errorf("column %q was accepted", bad)
		}
		if _, err := buildTableQuery(d, tableSpec{Columns: []tableColumn{{Key: "direction"}}, Sort: []reportSort{{Key: bad}}}); err == nil {
			t.Errorf("sort field %q was accepted", bad)
		}
	}
	if _, err := buildTableQuery(d, tableSpec{}); err == nil {
		t.Error("a table with no columns was accepted")
	}
}

// Unlike a raw export, a Table keeps the order the person arranged, under their names.
func TestTableQueryKeepsColumnOrderAndNames(t *testing.T) {
	d := callLog(t)
	tq, err := buildTableQuery(d, tableSpec{Columns: []tableColumn{
		{Key: "disposition", Label: "Outcome of call"},
		{Key: "started_at"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if tq.Cols[0].Key != "disposition" || tq.Cols[0].Label != "Outcome of call" || tq.Cols[1].Label != "Started" {
		t.Fatalf("cols = %+v", tq.Cols)
	}
	if strings.Index(tq.Select, "hc.disposition") > strings.Index(tq.Select, "hc.started_at") {
		t.Fatalf("select order is not the requested order:\n%s", tq.Select)
	}
}

func TestTableQuerySortDirectionIsAWhitelist(t *testing.T) {
	d := callLog(t)
	tq, err := buildTableQuery(d, tableSpec{
		Columns: []tableColumn{{Key: "direction"}},
		Sort:    []reportSort{{Key: "started_at", Dir: "desc; DROP TABLE app.helpdesk_calls"}},
		Limit:   50, Offset: -10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(tq.Select, "DROP") || !strings.Contains(tq.Select, "ASC NULLS LAST") {
		t.Fatalf("sort direction reached the SQL:\n%s", tq.Select)
	}
	if !strings.HasSuffix(tq.Select, "LIMIT 50 OFFSET 0") {
		t.Fatalf("limit/offset not clamped:\n%s", tq.Select)
	}
}

func TestTableQueryTotalsOnlyAddableColumns(t *testing.T) {
	d := callLog(t)
	tq, err := buildTableQuery(d, tableSpec{Columns: []tableColumn{{Key: "disposition"}, {Key: "duration_sec"}}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(tq.Totals, `AS "t_duration_sec"`) || strings.Contains(tq.Totals, "t_disposition") {
		t.Fatalf("totals query = %s", tq.Totals)
	}
}

// ── Column filters ───────────────────────────────────────────────────────────

func TestDateTimeFilterComparesDaysOrTimestamps(t *testing.T) {
	d := callLog(t)
	where, _, err := buildExportWhere(d, exportRequest{ColFilters: []colFilter{{Column: "started_at", Op: "lte", Value: "2026-09-12"}}})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(where, " "); !strings.Contains(got, ")::date::date <= $1::date") {
		t.Fatalf("a bare date must compare by calendar day: %s", got)
	}
	where, _, err = buildExportWhere(d, exportRequest{ColFilters: []colFilter{{Column: "started_at", Op: "gte", Value: "2026-09-12T18:00"}}})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(where, " "); !strings.Contains(got, "::timestamp >= $1::timestamp") {
		t.Fatalf("a date with a time must compare as a timestamp: %s", got)
	}
}

func TestInListFilterCanIncludeBlanks(t *testing.T) {
	d := callLog(t)
	where, args, err := buildExportWhere(d, exportRequest{ColFilters: []colFilter{
		{Column: "disposition", Op: "in", Values: []string{"Interested"}, IncludeBlank: true},
	}})
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(where, " ")
	if !strings.Contains(got, "IN ($1::text)") || !strings.Contains(got, "IS NULL OR") || len(args) != 1 {
		t.Fatalf("values plus blank: %s %v", got, args)
	}
	where, _, _ = buildExportWhere(d, exportRequest{ColFilters: []colFilter{
		{Column: "disposition", Op: "in", IncludeBlank: true},
	}})
	if got := strings.Join(where, " "); strings.Contains(got, " IN (") || !strings.Contains(got, "IS NULL") {
		t.Fatalf("blank only: %s", got)
	}
}

func TestUniquesQueryBindsSearchAndListsDatesByDay(t *testing.T) {
	d := callLog(t)
	if _, _, err := buildUniquesQuery(d, uniquesSpec{Column: "(SELECT 1)"}); err == nil {
		t.Fatal("unknown column accepted")
	}
	evil := "x' OR 1=1 --"
	q, args, err := buildUniquesQuery(d, uniquesSpec{Column: "disposition", Search: evil, Limit: 9999})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(q, evil) || args[len(args)-1] != evil || !strings.HasSuffix(q, "LIMIT 500") {
		t.Fatalf("search not bound or limit not capped:\n%s", q)
	}
	q, _, _ = buildUniquesQuery(d, uniquesSpec{Column: "started_at"})
	if !strings.Contains(q, "'YYYY-MM-DD'") {
		t.Fatalf("date values should be listed by day:\n%s", q)
	}
}

// ── Caps and recipients ──────────────────────────────────────────────────────

func TestReportFilesCarryTheDataSourceCapForEveryone(t *testing.T) {
	d := callLog(t)
	// A department head's file used to stop at 5,000 while BI got the data source's cap.
	// Removed 2026-09-18 after a supervisor's download came back short: the cap a file
	// carries is the data source's, whoever asked for it.
	if got := d.maxRows(); got != exportDefaultMaxRows {
		t.Errorf("call log cap = %d, want the data source cap %d", got, exportDefaultMaxRows)
	}
	// A head still only reaches their own departments' data sources.
	if reportDatasetAllowed(reportClaims("call_center_head"), "loan_book") {
		t.Error("a call centre head reached the loan book")
	}
	// BI may email anywhere without a lookup.
	if bad := reportRecipientsNotAllowed(t.Context(), nil, reportClaims("bi_head"), []string{"someone@example.com"}); bad != nil {
		t.Errorf("BI recipients refused: %v", bad)
	}
}

// ── Against the real database ────────────────────────────────────────────────

func TestReportBuilderRunsLive(t *testing.T) {
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
	ctx := t.Context()
	d := callLog(t)
	to := time.Now().Format("2006-01-02")
	from := time.Now().AddDate(0, 0, -6).Format("2006-01-02")

	res, err := runTable(ctx, db, d, tableSpec{
		DateFrom: from, DateTo: to, Filters: map[string]string{"direction": "inbound"},
		Columns: []tableColumn{{Key: "started_at"}, {Key: "customer_name", Label: "Customer"}, {Key: "disposition"}, {Key: "duration_sec"}},
		Sort:    []reportSort{{Key: "started_at", Dir: "desc"}}, Limit: 20,
	}, true)
	if err != nil {
		t.Fatalf("table: %v", err)
	}
	if res.Total < int64(len(res.Rows)) {
		t.Fatalf("total %d below page %d", res.Total, len(res.Rows))
	}
	t.Logf("table: %d rows of %d inbound calls, talk time total %v", len(res.Rows), res.Total, res.Totals["duration_sec"])

	q, args, err := buildUniquesQuery(d, uniquesSpec{Column: "disposition", DateFrom: from, DateTo: to})
	if err != nil {
		t.Fatal(err)
	}
	urows, err := db.PGQuery(ctx, q, args...)
	if err != nil {
		t.Fatalf("uniques: %v", err)
	}
	t.Logf("uniques: %d disposition values, most common %v", len(urows), urows[0])

	if _, err := runTable(ctx, db, d, tableSpec{
		DateFrom: from, DateTo: to, Columns: []tableColumn{{Key: "started_at"}},
		ColFilters: []colFilter{
			{Column: "started_at", Op: "in", Values: []string{to}},
			{Column: "disposition", Op: "in", IncludeBlank: true},
			{Column: "started_at", Op: "gte", Value: to + "T08:00"},
		},
	}, true); err != nil {
		t.Fatalf("date and blank filters: %v", err)
	}

	simple, err := runPivot(ctx, db, d, pivotSpec{DateFrom: from, DateTo: to,
		Rows: []string{"agent_name"}, Values: []pivotValue{{Agg: "count"}}, TopN: &pivotTopN{Measure: 0, N: 2}})
	if err != nil {
		t.Fatalf("top N: %v", err)
	}
	if len(simple.Rows) > 2 || (len(simple.Rows) == 2 && toInt64(simple.Rows[0]["m_0"]) < toInt64(simple.Rows[1]["m_0"])) {
		t.Fatalf("top 2 agents wrong: %v", simple.Rows)
	}
	t.Logf("top 2 of %d agents: %v", simple.GroupTotal, simple.Rows)

	cross, err := runPivot(ctx, db, d, pivotSpec{DateFrom: from, DateTo: to,
		Rows: []string{"agent_name"}, Cols: []string{"disposition"}, Values: []pivotValue{{Agg: "count"}},
		TopN: &pivotTopN{Measure: 0, N: 3}})
	if err != nil {
		t.Fatalf("top N with columns: %v", err)
	}
	agents := map[any]bool{}
	for _, r := range cross.Rows {
		agents[r["d_agent_name"]] = true
	}
	if len(agents) > 3 {
		t.Fatalf("top 3 agents across columns kept %d agents", len(agents))
	}

	rep, err := renderReport(ctx, db, d, savedPivotConfig{
		View: "table", DateWindow: "last_7_days",
		Columns: []tableColumn{{Key: "started_at"}, {Key: "disposition"}, {Key: "duration_sec", Label: "Talk time"}},
		Totals:  []string{"duration_sec"}, Sort: []reportSort{{Key: "started_at", Dir: "desc"}},
	}, time.Now(), 5)
	if err != nil {
		t.Fatalf("render table: %v", err)
	}
	if rep.Total > 5 && (!rep.Truncated || len(rep.Rows) != 6) {
		t.Fatalf("capped table file: truncated=%v rows=%d total=%d", rep.Truncated, len(rep.Rows), rep.Total)
	}
	if rep.Cols[2].Label != "Talk time" {
		t.Fatalf("renamed column lost in file: %+v", rep.Cols)
	}

	sum, err := renderReport(ctx, db, d, savedPivotConfig{
		DateWindow: "last_7_days", Rows: []string{"purpose"}, Values: []pivotValue{{Agg: "count"}},
		HeaderLabels: map[string]string{"m:0": "Calls"}, Sort: []reportSort{{Key: "m:0", Dir: "desc"}},
	}, time.Now(), 5000)
	if err != nil {
		t.Fatalf("render summary: %v", err)
	}
	if len(sum.Cols) != 2 || sum.Cols[1].Label != "Calls" {
		t.Fatalf("summary file columns: %+v", sum.Cols)
	}
	t.Logf("summary file: %v", sum.Rows)
}
