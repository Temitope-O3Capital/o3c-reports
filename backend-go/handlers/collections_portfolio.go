package handlers

import (
	"net/http"
	"strings"

	"github.com/o3c/workspace/core"
)

// ── Credit Portfolio ─────────────────────────────────────────────────────────
//
// One row per FACILITY (each card, each loan), so the credit terms are exact.
//
// This query was rebuilt (2026-09-09) after the page was reported as full of
// duplicates and wrong figures. Four separate causes, all fixed here:
//
//  1. ROW MULTIPLICATION. The workspace overlay was attached with
//     `LEFT JOIN collection_assignments ON account_cif = cif AND status IN
//     ('active','sent_to_recovery')`. Ten CIFs carry more than one such assignment
//     (ODOMETA ONOME has four), so those facilities rendered two-to-four identical
//     rows. Now resolved to exactly one assignment per CIF via DISTINCT ON.
//
//  2. RE-IMPORTED LOANS. The uploaded book holds the same mandate twice for two
//     customers (EDWARD COSMETICS, FOLTI TECHNOLOGY) — same CIF, same loan_ref.
//     Collapsed to the newest row. This also fixed the frontend's row key, which is
//     source+reference and therefore collided on those pairs.
//
//  3. DEAD FACILITIES DOMINATING THE LIST. The old filter (`card_limit > 0 OR
//     current_dr_balance > 0`) admitted 6,487 card rows of which 5,076 owed nothing,
//     and DPD was derived from payment_due_date even on settled cards. Terminated
//     2015 cards therefore scored DPD 4,010 and filled the top of a DPD-sorted work
//     list, ten near-identical rows at a time. A card that owes nothing is now DPD 0,
//     and the page defaults to facilities that actually owe (?scope=all restores the
//     full book — nothing is hidden, it is just not the default work list).
//
//  4. WRONG MONEY. "Amount Paid" was the card's LAST single payment
//     (last_amount_paid) and "% Paid" was that payment over one minimum due, capped
//     at 100 — so a card owing ₦4.6m read as fully paid, while 4,219 cards with no
//     recorded minimum read as 0%. Uploaded loans were hardcoded to zero paid even
//     though ₦814.7m of their repayments are now imported. All three product types
//     now report the same thing: money actually received, and what fraction of the
//     credit extended that represents.
//
// UNITS: app.accounts and core.transaction are NAIRA numerics (×100 → kobo);
// cbs_loans and collection_payments are already kobo.

// portfolioFacilitiesCTE builds the facility set. Shared with the KPI roll-up so the
// header figures and the table can never disagree.
const portfolioFacilitiesCTE = `
WITH assign AS (
    -- Exactly ONE workspace assignment per CIF: the active one if there is one,
    -- else the most recent. Joining all of them is what multiplied the rows.
    SELECT DISTINCT ON (account_cif)
           account_cif, id AS assignment_id, agent_user_id, current_stage
      FROM collection_assignments
     WHERE status IN ('active','sent_to_recovery')
     ORDER BY account_cif, (status = 'active') DESC, id DESC
), card_paid AS (
    -- Repayments genuinely received on each card over the last 12 months. This is
    -- the cumulative figure the "Repaid" column reports — not the last payment.
    SELECT account_id, SUM(COALESCE(amount_credit,0)) AS paid_naira
      FROM core.transaction
     WHERE money_in = true AND COALESCE(amount_credit,0) > 0
       AND txn_date >= CURRENT_DATE - INTERVAL '12 months'
     GROUP BY 1
), cif_paid AS (
    SELECT account_cif, SUM(amount_kobo) AS paid_kobo FROM collection_payments GROUP BY 1
), udara_owner AS (
    -- Udara customer ids are their OWN namespace and COLLIDE with card CIFs (Udara
    -- 00000424 is FINTRAK; card CIF 00000424 is Adetunji Taiwo, an unrelated person).
    -- Every Udara loan is resolved to its real customer through the curated party
    -- crosswalk and keyed on that customer — never on the raw cbs_customer_id, which
    -- would hand 22 collections accounts a stranger's loan.
    SELECT k.cbs_customer_id,
           k.entity_id AS party_id,
           (SELECT COALESCE(NULLIF(c2.cif,''), c2.contact_id) FROM app.customers c2
             WHERE c2.party_id = k.entity_id
             ORDER BY (c2.cif IS NULL), c2.cif LIMIT 1) AS customer_key
      FROM app.cbs_links k
     WHERE k.entity_type = 'party'
), udara_parties AS (
    SELECT DISTINCT o.party_id
      FROM cbs_loans cl
      JOIN udara_owner o ON o.cbs_customer_id = cl.cbs_customer_id
     WHERE cl.status NOT IN ('Closed','Revoked')
), uploaded AS (
    -- Every uploaded loan of the customer, including superseded (pre-restructure) rows.
    -- They must take part in the allocation below so they keep their OWN receipts
    -- instead of handing them to their successor; they are filtered out for display.
    SELECT ca.*,
           COALESCE(ca.target_amount_kobo, ca.original_outstanding_kobo, ca.outstanding_kobo, 0) AS approved_kobo
      FROM collection_assignments ca
     WHERE ca.product_type = 'loan' AND ca.data_source = 'manual'
       -- Closed loans stay in the set: a settled facility is still part of the credit
       -- history and must be findable. It carries zero outstanding, so it only surfaces
       -- under the "Whole book" scope, never in the work list.
       AND ca.status IN ('active','sent_to_recovery','closed')
), uploaded_alloc AS (
    -- collection_payments records the CUSTOMER, not which of their loans was settled,
    -- so a CIF's receipts are run down its loans oldest-disbursement-first — the same
    -- waterfall the account Credit File uses, so the two pages agree. Without this the
    -- whole CIF total attaches to every loan (FINTRAK's three loans each claimed the
    -- full ₦75.4m).
    SELECT u.*,
           COALESCE(pd.paid_kobo,0) AS cif_pool,
           -- Capped on the APPROVED amount: outstanding_kobo is net of receipts since
           -- migration 222, so capping on it would under-report what has been repaid.
           COALESCE(SUM(u.approved_kobo) OVER (
               PARTITION BY u.account_cif
               ORDER BY u.disbursement_date ASC NULLS LAST, u.id ASC
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS claimed_before,
           -- Udara is authoritative. An uploaded loan whose customer also has a live
           -- Udara facility of the SAME approved amount is that facility, re-keyed from
           -- a spreadsheet — a mirror, not a second loan.
           (EXISTS (SELECT 1 FROM cbs_loans cl2
                      JOIN udara_owner o2 ON o2.cbs_customer_id = cl2.cbs_customer_id
                     WHERE o2.party_id = u.party_id
                       AND cl2.status NOT IN ('Closed','Revoked')
                       AND cl2.loan_amount_kobo = u.approved_kobo)
            -- …and so is the RESTRUCTURE of a mirrored facility: it carries the same
            -- mandate, so it is the same loan on new terms, not a new one. FOLTI's
            -- ₦156,000,000 restructure of its ₦250,000,000 Udara facility is this case.
            OR EXISTS (SELECT 1 FROM collection_assignments s
                         JOIN cbs_loans cl3 ON cl3.loan_amount_kobo =
                              COALESCE(s.target_amount_kobo, s.original_outstanding_kobo, s.outstanding_kobo, 0)
                         JOIN udara_owner o3 ON o3.cbs_customer_id = cl3.cbs_customer_id
                                            AND o3.party_id = s.party_id
                        WHERE s.party_id = u.party_id
                          AND s.data_source = 'manual' AND s.product_type = 'loan'
                          AND s.id <> u.id
                          AND COALESCE(NULLIF(TRIM(s.loan_ref),''),'NO MANDATE') <> 'NO MANDATE'
                          AND s.loan_ref = u.loan_ref
                          AND cl3.status NOT IN ('Closed','Revoked'))
           ) AS also_in_udara
      FROM uploaded u
      LEFT JOIN cif_paid pd ON pd.account_cif = u.account_cif
), facilities AS (
    -- CARDS (CCS)
    SELECT a.cif                                                          AS cif,
           COALESCE(NULLIF(TRIM(c.first_name||' '||COALESCE(c.last_name,'')),''),
                    a.name_on_card, a.cif)                                AS customer_name,
           a.account_no                                                   AS reference,
           'card'                                                         AS source,
           'CCS'                                                          AS origin,
           COALESCE(NULLIF(a.product_name,''),'Card')                     AS product_name,
           COALESCE(a.status,'')                                          AS facility_status,
           -- A card that owes nothing is not late, whatever a stale statement date says.
           CASE WHEN COALESCE(a.current_dr_balance,0) <= 0 THEN 0
                WHEN a.payment_due_date IS NOT NULL
                     THEN GREATEST(0,(CURRENT_DATE - a.payment_due_date::date))::int
                ELSE LEAST(GREATEST(0,COALESCE(a.days_overdue,0)),360)::int END AS dpd,
           GREATEST(ROUND(COALESCE(a.current_dr_balance,0)*100),0)::bigint AS outstanding_kobo,
           GREATEST(ROUND(COALESCE(a.card_limit,0)*100),0)::bigint         AS loc_kobo,
           GREATEST(ROUND(COALESCE(a.min_payment_due,0)*100),0)::bigint    AS min_repayment_kobo,
           GREATEST(ROUND(COALESCE(cp.paid_naira,0)*100),0)::bigint        AS amount_paid_kobo,
           false                                                          AS superseded
      FROM app.accounts a
      LEFT JOIN app.customers c ON c.cif = a.cif
      LEFT JOIN card_paid cp    ON cp.account_id = a.account_id
     WHERE COALESCE(a.card_limit,0) > 0 OR COALESCE(a.current_dr_balance,0) > 0

    UNION ALL

    -- LOANS from Udara core banking
    SELECT COALESCE(uo.customer_key, cl.cbs_customer_id),
           COALESCE(NULLIF(TRIM(cl.raw->>'name'),''), cl.cbs_customer_id),
           cl.cbs_account_number, 'loan', 'Udara',
           COALESCE(NULLIF(cl.product_name,''),'Loan'),
           COALESCE(cl.status,''),
           app.cbs_loan_dpd(cl.status, cl.start_date, cl.maturity_date,
                            cl.first_installment_date, cl.loan_amount_kobo,
                            cl.outstanding_principal_kobo),
           (COALESCE(cl.outstanding_principal_kobo,0)+COALESCE(cl.outstanding_interest_kobo,0)
           +COALESCE(cl.outstanding_fee_kobo,0)),
           COALESCE(cl.loan_amount_kobo,0),
           -- Minimum to collect: the contractual instalment where Udara states one,
           -- else the full outstanding (policy for a matured facility).
           COALESCE(NULLIF(cl.installment_amount_kobo,0),
                    COALESCE(cl.outstanding_principal_kobo,0)+COALESCE(cl.outstanding_interest_kobo,0)),
           GREATEST(COALESCE(cl.loan_amount_kobo,0)-COALESCE(cl.outstanding_principal_kobo,0),0),
           false
      FROM cbs_loans cl
      LEFT JOIN udara_owner uo ON uo.cbs_customer_id = cl.cbs_customer_id
     WHERE cl.status NOT IN ('Closed','Revoked')

    UNION ALL

    -- LOANS uploaded from the Loan Repayment CRM spreadsheet
    SELECT u.account_cif,
           COALESCE(NULLIF(TRIM(u.customer_name),''), u.account_cif),
           COALESCE(NULLIF(u.loan_ref,''),'Uploaded loan'), 'loan', 'Uploaded',
           'Loan (uploaded)',
           COALESCE(u.status,''),
           CASE WHEN u.maturity_date IS NOT NULL
                THEN GREATEST(0,(CURRENT_DATE - u.maturity_date))::int
                ELSE CASE u.dpd_bucket WHEN '1-30' THEN 15 WHEN '31-60' THEN 45
                       WHEN '61-90' THEN 75 WHEN '91-180' THEN 135
                       WHEN '181-360' THEN 270 WHEN '360+' THEN 400 ELSE 0 END END,
           COALESCE(u.outstanding_kobo,0),
           u.approved_kobo,
           COALESCE(u.repayment_kobo, u.outstanding_kobo, 0),
           LEAST(u.approved_kobo, GREATEST(u.cif_pool - u.claimed_before, 0)),
           -- The same debt is also booked in Udara: shown, but flagged so it is not
           -- read as extra exposure.
           u.also_in_udara
      FROM uploaded_alloc u
     -- Superseded rows are pre-restructure history, and Udara mirrors are the same
     -- facility already carried by core banking. Neither is a second loan.
     WHERE u.superseded_by_id IS NULL AND NOT u.also_in_udara
)`

// collectionsPortfolioAccounts serves the Credit Portfolio table.
func collectionsPortfolioAccounts(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		search := strings.TrimSpace(qstr(r, "q"))
		territory := qstr(r, "territory")            // "collections" | "recovery" | ""
		scope := strings.TrimSpace(qstr(r, "scope")) // "" (owing) | "all"

		args := []any{}
		filter := ""
		if search != "" {
			filter += " AND (cif ILIKE $1 OR customer_name ILIKE $1)"
			args = append(args, "%"+search+"%")
		}
		switch territory {
		case "collections":
			filter += ` AND dpd <= 90`
		case "recovery":
			filter += ` AND dpd > 90`
		}
		// The work list is what is owed. ?scope=all opens the whole book, including
		// settled and closed facilities.
		if scope != "all" {
			filter += ` AND outstanding_kobo > 0`
		}

		query := portfolioFacilitiesCTE + `, ranked AS (
			    -- Cap cards and loans SEPARATELY so the far smaller loan book is always
			    -- represented (one DPD-ordered cap fills entirely with cards).
			    (SELECT * FROM facilities WHERE source='card'` + filter + ` ORDER BY dpd DESC, outstanding_kobo DESC LIMIT 8000)
			    UNION ALL
			    (SELECT * FROM facilities WHERE source='loan'` + filter + ` ORDER BY dpd DESC, outstanding_kobo DESC LIMIT 2000)
			), last_call AS (
			    -- Latest non-voided call per CIF in a single pass over the call log (a
			    -- per-row LATERAL seq-scans it and is far too slow here). The portfolio
			    -- matches on recorded CIF only; the detail views keep the phone crosswalk.
			    SELECT customer_cif AS cif, agent_name, started_at, disposition
			      FROM (SELECT customer_cif, agent_name, started_at, disposition,
			                   ROW_NUMBER() OVER (PARTITION BY customer_cif ORDER BY started_at DESC) AS rn
			              FROM app.helpdesk_calls
			             WHERE merged_into_call_id IS NULL AND voided_at IS NULL
			               AND COALESCE(customer_cif,'') <> '') z
			     WHERE rn = 1
			)
			SELECT
			    f.cif              AS applicant_cif,
			    f.reference, f.source, f.origin, f.customer_name, f.product_name,
			    f.facility_status,
			    f.superseded,
			    f.dpd              AS dpd_lower,
			    CASE
			        WHEN f.dpd <= 0   THEN '0'
			        WHEN f.dpd <= 30  THEN '1-30'
			        WHEN f.dpd <= 60  THEN '31-60'
			        WHEN f.dpd <= 90  THEN '61-90'
			        WHEN f.dpd <= 180 THEN '91-180'
			        WHEN f.dpd <= 360 THEN '181-360'
			        ELSE '360+' END AS dpd_bucket,
			    f.outstanding_kobo, f.loc_kobo, f.min_repayment_kobo, f.amount_paid_kobo,
			    -- % of the credit extended that has come back. One definition for all
			    -- three product types, so the column means the same thing on every row.
			    CASE WHEN (f.amount_paid_kobo + f.outstanding_kobo) > 0
			         THEN ROUND(100.0*f.amount_paid_kobo/(f.amount_paid_kobo + f.outstanding_kobo), 1)
			         ELSE 0 END    AS pct_paid,
			    CASE
			        WHEN (f.amount_paid_kobo + f.outstanding_kobo) <= 0 THEN 'cleared'
			        WHEN f.amount_paid_kobo <= 0 THEN 'none'
			        WHEN 100.0*f.amount_paid_kobo/(f.amount_paid_kobo+f.outstanding_kobo) <  25  THEN 'minimal'
			        WHEN 100.0*f.amount_paid_kobo/(f.amount_paid_kobo+f.outstanding_kobo) <  75  THEN 'partial'
			        WHEN 100.0*f.amount_paid_kobo/(f.amount_paid_kobo+f.outstanding_kobo) < 100  THEN 'substantial'
			        ELSE 'cleared' END AS tier,
			    ass.assignment_id,
			    u.full_name        AS agent_name,
			    -- Stage: the stored one, else derived from activity so it is never blank.
			    COALESCE(NULLIF(ass.current_stage,''),
			        CASE
			            WHEN ass.assignment_id IS NULL THEN 'unassigned'
			            WHEN EXISTS (SELECT 1 FROM collection_promises cp WHERE cp.cif_number = f.cif AND cp.is_kept IS NULL) THEN 'promise'
			            WHEN EXISTS (SELECT 1 FROM collection_contacts cc WHERE cc.cif_number = f.cif) THEN 'contacted'
			            ELSE 'new' END) AS current_stage,
			    lc.agent_name      AS last_call_agent,
			    lc.started_at      AS last_call_at,
			    lc.disposition     AS last_call_disposition
			FROM ranked f
			LEFT JOIN assign ass ON ass.account_cif = f.cif
			LEFT JOIN o3c_users u ON u.id = ass.agent_user_id
			LEFT JOIN last_call lc ON lc.cif = f.cif
			ORDER BY f.dpd DESC, f.outstanding_kobo DESC`

		rows, err := db.PGQuery(ctx, query, args...)
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
