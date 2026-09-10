package handlers

import (
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// Email bodies stored in helpdesk_messages.body_text often arrive as messy HTML —
// leaked <style>/CSS rules, HTML entities, the entire quoted reply chain and repeated
// legal disclaimers. Rendered raw on the timeline that's unreadable. cleanActivityDetail
// reduces a body to just the newest human-readable message.
var (
	reStyleScript = regexp.MustCompile(`(?is)<(style|script|head)[^>]*>.*?</(style|script|head)>`)
	reHTMLTag     = regexp.MustCompile(`(?s)<[^>]+>`)
	reCSSRule     = regexp.MustCompile(`(?s)[^{}<>\n]{0,300}\{[^{}]*\}`) // a leaked "selector { … }"
	reInlineWS    = regexp.MustCompile(`[ \t\f\v\x{00a0}]+`)
	reManyBlanks  = regexp.MustCompile(`\n\s*\n\s*\n+`)
)

// quotedMarkers begin the quoted history / signature / disclaimer that follows the
// actual message — everything from the earliest marker onward is trimmed.
var quotedMarkers = []string{
	"\nfrom:", "from:", "-----original message", "________________________________",
	"get outlook", "sent from my", "on wrote:", "disclaimer \"", "disclaimer “",
}

func cleanActivityDetail(s string) string {
	if s == "" {
		return s
	}
	orig := s
	s = reStyleScript.ReplaceAllString(s, " ")
	s = reHTMLTag.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	s = reCSSRule.ReplaceAllString(s, " ") // strip any CSS that leaked without <style> tags
	// Trim from the earliest quoted-history / disclaimer marker.
	low := strings.ToLower(s)
	cut := -1
	for _, m := range quotedMarkers {
		if i := strings.Index(low, m); i > 0 && (cut == -1 || i < cut) {
			cut = i
		}
	}
	if cut > 0 {
		s = s[:cut]
	}
	s = reInlineWS.ReplaceAllString(s, " ")
	s = reManyBlanks.ReplaceAllString(s, "\n\n")
	s = strings.TrimSpace(s)
	// If cleaning nuked everything (e.g. body was pure markup), fall back to a plain
	// entity-decoded, tag-stripped version so the row isn't left blank.
	if s == "" {
		s = strings.TrimSpace(reInlineWS.ReplaceAllString(html.UnescapeString(reHTMLTag.ReplaceAllString(orig, " ")), " "))
	}
	return s
}

// c360PersonCIFs is a SQL fragment that expands the opened CIF ($1) to every CIF
// held by the same PERSON (party). A CIF is a card, and one person holds many, so
// Customer 360 must aggregate across all of them. Falls back to the single CIF
// when the row isn't linked to a party yet. Only $1 is referenced, so it can be
// dropped into any query that already binds the CIF as $1.
const c360PersonCIFs = `(SELECT c2.cif FROM app.customers c2
	    WHERE c2.party_id = (SELECT party_id FROM app.customers WHERE cif = $1 LIMIT 1)
	      AND c2.party_id IS NOT NULL
	    UNION SELECT $1)`

// notTestCust excludes test/dummy/vendor records from customer-facing lists (directory,
// search). These come from the customer/card feed (custfeed/acctfeed) so they can't be durably
// deleted; filtering by name pattern keeps them out of view for good. Uses the c. alias
// and begins with " AND " so it appends to an existing WHERE.
const notTestCust = ` AND (COALESCE(c.full_name,'')||' '||COALESCE(c.first_name,'')||' '||COALESCE(c.last_name,'')) !~* '\m(test|bevertec|dummy|fastest)\M|testcard|questtest'`

// isSyntheticID reports whether an id is an internal placeholder handle generated for a
// customer that has no real card CIF: a 'cid:'-prefixed party key, or a 'W'/'Z' followed
// only by digits (e.g. W000000000000022, Z000000000034027). These carry no external
// meaning — the canonical CUST-<party_id> stands in for them — so they are never shown.
func isSyntheticID(s string) bool {
	if strings.HasPrefix(s, "cid:") {
		return true
	}
	if len(s) > 1 && (s[0] == 'W' || s[0] == 'w' || s[0] == 'Z' || s[0] == 'z') {
		for _, c := range s[1:] {
			if c < '0' || c > '9' {
				return false
			}
		}
		return true
	}
	return false
}

func RegisterCustomer360(r chi.Router, db *core.DB) {
	access := core.RequirePages("customer360")
	r.With(access).Get("/directory", c360Directory(db))
	r.With(access).Get("/directory/facets", c360DirectoryFacets(db))
	r.With(access).Get("/search", c360Search(db))
	r.With(access).Get("/{cif}", c360Profile(db))
	r.With(access).Get("/{cif}/transactions", c360Transactions(db))
	r.With(access).Get("/{cif}/transaction-analytics", c360TransactionAnalytics(db))
	r.With(access).Get("/{cif}/loans", c360Loans(db))
	r.With(access).Get("/{cif}/collections", c360Collections(db))
	r.With(access).Get("/{cif}/activity", c360Activity(db))
}

// c360Directory lists the canonical customer base from the "Accounts" table
// (the same source c360Profile reads), so directory rows deep-link into Customer
// 360 by CIF. Supports ?q= search and ?state= filter, paginated via limit/offset.
func c360Directory(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		// All predicates use the `c` alias so the same WHERE fragment drives both
		// the paginated page query (which also joins the product aggregate `a`)
		// and the summary query (customers only).
		where := "1=1" + notTestCust
		var args []any
		n := 1
		if q := qstr(r, "q"); q != "" {
			// Match on ANY of the person's ids: card CIF, workspace Customer ID
			// (contact_id, incl. a 'CUST-<party_id>' form), name, phone, email, an
			// uploaded-loan mandate, or a Udara loan/FD account number.
			where += fmt.Sprintf(` AND (c.cif ILIKE $%d OR c.contact_id ILIKE $%d
				OR c.first_name ILIKE $%d OR c.last_name ILIKE $%d OR c.phone ILIKE $%d OR c.email ILIKE $%d
				OR ('CUST-' || LPAD(c.party_id::text,6,'0')) ILIKE $%d
				OR EXISTS (SELECT 1 FROM collection_assignments ca
				     WHERE ca.account_cif = COALESCE(NULLIF(c.cif,''), c.contact_id)
				       AND ca.product_type='loan' AND ca.loan_ref ILIKE $%d)
				OR EXISTS (SELECT 1 FROM app.cbs_loans l
				     JOIN app.cbs_links k ON k.entity_type='party' AND k.cbs_customer_id = l.cbs_customer_id
				     WHERE k.entity_id = c.party_id AND l.cbs_account_number ILIKE $%d)
				OR EXISTS (SELECT 1 FROM app.cbs_fixed_deposits f
				     JOIN app.cbs_links k ON k.entity_type='party' AND k.cbs_customer_id = f.cbs_customer_id
				     WHERE k.entity_id = c.party_id AND f.cbs_account_number ILIKE $%d))`,
				n, n, n, n, n, n, n, n, n, n)
			args = append(args, "%"+q+"%")
			n++
		}
		// state / status / product_line accept a comma-separated list so the
		// multi-select filter panel can send several values at once.
		if v := qstr(r, "state"); v != "" {
			where += fmt.Sprintf(` AND c.state = ANY(string_to_array($%d, ','))`, n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "status"); v != "" {
			where += fmt.Sprintf(` AND c.account_status = ANY(string_to_array($%d, ','))`, n)
			args = append(args, v)
			n++
		}
		if qstr(r, "has_email") == "1" {
			where += ` AND c.email IS NOT NULL AND c.email <> ''`
		}
		if qstr(r, "has_phone") == "1" {
			where += ` AND c.phone IS NOT NULL AND c.phone <> ''`
		}
		if v := qstr(r, "product_line"); v != "" {
			where += fmt.Sprintf(` AND EXISTS (SELECT 1 FROM app.accounts ax WHERE ax.cif = c.cif AND ax.product_line = ANY(string_to_array($%d, ',')))`, n)
			args = append(args, v)
			n++
		}

		// Person-level directory: a CIF is a card, so one PERSON (party) can hold many
		// CIFs — the directory lists people, not cards. A person appears if ANY of their
		// cards matches the filters (the `where` clause uses the c. alias unchanged);
		// aggregates (product count/lines, status) span all of that person's cards.
		// activity = transaction-based engagement, NOT the messy account_status text
		// column: Active if any of the person's cards transacted in the last 90 days,
		// Lapsing within a year, Dormant beyond that, Never if the ledger has no
		// transaction for them. Whitelisted, so it inlines without shifting placeholders.
		activityCond := ""
		if v := qstr(r, "activity"); v != "" {
			var buckets []string
			for _, b := range strings.Split(v, ",") {
				switch strings.TrimSpace(b) {
				case "active", "lapsing", "dormant", "never":
					buckets = append(buckets, "'"+strings.TrimSpace(b)+"'")
				}
			}
			if len(buckets) > 0 {
				activityCond = " AND la.activity_status IN (" + strings.Join(buckets, ",") + ")"
			}
		}

		orderBy := "p.full_name"
		switch qstr(r, "sort") {
		case "newest":
			orderBy = "agg.created_at DESC NULLS LAST, p.full_name"
		case "oldest":
			orderBy = "agg.created_at ASC NULLS LAST, p.full_name"
		case "products":
			orderBy = "prod.product_count DESC, p.full_name"
		}

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			WITH matched AS (
				SELECT DISTINCT c.party_id FROM app.customers c
				WHERE c.party_id IS NOT NULL AND (%s)
			),
			agg AS (
				SELECT c.party_id,
				       (array_agg(COALESCE(NULLIF(c.cif,''), c.contact_id) ORDER BY c.account_created ASC NULLS LAST, c.cif))[1] AS cif,
				       min(c.account_created)                     AS created_at,
				       max(c.state)                               AS state,
				       max(c.city)                                AS city,
				       bool_or(c.account_status ILIKE 'Active')   AS any_active
				FROM app.customers c JOIN matched m ON m.party_id = c.party_id
				GROUP BY c.party_id
			),
			prod AS (
				SELECT c.party_id,
				       COUNT(ax.*)::int AS product_count,
				       COUNT(ax.*) FILTER (WHERE ax.status ILIKE 'Open' OR ax.status ILIKE 'Active')::int AS active_products,
				       array_to_string(array_agg(DISTINCT NULLIF(ax.product_line,''))
				         FILTER (WHERE ax.product_line IS NOT NULL AND ax.product_line <> ''), ',') AS product_lines
				FROM app.customers c JOIN matched m ON m.party_id = c.party_id
				LEFT JOIN app.accounts ax ON ax.cif = c.cif
				GROUP BY c.party_id
			),
			lastact AS (
				SELECT c.party_id,
				       CASE
				         WHEN MAX(t.txn_date) IS NULL                                THEN 'never'
				         WHEN MAX(t.txn_date) >= CURRENT_DATE - INTERVAL '90 days'   THEN 'active'
				         WHEN MAX(t.txn_date) >= CURRENT_DATE - INTERVAL '365 days'  THEN 'lapsing'
				         ELSE 'dormant'
				       END              AS activity_status,
				       MAX(t.txn_date)  AS last_activity
				FROM app.customers c JOIN matched m ON m.party_id = c.party_id
				LEFT JOIN app.transactions t ON t.cif = c.cif
				GROUP BY c.party_id
			)
			SELECT agg.cif                                          AS cif,
			       split_part(p.full_name,' ',1)                    AS first_name,
			       NULLIF(regexp_replace(p.full_name,'^\S+\s*',''),'') AS last_name,
			       COALESCE(p.primary_phone,'')                     AS phone,
			       COALESCE(p.primary_email,'')                     AS email,
			       agg.state                                        AS state,
			       agg.city                                         AS city,
			       CASE WHEN agg.any_active THEN 'Active' ELSE 'Inactive' END AS account_status,
			       agg.created_at                                   AS created_at,
			       COALESCE(prod.product_count,0)                   AS product_count,
			       COALESCE(prod.active_products,0)                 AS active_products,
			       COALESCE(prod.product_lines,'')                  AS product_lines,
			       p.party_type                                     AS party_type,
			       p.card_count                                     AS card_count,
			       COALESCE(la.activity_status,'never')             AS activity_status,
			       la.last_activity                                 AS last_activity
			FROM app.parties p
			JOIN agg  ON agg.party_id  = p.party_id
			LEFT JOIN prod ON prod.party_id = p.party_id
			LEFT JOIN lastact la ON la.party_id = p.party_id
			WHERE 1=1%s
			ORDER BY %s
			LIMIT $%d OFFSET $%d`, where, activityCond, orderBy, n, n+1), append(args, limit, offset)...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}

		total := 0
		var summary core.Row
		if tr, e := db.PGQuery(r.Context(), fmt.Sprintf(`
			WITH matched AS (
				SELECT DISTINCT c.party_id FROM app.customers c
				WHERE c.party_id IS NOT NULL AND (%s)
			),
			lastact AS (
				SELECT c.party_id,
				       CASE
				         WHEN MAX(t.txn_date) IS NULL                                THEN 'never'
				         WHEN MAX(t.txn_date) >= CURRENT_DATE - INTERVAL '90 days'   THEN 'active'
				         WHEN MAX(t.txn_date) >= CURRENT_DATE - INTERVAL '365 days'  THEN 'lapsing'
				         ELSE 'dormant'
				       END AS activity_status
				FROM app.customers c JOIN matched m ON m.party_id = c.party_id
				LEFT JOIN app.transactions t ON t.cif = c.cif
				GROUP BY c.party_id
			),
			per AS (
				SELECT p.party_id, p.primary_email, p.primary_phone,
				       COALESCE(la.activity_status,'never') AS activity_status,
				       max(c.state) AS state
				FROM app.parties p JOIN matched m ON m.party_id = p.party_id
				JOIN app.customers c ON c.party_id = p.party_id
				LEFT JOIN lastact la ON la.party_id = p.party_id
				GROUP BY p.party_id, p.primary_email, p.primary_phone, la.activity_status
			)
			SELECT COUNT(*)::int                                                        AS total,
			       COUNT(*) FILTER (WHERE activity_status='active')::int                AS active,
			       COUNT(*) FILTER (WHERE activity_status='lapsing')::int               AS lapsing,
			       COUNT(*) FILTER (WHERE activity_status='dormant')::int               AS dormant,
			       COUNT(*) FILTER (WHERE activity_status='never')::int                 AS never_active,
			       COUNT(*) FILTER (WHERE primary_email IS NOT NULL AND primary_email <> '')::int AS with_email,
			       COUNT(*) FILTER (WHERE primary_phone IS NOT NULL AND primary_phone <> '')::int AS with_phone,
			       COUNT(DISTINCT NULLIF(state,''))::int                               AS states
			FROM per WHERE 1=1%s`, where, activityCond), args...); e == nil && len(tr) > 0 {
			total = int(toInt64(tr[0]["total"]))
			summary = tr[0]
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows, "total": total, "summary": summary}) //nolint:errcheck
	}
}

// c360DirectoryFacets returns the distinct filter values the directory toolbar
// offers — states, customer statuses, and product lines — computed globally so
// the dropdowns stay stable regardless of the active filter set.
func c360DirectoryFacets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		states, _ := db.PGQuery(ctx, `SELECT DISTINCT state AS v FROM app.customers WHERE state IS NOT NULL AND state <> '' ORDER BY state`)
		statuses, _ := db.PGQuery(ctx, `SELECT account_status AS v, COUNT(*)::int AS n FROM app.customers WHERE account_status IS NOT NULL AND account_status <> '' GROUP BY account_status ORDER BY n DESC`)
		lines, _ := db.PGQuery(ctx, `SELECT product_line AS v, COUNT(*)::int AS n FROM app.accounts WHERE product_line IS NOT NULL AND product_line <> '' GROUP BY product_line ORDER BY n DESC`)
		// Activity buckets, transaction-based (see c360Directory). Global counts so the
		// filter chips show how many customers are Active / Lapsing / Dormant / Never.
		activity, _ := db.PGQuery(ctx, `
			WITH la AS (
				SELECT c.party_id,
				       CASE
				         WHEN MAX(t.txn_date) IS NULL                                THEN 'never'
				         WHEN MAX(t.txn_date) >= CURRENT_DATE - INTERVAL '90 days'   THEN 'active'
				         WHEN MAX(t.txn_date) >= CURRENT_DATE - INTERVAL '365 days'  THEN 'lapsing'
				         ELSE 'dormant'
				       END AS activity_status
				FROM app.customers c
				LEFT JOIN app.transactions t ON t.cif = c.cif
				WHERE c.party_id IS NOT NULL
				GROUP BY c.party_id
			)
			SELECT activity_status AS v, COUNT(*)::int AS n FROM la GROUP BY 1 ORDER BY 2 DESC`)
		total := 0
		if tr, e := db.PGQuery(ctx, `SELECT COUNT(*)::int AS n FROM app.parties`); e == nil && len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"states": states, "statuses": statuses, "product_lines": lines, "activity": activity, "total": total}) //nolint:errcheck
	}
}

func c360Search(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := strings.TrimSpace(qstr(r, "q"))
		limit := qint(r, "limit", 20, 1, 100)

		if q == "" {
			respond(w, []core.Row{}, "pg")
			return
		}

		// One PERSON per row: a CIF is a card and one human holds many, so we match at
		// card level then aggregate to the party (like the directory). Matching spans
		// full name, first/last, CIF, email and normalized phone; tokenised so word
		// order and partials work; wildcard-safe.
		match, args, n := buildCustomerSearch(q,
			[]string{"c.full_name", "c.first_name", "c.last_name", "c.cif", "c.email"},
			"c.phone", 1)
		match = "(" + match + ")" + notTestCust // keep test/dummy/vendor records out of search

		// Relevance: an exact CIF or exact phone hit sorts first, then a name/CIF prefix,
		// then everything else — so the obvious match leads the dropdown instead of an
		// arbitrary substring row.
		np := normalizePhone(q)
		pExact, pPrefix, pNp, pLimit := n, n+1, n+2, n+3
		args = append(args, q, escapeLike(q)+"%", np, limit)

		sql := fmt.Sprintf(`
			WITH matched AS (
				SELECT DISTINCT c.party_id
				FROM app.customers c
				WHERE %s
			)
			-- The route key, NOT the card CIF. c.cif is NULL for a customer who holds a
			-- loan and no card, so aggregating it alone returned cif=null and clicking
			-- the result opened Customer 360 on nothing ("Unknown Customer" — MON DIEU
			-- MONTESSORI and the other 40 loan-only borrowers). COALESCE to contact_id
			-- gives the universal customer key the profile handler already matches on.
			SELECT (array_agg(COALESCE(NULLIF(c.cif,''), c.contact_id)
			                  ORDER BY (c.cif IS NULL), c.account_created ASC NULLS LAST, c.cif))[1] AS cif,
			       p.full_name                    AS name,
			       COALESCE(p.primary_phone,'')   AS phone,
			       COALESCE(p.primary_email,'')   AS email,
			       max(c.state)                   AS state,
			       p.card_count                   AS card_count,
			       min(CASE
			         WHEN lower(c.cif) = lower($%d)                        THEN 0
			         WHEN $%d <> '' AND %s = $%d                           THEN 0
			         WHEN c.full_name ILIKE $%d OR c.cif ILIKE $%d         THEN 1
			         ELSE 2 END)                    AS rank
			FROM app.customers c
			JOIN app.parties p ON p.party_id = c.party_id
			JOIN matched     m ON m.party_id = c.party_id
			GROUP BY p.party_id, p.full_name, p.primary_phone, p.primary_email, p.card_count
			ORDER BY rank, p.full_name
			LIMIT $%d`,
			match,
			pExact,
			pNp, normalizedPhoneExpr("c.phone"), pNp,
			pPrefix, pPrefix,
			pLimit)

		data, err := db.PGQuery(r.Context(), sql, args...)
		if err != nil {
			respondErr(w, 500, "Search failed")
			return
		}
		if data == nil {
			data = []core.Row{}
		}
		respond(w, data, "pg")
	}
}

func c360Profile(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		ctx := r.Context()

		// Whole-person view: expand the opened CIF to all of the person's CIFs.
		personCIFs := c360PersonCIFs

		// Account info (identity from the opened CIF's row — same person either way)
		accounts, acctSrc, _ := db.DualQuery(ctx,
			`SELECT cif AS "CIF Number", first_name AS "First Name", last_name AS "Last Name", email AS "Email", phone AS "Phone Number",
			        birthday AS "Birthday", state AS "State", city AS "City", job_title AS "Job Title"
			 FROM app.customers WHERE cif = $1`,
			cif)

		// Products — ALL of the person's cards across their CIFs
		products, _, _ := db.DualQuery(ctx,
			`SELECT product_name AS "Product Name", status AS "Account Status", name_on_card AS "Name On Card", NULL AS "Account Manager"
			 FROM app.accounts WHERE cif IN `+personCIFs,
			cif)

		// Recent 20 transactions across all the person's CIFs
		transactions, txSrc, _ := db.DualQuery(ctx,
			`SELECT txn_date AS "Transaction Date", amount AS "Amount", description AS "Description", merchant_name AS "Merchant_Name"
			 FROM app.transactions WHERE cif IN `+personCIFs+`
			 ORDER BY txn_date DESC LIMIT 20`,
			cif)

		// Loan applications (PG only) — whole person
		loanApps, _ := db.PGQuery(ctx, `
			SELECT id, reference, product_type, amount_requested_kobo,
			       amount_approved_kobo, status, stage, created_at
			FROM loan_applications WHERE applicant_cif IN `+personCIFs+`
			ORDER BY created_at DESC`, cif)

		// Recovery cases (PG only) — whole person
		recoveryCases, _ := db.PGQuery(ctx, `
			SELECT id, case_ref, status, total_outstanding_kobo, total_recovered_kobo, created_at
			FROM recovery_cases WHERE cif_number IN `+personCIFs+`
			ORDER BY created_at DESC`, cif)

		// Credit-card position (PG — from the latest imported billing cycle for this CIF).
		// Per-card rows plus a rolled-up summary. Only credit-category products.
		cardCards, _ := db.PGQuery(ctx, `
			SELECT d.account_number, COALESCE(NULLIF(p.product_name,''), d.product_code) AS product,
			       d.outstanding_balance_kobo, d.credit_limit_kobo, d.overdue_amount_kobo,
			       d.minimum_payment_kobo, d.total_interest_kobo,
			       TO_CHAR(d.cycle_date,'YYYY-MM-DD') AS cycle_date,
			       CASE WHEN d.credit_limit_kobo > 0
			            THEN ROUND(d.outstanding_balance_kobo::numeric / d.credit_limit_kobo * 100, 1)
			            ELSE 0 END AS utilization_pct
			FROM card_cycle_data d
			JOIN card_products p ON p.product_code = d.product_code AND p.category = 'credit'
			WHERE d.cif IN `+personCIFs+`
			  AND d.cycle_date = (SELECT MAX(cycle_date) FROM card_cycle_data WHERE cif = d.cif)
			ORDER BY d.outstanding_balance_kobo DESC`, cif)

		cardSummaryRows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS cards,
			       COALESCE(SUM(d.outstanding_balance_kobo),0)::bigint AS outstanding_kobo,
			       COALESCE(SUM(d.credit_limit_kobo),0)::bigint        AS credit_limit_kobo,
			       COALESCE(SUM(d.overdue_amount_kobo),0)::bigint      AS overdue_kobo,
			       COALESCE(SUM(d.minimum_payment_kobo),0)::bigint     AS min_payment_kobo,
			       COALESCE(SUM(d.total_interest_kobo),0)::bigint      AS interest_kobo,
			       TO_CHAR(MAX(d.cycle_date),'YYYY-MM-DD')             AS cycle_date
			FROM card_cycle_data d
			JOIN card_products p ON p.product_code = d.product_code AND p.category = 'credit'
			WHERE d.cif IN `+personCIFs+`
			  AND d.cycle_date = (SELECT MAX(cycle_date) FROM card_cycle_data WHERE cif = d.cif)`, cif)

		// Financial summary (PG only — best-effort, nullable)
		summaryRows, _ := db.PGQuery(ctx, `
			SELECT
				(SELECT dpd_bucket FROM collection_assignments WHERE cif_number IN `+personCIFs+` ORDER BY updated_at DESC LIMIT 1) AS dpd_bucket,
				(SELECT COALESCE(SUM(total_outstanding_kobo), 0) FROM recovery_cases WHERE cif_number IN `+personCIFs+` AND status = 'active') AS recovery_outstanding_kobo,
				(SELECT amount_approved_kobo FROM loan_applications WHERE applicant_cif IN `+personCIFs+` AND stage NOT IN ('rejected','cancelled') ORDER BY created_at DESC LIMIT 1) AS loan_approved_kobo
		`, cif)

		if accounts == nil {
			accounts = []core.Row{}
		}
		if products == nil {
			products = []core.Row{}
		}
		if transactions == nil {
			transactions = []core.Row{}
		}
		if loanApps == nil {
			loanApps = []core.Row{}
		}
		if recoveryCases == nil {
			recoveryCases = []core.Row{}
		}
		if cardCards == nil {
			cardCards = []core.Row{}
		}

		profile := map[string]any{
			"account":           firstOrNil(accounts),
			"products":          products,
			"transactions":      transactions,
			"loan_apps":         loanApps,
			"recovery_cases":    recoveryCases,
			"card_position":     firstOrNil(cardSummaryRows), // rolled-up revolving summary (nil if none)
			"card_accounts":     cardCards,                   // per-card latest-cycle rows
			"financial_summary": firstOrNil(summaryRows),
		}

		// Prefer mssql_live if any source is live
		src := acctSrc
		if txSrc == "mssql_live" {
			src = "mssql_live"
		}

		respond(w, profile, src)
	}
}

func c360Transactions(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		limit := qint(r, "limit", 50, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

		data, src, err := db.DualQuery(r.Context(),
			`SELECT txn_date AS "Transaction Date", amount AS "Amount", description AS "Description", merchant_name AS "Merchant_Name"
			 FROM app.transactions WHERE cif IN `+c360PersonCIFs+`
			 ORDER BY txn_date DESC
			 LIMIT $2 OFFSET $3`,
			cif, offset, limit)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if data == nil {
			data = []core.Row{}
		}
		respond(w, data, src)
	}
}

// c360TransactionAnalytics turns the raw card/account ledger into a behaviour picture for
// one PERSON (all their CIFs): where they spend (merchants), what on (MCC category), how
// they transact (channel), where (city), and cashflow over the last 12 months.
//
// Sign convention (verified against the feed): amount is naira; an OUTFLOW carries a
// positive amount with money_in=false, an INFLOW a negative amount with money_in=true. So
// spend = SUM(amount) over money_in=false, and inflow = -SUM(amount) over money_in=true.
// The merchant/category/city cuts are spend-only — you analyse where money GOES.
func c360TransactionAnalytics(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		out := map[string]any{}

		// Totals + activity span.
		if rows, err := db.PGQuery(r.Context(), `
			SELECT COUNT(*)                                                       AS txns,
			       COALESCE(SUM(ABS(amount)) FILTER (WHERE money_in = false), 0)       AS outflow,
			       COALESCE(SUM(ABS(amount)) FILTER (WHERE money_in = true), 0)       AS inflow,
			       COUNT(*) FILTER (WHERE money_in = false)                       AS out_txns,
			       COUNT(*) FILTER (WHERE money_in = true)                        AS in_txns,
			       MIN(txn_date)                                                  AS first_txn,
			       MAX(txn_date)                                                  AS last_txn
			  FROM app.transactions WHERE cif IN `+c360PersonCIFs, cif); err == nil && len(rows) > 0 {
			out["totals"] = rows[0]
		}

		// Top merchants by spend (outflow only; a real merchant name, not a bank/ATM label).
		if rows, err := db.PGQuery(r.Context(), `
			SELECT TRIM(merchant_name) AS merchant, COUNT(*) AS txns,
			       COALESCE(SUM(ABS(amount)) FILTER (WHERE money_in = false), 0) AS spend
			  FROM app.transactions
			 WHERE cif IN `+c360PersonCIFs+`
			   AND NULLIF(TRIM(merchant_name),'') IS NOT NULL
			 GROUP BY TRIM(merchant_name)
			 ORDER BY spend DESC NULLS LAST
			 LIMIT 8`, cif); err == nil {
			out["top_merchants"] = rows
		}

		// Spending by category (MCC) — the frontend maps the code to a friendly name.
		if rows, err := db.PGQuery(r.Context(), `
			SELECT TRIM(mcc) AS mcc, COUNT(*) AS txns,
			       COALESCE(SUM(ABS(amount)) FILTER (WHERE money_in = false), 0) AS spend
			  FROM app.transactions
			 WHERE cif IN `+c360PersonCIFs+`
			   AND NULLIF(TRIM(mcc),'') IS NOT NULL
			 GROUP BY TRIM(mcc)
			 ORDER BY spend DESC NULLS LAST
			 LIMIT 8`, cif); err == nil {
			out["by_category"] = rows
		}

		// How they transact.
		if rows, err := db.PGQuery(r.Context(), `
			SELECT COALESCE(NULLIF(TRIM(channel),''),'other') AS channel, COUNT(*) AS txns,
			       COALESCE(SUM(ABS(amount)) FILTER (WHERE money_in = false), 0) AS spend
			  FROM app.transactions WHERE cif IN `+c360PersonCIFs+`
			 GROUP BY 1 ORDER BY txns DESC`, cif); err == nil {
			out["by_channel"] = rows
		}

		// Where they transact.
		if rows, err := db.PGQuery(r.Context(), `
			SELECT INITCAP(TRIM(city)) AS city, COUNT(*) AS txns,
			       COALESCE(SUM(ABS(amount)) FILTER (WHERE money_in = false), 0) AS spend
			  FROM app.transactions
			 WHERE cif IN `+c360PersonCIFs+`
			   AND NULLIF(TRIM(city),'') IS NOT NULL
			 GROUP BY INITCAP(TRIM(city))
			 ORDER BY txns DESC
			 LIMIT 6`, cif); err == nil {
			out["by_city"] = rows
		}

		// Cashflow, last 12 months.
		if rows, err := db.PGQuery(r.Context(), `
			SELECT to_char(date_trunc('month', txn_date), 'YYYY-MM')            AS month,
			       COALESCE(SUM(ABS(amount)) FILTER (WHERE money_in = false), 0)     AS outflow,
			       COALESCE(SUM(ABS(amount)) FILTER (WHERE money_in = true), 0)     AS inflow
			  FROM app.transactions
			 WHERE cif IN `+c360PersonCIFs+`
			   AND txn_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '11 months'
			 GROUP BY 1 ORDER BY 1`, cif); err == nil {
			out["monthly"] = rows
		}

		respond(w, out, "pg")
	}
}

func c360Loans(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, reference, product_type, amount_requested_kobo, amount_approved_kobo,
			       tenor_months, interest_rate_bps, status, stage, submitted_at, created_at
			FROM loan_applications WHERE applicant_cif IN `+c360PersonCIFs+`
			ORDER BY created_at DESC`, cif)
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

func c360Collections(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		rows, err := db.PGQuery(r.Context(), `
			SELECT cc.id, cc.contact_type, cc.outcome, cc.notes,
			       cc.next_action_date, cc.created_at,
			       u.full_name AS agent_name
			FROM collection_contacts cc
			LEFT JOIN o3c_users u ON cc.agent_user_id = u.id
			WHERE cc.cif_number IN `+c360PersonCIFs+`
			ORDER BY cc.created_at DESC
			LIMIT $2 OFFSET $3`, cif, limit, offset)
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

// c360Activity assembles a unified, time-sorted interaction timeline for a
// customer: calls, support tickets, collections touches, and the collections/
// recovery credit-activity audit trail. Records are matched
// by CIF and — so interactions logged with only a phone/email still surface — by
// the customer's normalised phone and email. The phone set spans both the customer
// master (app.customers) and any matching CRM lead (app.crm_contacts), so a call
// centre row keyed only by customer_phone still lands on the right person. This is
// what makes the profile "live".
func c360Activity(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		limit := qint(r, "limit", 100, 1, 500)
		ctx := r.Context()

		// Person-level: a CIF is a card, and one person holds many CIFs. Resolve the
		// party (app.customers.party_id) and gather activity across ALL of that
		// person's CIFs, phones and emails — so the timeline is the whole person, not
		// one card. Falls back to the single CIF when there's no party link.
		rows, err := db.PGQuery(ctx, `
			WITH me AS (SELECT party_id FROM app.customers WHERE cif = $1 LIMIT 1),
			cust AS (
			  -- The whole person: every CIF/card the party holds (or just this CIF
			  -- when it isn't linked to a party yet).
			  SELECT c.cif, c.phone, c.email
			  FROM app.customers c
			  WHERE ((SELECT party_id FROM me) IS NOT NULL AND c.party_id = (SELECT party_id FROM me))
			     OR ((SELECT party_id FROM me) IS NULL AND c.cif = $1)
			),
			ids AS (
			  SELECT
			    (SELECT array_agg(DISTINCT cif) FILTER (WHERE cif IS NOT NULL AND cif <> '') FROM cust) AS cifs,
			    -- Union of last-10 phone keys across the customer master AND any CRM
			    -- lead whose cif_number/converted_cif is one of the person's CIFs, so a
			    -- helpdesk_calls row keyed only by customer_phone still matches.
			    (SELECT array_agg(DISTINCT p) FROM (
			       SELECT app.norm_phone(phone) AS p FROM cust
			       UNION
			       SELECT app.norm_phone(cc.phone) FROM app.crm_contacts cc
			       WHERE cc.cif_number    IN (SELECT cif FROM cust WHERE cif <> '')
			          OR cc.converted_cif IN (SELECT cif FROM cust WHERE cif <> '')
			     ) ph WHERE p <> '') AS phones,
			    (SELECT array_agg(DISTINCT lower(email)) FILTER (WHERE email IS NOT NULL AND email <> '') FROM cust) AS emails
			)
			SELECT * FROM (
				SELECT 'call'::text AS kind, h.started_at AS ts,
				       h.direction, h.purpose,
				       COALESCE(h.outcome,'') AS outcome, NULL::text AS status,
				       h.agent_name, COALESCE(h.notes,'') AS detail,
				       'Call'::text AS title, h.duration_sec, h.id::text AS ref
				FROM app.helpdesk_calls h, ids
				WHERE (h.customer_cif = ANY(ids.cifs)
				   OR app.norm_phone(h.customer_phone) = ANY(ids.phones))
				  AND h.merged_into_call_id IS NULL AND h.voided_at IS NULL
				UNION ALL
				SELECT 'ticket', t.created_at,
				       t.channel, t.ticket_type,
				       NULL, t.status,
				       NULL, COALESCE(t.subject,''),
				       COALESCE(NULLIF(t.subject,''),'Ticket'), NULL::int, t.id::text
				FROM app.helpdesk_tickets t, ids
				WHERE t.customer_cif = ANY(ids.cifs)
				   OR app.norm_phone(t.customer_phone) = ANY(ids.phones)
				   OR lower(t.customer_email) = ANY(ids.emails)
				UNION ALL
				SELECT 'collection', cc.created_at,
				       NULL, 'collections',
				       COALESCE(cc.outcome,''), NULL,
				       u.full_name, COALESCE(cc.notes,''),
				       COALESCE(NULLIF(cc.contact_type,''),'Collections contact'), NULL::int, cc.id::text
				FROM app.collection_contacts cc
				LEFT JOIN app.o3c_users u ON u.id = cc.agent_user_id, ids
				WHERE cc.cif_number = ANY(ids.cifs)
				UNION ALL
				-- Credit activity: the collections/recovery audit trail (promises, payments,
				-- write-offs, escalations, watchlist). This is the credit_activity_log feed
				-- that used to live on the standalone Collections Activity Log page.
				SELECT 'credit', cal.ts,
				       NULL, cal.module,
				       COALESCE(cal.action,''), NULL,
				       cal.actor_name, COALESCE(cal.description,''),
				       COALESCE(NULLIF(cal.action,''),'Credit activity'), NULL::int, cal.id::text
				FROM credit_activity_log cal, ids
				WHERE cal.account_cif = ANY(ids.cifs)
				  AND cal.module IN ('collections','recovery','risk')
				UNION ALL
				-- Ticket messages: emails / SMS / WhatsApp / notes exchanged on the
				-- customer's tickets (inbound customer mail is routed here too). Staff
				-- internal notes are excluded.
				SELECT 'message', m.created_at,
				       m.direction, m.channel,
				       NULL, m.status,
				       COALESCE(m.author_name, m.sender_name), COALESCE(m.body_text,''),
				       COALESCE(NULLIF(t.subject,''), initcap(m.channel)||' message'),
				       NULL::int, m.id::text
				FROM app.helpdesk_messages m
				JOIN app.helpdesk_tickets t ON t.id = m.ticket_id, ids
				WHERE m.is_internal_note = false
				  AND (t.customer_cif = ANY(ids.cifs)
				    OR app.norm_phone(t.customer_phone) = ANY(ids.phones)
				    OR lower(t.customer_email) = ANY(ids.emails))
				UNION ALL
				-- Statement emails (outbound, CIF/email keyed)
				SELECT 'statement_email', se.created_at,
				       'outbound', 'statement',
				       NULL, se.status,
				       NULL, COALESCE(se.subject,''),
				       COALESCE(NULLIF(se.subject,''),'Statement email'), NULL::int, se.id::text
				FROM app.customer_statement_emails se, ids
				WHERE se.cif_number = ANY(ids.cifs)
				   OR lower(se.recipient_email) = ANY(ids.emails)
				UNION ALL
				-- Campaign email sends
				SELECT 'campaign_email', ce.email_sent_at,
				       'outbound', 'campaign',
				       NULL, ce.email_status,
				       NULL, '',
				       'Campaign email', NULL::int, ce.id::text
				FROM app.campaign_contacts ce, ids
				WHERE ce.email_sent_at IS NOT NULL
				  AND (ce.cif_number = ANY(ids.cifs) OR lower(ce.email) = ANY(ids.emails))
				UNION ALL
				-- Campaign SMS sends
				SELECT 'campaign_sms', cs.sms_sent_at,
				       'outbound', 'campaign',
				       NULL, cs.sms_status,
				       NULL, '',
				       'Campaign SMS', NULL::int, cs.id::text
				FROM app.campaign_contacts cs, ids
				WHERE cs.sms_sent_at IS NOT NULL
				  AND (cs.cif_number = ANY(ids.cifs) OR app.norm_phone(cs.phone) = ANY(ids.phones))
				UNION ALL
				-- Recovery field visits
				SELECT 'field_visit', COALESCE(v.created_at, v.visit_date::timestamptz),
				       'field', 'recovery',
				       COALESCE(v.outcome,''), NULL,
				       vu.full_name,
				       COALESCE(v.notes,'') || COALESCE(' @ '||NULLIF(v.address,''),''),
				       'Field visit', NULL::int, v.id::text
				FROM app.recovery_field_visits v
				JOIN app.recovery_cases rvc ON rvc.id = v.case_id
				LEFT JOIN app.o3c_users vu ON vu.id = v.officer_id, ids
				WHERE rvc.cif_number = ANY(ids.cifs)
				UNION ALL
				-- Collections payments (CIF-keyed ledger)
				SELECT 'payment', cpm.created_at,
				       'inbound', 'collections_payment',
				       NULL, CASE WHEN cpm.reconciled THEN 'reconciled' ELSE 'unreconciled' END,
				       cpu.full_name,
				       '₦'||to_char(cpm.amount_kobo/100.0,'FM999,999,990.00')||COALESCE(' · '||NULLIF(cpm.channel,''),'')||COALESCE(' · ref '||cpm.reference,''),
				       'Collections payment', NULL::int, cpm.id::text
				FROM app.collection_payments cpm
				LEFT JOIN app.o3c_users cpu ON cpu.id = cpm.received_by, ids
				WHERE cpm.account_cif = ANY(ids.cifs)
				UNION ALL
				-- Recovery payments (via case)
				SELECT 'payment', rp.created_at,
				       'inbound', 'recovery_payment',
				       NULL, NULL,
				       rpu.full_name,
				       '₦'||to_char(rp.amount_kobo/100.0,'FM999,999,990.00')||COALESCE(' · '||NULLIF(rp.channel,''),'')||COALESCE(' · ref '||rp.reference,''),
				       'Recovery payment', NULL::int, rp.id::text
				FROM app.recovery_payments rp
				JOIN app.recovery_cases rpc ON rpc.id = rp.case_id
				LEFT JOIN app.o3c_users rpu ON rpu.id = rp.posted_by, ids
				WHERE rpc.cif_number = ANY(ids.cifs)
				UNION ALL
				-- Loan repayments (via loan application)
				SELECT 'payment', lr.created_at,
				       'inbound', 'loan_repayment',
				       NULL, NULL,
				       lru.full_name,
				       '₦'||to_char(lr.amount_kobo/100.0,'FM999,999,990.00')||COALESCE(' · '||NULLIF(lr.channel,''),''),
				       'Loan repayment', NULL::int, lr.id::text
				FROM app.loan_repayments lr
				JOIN loan_applications la ON la.id = lr.loan_id
				LEFT JOIN app.o3c_users lru ON lru.id = lr.recorded_by, ids
				WHERE la.applicant_cif = ANY(ids.cifs)
				UNION ALL
				-- Survey responses (customer feedback), CIF/email keyed. Surfaces
				-- every completed feedback survey on the customer's timeline.
				SELECT 'survey', sr.submitted_at,
				       'inbound', 'feedback',
				       COALESCE(to_char(sr.overall_score,'FM990.0')||'/10',''), NULL,
				       NULL,
				       COALESCE(sv.title,'Survey response')||COALESCE(' · recommend '||sr.nps_score::text||'/10',''),
				       'Survey response', NULL::int, sr.id::text
				FROM survey_responses sr
				JOIN surveys sv ON sv.id = sr.survey_id, ids
				WHERE sr.customer_cif = ANY(ids.cifs)
				   OR lower(sr.customer_email) = ANY(ids.emails)
				UNION ALL
				-- Activity stream (app.activities): the non-call touches that had no home
				-- before — notes, documents, hand-offs (with who they went to + status) and
				-- risk/credit decisions. Calls/payments/etc. are NOT here (they come from
				-- their own branches above), so nothing is doubled. Matched by the person's
				-- CIFs/phones, plus their CRM contacts and loan applications.
				SELECT 'activity', a.occurred_at,
				       a.direction, a.type,
				       COALESCE(a.outcome,''), a.status,
				       a.actor_name, COALESCE(a.body,''),
				       COALESCE(NULLIF(a.subject,''), initcap(replace(a.type,'_',' ')))
				         || COALESCE(' → ' || a.target_team, ''),
				       NULL::int, a.id::text
				FROM app.activities a, ids
				WHERE a.type <> 'call'
				  AND (
				    a.cif = ANY(ids.cifs)
				    OR a.phone = ANY(ids.phones)
				    OR a.contact_id IN (
				         SELECT cc.id FROM app.crm_contacts cc
				          WHERE cc.cif_number = ANY(ids.cifs)
				             OR cc.converted_cif = ANY(ids.cifs)
				             OR app.norm_phone(cc.phone) = ANY(ids.phones))
				    OR a.application_id IN (
				         SELECT la.id FROM app.loan_applications la WHERE la.applicant_cif = ANY(ids.cifs))
				  )
			) tl
			WHERE ts IS NOT NULL
			ORDER BY ts DESC
			LIMIT $2`, cif, limit)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		// Tidy the free-text body of each row (emails/notes) so the timeline reads
		// cleanly instead of dumping raw HTML/CSS and the whole quoted thread.
		for _, row := range rows {
			if d, ok := row["detail"].(string); ok && d != "" {
				row["detail"] = cleanActivityDetail(d)
			}
		}
		respond(w, rows, "pg")
	}
}

// firstOrNil returns the first row or nil if empty.
func firstOrNil(rows []core.Row) any {
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}
