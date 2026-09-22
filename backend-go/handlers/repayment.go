package handlers

import (
	"net/http"
	"strings"

	"github.com/o3c/workspace/core"
)

// Repayment tiering + behaviour.
//
// The workspace previously treated every delinquent borrower the same — a customer who
// has repaid 70% of principal sat in the same bucket as one who has paid nothing. These
// two endpoints put a borrower's PAYDOWN on record so operations can prioritise
// (a 5-band tier) and, for those who have made real progress, offer a restructure
// instead of pushing straight to recovery/write-off.
//
// Paydown means one thing across all three product types: the share of the credit
// extended that has come back — repaid / (repaid + still outstanding). For an Udara
// loan that is (loan_amount − outstanding_principal) / loan_amount; for an uploaded
// loan it is the imported receipts allocated to it; for a revolving card it is the
// repayments received over the last 12 months against the balance still owed.

// paymentTierCTE projects each open loan with its paydown percentage. Wrapped by both
// handlers so the tier boundaries live in exactly one place.
//
// 2026-09-09: the uploaded-loan arm used to hardcode paid_kobo = 0 ("no paydown
// history yet"), which stopped being true once the Loan Repayment CRM repayments were
// imported — ₦814.7m of receipts were reading as zero and parking every one of those
// borrowers in the 'none' tier. They now draw on collection_payments, allocated down a
// CIF's loans oldest-first exactly as the Credit Portfolio and the Credit File do, so
// all three pages report the same paydown.
//
// 2026-09-21: cif_paid had NO status filter, so money still inside the HOP → COO
// approval chain counted as repaid. Live that was 11 rows / ₦106,393,555.56 of
// 'pending_hop' on top of the 1,801 approved rows / ₦1,094,578,699.07 — paydown
// percentages, the 5-band tier and `restructure_eligible` were all being computed off
// receipts finance had not signed off and the GL had not been posted. A 'rejected' row
// would have counted forever too. Only 'approved' is money that has actually landed;
// everything not yet approved/rejected is reported separately as pending_kobo so it is
// visible as "awaiting approval" rather than silently dropped — it deliberately does NOT
// feed pct_paid or the tier.
const paymentTierCTE = `
WITH cif_paid AS (
	SELECT account_cif,
	       SUM(amount_kobo) FILTER (WHERE status = 'approved') AS paid_kobo,
	       SUM(amount_kobo) FILTER (WHERE status NOT IN ('approved','rejected')) AS pending_kobo
	  FROM collection_payments GROUP BY 1
), uploaded_alloc AS (
	SELECT ca.*,
	       COALESCE(cp.paid_kobo, 0) AS cif_pool,
	       COALESCE(cp.pending_kobo, 0) AS cif_pending_pool,
	       COALESCE(SUM(ca.approved_kobo) OVER (
	           PARTITION BY ca.account_cif
	           ORDER BY ca.disbursement_date ASC NULLS LAST, ca.id ASC
	           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS claimed_before
	  FROM (
	      -- Superseded rows take part so they keep their own receipts; filtered below.
	      SELECT x.*, COALESCE(x.target_amount_kobo, x.original_outstanding_kobo, x.outstanding_kobo, 0) AS approved_kobo
	        FROM collection_assignments x
	       WHERE x.product_type='loan' AND x.data_source='manual'
	         -- Udara is the book of record: an uploaded row migration 268 proved to be
	         -- the same facility Udara already reports is a mirror, and the Udara side is
	         -- counted separately below. Including both would double this customer's arrears.
	         AND x.duplicate_of_cbs_id IS NULL
	         AND x.status IN ('active','sent_to_recovery')
	  ) ca
	  LEFT JOIN cif_paid cp ON cp.account_cif = ca.account_cif
), card_paid AS (
	SELECT account_id, SUM(COALESCE(amount_credit,0)) AS paid_naira
	  FROM core.transaction
	 WHERE money_in = true AND COALESCE(amount_credit,0) > 0
	   AND txn_date >= CURRENT_DATE - INTERVAL '12 months'
	 GROUP BY 1
), loan AS (
	SELECT cl.cbs_customer_id                                          AS cif,
	       COALESCE(NULLIF(TRIM(cl.raw->>'name'), ''), cl.cbs_customer_id) AS customer_name, -- Udara's own name
	       cl.product_name                                             AS product,
	       'Udara'                                                     AS origin,
	       cl.cbs_account_number                                       AS reference,
	       cl.loan_amount_kobo                                         AS principal_kobo,
	       cl.outstanding_principal_kobo                               AS outstanding_kobo,
	       GREATEST(cl.loan_amount_kobo - cl.outstanding_principal_kobo, 0) AS paid_kobo,
	       -- No approval chain on this arm: paydown comes from Udara's own outstanding
	       -- principal. collection_payments is keyed by CARDS account_cif, a different
	       -- namespace from cbs_customer_id, so it must NOT be joined here.
	       0::bigint                                                   AS pending_kobo,
	       CASE WHEN cl.loan_amount_kobo > 0
	            THEN ROUND(100.0 * GREATEST(cl.loan_amount_kobo - cl.outstanding_principal_kobo, 0)::numeric / cl.loan_amount_kobo, 1)
	            ELSE 0 END                                             AS pct_paid,
	       ` + cbsLoanDPD + `                                          AS dpd
	FROM cbs_loans cl
	WHERE cl.status NOT IN ('Closed','Revoked')

	UNION ALL

	-- Manually-uploaded loans (Loan Repayment CRM), with their imported repayments.
	SELECT ca.account_cif                                              AS cif,
	       COALESCE(NULLIF(TRIM(ca.customer_name),''), ca.account_cif) AS customer_name,
	       'Loan (uploaded)'                                           AS product,
	       'Uploaded'                                                  AS origin,
	       ca.loan_ref                                                 AS reference,
	       ca.approved_kobo                                            AS principal_kobo,
	       COALESCE(ca.outstanding_kobo,0)                             AS outstanding_kobo,
	       LEAST(ca.approved_kobo, GREATEST(ca.cif_pool - ca.claimed_before, 0)) AS paid_kobo,
	       -- Receipts still in the HOP → COO chain, run down the SAME oldest-first
	       -- waterfall and then netted of what approved money already claimed, so the
	       -- per-loan figures still sum to the CIF's pending pool. Reported alongside
	       -- paid_kobo, never inside it: this money has not been approved or posted.
	       LEAST(ca.approved_kobo, GREATEST(ca.cif_pool + ca.cif_pending_pool - ca.claimed_before, 0))
	         - LEAST(ca.approved_kobo, GREATEST(ca.cif_pool - ca.claimed_before, 0)) AS pending_kobo,
	       CASE WHEN ca.approved_kobo > 0
	            THEN ROUND(100.0 * LEAST(ca.approved_kobo, GREATEST(ca.cif_pool - ca.claimed_before,0))::numeric
	                       / ca.approved_kobo, 1)
	            ELSE 0 END                                             AS pct_paid,
	       CASE WHEN ca.maturity_date IS NOT NULL
	            THEN GREATEST(0, (CURRENT_DATE - ca.maturity_date))::int
	            ELSE CASE ca.dpd_bucket
	                   WHEN '1-30' THEN 15 WHEN '31-60' THEN 45 WHEN '61-90' THEN 75
	                   WHEN '91-180' THEN 135 WHEN '181-360' THEN 270 WHEN '360+' THEN 400
	                   ELSE 0 END END                                  AS dpd
	FROM uploaded_alloc ca
	WHERE ca.status = 'active' AND ca.superseded_by_id IS NULL

	UNION ALL

	-- Credit cards (CCS). paid = repayments actually received over the last 12 months,
	-- not the single last payment: on the old definition a card owing ₦4.6m whose last
	-- payment happened to clear one minimum read as 'cleared'. Only cards that owe a
	-- balance are in the book.
	SELECT a.cif                                                       AS cif,
	       COALESCE(NULLIF(TRIM(COALESCE(cust.first_name,'')||' '||COALESCE(cust.last_name,'')),''), a.name_on_card, a.cif) AS customer_name,
	       COALESCE(NULLIF(a.product_name,''),'Card')                  AS product,
	       'CCS'                                                       AS origin,
	       a.account_no                                                AS reference,
	       GREATEST(ROUND(COALESCE(cp.paid_naira,0)*100),0)::bigint
	         + GREATEST(ROUND(COALESCE(a.current_dr_balance,0)*100),0)::bigint AS principal_kobo,
	       GREATEST(ROUND(COALESCE(a.current_dr_balance,0)*100),0)::bigint AS outstanding_kobo,
	       GREATEST(ROUND(COALESCE(cp.paid_naira,0)*100),0)::bigint     AS paid_kobo,
	       -- Card repayments come off the settled transaction feed, not the approval
	       -- chain, so there is no pending tranche on this arm.
	       0::bigint                                                   AS pending_kobo,
	       CASE WHEN (COALESCE(cp.paid_naira,0) + COALESCE(a.current_dr_balance,0)) > 0
	            THEN ROUND(100.0*COALESCE(cp.paid_naira,0)::numeric
	                       / (COALESCE(cp.paid_naira,0) + COALESCE(a.current_dr_balance,0)), 1)
	            ELSE 0 END                                             AS pct_paid,
	       CASE WHEN COALESCE(a.current_dr_balance,0) <= 0 THEN 0
	            WHEN a.payment_due_date IS NOT NULL
	                 THEN GREATEST(0,(CURRENT_DATE - a.payment_due_date::date))::int
	            ELSE LEAST(GREATEST(0,COALESCE(a.days_overdue,0)),360)::int END AS dpd
	FROM app.accounts a
	LEFT JOIN app.customers cust ON cust.cif = a.cif
	LEFT JOIN card_paid cp ON cp.account_id = a.account_id
	WHERE COALESCE(a.current_dr_balance,0) > 0
), tiered AS (
	SELECT loan.*,
	       CASE
	         WHEN pct_paid <= 0   THEN 'none'
	         WHEN pct_paid <  25  THEN 'minimal'
	         WHEN pct_paid <  75  THEN 'partial'
	         WHEN pct_paid <  100 THEN 'substantial'
	         ELSE 'cleared'
	       END AS tier
	FROM loan
)`

// tierOrder gives the 5 bands a stable display order.
var tierOrder = []string{"none", "minimal", "partial", "substantial", "cleared"}

// collectionsPaymentTiers lists open loans with their paydown tier, so a collections /
// recovery officer can see who has genuinely been paying. Delinquent borrowers in the
// Partial/Substantial bands are flagged restructure-eligible — the intended entry point
// into the restructuring pipeline (credit_accommodations, kind='restructure').
func collectionsPaymentTiers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		q := strings.TrimSpace(qstr(r, "q"))
		tier := strings.TrimSpace(qstr(r, "tier"))
		delinquentOnly := qstr(r, "delinquent") == "true"
		lim := qint(r, "limit", 300, 1, 1000)

		var conds []string
		var args []any
		n := 1
		if q != "" {
			conds = append(conds, "(cif ILIKE $"+itoa(n)+" OR customer_name ILIKE $"+itoa(n)+")")
			args = append(args, "%"+q+"%")
			n++
		}
		if tier != "" {
			var ors []string
			for _, t := range strings.Split(tier, ",") {
				t = strings.TrimSpace(t)
				if t == "" {
					continue
				}
				ors = append(ors, "tier = $"+itoa(n))
				args = append(args, t)
				n++
			}
			if len(ors) > 0 {
				conds = append(conds, "("+strings.Join(ors, " OR ")+")")
			}
		}
		if delinquentOnly {
			conds = append(conds, "dpd > 0")
		}
		where := ""
		if len(conds) > 0 {
			where = " WHERE " + strings.Join(conds, " AND ")
		}

		sql := paymentTierCTE + `
			SELECT cif, customer_name, product, origin, reference, principal_kobo, outstanding_kobo,
			       paid_kobo, pending_kobo, pct_paid, dpd, tier,
			       (pending_kobo > 0)                              AS has_pending_approval,
			       (dpd > 0 AND tier IN ('partial','substantial')) AS restructure_eligible
			FROM tiered` + where + `
			ORDER BY pct_paid DESC, outstanding_kobo DESC
			LIMIT $` + itoa(n)
		args = append(args, lim)

		rows, err := db.PGQuery(ctx, sql, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		// Tier distribution over the whole book (unaffected by the row filters), so the
		// summary strip is stable while the table is refined.
		summary := map[string]map[string]any{}
		if srows, err := db.PGQuery(ctx, paymentTierCTE+`
			SELECT tier,
			       COUNT(*)                     AS loans,
			       COALESCE(SUM(outstanding_kobo),0) AS outstanding_kobo,
			       COALESCE(SUM(paid_kobo),0)        AS paid_kobo,
			       COALESCE(SUM(pending_kobo),0)     AS pending_kobo,
			       COUNT(*) FILTER (WHERE dpd > 0)   AS delinquent
			FROM tiered GROUP BY tier`); err == nil {
			for _, sr := range srows {
				summary[str(sr["tier"])] = map[string]any{
					"loans":            sr["loans"],
					"outstanding_kobo": sr["outstanding_kobo"],
					"paid_kobo":        sr["paid_kobo"],
					"pending_kobo":     sr["pending_kobo"],
					"delinquent":       sr["delinquent"],
				}
			}
		}
		ordered := make([]map[string]any, 0, len(tierOrder))
		for _, t := range tierOrder {
			row := map[string]any{"tier": t, "loans": 0, "outstanding_kobo": 0, "paid_kobo": 0, "pending_kobo": 0, "delinquent": 0}
			if s, ok := summary[t]; ok {
				for k, v := range s {
					row[k] = v
				}
			}
			ordered = append(ordered, row)
		}

		respond(w, map[string]any{"data": rows, "summary": ordered}, "payment_tiers")
	}
}

// repaymentBehaviour is the portfolio-level repayment-behaviour view (#4): the loan
// paydown-tier distribution, card minimum-payment-met behaviour from the latest cycle,
// and per-installment loan outcomes from the amortisation schedules. It ties a
// customer's actual repayment conduct — cards per cycle, loans per installment — back
// to the credit book, complementing the spend-side "Customer Behaviour" view.
func repaymentBehaviour(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		out := map[string]any{}

		// Loan paydown-tier distribution.
		if rows, err := db.PGQuery(ctx, paymentTierCTE+`
			SELECT tier,
			       COUNT(*)                          AS loans,
			       COALESCE(SUM(outstanding_kobo),0) AS outstanding_kobo,
			       COALESCE(SUM(paid_kobo),0)        AS paid_kobo,
			       COALESCE(SUM(pending_kobo),0)     AS pending_kobo,
			       COUNT(*) FILTER (WHERE dpd > 0)   AS delinquent
			FROM tiered GROUP BY tier`); err == nil {
			byTier := map[string]core.Row{}
			for _, r := range rows {
				byTier[str(r["tier"])] = r
			}
			ordered := make([]map[string]any, 0, len(tierOrder))
			for _, t := range tierOrder {
				row := map[string]any{"tier": t, "loans": 0, "outstanding_kobo": 0, "paid_kobo": 0, "pending_kobo": 0, "delinquent": 0}
				if s, ok := byTier[t]; ok {
					row["loans"] = s["loans"]
					row["outstanding_kobo"] = s["outstanding_kobo"]
					row["paid_kobo"] = s["paid_kobo"]
					row["pending_kobo"] = s["pending_kobo"]
					row["delinquent"] = s["delinquent"]
				}
				ordered = append(ordered, row)
			}
			out["loan_tiers"] = ordered
		}

		// Card minimum-payment behaviour from each account's most recent cycle.
		if rows, err := db.PGQuery(ctx, `
			WITH latest AS (
				SELECT DISTINCT ON (account_number)
				       account_number, minimum_payment_kobo, total_payment_kobo, outstanding_balance_kobo
				FROM card_cycle_data
				ORDER BY account_number, cycle_date DESC
			)
			SELECT COUNT(*)                                                                              AS accounts,
			       COUNT(*) FILTER (WHERE minimum_payment_kobo > 0)                                      AS with_minimum,
			       COUNT(*) FILTER (WHERE minimum_payment_kobo > 0 AND total_payment_kobo >= minimum_payment_kobo) AS met_minimum,
			       COALESCE(SUM(outstanding_balance_kobo),0)                                             AS outstanding_kobo
			FROM latest`); err == nil && len(rows) > 0 {
			out["card_behaviour"] = rows[0]
		}

		// Loan installment behaviour from the synced amortisation schedules.
		//
		// 2026-09-21: this used to report `processed` from cbs_loan_schedules.has_processed.
		// That flag is FALSE on all 202 rows — Udara's repayment tracker is switched off on
		// these loans (handlers/overview.go:168-170 documents the same thing and works
		// around it for accrued interest). The panel therefore showed "0 of 202 processed",
		// a 0% repayment rate that was an artefact of an unset flag, not a fact about the
		// book. The flag is no longer reported.
		//
		// Udara's real per-installment outcome is in payment_status, so that is what is
		// counted now. CAVEAT, deliberately honoured: this table stores only SCHEDULED
		// amounts (principal_kobo/interest_kobo/fee_kobo) — there is NO paid-amount column.
		// A 'PartiallyPaid' installment tells us it was partly paid and nothing about how
		// much, so no paid figure is derived here and partially-paid installments are kept
		// as their own bucket rather than being rounded into "paid" or "unpaid".
		if rows, err := db.PGQuery(ctx, `
			SELECT COUNT(*)                                                  AS installments,
			       COUNT(DISTINCT loan_account_number)                       AS loans,
			       COUNT(*) FILTER (WHERE payment_status = 'NotYetDue')      AS not_yet_due,
			       COUNT(*) FILTER (WHERE payment_status = 'DueAndUnpaid')   AS due_and_unpaid,
			       COUNT(*) FILTER (WHERE payment_status = 'PartiallyPaid')  AS partially_paid,
			       COUNT(*) FILTER (WHERE payment_status = 'FullyPaid')      AS fully_paid,
			       COUNT(*) FILTER (WHERE payment_status IS NULL
			                           OR payment_status NOT IN ('NotYetDue','DueAndUnpaid','PartiallyPaid','FullyPaid'))
			                                                                 AS status_unknown,
			       COUNT(*) FILTER (WHERE payment_status IN ('DueAndUnpaid','PartiallyPaid','FullyPaid'))
			                                                                 AS due_to_date,
			       COALESCE(SUM(principal_kobo + interest_kobo + fee_kobo),0) AS scheduled_kobo,
			       COALESCE(SUM(principal_kobo + interest_kobo + fee_kobo)
			                FILTER (WHERE payment_status IN ('DueAndUnpaid','PartiallyPaid','FullyPaid')),0)
			                                                                 AS scheduled_due_to_date_kobo
			FROM app.cbs_loan_schedules`); err == nil && len(rows) > 0 {
			ib := rows[0]
			// Make the limits of this data explicit in the payload rather than leaving the
			// UI to infer them: amounts here are what was SCHEDULED, never what was paid.
			ib["amounts_are_scheduled_only"] = true
			ib["paid_amount_available"] = false
			ib["has_processed_flag_populated"] = false
			ib["note"] = "Counts are Udara installment outcomes (payment_status). Amounts are scheduled, not paid — the core-banking schedule carries no paid-amount column, so a partially-paid installment has no known paid figure."
			out["installment_behaviour"] = ib
		}

		respond(w, out, "repayment_behaviour")
	}
}
