package handlers

import (
	"net/http"
	"strings"

	"github.com/o3c/workspace/core"
)

// repaymentPatternHandler returns a borrower's repayment cadence — the same money-in
// view Customer 360 shows, so the collections/recovery detail panels can render the
// monthly-repayment mini-chart without pulling the whole 360 profile.
//
// Mounted under BOTH /api/collections-ops and /api/recovery-ops so each inherits its own
// "collections"/"recovery" page guard.
//
// IDENTITY (2026-09-21 fix). The workspace carries three separate identifier namespaces
// that all look like an 8-digit "CIF" and are NOT interchangeable:
//
//	app.parties.party_id          — the workspace Customer ID, the only unifying key
//	app.customers.cif             — a CARDS identifier (CCS/Sage), not a customer id
//	cbs_loans.cbs_customer_id     — Udara core banking only
//
// This handler used to pull `transaction WHERE cif IN (<the party's CIFs> UNION $1)`,
// i.e. it joined the raw key straight onto the CARD transaction feed. Every one of the
// 44 Udara loan customer ids also exists as a cards CIF belonging to a DIFFERENT person
// (Udara 00000424 = FINTRAK; cards cif 00000424 = Adetunji Taiwo), so opening a Udara
// borrower's file rendered a stranger's narrations, merchants and "last payment" date
// under this borrower's name — 37 of the 44 showed someone else's money. That is both a
// collections hazard (an officer could escalate on it) and a data-protection exposure.
//
// Identity is now resolved to a party_id FIRST, and transactions are then pulled only for
// the CIFs that belong to that party. app.cbs_links (entity_type='party') is the only
// correct bridge from a Udara customer id to a party; it covers 294/294 Udara customers.
//
// The caller passes a bare string that can be valid in BOTH namespaces at once — all 44
// Udara loan ids are also live cards CIFs — so the string alone cannot say who is meant.
// The namespace is therefore decided from, in order:
//
//  1. an explicit ?party_id= — unambiguous, always wins;
//  2. an explicit ?origin=udara|cbs (→ cbs_links) or ?origin=cards|ccs (→ app.customers);
//  3. the party_id on the collections assignment / recovery case the panel is open on.
//     Measured against cbs_links, this column is trustworthy and is the only thing that
//     tells a card case from a loan case on the same string: every product_type='loan'
//     record agrees with cbs_links (6/6) and every product_type='card' record agrees with
//     the cards CIF (42/43);
//  4. that same ops record's product_type when its party_id is NULL (8 live card
//     assignments) — 'loan' means the Udara namespace, 'card' means the cards namespace;
//  5. cbs_links or app.customers when only ONE of them knows the key.
//
// If none of those apply and the key is live in both namespaces, the request is genuinely
// ambiguous and the handler REFUSES to guess: it returns the empty state naming both
// candidate parties rather than risk rendering a stranger's money. Showing nothing is
// recoverable; showing the wrong customer's transactions is not.
//
// The resolved party is echoed back in `identity` so the panel can show whose money it is
// displaying. Callers that hold a Udara loan (e.g. a drill-through from Payment Tiers,
// where rows carry origin='Udara' and cif=cbs_customer_id) should pass origin=udara, or
// better, the party_id outright.
func repaymentPatternHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := strings.TrimSpace(qstr(r, "cif"))
		partyParam := strings.TrimSpace(qstr(r, "party_id"))
		origin := strings.ToLower(strings.TrimSpace(qstr(r, "origin")))
		if cif == "" && partyParam == "" {
			respondErr(w, 422, "cif or party_id is required")
			return
		}

		// Gather every party this key could mean, in each namespace, plus the ops record
		// the panel is open on. The choice between them is made in Go below so the
		// precedence — and the refusal to guess — is auditable.
		idRows, err := db.PGQuery(r.Context(), `
			WITH want AS (
				SELECT $1::text AS key, NULLIF($2,'')::bigint AS party_param
			), assign AS (
				SELECT ca.party_id, ca.product_type
				  FROM want w JOIN app.collection_assignments ca ON ca.account_cif = w.key
				 ORDER BY (ca.party_id IS NOT NULL) DESC, (ca.status = 'active') DESC, ca.id DESC
				 LIMIT 1
			), rec AS (
				SELECT rc.party_id, rc.product_type
				  FROM want w JOIN app.recovery_cases rc
				    ON COALESCE(rc.account_cif, rc.cif_number) = w.key
				 ORDER BY (rc.party_id IS NOT NULL) DESC, (rc.status = 'open') DESC, rc.id DESC
				 LIMIT 1
			)
			SELECT w.party_param,
			       (SELECT lk.entity_id FROM app.cbs_links lk
			         WHERE lk.entity_type = 'party' AND lk.cbs_customer_id = w.key LIMIT 1) AS cbs_party,
			       (SELECT c.party_id FROM app.customers c
			         WHERE c.cif = w.key AND c.party_id IS NOT NULL LIMIT 1)                AS cards_party,
			       (SELECT party_id     FROM assign)                                       AS assign_party,
			       (SELECT product_type FROM assign)                                       AS assign_product,
			       (SELECT party_id     FROM rec)                                          AS rec_party,
			       (SELECT product_type FROM rec)                                          AS rec_product,
			       EXISTS (SELECT 1 FROM assign)                                           AS has_assign,
			       EXISTS (SELECT 1 FROM rec)                                              AS has_rec
			  FROM want w`, cif, partyParam)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}

		identity := core.Row{"cif": cif, "origin": origin, "resolved": false}
		var partyID, cbsParty, cardsParty int64
		var resolvedVia string
		var ambiguous bool
		if len(idRows) > 0 {
			c := idRows[0]
			partyParamID := toInt64(c["party_param"])
			cbsParty = toInt64(c["cbs_party"])
			cardsParty = toInt64(c["cards_party"])
			assignParty, recParty := toInt64(c["assign_party"]), toInt64(c["rec_party"])
			assignProd, recProd := str(c["assign_product"]), str(c["rec_product"])
			hasAssign, hasRec := c["has_assign"] == true, c["has_rec"] == true

			// opsNamespace maps a collections/recovery record's product_type to the
			// namespace its account_cif is drawn from. Verified on live data: every
			// product_type='loan' record's party_id agrees with cbs_links, every
			// product_type='card' record's agrees with the cards CIF.
			opsNamespace := func(prod string) int64 {
				if prod == "loan" && cbsParty > 0 {
					return cbsParty
				}
				return cardsParty
			}

			switch {
			case partyParamID > 0:
				partyID, resolvedVia = partyParamID, "party_id"
			case (origin == "udara" || origin == "cbs" || origin == "core_banking") && cbsParty > 0:
				partyID, resolvedVia = cbsParty, "cbs_link"
			case (origin == "cards" || origin == "ccs") && cardsParty > 0:
				partyID, resolvedVia = cardsParty, "cards_cif"
			case assignParty > 0:
				partyID, resolvedVia = assignParty, "collection_assignment"
			case recParty > 0:
				partyID, resolvedVia = recParty, "recovery_case"
			case hasAssign && opsNamespace(assignProd) > 0:
				partyID, resolvedVia = opsNamespace(assignProd), "collection_assignment_product_type"
			case hasRec && opsNamespace(recProd) > 0:
				partyID, resolvedVia = opsNamespace(recProd), "recovery_case_product_type"
			case cbsParty > 0 && cardsParty > 0 && cbsParty != cardsParty:
				// Live in both namespaces, nothing to break the tie. Refuse: a blank
				// panel is recoverable, a stranger's transactions are not.
				ambiguous = true
			case cbsParty > 0:
				partyID, resolvedVia = cbsParty, "cbs_link"
			case cardsParty > 0:
				partyID, resolvedVia = cardsParty, "cards_cif"
			}

			identity["resolved"] = partyID > 0
			identity["resolved_via"] = resolvedVia
			if partyID > 0 {
				identity["party_id"] = partyID
			}
			// Whenever the key is live in both namespaces, say so — even when we did
			// resolve it — so nobody reads this panel as the whole picture for the id.
			if cbsParty > 0 && cardsParty > 0 && cbsParty != cardsParty {
				identity["ambiguous_key"] = true
				identity["cbs_candidate_party_id"] = cbsParty
				identity["cards_candidate_party_id"] = cardsParty
			}
		}

		// Name the resolved party, for the panel to label whose money this is.
		if partyID > 0 {
			if nr, nerr := db.PGQuery(r.Context(),
				`SELECT full_name FROM app.parties WHERE party_id = $1`, partyID); nerr == nil && len(nr) > 0 {
				identity["party_name"] = nr[0]["full_name"]
			}
		}

		patRows := []core.Row{}
		payRows := []core.Row{}

		if partyID > 0 {
			// Every CARDS cif belonging to this party — the only cifs whose transactions
			// are this borrower's. NULLIF guards against a blank cif joining blank to
			// blank (app.norm_phone-style silent match); Udara-side app.customers rows
			// carry no cif at all.
			partyCIFs := `(SELECT DISTINCT c.cif FROM app.customers c
			    WHERE c.party_id = $1 AND NULLIF(TRIM(c.cif),'') IS NOT NULL)`

			// Money paid in per month over the last 12 months — cadence at a glance.
			patRows, err = db.PGQuery(r.Context(), `
				SELECT TO_CHAR(DATE_TRUNC('month',txn_date),'Mon YY') AS month,
				       DATE_TRUNC('month',txn_date) AS msort,
				       COALESCE(SUM(ABS(amount)),0)::float8 AS amount, COUNT(*) AS count
				FROM transaction WHERE cif IN `+partyCIFs+` AND money_in = TRUE
				  AND txn_date >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months'
				GROUP BY 1, 2 ORDER BY msort`, partyID)
			if err != nil {
				respondErrLog(w, 500, "Query failed", err)
				return
			}

			// The actual repayments (money_in), most recent first.
			payRows, err = db.PGQuery(r.Context(), `
				SELECT txn_date::text AS date, ABS(amount)::float8 AS amount,
				       description, merchant_name AS merchant
				FROM transaction WHERE cif IN `+partyCIFs+` AND money_in = TRUE
				ORDER BY txn_date DESC LIMIT 60`, partyID)
			if err != nil {
				respondErrLog(w, 500, "Query failed", err)
				return
			}
		}

		if patRows == nil {
			patRows = []core.Row{}
		}
		if payRows == nil {
			payRows = []core.Row{}
		}

		out := core.Row{
			"repayment_pattern": patRows,
			"payment_history":   payRows,
			"identity":          identity,
			"has_history":       len(payRows) > 0,
		}
		// An empty panel must say WHY it is empty. "No repayment history on file" and
		// "this borrower has never paid" are different statements and only the first is
		// one we can make: the card transaction feed simply does not cover Udara loans,
		// so every one of the 44 Udara borrowers legitimately has nothing here.
		if len(payRows) == 0 {
			switch {
			case ambiguous:
				out["empty_reason"] = "identity_ambiguous"
				out["empty_message"] = "This ID exists as both a cards CIF and a core-banking customer ID belonging to different customers. No repayment history is shown rather than risk showing the wrong customer's transactions."
			case partyID <= 0:
				out["empty_reason"] = "identity_unresolved"
				out["empty_message"] = "Customer could not be identified — no repayment history can be shown."
			case resolvedVia == "cbs_link" || cbsParty > 0:
				out["empty_reason"] = "not_in_card_transaction_feed"
				out["empty_message"] = "No repayment history on file. This borrower's repayments are tracked in core banking, not the card transaction feed."
			default:
				out["empty_reason"] = "no_repayment_history_on_file"
				out["empty_message"] = "No repayment history on file for this customer."
			}
		}
		if len(payRows) > 0 {
			out["last_payment"] = payRows[0]
		}
		respond(w, out, "pg")
	}
}
