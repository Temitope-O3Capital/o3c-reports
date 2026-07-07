package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterContactProfile(r chi.Router, db *core.DB) {
	access := core.RequirePages("customer360", "los", "recovery", "helpdesk", "collections")
	r.With(access).Get("/{cif}", contactProfileHandler(db))
}

func contactProfileHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		ctx := r.Context()

		// ── CRM contact record ────────────────────────────────────────────────
		contacts, _ := db.PGQuery(ctx, `
			SELECT id, first_name, last_name, phone, email,
			       id_type, id_number, address, state, employer,
			       income_range, date_of_birth, gender, status, created_at
			FROM crm_contacts WHERE cif_number = $1 LIMIT 1`, cif)

		// ── Loan applications (applications list + active loans) ───────────────
		apps, _ := db.PGQuery(ctx, `
			SELECT id, reference, applicant_name, applicant_phone, applicant_email,
			       product_type, amount_requested_kobo, amount_approved_kobo,
			       disbursed_amount_kobo, outstanding_kobo, dpd, next_due_date,
			       stage, disbursed_at, created_at
			FROM loan_applications
			WHERE applicant_cif = $1
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
			WHERE ca.account_cif = $1
			ORDER BY ca.updated_at DESC LIMIT 1`, cif)

		// ── Recovery case (most recent) ────────────────────────────────────────
		recov, _ := db.PGQuery(ctx, `
			SELECT rc.id, rc.case_ref, rc.status, rc.outstanding_kobo,
			       COALESCE(rc.recovered_kobo, 0) AS recovered_kobo,
			       COALESCE(rc.write_off_amount_kobo, 0) AS write_off_amount_kobo,
			       rc.legal_stage, u.full_name AS agent_name, rc.opened_at
			FROM recovery_cases rc
			LEFT JOIN o3c_users u ON u.id = rc.agent_user_id
			WHERE rc.account_cif = $1
			ORDER BY rc.opened_at DESC LIMIT 1`, cif)

		// ── Helpdesk tickets ───────────────────────────────────────────────────
		tickets, _ := db.PGQuery(ctx, `
			SELECT id, ticket_ref, subject, status, priority, created_at
			FROM helpdesk_tickets
			WHERE customer_cif = $1
			ORDER BY created_at DESC LIMIT 20`, cif)

		// ── Base profile ───────────────────────────────────────────────────────
		profile := map[string]any{
			"cif":              cif,
			"name":             "",
			"phone":            nil,
			"email":            nil,
			"applications":     []any{},
			"active_loans":     []any{},
			"cards":            []any{},
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

		// Fill from CRM contact
		if len(contacts) > 0 {
			c := contacts[0]
			fname := str(c["first_name"])
			lname := str(c["last_name"])
			name := fname
			if lname != "" {
				name += " " + lname
			}
			profile["name"] = name
			profile["phone"] = c["phone"]
			profile["email"] = c["email"]
			profile["address"] = c["address"]
			profile["state"] = c["state"]
			profile["employer"] = c["employer"]
			profile["date_of_birth"] = c["date_of_birth"]
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
			profile["name"] = str(a["applicant_name"])
			profile["phone"] = a["applicant_phone"]
			profile["email"] = a["applicant_email"]
		}

		// Applications list
		appList := make([]any, 0)
		activeLoans := make([]any, 0)
		for _, a := range apps {
			appList = append(appList, map[string]any{
				"id":                    a["id"],
				"ref":                   a["reference"],
				"product_type":          a["product_type"],
				"amount_requested_kobo": a["amount_requested_kobo"],
				"stage":                 a["stage"],
				"created_at":            a["created_at"],
			})
			if str(a["stage"]) == "active" || str(a["disbursed_at"]) != "" {
				activeLoans = append(activeLoans, map[string]any{
					"id":                a["id"],
					"ref":               a["reference"],
					"product_type":      a["product_type"],
					"outstanding_kobo":  a["outstanding_kobo"],
					"disbursed_kobo":    a["disbursed_amount_kobo"],
					"dpd":               a["dpd"],
					"status":            a["stage"],
					"next_payment_date": a["next_due_date"],
				})
			}
		}
		profile["applications"] = appList
		profile["active_loans"] = activeLoans
		profile["is_applicant"] = len(apps) > 0
		profile["is_active_customer"] = len(activeLoans) > 0

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
