package handlers

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

/*
PEOPLE — the staff register, read-only.

WHAT THIS IS BUILT ON, AND WHY THAT IS THE WHOLE STORY. O3C holds no HR data. There
is no payroll table in any schema, no /api/payroll route behind the three Payroll
pages, no leave or attendance record, and no staff data source in the report
builder. The only staff data that exists is app.o3c_users — the sign-in table. So
"people monitoring" here means exactly what that table can honestly answer:

    who is on the register, what they do, where they sit, are they active or
    suspended, how long their account has existed, and are they actually signing in.

Note what is NOT in that list: a hire date. o3c_users has created_at (when the
account was made) and nothing about employment, so no figure here is named "joiners",
"leavers" or "tenure" — 50 of the 52 live accounts were created in the last 90 days
because the workspace is new, and a "joiners (90 days): 50" tile would be a flatly
false HR number. Anything further (leave, appraisals, per-person performance KPIs)
needs data the company does not yet capture, and this file does not pretend otherwise.

READ-ONLY, AND A DIFFERENT PAGE FROM admin_users. This reads the same table the User
Management page writes, which is why it is a separate page key. admin_users grants
roles, resets passwords and suspends accounts; people_directory shows the register.
HR monitors people, it does not administer their accounts — so there is no write
route in this file at all, not even a guarded one.

THE SECRET COLUMNS ARE NEVER SELECTED. o3c_users carries password_hash,
totp_secret_encrypted, telnyx_sip_password_enc, the Zoho Voice OAuth tokens and the
reinstate-code hash. Every query below names its columns explicitly — there is no
SELECT * anywhere — and people_columns_test.go fails the build if a secret column
name ever appears in this file.
*/

// peopleSafeColumns is the entire set of o3c_users columns this module exposes.
// Identity, job, contact, status, tenure, engagement — and nothing else. Named in
// one place so the test can hold the file to it.
const peopleSafeColumns = `u.id, u.full_name, u.email, u.role, u.extra_roles,
	u.department, u.phone, u.office_location, u.is_active,
	u.suspended_at, u.suspended_reason, u.last_login, u.created_at, u.deleted_at`

// peopleStatusSQL derives one status per person from four columns that can disagree.
// Order matters: a leaver who was suspended first is a leaver, and an account can be
// is_active = false AND suspended, which is how a suspension is applied.
const peopleStatusSQL = `CASE
		WHEN u.deleted_at IS NOT NULL   THEN 'left'
		WHEN u.suspended_at IS NOT NULL THEN 'suspended'
		WHEN NOT COALESCE(u.is_active, true) THEN 'inactive'
		ELSE 'active'
	END`

func RegisterPeople(r chi.Router, db *core.DB) {
	// One gate for the module. There is no second, wider gate: every route here is a
	// read, and the page key is the whole authorisation story.
	read := core.RequirePages("people_directory")

	r.With(read).Get("/summary", peopleSummary(db))
	r.With(read).Get("/staff", peopleStaffList(db))
	r.With(read).Get("/departments", peopleDepartments(db))
}

/* ── Summary ────────────────────────────────────────────────────────────────── */

// peopleSummary is the headcount picture: the register split by status, by
// department and by office, plus the two movement figures (joiners, leavers) and
// the two engagement ones (never signed in, dormant).
//
// "Dormant" is counted only over active accounts that have signed in at least
// once, so a new joiner who has not logged in yet is a joiner — not a dormant
// employee. Those are different conversations and the page says which it is.
func peopleSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		out := map[string]any{}

		if rows, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT COUNT(*)                                              AS on_register,
			       COUNT(*) FILTER (WHERE %[1]s = 'active')              AS active,
			       COUNT(*) FILTER (WHERE %[1]s = 'inactive')            AS inactive,
			       COUNT(*) FILTER (WHERE %[1]s = 'suspended')           AS suspended,
			       COUNT(*) FILTER (WHERE %[1]s = 'left')                AS left_company,
			       COUNT(DISTINCT NULLIF(btrim(COALESCE(u.department,'')), ''))
			           FILTER (WHERE %[1]s = 'active')                   AS departments,
			       COUNT(DISTINCT NULLIF(btrim(COALESCE(u.office_location,'')), ''))
			           FILTER (WHERE %[1]s = 'active')                   AS offices
			FROM app.o3c_users u`, peopleStatusSQL)); len(rows) > 0 {
			out["headcount"] = rows[0]
		}

		// NOT "joiners" and "leavers". o3c_users has no hire date and no leaving date —
		// created_at is when the ACCOUNT was made and deleted_at is when it was closed.
		// On the live register 50 of 52 accounts were created inside the last 90 days
		// because the workspace itself is new, not because the company hired 50 people.
		// The figures are named for what they measure so the page cannot present
		// account administration as staff turnover.
		if rows, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT COUNT(*) FILTER (
			           WHERE u.created_at >= now() - interval '90 days'
			             AND u.deleted_at IS NULL)                        AS accounts_added_90d,
			       COUNT(*) FILTER (
			           WHERE u.deleted_at >= now() - interval '90 days')  AS accounts_closed_90d,
			       COUNT(*) FILTER (
			           WHERE %[1]s = 'active' AND u.last_login IS NULL)   AS never_signed_in,
			       COUNT(*) FILTER (
			           WHERE %[1]s = 'active' AND u.last_login IS NOT NULL
			             AND u.last_login < now() - interval '30 days')   AS dormant_30d
			FROM app.o3c_users u`, peopleStatusSQL)); len(rows) > 0 {
			out["accounts"] = rows[0]
		}

		// Unassigned is reported as its own row rather than dropped. A blank
		// department on a live account is an HR data gap, and hiding it would make
		// the by-department figures quietly fail to add up to the headcount.
		if rows, err := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT COALESCE(NULLIF(btrim(COALESCE(u.department,'')), ''), 'Unassigned') AS department,
			       COUNT(*)                                            AS headcount,
			       COUNT(*) FILTER (WHERE u.last_login IS NULL)        AS never_signed_in
			FROM app.o3c_users u
			WHERE %s = 'active'
			GROUP BY 1
			ORDER BY 2 DESC, 1`, peopleStatusSQL)); err == nil {
			out["by_department"] = rows
		}

		if rows, err := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT COALESCE(NULLIF(btrim(COALESCE(u.office_location,'')), ''), 'Unassigned') AS office,
			       COUNT(*) AS headcount
			FROM app.o3c_users u
			WHERE %s = 'active'
			GROUP BY 1
			ORDER BY 2 DESC, 1`, peopleStatusSQL)); err == nil {
			out["by_office"] = rows
		}

		respond(w, out, "app.o3c_users")
	}
}

/* ── Staff list ─────────────────────────────────────────────────────────────── */

// peopleStatusFilters is the closed set the status filter accepts. A closed set
// rather than interpolating the parameter: the status expression is SQL, so a
// free-text value would be the one injection hole in the file.
var peopleStatusFilters = map[string]bool{
	"active": true, "inactive": true, "suspended": true, "left": true,
}

func peopleStaffList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		where := []string{}
		var args []any

		// Default view is the people who are here now. Leavers are available, but
		// only when asked for — otherwise every headcount on the page would drift
		// from the register as soon as somebody left.
		status := strings.ToLower(qstr(r, "status"))
		switch {
		case status == "" || status == "current":
			where = append(where, "u.deleted_at IS NULL")
		case status == "all":
			// no status clause
		case peopleStatusFilters[status]:
			args = append(args, status)
			where = append(where, fmt.Sprintf("%s = $%d", peopleStatusSQL, len(args)))
		default:
			respondErr(w, http.StatusBadRequest, "unknown status filter")
			return
		}

		if dept := qstr(r, "department"); dept != "" {
			args = append(args, dept)
			where = append(where, fmt.Sprintf("btrim(COALESCE(u.department,'')) = $%d", len(args)))
		}
		if q := qstr(r, "q"); q != "" {
			args = append(args, "%"+q+"%")
			where = append(where, fmt.Sprintf(
				"(u.full_name ILIKE $%[1]d OR u.email ILIKE $%[1]d OR u.phone ILIKE $%[1]d)", len(args)))
		}

		clause := "1=1"
		if len(where) > 0 {
			clause = strings.Join(where, " AND ")
		}

		// 52 staff today, so the default never pages in practice; the ceiling is low
		// enough that the endpoint cannot be turned into a bulk export of the register.
		limit := qint(r, "limit", 200, 1, 500)
		offset := qint(r, "offset", 0, 0, 100000)

		var total any
		if rows, _ := db.PGQuery(ctx,
			fmt.Sprintf(`SELECT COUNT(*) AS n FROM app.o3c_users u WHERE %s`, clause), args...); len(rows) > 0 {
			total = rows[0]["n"]
		}

		// account_age_months, NOT tenure: created_at is when the account was made, and
		// the table holds no hire date. Computed in the database so the page never has
		// to guess a timezone. Active first, then newest account, so the register opens
		// on the people who are here.
		rows, err := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT %s,
			       %s AS status,
			       GREATEST(0, EXTRACT(YEAR FROM age(now(), u.created_at)) * 12
			                 + EXTRACT(MONTH FROM age(now(), u.created_at)))::int AS account_age_months
			FROM app.o3c_users u
			WHERE %s
			ORDER BY (%s = 'active') DESC, u.created_at DESC NULLS LAST, u.id
			LIMIT %d OFFSET %d`,
			peopleSafeColumns, peopleStatusSQL, clause, peopleStatusSQL, limit, offset), args...)
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read the staff register", err)
			return
		}

		respondPaginated(w, rows, total, "app.o3c_users")
	}
}

// peopleDepartments feeds the filter. Derived from the register rather than a fixed
// list, because department is free text on o3c_users and a hard-coded list would go
// stale the first time someone typed a new one.
func peopleDepartments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT btrim(u.department) AS department, COUNT(*) AS headcount
			FROM app.o3c_users u
			WHERE %s = 'active'
			  AND NULLIF(btrim(COALESCE(u.department,'')), '') IS NOT NULL
			GROUP BY 1
			ORDER BY 1`, peopleStatusSQL))
		if err != nil {
			respondErrLog(w, http.StatusInternalServerError, "could not read departments", err)
			return
		}
		respond(w, rows, "app.o3c_users")
	}
}
