// Package recon reconciles a settlement SOURCE against a ledger COUNTERPARTY for
// a period, recording every pairing with the rule (tier) and confidence that
// produced it, and turning everything else into an owned, aging exception.
//
// Design rule: the matcher never picks one of several candidates. Matching is
// strictly 1:1 — a source row with more than one candidate, or a ledger row
// claimed by more than one source row, becomes an 'ambiguous' exception for a
// human. A plausible-looking wrong pairing is worse than an unmatched row, because
// it silently understates the exception queue and can never be discovered again.
//
// WHAT O3 ACTUALLY SETTLES. CCS (the O3 card management system, Report 620
// EODTXN) is the master ledger. Interswitch and Paystack are payment PROVIDERS
// whose activity has to roll up to it. That gives three reconcilable pairs, two of
// which live here:
//
//	CCSCardLedger  — the CCS master against O3's own card account book.
//	InterswitchCCS — the uploaded Interswitch settlement feed against the master.
//
// Only the first existed before, and it was registered under the name
// "interswitch↔sage_ledger", which described neither side: it staged its source
// from app.interswitch_txns, a back-compat VIEW that migration 126 pointed at
// ccs_transactions precisely because that table "never held Interswitch data". So
// the engine reconciled CCS against the card book while reporting that it had
// reconciled Interswitch — and the real Interswitch settlement feed, every leg of
// it, had never been reconciled against anything. Both pairs are now registered
// under honest names, and the old name is accepted as an alias (see specFor).
package recon

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"github.com/o3c/workspace/core"
)

// Pair identifies a reconciliation: one source against one counterparty.
type Pair struct {
	Source       string
	Counterparty string
}

func (p Pair) String() string { return p.Source + "↔" + p.Counterparty }

var (
	// CCSCardLedger matches the CCS master ledger against O3's card account book
	// (app.transactions). This is the pair that shipped as "interswitch↔sage_ledger".
	CCSCardLedger = Pair{Source: "ccs", Counterparty: "card_ledger"}

	// InterswitchCCS matches the uploaded Interswitch settlement feed against the
	// CCS master. This is the pair the module always claimed to run and never did.
	InterswitchCCS = Pair{Source: "interswitch", Counterparty: "ccs"}

	// InterswitchSage is the name CCSCardLedger shipped under. Deprecated: it
	// names neither of the two books it actually compares. Accepted as an alias so
	// existing callers and the stored runs keep working.
	InterswitchSage = Pair{Source: "interswitch", Counterparty: "sage_ledger"}
)

// tier is one matching rule. Rules run strongest-first; each only sees rows the
// previous tiers left unmatched.
type tier struct {
	Name       string
	Confidence float64
	// Predicate joins source alias s to ledger alias c. It must be safe to
	// interpolate — these are compile-time constants, never user input.
	Predicate string
}

// pairSpec is everything the engine needs to reconcile one pair. Staging SQL and
// tiers are declared together because the tier predicates reference the columns
// the staging query produces; nothing else in the engine knows those names.
type pairSpec struct {
	Pair Pair

	// SourceSQL stages the source rows. It MUST produce source_key (unique within
	// the run), source_ref (what an officer should see), txn_date, amount_kobo and
	// a FALSE matched flag, plus whatever extra columns its tiers join on. It takes
	// $1 = period from, $2 = period to.
	SourceSQL string

	// Ledger is the counterparty relation, aliased c by the engine, and LedgerKey
	// the expression yielding its row identity for recon_matches.counterparty_key.
	Ledger    string
	LedgerKey string

	Tiers []tier

	// Residual counts plausible ledger rows for a source row that survived every
	// tier, so an exception can say "5 possible matches" rather than "unmatched".
	Residual string

	// LedgerDate is the ledger's transaction-date column. It drives the coverage
	// check: whether the ledger holds ANY row in a source row's date window,
	// ignoring every key. That separates "the master has nothing for this day"
	// from "the master has data but no counterpart" — see the master_no_data
	// reason below, which is the difference between an exception an officer can
	// work and one only a data feed can fix.
	//
	// Coverage is deliberately NOT a correlated subquery. Asked per source row it
	// is a date-range scan with no key to seek on — for the card book that is
	// 1.02M rows revisited for each of ~10k unmatched rows. The engine instead
	// collects the distinct dates the ledger covers once, up front, and tests
	// against that.
	LedgerDate string
}

// ── CCS master ↔ card account book ────────────────────────────────────────────

// CIF is the anchor on every tier: trace alone collides badly in this ledger
// (1.02M rows share only 505k distinct traces), so trace is used to *strengthen*
// a CIF match, never as a key on its own.
//
// app.transactions.amount is in NAIRA — the documented exception to the kobo rule
// that holds everywhere else in this schema — hence the *100 on every comparison.
var ccsCardLedgerSpec = pairSpec{
	Pair:      CCSCardLedger,
	Ledger:    "app.transactions",
	LedgerKey: "c.txn_id",
	SourceSQL: `
		SELECT c.id::text   AS source_key,
		       c.trace_num  AS source_ref,
		       c.trace_num,
		       c.cif,
		       c.txn_date,
		       c.amount_kobo,
		       FALSE        AS matched
		FROM ccs_transactions c
		WHERE c.txn_date BETWEEN $1::date AND $2::date
		  AND c.cif <> ''`,
	Tiers: []tier{
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
	},
	Residual: `c.cif = s.cif
		AND c.txn_date BETWEEN s.txn_date - 3 AND s.txn_date + 3`,
	LedgerDate: "txn_date",
}

// ── Interswitch settlement feed ↔ CCS master ──────────────────────────────────

// STAN is the anchor. Three measurements shaped these tiers, taken over the whole
// uploaded book (4,275 collapsed transactions):
//
// 1. THE DATE IS NOT THE SETTLEMENT DATE. Joining STAN + amount on
// settlement_date resolved ONE row of 4,275. Interswitch settles T+1: CCS
// txn_date = settlement_date - 1 in 2,680 of 2,747 matched rows. local_datetime
// is the transaction's own timestamp, and on its date the same join resolves
// 2,746. Every tier here therefore anchors on local_datetime::date, and a spec
// that reaches for settlement_date is reading the day the money moved between
// institutions, not the day the customer transacted.
//
// 2. THE AMOUNT CONFIRMS, IT DOES NOT DISCRIMINATE. Where a STAN resolves to a
// CCS row within ±3 days, the amount agrees essentially always — matching on
// STAN alone (2,747), on gross_kobo (2,747) and on amount_kobo (2,747) return the
// same rows. So amount is kept in the top tiers as corroboration, and a STAN that
// resolves to exactly one row whose amount differs is surfaced as amount_mismatch
// rather than quietly matched.
//
// 3. PAN IS A WEAK SECOND ANCHOR, WORTH HAVING. Interswitch pan and
// ccs_transactions.card_num share a masking format and agree for 4,075 of 4,275
// rows, but a PAN tier adds only 31 matches over the STAN tiers. It earns its
// place as a lower tier for rows whose STAN never reached CCS, not as a peer.
//
// What those tiers CANNOT fix is coverage. Where both feeds hold data the match
// rate is 97.5% (2025-01) and 98.3% (2025-02); the apparent 35% shortfall across
// the whole book is that CCS ends 2025-12-31 while the Interswitch uploads run
// into 2026-07. Those rows become master_no_data, not an officer's queue.
var interswitchCCSSpec = pairSpec{
	Pair:      InterswitchCCS,
	Ledger:    "ccs_transactions",
	LedgerKey: "c.id::text",
	// interswitch_transactions is the view that collapses interswitch_legs to one
	// row per transaction. Reconciling the legs themselves would double- and
	// triple-count: a single transaction carries an Amount_Payable leg plus a fee
	// leg per party. The view's grain — and so the source key — is
	// (report_family, session, settlement_date, rrn).
	//
	// local_datetime is NULL for 23 rows; they are excluded rather than anchored on
	// a date the feed never stated.
	SourceSQL: `
		SELECT i.report_family || '|' || i.session || '|' ||
		       i.settlement_date::text || '|' || i.rrn        AS source_key,
		       i.rrn                                         AS source_ref,
		       LPAD(i.stan, 6, '0')                           AS stan,
		       i.pan,
		       i.local_datetime::date                         AS txn_date,
		       ROUND(ABS(i.gross_kobo))::bigint               AS amount_kobo,
		       i.settlement_date,
		       FALSE                                          AS matched
		FROM interswitch_transactions i
		WHERE i.local_datetime::date BETWEEN $1::date AND $2::date
		  AND i.stan <> ''`,
	Tiers: []tier{
		{
			Name:       "stan+amount+date",
			Confidence: 0.99,
			Predicate: `LPAD(c.trace_num,6,'0') = s.stan
			            AND ABS(c.amount_kobo) = s.amount_kobo
			            AND c.txn_date = s.txn_date`,
		},
		{
			Name:       "stan+amount±3d",
			Confidence: 0.95,
			Predicate: `LPAD(c.trace_num,6,'0') = s.stan
			            AND ABS(c.amount_kobo) = s.amount_kobo
			            AND c.txn_date BETWEEN s.txn_date - 3 AND s.txn_date + 3`,
		},
		{
			Name:       "pan+amount+date",
			Confidence: 0.85,
			Predicate: `c.card_num = s.pan AND s.pan <> ''
			            AND ABS(c.amount_kobo) = s.amount_kobo
			            AND c.txn_date = s.txn_date`,
		},
		{
			Name:       "pan+amount±3d",
			Confidence: 0.70,
			Predicate: `c.card_num = s.pan AND s.pan <> ''
			            AND ABS(c.amount_kobo) = s.amount_kobo
			            AND c.txn_date BETWEEN s.txn_date - 3 AND s.txn_date + 3`,
		},
	},
	// A residual candidate is the same STAN on a nearby day at any amount, or the
	// same card on a nearby day. That is the set an officer would actually look
	// through, so it is the set the exception should count.
	Residual: `(LPAD(c.trace_num,6,'0') = s.stan OR (c.card_num = s.pan AND s.pan <> ''))
		AND c.txn_date BETWEEN s.txn_date - 3 AND s.txn_date + 3`,
	LedgerDate: "txn_date",
}

// specFor resolves a pair to its spec, accepting the deprecated name the first
// pair shipped under. The alias resolves to the canonical spec, so a run started
// under the old name is RECORDED under the honest one — the point of the rename is
// that recon_runs stops asserting a reconciliation that never happened.
func specFor(p Pair) (pairSpec, bool) {
	if p == InterswitchSage {
		p = CCSCardLedger
	}
	switch p {
	case CCSCardLedger:
		return ccsCardLedgerSpec, true
	case InterswitchCCS:
		return interswitchCCSSpec, true
	}
	return pairSpec{}, false
}

// Pairs lists the reconciliations the engine can run, for callers that offer a
// choice. Order is the order to present them: master first, then providers.
func Pairs() []Pair { return []Pair{CCSCardLedger, InterswitchCCS} }

// Canonical resolves whatever name a caller used to the pair the engine records
// runs under, and reports whether it is a pair at all.
func Canonical(p Pair) (Pair, bool) {
	spec, ok := specFor(p)
	if !ok {
		return Pair{}, false
	}
	return spec.Pair, true
}

// StoredNames lists every pair name a run for p may already be recorded under.
//
// It exists for overlap detection. Re-running a pair over a period it has already
// covered duplicates the entire exception set, so a caller has to be able to find
// the earlier run — and the earlier run for CCSCardLedger is stored under the
// DEPRECATED name, because that is what the engine was registered as when it ran.
// Matching the canonical name alone would miss it and silently double the queue.
func StoredNames(p Pair) []Pair {
	canon, ok := Canonical(p)
	if !ok {
		return nil
	}
	if canon == CCSCardLedger {
		return []Pair{CCSCardLedger, InterswitchSage}
	}
	return []Pair{canon}
}

// Result summarises one run.
type Result struct {
	RunID              int64
	SourceN            int
	MatchedN           int
	AmbiguousN         int
	AmountMismatchN    int
	MasterNoDataN      int
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

	spec, ok := specFor(p)
	if !ok {
		return res, fmt.Errorf("recon: unsupported pair %s", p)
	}
	if to.Before(from) {
		return res, fmt.Errorf("recon: period_to is before period_from")
	}

	if err := db.PG.QueryRowContext(ctx, `
		INSERT INTO recon_runs (source, counterparty, period_from, period_to, kind, status, triggered_by)
		VALUES ($1,$2,$3,$4,$5,'running',$6) RETURNING id`,
		spec.Pair.Source, spec.Pair.Counterparty, from, to, kind, triggeredBy).Scan(&res.RunID); err != nil {
		return res, fmt.Errorf("recon: open run: %w", err)
	}

	err := runInTx(ctx, db, spec, from, to, &res)
	if err != nil {
		_, _ = db.PG.ExecContext(ctx,
			`UPDATE recon_runs SET finished_at=NOW(), status='error', error=$2 WHERE id=$1`,
			res.RunID, err.Error())
		slog.Error("recon run failed", "run_id", res.RunID, "pair", spec.Pair.String(), "err", err)
		return res, err
	}

	_, _ = db.PG.ExecContext(ctx, `
		UPDATE recon_runs SET finished_at=NOW(), status='ok',
		    source_n=$2, matched_n=$3, ambiguous_n=$4, unmatched_n=$5,
		    source_value_kobo=$6, matched_value_kobo=$7, unmatched_value_kobo=$8
		WHERE id=$1`,
		res.RunID, res.SourceN, res.MatchedN, res.AmbiguousN, res.UnmatchedN,
		res.SourceValueKobo, res.MatchedValueKobo, res.UnmatchedValueKobo)

	slog.Info("recon run ok", "run_id", res.RunID, "pair", spec.Pair.String(),
		"matched", res.MatchedN, "ambiguous", res.AmbiguousN,
		"master_no_data", res.MasterNoDataN, "unmatched", res.UnmatchedN)
	return res, nil
}

func runInTx(ctx context.Context, db *core.DB, spec pairSpec, from, to time.Time, res *Result) error {
	tx, err := db.PG.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("recon: begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// Source rows for the period, staged in a temp table with a matched flag.
	if _, err := tx.ExecContext(ctx,
		`CREATE TEMP TABLE recon_src ON COMMIT DROP AS `+spec.SourceSQL, from, to); err != nil {
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

	// The dates the counterparty ledger actually covers, collected once. Widened
	// by the ±3 day match window so a source row at the edge of the period is
	// judged against the same window the tiers used.
	if _, err := tx.ExecContext(ctx, `
		CREATE TEMP TABLE recon_cov ON COMMIT DROP AS
		SELECT DISTINCT `+spec.LedgerDate+` AS d
		FROM `+spec.Ledger+`
		WHERE `+spec.LedgerDate+` BETWEEN $1::date - 3 AND $2::date + 3`, from, to); err != nil {
		return fmt.Errorf("recon: stage coverage: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `CREATE INDEX ON recon_cov (d)`); err != nil {
		return fmt.Errorf("recon: index coverage: %w", err)
	}

	for _, t := range spec.Tiers {
		n, err := applyTier(ctx, tx, res.RunID, spec, t)
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
	// ledger held plausible candidates at all — and, first, by whether it held
	// ANY row for those days.
	//
	// master_no_data is the reason that stops this queue lying to the people who
	// work it. The previous classification only knew 'no_candidate', so a day the
	// master ledger simply does not cover produced exceptions indistinguishable
	// from a genuine settlement break: 10,527 of them accumulated, unworkable and
	// untriaged, and the module reported the total as money in dispute. A row whose
	// counterpart book is empty for that whole window is a feed to chase, not a
	// transaction to investigate, and it is now labelled as such.
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO recon_exceptions
		    (run_id, source, source_key, source_ref, txn_date, amount_kobo, reason, candidate_n, detail)
		SELECT $1, $2, s.source_key, s.source_ref, s.txn_date, s.amount_kobo,
		       CASE WHEN NOT s.covered THEN 'master_no_data'
		            WHEN cand.n = 0    THEN 'no_candidate'
		            -- Exactly one nearby ledger row that still did not match means
		            -- the amounts differ — a different investigation to "which of
		            -- these five is it?", so it gets its own reason code.
		            WHEN cand.n = 1    THEN 'amount_mismatch'
		            ELSE 'ambiguous' END,
		       COALESCE(cand.n, 0),
		       CASE WHEN NOT s.covered
		            THEN 'The counterparty ledger has no rows at all within ±3 days — a data gap, not a settlement break'
		            WHEN cand.n = 0
		            THEN 'No ledger row matching this transaction within ±3 days'
		            WHEN cand.n = 1
		            THEN 'One candidate ledger row within ±3 days, but the amount differs'
		            ELSE cand.n || ' candidate ledger rows within ±3 days, none uniquely matchable on amount'
		       END
		FROM (
		    SELECT s.*, EXISTS (
		        SELECT 1 FROM recon_cov v
		        WHERE v.d BETWEEN s.txn_date - 3 AND s.txn_date + 3
		    ) AS covered
		    FROM recon_src s WHERE s.matched = FALSE
		) s
		LEFT JOIN LATERAL (
		    SELECT COUNT(*) AS n FROM `+spec.Ledger+` c WHERE `+spec.Residual+`
		) cand ON TRUE`, res.RunID, spec.Pair.Source); err != nil {
		return fmt.Errorf("recon: exceptions: %w", err)
	}

	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FILTER (WHERE reason='ambiguous'),
		       COUNT(*) FILTER (WHERE reason='amount_mismatch'),
		       COUNT(*) FILTER (WHERE reason='master_no_data'),
		       COUNT(*),
		       COALESCE(SUM(ABS(amount_kobo)),0)
		FROM recon_exceptions WHERE run_id=$1`, res.RunID).
		Scan(&res.AmbiguousN, &res.AmountMismatchN, &res.MasterNoDataN,
			&res.UnmatchedN, &res.UnmatchedValueKobo); err != nil {
		return fmt.Errorf("recon: exception totals: %w", err)
	}

	return tx.Commit()
}

// applyTier matches the still-unmatched source rows under one rule, inserting only
// strict 1:1 pairings: exactly one ledger candidate for the source row, and that
// ledger row claimed by exactly one source row. Ledger rows already consumed by an
// earlier tier in this run are excluded.
func applyTier(ctx context.Context, tx *sql.Tx, runID int64, spec pairSpec, t tier) (int, error) {
	q := `
		WITH cand AS (
		    SELECT s.source_key,
		           s.txn_date,
		           s.amount_kobo,
		           ` + spec.LedgerKey + ` AS ledger_key,
		           COUNT(*) OVER (PARTITION BY s.source_key)        AS n_per_source,
		           COUNT(*) OVER (PARTITION BY ` + spec.LedgerKey + `) AS n_per_ledger
		    FROM recon_src s
		    JOIN ` + spec.Ledger + ` c ON ` + t.Predicate + `
		    WHERE s.matched = FALSE
		      AND NOT EXISTS (
		          SELECT 1 FROM recon_matches m
		          WHERE m.run_id = $1 AND m.counterparty_key = ` + spec.LedgerKey + `)
		), uniq AS (
		    SELECT * FROM cand WHERE n_per_source = 1 AND n_per_ledger = 1
		), ins AS (
		    INSERT INTO recon_matches
		        (run_id, source_key, counterparty_key, txn_date, amount_kobo, tier, confidence)
		    SELECT $1, source_key, ledger_key, txn_date, amount_kobo, $2, $3
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
