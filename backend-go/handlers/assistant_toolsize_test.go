package handlers

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/o3c/workspace/core"
)

// Guards the round-2 prefill cost. Every token a tool returns is read back into
// the model on the next round at ~54 tok/s, so a tool that quietly grows to a
// few thousand tokens adds tens of seconds to every turn that calls it. Skips
// unless PGURL is set, so it is inert in CI.
func TestToolResultSizes(t *testing.T) {
	url := os.Getenv("PGURL")
	if url == "" {
		t.Skip("set PGURL")
	}
	db, err := core.Open(&core.Config{PGURL: url, DirectPGURL: url})
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	admin := &core.Claims{ID: 1, Role: "admin", FullName: "Test Admin"}

	type row struct {
		name  string
		bytes int
		ms    int64
		err   string
	}
	var rows []row
	for _, tl := range assistantTools() {
		args := map[string]any{}
		switch tl.Name {
		case "search_customers":
			args["query"] = "john"
		case "get_customer_overview":
			continue // needs a real CIF
		case "get_agent_call_stats":
			args["days"] = 7.0
		case "find_staff":
			args["name"] = "a"
		case "get_customer_transactions":
			args["customer"] = "Pinheiro"
		case "get_transaction_volume":
			if os.Getenv("LONG") != "" {
				args["days"] = 90.0
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		t0 := time.Now()
		out, err := tl.Run(ctx, db, admin, args)
		ms := time.Since(t0).Milliseconds()
		cancel()
		r := row{name: tl.Name, ms: ms}
		if err != nil {
			r.err = err.Error()
		} else {
			b, _ := json.Marshal(out)
			r.bytes = len(b)
		}
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].bytes > rows[j].bytes })
	total := 0
	for _, r := range rows {
		total += r.bytes
		t.Logf("%-30s %6d B  ~%5d tok  %5d ms  %s", r.name, r.bytes, r.bytes/4, r.ms, r.err)
	}
	t.Logf("TOTAL across tools: %d B", total)
	for _, r := range rows {
		if r.err != "" {
			t.Errorf("%s failed outright: %s", r.name, r.err)
		}
		if tok := r.bytes / 4; tok > 800 {
			t.Errorf("%s returns ~%d tokens; over ~800 it costs more than ~15s of prefill on every turn that calls it", r.name, tok)
		}
	}
}
