package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// The Account Officer's book.
//
// Sales officers are also account officers: they acquire a customer and then own that
// customer for life. Ownership used to live in the retired card system's
// Account_Manager_txt, which the going-forward feed does not carry and which was never
// backfilled — so it is now workspace-owned, in customer_officers, keyed on CIF.
//
// The book reads from app.customer_acquisition (the customer master plus a derived
// acquisition date), NOT from crm_contacts. crm_contacts is a one-off Zoho helpdesk
// export in which only 1,794 of 29,663 rows are flagged 'customer'; building the book
// on it made 91% of real customers invisible to their own officer.

// salesHeadRoles may see and reassign the whole book. Anyone else sees only their own.
// admin bypasses page gating entirely in RequirePages, but is listed here too because
// this is a data-scope decision, not a route-access one.
var salesHeadRoles = map[string]bool{
	"admin":      true,
	"sales_head": true,
	"head_sales": true,
	"head_ops":   true,
	"cfo":        true,
}

// Per-customer product aggregates, shared by the book list and its summary so the two
// can never disagree about what a customer holds.
//
// Join keys differ per source and are easy to get wrong: the card book keys on `cif`,
// while the Udara tables key on `cbs_customer_id` (which carries the CIF), and helpdesk
// keys on `customer_cif`.
//
// The card book is the one with data today — 20,479 accounts, with real limits,
// balances and days_overdue. cbs_loans and cbs_fixed_deposits are currently EMPTY: the
// Udara sync runs every minute and succeeds, but returns 0 loans and 0 FDs. These joins
// are written against the real schema so the book fills itself in the moment that sync
// starts returning the books, rather than needing a rewrite then.
const (
	cardAggSQL = `
	    SELECT cif,
	           COUNT(*) FILTER (WHERE status IN ('Open','Active'))                         AS active_cards,
	           COALESCE(SUM(current_dr_balance) FILTER (WHERE status IN ('Open','Active')), 0)
	                                                                                       AS card_balance_kobo,
	           COALESCE(MAX(days_overdue), 0)                                              AS max_dpd
	      FROM app.accounts
	     WHERE cif IS NOT NULL AND cif <> ''
	     GROUP BY cif`

	loanAggSQL = `
	    SELECT cbs_customer_id AS cif,
	           COUNT(*) FILTER (WHERE status ILIKE 'active')                               AS active_loans,
	           COALESCE(SUM(outstanding_principal_kobo + COALESCE(outstanding_interest_kobo,0)
	                        + COALESCE(outstanding_fee_kobo,0))
	                    FILTER (WHERE status ILIKE 'active'), 0)                           AS outstanding_kobo
	      FROM cbs_loans
	     WHERE cbs_customer_id IS NOT NULL AND cbs_customer_id <> ''
	     GROUP BY cbs_customer_id`

	fdAggSQL = `
	    SELECT cbs_customer_id AS cif,
	           COUNT(*) FILTER (WHERE status ILIKE 'active')                               AS active_fds,
	           COALESCE(SUM(principal_kobo) FILTER (WHERE status ILIKE 'active'), 0)       AS fd_principal_kobo,
	           MIN(maturity_date) FILTER (WHERE status ILIKE 'active')                     AS next_maturity
	      FROM cbs_fixed_deposits
	     WHERE cbs_customer_id IS NOT NULL AND cbs_customer_id <> ''
	     GROUP BY cbs_customer_id`
)

// requireSalesHead gates writes that a supervisor owns and a subordinate must not
// perform on themselves — setting targets, above all. Hiding the button in the UI
// is not sufficient: the endpoint is reachable directly, and the person with the
// clearest motive to move their own target is the one being measured by it.
func requireSalesHead(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isSalesHead(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Only a sales head or administrator can change targets")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isSalesHead(u *core.Claims) bool {
	if u == nil {
		return false
	}
	for _, r := range u.AllRoles() {
		if salesHeadRoles[r] {
			return true
		}
	}
	return false
}

func RegisterSalesBook(r chi.Router, db *core.DB) {
	access := core.RequirePages("sales", "crm_contacts")

	r.With(access).Get("/book", listBook(db))
	r.With(access).Get("/book/summary", bookSummary(db))
	r.With(access).Get("/book/{cif}", bookCustomer(db))
	r.With(access).Get("/officers", listSalesOfficers(db))
	r.With(access).Get("/book/{cif}/officer-history", officerHistory(db))

	// Reassignment is a head-only action: an officer must not be able to move a
	// customer onto or off their own book unilaterally.
	headOnly := core.RequirePages("sales")
	r.With(headOnly).Post("/book/assign", assignOfficer(db))
	r.With(headOnly).Post("/book/bulk-assign", bulkAssignOfficers(db))
}

// listBook returns the customers an officer owns, or the whole book for a head.
//
// Paginated, unlike the page it replaces: the old query joined four tables and ran two
// correlated subqueries per row with no LIMIT, which was survivable against 1,794 rows
// and is not against 21,000.
func listBook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}

		where := []string{"1=1"}
		args := []any{}
		n := 1

		// Scope. A head may look at one officer's book via ?officer_id=; an officer is
		// pinned to their own regardless of what they pass.
		if isSalesHead(user) {
			switch q := qstr(r, "officer_id"); q {
			case "":
				// whole book
			case "unassigned":
				where = append(where, "a.officer_id IS NULL")
			default:
				id, err := parseUserID(q)
				if err != nil {
					respondErr(w, 400, err.Error())
					return
				}
				where = append(where, fmt.Sprintf("a.officer_id = $%d", n))
				args = append(args, id)
				n++
			}
		} else {
			where = append(where, fmt.Sprintf("a.officer_id = $%d", n))
			args = append(args, user.ID)
			n++
		}

		if q := qstr(r, "q"); q != "" {
			if clause, sargs, nn := buildCustomerSearch(q,
				[]string{"a.full_name", "a.cif", "a.email", "a.phone"}, "a.phone", n); clause != "" {
				where = append(where, clause)
				args = append(args, sargs...)
				n = nn
			}
		}
		if s := qstr(r, "state"); s != "" {
			where = append(where, fmt.Sprintf("a.state = $%d", n))
			args = append(args, s)
			n++
		}
		if st := qstr(r, "status"); st != "" {
			where = append(where, fmt.Sprintf("a.account_status = $%d", n))
			args = append(args, st)
			n++
		}

		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1_000_000)
		cond := strings.Join(where, " AND ")

		var total int64
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT COUNT(*) FROM app.customer_acquisition a WHERE `+cond, args...).Scan(&total); err != nil {
			respondErr(w, 500, "Count failed")
			return
		}

		rows, err := db.PGQuery(r.Context(), `
			SELECT a.cif, a.full_name, a.email, a.phone, a.state, a.city,
			       a.account_status, a.acquired_on, a.acquired_on_source,
			       a.account_count, a.officer_id, a.officer_assigned_at,
			       u.full_name AS officer_name,
			       COALESCE(k.active_cards, 0)      AS active_cards,
			       COALESCE(k.card_balance_kobo, 0) AS card_balance_kobo,
			       COALESCE(k.max_dpd, 0)           AS max_dpd,
			       COALESCE(l.active_loans, 0)      AS active_loans,
			       COALESCE(l.outstanding_kobo, 0)  AS outstanding_kobo,
			       COALESCE(f.active_fds, 0)        AS active_fds,
			       COALESCE(f.fd_principal_kobo, 0) AS fd_principal_kobo,
			       f.next_maturity
			  FROM app.customer_acquisition a
			  LEFT JOIN o3c_users u ON u.id = a.officer_id
			  LEFT JOIN (`+cardAggSQL+`) k ON k.cif = a.cif
			  LEFT JOIN (`+loanAggSQL+`) l ON l.cif = a.cif
			  LEFT JOIN (`+fdAggSQL+`) f ON f.cif = a.cif
			 WHERE `+cond+`
			 ORDER BY a.acquired_on DESC NULLS LAST, a.cif
			 LIMIT `+fmt.Sprintf("$%d OFFSET $%d", n, n+1),
			append(args, limit, offset)...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data": rows, "total": total, "limit": limit, "offset": offset,
			"scope": map[string]any{"is_head": isSalesHead(user), "user_id": user.ID},
		})
	}
}

// bookSummary is the header strip above the book: size, value and health of what this
// officer owns. Heads get the same shape for the whole book or a chosen officer.
func bookSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}

		scope := "TRUE"
		args := []any{}
		if isSalesHead(user) {
			if q := qstr(r, "officer_id"); q == "unassigned" {
				scope = "a.officer_id IS NULL"
			} else if q != "" {
				id, err := parseUserID(q)
				if err != nil {
					respondErr(w, 400, err.Error())
					return
				}
				scope = "a.officer_id = $1"
				args = append(args, id)
			}
		} else {
			scope = "a.officer_id = $1"
			args = append(args, user.ID)
		}

		rows, err := db.PGQuery(r.Context(), `
			-- Customer counts are person-level (a CIF is a card; count DISTINCT owner);
			-- monetary sums stay per-card over the cards this officer actually owns.
			SELECT COUNT(DISTINCT a.person_key)                               AS customers,
			       COUNT(DISTINCT a.person_key) FILTER (WHERE a.acquired_on >= date_trunc('month', CURRENT_DATE))  AS acquired_mtd,
			       COUNT(DISTINCT a.person_key) FILTER (WHERE a.acquired_on >= date_trunc('year',  CURRENT_DATE))  AS acquired_ytd,
			       COUNT(DISTINCT a.person_key) FILTER (WHERE a.acquired_on_source = 'unknown')   AS undated,
			       COUNT(DISTINCT a.person_key) FILTER (WHERE a.account_count > 0)                AS with_accounts,
			       COALESCE(SUM(k.card_balance_kobo), 0)                      AS card_balance_kobo,
			       COALESCE(SUM(l.outstanding_kobo), 0)                       AS outstanding_kobo,
			       COALESCE(SUM(f.fd_principal_kobo), 0)                      AS fd_principal_kobo,
			       COUNT(DISTINCT a.person_key) FILTER (WHERE k.max_dpd > 0)  AS customers_in_arrears,
			       COUNT(*) FILTER (WHERE f.next_maturity BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)
			                                                                  AS fd_maturing_30d
			  FROM app.customer_acquisition a
			  LEFT JOIN (`+cardAggSQL+`) k ON k.cif = a.cif
			  LEFT JOIN (`+loanAggSQL+`) l ON l.cif = a.cif
			  LEFT JOIN (`+fdAggSQL+`) f ON f.cif = a.cif
			 WHERE `+scope, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, firstRowOrEmpty(rows), "pg")
	}
}

// bookCustomer is one customer as their officer needs to see them: identity, products
// across every module, and who owns them.
func bookCustomer(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := strings.TrimSpace(chi.URLParam(r, "cif"))
		if cif == "" {
			respondErr(w, 400, "cif is required")
			return
		}
		user := core.UserFromCtx(r.Context())

		base, err := db.PGQuery(r.Context(), `
			SELECT a.*, u.full_name AS officer_name
			  FROM app.customer_acquisition a
			  LEFT JOIN o3c_users u ON u.id = a.officer_id
			 WHERE a.cif = $1`, cif)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if len(base) == 0 {
			respondErr(w, 404, "No customer with that CIF")
			return
		}

		// An officer may only open a customer on their own book; a head may open any.
		if !isSalesHead(user) {
			owner := toInt64(base[0]["officer_id"])
			if owner == 0 || owner != user.ID {
				respondErr(w, 403, "This customer is not on your book")
				return
			}
		}

		out := map[string]any{"customer": base[0]}
		type sub struct {
			key, q string
		}
		for _, s := range []sub{
			{"accounts", `SELECT account_no, product_name, card_program, status, opened_date,
			                     card_limit, current_dr_balance, days_overdue
			                FROM app.accounts WHERE cif = $1 ORDER BY opened_date DESC NULLS LAST`},
			{"loans", `SELECT cbs_account_number, product_name, status, loan_amount_kobo,
			                  outstanding_principal_kobo, outstanding_interest_kobo, outstanding_fee_kobo,
			                  interest_rate, start_date, maturity_date, officer_name
			             FROM cbs_loans WHERE cbs_customer_id = $1
			            ORDER BY start_date DESC NULLS LAST`},
			{"fixed_deposits", `SELECT cbs_account_number, product_name, status, principal_kobo,
			                           accrued_interest_kobo, interest_rate, commencement_date, maturity_date
			                      FROM cbs_fixed_deposits WHERE cbs_customer_id = $1
			                     ORDER BY maturity_date DESC NULLS LAST`},
			{"applications", `SELECT id, reference, product_type, stage, status,
			                         amount_requested_kobo, amount_approved_kobo, created_at
			                    FROM loan_applications WHERE applicant_cif = $1
			                   ORDER BY created_at DESC LIMIT 25`},
			{"tickets", `SELECT id, ticket_ref, subject, status, priority, created_at
			               FROM helpdesk_tickets WHERE customer_cif = $1
			              ORDER BY created_at DESC LIMIT 25`},
		} {
			rows, err := db.PGQuery(r.Context(), s.q, cif)
			if err != nil {
				// A module whose table is absent must not take the whole profile down;
				// the section comes back empty and the page renders the rest.
				out[s.key] = []any{}
				continue
			}
			out[s.key] = rows
		}

		respond(w, out, "pg")
	}
}

// listSalesOfficers returns the assignable officers with their current book size, so a
// head reassigning work can see the load they are adding to.
//
// This deliberately does NOT use salesOfficerPredicate. That predicate counts holding
// a book as evidence of being an officer, which is circular for the assign dropdown:
// a user with no book, no target and no sales_* role would never appear, so they could
// never be given their first customer — the list would stay permanently empty and the
// book permanently unassigned. Any active user is therefore assignable, with the role
// shown so a head can tell who they are picking. `already_officer` marks the ones the
// rest of the module already treats as officers.
func listSalesOfficers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT u.id, u.full_name, u.email, u.role, u.is_active,
			       COUNT(o.cif) AS book_size,
			       (u.role IN ('sales_officer','sales_head','head_sales','bd_officer','bd_head')
			        OR COUNT(o.cif) > 0) AS already_officer
			  FROM o3c_users u
			  LEFT JOIN customer_officers o ON o.officer_id = u.id
			 WHERE u.deleted_at IS NULL AND u.is_active
			 GROUP BY u.id, u.full_name, u.email, u.role, u.is_active
			 ORDER BY already_officer DESC, book_size DESC, u.full_name`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, rows, "pg")
	}
}

func officerHistory(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT h.id, h.changed_at, h.reason,
			       h.from_officer_id, fo.full_name AS from_officer_name,
			       h.to_officer_id,   to_.full_name AS to_officer_name,
			       cb.full_name       AS changed_by_name
			  FROM customer_officer_history h
			  LEFT JOIN o3c_users fo  ON fo.id  = h.from_officer_id
			  LEFT JOIN o3c_users to_ ON to_.id = h.to_officer_id
			  LEFT JOIN o3c_users cb  ON cb.id  = h.changed_by
			 WHERE h.cif = $1
			 ORDER BY h.changed_at DESC`, chi.URLParam(r, "cif"))
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, rows, "pg")
	}
}

type assignReq struct {
	CIFs      []string `json:"cifs"`
	CIF       string   `json:"cif"`
	OfficerID int64    `json:"officer_id"`
	Reason    string   `json:"reason"`
}

func assignOfficer(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req assignReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if req.CIF != "" {
			req.CIFs = append(req.CIFs, req.CIF)
		}
		doAssign(w, r, db, req)
	}
}

func bulkAssignOfficers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req assignReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		doAssign(w, r, db, req)
	}
}

// doAssign moves customers onto an officer's book, recording every move in
// customer_officer_history. The whole batch is one transaction: a bulk reassignment
// that half-applied would leave a book in a state nobody chose.
func doAssign(w http.ResponseWriter, r *http.Request, db *core.DB, req assignReq) {
	user := core.UserFromCtx(r.Context())
	if !isSalesHead(user) {
		respondErr(w, 403, "Only a sales head can assign account officers")
		return
	}
	if len(req.CIFs) == 0 {
		respondErr(w, 400, "cif or cifs is required")
		return
	}
	if len(req.CIFs) > 5000 {
		respondErr(w, 400, "Too many customers in one request (max 5000)")
		return
	}

	// officer_id 0 means unassign — a real operation when someone leaves.
	if req.OfficerID != 0 {
		var ok bool
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT is_active FROM o3c_users WHERE id=$1`, req.OfficerID).Scan(&ok); err != nil {
			respondErr(w, 400, "No such officer")
			return
		}
		if !ok {
			respondErr(w, 400, "That user is deactivated and cannot hold a book")
			return
		}
	}

	var changedBy sql.NullInt64
	if user != nil && user.ID != 0 {
		changedBy = sql.NullInt64{Int64: user.ID, Valid: true}
	}

	tx, err := db.PG.BeginTx(r.Context(), nil)
	if err != nil {
		respondErr(w, 500, "Could not start transaction")
		return
	}
	defer tx.Rollback() //nolint:errcheck

	var assigned, skipped int
	for _, cif := range req.CIFs {
		cif = strings.TrimSpace(cif)
		if cif == "" {
			continue
		}

		// Refuse to assign a CIF that is not a real customer — otherwise a typo silently
		// creates ownership of nothing, and the book count stops meaning anything.
		var exists bool
		if err := tx.QueryRowContext(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM app.customers WHERE cif=$1)`, cif).Scan(&exists); err != nil {
			respondErr(w, 500, "Lookup failed")
			return
		}
		if !exists {
			skipped++
			continue
		}

		var prev sql.NullInt64
		_ = tx.QueryRowContext(r.Context(),
			`SELECT officer_id FROM customer_officers WHERE cif=$1`, cif).Scan(&prev)

		if prev.Valid && prev.Int64 == req.OfficerID {
			skipped++ // already there; do not write a no-op history row
			continue
		}

		if req.OfficerID == 0 {
			if _, err := tx.ExecContext(r.Context(),
				`DELETE FROM customer_officers WHERE cif=$1`, cif); err != nil {
				respondErr(w, 500, "Unassign failed")
				return
			}
		} else if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO customer_officers (cif, officer_id, assigned_by, source, note)
			VALUES ($1,$2,$3,'manual',$4)
			ON CONFLICT (cif) DO UPDATE
			   SET officer_id  = EXCLUDED.officer_id,
			       assigned_at = NOW(),
			       assigned_by = EXCLUDED.assigned_by,
			       source      = 'manual',
			       note        = EXCLUDED.note`,
			cif, req.OfficerID, changedBy, nullIfEmpty(req.Reason)); err != nil {
			respondErr(w, 500, "Assign failed")
			return
		}

		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO customer_officer_history
			    (cif, from_officer_id, to_officer_id, changed_by, reason)
			VALUES ($1,$2,$3,$4,$5)`,
			cif, prev, nullIfZero(req.OfficerID), changedBy, nullIfEmpty(req.Reason)); err != nil {
			respondErr(w, 500, "History write failed")
			return
		}
		assigned++
	}

	if err := tx.Commit(); err != nil {
		respondErr(w, 500, "Commit failed")
		return
	}
	respond(w, map[string]any{"assigned": assigned, "skipped": skipped}, "pg")
}

// parseUserID converts a user-id query parameter to the integer the column actually is.
//
// The officer/owner columns are bigint. Passing the raw query string straight into the
// query makes Postgres evaluate `bigint = text`, for which no operator exists — the
// request fails with "operator does not exist: bigint = text" and the caller sees a
// bare 500. Parsing here turns a bad value into a 400 that says what is wrong.
func parseUserID(v string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("officer_id must be a number, 'unassigned', or omitted")
	}
	return id, nil
}

func nullIfEmpty(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func nullIfZero(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

func firstRowOrEmpty(rows []core.Row) core.Row {
	if len(rows) == 0 {
		return core.Row{}
	}
	return rows[0]
}
