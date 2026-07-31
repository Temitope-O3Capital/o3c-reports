package handlers

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/reports/core"
)

// TestCBSReports exercises the report handlers directly (bypassing auth middleware)
// against the live snapshot tables populated by the sync worker.
//
//	CBS_LIVE_TEST=1 go test ./handlers -run TestCBSReports -v
func TestCBSReports(t *testing.T) {
	if os.Getenv("CBS_LIVE_TEST") != "1" {
		t.Skip("set CBS_LIVE_TEST=1")
	}
	env := readEnv(t, "../.env")
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}

	call := func(h http.HandlerFunc) map[string]any {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/", nil)
		h(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return out
	}

	// ── Loan book ──
	lb := call(cbsLoanBook(db))
	loanSummary, _ := lb["summary"].(map[string]any)
	t.Logf("loan-book summary: %v", loanSummary)
	if n := num(loanSummary["accounts"]); n != 66 {
		t.Errorf("loan accounts = %v, want 66", loanSummary["accounts"])
	}
	if len(lb["by_status"].([]any)) == 0 {
		t.Error("loan by_status empty")
	}
	if got := len(lb["loans"].([]any)); got != 66 {
		t.Errorf("loans list = %d, want 66", got)
	}

	// ── FD book ──
	fb := call(cbsFDBook(db))
	fdSummary, _ := fb["summary"].(map[string]any)
	t.Logf("fd-book summary: %v", fdSummary)
	if n := num(fdSummary["accounts"]); n != 189 {
		t.Errorf("fd accounts = %v, want 189", fdSummary["accounts"])
	}
	if len(fb["maturity_ladder"].([]any)) == 0 {
		t.Error("fd maturity_ladder empty")
	}

	// ── Reconciliation ──
	rc := call(cbsReconciliation(db))
	loanRec, _ := rc["loans"].(map[string]any)
	fdRec, _ := rc["fixed_deposits"].(map[string]any)
	t.Logf("reconciliation loans=%v fds=%v", loanRec, fdRec)
	if num(loanRec["cbs_total"]) != 66 {
		t.Errorf("recon loan cbs_total = %v, want 66", loanRec["cbs_total"])
	}
	if num(fdRec["cbs_total"]) != 189 {
		t.Errorf("recon fd cbs_total = %v, want 189", fdRec["cbs_total"])
	}
	t.Logf("unmatched loans=%d fds=%d",
		len(rc["unmatched_loans"].([]any)), len(rc["unmatched_fds"].([]any)))
}

func num(v any) int {
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return -1
}

func readEnv(t *testing.T, path string) map[string]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	out := map[string]string{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok {
			out[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	return out
}
