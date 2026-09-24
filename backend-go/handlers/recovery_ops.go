package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

func RegisterRecoveryOps(r chi.Router, db *core.DB) {
	base := core.RequirePages("recovery")
	assign := core.RequirePages("recovery_assign")
	writeOff := core.RequirePages("recovery_write_off")

	r.With(base).Get("/cases", recoveryOpsCases(db))
	r.With(base).Get("/repayment-pattern", repaymentPatternHandler(db))
	r.With(base).Get("/cases/{id}", recoveryOpsCaseDetail(db))
	r.With(base).Get("/cases/{id}/full", recoveryOpsCaseDetailFull(db))
	r.With(assign).Put("/cases/{id}/assign", recoveryOpsAssign(db))
	r.With(base).Post("/cases/{id}/payment", recoveryOpsPayment(db))
	r.With(base).Post("/cases/{id}/legal", recoveryOpsAddLegal(db))
	r.With(base).Put("/legal/{lid}/status", recoveryOpsUpdateLegal(db))
	r.With(base).Get("/visits", recoveryOpsVisitsList(db))
	r.With(base).Post("/cases/{id}/visit", recoveryOpsVisit(db))
	r.With(base).Post("/cases/{id}/write-off", recoveryOpsWriteOff(db))
	r.With(writeOff).Put("/write-off/{wid}/approve", recoveryOpsApproveWriteOff(db))
	r.With(writeOff).Put("/write-off/{wid}/reject", recoveryOpsRejectWriteOff(db))
	r.With(base).Get("/payments/pending", recoveryOpsPendingPayments(db))
	r.With(base).Put("/payments/{pid}/approve", recoveryOpsApprovePayment(db))
	r.With(base).Put("/payments/{pid}/reject", recoveryOpsRejectPayment(db))
	r.With(base).Put("/payments/{pid}/reverse", recoveryOpsReversePayment(db))
	r.With(base).Get("/dashboard", recoveryOpsDashboard(db))
	r.With(base).Get("/agent-dashboard", recoveryOpsAgentDashboard(db))
	r.With(base).Get("/agents", recoveryOpsAgents(db))
	r.With(assign).Post("/generate-cases", recoveryOpsGenerateCases(db))
	r.With(assign).Post("/cases", recoveryOpsOpenCase(db))
}

// recoveryOpsAgents returns the staff who can own recovery cases. As with Collections,
// there may be no users holding a dedicated recovery role yet, so the pool is broadened
// to any recovery/collections/call-centre operative plus admin/management — otherwise
// the assign dropdown would be permanently empty. Read by the Cases page.
func recoveryOpsAgents(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, full_name, role
			FROM o3c_users
			WHERE is_active = TRUE
			  AND (role ILIKE '%recovery%' OR role ILIKE '%collection%' OR role ILIKE '%call_center%'
			       OR role IN ('admin','management','coo','head_ops','md'))
			ORDER BY full_name`)
		if err != nil {
			respondErrLog(w, 500, "recovery agents query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// escalateSevereToRecovery opens a recovery case for every customer at/beyond minDPD
// in the unified delinquency book who is not already in an open case, then moves any
// active collection assignment for an in-recovery customer to 'sent_to_recovery' so
// the account leaves the collections queue (mirroring the manual per-account hand-off).
// Returns the number of NEW cases opened. Idempotent and self-healing — the second
// UPDATE also cleans up accounts escalated before this coupling existed. Shared by the
// head's "Generate Cases" button and the nightly auto-escalation worker.
//
// THIS FUNCTION RUNS UNATTENDED AT 02:00 AND WHAT IT WRITES IS A LEGAL RECOVERY FILE.
// It used to read app.collections_delinquent_unified with `GROUP BY v.cif` and write
// v.cif into recovery_cases.cif_number AND .account_cif. The view's Udara branch is keyed
// by cbs_loans.cbs_customer_id and its card branch by app.customers.cif — the same
// 8-digit strings, different people — so that GROUP BY merged two strangers' debts and the
// INSERT filed the result in the cards namespace. Every later
// `JOIN app.customers ON cif = account_cif` then named the card customer. That is how
// RC-001066 came to pursue a card customer for N262,480,000 owed by FOLTI TECHNOLOGIES,
// opened by this worker at 02:00:00.047 with nobody watching.
//
// Three things now make that outcome unreachable rather than merely unlikely:
//
//  1. The book is read through armSplitDelinquency, so a candidate carries exactly one
//     arm's money under exactly one arm's id — the arms are never summed, never share a
//     key space, and a Udara key is stored namespaced as 'UD-<cbs_customer_id>'.
//  2. A Udara candidate must have a party resolved through app.cbs_links. No link, no
//     case: udaraIdentityResolved drops it rather than file it against a guess.
//  3. A Udara candidate is refused outright while ANY open recovery case still holds its
//     bare id in the cards namespace. Such a case names a different person for this same
//     debt; opening the correct case beside it would double-book the debt and leave the
//     wrong person in an open file. The gate clears itself as soon as those rows are
//     corrected — it blocks nothing permanently.
//
// Every refusal is logged at Error with the ids and the money BEFORE any row is written,
// so a short run is never a silent one.
// Returns (cases opened, candidates refused).
func escalateSevereToRecovery(ctx context.Context, db *core.DB, minDPD int) (int64, int64, error) {
	// A Udara candidate is blocked while an open case holds its BARE id — that is, a case
	// filed in the cards namespace for what is really this borrower's debt.
	const crossedCaseOpen = `EXISTS (
		SELECT 1 FROM recovery_cases rc
		 WHERE b.arm = 'udara' AND rc.account_cif = b.raw_cif
		   AND NOT (COALESCE(rc.data_source,'') = 'udara' OR rc.account_cif LIKE '` + udaraCIFPrefix + `%')
		   AND rc.status NOT IN ('closed','recovered','written_off'))`

	// Report before writing: everything this run will refuse, with the ids and the money.
	refusals, rErr := db.PGQuery(ctx, armSplitDelinquency+`
		SELECT b.arm, b.raw_cif, b.key_cif, b.dpd, b.outstanding_kobo,
		       (b.arm = 'udara' AND b.party_id IS NULL) AS unlinked,
		       COALESCE(NULLIF(TRIM(cc.name),''), NULLIF(TRIM(p.full_name),''), b.raw_cif) AS borrower,
		       (SELECT rc.case_ref FROM recovery_cases rc
		         WHERE b.arm = 'udara' AND rc.account_cif = b.raw_cif
		           AND NOT (COALESCE(rc.data_source,'') = 'udara' OR rc.account_cif LIKE '`+udaraCIFPrefix+`%')
		           AND rc.status NOT IN ('closed','recovered','written_off')
		         ORDER BY rc.opened_at DESC LIMIT 1) AS crossed_case_ref
		  FROM book b
		  LEFT JOIN app.cbs_customers cc ON b.arm = 'udara' AND cc.cbs_customer_id = b.raw_cif
		  LEFT JOIN app.parties p ON p.party_id = b.party_id
		 WHERE b.dpd >= $1
		   AND NOT (`+udaraIdentityResolved+` AND NOT `+crossedCaseOpen+`)
		 ORDER BY b.outstanding_kobo DESC`, minDPD)
	if rErr != nil {
		return 0, 0, rErr
	}
	for _, f := range refusals {
		reason := "an open recovery case still holds this borrower's bare Udara id in the cards namespace — that case names a different person for this debt"
		if str(f["crossed_case_ref"]) == "" {
			reason = "no app.cbs_links bridge for this Udara customer id — there is no party this debt can be filed against"
		}
		slog.Error("recovery escalation REFUSED to open a case",
			"reason", reason,
			"arm", str(f["arm"]),
			"cbs_customer_id", str(f["raw_cif"]),
			"would_be_key", str(f["key_cif"]),
			"borrower", str(f["borrower"]),
			"crossed_case_ref", str(f["crossed_case_ref"]),
			"dpd", toInt64(f["dpd"]),
			"outstanding_kobo", toInt64(f["outstanding_kobo"]))
	}

	res, err := db.PG.ExecContext(ctx, armSplitDelinquency+`
		, sev AS (
			SELECT b.*,
			       -- source_assignment_id is the only trail from a recovery case back to
			       -- the collections row it came from. Looking only at 'active' rows broke
			       -- it: an assignment that has been escalated is 'sent_to_recovery' —
			       -- which is precisely the row that fed the case — so the subquery
			       -- returned NULL and the link was never written.
			       --
			       -- Measured 2026-09-23: 1,036 in-app cases carry no source. 982 of them
			       -- have a collections row on the same key, 959 of those rows predate the
			       -- case, and 955 are sitting in 'sent_to_recovery'. So the relationship
			       -- existed and was simply not recorded, for about 95% of every case
			       -- recovery has ever opened from the queue.
			       (SELECT ca.id FROM collection_assignments ca
			         WHERE ca.account_cif = b.key_cif
			           AND ca.status IN ('active','sent_to_recovery')
			         ORDER BY (ca.status = 'active') DESC, ca.updated_at DESC LIMIT 1) AS assignment_id
			  FROM book b
			 WHERE b.dpd >= $1
			   AND `+udaraIdentityResolved+`
			   AND NOT `+crossedCaseOpen+`
		)
		INSERT INTO recovery_cases
		  (case_ref, cif_number, account_cif, customer_name, party_id, data_source, product_type,
		   outstanding_kobo, total_outstanding_kobo,
		   source_assignment_id, dpd_at_handoff, status, opened_at, created_at, updated_at)
		SELECT 'RC-' || LPAD(NEXTVAL('sar_ref_seq')::TEXT, 6, '0'),
		       s.key_cif, s.key_cif, s.customer_name, s.party_id, s.data_source, s.product_type,
		       s.outstanding_kobo, s.outstanding_kobo,
		       -- 'active' (not 'open') to match the UI's status vocabulary + filter.
		       s.assignment_id, s.dpd::text, 'active', NOW(), NOW(), NOW()
		FROM sev s
		WHERE NOT EXISTS (
			SELECT 1 FROM recovery_cases rc
			WHERE rc.account_cif = s.key_cif AND rc.status NOT IN ('closed','recovered','written_off')
		)`, minDPD)
	if err != nil {
		return 0, int64(len(refusals)), err
	}
	created, _ := res.RowsAffected()

	// Take every active collection assignment that is now in an open recovery case out
	// of the collections queue, so no account is worked by both teams at once.
	//
	// The delinquency condition is essential and was missing. Without it this swept out
	// any account whose customer had ANY open case, regardless of whether the debt was
	// still severe — and because nothing closes a case when a debt cures, that exit was
	// permanent and re-applied every night. The queue therefore drained to nothing
	// (0 active assignments survived), and re-assigning an account by hand was undone
	// within 24 hours. An account only leaves collections while it is genuinely at or
	// beyond the escalation threshold.
	if _, err := db.PG.ExecContext(ctx, `
		UPDATE collection_assignments ca
		   SET status = 'sent_to_recovery', updated_at = NOW()
		 WHERE ca.status = 'active'
		   AND NOT `+udaraCrossedRows("ca")+`
		   AND EXISTS (SELECT 1 FROM recovery_cases rc
		               WHERE rc.account_cif = ca.account_cif
		                 AND rc.status NOT IN ('closed','recovered','written_off'))
		   AND EXISTS (SELECT 1 FROM app.collections_delinquent_unified v
		               WHERE v.cif = ca.account_cif
		                 AND v.dpd >= $1)`, minDPD); err != nil {
		return created, int64(len(refusals)), err
	}

	// Close cases whose debt has cured. Nothing else in the system ever closes a case —
	// the only other exit is a write-off approval — so an open case was effectively
	// permanent. That is what made the sweep above one-way: it keys on "an open case
	// exists", so a customer who paid off months ago could never return to collections,
	// and their balance kept inflating every recovery figure. 558 open cases belong to
	// customers with no delinquency at all.
	//
	// Legal cases are deliberately exempt. A matter under legal proceedings ends by
	// judgment, settlement or write-off — not because today's delinquency feed stopped
	// listing the customer, which it may do for reasons that have nothing to do with the
	// debt being paid. 63 such cases stay open by this rule.
	//
	// Ordering against the sweep does not matter: the sweep now carries its own DPD
	// guard, so a cured account cannot be swept out regardless of which runs first.
	// Requires migration 258 (closed_reason).
	if _, err := db.PG.ExecContext(ctx, `
		UPDATE recovery_cases rc
		   SET status        = 'closed',
		       closed_at     = NOW(),
		       updated_at    = NOW(),
		       closed_reason = 'cured — no delinquency on the book'
		 WHERE rc.status NOT IN ('closed','recovered','written_off','legal')
		   AND rc.account_cif IS NOT NULL
		   AND NOT EXISTS (SELECT 1 FROM app.collections_delinquent_unified v
		                   WHERE v.cif = rc.account_cif)`); err != nil {
		return created, int64(len(refusals)), err
	}
	return created, int64(len(refusals)), nil
}

// recoveryOpsGenerateCases is Recovery's analogue of Collections' generate-assignments:
// a head-triggered bulk seed at DPD >= min_dpd (default 90). Idempotent. The nightly
// worker (ScheduleRecoveryEscalation) does the same automatically.
func recoveryOpsGenerateCases(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		minDPD := qint(r, "min_dpd", 90, 1, 100000)
		created, refused, err := escalateSevereToRecovery(r.Context(), db, minDPD)
		if err != nil {
			respondErrLog(w, 500, "generate recovery cases failed", err)
			return
		}
		// `refused` is surfaced to the head who pressed the button, not just to the log:
		// a run that opens fewer cases than the book implies must say why on the screen.
		respond(w, core.Row{"created": created, "refused": refused, "min_dpd": minDPD}, "pg")
	}
}

// recoveryOpsOpenCase manually moves a specific customer into recovery, regardless of
// DPD — for the accounts a head decides to pull in by hand. Idempotent: returns the
// existing open case if there is one. Pulls the outstanding/DPD snapshot from the
// delinquency view when available, and takes the account out of the collections queue.
//
// The id in the request body is a KEY, not necessarily a cards CIF. A Udara borrower is
// named as 'UD-<cbs_customer_id>'; a bare id is read as a cards CIF, which is what every
// caller has always meant. A bare id that is really a delinquent Udara borrower is
// REFUSED with a 409 naming the borrower and the key to use instead — typing eight digits
// into a box must not be able to open a legal file against whoever happens to hold those
// digits in the other namespace.
func recoveryOpsOpenCase(db *core.DB) http.HandlerFunc {
	type body struct {
		CIF string `json:"cif"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		key := strings.TrimSpace(b.CIF)
		if key == "" {
			respondErr(w, 400, "cif is required")
			return
		}
		ctx := r.Context()
		cardsCIF, udaraCIF := splitCIFKey(key)

		if borrower, gErr := udaraBorrowerFor(ctx, db, key); gErr != nil {
			respondErrLog(w, 500, "identity namespace check failed", gErr)
			return
		} else if borrower != "" {
			user := core.UserFromCtx(ctx)
			actor := int64(0)
			if user != nil {
				actor = user.ID
			}
			slog.Error("manual recovery case REFUSED — bare Udara customer id supplied as a cards CIF",
				"supplied_cif", key, "udara_borrower", borrower, "suggested_key", udaraCIFPrefix+key, "actor_id", actor)
			respondErr(w, 409, fmt.Sprintf(
				"%s is a Udara customer id (borrower: %s), not a cards CIF — opening a case on it would name a different person. Use %s%s to open the case against the borrower.",
				key, borrower, udaraCIFPrefix, key))
			return
		}

		if rows, _ := db.PGQuery(ctx, `SELECT id, case_ref FROM recovery_cases
			WHERE account_cif = $1 AND status NOT IN ('closed','recovered','written_off')
			ORDER BY opened_at DESC LIMIT 1`, key); len(rows) > 0 {
			respond(w, core.Row{"case_id": rows[0]["id"], "case_ref": rows[0]["case_ref"], "existing": true}, "pg")
			return
		}

		// Snapshot one arm of the book only, so the opening balance is this borrower's
		// debt and not theirs plus a stranger's.
		var outstanding int64
		var dpd int
		if rows, _ := db.PGQuery(ctx, `SELECT COALESCE(MAX(v.dpd),0) AS dpd, COALESCE(SUM(v.outstanding_kobo),0) AS outstanding
			FROM app.collections_delinquent_unified v
			WHERE CASE WHEN $2 <> '' THEN
			           v.cif = $2 AND v.source = 'loan' AND v.product_name <> 'Loan (uploaded)'
			      ELSE v.cif = $1 AND NOT (v.source = 'loan' AND v.product_name <> 'Loan (uploaded)')
			      END`, cardsCIF, udaraCIF); len(rows) > 0 {
			dpd = int(toInt64(rows[0]["dpd"]))
			outstanding = toInt64(rows[0]["outstanding"])
		}

		caseRef, caseID, err := openRecoveryCase(ctx, db, key, strconv.Itoa(dpd), outstanding, nil)
		if err != nil {
			respondErrLog(w, 500, "open recovery case failed", err)
			return
		}
		// openRecoveryCase writes only the key; stamp the party and the arm on the row so
		// the case is never read back through the wrong namespace.
		stampCaseIdentity(ctx, db, caseID, key)

		// Take the account out of the collections queue if it was being worked there.
		db.PG.ExecContext(ctx, `UPDATE collection_assignments SET status='sent_to_recovery', updated_at=NOW()
			WHERE account_cif=$1 AND status='active'`, key) //nolint:errcheck

		respond(w, core.Row{"case_id": caseID, "case_ref": caseRef, "existing": false}, "pg")
	}
}

// ScheduleRecoveryEscalation runs daily at 02:00 and automatically opens recovery
// cases for any account that has crossed 90 DPD and is not already in recovery,
// moving it out of the collections queue. Manual hand-off still works alongside it:
// per-account "Send to Recovery" in Collections, the head's "Generate Cases" bulk
// button, and "Add Customer" for a specific CIF.
func ScheduleRecoveryEscalation(db *core.DB) {
	now := time.Now()
	next := time.Date(now.Year(), now.Month(), now.Day(), 2, 0, 0, 0, now.Location())
	if now.After(next) {
		next = next.Add(24 * time.Hour)
	}
	time.Sleep(next.Sub(now))
	for {
		runRecoveryEscalation(db)
		time.Sleep(24 * time.Hour)
	}
}

func runRecoveryEscalation(db *core.DB) {
	ctx := context.Background()
	WorkerBeat(ctx, db, "recovery_escalation", "running", "", "")
	created, refused, err := escalateSevereToRecovery(ctx, db, 90)
	if err != nil {
		slog.Error("recovery auto-escalation failed", "err", err)
		WorkerBeat(ctx, db, "recovery_escalation", "error", err.Error(), "")
		return
	}
	slog.Info("recovery auto-escalation swept", "cases_opened", created, "refused_identity", refused)
	// A refusal is a case that SHOULD have opened and did not, because the debt could not
	// be tied to a party without naming the wrong one. The heartbeat still beats 'ok' —
	// the worker itself is healthy and a red heartbeat would read as "the 02:00 job is
	// down" — but the detail line says so in as many words, and every refused candidate
	// is already in the Error log above with its ids and its money. The loud channel is
	// the Error log; this is the trail a head reads the next morning.
	msg := fmt.Sprintf("%d case(s) opened at 90+ DPD", created)
	if refused > 0 {
		msg = fmt.Sprintf("%d case(s) opened at 90+ DPD; %d REFUSED on identity — see the error log for the ids", created, refused)
	}
	WorkerBeat(ctx, db, "recovery_escalation", "ok", msg, "")
}

// settledSinceHandoffSQL yields a lateral exposing `stl.settled_since_handoff`:
// "nothing left to chase", so an agent stops calling a customer who has already paid.
//
// This is deliberately a DISPLAY flag and NOT a correction of the figure.
// recovery_cases.outstanding_kobo is the balance AS AT HAND-OFF and is meant to stay
// frozen: a case's live position is outstanding − recovered − written_off, and recovery's
// own receipts decrement it (see the payment-logging and write-off approval paths).
// Refreshing that column from the live card balance would subtract every payment twice,
// because the card balance has already fallen by the same amount.
//
// The `last_payment_date > opened_at` guard is the whole point of the rule. A zero card
// balance on its own means nothing: most zero balances among open cases belong to cases
// in LEGAL whose card account left the book years after the customer last paid, and
// flagging those as settled would invite an agent to close real, collectable debt.
// Requiring a payment dated AFTER the hand-off narrows it to customers who actually
// cleared the balance while in recovery — 5 cases when this was written, not 500.
//
// Joined on the guarded cards key, so a Udara case never reads a card customer's balance.
func settledSinceHandoffSQL(alias string) string {
	return `LEFT JOIN LATERAL (
			    SELECT (COUNT(*) > 0
			            AND COALESCE(SUM(GREATEST(a3.current_dr_balance, 0)), 0) <= 0
			            AND MAX(a3.last_payment_date) IS NOT NULL
			            AND MAX(a3.last_payment_date) > ` + alias + `.opened_at::date) AS settled_since_handoff
			    FROM app.accounts a3 WHERE a3.cif = ` + cardsKeySQL(alias) + `
			) stl ON TRUE`
}

func recoveryOpsCases(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		status := qstr(r, "status")
		legalStage := qstr(r, "legal_stage")
		productType := qstr(r, "product_type") // 'card' | 'loan'
		agentID := qstr(r, "agent_id")
		q := qstr(r, "q")
		from := qstr(r, "from")
		to := qstr(r, "to")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		// Identity comes off the row through debtorJoinsSQL: the party behind party_id,
		// the Udara customer master for a 'UD-' key, app.customers for a cards key and
		// ONLY for a cards key. Everything cards-shaped below — address, city, state,
		// phone, and the `bill` and `lc` laterals — hangs off that same guarded key, so a
		// Udara case shows blanks where card data would be rather than a card customer's
		// address and phone number under a loan customer's debt.
		query := `
			SELECT rc.id, rc.case_ref, rc.account_cif,
			       ` + debtorNameSQL("rc") + ` AS customer_name,
			       COALESCE(rc.product_type,'card') AS product_type,
			       COALESCE(rc.data_source,'core') AS data_source,
			       rc.officer_name, rc.loan_ref, rc.loan_amount_kobo, rc.maturity_date,
			       rc.assigned_agent_id,
			       u.full_name AS agent_name, rc.assigned_by, rc.legal_stage,
			       rc.outstanding_kobo, rc.recovered_kobo, rc.write_off_amount_kobo,
			       rc.status, rc.opened_at, rc.closed_at, rc.created_at, rc.updated_at,
			       -- Per-row enrichment: clean address, card billing, last payment and
			       -- the collections agent who worked it before hand-off — same picture
			       -- Customer 360 carries. app.accounts money is NAIRA, not kobo.
			       COALESCE(NULLIF(TRIM(c.full_address),''),
			                NULLIF(TRIM(CONCAT_WS(', ', NULLIF(c.address_1,''), NULLIF(c.address_2,''), NULLIF(c.city,''), NULLIF(c.state,''))),'')) AS full_address,
			       c.city, c.state, c.phone,
			       bill.current_dr_balance AS current_bill,
			       bill.cycle_balance      AS bill_balance,
			       bill.min_payment_due    AS min_payment,
			       bill.card_limit         AS credit_limit,
			       bill.last_amount_paid   AS last_payment_amount,
			       bill.last_payment_date,
			       col.collections_agent_name,
			       lc.agent_name  AS last_call_agent,
			       lc.started_at::text AS last_call_at,
			       COALESCE(stl.settled_since_handoff, FALSE) AS settled_since_handoff
			FROM recovery_cases rc
			LEFT JOIN o3c_users u ON rc.assigned_agent_id = u.id
			` + debtorJoinsSQL("rc") + `
			LEFT JOIN LATERAL (
			    SELECT a2.current_dr_balance, a2.cycle_balance, a2.min_payment_due,
			           a2.card_limit, a2.last_amount_paid,
			           a2.last_payment_date::text AS last_payment_date
			    FROM app.accounts a2 WHERE a2.cif = ` + cardsKeySQL("rc") + `
			    ORDER BY (LOWER(a2.status) IN ('active','open')) DESC LIMIT 1
			) bill ON TRUE
			LEFT JOIN LATERAL (
			    SELECT cu.full_name AS collections_agent_name
			    FROM collection_assignments ca2
			    LEFT JOIN o3c_users cu ON cu.id = ca2.agent_user_id
			    WHERE ca2.account_cif = rc.account_cif AND ca2.status = 'active'
			    ORDER BY ca2.updated_at DESC LIMIT 1
			) col ON TRUE
			-- Last call-centre call for this customer. helpdesk_calls.customer_cif is a
			-- CARDS cif, so this is matched through the guarded cards key: a Udara case
			-- shows no last call rather than a stranger's.
			LEFT JOIN LATERAL (
			    SELECT h.agent_name, h.started_at
			    FROM app.helpdesk_calls h
			    WHERE h.customer_cif = ` + cardsKeySQL("rc") + `
			      AND h.merged_into_call_id IS NULL AND h.voided_at IS NULL
			    ORDER BY h.started_at DESC LIMIT 1
			) lc ON TRUE
			` + settledSinceHandoffSQL("rc") + `
			WHERE 1=1`
		args := []any{}
		n := 1
		where := ""

		// Individual agents see only their own cases; heads/managers see all.
		if !user.HasPage("recovery_assign") {
			where += fmt.Sprintf(" AND rc.assigned_agent_id = $%d", n)
			args = append(args, user.ID)
			n++
		}

		if status != "" {
			vals := strings.Split(status, ",")
			placeholders := make([]string, len(vals))
			for i, v := range vals {
				placeholders[i] = fmt.Sprintf("$%d", n)
				args = append(args, strings.TrimSpace(v))
				n++
			}
			where += " AND rc.status IN (" + strings.Join(placeholders, ",") + ")"
		}
		if legalStage != "" {
			where += fmt.Sprintf(" AND rc.legal_stage = $%d", n)
			args = append(args, legalStage)
			n++
		}
		if productType != "" {
			where += fmt.Sprintf(" AND COALESCE(rc.product_type,'card') = $%d", n)
			args = append(args, productType)
			n++
		}
		if agentID != "" {
			where += fmt.Sprintf(" AND rc.assigned_agent_id = $%d", n)
			args = append(args, agentID)
			n++
		}
		if q != "" {
			// Search must cover the SAME name the row DISPLAYS, which now comes off any of
			// three sources depending on the arm — rc.customer_name, the party behind
			// party_id, the Udara customer master, or app.customers — so all four are
			// searched. Searching only the app.customers name would return zero hits for
			// every Udara case, whose displayed name never comes from there.
			if clause, sargs, nn := buildCustomerSearch(q,
				[]string{"rc.account_cif", "rc.customer_name", "pty.full_name", "cbs.name", "CONCAT(c.first_name,' ',c.last_name)", "rc.officer_name", "rc.loan_ref"},
				// Phone search must reach the arm that actually holds one: a Udara case has
				// no app.customers row, so c.phone alone made every loan borrower
				// unsearchable by number.
				"COALESCE(NULLIF(cbs.phone,''), NULLIF(pty.primary_phone,''), c.phone)", n); clause != "" {
				where += " AND " + clause
				args = append(args, sargs...)
				n = nn
			}
		}
		if from != "" {
			where += fmt.Sprintf(" AND rc.opened_at::date >= $%d", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			where += fmt.Sprintf(" AND rc.opened_at::date <= $%d", n)
			args = append(args, to)
			n++
		}

		// Total matching the current filters (before pagination) so the UI shows the
		// whole queue size, not just the current page.
		total := 0
		// Must carry the SAME identity joins as the list query — the search clause above
		// matches pty/cbs/c, so the count query needs all three or it 500s on an unknown
		// alias (and would otherwise miss the same rows).
		if crows, cerr := db.PGQuery(r.Context(),
			`SELECT COUNT(*) AS n FROM recovery_cases rc
			 `+debtorJoinsSQL("rc")+`
			 WHERE 1=1`+where, args...); cerr == nil && len(crows) > 0 {
			total = int(toInt64(crows[0]["n"]))
		}

		query += where + fmt.Sprintf(" ORDER BY rc.updated_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respondPaginated(w, rows, total, "pg")
	}
}

func recoveryOpsCaseDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		ctx := r.Context()

		cases, err := db.PGQuery(ctx, `
			SELECT rc.*, u.full_name AS agent_name,
			       COALESCE(stl.settled_since_handoff, FALSE) AS settled_since_handoff
			FROM recovery_cases rc
			LEFT JOIN o3c_users u ON rc.assigned_agent_id = u.id
			`+settledSinceHandoffSQL("rc")+`
			WHERE rc.id = $1`, id)
		if err != nil || len(cases) == 0 {
			respondErr(w, 404, "Case not found")
			return
		}

		payments, _ := db.PGQuery(ctx, `
			SELECT * FROM recovery_payments WHERE case_id = $1 AND status = 'approved' ORDER BY payment_date DESC`, id)
		proceedings, _ := db.PGQuery(ctx, `
			SELECT * FROM legal_proceedings WHERE case_id = $1 ORDER BY filing_date DESC`, id)
		visits, _ := db.PGQuery(ctx, `
			SELECT rfv.*, u.full_name AS agent_name
			FROM recovery_field_visits rfv
			LEFT JOIN o3c_users u ON rfv.agent_user_id = u.id
			WHERE rfv.case_id = $1 ORDER BY rfv.visit_date DESC`, id)
		writeoffs, _ := db.PGQuery(ctx, `
			SELECT * FROM recovery_write_off_approvals WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`, id)

		nilToEmpty := func(rows []core.Row) []core.Row {
			if rows == nil {
				return []core.Row{}
			}
			return rows
		}

		result := map[string]any{
			"case":        cases[0],
			"payments":    nilToEmpty(payments),
			"proceedings": nilToEmpty(proceedings),
			"visits":      nilToEmpty(visits),
		}
		if len(writeoffs) > 0 {
			result["write_off_approval"] = writeoffs[0]
		} else {
			result["write_off_approval"] = nil
		}

		respond(w, result, "pg")
	}
}

// recoveryOpsCaseDetailFull returns everything recoveryOpsCaseDetail returns, plus
// the full cross-team credit_activity_log for the account CIF so agents can see
// the complete lifecycle including the collections phase.
func recoveryOpsCaseDetailFull(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		ctx := r.Context()

		cases, err := db.PGQuery(ctx, `
			SELECT rc.*, u.full_name AS agent_name, au.full_name AS assigned_by_name
			FROM recovery_cases rc
			LEFT JOIN o3c_users u  ON rc.assigned_agent_id = u.id
			LEFT JOIN o3c_users au ON rc.assigned_by = au.id
			WHERE rc.id = $1`, id)
		if err != nil || len(cases) == 0 {
			respondErr(w, 404, "Case not found")
			return
		}

		cif := fmt.Sprint(cases[0]["account_cif"])

		payments, _ := db.PGQuery(ctx, `SELECT rp.*, u.full_name AS agent_name FROM recovery_payments rp LEFT JOIN o3c_users u ON rp.agent_user_id = u.id WHERE rp.case_id = $1 ORDER BY rp.payment_date DESC`, id)
		proceedings, _ := db.PGQuery(ctx, `SELECT * FROM legal_proceedings WHERE case_id = $1 ORDER BY filing_date DESC`, id)
		visits, _ := db.PGQuery(ctx, `
			SELECT rfv.*, u.full_name AS agent_name
			FROM recovery_field_visits rfv
			LEFT JOIN o3c_users u ON rfv.agent_user_id = u.id
			WHERE rfv.case_id = $1 ORDER BY rfv.visit_date DESC`, id)
		writeoffs, _ := db.PGQuery(ctx, `
			SELECT rwo.*, u.full_name AS approver_name
			FROM recovery_write_off_approvals rwo
			LEFT JOIN o3c_users u ON rwo.approved_by = u.id
			WHERE rwo.case_id = $1 ORDER BY rwo.created_at DESC LIMIT 1`, id)

		// Full cross-team activity log for this CIF (collections + recovery phases,
		// incl. the write-off request + every approval stage).
		//
		// The real columns are `description`, `ts` and `actor_name` — this query used to
		// select `detail`, `created_at` and join on `actor_user_id`, none of which exist,
		// so it errored on every call and the case showed NO activity. Aliased back to the
		// field names the frontend expects.
		activityLog, _ := db.PGQuery(ctx, `
			SELECT cal.id, cal.module, cal.entity_type, cal.entity_id, cal.account_cif,
			       cal.action, cal.description AS detail, cal.ts AS created_at, cal.actor_name
			FROM credit_activity_log cal
			WHERE cal.account_cif = $1
			ORDER BY cal.ts DESC
			LIMIT 200`, cif)

		// Collections-phase contacts and promises for context
		contacts, _ := db.PGQuery(ctx, `
			SELECT cc.*, u.full_name AS agent_name
			FROM collection_contacts cc
			LEFT JOIN o3c_users u ON cc.agent_user_id = u.id
			WHERE cc.cif_number = $1 ORDER BY cc.created_at DESC LIMIT 50`, cif)
		promises, _ := db.PGQuery(ctx, `
			SELECT cp.*, u.full_name AS agent_name
			FROM collection_promises cp
			LEFT JOIN o3c_users u ON cp.agent_user_id = u.id
			WHERE cp.cif_number = $1 ORDER BY cp.promised_date DESC LIMIT 20`, cif)

		// Debtor identity + live delinquency snapshot. This is the page a recovery
		// officer reads before they call, visit or instruct a solicitor, so getting the
		// person wrong here is the whole failure: it used to read
		// `FROM app.customers WHERE c.cif = <account_cif>` unconditionally, which for a
		// Udara case returned the CARD customer sharing the id — their name, their phone,
		// their home address, their card billing — printed over a loan customer's debt.
		//
		// The identity is now resolved in the case's own namespace. splitCIFKey decides
		// which; the cards branch ($2) reaches app.customers and app.accounts, the Udara
		// branch ($3) reaches cbs_customers and the linked party, and neither can fire for
		// the other's key. A Udara case shows no card billing because it has none.
		cardsCIF, udaraCIF := splitCIFKey(cif)
		customer := core.Row{}
		if crows, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(TRIM(cbs.name),''), NULLIF(TRIM(p.full_name),''),
			                NULLIF(TRIM(CONCAT(COALESCE(c.first_name,''),' ',COALESCE(c.last_name,''))),'')) AS name,
			       COALESCE(NULLIF(cbs.phone,''), NULLIF(p.primary_phone,''), c.phone) AS phone,
			       COALESCE(NULLIF(cbs.email,''), NULLIF(p.primary_email,''), c.email) AS email,
			       COALESCE(NULLIF(cbs.state,''), c.state) AS state,
			       COALESCE(NULLIF(cbs.city,''),  c.city)  AS city,
			       COALESCE(NULLIF(TRIM(cbs.address),''),
			                NULLIF(TRIM(c.full_address),''),
			                NULLIF(TRIM(CONCAT_WS(', ', NULLIF(c.address_1,''), NULLIF(c.address_2,''), NULLIF(c.city,''), NULLIF(c.state,''))),'')) AS full_address,
			       bill.current_dr_balance AS current_bill,
			       bill.cycle_balance      AS bill_balance,
			       bill.min_payment_due    AS min_payment,
			       bill.card_limit         AS credit_limit,
			       bill.last_amount_paid   AS last_payment_amount,
			       bill.last_payment_date::text AS last_payment_date
			FROM (SELECT 1) base
			LEFT JOIN app.customers c     ON $1 <> '' AND c.cif = $1
			LEFT JOIN app.cbs_customers cbs ON $2 <> '' AND cbs.cbs_customer_id = $2
			LEFT JOIN app.cbs_links lk    ON $2 <> '' AND lk.entity_type = 'party' AND lk.cbs_customer_id = $2
			LEFT JOIN app.parties p       ON p.party_id = lk.entity_id
			LEFT JOIN LATERAL (
			    SELECT a2.current_dr_balance, a2.cycle_balance, a2.min_payment_due,
			           a2.card_limit, a2.last_amount_paid, a2.last_payment_date
			    FROM app.accounts a2 WHERE a2.cif = c.cif
			    ORDER BY (LOWER(a2.status) IN ('active','open')) DESC LIMIT 1
			) bill ON TRUE
			LIMIT 1`, cardsCIF, udaraCIF); len(crows) > 0 {
			customer = crows[0]
		}
		// One arm of the book only: summing both branches for a colliding id is what put
		// two people's debts behind one number in the first place.
		var dpdCurrent, bookOutstanding int64
		if drows, _ := db.PGQuery(ctx, `SELECT COALESCE(MAX(v.dpd),0) AS dpd, COALESCE(SUM(v.outstanding_kobo),0) AS outstanding
			FROM app.collections_delinquent_unified v
			WHERE CASE WHEN $2 <> '' THEN
			           v.cif = $2 AND v.source = 'loan' AND v.product_name <> 'Loan (uploaded)'
			      ELSE v.cif = $1 AND NOT (v.source = 'loan' AND v.product_name <> 'Loan (uploaded)')
			      END`, cardsCIF, udaraCIF); len(drows) > 0 {
			dpdCurrent = toInt64(drows[0]["dpd"])
			bookOutstanding = toInt64(drows[0]["outstanding"])
		}
		// The borrower's actual Udara facilities behind the debt. cbs_loans is keyed by
		// cbs_customer_id, so feeding it a cards CIF listed a stranger's loans on a card
		// customer's case — the same collision running the other way. It is now asked only
		// for a Udara case, with the bare Udara id.
		loans, _ := db.PGQuery(ctx, `
			SELECT cbs_account_number AS reference, product_name, status,
			       outstanding_principal_kobo AS outstanding_kobo, loan_amount_kobo,
			       start_date, maturity_date
			FROM cbs_loans WHERE $1 <> '' AND cbs_customer_id = $1
			ORDER BY outstanding_principal_kobo DESC`, udaraCIF)

		nilToEmpty := func(rows []core.Row) []core.Row {
			if rows == nil {
				return []core.Row{}
			}
			return rows
		}

		result := map[string]any{
			"case":                  cases[0],
			"customer":              customer,
			"dpd_current":           dpdCurrent,
			"book_outstanding_kobo": bookOutstanding,
			"loans":                 nilToEmpty(loans),
			"payments":              nilToEmpty(payments),
			"proceedings":           nilToEmpty(proceedings),
			"visits":                nilToEmpty(visits),
			"activity_log":          nilToEmpty(activityLog),
			"coll_contacts":         nilToEmpty(contacts),
			"coll_promises":         nilToEmpty(promises),
		}
		if len(writeoffs) > 0 {
			result["write_off_approval"] = writeoffs[0]
		} else {
			result["write_off_approval"] = nil
		}

		respond(w, result, "pg")
	}
}

func recoveryOpsAssign(db *core.DB) http.HandlerFunc {
	type body struct {
		AgentID int64  `json:"agent_id"`
		Notes   string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AgentID == 0 {
			respondErr(w, 422, "agent_id is required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		rows, err := db.PGQuery(ctx, `SELECT id FROM recovery_cases WHERE id = $1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Case not found")
			return
		}

		_, err = db.PGExec(ctx, `
			UPDATE recovery_cases
			SET assigned_agent_id = $1, assigned_by = $2, updated_at = NOW()
			WHERE id = $3`,
			b.AgentID, user.ID, id)
		if err != nil {
			respondErr(w, 500, "Assign failed")
			return
		}

		sendNotification(ctx, db, b.AgentID, "recovery_assigned", //nolint:errcheck
			"Recovery Case Assigned",
			fmt.Sprintf("A recovery case has been assigned to you"),
			"recovery_case", id)

		go NotifyRole(context.Background(), db, "recovery_head", NotifPayload{
			EventType: EvtRecoveryCaseAssigned,
			Title:     "Recovery Case Assigned",
			Body:      fmt.Sprintf("Case #%d now has an agent.", id),
			ActionURL: fmt.Sprintf("/recovery/cases/%d", id),
			EntityRef: fmt.Sprintf("recovery_case:%d", id),
		})

		respondOK(w, "Assigned successfully")
	}
}

func recoveryOpsPayment(db *core.DB) http.HandlerFunc {
	type body struct {
		AmountKobo  int64  `json:"amount_kobo"`
		PaymentDate string `json:"payment_date"`
		Channel     string `json:"channel"`
		Reference   string `json:"reference"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AmountKobo <= 0 || b.PaymentDate == "" || b.Channel == "" {
			respondErr(w, 422, "a positive amount_kobo, payment_date and channel are required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Wrap INSERT + UPDATE in a transaction so neither can succeed without the other
		tx, err := db.PG.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
		if err != nil {
			respondErr(w, 500, "Transaction start failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Recovery payments enter their own HOP → COO chain (write-offs go HOP → COO →
		// CFO): the GL is posted and the case recovered_kobo updated only when the
		// final (COO) approval lands.
		var payID int64
		var payDate, payChannel, payRef, createdAt any
		err = tx.QueryRowContext(ctx, `
			INSERT INTO recovery_payments (case_id, amount_kobo, payment_date, channel, reference, posted_by, status, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
			RETURNING id, amount_kobo, payment_date, channel, reference, created_at`,
			id, b.AmountKobo, b.PaymentDate, b.Channel, b.Reference, user.ID, writeOffChainStart,
		).Scan(&payID, &b.AmountKobo, &payDate, &payChannel, &payRef, &createdAt)
		if err != nil {
			respondErr(w, 500, "Log payment failed")
			return
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		cif := ""
		if cifRows, _ := db.PGQuery(ctx, `SELECT account_cif FROM recovery_cases WHERE id = $1`, id); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(ctx, db, r, "recovery", "recovery_payment", fmt.Sprint(payID), cif, "payment_logged",
			fmt.Sprintf("Recovery payment of ₦%s submitted via %s — pending approval", fmtKoboStr(b.AmountKobo), b.Channel), nil, map[string]any{"amount_kobo": b.AmountKobo, "channel": b.Channel})
		if firstStage, ok := stageProgressions[writeOffChainStart]; ok {
			NotifyRole(ctx, db, firstStage.required, NotifPayload{
				EventType: "payment_approval_pending",
				Title:     "Recovery Payment Awaiting Approval",
				Body:      fmt.Sprintf("A ₦%s recovery payment needs %s sign-off.", fmtKoboStr(b.AmountKobo), firstStage.label),
				ActionURL: "/collections/recovery-approvals",
				EntityRef: fmt.Sprint(payID),
				Priority:  "high",
			})
		}

		respond(w, core.Row{
			"id":           payID,
			"amount_kobo":  b.AmountKobo,
			"payment_date": payDate,
			"channel":      payChannel,
			"reference":    payRef,
			"status":       writeOffChainStart,
			"created_at":   createdAt,
		}, "pg")
	}
}

func recoveryOpsPendingPayments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    rp.id, rp.case_id, rc.account_cif,
			    rp.amount_kobo, rp.payment_date, rp.channel, rp.reference,
			    rp.status, rp.created_at,
			    u.full_name AS posted_by_name
			FROM recovery_payments rp
			JOIN recovery_cases rc ON rc.id = rp.case_id
			LEFT JOIN o3c_users u ON u.id = rp.posted_by
			WHERE `+chainStatusClause(qstr(r, "status"), "rp")+`
			ORDER BY rp.created_at DESC
			LIMIT 200`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		// Annotate each with its chain stage + the role due to sign next, so the approvals
		// UI can show "Awaiting COO" and gate the approve button per-stage.
		for _, row := range rows {
			st := str(row["status"])
			row["stage_label"] = writeOffStageLabel(st)
			if prog, ok := stageProgressions[st]; ok {
				row["required_role"] = prog.required
			} else {
				row["required_role"] = ""
			}
		}
		respond(w, rows, "pg")
	}
}

func recoveryOpsApprovePayment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pid, err := strconv.ParseInt(chi.URLParam(r, "pid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid payment ID")
			return
		}
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Fetch the pending payment
		pmtRows, err := db.PGQuery(ctx,
			`SELECT id, case_id, amount_kobo, status, posted_by FROM recovery_payments WHERE id = $1`, pid)
		if err != nil || len(pmtRows) == 0 {
			respondErr(w, 404, "Payment not found")
			return
		}
		pmt := pmtRows[0]
		currentStatus := str(pmt["status"])
		prog, ok := paymentStageProgressions[currentStatus] // payments: HOP → COO (final, posts GL)
		if !ok {
			respondErr(w, 422, fmt.Sprintf("Payment is already '%s' and cannot be advanced", currentStatus))
			return
		}
		if user.Role != prog.required && user.Role != "admin" {
			respondErr(w, 403, fmt.Sprintf("This approval stage requires the '%s' (%s) role", prog.required, prog.label))
			return
		}
		// Self-approval prevention — the person who logged the payment can't sign ANY of its stages.
		postedBy := toInt64(pmt["posted_by"])
		if postedBy == user.ID {
			respondErr(w, 403, "Cannot approve a payment you submitted")
			return
		}
		// Four-eyes ACROSS stages: the same person may not sign two stages of one payment —
		// admin included, since admin is the break-glass override for every stage and could
		// otherwise push HOP→COO single-handedly. The prior approver is read from the audit
		// log (logCreditEvent stamps actor_id on each 'payment_approved'), so no schema change.
		if prior, _ := db.PGQuery(ctx, `
			SELECT 1 FROM credit_activity_log
			WHERE entity_type = 'recovery_payment' AND entity_id = $1
			  AND action = 'payment_approved' AND actor_id = $2
			LIMIT 1`, fmt.Sprint(pid), user.ID); len(prior) > 0 {
			respondErr(w, 403, "You already approved an earlier stage of this payment. A different approver must sign the next one.")
			return
		}
		caseID := toInt64(pmt["case_id"])
		amtKobo := toInt64(pmt["amount_kobo"])
		isFinal := prog.next == "approved"

		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "Transaction start failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Advance the stage. On the final (CFO) approval, stamp approved_by/at; the CAS on
		// status guards against a concurrent double-advance.
		var updatedID int64
		var scanErr error
		if isFinal {
			scanErr = tx.QueryRowContext(ctx, `
				UPDATE recovery_payments SET status = $1, approved_by = $2, approved_at = NOW()
				WHERE id = $3 AND status = $4 RETURNING id`, prog.next, user.ID, pid, currentStatus).Scan(&updatedID)
		} else {
			scanErr = tx.QueryRowContext(ctx, `
				UPDATE recovery_payments SET status = $1
				WHERE id = $2 AND status = $3 RETURNING id`, prog.next, pid, currentStatus).Scan(&updatedID)
		}
		if scanErr == sql.ErrNoRows {
			respondErr(w, 409, "Someone else changed this payment while you were working. Refresh and try again.")
			return
		}
		if scanErr != nil {
			respondErr(w, 500, "Update failed")
			return
		}

		// Money moves ONLY at final approval: bump the case recovered totals and post GL.
		if isFinal {
			if _, err = tx.ExecContext(ctx, `
				UPDATE recovery_cases
				SET recovered_kobo = COALESCE(recovered_kobo, 0) + $1,
				    total_recovered_kobo = COALESCE(total_recovered_kobo, 0) + $1,
				    updated_at = NOW()
				WHERE id = $2`, amtKobo, caseID); err != nil {
				respondErr(w, 500, "Update case totals failed")
				return
			}
			if glErr := postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   fmt.Sprintf("Recovery payment approved — payment %d", pid),
				Reference:     fmt.Sprintf("RCOV-PAY-%d", pid),
				DebitAccount:  "1001",
				CreditAccount: "1100",
				AmountKobo:    amtKobo,
				SourceType:    "recovery_payment",
				SourceID:      pid,
				PostedBy:      user.ID,
			}); glErr != nil {
				respondErr(w, 500, "GL post failed")
				return
			}
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}
		cif := ""
		if cifRows, _ := db.PGQuery(ctx, `SELECT account_cif FROM recovery_cases WHERE id = $1`, caseID); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(ctx, db, r, "recovery", "recovery_payment", fmt.Sprint(pid), cif, "payment_approved",
			fmt.Sprintf("Recovery payment of ₦%s — %s", fmtKoboStr(amtKobo), writeOffStageLabel(prog.next)), nil, map[string]any{"stage": prog.next})

		// Notify the next approver, or the submitter on final approval.
		if nextStage, ok := stageProgressions[prog.next]; ok {
			NotifyRole(ctx, db, nextStage.required, NotifPayload{
				EventType: "payment_approval_pending",
				Title:     "Recovery Payment Awaiting Approval",
				Body:      fmt.Sprintf("A ₦%s recovery payment now needs %s sign-off.", fmtKoboStr(amtKobo), nextStage.label),
				ActionURL: "/collections/recovery-approvals",
				EntityRef: fmt.Sprint(pid),
				Priority:  "high",
			})
		} else if isFinal && postedBy > 0 {
			NotifyUsers(ctx, db, []int64{postedBy}, NotifPayload{
				EventType: "payment_approved",
				Title:     "Recovery Payment Approved",
				Body:      fmt.Sprintf("The ₦%s recovery payment you logged was fully approved and posted.", fmtKoboStr(amtKobo)),
				ActionURL: "/collections/recovery-approvals",
				EntityRef: fmt.Sprint(pid),
				Priority:  "normal",
			})
		}
		respond(w, map[string]any{"id": pid, "status": prog.next}, "json")
	}
}

func recoveryOpsRejectPayment(db *core.DB) http.HandlerFunc {
	type body struct {
		RejectionReason string `json:"rejection_reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		pid, err := strconv.ParseInt(chi.URLParam(r, "pid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid payment ID")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		prows, perr := db.PGQuery(ctx, `SELECT status, amount_kobo, posted_by FROM recovery_payments WHERE id = $1`, pid)
		if perr != nil || len(prows) == 0 {
			respondErr(w, 404, "Payment not found")
			return
		}
		cur := str(prows[0]["status"])
		prog, ok := paymentStageProgressions[cur] // payments: HOP → COO, not the write-off chain's HOP → COO → CFO
		if !ok {
			respondErr(w, 422, "Payment is already finalised")
			return
		}
		// Only the approver whose stage it is (or admin) can reject it.
		if user.Role != prog.required && user.Role != "admin" {
			respondErr(w, 403, fmt.Sprintf("This stage requires the '%s' (%s) role", prog.required, prog.label))
			return
		}
		rows, err := db.PGQuery(ctx, `
			UPDATE recovery_payments
			SET status = 'rejected', approved_by = $1, approved_at = NOW(), rejection_reason = $2
			WHERE id = $3 AND status = $4
			RETURNING id, status`,
			user.ID, b.RejectionReason, pid, cur)
		if err != nil || len(rows) == 0 {
			respondErr(w, 409, "This payment has changed since you opened it. Refresh and try again.")
			return
		}
		cif := ""
		if cifRows, _ := db.PGQuery(ctx, `SELECT rc.account_cif FROM recovery_payments rp JOIN recovery_cases rc ON rc.id = rp.case_id WHERE rp.id = $1`, pid); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(ctx, db, r, "recovery", "recovery_payment", fmt.Sprint(pid), cif, "payment_rejected",
			fmt.Sprintf("Recovery payment rejected — reason: %s", b.RejectionReason), nil, map[string]any{"reason": b.RejectionReason})
		if postedBy := toInt64(prows[0]["posted_by"]); postedBy > 0 {
			NotifyUsers(ctx, db, []int64{postedBy}, NotifPayload{
				EventType: "payment_rejected",
				Title:     "Recovery Payment Rejected",
				Body:      fmt.Sprintf("The ₦%s recovery payment you logged was rejected.", fmtKoboStr(toInt64(prows[0]["amount_kobo"]))),
				ActionURL: "/collections/recovery-approvals",
				EntityRef: fmt.Sprint(pid),
				Priority:  "normal",
			})
		}
		respond(w, rows[0], "pg")
	}
}

func recoveryOpsAddLegal(db *core.DB) http.HandlerFunc {
	type body struct {
		ProceedingType  string `json:"proceeding_type"`
		CourtName       string `json:"court_name"`
		CaseNumber      string `json:"case_number"`
		FilingDate      string `json:"filing_date"`
		NextHearingDate string `json:"next_hearing_date"`
		Notes           string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ProceedingType == "" || b.FilingDate == "" {
			respondErr(w, 422, "proceeding_type and filing_date are required")
			return
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO legal_proceedings
				(case_id, proceeding_type, court_name, case_number, filing_date, next_hearing_date, status, notes, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, NOW())
			RETURNING id, proceeding_type, court_name, case_number, filing_date, next_hearing_date, status, created_at`,
			id, b.ProceedingType, b.CourtName, b.CaseNumber, b.FilingDate, b.NextHearingDate, b.Notes)
		if err != nil {
			respondErr(w, 500, "Add legal proceeding failed")
			return
		}
		if len(rows) == 0 {
			respondErr(w, 500, "Insert returned no result")
			return
		}
		// Move the CASE, not just the paperwork. recoveryLegal lists cases WHERE
		// legal_stage IS NOT NULL and both dashboards filter status IN ('active','legal'),
		// neither of which this handler set — so proceedings could be filed against a case
		// that never appeared in the Legal tracker. Only escalates: a closed, recovered or
		// written-off case is left alone.
		db.PGExec(r.Context(), `
			UPDATE recovery_cases
			   SET legal_stage = $1, status = 'legal', updated_at = NOW()
			 WHERE id = $2
			   AND status NOT IN ('closed','recovered','written_off')`,
			b.ProceedingType, id) //nolint:errcheck
		cif := ""
		if cifRows, _ := db.PGQuery(r.Context(), `SELECT account_cif FROM recovery_cases WHERE id = $1`, id); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(r.Context(), db, r, "recovery", "legal_milestone", fmt.Sprint(rows[0]["id"]), cif, "legal_milestone_added",
			fmt.Sprintf("Legal milestone added: %s", b.ProceedingType), nil, map[string]any{"milestone": b.ProceedingType})
		go NotifyRoles(context.Background(), db, []string{"recovery_head", "compliance_officer"}, NotifPayload{
			EventType: EvtRecoveryLegalMilestone,
			Title:     "Legal Proceeding Filed",
			Body:      fmt.Sprintf("A new '%s' proceeding is filed on recovery case #%d.", b.ProceedingType, id),
			ActionURL: "/recovery/legal",
			EntityRef: fmt.Sprintf("recovery_case:%d", id),
		})
		respond(w, rows[0], "pg")
	}
}

func recoveryOpsUpdateLegal(db *core.DB) http.HandlerFunc {
	type body struct {
		Status          string `json:"status"`
		NextHearingDate string `json:"next_hearing_date"`
		Notes           string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		lid, err := strconv.ParseInt(chi.URLParam(r, "lid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid proceeding ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Status == "" {
			respondErr(w, 422, "status is required")
			return
		}

		// Preserve existing next_hearing_date/notes when the caller omits them: an
		// update that only changes status used to blank both. COALESCE(NULLIF(...))
		// keeps the stored value on empty input — and, since next_hearing_date is now a
		// DATE column (mig 255), also avoids the '' → date cast error a blank would throw.
		_, err = db.PGExec(r.Context(), `
			UPDATE legal_proceedings
			SET status = $1,
			    next_hearing_date = COALESCE(NULLIF($2,'')::date, next_hearing_date),
			    notes = COALESCE(NULLIF($3,''), notes)
			WHERE id = $4`,
			b.Status, b.NextHearingDate, b.Notes, lid)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		respondOK(w, "Legal proceeding updated")
	}
}

func recoveryOpsVisitsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		visitType := qstr(r, "visit_type")
		outcome := qstr(r, "outcome")
		agentID := qstr(r, "agent_id")
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `
			SELECT rfv.id, rfv.case_id, rc.case_ref, rfv.agent_user_id,
			       u.full_name AS agent_name, rfv.visit_date, rfv.visit_type,
			       rfv.outcome, rfv.notes, rfv.created_at
			FROM recovery_field_visits rfv
			LEFT JOIN recovery_cases rc ON rfv.case_id = rc.id
			LEFT JOIN o3c_users u ON rfv.agent_user_id = u.id
			WHERE 1=1`
		args := []any{}
		n := 1

		if visitType != "" {
			query += fmt.Sprintf(" AND rfv.visit_type = $%d", n)
			args = append(args, visitType)
			n++
		}
		if outcome != "" {
			query += fmt.Sprintf(" AND rfv.outcome = $%d", n)
			args = append(args, outcome)
			n++
		}
		if agentID != "" {
			query += fmt.Sprintf(" AND rfv.agent_user_id = $%d", n)
			args = append(args, agentID)
			n++
		}
		if dateFrom != "" {
			query += fmt.Sprintf(" AND rfv.visit_date >= $%d", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			query += fmt.Sprintf(" AND rfv.visit_date <= $%d", n)
			args = append(args, dateTo)
			n++
		}

		query += fmt.Sprintf(" ORDER BY rfv.visit_date DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
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

func recoveryOpsVisit(db *core.DB) http.HandlerFunc {
	type body struct {
		VisitDate string `json:"visit_date"`
		VisitType string `json:"visit_type"`
		Outcome   string `json:"outcome"`
		Notes     string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.VisitDate == "" || b.VisitType == "" {
			respondErr(w, 422, "visit_date and visit_type are required")
			return
		}

		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO recovery_field_visits (case_id, agent_user_id, visit_date, visit_type, outcome, notes, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, NOW())
			RETURNING id, visit_date, visit_type, outcome, notes, created_at`,
			id, user.ID, b.VisitDate, b.VisitType, b.Outcome, b.Notes)
		if err != nil {
			respondErr(w, 500, "Log visit failed")
			return
		}
		cif := ""
		if cifRows, _ := db.PGQuery(r.Context(), `SELECT account_cif FROM recovery_cases WHERE id = $1`, id); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(r.Context(), db, r, "recovery", "recovery_visit", fmt.Sprint(rows[0]["id"]), cif, "field_visit_logged",
			fmt.Sprintf("Field visit logged — outcome: %s", b.Outcome), nil, map[string]any{"outcome": b.Outcome, "notes": b.Notes})
		respond(w, rows[0], "pg")
	}
}

// recoveryOpsReversePayment reverses a fully-approved recovery payment. Until now a payment
// was permanent once the COO posted it: a wrong amount, a wrong case, or a duplicate could
// never be corrected — which is how 33 cases came to carry recovered_kobo above their
// outstanding. This posts a COMPENSATING reversal rather than deleting the row: the original
// payment is preserved for audit, its status flips to 'reversed' (dropping it from every
// 'approved','posted' sum), the case recovered totals are given back, and an offsetting GL
// entry — debit/credit swapped from the original posting — nets the ledger to zero.
// Reversal is a COO/admin authority: the level that posted it is the level that can undo it.
func recoveryOpsReversePayment(db *core.DB) http.HandlerFunc {
	type body struct {
		Reason string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		pid, err := strconv.ParseInt(chi.URLParam(r, "pid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid payment ID")
			return
		}
		user := core.UserFromCtx(r.Context())
		if user.Role != "coo" && user.Role != "admin" {
			respondErr(w, 403, "Only the COO or an administrator can reverse a posted payment")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.Reason) == "" {
			respondErr(w, 422, "a reason for the reversal is required")
			return
		}
		ctx := r.Context()

		pmtRows, err := db.PGQuery(ctx,
			`SELECT id, case_id, amount_kobo, status FROM recovery_payments WHERE id = $1`, pid)
		if err != nil || len(pmtRows) == 0 {
			respondErr(w, 404, "Payment not found")
			return
		}
		caseID := toInt64(pmtRows[0]["case_id"])
		amtKobo := toInt64(pmtRows[0]["amount_kobo"])

		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "Transaction start failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// CAS on status: only an approved/posted payment can be reversed, and only once —
		// this both blocks reversing a pending/rejected payment and stops a double reversal
		// racing itself.
		var reversedID int64
		scanErr := tx.QueryRowContext(ctx, `
			UPDATE recovery_payments SET status = 'reversed'
			WHERE id = $1 AND status IN ('approved','posted') RETURNING id`, pid).Scan(&reversedID)
		if scanErr == sql.ErrNoRows {
			respondErr(w, 409, "Only an approved payment can be reversed, and this one may already be. Refresh and check.")
			return
		}
		if scanErr != nil {
			respondErr(w, 500, "Reverse failed")
			return
		}

		// Give the money back on the case — the mirror of the credit made at final approval.
		if _, err = tx.ExecContext(ctx, `
			UPDATE recovery_cases
			SET recovered_kobo = GREATEST(COALESCE(recovered_kobo,0) - $1, 0),
			    total_recovered_kobo = GREATEST(COALESCE(total_recovered_kobo,0) - $1, 0),
			    updated_at = NOW()
			WHERE id = $2`, amtKobo, caseID); err != nil {
			respondErr(w, 500, "Update case totals failed")
			return
		}

		// Compensating GL entry: debit/credit swapped from the original posting (1001/1100)
		// so the pair nets to zero, referenced back to the payment.
		if glErr := postJournalTx(ctx, tx, glEntry{
			Date:          time.Now(),
			Description:   fmt.Sprintf("Recovery payment reversed — payment %d (%s)", pid, b.Reason),
			Reference:     fmt.Sprintf("RCOV-REV-%d", pid),
			DebitAccount:  "1100",
			CreditAccount: "1001",
			AmountKobo:    amtKobo,
			SourceType:    "recovery_payment_reversal",
			SourceID:      pid,
			PostedBy:      user.ID,
		}); glErr != nil {
			respondErr(w, 500, "GL reversal post failed")
			return
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}
		cif := ""
		if cifRows, _ := db.PGQuery(ctx, `SELECT account_cif FROM recovery_cases WHERE id = $1`, caseID); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(ctx, db, r, "recovery", "recovery_payment", fmt.Sprint(pid), cif, "payment_reversed",
			fmt.Sprintf("Recovery payment of ₦%s reversed — %s", fmtKoboStr(amtKobo), b.Reason), nil,
			map[string]any{"amount_kobo": amtKobo, "reason": b.Reason})
		respond(w, map[string]any{"id": pid, "status": "reversed"}, "pg")
	}
}

func recoveryOpsWriteOff(db *core.DB) http.HandlerFunc {
	type body struct {
		AmountKobo int64  `json:"amount_kobo"`
		Reason     string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AmountKobo <= 0 || b.Reason == "" {
			respondErr(w, 422, "a positive amount_kobo and reason are required")
			return
		}

		// A write-off cannot exceed the debt that is actually still owed — you can't expense
		// a receivable that isn't there, and the GL posts the full requested amount at
		// approval. Reject rather than silently clamp, so an operator's slip surfaces instead
		// of quietly over-crediting the P&L.
		var outstanding int64
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT GREATEST(COALESCE(outstanding_kobo,0) - COALESCE(recovered_kobo,0) - COALESCE(write_off_amount_kobo,0), 0)
			 FROM recovery_cases WHERE id = $1`, id).Scan(&outstanding); err != nil {
			respondErr(w, 404, "Case not found")
			return
		}
		if b.AmountKobo > outstanding {
			respondErr(w, 422, fmt.Sprintf("Write-off (₦%s) exceeds the ₦%s still outstanding on this case", fmtKoboStr(b.AmountKobo), fmtKoboStr(outstanding)))
			return
		}

		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO recovery_write_off_approvals
				(case_id, amount_kobo, reason, requested_by, status, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
			RETURNING id, case_id, amount_kobo, reason, status, created_at`,
			id, b.AmountKobo, b.Reason, user.ID, writeOffChainStart)
		if err != nil {
			respondErr(w, 500, "Create write-off request failed")
			return
		}
		// Ping the first approver in the chain (HOP) so it doesn't sit unseen until
		// someone happens to open the approvals page.
		if firstStage, ok := stageProgressions[writeOffChainStart]; ok {
			NotifyRole(r.Context(), db, firstStage.required, NotifPayload{
				EventType: "writeoff_approval_pending",
				Title:     "Write-Off Awaiting Your Approval",
				Body:      fmt.Sprintf("A ₦%s write-off request needs %s sign-off.", fmtKoboStr(b.AmountKobo), firstStage.label),
				ActionURL: "/collections/writeoffs",
				EntityRef: fmt.Sprint(rows[0]["id"]),
				Priority:  "high",
			})
		}
		cif := ""
		if cifRows, _ := db.PGQuery(r.Context(), `SELECT account_cif FROM recovery_cases WHERE id = $1`, id); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(r.Context(), db, r, "recovery", "writeoff_request", fmt.Sprint(rows[0]["id"]), cif, "writeoff_requested",
			fmt.Sprintf("Write-off request submitted for ₦%s", fmtKoboStr(b.AmountKobo)), nil, map[string]any{"amount_kobo": b.AmountKobo})
		respond(w, rows[0], "pg")
	}
}

// writeOffChainStart is the status a new write-off request enters at — the first
// stage of the approval chain below.
const writeOffChainStart = "pending_hop"

type approvalStage struct {
	next     string
	roleCol  string
	required string
	label    string
}

// stageProgressions maps current status → next status and the role required to advance it.
//
// The WRITE-OFF and DEBT-SALE chain is HOP → COO → CFO (decided with the business):
// these are large, infrequent money decisions the CFO signs off. These are the roles that
// actually have users; the earlier code targeted recovery_head/finance_head/md, none of
// which exist, so every request silently dead-ended at stage 1. The three per-stage
// approver columns on recovery_write_off_approvals predate this remap, so their NAMES
// (recovery_head_/finance_/md_approved_by) no longer describe the role — they now simply
// record the stage-1/2/3 approver in order. `label` drives the approver notification.
var stageProgressions = map[string]approvalStage{
	"pending_hop": {
		next:     "pending_coo",
		roleCol:  "recovery_head_approved_by", // stage-1 approver (HOP)
		required: "head_ops",
		label:    "Head of Operations",
	},
	"pending_coo": {
		next:     "pending_cfo",
		roleCol:  "finance_approved_by", // stage-2 approver (COO)
		required: "coo",
		label:    "COO",
	},
	"pending_cfo": {
		next:     "approved",
		roleCol:  "md_approved_by", // stage-3 approver (CFO) — final
		required: "cfo",
		label:    "CFO",
	},
}

// paymentStageProgressions is the chain for COLLECTION and RECOVERY PAYMENTS: HOP → COO,
// where the COO is the FINAL approver and posts the GL. CFO was removed from payment
// approvals — a routine, high-volume operational step — while remaining the final
// signatory on write-offs and debt sales (stageProgressions above). The GL post is bound
// to "the last stage" (isFinal := prog.next == "approved"), so making COO final moves the
// posting to COO with no GL-code change. The pending-list endpoints read only `required`,
// which is identical for pending_hop/pending_coo in both chains, so only the two payment
// APPROVE handlers switch to this map.
var paymentStageProgressions = map[string]approvalStage{
	"pending_hop": {
		next:     "pending_coo",
		roleCol:  "recovery_head_approved_by",
		required: "head_ops",
		label:    "Head of Operations",
	},
	"pending_coo": {
		next:     "approved", // COO is final for payments — posts the GL
		roleCol:  "finance_approved_by",
		required: "coo",
		label:    "COO",
	},
}

// chainStatusClause returns a SQL WHERE fragment that filters an approval-chain table by
// the requested status view: pending (default) | approved | rejected | all. `alias` is the
// table alias holding the `status` column. Shared by every approval-queue list so they all
// offer the same Pending/Approved/Rejected/All tabs.
func chainStatusClause(status, alias string) string {
	switch strings.ToLower(status) {
	case "approved":
		return alias + ".status = 'approved'"
	case "rejected":
		return alias + ".status = 'rejected'"
	case "all":
		return "TRUE"
	default:
		return alias + ".status NOT IN ('approved','rejected')"
	}
}

// writeOffStageLabel gives a human "awaiting X" label for a pending status, for the UI
// and notifications. Keeps the frontend from having to hardcode the chain.
func writeOffStageLabel(status string) string {
	if prog, ok := stageProgressions[status]; ok {
		return "Awaiting " + prog.label
	}
	switch status {
	case "approved":
		return "Approved"
	case "rejected":
		return "Rejected"
	}
	return status
}

func recoveryOpsApproveWriteOff(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		wid, err := strconv.ParseInt(chi.URLParam(r, "wid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid write-off ID")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		wrows, err := db.PGQuery(ctx, `SELECT status, amount_kobo FROM recovery_write_off_approvals WHERE id = $1`, wid)
		if err != nil || len(wrows) == 0 {
			respondErr(w, 404, "Write-off request not found")
			return
		}

		currentStatus := str(wrows[0]["status"])
		writeOffKobo := toInt64(wrows[0]["amount_kobo"])
		prog, ok := stageProgressions[currentStatus]
		if !ok {
			respondErr(w, 422, fmt.Sprintf("Write-off is already '%s' and cannot be advanced", currentStatus))
			return
		}
		// The stage's designated approver acts; admin is the break-glass override so a
		// single approver being unavailable can't freeze the whole chain.
		if user.Role != prog.required && user.Role != "admin" {
			respondErr(w, 403, fmt.Sprintf("This approval stage requires the '%s' (%s) role", prog.required, prog.label))
			return
		}

		// Wrap the status UPDATE (and any final-approval side-effects) in a transaction
		// so the status never changes without the GL entry being posted.
		tx, txErr := db.PG.BeginTx(ctx, nil)
		if txErr != nil {
			respondErr(w, 500, "Transaction failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		var updatedID int64
		updateErr := tx.QueryRowContext(ctx,
			fmt.Sprintf(`UPDATE recovery_write_off_approvals
				SET status = $1, %s = $2, updated_at = NOW()
				WHERE id = $3 AND status = $4 RETURNING id`, prog.roleCol),
			prog.next, user.ID, wid, currentStatus).Scan(&updatedID)
		if updateErr == sql.ErrNoRows {
			respondErr(w, 409, "Someone else changed this write-off while you were working. Refresh and try again.")
			return
		}
		if updateErr != nil {
			respondErr(w, 500, "Approval failed")
			return
		}

		// If fully approved, update the case and post GL entry inside the same transaction.
		if prog.next == "approved" {
			if writeOffKobo <= 0 {
				respondErr(w, 422, "Write-off amount must be greater than zero to post")
				return
			}
			// Belt-and-suspenders against over-expensing the GL. The request-time cap can go
			// stale: outstanding may drop between request and this final sign-off if a payment
			// posts in between. Re-check at the point the GL actually moves — if the approved
			// amount now exceeds what is still owed, refuse rather than expense a receivable
			// that is no longer there. Runs inside the tx, so the status update rolls back.
			var netOutstanding int64
			if err := tx.QueryRowContext(ctx, `
				SELECT GREATEST(COALESCE(rc.outstanding_kobo,0) - COALESCE(rc.recovered_kobo,0) - COALESCE(rc.write_off_amount_kobo,0), 0)
				FROM recovery_cases rc JOIN recovery_write_off_approvals wa ON wa.case_id = rc.id
				WHERE wa.id = $1`, wid).Scan(&netOutstanding); err != nil {
				respondErr(w, 500, "Failed to read case outstanding")
				return
			}
			if writeOffKobo > netOutstanding {
				respondErr(w, 422, fmt.Sprintf("Write-off (₦%s) now exceeds the ₦%s still outstanding — the balance changed since the request; please revise it", fmtKoboStr(writeOffKobo), fmtKoboStr(netOutstanding)))
				return
			}
			if _, caseErr := tx.ExecContext(ctx, `
				UPDATE recovery_cases rc
				SET write_off_amount_kobo = wa.amount_kobo,
				    outstanding_kobo      = GREATEST(0, rc.outstanding_kobo - wa.amount_kobo),
				    status = 'closed', closed_at = NOW(), updated_at = NOW()
				FROM recovery_write_off_approvals wa
				WHERE wa.id = $1 AND rc.id = wa.case_id`,
				wid); caseErr != nil {
				respondErr(w, 500, "Failed to close recovery case")
				return
			}
			if glErr := postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   fmt.Sprintf("Loan write-off approved — request %d", wid),
				Reference:     fmt.Sprintf("WO-%d", wid),
				DebitAccount:  "5200", // Loan Loss Provision
				CreditAccount: "1100", // Loan Receivable
				AmountKobo:    writeOffKobo,
				SourceType:    "recovery_write_off",
				SourceID:      wid,
				PostedBy:      user.ID,
			}); glErr != nil {
				respondErr(w, 500, "GL post failed")
				return
			}
		}

		if commitErr := tx.Commit(); commitErr != nil {
			respondErr(w, 500, "The write-off did not commit. Try again.")
			return
		}

		cif := ""
		if cifRows, _ := db.PGQuery(ctx, `SELECT rc.account_cif FROM recovery_write_off_approvals wa JOIN recovery_cases rc ON rc.id = wa.case_id WHERE wa.id = $1`, wid); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(ctx, db, r, "recovery", "writeoff_approval", fmt.Sprint(wid), cif, "writeoff_approved",
			fmt.Sprintf("Write-off of ₦%s — %s", fmtKoboStr(writeOffKobo), writeOffStageLabel(prog.next)), nil, map[string]any{"stage": prog.next})

		// Hand off notice: tell the NEXT approver it's their turn, or — on final
		// approval — tell the original requester the write-off cleared. Without this the
		// next approver only learns by chance, which is how the old chain stalled.
		if nextStage, ok := stageProgressions[prog.next]; ok {
			NotifyRole(ctx, db, nextStage.required, NotifPayload{
				EventType: "writeoff_approval_pending",
				Title:     "Write-Off Awaiting Your Approval",
				Body:      fmt.Sprintf("A ₦%s write-off now needs %s sign-off.", fmtKoboStr(writeOffKobo), nextStage.label),
				ActionURL: "/collections/writeoffs",
				EntityRef: fmt.Sprint(wid),
				Priority:  "high",
			})
		} else if prog.next == "approved" {
			if rrows, _ := db.PGQuery(ctx, `SELECT requested_by FROM recovery_write_off_approvals WHERE id = $1`, wid); len(rrows) > 0 {
				if reqID := toInt64(rrows[0]["requested_by"]); reqID > 0 {
					NotifyUsers(ctx, db, []int64{reqID}, NotifPayload{
						EventType: "writeoff_approved",
						Title:     "Write-Off Approved",
						Body:      fmt.Sprintf("Your ₦%s write-off request was fully approved and posted.", fmtKoboStr(writeOffKobo)),
						ActionURL: "/collections/writeoffs",
						EntityRef: fmt.Sprint(wid),
						Priority:  "normal",
					})
				}
			}
		}

		respondOK(w, fmt.Sprintf("Write-off advanced — %s", writeOffStageLabel(prog.next)))
	}
}

func recoveryOpsRejectWriteOff(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		wid, err := strconv.ParseInt(chi.URLParam(r, "wid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid write-off ID")
			return
		}

		user := core.UserFromCtx(r.Context())
		wrows, err := db.PGQuery(r.Context(), `SELECT status, amount_kobo, requested_by FROM recovery_write_off_approvals WHERE id = $1`, wid)
		if err != nil || len(wrows) == 0 {
			respondErr(w, 404, "Write-off request not found")
			return
		}
		currentSt := str(wrows[0]["status"])
		prog, ok := stageProgressions[currentSt]
		if !ok {
			respondErr(w, 422, "Write-off is already finalised")
			return
		}
		// Only the stage's designated approver may decline it — same gate as approve.
		if user.Role != prog.required && user.Role != "admin" {
			respondErr(w, 403, fmt.Sprintf("This stage requires the '%s' (%s) role", prog.required, prog.label))
			return
		}

		// Guard on the status we validated (same optimistic-lock as approve/payment-reject):
		// without it, a reject that raced a concurrent final approval would blindly flip an
		// already-approved, GL-posted, case-closed write-off back to 'rejected' — an
		// un-reconcilable state with no compensating GL entry. 409 if it moved under us.
		rrows, err := db.PGQuery(r.Context(),
			`UPDATE recovery_write_off_approvals SET status = 'rejected', updated_at = NOW()
			 WHERE id = $1 AND status = $2 RETURNING id`, wid, currentSt)
		if err != nil {
			respondErr(w, 500, "Reject failed")
			return
		}
		if len(rrows) == 0 {
			respondErr(w, 409, "Someone else changed this write-off while you were working. Refresh and try again.")
			return
		}
		// Tell the requester it was declined so they aren't left waiting on a dead request.
		if reqID := toInt64(wrows[0]["requested_by"]); reqID > 0 {
			NotifyUsers(r.Context(), db, []int64{reqID}, NotifPayload{
				EventType: "writeoff_rejected",
				Title:     "Write-Off Declined",
				Body:      fmt.Sprintf("Your ₦%s write-off request was declined.", fmtKoboStr(toInt64(wrows[0]["amount_kobo"]))),
				ActionURL: "/collections/writeoffs",
				EntityRef: fmt.Sprint(wid),
				Priority:  "normal",
			})
		}
		respondOK(w, "Write-off rejected")
	}
}

func recoveryOpsDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		type stat struct {
			key, sql string
		}
		stats := []stat{
			{"total_open_cases", `SELECT COUNT(*) AS val FROM recovery_cases WHERE status IN ('active','legal')`},
			// Net of what has already been recovered, so this reconciles with the Overview's
			// "total in recovery" (recovery.go) instead of showing the raw handoff balance.
			{"total_outstanding_kobo", `SELECT COALESCE(SUM(GREATEST(outstanding_kobo - recovered_kobo, 0)), 0) AS val FROM recovery_cases WHERE status IN ('active','legal')`},
			{"total_recovered_kobo", `SELECT COALESCE(SUM(recovered_kobo), 0) AS val FROM recovery_cases`},
			{"pending_write_offs", `
				SELECT COUNT(*) AS val FROM recovery_write_off_approvals
				WHERE status NOT IN ('approved', 'rejected')`},
			{"visits_this_month", `
				SELECT COUNT(*) AS val FROM recovery_field_visits
				WHERE DATE_TRUNC('month', visit_date::date) = DATE_TRUNC('month', CURRENT_DATE)`},
		}

		// H9: individual stat failures return 0 rather than aborting the whole dashboard.
		result := map[string]any{}
		for _, s := range stats {
			rows, err := db.PGQuery(ctx, s.sql)
			if err != nil || len(rows) == 0 {
				result[s.key] = 0
				continue
			}
			result[s.key] = rows[0]["val"]
		}

		respond(w, result, "pg")
	}
}

func recoveryOpsAgentDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		var assignedCases, closedMTD, callsMTD int
		var collectedMTD int64

		db.PG.QueryRowContext(ctx, `SELECT COUNT(*) FROM recovery_cases WHERE assigned_agent_id = $1 AND status IN ('active','legal')`, user.ID).Scan(&assignedCases)                                                                                                                                                                      //nolint:errcheck
		db.PG.QueryRowContext(ctx, `SELECT COUNT(*) FROM recovery_cases WHERE assigned_agent_id = $1 AND status = 'closed' AND DATE_TRUNC('month', closed_at) = DATE_TRUNC('month', CURRENT_DATE)`, user.ID).Scan(&closedMTD)                                                                                                              //nolint:errcheck
		db.PG.QueryRowContext(ctx, `SELECT COUNT(*) FROM recovery_field_visits WHERE agent_user_id = $1 AND DATE_TRUNC('month', visit_date::date) = DATE_TRUNC('month', CURRENT_DATE)`, user.ID).Scan(&callsMTD)                                                                                                                           //nolint:errcheck
		db.PG.QueryRowContext(ctx, `SELECT COALESCE(SUM(rp.amount_kobo),0) FROM recovery_payments rp JOIN recovery_cases rc ON rc.id = rp.case_id WHERE rc.assigned_agent_id = $1 AND rp.status IN ('approved','posted') AND DATE_TRUNC('month', rp.payment_date::date) = DATE_TRUNC('month', CURRENT_DATE)`, user.ID).Scan(&collectedMTD) //nolint:errcheck

		// Debtor name resolved EXACTLY as the Cases list does — through debtorNameSQL /
		// debtorJoinsSQL — so My Dashboard and Cases never show different names for the
		// same case, and neither of them can reach app.customers for a Udara-keyed case.
		caseRows, _ := db.PGQuery(ctx, `
			SELECT
				rc.id, rc.case_ref,
				`+debtorNameSQL("rc")+` AS debtor_name,
				rc.outstanding_kobo,
				COALESCE(NULLIF(REGEXP_REPLACE(COALESCE(rc.dpd_at_handoff,''),'\D','','g'),'')::INT, 0) AS dpd,
				'' AS next_action, NULL::date AS next_action_date,
				rc.status
			FROM recovery_cases rc
			`+debtorJoinsSQL("rc")+`
			WHERE rc.assigned_agent_id = $1 AND rc.status IN ('active','legal')
			ORDER BY rc.outstanding_kobo DESC
			LIMIT 50`, user.ID)

		visitRows, _ := db.PGQuery(ctx, `
			SELECT
				v.id, rc.case_ref,
				`+debtorNameSQL("rc")+` AS debtor_name,
				v.outcome, v.visit_date AS visited_at,
				0 AS amount_promised_kobo
			FROM recovery_field_visits v
			JOIN recovery_cases rc ON rc.id = v.case_id
			`+debtorJoinsSQL("rc")+`
			WHERE COALESCE(v.agent_user_id, v.officer_id) = $1
			ORDER BY v.created_at DESC
			LIMIT 10`, user.ID)

		trendRows, _ := db.PGQuery(ctx, `
			SELECT
				TO_CHAR(gs, 'Mon YYYY') AS month,
				COALESCE(SUM(rp.amount_kobo) FILTER (WHERE rp.status IN ('approved','posted')), 0) AS collected,
				COUNT(DISTINCT v.id)                                                    AS calls
			FROM GENERATE_SERIES(
				DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months',
				DATE_TRUNC('month', CURRENT_DATE),
				'1 month'
			) AS gs
			LEFT JOIN recovery_payments rp
				ON DATE_TRUNC('month', rp.payment_date::date) = gs
				AND rp.case_id IN (SELECT id FROM recovery_cases WHERE assigned_agent_id = $1)
			LEFT JOIN recovery_field_visits v
				ON DATE_TRUNC('month', v.visit_date::date) = gs
				AND v.agent_user_id = $1
			GROUP BY gs
			ORDER BY gs`, user.ID)

		if caseRows == nil {
			caseRows = []core.Row{}
		}
		if visitRows == nil {
			visitRows = []core.Row{}
		}
		if trendRows == nil {
			trendRows = []core.Row{}
		}

		respond(w, core.Row{
			"assigned_cases":            assignedCases,
			"cases_closed_mtd":          closedMTD,
			"calls_made_mtd":            callsMTD,
			"amount_collected_mtd_kobo": collectedMTD,
			"cases":                     caseRows,
			"recent_visits":             visitRows,
			"monthly_trend":             trendRows,
		}, "pg")
	}
}
