package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/o3c/workspace/core"
)

// Card sale attribution.
//
// Cards were the only product nobody owned. Fixed deposits credit an officer through
// fd_transactions.sales_officer_id and loans through cbs_officer_map on the CBS officer
// name; cards had neither, so card-per-officer fell back to the CIF book and returned
// nothing — 0 of the 486 card and prepaid accounts opened this year matched an officer,
// because cards are not in CBS and the account feed carries no officer column.
//
// v_card_sale_officer (migration 241) resolves one owner per card: an explicit
// attribution beats the issuance record, which beats the legacy CIF book. Reports and
// these endpoints read the same view, so the workspace and the emails cannot disagree.

// cardAttrAcctNo matches the account numbers the feed writes. Bulk requests travel as
// one joined parameter, so anything else is refused before it reaches the query.
var cardAttrAcctNo = regexp.MustCompile(`^[0-9A-Za-z-]{4,40}$`)

// cardAttrWindow adds the opened-date filter every attribution read shares.
func cardAttrWindow(r *http.Request, where string, args []any, n int) (string, []any, int) {
	if from := qstr(r, "from"); from != "" {
		where += fmt.Sprintf(" AND v.opened_date >= $%d::date", n)
		args = append(args, from)
		n++
	}
	if to := qstr(r, "to"); to != "" {
		where += fmt.Sprintf(" AND v.opened_date <= $%d::date", n)
		args = append(args, to)
		n++
	}
	return where, args, n
}

// cardListAttribution lists card accounts opened in a window with whoever is credited
// and on what basis. Uncredited cards are included by design — the gap is the point of
// the page, and hiding it would make a half-credited month look complete.
func cardListAttribution(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		where, args, n := cardAttrWindow(r, "1=1", []any{}, 1)
		switch basis := qstr(r, "basis"); basis {
		case "":
		case "credited":
			where += " AND v.officer_id IS NOT NULL"
		case "attributed", "issuance", "legacy_book", "unattributed":
			where += fmt.Sprintf(" AND v.basis = $%d", n)
			args = append(args, basis)
			n++
		default:
			respondErr(w, 422, "basis must be credited, attributed, issuance, legacy_book or unattributed")
			return
		}
		if s := strings.TrimSpace(qstr(r, "q")); s != "" {
			where += fmt.Sprintf(" AND (v.account_no ILIKE $%d OR v.cif ILIKE $%d OR a.name_on_card ILIKE $%d)", n, n, n)
			args = append(args, "%"+s+"%")
			n++
		}
		limit := qint(r, "limit", 500, 1, 2000)
		args = append(args, limit)

		// The card PAN is deliberately not returned: the account number identifies the
		// card for crediting, and this list is read well beyond the cards team.
		q := fmt.Sprintf(`SELECT v.account_no, v.cif, COALESCE(a.name_on_card, '') AS name_on_card,
		       v.product_line, v.product_name, COALESCE(v.status, '') AS status,
		       TO_CHAR(v.opened_date, 'YYYY-MM-DD') AS opened_date,
		       v.officer_id, COALESCE(u.full_name, '') AS officer_name,
		       COALESCE(v.introducer, '') AS introducer, v.basis
		  FROM v_card_sale_officer v
		  LEFT JOIN accounts a ON a.account_no = v.account_no
		  LEFT JOIN o3c_users u ON u.id = v.officer_id
		 WHERE %s
		 ORDER BY v.opened_date DESC NULLS LAST, v.account_no
		 LIMIT $%d`, where, n)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		writeJSON(w, rows)
	}
}

// cardAttributionSummary rolls the same view up per person, split by how the credit was
// arrived at, plus the uncredited remainder. This is what the reports quote.
func cardAttributionSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		where, args, _ := cardAttrWindow(r, "1=1", []any{}, 1)

		q := fmt.Sprintf(`SELECT COALESCE(u.full_name, 'Not credited') AS person,
		       COALESCE(u.role, '') AS role,
		       v.officer_id,
		       COUNT(*)::int AS cards,
		       COUNT(*) FILTER (WHERE v.product_line = 'card')::int    AS credit_cards,
		       COUNT(*) FILTER (WHERE v.product_line = 'prepaid')::int AS prepaid_cards,
		       COUNT(*) FILTER (WHERE v.status IN ('Active','Open'))::int AS live,
		       COUNT(*) FILTER (WHERE v.basis = 'attributed')::int  AS via_attribution,
		       COUNT(*) FILTER (WHERE v.basis = 'issuance')::int     AS via_issuance,
		       COUNT(*) FILTER (WHERE v.basis = 'legacy_book')::int  AS via_legacy_book
		  FROM v_card_sale_officer v
		  LEFT JOIN o3c_users u ON u.id = v.officer_id
		 WHERE %s
		 GROUP BY u.full_name, u.role, v.officer_id
		 ORDER BY (v.officer_id IS NULL), cards DESC`, where)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		writeJSON(w, rows)
	}
}

// cardAttributionCoverage is the one number management asks first: of the cards opened
// in the window, how many have a person against them.
func cardAttributionCoverage(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		where, args, _ := cardAttrWindow(r, "1=1", []any{}, 1)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT COUNT(*)::int AS total,
			       COUNT(*) FILTER (WHERE v.officer_id IS NOT NULL)::int AS credited,
			       COUNT(*) FILTER (WHERE v.officer_id IS NULL)::int     AS uncredited,
			       COUNT(*) FILTER (WHERE v.basis = 'attributed')::int   AS via_attribution,
			       COUNT(*) FILTER (WHERE v.basis = 'issuance')::int     AS via_issuance,
			       COUNT(*) FILTER (WHERE v.basis = 'legacy_book')::int  AS via_legacy_book
			  FROM v_card_sale_officer v
			 WHERE %s`, where), args...)
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		if len(rows) == 0 {
			writeJSON(w, map[string]any{"total": 0, "credited": 0, "uncredited": 0,
				"via_attribution": 0, "via_issuance": 0, "via_legacy_book": 0})
			return
		}
		writeJSON(w, rows[0])
	}
}

// cardAttributionPeople lists everyone a card sale can be credited to. That is every
// active member of staff, not only the sales roster: ops, service and branch staff sell
// cards too. It is served here, under the attribution guard, because the sales officers
// list is gated to the sales pages and would refuse BI and management.
func cardAttributionPeople(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, full_name, role
			  FROM o3c_users
			 WHERE deleted_at IS NULL AND is_active
			 ORDER BY full_name`)
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		writeJSON(w, rows)
	}
}

// cardSetAttribution credits a card to a seller, an introducer, or both. Keyed on
// account_no rather than CIF: a card holder need not be a fully registered customer, so
// CIF is not a dependable key for a card sale.
func cardSetAttribution(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		var req struct {
			AccountNo      string `json:"account_no"`
			SalesOfficerID *int64 `json:"sales_officer_id"`
			Introducer     string `json:"introducer"`
			Note           string `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		if req.AccountNo == "" {
			respondErr(w, 422, "account_no required")
			return
		}
		// Credit has to name someone. Without this an empty save would quietly clear an
		// existing attribution and read as a successful edit.
		if req.SalesOfficerID == nil && strings.TrimSpace(req.Introducer) == "" {
			respondErr(w, 422, "name a sales officer, an introducer, or both")
			return
		}

		// Resolve the card first: this rejects a mistyped account number instead of
		// recording credit against a card that does not exist.
		acct, err := db.PGQuery(r.Context(),
			`SELECT cif, product_line FROM accounts WHERE account_no = $1 LIMIT 1`, req.AccountNo)
		if err != nil {
			respondErrLog(w, 500, "lookup failed", err)
			return
		}
		if len(acct) == 0 {
			respondErr(w, 404, "no account with that number")
			return
		}
		if pl := str(acct[0]["product_line"]); pl != "card" && pl != "prepaid" {
			respondErr(w, 422, "that account is not a card")
			return
		}
		cif := str(acct[0]["cif"])

		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO card_sale_attributions
			       (account_no, cif, sales_officer_id, introducer, basis_source, note, attributed_by)
			VALUES ($1, $2, $3, $4, 'manual', $5, $6)
			ON CONFLICT (account_no) DO UPDATE SET
			       cif              = EXCLUDED.cif,
			       sales_officer_id = EXCLUDED.sales_officer_id,
			       introducer       = EXCLUDED.introducer,
			       note             = EXCLUDED.note,
			       attributed_by    = EXCLUDED.attributed_by,
			       updated_at       = NOW()
			RETURNING id, account_no, cif, sales_officer_id, introducer`,
			req.AccountNo, cif, req.SalesOfficerID, strings.TrimSpace(req.Introducer), req.Note, user.ID)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 500, "save failed", err)
			return
		}

		aid, aname, ateam := actorOf(user)
		logActivitySafe(r.Context(), db, Activity{
			CIF: cif, ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "note", Outcome: "attributed",
			Subject: "Card sale credited", Body: req.Note,
			Source: "card_ops", EntityType: "card_attribution", EntityID: req.AccountNo,
			Metadata: map[string]any{
				"sales_officer_id": req.SalesOfficerID,
				"introducer":       req.Introducer,
			},
		})
		writeJSON(w, rows[0])
	}
}

// cardBulkAttribution credits many cards to the same person at once — the practical way
// to work through the existing book, where thousands of cards have no seller recorded.
func cardBulkAttribution(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureCardOpsSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "schema init failed")
			return
		}
		var req struct {
			AccountNos     []string `json:"account_nos"`
			SalesOfficerID *int64   `json:"sales_officer_id"`
			Introducer     string   `json:"introducer"`
			Note           string   `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		introducer := strings.TrimSpace(req.Introducer)
		if req.SalesOfficerID == nil && introducer == "" {
			respondErr(w, 422, "name a sales officer, an introducer, or both")
			return
		}
		seen := map[string]bool{}
		accts := []string{}
		for _, a := range req.AccountNos {
			a = strings.TrimSpace(a)
			if a == "" || seen[a] {
				continue
			}
			if !cardAttrAcctNo.MatchString(a) {
				respondErr(w, 422, "not an account number: "+a)
				return
			}
			seen[a] = true
			accts = append(accts, a)
		}
		if len(accts) == 0 {
			respondErr(w, 422, "choose at least one card")
			return
		}
		if len(accts) > 1000 {
			respondErr(w, 422, "credit at most 1,000 cards at a time")
			return
		}

		user := core.UserFromCtx(r.Context())
		// One statement, so a batch lands whole or not at all. Only card and prepaid
		// accounts are picked up; anything else in the list comes back as skipped.
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO card_sale_attributions
			       (account_no, cif, sales_officer_id, introducer, basis_source, note, attributed_by)
			SELECT a.account_no, a.cif, $2, $3, 'manual', $4, $5
			  FROM accounts a
			 WHERE a.account_no = ANY(string_to_array($1, ','))
			   AND a.product_line IN ('card', 'prepaid')
			ON CONFLICT (account_no) DO UPDATE SET
			       cif              = EXCLUDED.cif,
			       sales_officer_id = EXCLUDED.sales_officer_id,
			       introducer       = EXCLUDED.introducer,
			       note             = EXCLUDED.note,
			       attributed_by    = EXCLUDED.attributed_by,
			       updated_at       = NOW()
			RETURNING account_no`,
			strings.Join(accts, ","), req.SalesOfficerID, introducer, req.Note, user.ID)
		if err != nil {
			respondErrLog(w, 500, "save failed", err)
			return
		}

		done := map[string]bool{}
		for _, row := range rows {
			done[str(row["account_no"])] = true
		}
		skipped := []string{}
		for _, a := range accts {
			if !done[a] {
				skipped = append(skipped, a)
			}
		}

		aid, aname, ateam := actorOf(user)
		logActivitySafe(r.Context(), db, Activity{
			ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "note", Outcome: "attributed",
			Subject: fmt.Sprintf("Card sales credited — %d cards", len(rows)), Body: req.Note,
			Source: "card_ops", EntityType: "card_attribution", EntityID: "bulk",
			Metadata: map[string]any{
				"sales_officer_id": req.SalesOfficerID,
				"introducer":       introducer,
				"credited":         len(rows),
				"skipped":          len(skipped),
			},
		})
		writeJSON(w, map[string]any{"credited": len(rows), "skipped": skipped})
	}
}
