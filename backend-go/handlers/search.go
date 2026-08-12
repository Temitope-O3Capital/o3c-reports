package handlers

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/o3c/reports/core"
)

// GlobalSearch powers the ⌘K palette: a few best matches from each entity type —
// customers, tickets, loan applications, CRM contacts — matched the same accurate way
// as everywhere else (tokenised, phone-normalized, wildcard-safe via searchcore) and
// ordered so the obvious hit leads each group. Customers are the identity table
// (app.customers) deduplicated to the PERSON, not loan_applications, so a card- or
// deposit-only customer is found too.
func GlobalSearch(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := strings.TrimSpace(qstr(r, "q"))
		if len(q) < 2 {
			respond(w, []any{}, "pg")
			return
		}
		ctx := r.Context()

		type Result struct {
			Type  string `json:"type"`
			ID    string `json:"id"`
			Label string `json:"label"`
			Sub   string `json:"sub"`
			URL   string `json:"url"`
		}
		var results []Result

		prefix := escapeLike(q) + "%"
		np := normalizePhone(q)

		// ── 1. Customers (identity, person-deduped, relevance-ranked) ─────────
		{
			match, args, n := buildCustomerSearch(q,
				[]string{"c.full_name", "c.first_name", "c.last_name", "c.cif", "c.email"}, "c.phone", 1)
			pExact, pPrefix, pNp := n, n+1, n+2
			args = append(args, q, prefix, np)
			rows, _ := db.PGQuery(ctx, fmt.Sprintf(`
				WITH matched AS (SELECT DISTINCT c.party_id FROM app.customers c WHERE %s)
				SELECT (array_agg(c.cif ORDER BY c.account_created ASC NULLS LAST, c.cif))[1] AS cif,
				       p.full_name AS name, COALESCE(p.primary_phone,'') AS phone, p.card_count AS card_count,
				       min(CASE
				         WHEN lower(c.cif) = lower($%d)                THEN 0
				         WHEN $%d <> '' AND %s = $%d                   THEN 0
				         WHEN c.full_name ILIKE $%d OR c.cif ILIKE $%d THEN 1
				         ELSE 2 END) AS rank
				FROM app.customers c
				JOIN app.parties p ON p.party_id = c.party_id
				JOIN matched     m ON m.party_id = c.party_id
				GROUP BY p.party_id, p.full_name, p.primary_phone, p.card_count
				ORDER BY rank, p.full_name LIMIT 6`,
				match, pExact, pNp, normalizedPhoneExpr("c.phone"), pNp, pPrefix, pPrefix), args...)
			for _, row := range rows {
				cif := str(row["cif"])
				sub := "CIF " + cif
				if ph := str(row["phone"]); ph != "" {
					sub += " · " + ph
				}
				if cc := toInt64(row["card_count"]); cc > 1 {
					sub += fmt.Sprintf(" · %d accounts", cc)
				}
				results = append(results, Result{Type: "customer", ID: cif, Label: str(row["name"]), Sub: sub, URL: "/customers/" + cif})
			}
		}

		// ── 2. Helpdesk tickets ──────────────────────────────────────────────
		{
			match, args, _ := buildCustomerSearch(q,
				[]string{"subject", "customer_name", "customer_cif", "ticket_ref", "customer_email"}, "customer_phone", 1)
			rows, _ := db.PGQuery(ctx, fmt.Sprintf(`
				SELECT id::text, ticket_ref, subject, COALESCE(status,'') AS status, COALESCE(customer_name,'') AS customer_name
				FROM helpdesk_tickets WHERE %s ORDER BY id DESC LIMIT 6`, match), args...)
			for _, row := range rows {
				results = append(results, Result{Type: "ticket", ID: str(row["id"]),
					Label: fmt.Sprintf("[%s] %s", str(row["ticket_ref"]), str(row["subject"])),
					Sub:   strings.Trim(fmt.Sprintf("%s · %s", str(row["customer_name"]), str(row["status"])), " ·"),
					URL:   "/helpdesk/" + str(row["id"])})
			}
		}

		// ── 3. Loan applications ─────────────────────────────────────────────
		{
			match, args, _ := buildCustomerSearch(q,
				[]string{"reference", "ref_no", "applicant_name", "applicant_cif", "applicant_email"}, "applicant_phone", 1)
			rows, _ := db.PGQuery(ctx, fmt.Sprintf(`
				SELECT id::text, reference, applicant_name, COALESCE(product_type,'') AS product_type, COALESCE(status,'') AS status
				FROM loan_applications WHERE %s ORDER BY id DESC LIMIT 6`, match), args...)
			for _, row := range rows {
				results = append(results, Result{Type: "application", ID: str(row["id"]),
					Label: fmt.Sprintf("%s — %s", str(row["reference"]), str(row["applicant_name"])),
					Sub:   strings.Trim(fmt.Sprintf("%s · %s", str(row["product_type"]), str(row["status"])), " ·"),
					URL:   "/sales/applications/" + str(row["id"])})
			}
		}

		// ── 4. CRM contacts (leads) ──────────────────────────────────────────
		{
			match, args, _ := buildCustomerSearch(q,
				[]string{"first_name", "last_name", "cif_number", "email"}, "phone", 1)
			rows, _ := db.PGQuery(ctx, fmt.Sprintf(`
				SELECT id::text, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name,
				       COALESCE(phone,'') AS phone, COALESCE(email,'') AS email
				FROM app.crm_contacts WHERE %s ORDER BY updated_at DESC NULLS LAST LIMIT 6`, match), args...)
			for _, row := range rows {
				sub := str(row["email"])
				if sub == "" {
					sub = str(row["phone"])
				}
				results = append(results, Result{Type: "contact", ID: str(row["id"]), Label: str(row["name"]), Sub: sub,
					URL: "/sales/customers/" + str(row["id"])})
			}
		}

		if results == nil {
			results = []Result{}
		}
		respond(w, results, "pg")
	}
}
