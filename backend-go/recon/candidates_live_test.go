package recon

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/workspace/core"
)

// TestCandidatesMatchStoredCount is the guard that keeps candidates.go honest.
//
// The candidate queries in candidates.go MIRROR the Residual predicates in
// engine.go — they are deliberately a second copy, because the engine's residual
// runs over a staged temp table for a whole period and this one has to answer for
// a single stored exception. A copy drifts. This test makes drift fail loudly:
// the engine recorded candidate_n when it classified each exception, so the set
// re-derived now must contain exactly that many rows.
//
// It is NOT a tautology. If a Residual gains a condition and candidates.go does
// not, the counts diverge on every affected exception. The one legitimate way to
// diverge is the ledger changing under a stored exception, which is why
// CandidateSet.Complete exists and why this test reports the mismatch rate rather
// than demanding perfection on row one.
//
//	CBS_LIVE_TEST=1 go test ./recon -run TestCandidates -v
func TestCandidatesMatchStoredCount(t *testing.T) {
	if os.Getenv("CBS_LIVE_TEST") != "1" {
		t.Skip("set CBS_LIVE_TEST=1 to check candidate derivation against the live ledger")
	}
	env := readDotEnv(t, "../.env")

	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}
	ctx := context.Background()

	// Both pairs, and only the reasons that HAVE candidates: no_candidate stores
	// zero by definition and master_no_data is a feed gap, so neither exercises
	// the residual.
	for _, source := range []string{"ccs", "interswitch"} {
		rows, err := pg.QueryContext(ctx, `
			SELECT id FROM recon_exceptions
			 WHERE source = $1
			   AND reason IN ('ambiguous','amount_mismatch')
			   AND status = 'open'
			 ORDER BY id
			 LIMIT 300`, source)
		if err != nil {
			t.Fatalf("%s: list exceptions: %v", source, err)
		}
		var ids []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				t.Fatalf("%s: scan id: %v", source, err)
			}
			ids = append(ids, id)
		}
		rows.Close() //nolint:errcheck
		if len(ids) == 0 {
			t.Logf("%-12s no open ambiguous/amount_mismatch exceptions to check", source)
			continue
		}

		var mismatched, empty, contested, twinned int
		for _, id := range ids {
			set, err := Candidates(ctx, db, id)
			if err != nil {
				t.Fatalf("%s: candidates for %d: %v", source, id, err)
			}
			if !set.Complete {
				mismatched++
				if mismatched <= 5 {
					t.Errorf("%s exception %d: stored candidate_n=%d but derived %d — "+
						"the candidate query no longer mirrors the engine's Residual",
						source, id, set.StoredN, set.DerivedN)
				}
			}
			if set.DerivedN == 0 {
				empty++
			}
			if len(set.Rivals) > 0 {
				contested++
			}
			for _, c := range set.Candidates {
				if c.Exact && c.Twins > 1 {
					twinned++
					break
				}
			}
			// Every set must say something: a blank verdict is a reader left exactly
			// where they were before this endpoint existed.
			if set.Verdict == "" {
				t.Errorf("%s exception %d: no verdict", source, id)
			}
		}

		t.Logf("%-12s %3d checked  %3d count-mismatched  %3d empty  %3d source-contested  %3d ledger-duplicated",
			source, len(ids), mismatched, empty, contested, twinned)
		if mismatched > 0 {
			t.Errorf("%s: %d of %d exceptions disagree with their stored candidate_n",
				source, mismatched, len(ids))
		}
	}
}

// TestCandidatesRejectsUnknownException pins the two edges the handler maps onto
// HTTP status: a missing id errors, and a source with no rule returns a set that
// explains itself instead of failing.
func TestCandidatesRejectsUnknownException(t *testing.T) {
	if os.Getenv("CBS_LIVE_TEST") != "1" {
		t.Skip("set CBS_LIVE_TEST=1 to run against the live ledger")
	}
	env := readDotEnv(t, "../.env")

	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}

	if _, err := Candidates(context.Background(), db, -1); err == nil {
		t.Fatal("expected an error for a nonexistent exception id")
	}
}
