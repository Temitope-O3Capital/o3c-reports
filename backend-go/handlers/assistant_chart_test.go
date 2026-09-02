package handlers

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/o3c/reports/core"
)

// Runs every tool and reports which of them yield a chart, so the extractor's
// coverage is visible rather than assumed. It also guards the two mistakes that
// made charts actively misleading the first time round:
//
//   - identifiers plotted as metrics (a customer search charted CIF and phone
//     number, where a tall bar reads as a large value)
//   - a label column that repeats (get_revenue_summary returns category/product
//     pairs; keyed on category, twelve rows collapse onto two labels)
//
// Skips unless PGURL is set, so it stays inert in CI.
func TestChartExtraction(t *testing.T) {
	url := os.Getenv("PGURL")
	if url == "" {
		t.Skip("set PGURL")
	}
	db, err := core.Open(&core.Config{PGURL: url, DirectPGURL: url})
	if err != nil {
		t.Fatal(err)
	}
	u := &core.Claims{ID: 1, Role: "admin", FullName: "T"}

	charted := 0
	for _, tl := range assistantTools() {
		args := map[string]any{}
		switch tl.Name {
		case "search_customers":
			args["query"] = "john"
		case "find_staff":
			args["name"] = "a"
		case "get_customer_transactions", "get_customer_overview":
			continue // need a specific customer; covered by the end-to-end test
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		res, rerr := tl.Run(ctx, db, u, args)
		cancel()
		if rerr != nil {
			t.Errorf("%s: %v", tl.Name, rerr)
			continue
		}
		ch := assistantChartFrom(tl.Name, res)
		if ch == nil {
			t.Logf("%-30s no chart", tl.Name)
			continue
		}
		charted++

		// A repeated x label means the wrong column was chosen for the axis.
		seen := map[string]bool{}
		for _, r := range ch.Rows {
			lbl, _ := r[ch.XKey].(string)
			if seen[lbl] {
				t.Errorf("%s: x axis %q repeats the label %q — the chart would collapse rows together",
					tl.Name, ch.XKey, lbl)
				break
			}
			seen[lbl] = true
		}
		for _, s := range ch.Series {
			if notAMetric[s.Key] {
				t.Errorf("%s: charting %q, which is an identifier and not a quantity", tl.Name, s.Key)
			}
		}
		keys := make([]string, 0, len(ch.Series))
		for _, s := range ch.Series {
			keys = append(keys, s.Key)
		}
		t.Logf("%-30s %-5s x=%-14s rows=%-3d series=%v", tl.Name, ch.Kind, ch.XKey, len(ch.Rows), keys)
	}
	if charted == 0 {
		t.Error("no tool produced a chart; the extractor has stopped matching anything")
	}
}
