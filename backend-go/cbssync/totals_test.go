package cbssync

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// TestSnapshotTotals reads the already-synced snapshot tables (no CBS calls) and
// prints portfolio totals, confirming amounts were stored correctly in kobo.
//
//	CBS_LIVE_TEST=1 go test ./cbssync -run TestSnapshotTotals -v
func TestSnapshotTotals(t *testing.T) {
	if os.Getenv("CBS_LIVE_TEST") != "1" {
		t.Skip("set CBS_LIVE_TEST=1")
	}
	env := readDotEnv(t, "../.env")
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	ctx := context.Background()

	var loanN int
	var loanOut, loanAmt sql.NullInt64
	if err := pg.QueryRowContext(ctx, `SELECT count(*), COALESCE(sum(outstanding_principal_kobo),0),
		COALESCE(sum(loan_amount_kobo),0) FROM cbs_loans`).Scan(&loanN, &loanOut, &loanAmt); err != nil {
		t.Fatalf("loan totals: %v", err)
	}
	var fdN int
	var fdPrin, fdAccr sql.NullInt64
	if err := pg.QueryRowContext(ctx, `SELECT count(*), COALESCE(sum(principal_kobo),0),
		COALESCE(sum(accrued_interest_kobo),0) FROM cbs_fixed_deposits`).Scan(&fdN, &fdPrin, &fdAccr); err != nil {
		t.Fatalf("fd totals: %v", err)
	}

	t.Logf("LOAN BOOK: %d accounts | disbursed NGN %s | outstanding NGN %s",
		loanN, naira(loanAmt.Int64), naira(loanOut.Int64))
	t.Logf("FD BOOK:   %d accounts | principal NGN %s | accrued NGN %s",
		fdN, naira(fdPrin.Int64), naira(fdAccr.Int64))

	// By-status breakdowns (sanity).
	logGroup(t, ctx, pg, "loans by status", `SELECT status, count(*), COALESCE(sum(outstanding_principal_kobo),0)
		FROM cbs_loans GROUP BY status ORDER BY count(*) DESC`)

	if loanN == 0 || fdN == 0 {
		t.Fatal("snapshot is empty; run TestLiveSync first")
	}
	// Ballpark sanity (order of magnitude), not exact — Udara is the source of truth.
	if loanOut.Int64 < 100_00000000 || loanOut.Int64 > 5000_00000000 {
		t.Errorf("loan outstanding out of expected range: %d kobo", loanOut.Int64)
	}
	if fdPrin.Int64 < 1_000_00000000 { // >= ~1bn naira
		t.Errorf("FD principal unexpectedly low: %d kobo", fdPrin.Int64)
	}
}

func logGroup(t *testing.T, ctx context.Context, pg *sql.DB, label, q string) {
	rows, err := pg.QueryContext(ctx, q)
	if err != nil {
		t.Logf("%s: %v", label, err)
		return
	}
	defer rows.Close()
	t.Logf("%s:", label)
	for rows.Next() {
		var s sql.NullString
		var n int
		var amt sql.NullInt64
		if err := rows.Scan(&s, &n, &amt); err != nil {
			return
		}
		t.Logf("   %-14s %3d acct | NGN %s", s.String, n, naira(amt.Int64))
	}
}

// naira formats kobo as a comma-grouped naira string.
func naira(kobo int64) string {
	neg := kobo < 0
	if neg {
		kobo = -kobo
	}
	whole := kobo / 100
	frac := kobo % 100
	s := ""
	digits := []byte{}
	for whole > 0 {
		digits = append(digits, byte('0'+whole%10))
		whole /= 10
	}
	if len(digits) == 0 {
		digits = []byte{'0'}
	}
	for i := 0; i < len(digits); i++ {
		if i > 0 && i%3 == 0 {
			s = "," + s
		}
		s = string(digits[i]) + s
	}
	out := s + "." + string([]byte{byte('0' + frac/10), byte('0' + frac%10)})
	if neg {
		return "-" + out
	}
	return out
}
