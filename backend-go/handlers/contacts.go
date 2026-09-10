package handlers

import (
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// isNameLike reports whether s contains at least one alphabetic character, so a
// value that is really a phone number (all digits / punctuation) is rejected.
func isNameLike(s string) bool {
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			return true
		}
	}
	return false
}

// cleanNameStr trims whitespace and drops any leading non-letter run (stray
// titles/punctuation like ". Sunday Essien" → "Sunday Essien").
func cleanNameStr(s string) string {
	s = strings.TrimSpace(s)
	for i, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			return strings.TrimSpace(s[i:])
		}
	}
	return s
}

func RegisterContactProfile(r chi.Router, db *core.DB) {
	access := core.RequirePages("customer360", "los", "recovery", "helpdesk", "collections")
	// The more specific paths must be registered before the bare "/{cif}" or chi
	// would never reach them.
	r.With(access).Get("/{cif}/transactions", contactTransactionsHandler(db))
	r.With(access).Get("/{cif}/documents", contactDocumentsHandler(db))
	r.With(access).Get("/{cif}", contactProfileHandler(db))
}

// contactDocumentsHandler returns every document uploaded against any of the
// person's credit applications (los_documents → loan_applications by applicant_cif),
// across all the CIFs that belong to the same party. This is what powers the
// Documents tab on Customer 360: the KYC and supporting files a Sales officer
// collected during origination, rendered on the customer's own page rather than
// only inside the application. Empty until an application has been raised — the
// files live on the application, so a CBS-only customer has none yet.
func contactDocumentsHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		ctx := r.Context()
		// Resolve by the universal customer key: a real CIF (card customers) when present,
		// else the workspace contact_id (loan/FD customers with no card CIF). $1 may be
		// either, so match on COALESCE(cif, contact_id).
		personCIFs := `(SELECT COALESCE(NULLIF(c2.cif,''), c2.contact_id) FROM app.customers c2
		    WHERE c2.party_id = (SELECT party_id FROM app.customers WHERE COALESCE(NULLIF(cif,''), contact_id) = $1 LIMIT 1)
		      AND c2.party_id IS NOT NULL
		    UNION SELECT $1)`
		rows, err := db.PGQuery(ctx, `
			SELECT d.id, d.doc_type, d.file_name, d.file_url, d.file_size_bytes,
			       d.created_at, la.reference AS application_ref, la.product_type,
			       u.full_name AS uploaded_by_name
			FROM los_documents d
			JOIN loan_applications la ON la.id = d.application_id
			LEFT JOIN o3c_users u ON u.id = d.uploaded_by
			WHERE la.applicant_cif IN `+personCIFs+`
			ORDER BY d.created_at DESC`, cif)
		if err != nil {
			// The LOS tables may not exist on a fresh DB — return empty, not a 500.
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, []core.Row{}, "pg")
				return
			}
			respondErrLog(w, 500, "contact documents query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func contactProfileHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		ctx := r.Context()

		// A CIF is a card, and one PERSON holds many CIFs. Resolve every CIF that
		// belongs to the same person (party) as the one opened, so Cards and
		// Transactions show the whole person — not just this one card. Falls back to
		// the single CIF when the row isn't linked to a party yet.
		// Resolve by the universal customer key: a real CIF (card customers) when present,
		// else the workspace contact_id (loan/FD customers with no card CIF). $1 may be
		// either, so match on COALESCE(cif, contact_id).
		personCIFs := `(SELECT COALESCE(NULLIF(c2.cif,''), c2.contact_id) FROM app.customers c2
		    WHERE c2.party_id = (SELECT party_id FROM app.customers WHERE COALESCE(NULLIF(cif,''), contact_id) = $1 LIMIT 1)
		      AND c2.party_id IS NOT NULL
		    UNION SELECT $1)`

		// The person's Udara/CBS customer ids, resolved through the curated cbs_links
		// crosswalk (party -> cbs_customer_id). CBS loans/FDs MUST be resolved this way,
		// NOT by cbs_customer_id IN personCIFs: cbs_customer_id and app.customers.cif are
		// different id namespaces that collide (Udara 00000424=FINTRAK vs card CIF
		// 00000424=an unrelated person), which is what showed a stranger's ₦80m loan on
		// the wrong customer's 360.
		personCBSIDs := `(SELECT k.cbs_customer_id FROM app.cbs_links k
		    WHERE k.entity_type='party'
		      AND k.entity_id = (SELECT party_id FROM app.customers WHERE COALESCE(NULLIF(cif,''), contact_id) = $1 LIMIT 1))`

		// ── Identity from the customer master ("Accounts" — Sage snapshot) ─────
		acctRows, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(TRIM(CONCAT(first_name, ' ', last_name)),''), full_name) AS name,
			       phone AS phone, email AS email,
			       state AS state, city AS city, country AS country, job_title AS job_title,
			       COALESCE(NULLIF(TRIM(full_address),''),
			                NULLIF(TRIM(CONCAT_WS(', ', NULLIF(address_1,''), NULLIF(address_2,''), NULLIF(city,''), NULLIF(state,''))),'')) AS full_address,
			       address_1, address_2,
			       contact_id AS customer_id, cif AS real_cif,
			       birthday::text AS date_of_birth
			FROM app.customers WHERE COALESCE(NULLIF(cif,''), contact_id) = $1 LIMIT 1`, cif)

		// ── Cards / accounts — ALL of the person's cards across their CIFs ─────
		//    Each card carries its OWN cif (a CIF is a card, not a person), which is
		//    what the transactions ledger is keyed by — so the cif returned here is
		//    the handle the Transactions tab filters on.
		prodRows, _ := db.PGQuery(ctx, `
			SELECT a.account_id AS account_id, a.cif AS cif, a.account_no AS account_no,
			       a.product_name AS product_name, a.status AS status,
			       a.name_on_card AS name_on_card, a.card_pan AS card_pan,
			       COALESCE(NULLIF(a.card_product,''), NULLIF(a.card_program,'')) AS scheme,
			       a.card_limit, a.current_dr_balance, a.cycle_balance, a.card_utilisation,
			       a.min_payment_due, a.days_overdue,
			       a.last_amount_paid, a.last_payment_date::text AS last_payment_date,
			       a.card_expiry_date::text AS card_expiry_date,
			       a.payment_due_date::text AS payment_due_date,
			       a.opened_date::text      AS opened_date,
			       COALESCE(t.n, 0)         AS txn_count,
			       t.last_txn::text         AS last_txn_date
			FROM app.accounts a
			LEFT JOIN LATERAL (
			  SELECT COUNT(*) AS n, MAX(txn_date) AS last_txn
			    FROM core.transaction t WHERE t.cif = a.cif
			) t ON TRUE
			WHERE a.cif IN `+personCIFs+`
			ORDER BY (LOWER(a.status) IN ('active','open')) DESC, COALESCE(t.n,0) DESC, a.cif`, cif)

		// ── Loans from the CBS/Udara book ─────────────────────────────────────
		cbsLoans, _ := db.PGQuery(ctx, `
			SELECT cbs_account_number, product_name, status,
			       outstanding_principal_kobo, loan_amount_kobo, interest_rate,
			       start_date, maturity_date
			FROM cbs_loans WHERE cbs_customer_id IN `+personCBSIDs+`
			ORDER BY start_date DESC`, cif)

		// ── Fixed deposits from the CBS/Udara register ────────────────────────
		cbsFDs, _ := db.PGQuery(ctx, `
			SELECT cbs_account_number, product_name, status,
			       principal_kobo, accrued_interest_kobo, interest_rate,
			       commencement_date, maturity_date
			FROM cbs_fixed_deposits WHERE cbs_customer_id IN `+personCBSIDs+`
			ORDER BY commencement_date DESC`, cif)

		// ── Recent account transactions (naira). Read the base table so we get
		//    the authoritative money_in flag — in this source credits carry a
		//    NEGATIVE amount, so the sign alone cannot be trusted for direction. ─
		txnRows, _ := db.PGQuery(ctx, `
			SELECT txn_date::text AS date, amount::float8 AS amount, money_in,
			       description, merchant_name AS merchant
			FROM transaction WHERE cif IN `+personCIFs+`
			ORDER BY txn_date DESC LIMIT 40`, cif)
		var txnTotal int64
		if rows, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM transaction WHERE cif IN `+personCIFs, cif); len(rows) > 0 {
			txnTotal = toInt64(rows[0]["n"])
		}

		// ── Payment history — the customer's actual repayments (money_in). This is
		//    what the collections & recovery teams work from, so it gets its own
		//    detailed list rather than being buried in the mixed transaction feed. ─
		payRows, _ := db.PGQuery(ctx, `
			SELECT txn_date::text AS date, ABS(amount)::float8 AS amount,
			       description, merchant_name AS merchant
			FROM transaction WHERE cif IN `+personCIFs+` AND money_in = TRUE
			ORDER BY txn_date DESC LIMIT 60`, cif)
		// Repayment pattern — money paid in per month over the last 12 months, so the
		// team can see cadence (regular vs erratic) at a glance.
		patRows, _ := db.PGQuery(ctx, `
			SELECT TO_CHAR(DATE_TRUNC('month',txn_date),'Mon YY') AS month,
			       DATE_TRUNC('month',txn_date) AS msort,
			       COALESCE(SUM(ABS(amount)),0)::float8 AS amount, COUNT(*) AS count
			FROM transaction WHERE cif IN `+personCIFs+` AND money_in = TRUE
			  AND txn_date >= DATE_TRUNC('month',CURRENT_DATE) - INTERVAL '11 months'
			GROUP BY 1, 2 ORDER BY msort`, cif)

		// ── CRM contact record ────────────────────────────────────────────────
		contacts, _ := db.PGQuery(ctx, `
			SELECT id, first_name, last_name, phone, email,
			       id_type, id_number, address, state, employer,
			       income_range, date_of_birth, gender, status, created_at
			FROM crm_contacts WHERE cif_number IN `+personCIFs+` LIMIT 1`, cif)

		// ── Loan applications (applications list + active loans) ───────────────
		apps, _ := db.PGQuery(ctx, `
			SELECT id, reference, applicant_name, applicant_phone, applicant_email,
			       product_type, amount_requested_kobo, amount_approved_kobo,
			       disbursed_amount_kobo, outstanding_kobo, dpd, next_due_date,
			       stage, disbursed_at, created_at
			FROM loan_applications
			WHERE applicant_cif IN `+personCIFs+`
			ORDER BY created_at DESC LIMIT 20`, cif)

		// ── Collections assignment (most recent) ───────────────────────────────
		colls, _ := db.PGQuery(ctx, `
			SELECT ca.dpd_bucket, ca.outstanding_kobo, ca.current_stage,
			       u.full_name AS agent_name,
			       (SELECT MAX(cc.created_at) FROM collection_contacts cc
			        WHERE cc.cif_number = ca.account_cif) AS last_contact_at,
			       (SELECT cp.promised_date FROM collection_promises cp
			        WHERE cp.cif_number = ca.account_cif AND cp.is_kept = FALSE
			        ORDER BY cp.created_at DESC LIMIT 1) AS ptp_date
			FROM collection_assignments ca
			LEFT JOIN o3c_users u ON u.id = ca.agent_user_id
			WHERE ca.account_cif IN `+personCIFs+`
			ORDER BY ca.updated_at DESC LIMIT 1`, cif)

		// ── Recovery case (most recent) ────────────────────────────────────────
		recov, _ := db.PGQuery(ctx, `
			SELECT rc.id, rc.case_ref, rc.status, rc.outstanding_kobo,
			       COALESCE(rc.recovered_kobo, 0) AS recovered_kobo,
			       COALESCE(rc.write_off_amount_kobo, 0) AS write_off_amount_kobo,
			       rc.legal_stage, u.full_name AS agent_name, rc.opened_at
			FROM recovery_cases rc
			LEFT JOIN o3c_users u ON u.id = rc.assigned_agent_id
			WHERE rc.account_cif IN `+personCIFs+`
			ORDER BY rc.opened_at DESC LIMIT 1`, cif)

		// ── Helpdesk tickets ───────────────────────────────────────────────────
		tickets, _ := db.PGQuery(ctx, `
			SELECT id, ticket_ref, subject, status, priority, created_at
			FROM helpdesk_tickets
			WHERE customer_cif IN `+personCIFs+`
			ORDER BY created_at DESC LIMIT 20`, cif)

		// ── Every identity row for this person (party) — so the profile can list ALL
		//    their ids: card CIFs, the workspace Customer ID, etc. One person holds
		//    many CIFs (a CIF is a card), plus a workspace id when they have no card. ─
		partyRows, _ := db.PGQuery(ctx, `
			SELECT c.cif, c.contact_id, c.source, c.party_id
			FROM app.customers c
			WHERE c.party_id = (SELECT party_id FROM app.customers WHERE COALESCE(NULLIF(cif,''),contact_id)=$1 LIMIT 1)
			  AND c.party_id IS NOT NULL
			UNION
			SELECT c.cif, c.contact_id, c.source, c.party_id
			FROM app.customers c WHERE COALESCE(NULLIF(cif,''),contact_id)=$1`, cif)

		// ── Uploaded / manually-tracked loans (collections book), keyed by any of the
		//    person's ids — these are NOT in the Udara loan book. ─────────────────────
		manualLoanRows, _ := db.PGQuery(ctx, `
			SELECT loan_ref, customer_name, outstanding_kobo, repayment_kobo, loan_tenor,
			       loan_rate, debit_day, disbursement_date, maturity_date, dpd_bucket,
			       officer_name, data_source
			FROM collection_assignments
			WHERE product_type='loan' AND account_cif IN `+personCIFs+`
			ORDER BY updated_at DESC`, cif)

		// ── Activity log (UNION across all modules) ────────────────────────────
		activityRows, _ := db.PGQuery(ctx, `
			SELECT id, type, description, created_by, created_at, module, ref, meta
			FROM (
				SELECT a.id::text AS id,
				       a.type,
				       COALESCE(a.note,'') AS description,
				       COALESCE(u.full_name,'') AS created_by,
				       a.created_at,
				       'crm' AS module,
				       '' AS ref,
				       '' AS meta
				FROM crm_activities a
				LEFT JOIN o3c_users u ON u.id = a.created_by
				WHERE a.contact_id IN (SELECT id FROM crm_contacts WHERE cif_number IN `+personCIFs+`)

				UNION ALL

				SELECT ae.id::text,
				       ae.event_type AS type,
				       COALESCE(ae.notes,'') AS description,
				       COALESCE(u.full_name,'') AS created_by,
				       ae.created_at,
				       'los' AS module,
				       COALESCE(la.reference,'') AS ref,
				       CASE
				         WHEN ae.from_stage IS NOT NULL AND ae.to_stage IS NOT NULL
				         THEN ae.from_stage || ' → ' || ae.to_stage
				         ELSE ''
				       END AS meta
				FROM application_events ae
				JOIN loan_applications la ON la.id = ae.application_id
				LEFT JOIN o3c_users u ON u.id = ae.actor_user_id
				WHERE la.applicant_cif IN `+personCIFs+`

				UNION ALL

				SELECT cc.id::text,
				       'collection_contact' AS type,
				       COALESCE(cc.notes, cc.outcome, '') AS description,
				       COALESCE(u.full_name,'') AS created_by,
				       cc.created_at,
				       'collections' AS module,
				       '' AS ref,
				       CONCAT_WS(' · ', NULLIF(cc.contact_type,''), NULLIF(cc.outcome,'')) AS meta
				FROM collection_contacts cc
				LEFT JOIN o3c_users u ON u.id = cc.agent_user_id
				WHERE cc.cif_number IN `+personCIFs+`

				UNION ALL

				SELECT t.id::text,
				       'ticket_opened' AS type,
				       t.subject AS description,
				       '' AS created_by,
				       t.created_at,
				       'helpdesk' AS module,
				       COALESCE(t.ticket_ref,'') AS ref,
				       CONCAT_WS(' · ', NULLIF(t.priority,''), NULLIF(t.status,'')) AS meta
				FROM helpdesk_tickets t
				WHERE t.customer_cif IN `+personCIFs+`
			) sub
			ORDER BY created_at DESC
			LIMIT 30`, cif)

		// ── Base profile ───────────────────────────────────────────────────────
		profile := map[string]any{
			"cif":                cif,
			"name":               "",
			"phone":              nil,
			"email":              nil,
			"applications":       []any{},
			"active_loans":       []any{},
			"cards":              []any{},
			"fixed_deposits":     []any{},
			"helpdesk_tickets":   []any{},
			"activity_log":       []any{},
			"is_prospect":        false,
			"is_applicant":       false,
			"is_active_customer": false,
			"is_card_holder":     false,
			"is_delinquent":      false,
			"is_in_recovery":     false,
			"is_written_off":     false,
		}

		// Identity from the "Accounts" master (real customer data). CRM record, if any,
		// overrides below.
		if len(acctRows) > 0 {
			a := acctRows[0]
			profile["name"] = a["name"]
			profile["phone"] = a["phone"]
			profile["email"] = a["email"]
			profile["state"] = a["state"]
			profile["city"] = a["city"]
			profile["country"] = a["country"]
			profile["full_address"] = a["full_address"]
			profile["address_line"] = a["address_1"]
			profile["address_2"] = a["address_2"]
			profile["employer"] = a["job_title"]
			profile["date_of_birth"] = a["date_of_birth"]
		}

		// fillIfEmpty augments the profile without clobbering good master data —
		// the "Accounts" snapshot is authoritative for identity; CRM only fills gaps.
		fillIfEmpty := func(key string, val any) {
			if str(profile[key]) == "" && str(val) != "" {
				profile[key] = val
			}
		}

		// Fill from CRM contact
		if len(contacts) > 0 {
			c := contacts[0]
			crmName := strings.TrimSpace(str(c["first_name"]) + " " + str(c["last_name"]))
			if isNameLike(crmName) {
				fillIfEmpty("name", crmName)
			}
			fillIfEmpty("phone", c["phone"])
			fillIfEmpty("email", c["email"])
			fillIfEmpty("state", c["state"])
			fillIfEmpty("employer", c["employer"])
			fillIfEmpty("date_of_birth", c["date_of_birth"])
			profile["address"] = c["address"]
			fillIfEmpty("full_address", c["address"])
			profile["gender"] = c["gender"]
			idType := str(c["id_type"])
			if idType == "BVN" {
				profile["bvn"] = c["id_number"]
			} else if idType == "NIN" {
				profile["nin"] = c["id_number"]
			}
			profile["is_prospect"] = str(c["status"]) == "prospect"

			// CRM sub-section
			contactID := c["id"]
			deals, _ := db.PGQuery(ctx, `
				SELECT d.id, d.title, COALESCE(d.value_kobo,0) AS value_kobo,
				       COALESCE(s.name,'') AS stage
				FROM crm_deals d
				LEFT JOIN crm_pipeline_stages s ON s.id = d.stage_id
				WHERE d.contact_id = $1
				ORDER BY d.created_at DESC LIMIT 10`, contactID)
			activities, _ := db.PGQuery(ctx, `
				SELECT a.id, a.type, COALESCE(a.note,'') AS note, a.created_at,
				       COALESCE(u.full_name,'') AS "user"
				FROM crm_activities a
				LEFT JOIN o3c_users u ON u.id = a.created_by
				WHERE a.contact_id = $1
				ORDER BY a.created_at DESC LIMIT 20`, contactID)

			if deals == nil {
				deals = []core.Row{}
			}
			if activities == nil {
				activities = []core.Row{}
			}

			profile["crm"] = map[string]any{
				"contact_id":  contactID,
				"status":      c["status"],
				"assigned_to": "",
				"created_at":  c["created_at"],
				"deals":       deals,
				"activities":  activities,
			}
		} else if len(apps) > 0 {
			// No CRM record — infer basics from loan application
			a := apps[0]
			if n := str(a["applicant_name"]); isNameLike(n) {
				fillIfEmpty("name", n)
			}
			fillIfEmpty("phone", a["applicant_phone"])
			fillIfEmpty("email", a["applicant_email"])
		}

		// Final fallback: if we still don't have a real name (master/CRM blank or a
		// phone slipped into the field), use the card's "Name On Card".
		if !isNameLike(str(profile["name"])) {
			for _, p := range prodRows {
				if noc := str(p["name_on_card"]); isNameLike(noc) {
					profile["name"] = noc
					break
				}
			}
		}
		profile["name"] = cleanNameStr(str(profile["name"]))

		// Loans from the CBS/Udara book (native loan_applications is empty).
		// open = NOT IN ('Closed','Revoked');  NPL = Defaulting/Expired.
		appList := make([]any, 0)
		activeLoans := make([]any, 0)
		hasDelinquent := false
		for _, l := range cbsLoans {
			status := str(l["status"])
			open := status != "Closed" && status != "Revoked"
			appList = append(appList, map[string]any{
				"id":                    l["cbs_account_number"],
				"ref":                   l["cbs_account_number"],
				"product_type":          l["product_name"],
				"amount_requested_kobo": l["loan_amount_kobo"],
				"stage":                 status,
				"created_at":            l["start_date"],
			})
			if open {
				activeLoans = append(activeLoans, map[string]any{
					"id":                l["cbs_account_number"],
					"ref":               l["cbs_account_number"],
					"product_type":      l["product_name"],
					"outstanding_kobo":  l["outstanding_principal_kobo"],
					"disbursed_kobo":    l["loan_amount_kobo"],
					"dpd":               0,
					"status":            status,
					"next_payment_date": l["maturity_date"],
				})
			}
			if status == "Defaulting" || status == "Expired" {
				hasDelinquent = true
			}
		}
		profile["applications"] = appList
		profile["active_loans"] = activeLoans
		profile["is_applicant"] = len(cbsLoans) > 0
		if hasDelinquent {
			profile["is_delinquent"] = true
		}

		// Cards / accounts. The card's own CIF is the id — name_on_card is not
		// unique (one person's 21 cards can all read "ABIMBOLA PINHEIRO") and is
		// not what transactions are keyed by.
		cardList := make([]any, 0)
		hasActiveCard := false
		for _, p := range prodRows {
			status := str(p["status"])
			cardList = append(cardList, map[string]any{
				// account_id is the only unique key on the card book; two card rows can
				// share one cif, so cif alone would collide as a list key.
				"id":                 p["account_id"],
				"cif":                p["cif"],
				"account_no":         p["account_no"],
				"card_number_masked": p["card_pan"],
				"name_on_card":       p["name_on_card"],
				"product_name":       p["product_name"],
				"scheme":             p["scheme"],
				"status":             status,
				// Balances here are naira numerics from the card book, not kobo.
				"balance":             p["current_dr_balance"],
				"bill_balance":        p["cycle_balance"],
				"credit_limit":        p["card_limit"],
				"utilisation":         p["card_utilisation"],
				"min_payment":         p["min_payment_due"],
				"days_overdue":        p["days_overdue"],
				"last_payment_amount": p["last_amount_paid"],
				"last_payment_date":   p["last_payment_date"],
				"expiry_date":         p["card_expiry_date"],
				"payment_due":         p["payment_due_date"],
				"issued_at":           p["opened_date"],
				"txn_count":           p["txn_count"],
				"last_txn_date":       p["last_txn_date"],
			})
			if lc := strings.ToLower(status); lc == "open" || lc == "active" {
				hasActiveCard = true
			}
		}
		profile["cards"] = cardList
		profile["is_card_holder"] = hasActiveCard

		// Fixed deposits from the CBS/Udara register.
		fdList := make([]any, 0)
		hasActiveFD := false
		for _, f := range cbsFDs {
			status := str(f["status"])
			fdList = append(fdList, map[string]any{
				"id":                    f["cbs_account_number"],
				"ref":                   f["cbs_account_number"],
				"product_name":          f["product_name"],
				"status":                status,
				"principal_kobo":        f["principal_kobo"],
				"accrued_interest_kobo": f["accrued_interest_kobo"],
				"interest_rate":         f["interest_rate"],
				"commencement_date":     f["commencement_date"],
				"maturity_date":         f["maturity_date"],
			})
			if status == "Active" {
				hasActiveFD = true
			}
		}
		profile["fixed_deposits"] = fdList

		profile["is_active_customer"] = len(activeLoans) > 0 || hasActiveCard || hasActiveFD

		// Recent account transactions (naira amounts).
		txnList := make([]any, 0)
		for _, t := range txnRows {
			// Source encodes credits as negative amounts; expose the absolute
			// naira value and let money_in carry the direction unambiguously.
			amt := toFloat64(t["amount"])
			if amt < 0 {
				amt = -amt
			}
			txnList = append(txnList, map[string]any{
				"date":        t["date"],
				"amount":      amt,
				"money_in":    t["money_in"],
				"description": t["description"],
				"merchant":    t["merchant"],
			})
		}
		profile["transactions"] = txnList

		// Payment history (repayments) + monthly repayment pattern.
		payList := make([]any, 0)
		for _, p := range payRows {
			payList = append(payList, map[string]any{
				"date": p["date"], "amount": p["amount"],
				"description": p["description"], "merchant": p["merchant"],
			})
		}
		profile["payment_history"] = payList
		patList := make([]any, 0)
		for _, p := range patRows {
			patList = append(patList, map[string]any{
				"month": p["month"], "amount": p["amount"], "count": p["count"],
			})
		}
		profile["repayment_pattern"] = patList
		if len(payList) > 0 {
			profile["last_payment"] = payList[0]
		}

		// Relationship summary — drives the KPI strip + financial snapshot.
		var loanOut, fdPrincipal, fdAccrued int64
		loanCount := 0
		for _, l := range cbsLoans {
			if s := str(l["status"]); s != "Closed" && s != "Revoked" {
				loanOut += toInt64(l["outstanding_principal_kobo"])
				loanCount++
			}
		}
		fdCount, activeCards := 0, 0
		for _, f := range cbsFDs {
			if str(f["status"]) == "Active" {
				fdPrincipal += toInt64(f["principal_kobo"])
				fdAccrued += toInt64(f["accrued_interest_kobo"])
				fdCount++
			}
		}
		for _, p := range prodRows {
			// The card book stores both "Active" and "active" — match case-insensitively
			// or the strip under-counts by the 541 lowercase rows.
			if s := strings.ToLower(str(p["status"])); s == "open" || s == "active" {
				activeCards++
			}
		}
		profile["summary"] = map[string]any{
			"loan_outstanding_kobo": loanOut,
			"loan_count":            loanCount,
			"fd_principal_kobo":     fdPrincipal,
			"fd_accrued_kobo":       fdAccrued,
			"fd_count":              fdCount,
			"card_count":            len(prodRows),
			"active_card_count":     activeCards,
			"txn_count":             txnTotal,
			"net_position_kobo":     fdPrincipal - loanOut,
		}

		// Collections
		if len(colls) > 0 {
			c := colls[0]
			bucket := str(c["dpd_bucket"])
			profile["collections"] = map[string]any{
				"dpd":              dpdMidpoint(bucket),
				"dpd_bucket":       bucket,
				"outstanding_kobo": c["outstanding_kobo"],
				"last_contact_at":  c["last_contact_at"],
				"agent_name":       c["agent_name"],
				"ptp_date":         c["ptp_date"],
				"current_stage":    c["current_stage"],
			}
			profile["is_delinquent"] = bucket != "0" && bucket != ""
		}

		// Recovery
		if len(recov) > 0 {
			rc := recov[0]
			profile["recovery_case"] = map[string]any{
				"id":                    rc["id"],
				"case_ref":              rc["case_ref"],
				"status":                rc["status"],
				"outstanding_kobo":      rc["outstanding_kobo"],
				"recovered_kobo":        rc["recovered_kobo"],
				"write_off_amount_kobo": rc["write_off_amount_kobo"],
				"legal_stage":           rc["legal_stage"],
				"agent_name":            rc["agent_name"],
				"opened_at":             rc["opened_at"],
			}
			profile["is_in_recovery"] = true
			if toInt64(rc["write_off_amount_kobo"]) > 0 {
				profile["is_written_off"] = true
			}
		}

		// ── Identifiers — every id this person carries, consolidated. Customer ID is
		//    the one universal per-person id (party); CIFs are card ids; loan mandates
		//    and Udara loan/FD account numbers are listed too. ───────────────────────
		var partyID int64
		cifSet := map[string]bool{}
		wsSet := map[string]bool{}
		for _, pr := range partyRows {
			if partyID == 0 {
				partyID = toInt64(pr["party_id"])
			}
			id := str(pr["cif"])
			cid := str(pr["contact_id"])
			if id != "" && !isSyntheticID(id) {
				cifSet[id] = true // a real (card) CIF
			} else if cid != "" && !isSyntheticID(cid) {
				wsSet[cid] = true // a real workspace-only id (no card CIF)
			}
			// Synthetic placeholder handles (W…/Z…/cid:…) generated for customers with no
			// real card CIF carry no external meaning — the canonical CUST-<party_id> stands
			// in for them — so they are never surfaced. Make sure one never leaks into the
			// CIF list either.
			if isSyntheticID(id) {
				delete(cifSet, id)
			}
			if isSyntheticID(cid) {
				delete(cifSet, cid)
			}
		}
		cifs := make([]string, 0, len(cifSet))
		for k := range cifSet {
			cifs = append(cifs, k)
		}
		sort.Strings(cifs)
		wsIDs := make([]string, 0, len(wsSet))
		for k := range wsSet {
			wsIDs = append(wsIDs, k)
		}
		sort.Strings(wsIDs)

		// Manual (uploaded) loans + their mandate ids.
		manualLoans := make([]any, 0)
		mandates := make([]string, 0)
		for _, l := range manualLoanRows {
			manualLoans = append(manualLoans, map[string]any{
				"mandate_id":        l["loan_ref"],
				"name":              l["customer_name"],
				"outstanding_kobo":  l["outstanding_kobo"],
				"repayment_kobo":    l["repayment_kobo"],
				"tenor":             l["loan_tenor"],
				"rate":              l["loan_rate"],
				"debit_day":         l["debit_day"],
				"disbursement_date": l["disbursement_date"],
				"maturity_date":     l["maturity_date"],
				"dpd_bucket":        l["dpd_bucket"],
				"officer_name":      l["officer_name"],
				"source":            l["data_source"],
			})
			if m := str(l["loan_ref"]); m != "" && m != "NO MANDATE" {
				mandates = append(mandates, m)
			}
		}
		profile["loans"] = manualLoans

		// Udara loan / FD account numbers.
		udaraLoanAccts := make([]string, 0)
		for _, l := range cbsLoans {
			if v := str(l["cbs_account_number"]); v != "" {
				udaraLoanAccts = append(udaraLoanAccts, v)
			}
		}
		fdAccts := make([]string, 0)
		for _, f := range cbsFDs {
			if v := str(f["cbs_account_number"]); v != "" {
				fdAccts = append(fdAccts, v)
			}
		}
		customerID := str(profile["cif"])
		if partyID > 0 {
			customerID = fmt.Sprintf("CUST-%06d", partyID)
		}
		profile["customer_id"] = customerID
		profile["identifiers"] = map[string]any{
			"customer_id":         customerID,
			"party_id":            partyID,
			"cifs":                cifs,           // card CIFs
			"workspace_ids":       wsIDs,          // non-card workspace ids
			"loan_mandates":       mandates,       // uploaded-loan mandate ids
			"udara_loan_accounts": udaraLoanAccts, // Udara loan account numbers
			"fd_accounts":         fdAccts,        // Udara FD account numbers
		}

		// Helpdesk tickets
		hdList := make([]any, 0)
		for _, t := range tickets {
			hdList = append(hdList, map[string]any{
				"id":         t["id"],
				"ticket_ref": t["ticket_ref"],
				"subject":    t["subject"],
				"status":     t["status"],
				"priority":   t["priority"],
				"created_at": t["created_at"],
			})
		}
		profile["helpdesk_tickets"] = hdList

		// Activity log
		actList := make([]any, 0)
		for _, a := range activityRows {
			actList = append(actList, map[string]any{
				"id":          a["id"],
				"type":        a["type"],
				"description": a["description"],
				"created_by":  a["created_by"],
				"created_at":  a["created_at"],
				"module":      a["module"],
				"ref":         a["ref"],
				"meta":        a["meta"],
			})
		}
		profile["activity_log"] = actList

		respond(w, profile, "pg")
	}
}

// dpdMidpoint returns an approximate DPD integer from a bucket string
// used only for display on the Contact Profile page.
func dpdMidpoint(bucket string) int {
	switch bucket {
	case "0":
		return 0
	case "1-30":
		return 15
	case "31-60":
		return 45
	case "61-90":
		return 75
	case "91-180":
		return 135
	case "181-360":
		return 270
	default:
		return 365
	}
}
