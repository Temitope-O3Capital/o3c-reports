// Package recon reconciles a settlement SOURCE against a ledger COUNTERPARTY for
// a period, recording every pairing with the rule (tier) and confidence that
// produced it, and turning everything else into an owned, aging exception.
//
// Design rule: the matcher never picks one of several candidates. Matching is
// strictly 1:1 — a source row with more than one candidate, or a ledger row
// claimed by more than one source row, becomes an 'ambiguous' exception for a
// human. A plausible-looking wrong pairing is worse than an unmatched row, because
// it silently understates the exception queue and can never be discovered again.
package recon

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"github.com/o3c/reports/core"
)

// Pair identifies a reconciliation: one source against one counterparty.
type Pair struct {
	Source       string
	Counterparty string
}

// InterswitchSage is the pair that is reconcilable today: the uploaded Interswitch
// EOD feed against the Sage ledger (app.transactions, exposed as app."Transactions").
var InterswitchSage = Pair{Source: "interswitch", Counterparty: "sage_ledger"}

// tier is one matching rule. Rules run strongest-first; each only sees rows the
// previous tiers left unmatched.
type tier struct {
	Name       string
	Confidence float64
	// Predicate joins source alias s to ledger alias c. It must be safe to
	// interpolate — these are compile-time constants, never user input.
	Predicate string
}

// Tiers for interswitch↔sage. CIF is the anchor on every tier: trace alone
// collides badly in this ledger (1.02M rows share only 505k distinct traces), so
// trace is used to *strengthen* a CIF match, never as a key on its own.
var interswitchTiers = []tier{
	{
		Name:       "cif+trace+amount+date",
		Confidence: 0.99,
		Predicate: `c.cif = s.cif AND c.trace = s.trace_num
		            AND ROUND(ABS(c.amount)*100) = ABS(s.amount_kobo)
		            AND c.txn_date = s.txn_date`,
	},
	{
		Name:       "cif+trace+amount",
		Confidence: 0.95,
		Predicate: `c.cif = s.cif AND c.trace = s.trace_num
		            AND ROUND(ABS(c.amount)*100) = ABS(s.amount_kobo)`,
	},
	{
		Name:       "cif+date+amount",
		Confidence: 0.90,
		Predicate: `c.cif = s.cif AND c.txn_date = s.txn_date
		            AND ROUND(ABS(c.amount)*100) = ABS(s.amount_kobo)`,
	},
	{
		Name:       "cif+amount±3d",
		Confidence: 0.75,
		Predicate: `c.cif = s.cif
		            AND ROUND(ABS(c.amount)*100) = ABS(s.amount_kobo)
		            AND c.txn_date BETWEEN s.txn_date - 3 AND s.txn_date + 3`,
	},
}

// residualPredicate is used only to count candidates for rows that survived every
// tier, so an exception can say "5 possible matches" rather than just "unmatched".
const residualPredicate = `c.cif = s.cif
	AND c.txn_date BETWEEN s.txn_date - 3 AND s.txn_date + 3`

// Result summarises one run.
type Result struct {
	RunID              int64
	SourceN            int
	MatchedN           int
	AmbiguousN         int
	AmountMismatchN    int
	UnmatchedN         int
	SourceValueKobo    int64
	MatchedValueKobo   int64
	UnmatchedValueKobo int64
	// PerTier is matched counts keyed by tier name, in tier order.
	PerTier map[string]int
}

// Run reconciles the pair over [from, to] and returns the outcome. Everything
// happens in one transaction: a run either lands complete or not at all.
func Run(ctx context.Context, db *core.DB, p Pair, from, to time.Time,
	kind string, triggeredBy sql.NullInt64) (Result, error) {

	var res Result
	res.PerTier = map[string]int{}

	if p != InterswitchSage {
		return res, fmt.Errorf("recon: unsupported pair %s↔%s", p.Source, p.Counterparty)
	}
	if to.Before(from) {
		return res, fmt.Errorf("recon: period_to is before period_from")
	}

	if err := db.PG.QueryRowContext(ctx, `
		INSERT INTO recon_runs (source, counterparty, period_from, period_to, kind, status, triggered_by)
		VALUES ($1,$2,$3,$4,$5,'running',$6) RETURNING id`,
		p.Source, p.Counterparty, from, to, kind, triggeredBy).Scan(&res.RunID); err != nil {
		return res, fmt.Errorf("recon: open run: %w", err)
	}

	err := runInTx(ctx, db, p, from, to, &res)
	if err != nil {
		_, _ = db.PG.ExecContext(ctx,
			`UPDATE recon_runs SET finished_at=NOW(), status='error', error=$2 WHERE id=$1`,
			res.RunID, err.Error())
		slog.Error("recon run failed", "run_id", res.RunID, "err", err)
		return res, err
	}

	_, _ = db.PG.ExecContext(ctx, `
		UPDATE recon_runs SET finished_at=NOW(), status='ok',
		    source_n=$2, matched_n=$3, ambiguous_n=$4, unmatched_n=$5,
		    source_value_kobo=$6, matched_value_kobo=$7, unmatched_value_kobo=$8
		WHERE id=$1`,
		res.RunID, res.SourceN, res.MatchedN, res.AmbiguousN, res.UnmatchedN,
		res.SourceValueKobo, res.MatchedValueKobo, res.UnmatchedValueKobo)

	slog.Info("recon run ok", "run_id", res.RunID, "source", p.Source,
		"matched", res.MatchedN, "ambiguous", res.AmbiguousN, "unmatched", res.UnmatchedN)
	return res, nil
}

func runInTx(ctx context.Context, db *core.DB, p Pair, from, to time.Time, res *Result) error {
	tx, err := db.PG.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("recon: begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// Source rows for the period, staged in a temp table with a matched flag.
	if _, err := tx.ExecContext(ctx, `
		CREATE TEMP TABLE recon_src ON COMMIT DROP AS
		SELECT i.id::text AS source_key,
		       i.trace_num,
		       i.cif,
		       i.txn_date,
		       i.amount_kobo,
		       FALSE AS matched
		FROM interswitch_txns i
		WHERE i.txn_date BETWEEN $1::date AND $2::date
		  AND i.cif <> ''`, from, to); err != nil {
		return fmt.Errorf("recon: stage source: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`CREATE INDEX ON recon_src (source_key); CREATE INDEX ON recon_src (matched)`); err != nil {
		return fmt.Errorf("recon: index source: %w", err)
	}

	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*), COALESCE(SUM(ABS(amount_kobo)),0) FROM recon_src`).
		Scan(&res.SourceN, &res.SourceValueKobo); err != nil {
		return fmt.Errorf("recon: source totals: %w", err)
	}

	for _, t := range interswitchTiers {
		n, err := applyTier(ctx, tx, res.RunID, t)
		if err != nil {
			return fmt.Errorf("recon: tier %s: %w", t.Name, err)
		}
		res.PerTier[t.Name] = n
		res.MatchedN += n
	}

	if err := tx.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(ABS(amount_kobo)),0) FROM recon_matches WHERE run_id=$1`,
		res.RunID).Scan(&res.MatchedValueKobo); err != nil {
		return fmt.Errorf("recon: matched value: %w", err)
	}

	// Everything still unmatched becomes an exception, classified by whether the
	// ledger held plausible candidates at all.
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO recon_exceptions
		    (run_id, source, source_key, source_ref, txn_date, amount_kobo, reason, candidate_n, detail)
		SELECT $1, $2, s.source_key, s.trace_num, s.txn_date, s.amount_kobo,
		       -- Exactly one nearby ledger row that still did not match means the
		       -- amounts differ — a different investigation to "which of these five
		       -- is it?", so it gets its own reason code.
		       CASE WHEN cand.n = 0 THEN 'no_candidate'
		            WHEN cand.n = 1 THEN 'amount_mismatch'
		            ELSE 'ambiguous' END,
		       COALESCE(cand.n, 0),
		       CASE WHEN cand.n = 0
		            THEN 'No ledger row for this customer within ±3 days'
		            WHEN cand.n = 1
		            THEN 'One ledger row for this customer within ±3 days, but the amount differs'
		            ELSE cand.n || ' ledger rows for this customer within ±3 days, none uniquely matchable on amount'
		       END
		FROM recon_src s
		LEFT JOIN LATERAL (
		    SELECT COUNT(*) AS n FROM app.transactions c WHERE `+residualPredicate+`
		) cand ON TRUE
		WHERE s.matched = FALSE`, res.RunID, InterswitchSage.Source); err != nil {
		return fmt.Errorf("recon: exceptions: %w", err)
	}

	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FILTER (WHERE reason='ambiguous'),
		       COUNT(*) FILTER (WHERE reason='amount_mismatch'),
		       COUNT(*),
		       COALESCE(SUM(ABS(amount_kobo)),0)
		FROM recon_exceptions WHERE run_id=$1`, res.RunID).
		Scan(&res.AmbiguousN, &res.AmountMismatchN, &res.UnmatchedN, &res.UnmatchedValueKobo); err != nil {
		return fmt.Errorf("recon: exception totals: %w", err)
	}

	return tx.Commit()
}

// applyTier matches the still-unmatched source rows under one rule, inserting only
// strict 1:1 pairings: exactly one ledger candidate for the source row, and that
// ledger row claimed by exactly one source row. Ledger rows already consumed by an
// earlier tier in this run are excluded.
func applyTier(ctx context.Context, tx *sql.Tx, runID int64, t tier) (int, error) {
	q := `
		WITH cand AS (
		    SELECT s.source_key,
		           s.txn_date,
		           s.amount_kobo,
		           c.txn_id,
		           COUNT(*) OVER (PARTITION BY s.source_key) AS n_per_source,
		           COUNT(*) OVER (PARTITION BY c.txn_id)     AS n_per_ledger
		    FROM recon_src s
		    JOIN app.transactions c ON ` + t.Predicate + `
		    WHERE s.matched = FALSE
		      AND NOT EXISTS (
		          SELECT 1 FROM recon_matches m
		          WHERE m.run_id = $1 AND m.counterparty_key = c.txn_id)
		), uniq AS (
		    SELECT * FROM cand WHERE n_per_source = 1 AND n_per_ledger = 1
		), ins AS (
		    INSERT INTO recon_matches
		        (run_id, source_key, counterparty_key, txn_date, amount_kobo, tier, confidence)
		    SELECT $1, source_key, txn_id, txn_date, amount_kobo, $2, $3
		    FROM uniq
		    ON CONFLICT DO NOTHING
		    RETURNING source_key
		)
		UPDATE recon_src s SET matched = TRUE
		FROM ins WHERE ins.source_key = s.source_key`

	r, err := tx.ExecContext(ctx, q, runID, t.Name, t.Confidence)
	if err != nil {
		return 0, err
	}
	n, _ := r.RowsAffected()
	return int(n), nil
}
