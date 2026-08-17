package handlers

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
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
	// The more specific path must be registered before the bare "/{cif}" or chi
	// would never reach it.
	r.With(access).Get("/{cif}/transactions", contactTransactionsHandler(db))
	r.With(access).Get("/{cif}", contactProfileHandler(db))
}

func contactProfileHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		ctx := r.Context()

		// A CIF is a card, and one PERSON holds many CIFs. Resolve every CIF that
		// belongs to the same person (party) as the one opened, so Cards and
		// Transactions show the whole person — not just this one card. Falls back to
		// the single CIF when the row isn't linked to a party yet.
		personCIFs := `(SELECT c2.cif FROM app.customers c2
		    WHERE c2.party_id = (SELECT party_id FROM app.customers WHERE cif = $1 LIMIT 1)
		      AND c2.party_id IS NOT NULL
		    UNION SELECT $1)`

		// ── Identity from the customer master ("Accounts" — Sage snapshot) ─────
		acctRows, _ := db.PGQuery(ctx, `
			SELECT TRIM(CONCAT(first_name, ' ', last_name)) AS name,
			       phone AS phone, email AS email,
			       state AS state, city AS city, job_title AS job_title,
			       birthday::text AS date_of_birth
			FROM app.customers WHERE cif = $1 LIMIT 1`, cif)

		// ── Cards / accounts — ALL of the person's cards across their CIFs ─────
		//    Each card carries its OWN cif (a CIF is a card, not a person), which is
		//    what the transactions ledger is keyed by — so the cif returned here is
		//    the handle the Transactions tab filters on.
		prodRows, _ := db.PGQuery(ctx, `
			SELECT a.account_id AS account_id, a.cif AS cif, a.account_no AS account_no,
			       a.product_name AS product_name, a.status AS status,
			       a.name_on_card AS name_on_card, a.card_pan AS card_pan,
			       COALESCE(NULLIF(a.card_product,''), NULLIF(a.card_program,'')) AS scheme,
			       a.card_limit, a.current_dr_balance, a.card_utilisation,
			       a.min_payment_due, a.days_overdue,
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
			FROM cbs_loans WHERE cbs_customer_id IN `+personCIFs+`
			ORDER BY start_date DESC`, cif)

		// ── Fixed deposits from the CBS/Udara register ────────────────────────
		cbsFDs, _ := db.PGQuery(ctx, `
			SELECT cbs_account_number, product_name, status,
			       principal_kobo, accrued_interest_kobo, interest_rate,
			       commencement_date, maturity_date
			FROM cbs_fixed_deposits WHERE cbs_customer_id IN `+personCIFs+`
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
			LEFT JOIN o3c_users u ON u.id = rc.agent_user_id
			WHERE rc.account_cif IN `+personCIFs+`
			ORDER BY rc.opened_at DESC LIMIT 1`, cif)

		// ── Helpdesk tickets ───────────────────────────────────────────────────
		tickets, _ := db.PGQuery(ctx, `
			SELECT id, ticket_ref, subject, status, priority, created_at
			FROM helpdesk_tickets
			WHERE customer_cif IN `+personCIFs+`
			ORDER BY created_at DESC LIMIT 20`, cif)

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
			"cif":              cif,
			"name":             "",
			"phone":            nil,
			"email":            nil,
			"applications":     []any{},
			"active_loans":     []any{},
			"cards":            []any{},
			"fixed_deposits":   []any{},
			"helpdesk_tickets": []any{},
			"activity_log":     []any{},
			"is_prospect":      false,
			"is_applicant":     false,
			"is_active_customer": false,
			"is_card_holder":   false,
			"is_delinquent":    false,
			"is_in_recovery":   false,
			"is_written_off":   false,
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
				"id":  p["account_id"],
				"cif": p["cif"],
				"account_no":         p["account_no"],
				"card_number_masked": p["card_pan"],
				"name_on_card":       p["name_on_card"],
				"product_name":       p["product_name"],
				"scheme":             p["scheme"],
				"status":             status,
				// Balances here are naira numerics from the card book, not kobo.
				"balance":       p["current_dr_balance"],
				"credit_limit":  p["card_limit"],
				"utilisation":   p["card_utilisation"],
				"min_payment":   p["min_payment_due"],
				"days_overdue":  p["days_overdue"],
				"expiry_date":   p["card_expiry_date"],
				"payment_due":   p["payment_due_date"],
				"issued_at":     p["opened_date"],
				"txn_count":     p["txn_count"],
				"last_txn_date": p["last_txn_date"],
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
				"dpd":             dpdMidpoint(bucket),
				"dpd_bucket":      bucket,
				"outstanding_kobo": c["outstanding_kobo"],
				"last_contact_at": c["last_contact_at"],
				"agent_name":      c["agent_name"],
				"ptp_date":        c["ptp_date"],
				"current_stage":   c["current_stage"],
			}
			profile["is_delinquent"] = bucket != "0" && bucket != ""
		}

		// Recovery
		if len(recov) > 0 {
			rc := recov[0]
			profile["recovery_case"] = map[string]any{
				"id":                     rc["id"],
				"case_ref":               rc["case_ref"],
				"status":                 rc["status"],
				"outstanding_kobo":       rc["outstanding_kobo"],
				"recovered_kobo":         rc["recovered_kobo"],
				"write_off_amount_kobo":  rc["write_off_amount_kobo"],
				"legal_stage":            rc["legal_stage"],
				"agent_name":             rc["agent_name"],
				"opened_at":              rc["opened_at"],
			}
			profile["is_in_recovery"] = true
			if toInt64(rc["write_off_amount_kobo"]) > 0 {
				profile["is_written_off"] = true
			}
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
