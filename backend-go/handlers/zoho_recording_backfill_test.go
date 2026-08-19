package handlers

import (
	"database/sql"
	"os"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/reports/core"
)

// TestBackfillVoiceRecordings re-runs the Voice importer over a wide window so
// every answered call Zoho recorded carries its audio in the workspace.
//
// Needed because the attach is forward-only — it fills a row whose
// recording_filename is NULL and never revisits one — and for a long stretch the
// pairing could not succeed: this server's clock ran ~55 minutes slow, so Desk
// calls and their Voice legs sat an hour apart while the matcher allows ±180s.
// Recordings that failed to pair then were simply never retried.
//
//	ZOHO_BACKFILL_DAYS=60 go test ./handlers -run TestBackfillVoiceRecordings -v -timeout 30m
func TestBackfillVoiceRecordings(t *testing.T) {
	days := os.Getenv("ZOHO_BACKFILL_DAYS")
	if days == "" {
		t.Skip("set ZOHO_BACKFILL_DAYS=<n>")
	}
	n, err := time.ParseDuration(days + "h")
	if err != nil {
		t.Fatalf("ZOHO_BACKFILL_DAYS must be a number of days: %v", err)
	}
	back := int(n.Hours())

	env := readEnv(t, "../.env")
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}
	for k, v := range env {
		if os.Getenv(k) == "" {
			_ = os.Setenv(k, v)
		}
	}
	ctx := t.Context()
	if !zohoEnsureConfigured(ctx, db) {
		t.Fatal("Zoho is not configured")
	}

	count := func() (calls, recs int64) {
		rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) FILTER (WHERE COALESCE(duration_sec,0) > 5) AS conversations,
			       COUNT(recording_filename) AS with_recording
			FROM helpdesk_calls
			WHERE source_system='zoho_desk' AND started_at >= NOW() - make_interval(days => $1)`, back)
		if len(rows) > 0 {
			return toInt64(rows[0]["conversations"]), toInt64(rows[0]["with_recording"])
		}
		return 0, 0
	}

	c0, r0 := count()
	t.Logf("before: %d real conversations, %d with a recording", c0, r0)

	// Walk the window a week at a time — Zoho's log endpoint pages, and a single
	// enormous range times out.
	total := 0
	for off := back; off > 0; off -= 7 {
		from := time.Now().AddDate(0, 0, -off).Format("2006-01-02")
		to := time.Now().AddDate(0, 0, -max(0, off-7)).Format("2006-01-02")
		imported, skipped, failed, err := runZohoVoiceImport(ctx, db, from, to)
		if err != nil {
			t.Logf("  %s..%s  error: %v", from, to, err)
			continue
		}
		total += imported
		t.Logf("  %s..%s  attached=%d skipped=%d failed=%d", from, to, imported, skipped, failed)
	}

	c1, r1 := count()
	t.Logf("after:  %d real conversations, %d with a recording (+%d attached)", c1, r1, r1-r0)
	if total == 0 && r1 == r0 {
		t.Log("nothing new attached — either everything was already paired, or the " +
			"remaining calls genuinely have no recording in Zoho")
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
