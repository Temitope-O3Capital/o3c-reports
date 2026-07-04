package handlers

import (
	"fmt"
	"net/http"

	"github.com/o3c/reports/core"
)

// GlobalSearch returns up to 5 results from each module for a given query.
func GlobalSearch(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := qstr(r, "q")
		if len(q) < 2 {
			respond(w, []any{}, "pg")
			return
		}
		like := "%" + q + "%"
		ctx := r.Context()

		type Result struct {
			Type    string `json:"type"`
			ID      string `json:"id"`
			Label   string `json:"label"`
			Sub     string `json:"sub"`
			URL     string `json:"url"`
		}

		var results []Result

		// ── 1. CRM Contacts ──────────────────────────────────────────────────
		contactRows, _ := db.PGQuery(ctx,
			`SELECT id::text, full_name, COALESCE(phone,'') AS phone, COALESCE(company,'') AS company
			 FROM crm_contacts
			 WHERE full_name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1
			 LIMIT 5`,
			like)
		for _, row := range contactRows {
			id := str(row["id"])
			name := str(row["full_name"])
			sub := str(row["company"])
			if sub == "" {
				sub = str(row["phone"])
			}
			results = append(results, Result{
				Type:  "contact",
				ID:    id,
				Label: name,
				Sub:   sub,
				URL:   fmt.Sprintf("/sales/customers/%s", id),
			})
		}

		// ── 2. LOS Applications ──────────────────────────────────────────────
		losRows, _ := db.PGQuery(ctx,
			`SELECT id::text, reference, applicant_name, COALESCE(product_type,'') AS product_type, status
			 FROM loan_applications
			 WHERE reference ILIKE $1 OR applicant_name ILIKE $1 OR applicant_cif ILIKE $1
			 LIMIT 5`,
			like)
		for _, row := range losRows {
			results = append(results, Result{
				Type:  "application",
				ID:    str(row["id"]),
				Label: fmt.Sprintf("%s — %s", str(row["reference"]), str(row["applicant_name"])),
				Sub:   fmt.Sprintf("%s · %s", str(row["product_type"]), str(row["status"])),
				URL:   fmt.Sprintf("/los/applications/%s", str(row["id"])),
			})
		}

		// ── 3. Helpdesk Tickets ──────────────────────────────────────────────
		ticketRows, _ := db.PGQuery(ctx,
			`SELECT id::text, reference, subject, COALESCE(status,'') AS status, COALESCE(customer_name,'') AS customer_name
			 FROM helpdesk_tickets
			 WHERE reference ILIKE $1 OR subject ILIKE $1 OR customer_name ILIKE $1 OR customer_phone ILIKE $1
			 LIMIT 5`,
			like)
		for _, row := range ticketRows {
			results = append(results, Result{
				Type:  "ticket",
				ID:    str(row["id"]),
				Label: fmt.Sprintf("[%s] %s", str(row["reference"]), str(row["subject"])),
				Sub:   fmt.Sprintf("%s · %s", str(row["customer_name"]), str(row["status"])),
				URL:   fmt.Sprintf("/helpdesk/tickets/%s", str(row["id"])),
			})
		}

		// ── 4. Accounts / Customers (PG fallback for CIF lookup) ─────────────
		acctRows, _ := db.PGQuery(ctx,
			`SELECT DISTINCT applicant_cif AS cif, applicant_name AS name,
			        COALESCE(applicant_phone,'') AS phone
			 FROM loan_applications
			 WHERE applicant_cif ILIKE $1 OR applicant_name ILIKE $1 OR applicant_phone ILIKE $1
			 LIMIT 5`,
			like)
		seenCIF := map[string]bool{}
		for _, row := range acctRows {
			cif := str(row["cif"])
			if cif == "" || seenCIF[cif] {
				continue
			}
			seenCIF[cif] = true
			results = append(results, Result{
				Type:  "customer",
				ID:    cif,
				Label: str(row["name"]),
				Sub:   fmt.Sprintf("CIF %s · %s", cif, str(row["phone"])),
				URL:   fmt.Sprintf("/customer360/%s", cif),
			})
		}

		if results == nil {
			results = []Result{}
		}
		respond(w, results, "pg")
	}
}
