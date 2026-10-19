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
), loan_paid AS (
    -- Repayments received on a UDARA loan, keyed on the LOAN ACCOUNT NUMBER.
    --
    -- The Udara arm below used to report 0 paid on every facility, with a correct
    -- reason: collection_payments is keyed by cards account_cif, a namespace that
    -- COLLIDES with cbs_customer_id, so it must not be reached from this arm. True —
    -- but it left the arm with no paid figure at all, and app.loan_repayments is the
    -- feed that belongs here. It keys on cbs_loan_account, which is an ACCOUNT NUMBER
    -- and not a customer id, so it carries none of that collision risk: all 88 rows
    -- join to cbs_loans.cbs_account_number exactly.
    --
    -- Live, that silence hid 135,566,488 naira of real repayment across 20 of the 42
    -- live Udara facilities — FINTRAK alone had five receipts totalling 56.8m while
    -- the page reported nothing collected.
    --
    -- No 12-month window, unlike card_paid: a loan is repaid over its whole life and
    -- the figure wanted here is cumulative, which is also how cif_paid treats the
    -- uploaded arm. Keeping the two loan arms on the same basis is the point.
    SELECT cbs_loan_account, SUM(COALESCE(amount_kobo,0)) AS paid_kobo
      FROM app.loan_repayments
     WHERE NULLIF(TRIM(cbs_loan_account),'') IS NOT NULL
     GROUP BY 1
), cif_paid AS (
    -- 2026-09-21: this had NO status filter, so money still inside the HOP -> COO ->
    -- CFO approval chain counted as repaid. Live that was 11 rows / N106,393,555.56 of
    -- 'pending_hop' on top of 1,801 approved rows / N1,094,578,699.07, and it inflated
    -- amount_paid_kobo, pct_paid and the 5-band tier on 11 uploaded loans. Only an
    -- 'approved' receipt has been signed off and posted to the GL. Filtering TO
    -- 'approved' rather than excluding 'pending_hop' also keeps a future 'rejected' row
    -- out for good. Money still awaiting approval is kept as its own pool and reported
    -- in its own column -- never blended into a paid or outstanding figure.
    SELECT account_cif,
           -- superseded_by_udara excluded: migration 366 flags a hand-entered receipt
           -- on a facility Udara holds, where app.loan_repayments carries the
           -- authoritative version and the Udara arm above now reports it. Counting
           -- both would credit the same money twice.
           COALESCE(SUM(amount_kobo) FILTER (WHERE status = 'approved'
                                               AND NOT superseded_by_udara), 0)              AS paid_kobo,
           COALESCE(SUM(amount_kobo) FILTER (WHERE status NOT IN ('approved','rejected')), 0) AS pending_kobo
      FROM collection_payments GROUP BY 1
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
     -- NOTE (2026-09-21): the crosswalk itself is complete (295/295 links, 0 dangling),
     -- but only 31 of those 295 parties have an app.customers row at all, and only 24 of
     -- those carry a cif — so customer_key is NULL for the large majority. customer_key
     -- is a CARDS-side lookup key and nothing more; it is NOT the identity, and its
     -- absence must never be papered over with the raw cbs_customer_id. See cards_key
     -- on the Udara arm below.
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
           COALESCE(pd.paid_kobo,0)    AS cif_pool,
           COALESCE(pd.pending_kobo,0) AS cif_pending_pool,
           -- Capped on the APPROVED amount: outstanding_kobo is net of receipts since
           -- migration 222, so capping on it would under-report what has been repaid.
           COALESCE(SUM(u.approved_kobo) OVER (
               PARTITION BY u.account_cif
               ORDER BY u.disbursement_date ASC NULLS LAST, u.id ASC
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS claimed_before,
           -- Udara is authoritative. An uploaded loan whose customer also has a live
           -- Udara facility of the SAME approved amount is that facility, re-keyed from
           -- a spreadsheet — a mirror, not a second loan.
           -- Migration 268 stamps the mirrors it could PROVE: an identical approved
           -- amount plus an exact name, a rare shared word, or a high trigram score,
           -- matched one-to-one between the books. That is stronger evidence than the
           -- amount-and-party test below, which cannot fire at all on the many uploaded
           -- rows carrying no party_id. It is checked first; the original test stays as
           -- a fallback so nothing already deduplicated on this page can regress.
           --
           -- AUDITED 2026-10-19 AND DELIBERATELY LEFT ALONE. The amount-and-party test
           -- is unbounded: N uploaded rows of the same amount on one party are all
           -- suppressed by a SINGLE Udara facility of that amount, so in principle a
           -- genuine second facility can vanish. Measured against the live book before
           -- touching it: 14 party+amount groups match a Udara facility, 13 of them
           -- one-to-one, and the only group with two uploaded rows (party 708783,
           -- 5,000,000.00) holds two IDENTICAL rows — same account_cif, same mandate
           -- reference, both closed. They are one loan uploaded twice, so suppressing
           -- both is right.
           --
           -- Bounding the test by rank (suppress only as many uploaded rows as there
           -- are matching facilities) would therefore un-suppress that second row and
           -- CREATE a 5,000,000.00 double-count today, to protect against a case the
           -- book does not contain. Re-run the measurement before changing it: the
           -- query is in the Udara funnel audit, and the signal to watch for is a
           -- party+amount group whose uploaded rows differ from each other.
           (u.duplicate_of_cbs_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM cbs_loans cl2
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
    -- Every arm carries TWO identity columns and they must not be confused:
    --   cif       — what the row IS CALLED. Displayed, searched, and used by the
    --               frontend as the row key and the /collections/accounts/{id} link.
    --               For a Udara facility this is legitimately a Udara customer id.
    --   cards_key — what the row may be JOINED ON cards-side (collection_assignments,
    --               collection_promises, collection_contacts, helpdesk_calls — all of
    --               which are keyed by CARDS cif). NULL when no such key exists.
    -- Keeping them apart is the whole point: the two id spaces collide (Udara 00000424
    -- is FINTRAK, card CIF 00000424 is Adetunji Taiwo), so a single merged key silently
    -- attaches a stranger's agent, stage and call history to a Udara loan.
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
           -- Card repayments come off the settled transaction feed, not the collections
           -- approval chain, so no card row can have money awaiting approval.
           0::bigint                                                      AS pending_paid_kobo,
           false                                                          AS superseded,
           -- A card row IS a cards row: its own cif is the correct join key.
           a.cif                                                          AS cards_key
      FROM app.accounts a
      LEFT JOIN app.customers c ON c.cif = a.cif
      LEFT JOIN card_paid cp    ON cp.account_id = a.account_id
     WHERE COALESCE(a.card_limit,0) > 0 OR COALESCE(a.current_dr_balance,0) > 0

    UNION ALL

    -- LOANS from Udara core banking
    SELECT COALESCE(uo.customer_key, 'UD-' || cl.cbs_customer_id), -- never the bare id: 34 of 41 loans have no cards key, and the raw value resolves to a different person
           -- cbs_customers.name is the authoritative borrower name for a Udara
           -- facility; the embedded raw->>'name' is the same string today (41/41 live
           -- loans agree exactly) and stays as the backstop.
           COALESCE((SELECT NULLIF(TRIM(cc.name),'') FROM cbs_customers cc
                      WHERE cc.cbs_customer_id = cl.cbs_customer_id LIMIT 1),
                    NULLIF(TRIM(cl.raw->>'name'),''), cl.cbs_customer_id),
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
           -- AMOUNT REPAID IS NOW THE RECEIPTS, not the balance movement.
           --
           -- This was GREATEST(loan_amount - outstanding_principal, 0): the drop in
           -- principal, which is not the same thing as money received and must not be
           -- labelled "Repaid". It moves for a restructure, a write-down, an interest
           -- capitalisation or a correction, and it omits every naira of interest and
           -- fee actually collected. Live, the two disagree in BOTH directions —
           -- FINTRAK had 40.0m of paydown against 56.8m of receipts, HARRIET ODOMETA
           -- 30.0m against 28.8m — so neither substitutes for the other.
           --
           -- app.loan_repayments is the receipt feed and keys on the loan ACCOUNT
           -- NUMBER, so it carries none of the cbs_customer_id collision risk that
           -- (correctly) keeps collection_payments away from this arm.
           --
           -- Where no receipt is on record the figure is 0, which is the honest answer:
           -- 22 of the 42 live facilities have no repayment row, and the old derived
           -- number was presenting an inference as a collection. The paydown it used to
           -- show is still derivable on the client from loc_kobo - outstanding_kobo,
           -- both of which this arm already returns.
           COALESCE(lp.paid_kobo,0)::bigint,
           -- Udara receipts post straight from core banking and pass through no
           -- approval chain, so none of this money is awaiting sign-off.
           0::bigint,
           false,
           -- THE FIX (2026-09-21). The cif column above still COALESCEs to the raw
           -- cbs_customer_id so the facility keeps a name to display and navigate by —
           -- but that value is a UDARA id and must never reach a cards-keyed table.
           -- cards_key therefore carries ONLY the crosswalked cards key and stays NULL
           -- when the crosswalk yields none. Live, 34 of 41 Udara loans have no cards
           -- key; all 34 collide with an unrelated card CIF, and 26 of them were
           -- picking up that stranger's collection assignment, agent and stage.
           uo.customer_key
      FROM cbs_loans cl
      LEFT JOIN udara_owner uo ON uo.cbs_customer_id = cl.cbs_customer_id
      -- On the loan ACCOUNT NUMBER. Deliberately not on any customer id: that is the
      -- namespace that collides, and this one does not.
      LEFT JOIN loan_paid lp    ON lp.cbs_loan_account = cl.cbs_account_number
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
           -- Receipts still inside the approval chain, run down the SAME oldest-first
           -- waterfall and then netted of what approved money already claimed, so the
           -- per-loan figures still sum to the CIF's pending pool. Reported beside
           -- amount_paid_kobo, never inside it, and never into pct_paid or the tier.
           LEAST(u.approved_kobo, GREATEST(u.cif_pool + u.cif_pending_pool - u.claimed_before, 0))
             - LEAST(u.approved_kobo, GREATEST(u.cif_pool - u.claimed_before, 0)),
           -- The same debt is also booked in Udara: shown, but flagged so it is not
           -- read as extra exposure.
           u.also_in_udara,
           -- Uploaded loans are keyed by the same account_cif the collections tables
           -- use (cards CIFs, plus synthetic W-prefixed workspace keys that collide
           -- with nothing), so the key is its own join key.
           u.account_cif
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
			    -- Money received but NOT yet through HOP -> COO -> CFO. Surfaced as its
			    -- own column and deliberately kept out of amount_paid_kobo, pct_paid and
			    -- the tier below: it has not been signed off and has not posted to the GL.
			    f.pending_paid_kobo,
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
			            WHEN EXISTS (SELECT 1 FROM collection_promises cp WHERE cp.cif_number = f.cards_key AND cp.is_kept IS NULL) THEN 'promise'
			            WHEN EXISTS (SELECT 1 FROM collection_contacts cc WHERE cc.cif_number = f.cards_key) THEN 'contacted'
			            ELSE 'new' END) AS current_stage,
			    lc.agent_name      AS last_call_agent,
			    lc.started_at      AS last_call_at,
			    lc.disposition     AS last_call_disposition
			FROM ranked f
			LEFT JOIN assign ass ON ass.account_cif = f.cards_key
			LEFT JOIN o3c_users u ON u.id = ass.agent_user_id
			LEFT JOIN last_call lc ON lc.cif = f.cards_key
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
