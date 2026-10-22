package recon

// An exception records HOW MANY ledger rows it was compared against and never
// WHICH, and that is why the queue stopped moving.
//
// The engine's design rule is that the matcher never picks one of several
// candidates (see the package comment): more than one plausible ledger row makes
// an 'ambiguous' exception for a human. That rule is right. What was missing is
// the other half of it — the human it defers to could not see the candidates
// either. `recon_exceptions.detail` says "10 candidate ledger rows within ±3
// days, none uniquely matchable on amount" and the row carries candidate_n = 10,
// but nothing anywhere could name those ten rows. So the only way to work an item
// was to reconstruct the residual join by hand against the live ledger.
//
// Measured 2026-10-15: of 24,100 exceptions, 266 have ever been resolved by a
// person, all on one day (2026-09-22) and all by one user. 12,363 more were closed
// in a single automated supersede. The remaining 11,471 sit open, 5,608 of them
// actionable. A queue nobody can see the evidence for is not a queue.
//
// This file re-derives the candidate set from the SAME Residual predicate the
// engine classified the exception with, so what an officer reads is what the
// matcher saw, not a second opinion. The mirroring is asserted by
// TestCandidatesMatchStoredCount, which fails if a spec's Residual changes without
// this file following it: the derived count must equal the stored candidate_n.
// Validated over 300 exceptions per pair at 300/300 before this shipped.
//
// NOTHING HERE RESOLVES ANYTHING. It reports evidence and stops, for a reason that
// is measurable rather than cautious: where several candidates look identical, the
// ledger has 1,642 key groups whose copies share one recorded balance (a duplicated
// record) and 8 whose balances differ (two real postings). The second kind is rare
// and real, so an automatic rule that closed the first would silently write off
// money in the second. The officer gets the balance evidence and makes the call.

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/o3c/workspace/core"
)

// Candidate is one ledger row the matcher weighed against a source row.
type Candidate struct {
	LedgerKey  string `json:"ledger_key"`
	TxnDate    string `json:"txn_date"`
	AmountKobo int64  `json:"amount_kobo"`
	// DeltaKobo is candidate minus source: negative means the ledger holds less.
	DeltaKobo int64 `json:"delta_kobo"`
	// KeyHit means the pair's anchor agrees — trace for the card book, STAN for
	// Interswitch. It is what separates "the same transaction, wrong amount" from
	// "a different transaction that happens to be nearby".
	KeyHit    bool   `json:"key_hit"`
	Exact     bool   `json:"exact"`
	Account   string `json:"account"`
	Narrative string `json:"narrative"`
	// Balance is the recorded running balance, blank where the ledger never
	// captured one. It is the evidence that decides a duplicate: copies sharing one
	// balance are one posting recorded twice, differing balances are two postings.
	Balance string `json:"balance"`
	// Twins counts candidates in this set indistinguishable from this one on
	// account, date, amount and narration — including itself, so 1 means unique.
	Twins int `json:"twins"`
	// Contested means another SOURCE row claims this same ledger row. That is the
	// other half of the 1:1 rule and the half nothing could show: applyTier
	// requires one candidate for the source row AND that row claimed by one source
	// row, so a lone exact candidate can still be refused.
	Contested bool `json:"contested"`
}

// Rival is another source row competing for the same ledger row.
//
// It exists because the obvious reading of a single exact candidate — "that is
// the match, the matcher was being timid" — is often wrong. Interswitch publishes
// one transaction under more than one report family, so STAN 132681 for 800,000
// on 2025-01-20 arrives as both WEB|DR and IPG, and the engine refuses the pair
// rather than crediting the ledger row twice. Naming the rival turns an
// unexplainable refusal into a two-line instruction: match one, mark the other a
// duplicate of it.
type Rival struct {
	LedgerKey  string `json:"ledger_key"`
	SourceKey  string `json:"source_key"`
	SourceRef  string `json:"source_ref"`
	TxnDate    string `json:"txn_date"`
	AmountKobo int64  `json:"amount_kobo"`
	// ExceptionID is the rival's own exception where it has one, so the officer can
	// close both sides from one screen. Zero means the rival matched cleanly
	// elsewhere or was never an exception.
	ExceptionID int64  `json:"exception_id"`
	Status      string `json:"status"`
}

// CandidateSet is everything known about one exception's evidence.
type CandidateSet struct {
	ExceptionID int64       `json:"exception_id"`
	Source      string      `json:"source"`
	Reason      string      `json:"reason"`
	SourceRef   string      `json:"source_ref"`
	SourceKey   string      `json:"source_key"`
	TxnDate     string      `json:"txn_date"`
	AmountKobo  int64       `json:"amount_kobo"`
	StoredN     int         `json:"stored_n"`
	DerivedN    int         `json:"derived_n"`
	Ledger      string      `json:"ledger"`
	Anchor      string      `json:"anchor"`
	Candidates  []Candidate `json:"candidates"`
	Rivals      []Rival     `json:"rivals"`
	// Complete is false when the derived set no longer agrees with the count the
	// run recorded. The ledger moves under a stored exception — a row can be
	// loaded, corrected or removed after the run — so the UI must be able to say
	// "this is today's evidence, and it is not what the matcher saw".
	Complete bool   `json:"complete"`
	Verdict  string `json:"verdict"`
}

// candidateSpec is the per-pair half of this file that has to track the engine's
// pairSpec. Each query takes $1 = the exception's source_key and must return the
// residual candidate set in the officer's reading order: anchor hits first, then
// closest on amount, then by date.
type candidateSpec struct {
	Ledger string
	Anchor string
	SQL    string
	// RivalSQL finds the other source rows claiming this row's EXACT candidates —
	// the contention applyTier refuses on. It takes $1 = source_key and returns
	// (ledger_key, source_key, source_ref, txn_date, amount_kobo, exception_id,
	// status), at most one row per (ledger row, rival).
	RivalSQL string
}

// ── CCS master ↔ card account book ────────────────────────────────────────────
//
// Mirrors ccsCardLedgerSpec.Residual: same CIF, within ±3 days. app.transactions
// .amount is in NAIRA — the documented exception to the kobo rule — hence the *100
// on every comparison, exactly as the tiers do it.
var ccsCandidateSpec = candidateSpec{
	Ledger: "app.transactions (card account book)",
	Anchor: "trace",
	SQL: `
		WITH s AS (
		    SELECT c.cif, c.trace_num, c.txn_date, c.amount_kobo
		      FROM ccs_transactions c
		     WHERE c.id::text = $1
		)
		SELECT t.txn_id,
		       t.txn_date::text,
		       ROUND(ABS(t.amount) * 100)::bigint,
		       ROUND(ABS(t.amount) * 100)::bigint - s.amount_kobo,
		       (t.trace = s.trace_num),
		       COALESCE(t.account_no, ''),
		       COALESCE(NULLIF(t.description, ''), COALESCE(t.merchant_name, '')),
		       COALESCE(t.account_balance::text, '')
		  FROM s
		  JOIN app.transactions t
		    ON t.cif = s.cif
		   AND t.txn_date BETWEEN s.txn_date - 3 AND s.txn_date + 3
		 ORDER BY (t.trace = s.trace_num) DESC,
		          ABS(ROUND(ABS(t.amount) * 100) - s.amount_kobo),
		          t.txn_date`,
	// A rival is another CCS row on the same CIF, trace and amount near the same
	// day — which is to say the master itself recorded the transaction twice.
	RivalSQL: `
		WITH s AS (
		    SELECT c.id::text AS source_key, c.cif, c.trace_num, c.txn_date, c.amount_kobo
		      FROM ccs_transactions c
		     WHERE c.id::text = $1
		), cand AS (
		    SELECT t.txn_id, t.txn_date, ROUND(ABS(t.amount) * 100)::bigint AS amount_kobo
		      FROM s
		      JOIN app.transactions t
		        ON t.cif = s.cif
		       AND t.trace = s.trace_num
		       AND ROUND(ABS(t.amount) * 100) = s.amount_kobo
		       AND t.txn_date BETWEEN s.txn_date - 3 AND s.txn_date + 3
		)
		SELECT DISTINCT ON (cand.txn_id, r.id)
		       cand.txn_id,
		       r.id::text,
		       r.trace_num,
		       r.txn_date::text,
		       r.amount_kobo,
		       COALESCE(e.id, 0),
		       COALESCE(e.status, '')
		  FROM cand
		  CROSS JOIN s
		  JOIN ccs_transactions r
		    ON r.cif = s.cif
		   AND r.trace_num = s.trace_num
		   AND r.amount_kobo = cand.amount_kobo
		   AND cand.txn_date BETWEEN r.txn_date - 3 AND r.txn_date + 3
		  LEFT JOIN recon_exceptions e
		    ON e.source = 'ccs' AND e.source_key = r.id::text
		 WHERE r.id::text <> s.source_key
		 ORDER BY cand.txn_id, r.id, (e.status = 'open') DESC NULLS LAST, e.id DESC`,
}

// ── Interswitch settlement feed ↔ CCS master ──────────────────────────────────
//
// Mirrors interswitchCCSSpec.Residual: same STAN or same card, within ±3 days of
// local_datetime — the transaction's own date, never settlement_date, for the
// reason measured in the engine's comment. ccs_transactions has no running
// balance, so the duplicate evidence this pair can offer is narration and account.
var interswitchCandidateSpec = candidateSpec{
	Ledger: "ccs_transactions (CCS master)",
	Anchor: "STAN",
	SQL: `
		WITH s AS (
		    SELECT LPAD(i.stan, 6, '0')              AS stan,
		           i.pan,
		           i.local_datetime::date            AS txn_date,
		           ROUND(ABS(i.gross_kobo))::bigint  AS amount_kobo
		      FROM interswitch_transactions i
		     WHERE i.report_family || '|' || i.session || '|' ||
		           i.settlement_date::text || '|' || i.rrn = $1
		)
		SELECT c.id::text,
		       c.txn_date::text,
		       ABS(c.amount_kobo),
		       ABS(c.amount_kobo) - s.amount_kobo,
		       (LPAD(c.trace_num, 6, '0') = s.stan),
		       COALESCE(c.account_no, ''),
		       COALESCE(NULLIF(c.description, ''), COALESCE(c.merchant_name, '')),
		       ''
		  FROM s
		  JOIN ccs_transactions c
		    ON (LPAD(c.trace_num, 6, '0') = s.stan
		        OR (c.card_num = s.pan AND s.pan <> ''))
		   AND c.txn_date BETWEEN s.txn_date - 3 AND s.txn_date + 3
		 ORDER BY (LPAD(c.trace_num, 6, '0') = s.stan) DESC,
		          ABS(ABS(c.amount_kobo) - s.amount_kobo),
		          c.txn_date`,
	// A rival here is the same STAN and amount arriving under another report
	// family — the feed publishing one transaction twice, which is the commonest
	// reason an Interswitch item with an obvious match was still refused.
	RivalSQL: `
		WITH s AS (
		    SELECT i.report_family || '|' || i.session || '|' ||
		           i.settlement_date::text || '|' || i.rrn       AS source_key,
		           LPAD(i.stan, 6, '0')                          AS stan,
		           i.local_datetime::date                        AS txn_date,
		           ROUND(ABS(i.gross_kobo))::bigint              AS amount_kobo
		      FROM interswitch_transactions i
		     WHERE i.report_family || '|' || i.session || '|' ||
		           i.settlement_date::text || '|' || i.rrn = $1
		), cand AS (
		    SELECT c.id, c.txn_date, ABS(c.amount_kobo) AS amount_kobo,
		           LPAD(c.trace_num, 6, '0') AS stan
		      FROM s
		      JOIN ccs_transactions c
		        ON LPAD(c.trace_num, 6, '0') = s.stan
		       AND ABS(c.amount_kobo) = s.amount_kobo
		       AND c.txn_date BETWEEN s.txn_date - 3 AND s.txn_date + 3
		)
		SELECT DISTINCT ON (cand.id, r.report_family, r.session, r.settlement_date, r.rrn)
		       cand.id::text,
		       r.report_family || '|' || r.session || '|' ||
		       r.settlement_date::text || '|' || r.rrn,
		       r.rrn,
		       r.local_datetime::date::text,
		       ROUND(ABS(r.gross_kobo))::bigint,
		       COALESCE(e.id, 0),
		       COALESCE(e.status, '')
		  FROM cand
		  CROSS JOIN s
		  JOIN interswitch_transactions r
		    ON LPAD(r.stan, 6, '0') = cand.stan
		   AND ROUND(ABS(r.gross_kobo))::bigint = cand.amount_kobo
		   AND cand.txn_date BETWEEN r.local_datetime::date - 3 AND r.local_datetime::date + 3
		  LEFT JOIN recon_exceptions e
		    ON e.source = 'interswitch'
		   AND e.source_key = r.report_family || '|' || r.session || '|' ||
		                      r.settlement_date::text || '|' || r.rrn
		 WHERE (r.report_family || '|' || r.session || '|' ||
		        r.settlement_date::text || '|' || r.rrn) <> s.source_key
		 ORDER BY cand.id, r.report_family, r.session, r.settlement_date, r.rrn,
		          (e.status = 'open') DESC NULLS LAST, e.id DESC`,
}

func candidateSpecFor(source string) (candidateSpec, bool) {
	switch source {
	case "ccs":
		return ccsCandidateSpec, true
	case "interswitch":
		return interswitchCandidateSpec, true
	}
	return candidateSpec{}, false
}

// Candidates loads the exception and re-derives its evidence.
//
// A missing exception is an error; a source whose pair has no spec is not — it
// returns a set that says so, because a reader asking for evidence deserves the
// reason there is none rather than a 500.
func Candidates(ctx context.Context, db *core.DB, exceptionID int64) (CandidateSet, error) {
	var set CandidateSet
	var ref, key sql.NullString

	if err := db.PG.QueryRowContext(ctx, `
		SELECT id, source, reason, COALESCE(source_ref,''), COALESCE(source_key,''),
		       txn_date::text, amount_kobo, COALESCE(candidate_n, 0)
		  FROM recon_exceptions
		 WHERE id = $1`, exceptionID).Scan(
		&set.ExceptionID, &set.Source, &set.Reason, &ref, &key,
		&set.TxnDate, &set.AmountKobo, &set.StoredN); err != nil {
		if err == sql.ErrNoRows {
			return set, fmt.Errorf("recon: exception %d not found", exceptionID)
		}
		return set, fmt.Errorf("recon: load exception %d: %w", exceptionID, err)
	}
	set.SourceRef, set.SourceKey = ref.String, key.String
	set.Candidates = []Candidate{}

	spec, ok := candidateSpecFor(set.Source)
	if !ok {
		set.Verdict = "No candidate rule is registered for source " + set.Source +
			", so the evidence behind this exception cannot be shown."
		return set, nil
	}
	set.Ledger, set.Anchor = spec.Ledger, spec.Anchor

	rows, err := db.PG.QueryContext(ctx, spec.SQL, set.SourceKey)
	if err != nil {
		return set, fmt.Errorf("recon: candidates for %d: %w", exceptionID, err)
	}
	defer rows.Close() //nolint:errcheck

	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.LedgerKey, &c.TxnDate, &c.AmountKobo, &c.DeltaKobo,
			&c.KeyHit, &c.Account, &c.Narrative, &c.Balance); err != nil {
			return set, fmt.Errorf("recon: scan candidate: %w", err)
		}
		c.Exact = c.KeyHit && c.DeltaKobo == 0
		set.Candidates = append(set.Candidates, c)
	}
	if err := rows.Err(); err != nil {
		return set, fmt.Errorf("recon: candidates for %d: %w", exceptionID, err)
	}

	set.DerivedN = len(set.Candidates)
	set.Complete = set.DerivedN == set.StoredN
	markTwins(set.Candidates)

	if err := loadRivals(ctx, db, spec, &set); err != nil {
		return set, err
	}
	set.Verdict = verdict(&set)
	return set, nil
}

// loadRivals fills in the source-side contention and flags the candidates it
// falls on. A pair with no rival rule simply reports none.
func loadRivals(ctx context.Context, db *core.DB, spec candidateSpec, set *CandidateSet) error {
	set.Rivals = []Rival{}
	if spec.RivalSQL == "" {
		return nil
	}

	rows, err := db.PG.QueryContext(ctx, spec.RivalSQL, set.SourceKey)
	if err != nil {
		return fmt.Errorf("recon: rivals for %d: %w", set.ExceptionID, err)
	}
	defer rows.Close() //nolint:errcheck

	contested := map[string]bool{}
	for rows.Next() {
		var v Rival
		if err := rows.Scan(&v.LedgerKey, &v.SourceKey, &v.SourceRef, &v.TxnDate,
			&v.AmountKobo, &v.ExceptionID, &v.Status); err != nil {
			return fmt.Errorf("recon: scan rival: %w", err)
		}
		set.Rivals = append(set.Rivals, v)
		contested[v.LedgerKey] = true
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("recon: rivals for %d: %w", set.ExceptionID, err)
	}

	for i := range set.Candidates {
		set.Candidates[i].Contested = contested[set.Candidates[i].LedgerKey]
	}
	return nil
}

// markTwins counts candidates that are indistinguishable from one another, which
// is the shape that makes an ambiguous break decidable: the matcher refused not
// because the right row is unclear but because the ledger holds the same row more
// than once.
func markTwins(cs []Candidate) {
	type sig struct {
		acct, date, narr string
		amt              int64
	}
	n := map[sig]int{}
	for _, c := range cs {
		n[sig{c.Account, c.TxnDate, c.Narrative, c.AmountKobo}]++
	}
	for i := range cs {
		cs[i].Twins = n[sig{cs[i].Account, cs[i].TxnDate, cs[i].Narrative, cs[i].AmountKobo}]
	}
}

// verdict says what the evidence shows, in the words an officer needs to act —
// and never more than the evidence supports. Candidates that look identical are
// reported as looking identical, because 8 measured key groups in the card book
// carry differing balances and are therefore two real postings rather than one
// recorded twice.
func verdict(s *CandidateSet) string {
	if s.DerivedN == 0 {
		return "The ledger holds no row for this customer within ±3 days. " +
			"Nothing here can be matched: this is a genuine break, a late " +
			"posting, or a transaction the ledger never received."
	}

	exact, twinned := 0, 0
	for _, c := range s.Candidates {
		if c.Exact {
			exact++
			if c.Twins > 1 {
				twinned++
			}
		}
	}

	switch {
	// Contention is named first, because it is the only explanation that accounts
	// for a refusal an officer would otherwise read as timidity: the obvious match
	// is obvious, and it is claimed twice.
	case len(s.Rivals) > 0:
		return fmt.Sprintf("Another source row claims the same ledger row — %d of them. "+
			"The feed carries this transaction more than once, so matching it would "+
			"credit one ledger row to two settlements and the engine refused. Match "+
			"whichever source row is the real one and mark the rest duplicates of it.",
			len(s.Rivals))
	case exact == 1:
		return "One ledger row agrees on both amount and " + s.Anchor +
			". Nothing in this evidence explains the refusal, which usually means " +
			"that row was already paired under a stronger rule in the same run — " +
			"confirm it is not already matched before resolving."
	case twinned > 1:
		return fmt.Sprintf("%d ledger rows agree on amount and %s, and %d of them are "+
			"indistinguishable on account, date, amount and narration. The matcher "+
			"refused because it will not choose between identical rows. Check the "+
			"recorded balances below: copies sharing one balance are one posting "+
			"recorded twice, balances that differ are two real postings.",
			exact, s.Anchor, twinned)
	case exact > 1:
		return fmt.Sprintf("%d ledger rows agree on both amount and %s but differ in "+
			"other respects. Pick the one that belongs to this transaction.", exact, s.Anchor)
	case s.Reason == "amount_mismatch":
		return "The " + s.Anchor + " resolves to a ledger row whose amount differs. " +
			"The delta below is the ledger minus the source: a fee, a partial " +
			"settlement, or a posting error."
	default:
		return fmt.Sprintf("%d nearby ledger rows, none agreeing on both amount and %s. "+
			"Read the deltas: a small one is usually a fee, a large one is a "+
			"different transaction.", s.DerivedN, s.Anchor)
	}
}
