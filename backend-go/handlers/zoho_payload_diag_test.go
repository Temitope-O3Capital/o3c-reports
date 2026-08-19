package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/reports/core"
)

// TestDumpZohoCallPayload prints the RAW shape of a Zoho Desk call and a Zoho
// Voice log so the timestamp fields can be read rather than guessed at.
//
// 246 of today's 1,239 Desk calls are stamped roughly an hour in the FUTURE
// (started_at after created_at, mean +24 min), which breaks write-up matching
// (ORDER BY started_at DESC picks a fake "most recent") and recording pairing
// (Desk and Voice end up an hour apart and can never match within ±180s).
//
//	ZOHO_DIAG=1 go test ./handlers -run TestDumpZohoCallPayload -v
func TestDumpZohoCallPayload(t *testing.T) {
	if os.Getenv("ZOHO_DIAG") != "1" {
		t.Skip("set ZOHO_DIAG=1")
	}
	env := readEnv(t, "../.env")
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}
	ctx := t.Context()

	// Credentials live encrypted in the DB, so the process needs the same env the
	// server runs with (ENCRYPTION_KEY above all) to decrypt them. Values are set
	// into the environment and never printed.
	for k, v := range env {
		if os.Getenv(k) == "" {
			_ = os.Setenv(k, v)
		}
	}

	if !zohoEnsureConfigured(ctx, db) {
		t.Fatal("Zoho is not configured")
	}

	// ── Desk: the source of started_at ──
	today := time.Now().Format("2006-01-02")
	resp, err := zohoWrite(ctx, "GET", "calls?from=0&limit=3&sortBy=-startTime", nil)
	_ = today
	if err != nil {
		t.Fatalf("desk calls: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 200_000))
	t.Logf("DESK /calls status=%d", resp.StatusCode)

	var deskWrap map[string]any
	if err := json.Unmarshal(raw, &deskWrap); err != nil {
		t.Logf("desk body (first 600 bytes): %s", string(raw[:min(600, len(raw))]))
	} else if arr, ok := deskWrap["data"].([]any); ok && len(arr) > 0 {
		if c, ok := arr[0].(map[string]any); ok {
			t.Log("── DESK CALL: every time-ish field ──")
			keys := make([]string, 0, len(c))
			for k := range c {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				v := c[k]
				if v == nil {
					continue
				}
				s := fmt.Sprintf("%v", v)
				if len(s) > 90 {
					s = s[:90] + "…"
				}
				t.Logf("  %-24s %v", k, s)
			}
			// The decisive comparison.
			t.Log("── how we parse it ──")
			for _, f := range []string{"startTime", "completedTime", "createdTime", "modifiedTime"} {
				if v, ok := c[f]; ok && v != nil {
					parsed := zohoParseTime(v)
					t.Logf("  %-14s raw=%-30v parsed=%v (local %v)",
						f, v, parsed.UTC().Format(time.RFC3339), parsed.Local().Format("15:04:05"))
				}
			}
			t.Logf("  NOW            local=%s utc=%s",
				time.Now().Format("15:04:05"), time.Now().UTC().Format("15:04:05"))
		}
	}

	// ── Voice: the source the recording pairs against ──
	vtok, verr := zohoVoiceAccessToken(ctx, db)
	if verr != nil {
		t.Logf("voice token: %v (skipping Voice dump)", verr)
		return
	}
	vURL := fmt.Sprintf("https://voice.zoho.com/rest/json/zv/logs?from=0&size=2&fromDate=%s&toDate=%s", today, today)
	vreq, _ := http.NewRequestWithContext(ctx, "GET", vURL, nil)
	vreq.Header.Set("Authorization", "Zoho-oauthtoken "+vtok)
	vresp, verr2 := zohoHTTP.Do(vreq)
	if verr2 != nil {
		t.Logf("voice logs: %v", verr2)
		return
	}
	defer vresp.Body.Close()
	vraw, _ := io.ReadAll(io.LimitReader(vresp.Body, 200_000))
	t.Logf("VOICE /logs status=%d", vresp.StatusCode)
	var vWrap map[string]any
	if err := json.Unmarshal(vraw, &vWrap); err == nil {
		var logs []any
		if a, ok := vWrap["logs"].([]any); ok {
			logs = a
		} else if a, ok := vWrap["data"].([]any); ok {
			logs = a
		} else if r, ok := vWrap["response"].(map[string]any); ok {
			if a, ok := r["result"].([]any); ok {
				logs = a
			}
		}
		if len(logs) > 0 {
			if c, ok := logs[0].(map[string]any); ok {
				t.Log("── VOICE LOG: every field ──")
				keys := make([]string, 0, len(c))
				for k := range c {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				for _, k := range keys {
					s := fmt.Sprintf("%v", c[k])
					if len(s) > 90 {
						s = s[:90] + "…"
					}
					t.Logf("  %-24s %v", k, s)
				}
				if st, ok := c["start_time"]; ok {
					p := zohoParseMillisTime(st)
					t.Logf("  start_time raw=%v parsed=%v (local %v)",
						st, p.UTC().Format(time.RFC3339), p.Local().Format("15:04:05"))
				}
			}
		} else {
			t.Logf("voice body (first 500): %s", string(vraw[:min(500, len(vraw))]))
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
