package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// c360PersonCIFs is a SQL fragment that expands the opened CIF ($1) to every CIF
// held by the same PERSON (party). A CIF is a card, and one person holds many, so
// Customer 360 must aggregate across all of them. Falls back to the single CIF
// when the row isn't linked to a party yet. Only $1 is referenced, so it can be
// dropped into any query that already binds the CIF as $1.
const c360PersonCIFs = `(SELECT c2.cif FROM app.customers c2
	    WHERE c2.party_id = (SELECT party_id FROM app.customers WHERE cif = $1 LIMIT 1)
	      AND c2.party_id IS NOT NULL
	    UNION SELECT $1)`

func RegisterCustomer360(r chi.Router, db *core.DB) {
	access := core.RequirePages("customer360")
	r.With(access).Get("/directory", c360Directory(db))
	r.With(access).Get("/directory/facets", c360DirectoryFacets(db))
	r.With(access).Get("/search", c360Search(db))
	r.With(access).Get("/{cif}", c360Profile(db))
	r.With(access).Get("/{cif}/transactions", c360Transactions(db))
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
		where := "1=1"
		var args []any
		n := 1
		if q := qstr(r, "q"); q != "" {
			where += fmt.Sprintf(` AND (c.cif ILIKE $%d OR c.first_name ILIKE $%d OR c.last_name ILIKE $%d OR c.phone ILIKE $%d OR c.email ILIKE $%d)`, n, n, n, n, n)
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
				       (array_agg(c.cif ORDER BY c.account_created ASC NULLS LAST, c.cif))[1] AS cif,
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
			       p.card_count                                     AS card_count
			FROM app.parties p
			JOIN agg  ON agg.party_id  = p.party_id
			LEFT JOIN prod ON prod.party_id = p.party_id
			ORDER BY %s
			LIMIT $%d OFFSET $%d`, where, orderBy, n, n+1), append(args, limit, offset)...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}

		total := 0
		var summary core.Row
		if tr, e := db.PGQuery(r.Context(), fmt.Sprintf(`
			WITH matched AS (
				SELECT DISTINCT c.party_id FROM app.customers c
				WHERE c.party_id IS NOT NULL AND (%s)
			),
			per AS (
				SELECT p.party_id, p.primary_email, p.primary_phone,
				       bool_or(c.account_status ILIKE 'Active') AS any_active,
				       max(c.state) AS state
				FROM app.parties p JOIN matched m ON m.party_id = p.party_id
				JOIN app.customers c ON c.party_id = p.party_id
				GROUP BY p.party_id, p.primary_email, p.primary_phone
			)
			SELECT COUNT(*)::int                                                        AS total,
			       COUNT(*) FILTER (WHERE any_active)::int                              AS active,
			       COUNT(*) FILTER (WHERE primary_email IS NOT NULL AND primary_email <> '')::int AS with_email,
			       COUNT(*) FILTER (WHERE primary_phone IS NOT NULL AND primary_phone <> '')::int AS with_phone,
			       COUNT(DISTINCT NULLIF(state,''))::int                               AS states
			FROM per`, where), args...); e == nil && len(tr) > 0 {
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
		total := 0
		if tr, e := db.PGQuery(ctx, `SELECT COUNT(*)::int AS n FROM app.parties`); e == nil && len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"states": states, "statuses": statuses, "product_lines": lines, "total": total}) //nolint:errcheck
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
			SELECT (array_agg(c.cif ORDER BY c.account_created ASC NULLS LAST, c.cif))[1] AS cif,
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
			respondErr(w, 500, "Query failed")
			return
		}
		if data == nil {
			data = []core.Row{}
		}
		respond(w, data, src)
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
			respondErr(w, 500, "Query failed")
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
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// c360Activity assembles a unified, time-sorted interaction timeline for a
// customer: calls, support tickets, and collections touches. Records are matched
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
				WHERE h.customer_cif = ANY(ids.cifs)
				   OR app.norm_phone(h.customer_phone) = ANY(ids.phones)
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
			) tl
			WHERE ts IS NOT NULL
			ORDER BY ts DESC
			LIMIT $2`, cif, limit)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
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
