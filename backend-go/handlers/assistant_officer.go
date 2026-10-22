package handlers

import (
	"context"
	"regexp"
	"strings"

	"github.com/o3c/workspace/core"
)

// What an officer brought in, and not confusing them with a customer.
//
// On 2026-10-22 a user asked "how much has Kehinde Ajayi brought in Fd". The
// assistant called get_customer_transactions, which matched TWO CUSTOMERS who
// happen to share a sales officer's name (CIF 00038391 and 00038486), totalled
// their current-account activity, and reported "Kehinde Ajayi has brought in
// NGN 10,633,394.24 in fixed deposits over the past year".
//
// Every part of that was wrong. The money belonged to two members of the public,
// not to the officer. It was ordinary transaction flow, not fixed deposits -- the
// tool returns money in and out of app.transactions and the word "fixed deposits"
// came from the question, not the data. And the true answer existed the whole
// time: cbs_fixed_deposits.officer_name attributes 4 active deposits worth
// NGN 50,550,000 to him.
//
// Two separate defects produced it:
//
//  1. NOTHING COULD ASK WHAT AN OFFICER PRODUCED. officer_name sits on both
//     cbs_fixed_deposits and cbs_loans and no tool selected on it, so the only
//     tool that took a person's name was the customer one.
//
//  2. A STAFF NAME AND A CUSTOMER NAME WERE INDISTINGUISHABLE. The customer tool
//     matched a colleague's name against the public and answered confidently.
//     Reporting a member of the public's balances as an employee's performance is
//     both wrong and a disclosure, so the tool now says when a name it was handed
//     belongs to a colleague.
//
// NAMES ARE STORED IN THE OTHER ORDER. The directory holds "Kehinde Ajayi"; CBS
// holds "Ajayi Kehinde", with trailing spaces ([[o3c-officer-name-trailing-space]]).
// Matching on the string as typed finds nothing, and finding nothing reads as "he
// brought in none" -- a wrong answer that looks like a real one. So matching is
// by TOKEN CONTAINMENT: every word of the name must appear somewhere in the
// officer field, in any order, which handles both orders and any middle name
// without guessing which convention a given table follows.

var assistantNameSplit = regexp.MustCompile(`[^a-z0-9]+`)

// assistantNameTokens reduces a name to space-separated lowercase words, for the
// token-containment match. Returns "" when nothing usable is left.
func assistantNameTokens(q string) string {
	var out []string
	for _, t := range assistantNameSplit.Split(strings.ToLower(strings.TrimSpace(q)), -1) {
		// One-letter fragments are initials and match almost anything.
		if len(t) > 1 {
			out = append(out, t)
		}
	}
	return strings.Join(out, " ")
}

// assistantStaffByName finds COLLEAGUES whose name matches, in either order.
// Used to tell a staff name from a customer name before reporting money.
func assistantStaffByName(ctx context.Context, db *core.DB, name string) ([]map[string]any, error) {
	tok := assistantNameTokens(name)
	if tok == "" {
		return nil, nil
	}
	return db.PGQuery(ctx, `
		SELECT full_name, role, department
		FROM o3c_users
		WHERE deleted_at IS NULL AND role <> 'system'
		  AND NOT EXISTS (
		        SELECT 1 FROM unnest(string_to_array($1, ' ')) AS t
		        WHERE lower(full_name) NOT LIKE '%' || t || '%')
		ORDER BY is_active DESC, full_name
		LIMIT 4`, tok)
}

// assistantVisualWord matches the vocabulary of asking for a picture, on WORD
// boundaries. A plain substring test fails on "our uncharted exposure", which
// contains "chart" and asks for no such thing -- the same trap that once made
// the answer benchmark pass a figure of "0" against any answer containing a zero.
var assistantVisualWord = regexp.MustCompile(
	`\b(charts?|graphs?|plots?|visual|visuali[sz]ed?|diagrams?|pictures?|histograms?|trend ?lines?|draw)\b`)

// assistantWantsVisual reports whether the QUESTION asked for a picture.
//
// Charts used to be sent on every tool result that happened to be plottable,
// which put a graph on screen under answers nobody wanted one for. A figure is
// the answer; a chart is a thing you ask for. This keeps the guarantee that
// matters -- the chart is still built from the tool's own rows, so it can never
// disagree with the text -- and simply stops volunteering it.
//
// Deliberately strict. "Show me a breakdown" and "by month" are requests for
// detail, not for a graph, and treating them as graph requests is how the old
// behaviour justified itself.
func assistantWantsVisual(q string) bool {
	return assistantVisualWord.MatchString(strings.ToLower(q))
}

func assistantOfficerTools() []assistantTool {
	return []assistantTool{
		{
			Name: "get_officer_production",
			Description: "What business a STAFF MEMBER brought in: the fixed deposits and loans " +
				"booked under them as account officer, with amounts in naira. Use this for " +
				"'how much has Kehinde brought in', 'who is our best officer', 'how much FD " +
				"has Jennifer booked this year'. The person named must be a colleague, not a " +
				"customer -- for a customer's own money use get_customer_transactions. Leave " +
				"officer out for a league table of everybody.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"officer": map[string]any{"type": "string",
						"description": "The colleague's name, in any order, e.g. 'Kehinde Ajayi' or 'Ajayi'."},
					"days": map[string]any{"type": "integer",
						"description": "Booked within how many days back, 1 to 3650. Default 365."},
				},
			},
			Pages: []string{"sales"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				days := argInt(a, "days", 365, 1, 3650)
				who := argStr(a, "officer")
				tok := assistantNameTokens(who)

				out := map[string]any{"days": days}

				if tok == "" {
					// League table. Fixed deposits only: the loan book is a different
					// business and mixing the two into one ranking invents a total
					// nobody measures.
					rows, err := db.PGQuery(ctx, `
						SELECT btrim(officer_name) AS officer,
						       COUNT(*)                              AS deposits,
						       ROUND(SUM(principal_kobo)/100.0,2)    AS principal_ngn
						FROM cbs_fixed_deposits
						WHERE officer_name IS NOT NULL AND btrim(officer_name) <> ''
						  AND date_booked >= now() - make_interval(days => $1)
						GROUP BY 1
						ORDER BY SUM(principal_kobo) DESC NULLS LAST
						LIMIT 10`, days)
					if err != nil {
						return nil, err
					}
					out["scope"] = "every officer"
					out["fixed_deposits_by_officer"] = rows
					out["note"] = "Fixed deposits booked in the window, by the account officer CBS " +
						"records against each deposit. Officer names are stored surname first. " +
						"This is the book attributed to them, not a commission or a target."
					return out, nil
				}

				// One officer. Both books, each counted on its own terms: a deposit is
				// money placed with us and a loan is money we put out, so they are
				// never added together.
				fd, err := db.PGQuery(ctx, `
					SELECT COUNT(*)                                             AS deposits_booked,
					       ROUND(SUM(principal_kobo)/100.0,2)                   AS principal_ngn,
					       COUNT(*) FILTER (WHERE status = 'Active')            AS still_active,
					       ROUND(SUM(principal_kobo) FILTER (WHERE status = 'Active')/100.0,2) AS active_principal_ngn,
					       MAX(date_booked)::date::text                         AS last_booked
					FROM cbs_fixed_deposits f
					WHERE date_booked >= now() - make_interval(days => $1)
					  AND NOT EXISTS (
					        SELECT 1 FROM unnest(string_to_array($2, ' ')) AS t
					        WHERE btrim(lower(f.officer_name)) NOT LIKE '%' || t || '%')`, days, tok)
				if err != nil {
					return nil, err
				}
				ln, err := db.PGQuery(ctx, `
					SELECT COUNT(*)                                        AS loans_booked,
					       ROUND(SUM(loan_amount_kobo)/100.0,2)            AS amount_booked_ngn,
					       ROUND(SUM(outstanding_principal_kobo)/100.0,2)  AS outstanding_principal_ngn,
					       MAX(date_booked)::date::text                    AS last_booked
					FROM cbs_loans l
					WHERE date_booked >= now() - make_interval(days => $1)
					  AND NOT EXISTS (
					        SELECT 1 FROM unnest(string_to_array($2, ' ')) AS t
					        WHERE btrim(lower(l.officer_name)) NOT LIKE '%' || t || '%')`, days, tok)
				if err != nil {
					return nil, err
				}

				// Which officer the tokens actually landed on, so the answer can name
				// them. Finding nobody is NOT zero production -- it means the name is
				// not an account officer in CBS, and saying "they brought in nothing"
				// would be a wrong answer wearing the clothes of a right one.
				matched, err := db.PGQuery(ctx, `
					SELECT DISTINCT btrim(officer_name) AS officer
					FROM cbs_fixed_deposits f
					WHERE NOT EXISTS (
					        SELECT 1 FROM unnest(string_to_array($1, ' ')) AS t
					        WHERE btrim(lower(f.officer_name)) NOT LIKE '%' || t || '%')
					UNION
					SELECT DISTINCT btrim(officer_name)
					FROM cbs_loans l
					WHERE NOT EXISTS (
					        SELECT 1 FROM unnest(string_to_array($1, ' ')) AS t
					        WHERE btrim(lower(l.officer_name)) NOT LIKE '%' || t || '%')
					LIMIT 5`, tok)
				if err != nil {
					return nil, err
				}

				out["searched_for"] = who
				out["matched_officer_names"] = matched
				if len(fd) > 0 {
					out["fixed_deposits"] = fd[0]
				}
				if len(ln) > 0 {
					out["loans"] = ln[0]
				}
				if len(matched) == 0 {
					out["found"] = false
					out["note"] = "No account officer in core banking matches that name, so there is " +
						"nothing attributed to them. Say that the name is not recorded as an " +
						"account officer -- do NOT say they brought in nothing, which is a " +
						"different claim."
					return out, nil
				}
				out["found"] = true
				out["note"] = "Fixed deposits and loans are separate books and must never be added " +
					"together: a deposit is money placed with us, a loan is money we put out. " +
					"Closed deposits carry zero principal, so the active figure is what is " +
					"still held. Officer names are stored surname first, which is why the " +
					"matched name may read in the other order."
				return out, nil
			},
		},
	}
}

// assistantExtraTools carries the tools defined outside the main registry.
func assistantExtraTools() []assistantTool {
	return append(assistantTeamTools(), assistantOfficerTools()...)
}
