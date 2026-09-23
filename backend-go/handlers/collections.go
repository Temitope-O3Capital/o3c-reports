package handlers

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// ── Identity namespaces ───────────────────────────────────────────────────────
//
// Three id namespaces exist in this system. All three look like a zero-padded
// 8-digit number and NONE of them are interchangeable:
//
//	app.parties.party_id      the workspace Customer ID — the only unifying key
//	app.customers.cif         a CARDS id (CCS/Sage). NOT a customer id.
//	cbs_*.cbs_customer_id     Udara360 only.
//
// 288 of the 295 Udara customer ids also exist as an app.customers.cif, and 94% of
// those are a DIFFERENT REAL PERSON. So writing a Udara id into a cards-namespace
// column — collection_assignments.cif_number/.account_cif, recovery_cases.cif_number/
// .account_cif — makes every later `JOIN app.customers c ON c.cif = account_cif`
// name a stranger, and that is how legal recovery cases came to be opened against the
// wrong person (RC-001066 pursued a card customer for N262,480,000 owed by a Udara
// borrower). app.cbs_links (entity_type='party') is the ONLY correct bridge.
//
// A row sourced from the Udara arm is therefore written as:
//
//	cif_number / account_cif = udaraCIFPrefix || cbs_customer_id. Namespaced text.
//	    Every cards CIF is exactly 8 characters and all digits, so 'UD-00000553'
//	    can never equal one: a stray cards join on it resolves to NULL — visibly
//	    nameless — instead of silently resolving to the wrong person. The failure
//	    mode is structural, not a rule someone has to remember.
//	party_id = app.cbs_links.entity_id, the real borrower. MANDATORY: a Udara row
//	    whose id has no link is refused and logged, never written.
//	data_source / product_type = 'udara' / 'loan'. The arm tag, carried on columns
//	    that already exist and already carry 'core' and 'manual'. No new column.
//
// Nothing here repairs rows written before this existed: those still hold a bare
// Udara id in a cards column and are identified by udaraCrossedRows below.
const udaraCIFPrefix = "UD-"

// isUdaraRow is the SQL predicate for "this row came from the Udara arm", over a table
// alias. Both the tag and the key prefix are tested, so a row is recognised whichever
// way it was stamped and a row carrying only one of the two is still caught.
func isUdaraRow(alias string) string {
	return "(COALESCE(" + alias + ".data_source,'') = 'udara' OR " + alias +
		".account_cif LIKE '" + udaraCIFPrefix + "%')"
}

// udaraKeySQL strips the namespace prefix back to the bare cbs_customer_id, and is NULL
// for any row that is not Udara-keyed — safe to feed straight into a cbs_* join.
func udaraKeySQL(alias string) string {
	return "(CASE WHEN " + alias + ".account_cif LIKE '" + udaraCIFPrefix + "%' THEN SUBSTRING(" +
		alias + ".account_cif FROM " + strconv.Itoa(len(udaraCIFPrefix)+1) + ") END)"
}

// cardsKeySQL is the mirror: the row's account_cif ONLY when the row really is a cards
// row, NULL otherwise. Every join to app.customers / app.accounts must go through this
// rather than through account_cif directly, so a Udara-sourced row can never resolve a
// cards customer.
func cardsKeySQL(alias string) string {
	return "(CASE WHEN NOT " + isUdaraRow(alias) + " THEN " + alias + ".account_cif END)"
}

// splitCIFKey takes an id as it arrives from a URL or a request body and says which
// namespace it is in. A 'UD-'-prefixed id is a Udara customer; anything else is treated
// as a cards CIF, which is what every existing caller means.
func splitCIFKey(key string) (cardsCIF, udaraCIF string) {
	if strings.HasPrefix(key, udaraCIFPrefix) {
		return "", strings.TrimPrefix(key, udaraCIFPrefix)
	}
	return key, ""
}

// armSplitDelinquency is the delinquency book re-projected so the two arms are never
// summed together. app.collections_delinquent_unified UNIONs a cards branch keyed by
// app.customers.cif with a Udara branch keyed by cbs_loans.cbs_customer_id, and the two
// key spaces collide — so `GROUP BY cif` over the raw view merges one person's card
// arrears with a different person's loan into a single total under a single name. Every
// statement that reads the book in order to WRITE an identity must read it through this.
//
//	arm       'udara' | 'cards'
//	raw_cif   the id in its own namespace (cbs_customer_id, or app.customers.cif)
//	key_cif   the id as it is safe to store: prefixed for Udara, unchanged for cards
//	party_id  the workspace Customer ID — cbs_links for Udara, app.customers for cards.
//	          NULL on a Udara row means the bridge is missing and the row MUST be refused.
//
// The uploaded loan book ('Loan (uploaded)') is excluded: that branch of the view is
// collection_assignments itself, so including it would have a statement read the column
// it is about to write.
const armSplitDelinquency = `
	WITH src AS (
		SELECT v.cif AS raw_cif,
		       CASE WHEN v.source = 'loan' AND v.product_name <> 'Loan (uploaded)'
		            THEN 'udara' ELSE 'cards' END AS arm,
		       v.dpd, v.outstanding_kobo, v.customer_name
		  FROM app.collections_delinquent_unified v
		 WHERE v.product_name <> 'Loan (uploaded)'
		   AND v.cif IS NOT NULL AND v.cif <> ''
	), agg AS (
		SELECT arm, raw_cif,
		       MAX(dpd)               AS dpd,
		       SUM(outstanding_kobo)  AS outstanding_kobo,
		       MAX(customer_name)     AS customer_name
		  FROM src GROUP BY arm, raw_cif
	), book AS (
		SELECT a.arm, a.raw_cif, a.dpd, a.outstanding_kobo, a.customer_name,
		       CASE WHEN a.arm = 'udara' THEN '` + udaraCIFPrefix + `' || a.raw_cif
		            ELSE a.raw_cif END AS key_cif,
		       CASE WHEN a.arm = 'udara' THEN lk.entity_id ELSE cu.party_id END AS party_id,
		       CASE WHEN a.arm = 'udara' THEN 'udara' ELSE 'core' END          AS data_source,
		       CASE WHEN a.arm = 'udara' THEN 'loan'  ELSE 'card' END          AS product_type
		  FROM agg a
		  LEFT JOIN app.cbs_links lk
		         ON a.arm = 'udara' AND lk.entity_type = 'party'
		        AND lk.cbs_customer_id = a.raw_cif
		  LEFT JOIN app.customers cu
		         ON a.arm = 'cards' AND cu.cif = a.raw_cif
	)`

// udaraIdentityResolved is the structural gate every write path applies to a `book` row:
// a Udara row may only be written when app.cbs_links actually names its borrower. A cards
// row needs no gate — a cards CIF is, by definition, the cards customer.
const udaraIdentityResolved = `(b.arm <> 'udara' OR b.party_id IS NOT NULL)`

// udaraCrossedRows is the SQL predicate for a row whose identity is CONTESTED: it is
// keyed in the cards namespace (no Udara tag, no 'UD-' prefix) on an id that is at this
// moment a delinquent Udara borrower. These are the rows the old, un-split statements
// produced — a card customer's name over a loan customer's debt, or the two summed
// together — and nothing in the row itself says which person it means.
//
// This code never repairs such a row; that is a data correction. Every write path
// refuses to touch one, and every refusal is logged at Error with the ids.
//
// The test is deliberately "carries live Udara delinquency" rather than "exists in
// app.cbs_links": 288 of the 295 Udara ids also exist as a cards CIF, so the wider test
// would freeze legitimate card assignments for hundreds of card customers who have
// merely been unlucky with their id. A cards row on a colliding id with no Udara debt
// behind it is not ambiguous, and is worked normally.
func udaraCrossedRows(alias string) string {
	return "(NOT " + isUdaraRow(alias) + " AND EXISTS (" +
		"SELECT 1 FROM app.collections_delinquent_unified v" +
		" WHERE v.source = 'loan' AND v.product_name <> 'Loan (uploaded)'" +
		"   AND v.cif = " + alias + ".account_cif))"
}

// debtorJoinsSQL / debtorNameSQL are the ONLY sanctioned way to put a debtor's name on a
// collection_assignments or recovery_cases row. The joins they emit are:
//
//	pty  app.parties via the row's own party_id — the unifying key, right for either arm
//	cbs  app.cbs_customers, reachable ONLY through udaraKeySQL, so it fires for a
//	     'UD-'-keyed row and for nothing else
//	c    app.customers, reachable ONLY through cardsKeySQL, so it CANNOT fire for a
//	     Udara-keyed row
//
// The last point is the whole fix on the read side. `LEFT JOIN app.customers c ON
// c.cif = rc.account_cif` looks harmless and is how a card customer's name, phone,
// address and card billing ended up on a loan customer's recovery case. Routing the join
// through cardsKeySQL makes that outcome impossible rather than forbidden: the join key
// is NULL for the wrong kind of row, so the row comes back nameless instead of wrong, and
// nameless is a bug someone reports.
func debtorJoinsSQL(alias string) string {
	return "LEFT JOIN app.parties pty ON pty.party_id = " + alias + ".party_id\n" +
		"\t\t\tLEFT JOIN app.cbs_customers cbs ON cbs.cbs_customer_id = " + udaraKeySQL(alias) + "\n" +
		"\t\t\tLEFT JOIN app.customers c ON c.cif = " + cardsKeySQL(alias)
}

// debtorNameSQL is the display name over those joins: the row's own stored name first
// (it was written from the arm's own source), then the party, then the arm's customer
// master, then the key itself. It never falls through to another namespace's name.
func debtorNameSQL(alias string) string {
	return "COALESCE(NULLIF(TRIM(" + alias + ".customer_name),''), NULLIF(TRIM(pty.full_name),''), " +
		"NULLIF(TRIM(cbs.name),''), NULLIF(TRIM(CONCAT(c.first_name,' ',c.last_name)),''), " +
		alias + ".account_cif)"
}

// udaraBorrowerFor is the same test as udaraCrossedRows for a single id that some caller
// is about to treat as a cards CIF. It returns the name of the Udara borrower that id
// really belongs to when the id is namespace-crossed — a bare (un-prefixed) id carrying
// live Udara delinquency — and "" when the id is safe to use as a cards CIF.
//
// A non-empty return is a REFUSAL, not a warning: acting on that id would name the card
// customer who shares it, who is somebody else.
func udaraBorrowerFor(ctx context.Context, db *core.DB, key string) (string, error) {
	if key == "" || strings.HasPrefix(key, udaraCIFPrefix) {
		return "", nil // already namespaced, or nothing to check
	}
	rows, err := db.PGQuery(ctx, `
		SELECT COALESCE(NULLIF(TRIM(cc.name),''), NULLIF(TRIM(p.full_name),''), $1) AS borrower
		  FROM app.collections_delinquent_unified v
		  LEFT JOIN app.cbs_customers cc ON cc.cbs_customer_id = v.cif
		  LEFT JOIN app.cbs_links lk ON lk.entity_type = 'party' AND lk.cbs_customer_id = v.cif
		  LEFT JOIN app.parties p ON p.party_id = lk.entity_id
		 WHERE v.cif = $1 AND v.source = 'loan' AND v.product_name <> 'Loan (uploaded)'
		 LIMIT 1`, key)
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", nil
	}
	return str(rows[0]["borrower"]), nil
}

// stampCaseIdentity fills in the identity columns of a recovery case that was created by
// the shared openRecoveryCase helper, which writes only the key into cif_number/account_cif
// and leaves party_id, data_source and product_type at their defaults ('core'/'card') —
// defaults that are a lie for a Udara row. Every case this package opens through that
// helper is stamped here instead, so the unifying key is present on the row from the
// moment it exists and a Udara case is never labelled as a card case.
//
// Best-effort by design: a failure here must not undo a case that has already been
// created, so it is logged rather than returned.
func stampCaseIdentity(ctx context.Context, db *core.DB, caseID int64, key string) {
	if caseID == 0 || key == "" {
		return
	}
	cardsCIF, udaraCIF := splitCIFKey(key)
	if _, err := db.PGExec(ctx, `
		UPDATE recovery_cases rc SET
			party_id     = COALESCE(rc.party_id, CASE WHEN $3 <> ''
			                   THEN (SELECT lk.entity_id FROM app.cbs_links lk
			                          WHERE lk.entity_type = 'party' AND lk.cbs_customer_id = $3 LIMIT 1)
			                   ELSE (SELECT c.party_id FROM app.customers c WHERE c.cif = $2 LIMIT 1) END),
			data_source  = CASE WHEN $3 <> '' THEN 'udara' ELSE rc.data_source END,
			product_type = CASE WHEN $3 <> '' THEN 'loan'  ELSE rc.product_type END,
			updated_at   = NOW()
		WHERE rc.id = $1`, caseID, cardsCIF, udaraCIF); err != nil {
		slog.Error("recovery case identity stamp failed — case left without a party_id",
			"case_id", caseID, "account_cif", key, "err", err)
	}
}

func RegisterCollections(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("collections"))
	head := core.RequirePages("collections_assign")
	payApprove := core.RequirePages("collections_payment_approve") // HOP/COO/CFO all hold this
	// /kpis stays unregistered, with /by-mode, /monthly-trend and /log. All four query a
	// "Collections Log" relation that does not exist in this database, and core/db.go
	// swallows a missing-relation error and returns an empty result with HTTP 200 — so
	// they answered every request with permanent zeros indistinguishable from real ones.
	// Nothing in the frontend calls them. A merge restored this one line; it is removed
	// again deliberately. Their handler functions are now unreferenced and should be
	// deleted in a follow-up pass.
	r.Get("/portfolio-kpis", collectionsPortfolioKPIs(db))
	r.Get("/dpd-trend", collectionsDPDTrend(db))
	r.Get("/by-agent", collectionsByAgent(db))
	r.Get("/roll-rate", collectionsRollRate(db))
	r.Get("/promise-kpis", collectionsPromiseKPIs(db))
	r.Get("/repayment-kpis", collectionsRepaymentKPIs(db))
	r.Get("/writeoff-kpis", collectionsWriteoffKPIs(db))

	// Portfolio + watchlist (all collections roles can read)
	r.Get("/portfolio", collectionsPortfolioAccounts(db))
	r.Get("/watchlist", collectionsWatchlistList(db))
	r.Post("/watchlist", collectionsWatchlistAdd(db))
	r.With(head).Put("/watchlist/{id}/resolve", collectionsWatchlistResolve(db))

	// Generate/refresh collection assignments from the unified delinquency book
	r.Post("/generate-assignments", collectionsGenerateAssignments(db))

	// Batch payment upload — posts straight to the GL with no per-row approval
	// step, so it needs the same elevated permission the single-payment approve
	// path requires, not just base collections access.
	r.With(payApprove).Post("/payments/batch", collectionsBatchPayment(db))

	// Credit activity log
	r.Get("/activity", creditActivityFeed(db))
	r.Get("/activity/cif/{cif}", creditActivityByCIF(db))

	// Call-centre calls for a customer (crosswalk), and a typed step-log both the
	// collections and recovery detail views write through.
	r.Get("/calls/cif/{cif}", collectionsCallsByCIF(db))
	r.Post("/step", collectionsLogStep(db))

	// Payment tiering (5 bands by principal paid) feeding the restructuring pipeline.
	r.Get("/payment-tiers", collectionsPaymentTiers(db))

	// Repayment schedule — facilities due this week (Sun–Sat) or already overdue.
	r.Get("/due-schedule", collectionsDueSchedule(db))

	// Account detail snapshot by CIF
	r.Get("/accounts/{cif}", collectionsAccountDetail(db))
	// Full credit dossier: every facility this person holds, each with its
	// repayment schedule, what has been paid against it, and the merged ledger.
	r.Get("/accounts/{cif}/credit", collectionsCreditDossier(db))
}

// runCollectionsGenerate seeds/refreshes the collection_assignments work
// book from the unified delinquency source (both card arrears and the Udara loan
// book, aggregated per CIF). Head-gated. It refreshes outstanding/dpd on existing
// active assignments and creates new ones for delinquent CIFs not yet being worked
// or already in recovery. This is the job that makes the module operational.
//
// WHY THE REFRESH IS SPLIT IN TWO. It used to stamp one CIF-level SUM taken from
// app.collections_delinquent_unified onto every active assignment of that customer,
// with no data_source/product_type filter. That is wrong twice over for the
// manually-uploaded loan book (data_source='manual', product_type='loan'):
//
//   - those rows are per-FACILITY, not per-customer, so a customer's total landed on
//     each of their facilities — including on a superseded (pre-restructure) row as
//     well as on its live successor, which migration 221 linked precisely so the two
//     would not be read as two live loans;
//   - the view's third branch (migration 207) READS
//     collection_assignments.outstanding_kobo for those same rows, so the refresh read
//     the column it was about to write and compounded the total on every run, silently
//     reversing migration 222's netting.
//
// FOLTI TECHNOLOGY is the worked example: ids 1755 (approved 156,000,000.00, live) and
// 1782 (approved 250,000,000.00, superseded_by_id=1755) both reached 279,580,000.00 —
// the sum of the pair — and the next run would have made it 559,160,000.00 each.
//
// So there are now two statements that cannot feed each other:
//
//	(1) the CIF-aggregate refresh, for card and Udara assignments only, computed from
//	    the card and core-banking branches of the view and never from the uploaded
//	    branch (which is this very table, read back through a view);
//	(2) a per-facility recompute for the uploaded loans, from the approved amount less
//	    the customer's receipts allocated oldest-disbursement-first — migration 222's
//	    own formula, reproduced here so that a refresh keeps its result true as
//	    payments arrive instead of undoing it. It reads target_amount_kobo /
//	    original_outstanding_kobo / collection_payments and no column it writes, so it
//	    is idempotent: running it twice gives the same answer, and it cannot inflate.
//
// WHY THE BOOK IS READ ARM-SPLIT. Both the refresh and the insert used to read the view
// with a bare `GROUP BY cif`. The view's Udara branch is keyed by cbs_loans.cbs_customer_id
// and its card branch by app.customers.cif — two different namespaces that collide on the
// same 8-digit strings — so that GROUP BY merged one person's card arrears with a
// different person's loan under one id and one name, and the INSERT then wrote that id
// into cif_number AND account_cif, both cards-namespace columns. Every read-back joined
// app.customers on it and named a stranger; escalateSevereToRecovery copied the id into
// recovery_cases and opened legal recovery against that stranger.
//
// So the book is now read through armSplitDelinquency: grouped by (arm, id), keyed
// 'UD-<cbs_customer_id>' for the Udara arm, and carrying the party_id that app.cbs_links
// resolves. A Udara row with no link is refused rather than written under a guess, and
// refusals are logged at Error with the ids. See the Identity namespaces block above.
//
// party_id IS now written — the old comment here said it should not be, on the grounds
// that a refresh must not infer identity. That reasoning was right about the old,
// merged-namespace statements: there the party genuinely was unknowable. Once each
// statement reads one arm at a time, the party is not inferred but looked up — cbs_links
// for Udara, app.customers for cards — and leaving the unifying key blank was what forced
// every downstream reader back onto the colliding CIF in the first place.
//
// runCollectionsGenerate is the whole of Generate Assignments, callable without an HTTP
// request so a scheduler can run it too.
//
// WHY THIS WAS EXTRACTED. This job does two different things:
//   1. REFRESH — recompute outstanding/dpd/name on rows already being worked.
//   2. CREATE  — add a row for a delinquent customer who has none.
// Only (2) has any human judgement in it, and even then the new row lands UNASSIGNED
// (agent_user_id NULL) for a head to distribute. (1) is pure arithmetic over the
// delinquency book.
//
// Leaving both behind a button meant neither happened: the credit activity log shows the
// endpoint had been invoked ZERO times, while 255 card assignments drifted from their live
// balances — N90,186,756.95 of absolute error, 141 overstated and 114 understated. A
// balance nobody recomputes is not "slightly stale", it is wrong in whichever direction
// the customer moved, and an agent calls on it.
//
// actorID is stamped into assigned_by (NOT NULL). The scheduled run passes the automation
// service account so an automated creation is never attributed to a real person.
func runCollectionsGenerate(ctx context.Context, db *core.DB, actorID int64) (int64, []string, error) {

	// DPD -> bucket, over whichever DPD expression the statement has to hand.
	bucketOf := func(dpd string) string {
		return `CASE WHEN ` + dpd + `<=30 THEN '1-30' WHEN ` + dpd + `<=60 THEN '31-60' WHEN ` + dpd + `<=90 THEN '61-90'
			WHEN ` + dpd + `<=180 THEN '91-180' WHEN ` + dpd + `<=360 THEN '181-360' ELSE '360+' END`
	}
	bucketExpr := bucketOf("b.dpd")

	// Rows whose outstanding legitimately comes from a CIF-level aggregate:
	// everything except the per-facility uploaded loan book.
	const aggregateRefreshable = `(COALESCE(ca.data_source,'') <> 'manual' OR COALESCE(ca.product_type,'') <> 'loan')`

	// (1) Refresh outstanding/bucket/name on card + Udara assignments still being
	// worked — each arm against its own aggregate, matched on its own key, so a
	// Udara borrower's loan balance can never be stamped onto the card customer who
	// happens to share the id. `(b.arm='udara') = isUdaraRow(ca)` is the arm
	// agreement: a Udara book row only ever updates a Udara-keyed assignment and a
	// card book row only ever updates a card-keyed one.
	if _, err := db.PGExec(ctx, armSplitDelinquency+`
		UPDATE collection_assignments ca SET
			outstanding_kobo = b.outstanding_kobo,
			dpd_bucket       = `+bucketExpr+`,
			customer_name    = COALESCE(NULLIF(ca.customer_name,''), b.customer_name),
			party_id         = COALESCE(b.party_id, ca.party_id),
			updated_at       = NOW()
		FROM book b
		WHERE ca.account_cif = b.key_cif AND ca.status = 'active'
		  AND (b.arm = 'udara') = `+isUdaraRow("ca")+`
		  AND `+udaraIdentityResolved+`
		  AND NOT `+udaraCrossedRows("ca")+`
		  AND `+aggregateRefreshable); err != nil {
		return 0, nil, fmt.Errorf("refresh card and Udara assignments: %w", err)
	}

	// (2) Refresh the uploaded loan book per facility, never per customer.
	//
	// The allocation set deliberately includes closed and superseded rows: receipts
	// are recorded against the CUSTOMER, not the facility, so a customer's pool is
	// run down their loans oldest-disbursement-first and a superseded row must claim
	// its own receipts rather than hand them to its successor. Only active rows are
	// written back — a superseded row is history and a closed one is settled, and
	// neither should be re-opened by a refresh. Where a customer holds several loans
	// this is an allocation, not a fact: the ledger cannot say which facility was
	// paid. Tagging payments with their facility is the real fix and is not
	// attempted here — the same caveat migration 222 and the Credit Portfolio
	// waterfall carry, and deliberately the same arithmetic, so the pages agree.
	//
	// dpd_bucket is re-derived from the maturity date on the basis the view uses,
	// and left alone where there is no maturity date to derive it from.
	uploadedDPD := `GREATEST(0, (CURRENT_DATE - ca.maturity_date))`
	if _, err := db.PGExec(ctx, `
		WITH cif_paid AS (
			-- 2026-09-21: no status filter here meant the refresh netted outstanding
			-- against money still inside the HOP -> COO -> CFO chain, writing an
			-- outstanding balance N106,393,555.56 too low across 11 uploaded loans
			-- (e.g. W000000000000041 would have been written down to N34,000,000
			-- when N57,000,000 is still owed). Only an approved receipt has posted
			-- to the GL, so only an approved receipt may reduce a balance. Filtering
			-- TO 'approved' also keeps a future 'rejected' row out permanently.
			-- Unapproved money is deliberately NOT written anywhere by this refresh:
			-- it is reported on the read surfaces as a separate "awaiting approval"
			-- figure and must never be baked into a stored balance.
			SELECT account_cif,
			       COALESCE(SUM(amount_kobo) FILTER (WHERE status = 'approved'), 0) AS paid
			  FROM collection_payments GROUP BY 1
		), al AS (
			SELECT a.id,
			       COALESCE(a.target_amount_kobo, a.original_outstanding_kobo, 0) AS approved,
			       COALESCE(p.paid, 0)                                            AS pool,
			       COALESCE(SUM(COALESCE(a.target_amount_kobo, a.original_outstanding_kobo, 0)) OVER (
			           PARTITION BY a.account_cif
			           ORDER BY a.disbursement_date ASC NULLS LAST, a.id ASC
			           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)      AS claimed_before
			  FROM collection_assignments a
			  LEFT JOIN cif_paid p ON p.account_cif = a.account_cif
			 WHERE a.data_source = 'manual' AND a.product_type = 'loan'
		), netted AS (
			SELECT id, GREATEST(approved - LEAST(approved, GREATEST(pool - claimed_before, 0)), 0) AS outstanding
			  FROM al
		)
		UPDATE collection_assignments ca SET
			outstanding_kobo = n.outstanding,
			dpd_bucket       = CASE WHEN ca.maturity_date IS NOT NULL
			                        THEN `+bucketOf(uploadedDPD)+`
			                        ELSE ca.dpd_bucket END,
			updated_at       = NOW()
		FROM netted n
		WHERE ca.id = n.id
		  AND ca.status = 'active'
		  AND ca.data_source = 'manual' AND ca.product_type = 'loan'
		  -- A row proven to mirror a Udara facility is NOT netted from the spreadsheet:
		  -- statement (2b) takes its figure from Udara instead. See below.
		  AND ca.duplicate_of_cbs_id IS NULL
		  AND (ca.outstanding_kobo IS DISTINCT FROM n.outstanding
		       OR ca.dpd_bucket IS DISTINCT FROM CASE WHEN ca.maturity_date IS NOT NULL
		                                              THEN `+bucketOf(uploadedDPD)+`
		                                              ELSE ca.dpd_bucket END)`); err != nil {
		return 0, nil, fmt.Errorf("refresh uploaded loan book: %w", err)
	}

	// (2b) Udara is the book of record. Where migration 268 proved an uploaded row mirrors
	// a live Udara facility, that row keeps its place on the queue — it is the work item an
	// agent already has, and the queue reads this table directly rather than the delinquency
	// view — but its FIGURE comes from core banking, not from the spreadsheet.
	//
	// Without this the two halves of the decision contradicted each other: 268 hid the row
	// from the view as a duplicate, yet statement (2) kept rewriting it with the sheet's
	// number, so an agent worked PAUBEE at the sheet's N51,566,667 while Udara said
	// N54,166,667. Thirty rows carrying N543,538,634.32 were in that state.
	//
	// Only the amount is taken. Status, ownership and history stay with the row.
	if _, err := db.PGExec(ctx, `
		UPDATE collection_assignments ca SET
			outstanding_kobo = GREATEST(
				COALESCE(cl.outstanding_principal_kobo,0)
			  + COALESCE(cl.outstanding_interest_kobo,0)
			  + COALESCE(cl.outstanding_fee_kobo,0), 0),
			updated_at       = NOW()
		FROM cbs_loans cl
		WHERE cl.cbs_id = ca.duplicate_of_cbs_id
		  AND ca.duplicate_of_cbs_id IS NOT NULL
		  AND ca.status IN ('active','sent_to_recovery')
		  AND ca.outstanding_kobo IS DISTINCT FROM GREATEST(
				COALESCE(cl.outstanding_principal_kobo,0)
			  + COALESCE(cl.outstanding_interest_kobo,0)
			  + COALESCE(cl.outstanding_fee_kobo,0), 0)`); err != nil {
		return 0, nil, fmt.Errorf("sync mirrored rows to the Udara figure: %w", err)
	}

	// A Udara borrower is not seeded while a live assignment still holds their bare
	// id in the cards namespace. That row names a card customer for this borrower's
	// debt; adding the correctly-named row beside it would put the same money on two
	// queues and leave the wrong person on one of them. Same gate the escalation
	// applies, and it lifts itself as soon as those rows are corrected.
	// A proven duplicate (duplicate_of_cbs_id, migration 268) DOES still block, deliberately.
	// It is the same facility Udara reports, it is still the live work item on the agent's
	// queue — the queue reads this table directly, not the view — and statement (2b) above
	// keeps its figure equal to Udara's. Seeding a second row beside it would put one debt
	// on two queue lines.
	//
	// What no longer blocks is a CARD row whose outstanding equals that customer's own live
	// card balance to the kobo: that is provably card work for a different person who merely
	// shares the eight digits — the same test migration 267 used to decide which rows NOT to
	// re-key. The guard was over-broad without it and left real money unworked: BENLAD
	// MULTILINKS' N29,166,666.67 was refused because Obinna Ubani, an unrelated CARD customer
	// holding CIF 00000656, had a legitimate N1,793,333.11 card assignment on the same
	// number. Refusing a Udara borrower because a stranger's card row exists is not caution;
	// it is the collision winning twice.
	const crossedAssignmentOpen = `EXISTS (
		SELECT 1 FROM collection_assignments ca
		 WHERE b.arm = 'udara' AND ca.account_cif = b.raw_cif
		   AND NOT (COALESCE(ca.data_source,'') = 'udara' OR ca.account_cif LIKE '` + udaraCIFPrefix + `%')
		   AND ca.status IN ('active','sent_to_recovery')
		   AND NOT (
		         COALESCE(ca.product_type,'') = 'card'
		     AND ca.outstanding_kobo > 0
		     AND ca.outstanding_kobo = (SELECT COALESCE(SUM(round(COALESCE(a.current_dr_balance,0) * 100)), 0)
		                                  FROM accounts a WHERE a.cif = ca.account_cif)
		   ))`

	// Refuse-and-report, before anything is written: every delinquent Udara borrower
	// this run will NOT seed, and why. These are skipped by the WHERE below — this
	// query exists so the skip is LOUD rather than a row count that silently comes up
	// short.
	var refused []core.Row
	if rows, uErr := db.PGQuery(ctx, armSplitDelinquency+`
		SELECT b.raw_cif, b.key_cif, b.outstanding_kobo, b.dpd,
		       (b.party_id IS NULL) AS unlinked,
		       COALESCE(NULLIF(TRIM(cc.name),''), NULLIF(TRIM(p.full_name),''), b.raw_cif) AS borrower
		  FROM book b
		  LEFT JOIN app.cbs_customers cc ON cc.cbs_customer_id = b.raw_cif
		  LEFT JOIN app.parties p ON p.party_id = b.party_id
		 WHERE b.arm = 'udara'
		   AND (b.party_id IS NULL OR `+crossedAssignmentOpen+`)
		 ORDER BY b.outstanding_kobo DESC`); uErr == nil {
		refused = rows
	}
	for _, u := range refused {
		reason := "a live collection assignment still holds this borrower's bare Udara id in the cards namespace — it names a different person for this debt"
		if toBool(u["unlinked"]) {
			reason = "no app.cbs_links bridge for this Udara customer id — no party can be named for this debt"
		}
		slog.Error("collections generate REFUSED to create an assignment",
			"reason", reason, "cbs_customer_id", str(u["raw_cif"]), "would_be_key", str(u["key_cif"]),
			"borrower", str(u["borrower"]), "outstanding_kobo", toInt64(u["outstanding_kobo"]),
			"dpd", toInt64(u["dpd"]), "actor_id", actorID)
	}

	// Create assignments for delinquent ids not already active or in recovery, one
	// row per (arm, id). assigned_by records the head who ran the generation; agent
	// stays NULL (unassigned) until a head distributes the queue. The uploaded branch
	// is excluded here too: every row it can emit is already an active assignment (the
	// view only shows uploaded loans with status='active'), so it can never seed a
	// new row — it could only lend a facility total to an unrelated card CIF that
	// happened to share the key.
	//
	// A Udara row is stored under key_cif = 'UD-<cbs_customer_id>' with its real
	// party_id and data_source='udara'; a card row is unchanged.
	res, err := db.PGExec(ctx, armSplitDelinquency+`
		INSERT INTO collection_assignments
		  (cif_number, account_cif, customer_name, party_id, data_source, product_type,
		   assigned_by, dpd_bucket, outstanding_kobo, status, assignment_date, created_at, updated_at)
		SELECT b.key_cif, b.key_cif, b.customer_name, b.party_id, b.data_source, b.product_type,
		       $1, `+bucketExpr+`, b.outstanding_kobo, 'active', CURRENT_DATE, NOW(), NOW()
		FROM book b
		WHERE `+udaraIdentityResolved+`
		  AND NOT `+crossedAssignmentOpen+`
		  AND b.key_cif NOT IN (
			SELECT account_cif FROM collection_assignments
			WHERE status IN ('active','sent_to_recovery') AND account_cif IS NOT NULL
		)`, actorID)
	if err != nil {
		return 0, nil, fmt.Errorf("create new assignments: %w", err)
	}
	created := int64(0)
	if res != nil {
		created, _ = res.RowsAffected()
	}
	refusedIDs := make([]string, 0, len(refused))
	for _, u := range refused {
		refusedIDs = append(refusedIDs, str(u["raw_cif"]))
	}

	return created, refusedIDs, nil
}

// collectionsGenerateAssignments is the head-gated button. The work itself lives in
// runCollectionsGenerate, which the hourly worker calls with the automation account.
func collectionsGenerateAssignments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil || !user.HasPage("collections_assign") {
			respondErr(w, 403, "Only collections heads can generate assignments")
			return
		}
		created, refusedIDs, err := runCollectionsGenerate(r.Context(), db, user.ID)
		if err != nil {
			respondErr(w, 500, "Generation failed: "+err.Error())
			return
		}
		desc := fmt.Sprintf("Generated %d new collection assignments from the delinquency book", created)
		if len(refusedIDs) > 0 {
			desc += fmt.Sprintf(" — REFUSED %d Udara borrower(s) on identity: %s",
				len(refusedIDs), strings.Join(refusedIDs, ", "))
		}
		logCreditEvent(r.Context(), db, r, "collections", "assignment", "generate", "", "assignments_generated",
			desc, nil, map[string]any{"created": created, "refused_udara_ids": refusedIDs})
		respond(w, map[string]any{
			"created":           created,
			"refused_udara_ids": refusedIDs,
		}, "json")
	}
}

// collectionsAccountDetail returns a full account snapshot for a given account key.
//
// The {cif} path parameter is a STORED KEY, not necessarily a cards CIF: a Udara-sourced
// account arrives as 'UD-<cbs_customer_id>'. splitCIFKey says which namespace it is in
// and the query then reads one arm only — the Udara branch of the delinquency book and
// the Udara customer master for a Udara key, the card branch and app.customers for a
// cards key. Before this, both the book lookup (`WHERE cif = $1`, over a view whose two
// branches share a key space) and the app.customers name fallback ran unconditionally,
// so opening a Udara account showed the card customer who shares the id: their name, on
// top of a balance that was the two people's debts added together.
func collectionsAccountDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "cif")
		cardsCIF, udaraCIF := splitCIFKey(key)
		// Base the snapshot on the key itself (never 404 for a valid account) and
		// draw balances/name/product from the unified delinquency book, the
		// collection overlay, and the key-keyed payments ledger.
		rows, err := db.PGQuery(r.Context(), `
			WITH d AS (
			    SELECT MAX(v.customer_name)                        AS customer_name,
			           STRING_AGG(DISTINCT v.product_name, ', ')   AS product_name,
			           STRING_AGG(DISTINCT v.source, ',')          AS source,
			           MAX(v.dpd)                                  AS dpd,
			           SUM(v.outstanding_kobo)                     AS outstanding_kobo
			    FROM app.collections_delinquent_unified v
			    WHERE CASE WHEN $3 <> '' THEN
			               v.cif = $3 AND v.source = 'loan' AND v.product_name <> 'Loan (uploaded)'
			          ELSE v.cif = $2 AND NOT (v.source = 'loan' AND v.product_name <> 'Loan (uploaded)')
			          END
			), ident AS (
			    -- Name of last resort, resolved inside the key's own namespace. The Udara
			    -- side goes cbs_customers -> app.cbs_links -> app.parties; the cards side
			    -- goes to app.customers. Neither branch can fire for the other's key.
			    SELECT COALESCE(
			        (SELECT NULLIF(TRIM(cc.name),'') FROM app.cbs_customers cc
			          WHERE $3 <> '' AND cc.cbs_customer_id = $3),
			        (SELECT NULLIF(TRIM(p.full_name),'') FROM app.cbs_links lk
			           JOIN app.parties p ON p.party_id = lk.entity_id
			          WHERE $3 <> '' AND lk.entity_type = 'party' AND lk.cbs_customer_id = $3 LIMIT 1),
			        (SELECT NULLIF(TRIM(c.full_name),'') FROM app.customers c
			          WHERE $2 <> '' AND COALESCE(NULLIF(c.cif,''), c.contact_id) = $2 LIMIT 1)
			    ) AS resolved_name
			)
			SELECT
			    NULL::bigint                                        AS loan_id,
			    base.cif                                            AS applicant_cif,
			    COALESCE(d.customer_name, ca.customer_name, ident.resolved_name,
			             base.cif)                                      AS applicant_name,
			    COALESCE(d.product_name, '—')                       AS product_type,
			    COALESCE(d.outstanding_kobo, ca.outstanding_kobo, 0) AS principal_kobo, -- CBS SUM removed: cbs_customer_id != cif
			    COALESCE(d.source, '')                              AS loan_status,
			    NULL::timestamptz                                   AS loan_created_at,
			    ca.id                                               AS assignment_id,
			    ca.agent_user_id,
			    u.full_name                                         AS agent_name,
			    ca.assignment_date,
			    COALESCE(ca.dpd_bucket, CASE
			        WHEN COALESCE(d.dpd,0) <= 0   THEN '0'
			        WHEN d.dpd <= 30  THEN '1-30'
			        WHEN d.dpd <= 60  THEN '31-60'
			        WHEN d.dpd <= 90  THEN '61-90'
			        WHEN d.dpd <= 180 THEN '91-180'
			        WHEN d.dpd <= 360 THEN '181-360'
			        ELSE '360+' END)                                AS dpd_bucket,
			    COALESCE(ca.outstanding_kobo, d.outstanding_kobo, 0) AS outstanding_kobo,
			    ca.current_stage,
			    ca.notes                                            AS assignment_notes,
			    COALESCE(d.dpd, 0)                                  AS dpd_lower,
			    cw.id                                               AS watchlist_id,
			    cw.scenario                                         AS watchlist_scenario,
			    cw.notes                                            AS watchlist_notes,
			    wbu.full_name                                       AS watchlist_flagged_by,
			    cw.created_at                                       AS watchlist_flagged_at,
			    (SELECT COUNT(*) FROM collection_contacts WHERE cif_number = base.cif)                  AS total_contacts,
			    (SELECT COUNT(*) FROM collection_promises WHERE cif_number = base.cif)                  AS ptps_created,
			    (SELECT COUNT(*) FROM collection_promises WHERE cif_number = base.cif AND is_kept = true) AS ptps_kept,
			    -- Approved receipts only: money still in the HOP -> COO -> CFO chain has
			    -- not posted to the GL and is not repayment. It is reported beside this
			    -- as pending_paid_kobo so it stays visible without inflating what was
			    -- paid. Filtering TO 'approved' also excludes a future 'rejected' row.
			    (SELECT COALESCE(SUM(amount_kobo), 0) FROM collection_payments
			      WHERE account_cif = base.cif AND status = 'approved')                  AS total_paid_kobo,
			    (SELECT COALESCE(SUM(amount_kobo), 0) FROM collection_payments
			      WHERE account_cif = base.cif AND status NOT IN ('approved','rejected')) AS pending_paid_kobo,
			    (SELECT MAX(cc.created_at) FROM collection_contacts cc WHERE cc.cif_number = base.cif)  AS last_contact_at,
			    (SELECT cc.outcome FROM collection_contacts cc WHERE cc.cif_number = base.cif ORDER BY cc.created_at DESC LIMIT 1) AS last_contact_outcome
			FROM (SELECT $1::text AS cif) base
			CROSS JOIN d
			CROSS JOIN ident
			LEFT JOIN collection_assignments ca ON ca.account_cif = base.cif AND ca.status IN ('active','sent_to_recovery')
			LEFT JOIN o3c_users u ON u.id = ca.agent_user_id
			LEFT JOIN LATERAL (
			    SELECT id, scenario, notes, created_at, flagged_by FROM collections_watchlist
			    WHERE account_cif = base.cif AND status = 'active' LIMIT 1
			) cw ON TRUE
			LEFT JOIN o3c_users wbu ON wbu.id = cw.flagged_by
			LIMIT 1`, key, cardsCIF, udaraCIF)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Account not found")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// collectionsDueSchedule lists facilities (cards + loans, all sources) by their next
// due date — either falling in the current Sun–Sat week (window=week) or already
// overdue (window=overdue). Card due = statement payment_due_date; loan due = maturity.
// days_until is (due − today): 0 = due today, negative = days overdue.
func collectionsDueSchedule(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		window := qstr(r, "window") // "week" | "overdue"
		var whereWin string
		var args []any
		switch window {
		case "overdue":
			whereWin = "due_date < CURRENT_DATE"
		default: // week window — an explicit [from,to] (the calendar navigates weeks) or the current Sun–Sat.
			from, _ := validDate(r, "from")
			to, _ := validDate(r, "to")
			if from != "" && to != "" {
				whereWin = "due_date BETWEEN $1::date AND $2::date"
				args = append(args, from, to)
			} else {
				whereWin = `due_date BETWEEN (CURRENT_DATE - EXTRACT(DOW FROM CURRENT_DATE)::int)
				                        AND (CURRENT_DATE - EXTRACT(DOW FROM CURRENT_DATE)::int + 6)`
			}
		}
		order := "due_date ASC"
		rows, err := db.PGQuery(r.Context(), `
			WITH facilities AS (
			    SELECT a.cif AS cif,
			           COALESCE(NULLIF(TRIM(c.first_name||' '||COALESCE(c.last_name,'')),''), a.name_on_card, a.cif) AS customer_name,
			           a.account_no AS reference, 'card' AS source, 'CCS' AS origin,
			           COALESCE(NULLIF(a.product_name,''), 'Card') AS product_name,
			           GREATEST(ROUND(COALESCE(a.current_dr_balance,0)*100),0)::bigint AS outstanding_kobo,
			           a.payment_due_date::date AS due_date
			    FROM app.accounts a LEFT JOIN app.customers c ON c.cif = a.cif
			    WHERE a.payment_due_date IS NOT NULL
			      AND COALESCE(a.current_dr_balance,0) > 0   -- only cards that actually owe
			    UNION ALL
			    -- Udara facilities are emitted under the namespaced key, never the bare
			    -- cbs_customer_id: this list is a drill-through, and a bare id sends the
			    -- click to /accounts/<id>, which is a DIFFERENT PERSON's card account for
			    -- 94% of these ids. The name comes from the Udara customer master with the
			    -- linked party as fallback — never from app.customers.
			    SELECT '` + udaraCIFPrefix + `' || cl.cbs_customer_id,
			           COALESCE(NULLIF(TRIM(cc.name),''), NULLIF(TRIM(cl.raw->>'name'),''),
			                    NULLIF(TRIM(p.full_name),''), cl.cbs_customer_id),
			           cl.cbs_account_number, 'loan', 'Udara',
			           COALESCE(NULLIF(cl.product_name,''), 'Loan'),
			           (COALESCE(cl.outstanding_principal_kobo,0)+COALESCE(cl.outstanding_interest_kobo,0)+COALESCE(cl.outstanding_fee_kobo,0))::bigint,
			           cl.maturity_date::date
			    FROM cbs_loans cl
			    LEFT JOIN cbs_customers cc ON cc.cbs_customer_id = cl.cbs_customer_id
			    LEFT JOIN app.cbs_links lk ON lk.entity_type = 'party' AND lk.cbs_customer_id = cl.cbs_customer_id
			    LEFT JOIN app.parties p ON p.party_id = lk.entity_id
			    WHERE cl.status NOT IN ('Closed','Revoked') AND cl.maturity_date IS NOT NULL
			    UNION ALL
			    SELECT ca.account_cif,
			           COALESCE(NULLIF(TRIM(ca.customer_name),''), ca.account_cif),
			           COALESCE(NULLIF(ca.loan_ref,''),'Uploaded loan'), 'loan', 'Uploaded',
			           'Loan (uploaded)',
			           COALESCE(ca.outstanding_kobo,0)::bigint,
			           ca.maturity_date
			    FROM collection_assignments ca
			    WHERE ca.product_type='loan' AND ca.data_source='manual' AND ca.status='active'
			      AND ca.maturity_date IS NOT NULL
			)
			SELECT cif, customer_name, reference, source, origin, product_name, outstanding_kobo,
			       due_date::text AS due_date,
			       (due_date - CURRENT_DATE) AS days_until,
			       TRIM(TO_CHAR(due_date,'Dy')) AS weekday
			FROM facilities
			WHERE `+whereWin+`
			ORDER BY `+order+`, outstanding_kobo DESC
			LIMIT 4000`, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// collectionsPortfolioKPIs returns PAR-based KPIs from collection_assignments.
func collectionsPortfolioKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Unified delinquency book — both the card/customer arrears (app.accounts)
		// and the Udara loan book (cbs_loans), aggregated per CIF. This is an
		// as-of-now snapshot, so date filters don't apply. PAR30/60/90 = cumulative
		// DPD > 30/60/90 (CBN definition).
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COALESCE(SUM(outstanding_kobo) FILTER (WHERE dpd > 30), 0) AS par30_kobo,
				COALESCE(SUM(outstanding_kobo) FILTER (WHERE dpd > 60), 0) AS par60_kobo,
				COALESCE(SUM(outstanding_kobo) FILTER (WHERE dpd > 90), 0) AS par90_kobo,
				COALESCE(SUM(outstanding_kobo), 0)                        AS total_outstanding_kobo,
				COUNT(*)                                                  AS total_accounts,
				COUNT(*) FILTER (WHERE dpd > 0)                           AS delinquent_accounts,
				0::numeric                                                AS current_rate_pct
			FROM (
				SELECT cif, MAX(dpd) AS dpd, SUM(outstanding_kobo) AS outstanding_kobo
				FROM app.collections_delinquent_unified
				GROUP BY cif
			) ca`)
		var result core.Row
		if err != nil || len(rows) == 0 {
			result = core.Row{
				"par30_kobo": int64(0), "par60_kobo": int64(0), "par90_kobo": int64(0),
				"total_outstanding_kobo": int64(0), "total_accounts": int64(0),
				"delinquent_accounts": int64(0), "current_rate_pct": 0.0,
			}
		} else {
			result = rows[0]
		}

		// Collected in the selected period — from the real payments ledger (kobo), not
		// the retired "Collections Log". Defaults to month-to-date when no range given.
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		where := "status = 'approved'"
		cargs := []any{}
		if from != "" {
			cargs = append(cargs, from)
			where += fmt.Sprintf(" AND payment_date >= $%d::date", len(cargs))
		}
		if to != "" {
			cargs = append(cargs, to)
			where += fmt.Sprintf(" AND payment_date <= $%d::date", len(cargs))
		}
		if from == "" && to == "" {
			where += " AND date_trunc('month',payment_date) = date_trunc('month',CURRENT_DATE)"
		}
		crow, _ := db.PGQuery(r.Context(),
			`SELECT COALESCE(SUM(amount_kobo),0) AS collected_kobo, COUNT(*) AS collected_count
			 FROM app.collection_payments WHERE `+where, cargs...)
		if len(crow) > 0 {
			result["collected_kobo"] = crow[0]["collected_kobo"]
			result["collected_count"] = crow[0]["collected_count"]
		} else {
			result["collected_kobo"] = int64(0)
			result["collected_count"] = int64(0)
		}
		respond(w, result, "pg")
	}
}

// collectionsDPDTrend returns 6-month PAR trend from collection_assignments.
func collectionsDPDTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		rows, err := db.PGQuery(r.Context(), `
			WITH months AS (
				SELECT generate_series(
					DATE_TRUNC('month', NOW() - INTERVAL '5 months'),
					DATE_TRUNC('month', NOW()),
					'1 month'::interval
				) AS m
			)
			SELECT
				TO_CHAR(m.m, 'Mon YY') AS month,
				m.m                    AS month_sort,
				COALESCE(SUM(CASE WHEN ca.dpd_bucket IN ('31-60','61-90','91-180','181-360','360+')
				              THEN ca.outstanding_kobo END), 0)            AS par30_kobo,
				COALESCE(SUM(CASE WHEN ca.dpd_bucket IN ('61-90','91-180','181-360','360+')
				              THEN ca.outstanding_kobo END), 0)            AS par60_kobo,
				COALESCE(SUM(CASE WHEN ca.dpd_bucket IN ('91-180','181-360','360+')
				              THEN ca.outstanding_kobo END), 0)            AS par90_kobo
			FROM months m
			LEFT JOIN collection_assignments ca
				ON DATE_TRUNC('month', ca.updated_at) = m.m
				AND ($1 = '' OR ca.updated_at::date >= $1::date)
				AND ($2 = '' OR ca.updated_at::date <= $2::date)
			GROUP BY m.m
			ORDER BY m.m`, from, to)
		if err != nil {
			respond(w, []any{}, "pg")
			return
		}
		respond(w, rows, "pg")
	}
}

// collectionsRollRate returns DPD bucket distribution and MoM transition counts.
// A full roll-rate matrix requires historical snapshots; this endpoint provides
// the current DPD distribution plus last-month's distribution for comparison.
func collectionsRollRate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")

		// Current DPD distribution from the unified delinquency book (per CIF), so it
		// reflects the live arrears snapshot regardless of assignment generation.
		current, err := db.PGQuery(ctx, `
			SELECT
				dpd_bucket,
				COUNT(*)                             AS account_count,
				COALESCE(SUM(outstanding_kobo), 0)  AS outstanding_kobo
			FROM (
				SELECT cif,
				       SUM(outstanding_kobo) AS outstanding_kobo,
				       CASE
				         WHEN MAX(dpd)<=0 THEN '0' WHEN MAX(dpd)<=30 THEN '1-30' WHEN MAX(dpd)<=60 THEN '31-60'
				         WHEN MAX(dpd)<=90 THEN '61-90' WHEN MAX(dpd)<=180 THEN '91-180' WHEN MAX(dpd)<=360 THEN '181-360' ELSE '360+'
				       END AS dpd_bucket
				FROM app.collections_delinquent_unified GROUP BY cif
			) d
			GROUP BY dpd_bucket
			ORDER BY
				CASE dpd_bucket
					WHEN '0'       THEN 0
					WHEN '1-30'    THEN 1
					WHEN '31-60'   THEN 2
					WHEN '61-90'   THEN 3
					WHEN '91-180'  THEN 4
					WHEN '181-360' THEN 5
					ELSE 6
				END`)
		if err != nil {
			respondErr(w, 500, "Roll rate query failed")
			return
		}

		// Movement in the requested window (defaults to the current calendar month):
		// accounts that changed dpd_bucket. Proxied by comparing updated_at vs
		// created_at bucket changes.
		cures, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS cured_count
			FROM collection_assignments
			WHERE dpd_bucket = '0'
			  AND updated_at >= COALESCE(NULLIF($1, '')::date, DATE_TRUNC('month', CURRENT_DATE)::date)
			  AND ($2 = '' OR updated_at::date <= $2::date)
			  AND updated_at > created_at`, from, to)

		respond(w, map[string]any{
			"current_distribution": current,
			"cured_this_month": func() any {
				if len(cures) > 0 {
					return cures[0]["cured_count"]
				}
				return 0
			}(),
		}, "pg")
	}
}

func collectionsKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		agent := qstr(r, "agent")

		var f Filter
		f.Date("Repayment_Date", `"Date"`, dateFrom, dateTo)
		f.Eq(" AND Rn_Create_User=?", ` AND "Agent"=?`, agent)

		ctx := r.Context()
		kpis := map[string]any{}
		var sources []string

		type spec struct{ key, pg string }
		for _, s := range []spec{
			{"total_collected",
				fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE 1=1%s`, f.PG())},
			{"collection_count",
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Collections Log" WHERE 1=1%s`, f.PG())},
			{"paid_collections",
				fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Mode Of Payment" IS NOT NULL%s`, f.PG())},
			{"pending_collections",
				fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE "Mode Of Payment" IS NULL%s`, f.PG())},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.pg, f.Args()...)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		// MTD always uses current month; include agent filter but not date filter
		var af Filter
		af.Eq(" AND Rn_Create_User=?", ` AND "Agent"=?`, agent)
		mtd, src, _ := db.DualScalar(ctx, "val",
			fmt.Sprintf(`SELECT COALESCE(SUM("Amount"),0) AS val FROM "Collections Log" WHERE DATE_TRUNC('month',"Date")=DATE_TRUNC('month',CURRENT_DATE)%s`, af.PG()),
			af.Args()...)
		kpis["collections_mtd"] = mtd
		sources = append(sources, src)

		respond(w, kpis, pickSource(sources))
	}
}

func collectionsByAgent(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		// Real per-agent collections from the payments ledger (kobo). A payment is
		// attributed to the agent who recorded it, else the agent assigned to that
		// account. Imported payments with neither are grouped as "Unattributed" so the
		// figures still reconcile with the portfolio total.
		where := "cp.status = 'approved'"
		args := []any{}
		if dateFrom != "" {
			args = append(args, dateFrom)
			where += fmt.Sprintf(" AND cp.payment_date >= $%d::date", len(args))
		}
		if dateTo != "" {
			args = append(args, dateTo)
			where += fmt.Sprintf(" AND cp.payment_date <= $%d::date", len(args))
		}
		data, err := db.PGQuery(r.Context(),
			`SELECT COALESCE(u.full_name, 'Unattributed') AS "Agent",
			        COALESCE(SUM(cp.amount_kobo),0)       AS total,
			        COUNT(*)                              AS count
			 FROM app.collection_payments cp
			 LEFT JOIN app.collection_assignments ca ON ca.id = cp.assignment_id
			 LEFT JOIN app.o3c_users u ON u.id = COALESCE(cp.received_by, ca.agent_user_id)
			 WHERE `+where+`
			 GROUP BY 1 ORDER BY total DESC LIMIT 15`, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if data == nil {
			data = []core.Row{}
		}
		respond(w, data, "pg")
	}
}

func collectionsByMode(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT COALESCE("Mode Of Payment",'Pending') AS payment_status,
			        COALESCE(SUM("Amount"),0) AS total, COUNT(*) AS count
			 FROM "Collections Log" GROUP BY "Mode Of Payment" ORDER BY total DESC`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

func collectionsMonthlyTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT TO_CHAR(DATE_TRUNC('month',"Date"),'Mon YYYY') AS month,
			        DATE_TRUNC('month',"Date") AS month_sort,
			        COALESCE(SUM("Amount"),0) AS total
			 FROM "Collections Log" WHERE "Date" IS NOT NULL
			 GROUP BY DATE_TRUNC('month',"Date") ORDER BY month_sort`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

func collectionsLog(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		agent := qstr(r, "agent")
		limit := qint(r, "limit", 200, 1, 1000)

		var f Filter
		f.Date("Repayment_Date", `"Date"`, dateFrom, dateTo)
		f.Eq(" AND r.Rn_Create_User=?", ` AND cl."Agent"=?`, agent)

		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT cl."Date", cl."CIF",
			        a.first_name AS "First Name", a.last_name AS "Last Name",
			        cl."Agent", cl."Amount", cl."Mode Of Payment", cl."Payment Receipt"
			 FROM "Collections Log" cl
			 LEFT JOIN app.customers a ON cl."CIF"=a.cif
			 WHERE 1=1%s ORDER BY cl."Date" DESC LIMIT %d`, f.PG(), limit),
			f.Args()...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

func collectionsPromiseKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*)                                                      AS total,
				COUNT(*) FILTER (WHERE is_kept = TRUE)                        AS kept,
				COUNT(*) FILTER (WHERE is_kept = FALSE)                       AS broken,
				COALESCE(SUM(promised_amount_kobo), 0)                        AS amount_promised_kobo
			FROM collection_promises
			WHERE ($1 = '' OR created_at::date >= $1::date)
			  AND ($2 = '' OR created_at::date <= $2::date)`, from, to)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total": int64(0), "kept": int64(0), "broken": int64(0),
				"amount_promised_kobo": int64(0),
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func collectionsRepaymentKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*) FILTER (WHERE status = 'Active')                         AS active,
				COUNT(*) FILTER (WHERE status = 'Active'
				                   AND (next_payment_date IS NULL
				                        OR next_payment_date >= CURRENT_DATE))    AS on_track,
				COUNT(*) FILTER (WHERE status = 'Active'
				                   AND next_payment_date < CURRENT_DATE)          AS behind,
				COALESCE(SUM(
					CASE WHEN status = 'Active'
					THEN (SELECT COALESCE(SUM(ri.amount_kobo),0)
					      FROM repayment_instalments ri
					      WHERE ri.plan_id = rp.id
					        AND ri.due_date >= DATE_TRUNC('month', CURRENT_DATE)
					        AND ri.due_date <  DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
					        AND ri.status != 'Paid')
					ELSE 0 END
				), 0)                                                              AS monthly_due_kobo
			FROM repayment_plans rp
			WHERE ($1 = '' OR rp.created_at::date >= $1::date)
			  AND ($2 = '' OR rp.created_at::date <= $2::date)`, from, to)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"active": int64(0), "on_track": int64(0),
				"behind": int64(0), "monthly_due_kobo": int64(0),
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func collectionsWriteoffKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				COUNT(*)                                                          AS total,
				COALESCE(SUM(wo.amount_kobo), 0)                                 AS amount_kobo,
				CASE WHEN SUM(wo.amount_kobo) = 0 OR SUM(wo.amount_kobo) IS NULL THEN 0
				     ELSE ROUND(
				       100.0 * (SELECT COALESCE(SUM(rc2.recovered_kobo), 0)
				                FROM recovery_cases rc2
				                WHERE rc2.id IN (
				                    SELECT DISTINCT case_id FROM recovery_write_off_approvals w2
				                    WHERE ($1 = '' OR w2.created_at::date >= $1::date)
				                      AND ($2 = '' OR w2.created_at::date <= $2::date)
				                )) / NULLIF(SUM(wo.amount_kobo), 0), 1
				     )
				END                                                               AS recovery_rate_pct,
				COUNT(*) FILTER (WHERE wo.status NOT IN ('approved','rejected')) AS pending
			FROM recovery_write_off_approvals wo
			JOIN recovery_cases rc ON wo.case_id = rc.id
			WHERE ($1 = '' OR wo.created_at::date >= $1::date)
			  AND ($2 = '' OR wo.created_at::date <= $2::date)`, from, to)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total": int64(0), "amount_kobo": int64(0),
				"recovery_rate_pct": 0.0, "pending": int64(0),
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}

// ── Watchlist CRUD ────────────────────────────────────────────────────────────

func collectionsWatchlistList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		if status == "" {
			status = "active"
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    cw.id, cw.account_cif, cw.scenario, cw.notes,
			    cw.dpd_at_flag, cw.outstanding_kobo, cw.status,
			    cw.resolved_at, cw.resolution_notes, cw.created_at,
			    u.full_name AS flagged_by_name
			FROM collections_watchlist cw
			LEFT JOIN o3c_users u ON u.id = cw.flagged_by
			WHERE ($1 = 'all' OR cw.status = $1)
			ORDER BY cw.created_at DESC
			LIMIT 200`, status)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func collectionsWatchlistAdd(db *core.DB) http.HandlerFunc {
	type body struct {
		AccountCIF      string `json:"account_cif"`
		Scenario        string `json:"scenario"`
		Notes           string `json:"notes"`
		DPDAtFlag       int    `json:"dpd_at_flag"`
		OutstandingKobo int64  `json:"outstanding_kobo"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AccountCIF == "" || b.Scenario == "" {
			respondErr(w, 422, "account_cif and scenario are required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO collections_watchlist
			    (account_cif, flagged_by, scenario, notes, dpd_at_flag, outstanding_kobo, status, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW())
			RETURNING id, account_cif, scenario, notes, dpd_at_flag, outstanding_kobo, status, created_at`,
			b.AccountCIF, user.ID, b.Scenario, b.Notes, b.DPDAtFlag, b.OutstandingKobo)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		// A RETURNING that comes back empty is not an error, so testing err alone left
		// rows[0] to panic the handler on an index out of range.
		if len(rows) == 0 {
			respondErr(w, 500, "Insert returned no result")
			return
		}
		logCreditEvent(r.Context(), db, r, "collections", "watchlist", fmt.Sprint(rows[0]["id"]), b.AccountCIF, "watchlist_flagged",
			fmt.Sprintf("Account added to watchlist — scenario: %s", b.Scenario), nil, map[string]any{"scenario": b.Scenario, "notes": b.Notes})
		respond(w, rows[0], "pg")
	}
}

func collectionsWatchlistResolve(db *core.DB) http.HandlerFunc {
	type body struct {
		Status          string `json:"status"` // resolved | escalated_to_recovery
		ResolutionNotes string `json:"resolution_notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Status != "resolved" && b.Status != "escalated_to_recovery" {
			respondErr(w, 422, "status must be resolved or escalated_to_recovery")
			return
		}
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Load current flag first so escalation can carry outstanding/dpd into the
		// recovery case, and so we don't open a duplicate case on re-escalation.
		cur, cErr := db.PGQuery(ctx, `SELECT status, COALESCE(outstanding_kobo,0) AS outstanding_kobo, COALESCE(dpd_at_flag,0) AS dpd_at_flag FROM collections_watchlist WHERE id=$1`, id)
		if cErr != nil || len(cur) == 0 {
			respondErr(w, 404, "Watchlist entry not found")
			return
		}
		alreadyEscalated := str(cur[0]["status"]) == "escalated_to_recovery"
		wlOutstanding := toInt64(cur[0]["outstanding_kobo"])
		wlDPD := toInt64(cur[0]["dpd_at_flag"])

		rows, err := db.PGQuery(ctx, `
			UPDATE collections_watchlist
			SET status = $1, resolved_at = NOW(), resolved_by = $2, resolution_notes = $3
			WHERE id = $4
			RETURNING id, account_cif, scenario, status, resolved_at, resolution_notes`,
			b.Status, user.ID, b.ResolutionNotes, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Watchlist entry not found")
			return
		}
		cif := str(rows[0]["account_cif"])

		// Escalation must actually reach recovery — open a real recovery case
		// (mirrors send-to-recovery) instead of only flipping the flag's status.
		//
		// But not blindly. A watchlist flag carries only account_cif, and openRecoveryCase
		// writes whatever it is given into recovery_cases.cif_number AND .account_cif —
		// both cards-namespace columns. If the flag holds a bare Udara customer id, the
		// case is opened against whoever holds the same id in the cards namespace. Refuse,
		// loudly, and resolve the flag without a case rather than name the wrong person in
		// a recovery file.
		var caseRef, escalationRefusal string
		if b.Status == "escalated_to_recovery" && !alreadyEscalated && cif != "" {
			borrower, gErr := udaraBorrowerFor(ctx, db, cif)
			switch {
			case gErr != nil:
				escalationRefusal = "could not verify the identity namespace of " + cif
				slog.Error("watchlist escalation REFUSED — identity check failed",
					"watchlist_id", id, "account_cif", cif, "err", gErr, "actor_id", user.ID)
			case borrower != "":
				escalationRefusal = fmt.Sprintf("%s is a Udara customer id (borrower: %s), not a cards CIF — a recovery case opened on it would name a different person", cif, borrower)
				slog.Error("watchlist escalation REFUSED — namespace-crossed account_cif",
					"watchlist_id", id, "account_cif", cif, "udara_borrower", borrower,
					"outstanding_kobo", wlOutstanding, "actor_id", user.ID)
			default:
				if ref, caseID, oErr := openRecoveryCase(ctx, db, cif, fmt.Sprint(wlDPD), wlOutstanding, nil); oErr == nil {
					caseRef = ref
					stampCaseIdentity(ctx, db, caseID, cif)
				}
			}
		}

		evtDesc := fmt.Sprintf("Watchlist flag resolved — status: %s", b.Status)
		if caseRef != "" {
			evtDesc = fmt.Sprintf("Watchlist flag escalated to recovery — case %s created", caseRef)
		} else if escalationRefusal != "" {
			evtDesc = "Watchlist escalation REFUSED — " + escalationRefusal
		}
		logCreditEvent(ctx, db, r, "collections", "watchlist", fmt.Sprint(id), cif, "watchlist_resolved",
			evtDesc, nil, map[string]any{"status": b.Status, "notes": b.ResolutionNotes, "case_ref": caseRef, "escalation_refused": escalationRefusal})
		out := rows[0]
		if caseRef != "" {
			out["recovery_case_ref"] = caseRef
		}
		if escalationRefusal != "" {
			out["escalation_refused"] = escalationRefusal
		}
		respond(w, out, "pg")
	}
}

// ── Credit activity log endpoints ─────────────────────────────────────────────

func creditActivityFeed(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		page := qint(r, "page", 1, 1, 500)
		size := qint(r, "size", 50, 1, 200)
		from := r.URL.Query().Get("from")
		to := r.URL.Query().Get("to")
		mod := r.URL.Query().Get("module")
		act := r.URL.Query().Get("action")
		etype := r.URL.Query().Get("entity_type")
		cif := r.URL.Query().Get("cif")
		actor := r.URL.Query().Get("actor_id")

		where := " WHERE 1=1"
		args := []any{}

		addFilter := func(col, val string) {
			if val != "" {
				args = append(args, val)
				where += fmt.Sprintf(" AND %s = $%d", col, len(args))
			}
		}
		if from != "" {
			args = append(args, from)
			where += fmt.Sprintf(" AND ts >= $%d::date", len(args))
		}
		if to != "" {
			args = append(args, to)
			where += fmt.Sprintf(" AND ts <  $%d::date + INTERVAL '1 day'", len(args))
		}
		addFilter("module", mod)
		addFilter("action", act)
		addFilter("entity_type", etype)
		addFilter("account_cif", cif)
		addFilter("actor_id::text", actor)

		// Snapshot filter args before adding LIMIT/OFFSET for the COUNT query.
		countArgs := make([]any, len(args))
		copy(countArgs, args)

		offset := (page - 1) * size
		args = append(args, size, offset)
		limitClause := fmt.Sprintf(" ORDER BY ts DESC LIMIT $%d OFFSET $%d", len(args)-1, len(args))

		rows, err := db.PGQuery(ctx,
			`SELECT cal.id, cal.ts, cal.module, cal.actor_id, cal.actor_name, cal.actor_role,
			        cal.entity_type, cal.entity_id, cal.account_cif, cal.action, cal.description,
			        cal.previous_state, cal.new_state, cal.ip_address
			 FROM credit_activity_log cal`+where+limitClause, args...)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		var total int
		if cErr := db.PG.QueryRowContext(ctx, "SELECT COUNT(*) FROM credit_activity_log"+where, countArgs...).Scan(&total); cErr != nil {
			respondErr(w, 500, "Count query failed: "+cErr.Error())
			return
		}

		respond(w, map[string]any{"data": rows, "total": total, "page": page, "size": size}, "credit_activity_feed")
	}
}

func creditActivityByCIF(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		cif := chi.URLParam(r, "cif")
		if cif == "" {
			respondErr(w, 400, "cif required")
			return
		}

		rows, err := db.PGQuery(ctx, `
			SELECT id, ts, module, actor_id, actor_name, actor_role,
			       entity_type, entity_id, action, description,
			       previous_state, new_state
			FROM credit_activity_log
			WHERE account_cif = $1
			ORDER BY ts DESC
			LIMIT 200`, cif)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		// respond() already wraps the payload as {"data": …}; return the rows
		// directly so the client sees r.data as the array (TimelineTab reads
		// r.data). Wrapping again here double-nests and crashes the timeline
		// with "x.map is not a function".
		respond(w, rows, "credit_activity_cif")
	}
}

// collectionsCallsByCIF surfaces the call-centre's calls for a customer inside the
// collections / recovery detail views, so the officer working a case can see what has
// already been dialled without leaving for Customer 360. It reuses the same crosswalk
// c360Activity does: a call matches the customer either by its own recorded CIF or by
// last-10-digit phone against the customer master, excluding merged/voided legs.
func collectionsCallsByCIF(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		cif := chi.URLParam(r, "cif")
		if cif == "" {
			respondErr(w, 400, "cif required")
			return
		}
		// The phone crosswalk must be resolved in the key's own namespace. A Udara key
		// ('UD-<cbs_customer_id>') resolves through the Udara customer master and the
		// linked party; a cards key through app.customers. Matching a Udara key against
		// app.customers.cif would pull back the card customer who shares the id and show
		// a recovery officer a different person's call history.
		//
		// length(...) = 10 guards app.norm_phone, which is last-10-digits and returns ''
		// rather than NULL — without the guard a blank stored phone matches every call
		// whose own number is unparseable.
		cardsCIF, udaraCIF := splitCIFKey(cif)
		rows, err := db.PGQuery(ctx, `
			WITH subject_phone AS (
			    SELECT COALESCE(
			        (SELECT app.norm_phone(cc.phone) FROM app.cbs_customers cc
			          WHERE $2 <> '' AND cc.cbs_customer_id = $2 AND COALESCE(cc.phone,'') <> '' LIMIT 1),
			        (SELECT app.norm_phone(p.primary_phone) FROM app.cbs_links lk
			           JOIN app.parties p ON p.party_id = lk.entity_id
			          WHERE $2 <> '' AND lk.entity_type = 'party' AND lk.cbs_customer_id = $2
			            AND COALESCE(p.primary_phone,'') <> '' LIMIT 1),
			        (SELECT app.norm_phone(c.phone) FROM app.customers c
			          WHERE $1 <> '' AND c.cif = $1 AND COALESCE(c.phone,'') <> '' LIMIT 1)
			    ) AS phone
			)
			SELECT h.id, h.started_at, h.direction, h.duration_sec,
			       COALESCE(h.outcome,'')     AS outcome,
			       COALESCE(h.disposition,'') AS disposition,
			       COALESCE(h.purpose,'')     AS purpose,
			       COALESCE(h.agent_name,'')  AS agent_name,
			       COALESCE(h.notes,'')       AS notes
			FROM app.helpdesk_calls h, subject_phone sp
			WHERE (($1 <> '' AND h.customer_cif = $1)
			    OR (LENGTH(COALESCE(sp.phone,'')) = 10
			        AND app.norm_phone(h.customer_phone) = sp.phone))
			  AND h.merged_into_call_id IS NULL AND h.voided_at IS NULL
			ORDER BY h.started_at DESC
			LIMIT 100`, cardsCIF, udaraCIF)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "collections_calls_cif")
	}
}

// stepTypes is the controlled vocabulary for a logged collections/recovery step, so
// the timeline can render a consistent icon/label per channel.
var stepTypes = map[string]bool{
	"call": true, "email": true, "sms": true, "whatsapp": true,
	"letter": true, "field_visit": true, "file": true, "note": true,
}

// collectionsLogStep records a typed step (call/email/SMS/letter/field-visit/file/note)
// the officer took on a case or assignment, via the shared credit_activity_log. This is
// the "standard approach" so every step — whoever logs it — shows up on the case
// timeline and Customer 360, letting a recovery officer see exactly what has been done.
func collectionsLogStep(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var body struct {
			Module   string `json:"module"`
			CIF      string `json:"cif"`
			EntityID string `json:"entity_id"`
			StepType string `json:"step_type"`
			Outcome  string `json:"outcome"`
			Notes    string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "invalid body")
			return
		}
		body.CIF = strings.TrimSpace(body.CIF)
		body.StepType = strings.ToLower(strings.TrimSpace(body.StepType))
		if body.CIF == "" {
			respondErr(w, 400, "cif required")
			return
		}
		if !stepTypes[body.StepType] {
			respondErr(w, 400, "invalid step_type")
			return
		}
		module := body.Module
		if module != "recovery" {
			module = "collections" // the log's CHECK allows only collections/recovery/risk
		}
		entityID := strings.TrimSpace(body.EntityID)
		if entityID == "" {
			entityID = body.CIF
		}
		// Human-readable description: "<Channel> — <outcome>: <notes>".
		label := map[string]string{
			"call": "Call", "email": "Email", "sms": "SMS", "whatsapp": "WhatsApp",
			"letter": "Letter", "field_visit": "Field visit", "file": "File", "note": "Note",
		}[body.StepType]
		desc := label
		if o := strings.TrimSpace(body.Outcome); o != "" {
			desc += " — " + o
		}
		if nt := strings.TrimSpace(body.Notes); nt != "" {
			desc += ": " + nt
		}
		logCreditEvent(ctx, db, r, module, "step", entityID, body.CIF,
			"step_"+body.StepType, desc,
			nil, map[string]any{"step_type": body.StepType, "outcome": body.Outcome, "notes": body.Notes})
		respond(w, map[string]any{"ok": true}, "collections_step")
	}
}

// ── Batch payment upload ──────────────────────────────────────────────────────

func collectionsBatchPayment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(4 << 20); err != nil {
			respondErr(w, 400, "Invalid multipart form")
			return
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			respondErr(w, 400, "Missing file field")
			return
		}
		defer file.Close()

		reader := csv.NewReader(file)
		reader.TrimLeadingSpace = true
		records, err := reader.ReadAll()
		if err != nil {
			respondErr(w, 400, "Invalid CSV")
			return
		}
		if len(records) < 2 {
			respondErr(w, 422, "CSV has no data rows")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		type result struct {
			Row     int    `json:"row"`
			CIF     string `json:"cif"`
			Success bool   `json:"success"`
			Error   string `json:"error,omitempty"`
		}
		var results []result
		processed, failed := 0, 0

		for i, rec := range records[1:] {
			rowNum := i + 2
			if len(rec) < 5 {
				results = append(results, result{Row: rowNum, Error: "not enough columns (need: cif,amount_naira,payment_date,channel,reference)"})
				failed++
				continue
			}
			cif := strings.TrimSpace(rec[0])
			amtNaira, parseErr := strconv.ParseFloat(strings.TrimSpace(rec[1]), 64)
			payDate := strings.TrimSpace(rec[2])
			channel := strings.TrimSpace(rec[3])
			reference := strings.TrimSpace(rec[4])

			if parseErr != nil || amtNaira <= 0 {
				results = append(results, result{Row: rowNum, CIF: cif, Error: "invalid amount"})
				failed++
				continue
			}
			if payDate == "" || channel == "" {
				results = append(results, result{Row: rowNum, CIF: cif, Error: "payment_date and channel required"})
				failed++
				continue
			}
			amtKobo := int64(math.Round(amtNaira * 100))

			// Validate the CIF is a known customer so a typo can't post a GL entry.
			if custRows, cErr := db.PGQuery(ctx, `SELECT 1 FROM app.customers WHERE cif = $1 LIMIT 1`, cif); cErr != nil || len(custRows) == 0 {
				results = append(results, result{Row: rowNum, CIF: cif, Error: "unknown CIF"})
				failed++
				continue
			}
			if _, dErr := time.Parse("2006-01-02", payDate); dErr != nil {
				results = append(results, result{Row: rowNum, CIF: cif, Error: "invalid payment_date (want YYYY-MM-DD)"})
				failed++
				continue
			}

			// Link the active assignment when there is one (nullable in the ledger).
			var assignmentID any
			if aRows, _ := db.PGQuery(ctx, `SELECT id FROM collection_assignments WHERE account_cif = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`, cif); len(aRows) > 0 {
				assignmentID = toInt64(aRows[0]["id"])
			}

			tx, txErr := db.PG.BeginTx(ctx, nil)
			if txErr != nil {
				results = append(results, result{Row: rowNum, CIF: cif, Error: "tx start failed"})
				failed++
				continue
			}

			// Write to the CIF-keyed collections ledger (works for the whole
			// delinquency book, not just booked loans) so batch payments post and
			// show up in the account snapshot.
			var payID int64
			insErr := tx.QueryRowContext(ctx, `
				INSERT INTO collection_payments (assignment_id, account_cif, amount_kobo, payment_date, channel, reference, received_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
				RETURNING id`,
				assignmentID, cif, amtKobo, payDate, channel, reference, user.ID,
			).Scan(&payID)
			if insErr != nil {
				tx.Rollback() //nolint:errcheck
				results = append(results, result{Row: rowNum, CIF: cif, Error: "insert failed"})
				failed++
				continue
			}

			// NO GL POST HERE, and no loan_repayments mirror. Both used to happen in this
			// transaction while the INSERT above omitted `status` — so the row took the
			// column default 'pending_hop' and ALSO landed in the approval queue with a
			// journal already behind it. Approving it then posted the same money a second
			// time, via postCollectionPaymentGL in collectionsOpsApprovePayment. Eleven
			// rows worth ₦106,393,556 are sitting in exactly that state today.
			//
			// The approval chain owns the ledger: collectionsOpsApprovePayment posts the
			// journal once, at the final stage, inside its own transaction. A batch upload
			// is not pre-approved — this endpoint carries no payment-approval gate — so it
			// must not write financial records. It records the payment; HOP → COO decide.

			if cErr := tx.Commit(); cErr != nil {
				results = append(results, result{Row: rowNum, CIF: cif, Error: "commit failed"})
				failed++
				continue
			}

			// Legacy parity: mirror to loan_repayments when the CIF maps to a booked
			// loan. Best-effort and deliberately run after the commit above, in its
			// own connection, so a failure here can never poison and roll back the
			// payment + GL entry that already committed successfully.
			if lr, lErr := db.PGQuery(ctx, `SELECT id FROM loan_applications WHERE applicant_cif = $1 AND status IN ('active','booked') ORDER BY created_at DESC LIMIT 1`, cif); lErr == nil && len(lr) > 0 {
				_, _ = db.PG.ExecContext(ctx, `INSERT INTO loan_repayments (application_id, amount_kobo, payment_date, payment_method, reference, received_by, created_at)
					VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
					toInt64(lr[0]["id"]), amtKobo, payDate, channel, reference, user.ID)
			}

			results = append(results, result{Row: rowNum, CIF: cif, Success: true})
			processed++
		}

		respond(w, map[string]any{
			"processed": processed,
			"failed":    failed,
			"total":     processed + failed,
			"results":   results,
		}, "pg")
	}
}
