package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// Lead capture and lifecycle.
//
// Leads reach Sales from Business Development, from campaigns, from the call centre,
// and from officers profiling a walk-in or referral themselves. They live in
// crm_contacts and move
//
//	new → contacted → qualified → handed_to_sales → documents_requested
//	    → application_submitted → approved → converted
//
// or leave via disqualified from any open stage. Every move is recorded in
// crm_lead_events, so "how long did this sit in Qualified?" and "who had it before me?"
// are answerable, and crm_contacts.stage_changed_at says when the lead entered the stage
// it is in now.
//
// Conversion is the hinge between this file and sales_book.go: when a lead becomes a
// customer, the officer who worked it becomes that customer's account officer.

// leadStages is the permitted set, matching crm_contacts_lead_stage_chk (migration 246).
var leadStages = map[string]bool{
	"new": true, "contacted": true, "qualified": true,
	"handed_to_sales": true, "documents_requested": true,
	"application_submitted": true, "approved": true,
	"converted": true, "disqualified": true,
}

// leadStageOrder gates forward movement. Conversion and disqualification are handled by
// their own endpoints, which do more than move a stage.
var leadStageOrder = map[string]int{
	"new": 0, "contacted": 1, "qualified": 2,
	"handed_to_sales": 3, "documents_requested": 4, "application_submitted": 5, "approved": 6,
	"converted": 7, "disqualified": 7,
}

// openLeadStagesSQL is every stage a lead can still be worked in (anything but converted
// or disqualified), as a SQL IN-list. workedLeadStagesSQL is the same minus 'new': the
// stages where someone has touched the lead, which is what the "stalled" worklists
// count. Kept here so a stage added later cannot be silently left out of one query.
const (
	openLeadStagesSQL   = `'new','contacted','qualified','handed_to_sales','documents_requested','application_submitted','approved'`
	workedLeadStagesSQL = `'contacted','qualified','handed_to_sales','documents_requested','application_submitted','approved'`
)

// isOpenLeadStage reports whether a lead in this stage can still be worked.
func isOpenLeadStage(s string) bool {
	return leadStages[s] && s != "converted" && s != "disqualified"
}

// advanceLeadOnApplication moves a lead to 'application_submitted' when an application
// is submitted from it, if the lead is still in an earlier open stage. A lead that is
// already application_submitted, approved, converted or disqualified is never moved.
// Runs inside the caller's transaction and records the move in crm_lead_events.
func advanceLeadOnApplication(ctx context.Context, tx *sql.Tx, leadID int64, actor any, note string) (moved bool, err error) {
	const to = "application_submitted"
	var current string
	if err := tx.QueryRowContext(ctx,
		`SELECT lead_stage FROM app.crm_contacts WHERE id = $1 FOR UPDATE`, leadID).Scan(&current); err != nil {
		return false, err
	}
	if !isOpenLeadStage(current) || leadStageOrder[current] >= leadStageOrder[to] {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE app.crm_contacts
		   SET lead_stage = $2, stage_changed_at = NOW(),
		       qualified_at = COALESCE(qualified_at, NOW()),
		       last_activity_at = NOW(), updated_at = NOW()
		 WHERE id = $1`, leadID, to); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
		VALUES ($1,'stage_change',$2,$3,$4,$5)`,
		leadID, current, to, nullIfEmpty(note), actor); err != nil {
		return false, err
	}
	return true, nil
}

func RegisterSalesLeads(r chi.Router, db *core.DB) {
	access := core.RequirePages("sales", "crm_contacts", "bd")

	r.With(access).Get("/leads", listLeads(db))
	r.With(access).Post("/leads", createLead(db))
	r.With(access).Get("/leads/sources", listLeadSources(db))
	r.With(access).Get("/leads/funnel", leadFunnel(db))
	r.With(access).Get("/leads/{id}", getLead(db))
	r.With(access).Patch("/leads/{id}", updateLead(db))
	r.With(access).Post("/leads/{id}/stage", moveLeadStage(db))
	// Logging what happened on a lead is how it moves forward: record "Documents
	// requested" and the lead is at Documents requested, with the entry on its timeline.
	r.With(access).Post("/leads/{id}/activity", logLeadActivity(db))
	r.With(access).Post("/leads/{id}/claim", claimLead(db))
	// Hand a lead to another officer. Owner or head only; see transferLead.
	r.With(access).Post("/leads/{id}/transfer", transferLead(db))
	r.With(access).Post("/leads/{id}/convert", convertLead(db))
	r.With(access).Post("/leads/{id}/disqualify", disqualifyLead(db))
	r.With(access).Get("/leads/{id}/events", leadEvents(db))
	// Everything that has happened to this lead, from every team. See leadTimeline.
	r.With(access).Get("/leads/{id}/timeline", leadTimeline(db))

	// Bulk distribution of the unowned lead pool. Head-only (enforced in-handler,
	// like the book's assign routes). Static path — no conflict with /leads/{id}.
	r.With(access).Post("/leads/distribute", distributeLeads(db))

	// Re-flag leads that are already customers (matched by phone) so they drop out of
	// the queue. Head-only; the initial pass runs in migration 192.
	r.With(access).Post("/leads/rescan-customers", rescanCustomerLeads(db))
}

// rescanCustomerLeads re-flags any non-converted lead whose phone now matches a real
// customer (customers arrive continuously via the feed, so new matches appear over
// time). Idempotent — only touches rows not already flagged.
func rescanCustomerLeads(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isSalesHead(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Only a sales head can run the customer match")
			return
		}
		res, err := db.PGExec(r.Context(), `
			UPDATE app.crm_contacts c
			   SET already_customer     = true,
			       matched_customer_cif = (
			         SELECT cu.cif FROM app.customers cu
			          WHERE app.normalise_ng_phone(cu.phone) = app.normalise_ng_phone(c.phone)
			          ORDER BY cu.cif LIMIT 1),
			       customer_matched_at  = now()
			 WHERE c.lead_stage <> 'converted'
			   AND COALESCE(c.already_customer, false) = false
			   AND app.normalise_ng_phone(c.phone) IS NOT NULL
			   AND EXISTS (
			     SELECT 1 FROM app.customers cu
			      WHERE app.normalise_ng_phone(cu.phone) = app.normalise_ng_phone(c.phone))`)
		if err != nil {
			respondErrLog(w, 500, "Rescan failed", err)
			return
		}
		flagged, _ := res.RowsAffected()
		respond(w, map[string]any{"flagged": flagged}, "pg")
	}
}

type distributeReq struct {
	OfficerIDs []int64 `json:"officer_ids"`
	Strategy   string  `json:"strategy"` // "round_robin" (default) | "by_state"
	Source     string  `json:"source"`   // optional lead_source filter
	State      string  `json:"state"`    // optional state filter
	Limit      int     `json:"limit"`    // optional cap; 0 = every unowned lead
	DryRun     bool    `json:"dry_run"`  // preview the split without writing
}

// distributeLeads load-balances the unowned lead pool across a chosen set of
// officers. It is the sales analogue of the call centre's ticket distribution and
// the linchpin that makes the whole module operational: nothing on an officer's
// dashboard can light up until they own leads.
//
// Two guarantees make it safe to run repeatedly:
//   - It only ever touches leads with no sales owner (sales_owner_id IS NULL) that
//     have actually reached Sales (sales_entered_at IS NOT NULL). Re-running never
//     reshuffles work an officer has already started — it just picks up whatever is
//     still unassigned.
//   - The whole batch is one transaction. A half-applied distribution would leave
//     the book in a state nobody chose.
//
// The sales_entered_at half of the first guarantee is load-bearing, not belt-and-
// braces. The pool used to read "lead_owner_id IS NULL AND status='lead'", which on
// 28 Sept 2026 selected 15,146 rows of which every one was a help-desk contact from
// Zoho Desk. One press of Distribute would have dealt the support inbox out across
// the sales floor as assigned work, with an audit event on each row saying it was
// deliberate. See migration 302.
//
// Every assignment is written to crm_lead_events (event 'assigned', to_owner set)
// so "who was this handed to, and when?" stays answerable.
func distributeLeads(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if !isSalesHead(user) {
			respondErr(w, 403, "Only a sales head can distribute leads")
			return
		}

		var req distributeReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if len(req.OfficerIDs) == 0 {
			respondErr(w, 400, "officer_ids is required")
			return
		}
		if len(req.OfficerIDs) > 100 {
			respondErr(w, 400, "Too many officers in one request (max 100)")
			return
		}
		switch req.Strategy {
		case "":
			req.Strategy = "round_robin"
		case "round_robin", "by_state":
			// ok
		default:
			respondErr(w, 400, "strategy must be round_robin or by_state")
			return
		}

		// A team head may only distribute to officers on their own team; executives
		// (scopeAll) distribute to anyone.
		if mode, teamIDs := salesLeadScope(r, db, user); mode == scopeTeam {
			allowed := map[int64]bool{}
			for _, id := range teamIDs {
				allowed[id] = true
			}
			for _, id := range req.OfficerIDs {
				if !allowed[id] {
					respondErr(w, 403, "You can only distribute leads to officers on your team")
					return
				}
			}
		}

		// Validate every recipient is a real, active user. Preserve the caller's
		// order (deduped) so round-robin is deterministic and previewable.
		seen := map[int64]bool{}
		officers := make([]int64, 0, len(req.OfficerIDs))
		names := map[int64]string{}
		for _, id := range req.OfficerIDs {
			if id == 0 || seen[id] {
				continue
			}
			var name string
			var active bool
			if err := db.PG.QueryRowContext(r.Context(),
				`SELECT full_name, is_active FROM o3c_users WHERE id=$1 AND deleted_at IS NULL`, id).
				Scan(&name, &active); err != nil {
				respondErr(w, 400, fmt.Sprintf("No such user: %d", id))
				return
			}
			if !active {
				respondErr(w, 400, fmt.Sprintf("%s is deactivated and cannot receive leads", name))
				return
			}
			seen[id] = true
			officers = append(officers, id)
			names[id] = name
		}
		if len(officers) == 0 {
			respondErr(w, 400, "No valid officers")
			return
		}

		// Read the unowned lead pool, optionally scoped by source/state and capped.
		// Gated on sales_entered_at: only leads genuinely handed to Sales are dealable.
		q := `SELECT id, COALESCE(NULLIF(TRIM(state),''),'—') AS state
		        FROM crm_contacts
		       WHERE sales_entered_at IS NOT NULL
		         AND sales_owner_id IS NULL
		         AND status = 'lead'`
		args := []any{}
		n := 1
		if req.Source != "" {
			q += fmt.Sprintf(" AND lead_source = $%d", n)
			args = append(args, req.Source)
			n++
		}
		if req.State != "" {
			q += fmt.Sprintf(" AND state = $%d", n)
			args = append(args, req.State)
			n++
		}
		q += " ORDER BY created_at NULLS LAST, id"
		if req.Limit > 0 {
			q += fmt.Sprintf(" LIMIT $%d", n)
			args = append(args, req.Limit)
		}
		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErrLog(w, 500, "Could not read the lead pool", err)
			return
		}

		// Split into per-officer buckets. by_state keeps every lead from one state
		// with the same officer (so nobody juggles one lead across forty states);
		// round_robin simply cycles.
		buckets := map[int64][]int64{}
		stateOwner := map[string]int64{}
		next := 0
		for _, row := range rows {
			id := toInt64(row["id"])
			if id == 0 {
				continue
			}
			var officer int64
			if req.Strategy == "by_state" {
				st, _ := row["state"].(string)
				if o, ok := stateOwner[st]; ok {
					officer = o
				} else {
					officer = officers[next%len(officers)]
					stateOwner[st] = officer
					next++
				}
			} else {
				officer = officers[next%len(officers)]
				next++
			}
			buckets[officer] = append(buckets[officer], id)
		}

		type perOfficer struct {
			OfficerID int64  `json:"officer_id"`
			FullName  string `json:"full_name"`
			Count     int    `json:"count"`
		}
		summary := make([]perOfficer, 0, len(officers))
		total := 0
		for _, id := range officers {
			c := len(buckets[id])
			total += c
			summary = append(summary, perOfficer{OfficerID: id, FullName: names[id], Count: c})
		}

		// Dry run previews the split; no writes.
		if req.DryRun {
			respond(w, map[string]any{"assigned": 0, "would_assign": total, "per_officer": summary, "dry_run": true}, "pg")
			return
		}
		if total == 0 {
			respond(w, map[string]any{"assigned": 0, "per_officer": summary}, "pg")
			return
		}

		tx, err := db.PG.BeginTx(r.Context(), nil)
		if err != nil {
			respondErr(w, 500, "Could not start transaction")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		for _, id := range officers {
			ids := buckets[id]
			if len(ids) == 0 {
				continue
			}
			// The sales_owner_id IS NULL guard in the WHERE clause makes this a no-op
			// on anything a concurrent request grabbed first — re-running is safe.
			// lead_owner_id is deliberately untouched: it is the call-centre agent's
			// own book, and distributing a lead to Sales must not empty it.
			if _, err := tx.ExecContext(r.Context(), `
				UPDATE crm_contacts
				   SET sales_owner_id = $1,
				       updated_at     = NOW()
				 WHERE id = ANY($2)
				   AND sales_owner_id IS NULL
				   AND sales_entered_at IS NOT NULL`, id, ids); err != nil {
				respondErrLog(w, 500, "Assignment failed", err)
				return
			}
			if _, err := tx.ExecContext(r.Context(), `
				INSERT INTO crm_lead_events (contact_id, event, to_owner, note, created_by)
				SELECT unnest($1::bigint[]), 'assigned', $2, 'Bulk distribution', $3`,
				ids, id, user.ID); err != nil {
				respondErrLog(w, 500, "Could not record lead events", err)
				return
			}
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Could not commit the distribution")
			return
		}
		respond(w, map[string]any{"assigned": total, "per_officer": summary}, "pg")
	}
}

// listLeads returns the lead queue. An officer sees their own; a head sees everyone's.
func listLeads(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}

		// Customers are excluded: this is the lead queue, not the customer book. Without
		// this the 1,794 already-converted rows would sit permanently at the top.
		where := []string{"c.lead_stage <> 'converted'"}
		args := []any{}
		n := 1

		// Owner scope: executives see all, a team head sees their team + the unowned
		// pool, an officer sees their own + the pool. (salesLeadScope / applyLeadScope.)
		where, args, n = applyLeadScope(r, db, user, where, args, n)

		// This is the lead queue, not the customer book: hide contacts already matched to
		// a real customer by phone. ?include_customers=1 surfaces them for review.
		if qstr(r, "include_customers") != "1" {
			where = append(where, "COALESCE(c.already_customer, false) = false")
		}

		if s := qstr(r, "stage"); s != "" && leadStages[s] {
			where = append(where, fmt.Sprintf("c.lead_stage = $%d", n))
			args = append(args, s)
			n++
		}
		if src := qstr(r, "source"); src != "" {
			where = append(where, fmt.Sprintf("c.lead_source = $%d", n))
			args = append(args, src)
			n++
		}
		// How the lead reached SALES — call_centre | business_dev | self — which is a
		// different question from lead_source above. lead_source records where the
		// contact originally came from and is set by whoever created it; sales_source
		// records which of the three doors into Sales it came through. A campaign lead
		// worked by the call centre and then forwarded has lead_source 'call_centre' and
		// sales_source 'call_centre'; the same lead entered by an officer who met them at
		// a branch has sales_source 'self'. Officers filter on the second.
		if ss := qstr(r, "sales_source"); ss != "" {
			where = append(where, fmt.Sprintf("c.sales_source = $%d", n))
			args = append(args, ss)
			n++
		}
		// Filter by product line ('cards'|'loans'|'fixed_deposit') — expand to the
		// line's canonical sub-codes so a lead tagged 'credit_card' matches line 'cards'.
		if line := qstr(r, "line"); line != "" {
			if subs := SubsForLine(line); len(subs) > 0 {
				ph := make([]string, len(subs))
				for i, s := range subs {
					ph[i] = fmt.Sprintf("$%d", n)
					args = append(args, s)
					n++
				}
				where = append(where, "c.product_interest IN ("+strings.Join(ph, ",")+")")
			}
		}
		if q := qstr(r, "q"); q != "" {
			if clause, sargs, nn := buildCustomerSearch(q,
				[]string{"c.first_name", "c.last_name", "c.email", "c.phone"}, "c.phone", n); clause != "" {
				where = append(where, clause)
				args = append(args, sargs...)
				n = nn
			}
		}
		if qstr(r, "due") == "1" {
			where = append(where, "c.next_action_at IS NOT NULL AND c.next_action_at <= NOW()")
		}
		// stalled=1 mirrors the overview's "stalled leads" worklist: contacted or any
		// later open stage, but untouched for a fortnight — so that attention tile
		// deep-links to exactly the rows it counts.
		if qstr(r, "stalled") == "1" {
			where = append(where, "c.lead_stage IN ("+workedLeadStagesSQL+") AND COALESCE(c.last_activity_at, c.updated_at) < NOW() - INTERVAL '14 days'")
		}

		cond := strings.Join(where, " AND ")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1_000_000)

		var total int64
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT COUNT(*) FROM crm_contacts c WHERE `+cond, args...).Scan(&total); err != nil {
			respondErr(w, 500, "Count failed")
			return
		}

		rows, err := db.PGQuery(r.Context(), `
			SELECT c.id, c.first_name, c.last_name, c.phone, c.email,
			       c.state, c.city, c.employer, c.occupation,
			       c.lead_stage, c.lead_source, c.source, c.source_type,
			       c.product_interest,
			       c.sales_owner_id, c.estimated_value_kobo,
			       c.next_action_at, c.last_activity_at,
			       c.qualified_at, c.created_at, c.updated_at,
			       c.already_customer, c.matched_customer_cif,
			       c.converted_cif,
			       -- The CIF to open in Customer 360, only when that customer exists: a
			       -- converted lead's CIF, or the customer an existing-customer lead matched.
			       CASE WHEN NULLIF(c.converted_cif, '') IS NOT NULL
			                 AND EXISTS (SELECT 1 FROM customers cu WHERE cu.cif = c.converted_cif)
			            THEN c.converted_cif
			            WHEN COALESCE(c.already_customer, false) AND NULLIF(c.matched_customer_cif, '') IS NOT NULL
			                 AND EXISTS (SELECT 1 FROM customers cu WHERE cu.cif = c.matched_customer_cif)
			            THEN c.matched_customer_cif
			       END AS customer360_cif,
			       u.full_name AS owner_name,
			       e.name      AS employer_name
			  FROM crm_contacts c
			  LEFT JOIN o3c_users u ON u.id = c.sales_owner_id
			  LEFT JOIN employers e ON e.id = c.employer_id
			 WHERE `+cond+`
			 ORDER BY (c.next_action_at IS NOT NULL AND c.next_action_at <= NOW()) DESC,
			          c.updated_at DESC
			 LIMIT `+fmt.Sprintf("$%d OFFSET $%d", n, n+1),
			append(args, limit, offset)...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data": rows, "total": total, "limit": limit, "offset": offset,
		})
	}
}

func listLeadSources(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT code, label FROM crm_lead_sources WHERE is_active ORDER BY order_index, label`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, rows, "pg")
	}
}

// leadFunnel is the conversion picture: how many leads sit at each stage, and how many
// converted, scoped the same way the queue is.
func leadFunnel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		// Same owner scope as the queue, so the funnel counts exactly what the list shows.
		where := []string{"TRUE"}
		args := []any{}
		where, args, _ = applyLeadScope(r, db, user, where, args, 1)
		if qstr(r, "include_customers") != "1" {
			where = append(where, "COALESCE(c.already_customer, false) = false")
		}
		scope := strings.Join(where, " AND ")

		rows, err := db.PGQuery(r.Context(), `
			SELECT c.lead_stage AS stage, COUNT(*) AS n,
			       COALESCE(SUM(c.estimated_value_kobo), 0) AS value_kobo
			  FROM crm_contacts c
			 WHERE `+scope+`
			 GROUP BY c.lead_stage`, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}

		// Return every stage, including empty ones, so the funnel renders a consistent
		// shape rather than collapsing when a stage happens to be empty.
		counts := map[string]any{}
		values := map[string]any{}
		for s := range leadStages {
			counts[s], values[s] = int64(0), int64(0)
		}
		for _, row := range rows {
			s, _ := row["stage"].(string)
			counts[s] = toInt64(row["n"])
			values[s] = toInt64(row["value_kobo"])
		}

		// Product mix: open (non-converted) leads grouped into the three product lines,
		// so the pipeline can be read by product. Untagged leads fall into 'unclassified'.
		mixRows, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(product_interest,'') AS code, COUNT(*) AS n,
			       COALESCE(SUM(estimated_value_kobo),0) AS value_kobo
			  FROM crm_contacts c
			 WHERE `+scope+` AND c.lead_stage <> 'converted'
			 GROUP BY COALESCE(product_interest,'')`, args...)
		mix := map[string]map[string]any{
			"cards":         {"count": int64(0), "value_kobo": int64(0)},
			"loans":         {"count": int64(0), "value_kobo": int64(0)},
			"fixed_deposit": {"count": int64(0), "value_kobo": int64(0)},
			"unclassified":  {"count": int64(0), "value_kobo": int64(0)},
		}
		for _, row := range mixRows {
			line := ProductLineOf(str(row["code"]))
			if line == "" {
				line = "unclassified"
			}
			mix[line]["count"] = toInt64(mix[line]["count"]) + toInt64(row["n"])
			mix[line]["value_kobo"] = toInt64(mix[line]["value_kobo"]) + toInt64(row["value_kobo"])
		}

		respond(w, map[string]any{"counts": counts, "value_kobo": values, "product_mix": mix}, "pg")
	}
}

type leadReq struct {
	FirstName    string `json:"first_name"`
	LastName     string `json:"last_name"`
	Phone        string `json:"phone"`
	Email        string `json:"email"`
	State        string `json:"state"`
	City         string `json:"city"`
	Address      string `json:"address"`
	Occupation   string `json:"occupation"`
	Employer     string `json:"employer"`
	EmployerID   *int64 `json:"employer_id"`
	IncomeRange  string `json:"income_range"`
	LeadSource   string `json:"lead_source"`
	OwnerID      *int64 `json:"sales_owner_id"`
	EstValueKobo *int64 `json:"estimated_value_kobo"`
	NextActionAt string `json:"next_action_at"`
	Notes        string `json:"notes"`
	// Which of the three product lines this lead is an opportunity for. Stored as a
	// canonical sub-code (see handlers/products.go); free-text is normalized on write.
	ProductInterest string `json:"product_interest"`
}

// createLead lets a sales officer or BD officer profile a lead directly.
//
// The lead defaults to the creating user, because in practice whoever profiles a
// walk-in intends to work it; a head can reassign afterwards.
func createLead(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req leadReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		req.FirstName = strings.TrimSpace(req.FirstName)
		req.LastName = strings.TrimSpace(req.LastName)
		req.Phone = strings.TrimSpace(req.Phone)
		req.Email = strings.TrimSpace(req.Email)

		if req.FirstName == "" && req.LastName == "" {
			respondErr(w, 400, "A first or last name is required")
			return
		}
		// A lead with no way to reach it is not a lead.
		if req.Phone == "" && req.Email == "" {
			respondErr(w, 400, "A phone number or email is required")
			return
		}
		if req.LeadSource == "" {
			respondErr(w, 400, "lead_source is required. Without it nobody can be credited for the origination.")
			return
		}
		var validSource bool
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM crm_lead_sources WHERE code=$1 AND is_active)`,
			req.LeadSource).Scan(&validSource); err != nil || !validSource {
			respondErr(w, 400, "Unknown lead_source")
			return
		}

		user := core.UserFromCtx(r.Context())
		owner := sql.NullInt64{}
		if req.OwnerID != nil && *req.OwnerID != 0 {
			owner = sql.NullInt64{Int64: *req.OwnerID, Valid: true}
		} else if user != nil && user.ID != 0 {
			owner = sql.NullInt64{Int64: user.ID, Valid: true}
		}
		var createdBy sql.NullInt64
		if user != nil && user.ID != 0 {
			createdBy = sql.NullInt64{Int64: user.ID, Valid: true}
		}

		// Warn on an existing contact with the same phone rather than blocking: the same
		// person genuinely can come back as a fresh opportunity, but silently creating a
		// second record is how a book becomes untrustworthy.
		var dupID sql.NullInt64
		if req.Phone != "" {
			_ = db.PG.QueryRowContext(r.Context(),
				`SELECT id FROM crm_contacts WHERE phone = $1 ORDER BY id LIMIT 1`,
				req.Phone).Scan(&dupID)
		}

		tx, err := db.PG.BeginTx(r.Context(), nil)
		if err != nil {
			respondErr(w, 500, "Could not start transaction")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		productInterest := sql.NullString{}
		if pc := NormalizeProductCode(req.ProductInterest); pc != "" {
			productInterest = sql.NullString{String: pc, Valid: true}
		}

		// sales_entered_at is stamped unconditionally: a lead an officer profiles here is
		// in Sales by definition — it is the third way in, alongside the call-centre
		// hand-off and a BD assignment. Without it the lead would be created and then be
		// invisible on the very page that created it, since the queue is gated on this
		// column (migration 302).
		var id int64
		err = tx.QueryRowContext(r.Context(), `
			INSERT INTO crm_contacts (
			    first_name, last_name, phone, email, state, city, address,
			    occupation, employer, employer_id, income_range,
			    status, lead_stage, lead_source, source, source_type,
			    sales_owner_id, assigned_to, estimated_value_kobo, next_action_at,
			    product_interest, notes, created_by, last_activity_at, created_at, updated_at,
			    sales_entered_at, sales_source
			) VALUES (
			    $1,$2,$3,$4,$5,$6,$7,
			    $8,$9,$10,$11,
			    'lead','new',$12,'workspace','manual',
			    $13,$13,$14,NULLIF($15,'')::timestamptz,
			    $16,$17,$18,NOW(),NOW(),NOW(),
			    NOW(),'self'
			) RETURNING id`,
			req.FirstName, req.LastName, req.Phone, req.Email, req.State, req.City, req.Address,
			req.Occupation, req.Employer, req.EmployerID, req.IncomeRange,
			req.LeadSource, owner, req.EstValueKobo, req.NextActionAt,
			productInterest, req.Notes, createdBy).Scan(&id)
		if err != nil {
			respondErr(w, 500, "Could not create lead: "+err.Error())
			return
		}

		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO crm_lead_events (contact_id, event, to_stage, to_owner, note, created_by)
			VALUES ($1,'created','new',$2,$3,$4)`,
			id, owner, nullIfEmpty(req.Notes), createdBy); err != nil {
			respondErr(w, 500, "Could not record lead event")
			return
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		out := map[string]any{"id": id, "lead_stage": "new"}
		if dupID.Valid {
			out["possible_duplicate_of"] = dupID.Int64
			out["warning"] = "Another contact already has this phone number"
		}
		respond(w, out, "pg")
	}
}

// getLead returns one lead in full.
//
// Scoped like the queue it is opened from. It previously fetched any crm_contacts row by
// id with no check at all, which meant the whole record of any of the 16,752 Zoho Desk
// help-desk contacts — name, phone, email, employer, notes — came back to anyone who
// could reach the endpoint, simply by walking the ids. Filtering the LIST is not enough
// when the DETAIL takes an id from the caller.
func getLead(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		gate := []string{"c.id = $1"}
		gargs := []any{chi.URLParam(r, "id")}
		gate, gargs, _ = applyLeadScope(r, db, user, gate, gargs, 2)
		var visible bool
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM crm_contacts c WHERE `+strings.Join(gate, " AND ")+`)`,
			gargs...).Scan(&visible); err != nil || !visible {
			respondErr(w, 404, "Lead not found")
			return
		}

		rows, err := db.PGQuery(r.Context(), `
			SELECT c.*, u.full_name AS owner_name, e.name AS employer_name,
			       cb.full_name AS created_by_name,
			       f.forwarded_by_name  AS cc_forwarded_by,
			       f.notes              AS cc_forward_notes,
			       f.product_interest   AS cc_product_interest,
			       f.forwarded_at       AS cc_forwarded_at
			  FROM crm_contacts c
			  LEFT JOIN o3c_users u  ON u.id  = c.sales_owner_id
			  LEFT JOIN o3c_users cb ON cb.id = c.created_by
			  LEFT JOIN employers e  ON e.id  = c.employer_id
			  LEFT JOIN LATERAL (
			      SELECT forwarded_by_name, notes, product_interest, forwarded_at
			        FROM call_center_lead_forwards
			       WHERE contact_id = c.id
			       ORDER BY forwarded_at DESC LIMIT 1
			  ) f ON true
			 WHERE c.id = $1`, chi.URLParam(r, "id"))
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "Lead not found")
			return
		}
		// id_number is encrypted at rest; never widen this endpoint to expose it.
		delete(rows[0], "id_number_enc")
		delete(rows[0], "id_number_hmac")
		delete(rows[0], "id_number")
		respond(w, rows[0], "pg")
	}
}

// leadTimeline returns everything that has happened to a lead, from every team, as one
// ordered list.
//
// A lead's history is written in three places by three different parts of the business
// and the Leads page only ever showed one of them:
//
//   crm_lead_events            stage moves, claims, transfers, conversion  (Sales)
//   app.activities             calls, notes, visits, hand-offs             (every team)
//   call_center_lead_forwards  the hand-off itself, and how it resolved    (call centre)
//
// Showing only crm_lead_events meant an officer opening a lead saw "qualified" and
// nothing else — not the 14,818 recorded calls, not who dialled them, not what the
// customer said. The single most useful fact about a lead ("we have rung this person
// four times and they asked us to call back in March") lived one table away and was
// never on screen.
//
// Merged in SQL rather than in the client: the three sources have different shapes and
// different time columns, and interleaving them correctly by time is exactly what a
// UNION with a shared ORDER BY is for. The client renders what it is given.
func leadTimeline(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")

		// The lead must be visible to this caller before any of its history is. Without
		// this the endpoint would hand back the full call history of any contact whose
		// id was guessed, including help-desk contacts that are not leads at all.
		user := core.UserFromCtx(r.Context())
		where := []string{"c.id = $1"}
		args := []any{id}
		where, args, _ = applyLeadScope(r, db, user, where, args, 2)
		var visible bool
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM crm_contacts c WHERE `+strings.Join(where, " AND ")+`)`,
			args...).Scan(&visible); err != nil || !visible {
			respondErr(w, 404, "Lead not found")
			return
		}

		rows, err := db.PGQuery(r.Context(), `
			(
			  SELECT e.created_at                              AS at,
			         'lead_event'                              AS kind,
			         e.event                                   AS type,
			         NULLIF(TRIM(COALESCE(e.from_stage,'') || ' → ' || COALESCE(e.to_stage,'')), '→') AS detail,
			         e.note                                    AS note,
			         COALESCE(u.full_name, 'System')           AS actor,
			         'sales'                                   AS team,
			         NULL                                      AS outcome
			    FROM crm_lead_events e
			    LEFT JOIN o3c_users u ON u.id = e.created_by
			   WHERE e.contact_id = $1
			)
			UNION ALL
			(
			  SELECT a.occurred_at, 'activity', a.type,
			         a.subject, a.body,
			         COALESCE(NULLIF(a.actor_name,''), 'System'),
			         COALESCE(a.actor_team, 'unknown'),
			         a.outcome
			    FROM app.activities a
			   WHERE a.contact_id = $1
			)
			UNION ALL
			(
			  SELECT f.forwarded_at, 'handoff', 'forwarded_to_sales',
			         'Forwarded to Sales' ||
			           CASE WHEN NULLIF(f.product_interest,'') IS NOT NULL
			                THEN ' · ' || f.product_interest ELSE '' END,
			         f.notes,
			         COALESCE(NULLIF(f.forwarded_by_name,''), 'Call centre'),
			         'call_center',
			         f.status
			    FROM call_center_lead_forwards f
			   WHERE f.contact_id = $1
			)
			ORDER BY at DESC
			LIMIT 300`, id)
		if err != nil {
			respondErrLog(w, 500, "Could not load the lead timeline", err)
			return
		}
		respond(w, rows, "pg")
	}
}

// transferLead hands a lead from one officer to another.
//
// Officers cover for each other — leave, a customer who turns out to be a colleague's
// existing relationship, a lead in a state the owner does not cover — and until now the
// only ways to move one were to ask a head to run a bulk distribution (which only
// touches UNOWNED leads, so it could not move this one at all) or to have the receiving
// officer claim it, which claimLead refuses on a lead somebody already owns. So in
// practice a lead could not be moved once claimed.
//
// Who may transfer: the current owner (handing their own work over), or a head
// (reassigning within their team). Not a third officer helping themselves to someone
// else's lead — that is a reassignment, and it belongs to the owner or their head.
//
// Every transfer is written to crm_lead_events with BOTH sides recorded in from_owner
// and to_owner, so "who had this before me, and who gave it to them?" stays answerable
// down the whole chain.
func transferLead(db *core.DB) http.HandlerFunc {
	type body struct {
		ToUserID int64  `json:"to_user_id"`
		Note     string `json:"note"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		if user == nil || user.ID == 0 {
			respondErr(w, 401, "Not authenticated")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ToUserID <= 0 {
			respondErr(w, 400, "Choose the officer to transfer this lead to")
			return
		}

		var owner sql.NullInt64
		var stage string
		var inSales sql.NullTime
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT sales_owner_id, lead_stage, sales_entered_at FROM crm_contacts WHERE id=$1`,
			id).Scan(&owner, &stage, &inSales); err != nil {
			respondErr(w, 404, "Lead not found")
			return
		}
		// Same gate as the queue and claimLead: a contact that never reached Sales is
		// not a lead, whatever id is posted.
		if !inSales.Valid {
			respondErr(w, 404, "Lead not found")
			return
		}
		if !isOpenLeadStage(stage) {
			respondErr(w, 409, "This lead is closed — a converted or disqualified lead cannot be transferred")
			return
		}
		if owner.Valid && owner.Int64 == b.ToUserID {
			respondErr(w, 400, "That officer already owns this lead")
			return
		}

		isHead := core.IsManagement(user.Role) || isSalesHead(user)
		if !isHead && !(owner.Valid && owner.Int64 == user.ID) {
			respondErr(w, 403, "You can only transfer a lead you own")
			return
		}

		// The recipient has to be a real, active user. Without this a typo'd id parks the
		// lead on nobody and it silently leaves every queue: the pool query looks for
		// sales_owner_id IS NULL, and this would not be NULL.
		var recipient string
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT full_name FROM o3c_users WHERE id=$1 AND deleted_at IS NULL AND is_active`,
			b.ToUserID).Scan(&recipient); err != nil {
			respondErr(w, 400, "That officer is not an active user")
			return
		}

		tx, err := db.PG.BeginTx(r.Context(), nil)
		if err != nil {
			respondErr(w, 500, "Could not start transaction")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Guarded on the owner we read above, so two people transferring the same lead at
		// once cannot both succeed — the second finds it moved and is told so.
		res, err := tx.ExecContext(r.Context(), `
			UPDATE crm_contacts
			   SET sales_owner_id = $2, last_activity_at = NOW(), updated_at = NOW()
			 WHERE id = $1 AND sales_owner_id IS NOT DISTINCT FROM $3`,
			id, b.ToUserID, owner)
		if err != nil {
			respondErrLog(w, 500, "Transfer failed", err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 409, "This lead moved to another officer while you were working on it")
			return
		}

		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO crm_lead_events (contact_id, event, from_owner, to_owner, note, created_by)
			VALUES ($1,'transferred',$2,$3,$4,$5)`,
			id, owner, b.ToUserID, nullIfEmpty(strings.TrimSpace(b.Note)), user.ID); err != nil {
			respondErrLog(w, 500, "Could not record the transfer", err)
			return
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Transfer failed")
			return
		}
		respond(w, map[string]any{"ok": true, "to_user_id": b.ToUserID, "to_name": recipient}, "pg")
	}
}

// claimLead lets a sales officer take ownership of a lead handed over by the call
// centre (or any unowned lead). It records the claim on the call-centre hand-off
// tracker as 'assigned', so the forwarding agent sees Sales has picked it up.
func claimLead(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		if user == nil || user.ID == 0 {
			respondErr(w, 401, "Not authenticated")
			return
		}
		var owner sql.NullInt64
		var stage string
		var inSales sql.NullTime
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT sales_owner_id, lead_stage, sales_entered_at FROM crm_contacts WHERE id=$1`,
			id).Scan(&owner, &stage, &inSales); err != nil {
			respondErr(w, 404, "Lead not found")
			return
		}
		// The same gate the queue applies, enforced again at the write. Scoping a list
		// only controls what is offered; this endpoint takes an id from the caller, so
		// without the check a helpdesk contact could still be claimed by posting its id.
		if !inSales.Valid {
			respondErr(w, 404, "Lead not found")
			return
		}
		isHead := core.IsManagement(user.Role) || user.Role == "sales_head"
		if owner.Valid && owner.Int64 != user.ID && !isHead {
			respondErr(w, 409, "This lead is already owned by another officer")
			return
		}
		if _, err := db.PGExec(r.Context(), `
			UPDATE crm_contacts
			   SET sales_owner_id    = $2,
			       lead_stage       = CASE WHEN lead_stage IN ('new','contacted') THEN 'qualified' ELSE lead_stage END,
			       stage_changed_at = CASE WHEN lead_stage IN ('new','contacted') THEN NOW() ELSE stage_changed_at END,
			       last_activity_at = NOW(), updated_at = NOW()
			 WHERE id = $1`, id, user.ID); err != nil {
			respondErr(w, 500, "Could not claim the lead")
			return
		}
		db.PGExec(r.Context(), //nolint:errcheck
			`INSERT INTO crm_lead_events (contact_id, event, to_owner, note, created_by)
			 VALUES ($1,'claimed',$2,'Claimed from the call-centre hand-off',$2)`, id, user.ID)
		me := user.ID
		markForwardResolved(r.Context(), db, toInt64FromStr(id), "assigned", &me, "Claimed by "+user.FullName)
		respond(w, map[string]any{"ok": true, "owner_id": user.ID}, "pg")
	}
}

func updateLead(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		// Normalize a free-text product to a canonical sub-code before it is written.
		if pi, ok := body["product_interest"]; ok {
			if s, ok := pi.(string); ok {
				body["product_interest"] = NormalizeProductCode(s)
			}
		}
		allowed := []string{
			"first_name", "last_name", "phone", "email", "state", "city", "address",
			"occupation", "employer", "employer_id", "income_range", "lead_source",
			"sales_owner_id", "estimated_value_kobo", "next_action_at", "notes", "tags",
			"product_interest",
		}
		// REASSIGNMENT THROUGH THE GENERIC PATCH.
		//
		// sales_owner_id is in the allowlist above because the Leads page assigns through
		// this endpoint ("Reuses the lead PATCH — no bespoke endpoint needed"). But every
		// OTHER route that writes that column — transferLead, claimLead — gates it, and this
		// one gated nothing: no ownership test, no active-recipient test, no concurrency
		// guard, no crm_lead_events row. Any holder of the sales/crm/bd page could take a
		// lead off the officer working it, and the timeline would not record who did it.
		//
		// The guards below are transferLead's, in the same order and for the same reasons.
		// Deliberately NOT removing the field from the allowlist: that would break the live
		// assign control rather than secure it.
		if v, changing := body["sales_owner_id"]; changing {
			user := core.UserFromCtx(r.Context())
			if user == nil {
				respondErr(w, 401, "Sign in first")
				return
			}
			var owner sql.NullInt64
			var stage string
			var inSales sql.NullTime
			if err := db.PG.QueryRowContext(r.Context(),
				`SELECT sales_owner_id, lead_stage, sales_entered_at FROM crm_contacts WHERE id=$1`,
				chi.URLParam(r, "id")).Scan(&owner, &stage, &inSales); err != nil {
				respondErr(w, 404, "Lead not found")
				return
			}
			// A contact that never reached Sales is not a lead, whatever id is posted.
			if !inSales.Valid {
				respondErr(w, 404, "Lead not found")
				return
			}
			if !isOpenLeadStage(stage) {
				respondErr(w, 409, "This lead is closed — a converted or disqualified lead cannot be reassigned")
				return
			}
			isHead := core.IsManagement(user.Role) || isSalesHead(user)
			if !isHead && !(owner.Valid && owner.Int64 == user.ID) {
				respondErr(w, 403, "You can only reassign a lead you own")
				return
			}
			// Clearing the owner back to the unowned pool is legitimate; naming a recipient
			// who is not a real active user is not. Without this a typo'd id parks the lead
			// on nobody and it leaves every queue silently, because the unowned pool looks
			// for sales_owner_id IS NULL and this would not be NULL.
			if v != nil {
				var toID int64
				switch n := v.(type) {
				case float64:
					toID = int64(n)
				case int64:
					toID = n
				default:
					respondErr(w, 400, "sales_owner_id must be a user id or null")
					return
				}
				if toID != 0 {
					var recipient string
					if err := db.PG.QueryRowContext(r.Context(),
						`SELECT full_name FROM o3c_users WHERE id=$1 AND deleted_at IS NULL AND is_active`,
						toID).Scan(&recipient); err != nil {
						respondErr(w, 400, "That officer is not an active user")
						return
					}
				}
			}
		}

		sets, args := buildSet(body, allowed, 1)
		if len(sets) == 0 {
			respondErr(w, 400, "No updatable fields supplied")
			return
		}
		sets = append(sets, "updated_at = NOW()", "last_activity_at = NOW()")
		args = append(args, chi.URLParam(r, "id"))

		res, err := db.PGExec(r.Context(), fmt.Sprintf(
			`UPDATE crm_contacts SET %s WHERE id = $%d`,
			strings.Join(sets, ", "), len(args)), args...)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 404, "Lead not found")
			return
		}
		respond(w, map[string]any{"ok": true}, "pg")
	}
}

type stageReq struct {
	Stage string `json:"stage"`
	Note  string `json:"note"`
}

// moveLeadStage advances an open lead to any later stage in leadStageOrder, up to
// 'approved' (skipping ahead is allowed).
//
// It refuses to move backwards, refuses to move a converted or disqualified lead, and
// refuses to reach 'converted' or 'disqualified', which have their own endpoints
// because they do more than change a label.
// leadActivityStage names the activities that move a lead forward, and the stage each
// moves it to. Logging one of these on a lead that has not reached that stage is how the
// lead gets there (agreed 14 Sept 2026); the entry lands on the lead's activity timeline
// through the crm_lead_events trigger, titled from the kind ("Documents Requested").
var leadActivityStage = map[string]string{
	"interested":            "qualified",
	"handed_to_sales":       "handed_to_sales",
	"documents_requested":   "documents_requested",
	"application_submitted": "application_submitted",
	"approved":              "approved",
}

// leadActivityLabel is every kind that can be logged, forward-moving or record-only.
var leadActivityLabel = map[string]string{
	"interested": "Interested", "handed_to_sales": "Handed to sales",
	"documents_requested": "Documents requested", "application_submitted": "Application submitted",
	"approved": "Approved",
	"call": "Call", "meeting": "Meeting", "email": "Email", "note": "Note",
}

// leadStageShown is how a stored stage reads to people. 'qualified' is shown as
// Interested: only a lead who said they are interested reaches it.
var leadStageShown = map[string]string{
	"new": "New", "contacted": "Contacted", "qualified": "Interested",
	"handed_to_sales": "Handed to sales", "documents_requested": "Documents requested",
	"application_submitted": "Application submitted", "approved": "Approved",
	"converted": "Converted", "disqualified": "Disqualified",
}

// logLeadActivity records what happened on a lead. A forward kind moves the lead to its
// stage (forward only, owner rules as for moving a stage); a record-only kind — call,
// meeting, email, note — goes on the timeline and leaves the stage alone.
func logLeadActivity(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Kind string `json:"kind"`
			Note string `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		kind := strings.ToLower(strings.TrimSpace(req.Kind))
		label, known := leadActivityLabel[kind]
		if !known {
			respondErr(w, 400, "Unknown activity. Choose one of: interested, handed_to_sales, documents_requested, application_submitted, approved, call, meeting, email, note.")
			return
		}
		note := strings.TrimSpace(req.Note)
		if len([]rune(note)) > 2000 {
			respondErr(w, 422, "Keep the note to 2,000 characters or fewer.")
			return
		}

		var contactID int64
		var current string
		var owner sql.NullInt64
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT id, lead_stage, sales_owner_id FROM crm_contacts WHERE id = $1`, chi.URLParam(r, "id")).
			Scan(&contactID, &current, &owner); err != nil {
			respondErr(w, 404, "Lead not found")
			return
		}
		u := core.UserFromCtx(r.Context())
		if !canWorkLead(u, owner) {
			respondErr(w, 403, "You can only log activity on a lead you own")
			return
		}
		var actor sql.NullInt64
		if u != nil && u.ID != 0 {
			actor = sql.NullInt64{Int64: u.ID, Valid: true}
		}

		stage, moves := leadActivityStage[kind]
		if !moves {
			aid, aname, ateam := actorOf(u)
			cid := contactID
			id, err := LogActivity(r.Context(), db, Activity{
				ContactID: &cid, ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
				Type: kind, Subject: label, Body: note, Source: "manual",
				EntityType: "crm_contact", EntityID: fmt.Sprintf("%d", contactID),
			})
			if err != nil {
				respondErrLog(w, 500, "Could not log activity", err)
				return
			}
			db.PGExec(r.Context(), `UPDATE crm_contacts SET last_activity_at = NOW(), updated_at = NOW() WHERE id = $1`, contactID) //nolint:errcheck
			respond(w, map[string]any{"ok": true, "moved": false, "activity_id": id}, "pg")
			return
		}

		if current == "converted" {
			respondErr(w, 409, "This lead has already converted, so it cannot move to "+label+".")
			return
		}
		if !isOpenLeadStage(current) {
			respondErr(w, 409, fmt.Sprintf("A %s lead cannot move forward.", strings.ToLower(leadStageShown[current])))
			return
		}
		if leadStageOrder[stage] <= leadStageOrder[current] {
			respondErr(w, 409, fmt.Sprintf("This lead is already at %s, so it cannot move to %s.", leadStageShown[current], label))
			return
		}

		tx, err := db.PG.BeginTx(r.Context(), nil)
		if err != nil {
			respondErr(w, 500, "Could not start transaction")
			return
		}
		defer tx.Rollback() //nolint:errcheck
		if _, err := tx.ExecContext(r.Context(), `
			UPDATE crm_contacts
			   SET lead_stage = $2,
			       stage_changed_at = NOW(),
			       qualified_at = CASE WHEN qualified_at IS NULL THEN NOW() ELSE qualified_at END,
			       last_activity_at = NOW(),
			       updated_at = NOW()
			 WHERE id = $1`, contactID, stage); err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		// event carries the kind, so the timeline entry the trigger writes reads as what
		// happened ("Documents Requested") rather than a generic "Stage Change".
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			contactID, kind, current, stage, nullIfEmpty(note), actor); err != nil {
			respondErr(w, 500, "Could not record lead event")
			return
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}
		respond(w, map[string]any{"ok": true, "moved": true, "from": current, "to": stage}, "pg")
	}
}

func moveLeadStage(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req stageReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if !leadStages[req.Stage] {
			respondErr(w, 400, "Unknown stage")
			return
		}
		if req.Stage == "converted" {
			respondErr(w, 400, "Use /leads/{id}/convert instead. Conversion needs a CIF.")
			return
		}
		if req.Stage == "disqualified" {
			respondErr(w, 400, "Use /leads/{id}/disqualify instead. It needs a reason.")
			return
		}

		id := chi.URLParam(r, "id")
		var current string
		var owner sql.NullInt64
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT lead_stage, sales_owner_id FROM crm_contacts WHERE id=$1`, id).
			Scan(&current, &owner); err != nil {
			respondErr(w, 404, "Lead not found")
			return
		}
		if current == req.Stage {
			respond(w, map[string]any{"ok": true, "stage": current, "unchanged": true}, "pg")
			return
		}
		if current == "converted" {
			respondErr(w, 409, "This lead has already converted")
			return
		}
		if !isOpenLeadStage(current) {
			respondErr(w, 409, fmt.Sprintf("A %s lead cannot be advanced", current))
			return
		}
		if leadStageOrder[req.Stage] < leadStageOrder[current] {
			respondErr(w, 400, fmt.Sprintf("Cannot move a lead back from %s to %s", current, req.Stage))
			return
		}
		if u := core.UserFromCtx(r.Context()); !canWorkLead(u, owner) {
			respondErr(w, 403, "You can only advance a lead you own")
			return
		}

		var actor sql.NullInt64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			actor = sql.NullInt64{Int64: u.ID, Valid: true}
		}

		tx, err := db.PG.BeginTx(r.Context(), nil)
		if err != nil {
			respondErr(w, 500, "Could not start transaction")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		if _, err := tx.ExecContext(r.Context(), `
			UPDATE crm_contacts
			   SET lead_stage = $2,
			       stage_changed_at = NOW(),
			       qualified_at = CASE WHEN $3 AND qualified_at IS NULL
			                           THEN NOW() ELSE qualified_at END,
			       last_activity_at = NOW(),
			       updated_at = NOW()
			 WHERE id = $1`, id, req.Stage,
			// Skipping past qualified still means the lead was qualified.
			leadStageOrder[req.Stage] >= leadStageOrder["qualified"]); err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
			VALUES ($1,'stage_change',$2,$3,$4,$5)`,
			id, current, req.Stage, nullIfEmpty(req.Note), actor); err != nil {
			respondErr(w, 500, "Could not record lead event")
			return
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}
		respond(w, map[string]any{"ok": true, "from": current, "to": req.Stage}, "pg")
	}
}

type convertReq struct {
	// Line is the product the lead converted on: cards | loans | fixed_deposit.
	// Defaults to cards when omitted, so an older client that only sends `cif` keeps
	// working unchanged.
	Line string `json:"line"`
	// Ref is the identifier in that line's own namespace: a card CIF for cards, a Udara
	// account number for loans and fixed deposits. `cif` remains accepted as the alias
	// for the cards case.
	Ref  string `json:"ref"`
	CIF  string `json:"cif"`
	Note string `json:"note"`
}

// convertedProduct resolves and validates the {line, ref} a lead converted on, in that
// line's OWN namespace. The three references are not interchangeable — a card CIF, a
// Udara loan account and a Udara FD account are different keys over different books,
// and checking one against another returns a different person or nothing at all.
// Returns a human-readable reason when the reference does not resolve.
func convertedProduct(ctx context.Context, db *core.DB, line, ref string) (string, string, string) {
	line = strings.ToLower(strings.TrimSpace(line))
	ref = strings.TrimSpace(ref)
	if line == "" {
		line = LineCards
	}
	if ref == "" {
		return "", "", "A reference is required to convert a lead: the CIF for a card, or the Udara account number for a loan or fixed deposit."
	}

	var q, reason string
	switch line {
	case LineCards:
		q = `SELECT EXISTS (SELECT 1 FROM app.customers WHERE cif = $1)`
		reason = "No customer with that CIF. A card customer is created in the card system and arrives through the feed, so the CIF has to exist before the lead can be converted."
	case LineLoans:
		q = `SELECT EXISTS (SELECT 1 FROM app.cbs_loans WHERE cbs_account_number = $1)`
		reason = "No Udara loan with that account number. The loan has to be booked in Udara before the lead can be converted on it."
	case LineFixedDeposit:
		q = `SELECT EXISTS (SELECT 1 FROM app.cbs_fixed_deposits WHERE cbs_account_number = $1)`
		reason = "No Udara fixed deposit with that account number. The deposit has to be booked in Udara before the lead can be converted on it."
	default:
		return "", "", "Unknown product line. A lead converts on cards, loans or fixed_deposit."
	}

	var ok bool
	if err := db.PG.QueryRowContext(ctx, q, ref).Scan(&ok); err != nil || !ok {
		return "", "", reason
	}
	return line, ref, ""
}

// convertLead closes the loop between a lead and the customer book.
//
// A lead converts onto a PRODUCT LINE — cards, loans or fixed_deposit — carrying the
// reference that line uses. It used to demand a card CIF and nothing else, which meant
// a lead who took a salary loan or opened a fixed deposit could never be converted:
// no card, no CIF, no way to close a deal that had actually been won. The officer's
// only outs were to leave it open for ever or to borrow someone else's CIF. See
// migration 304.
//
// The reference is always checked against the book that owns it, never against a
// different one, because these keys are not interchangeable.
//
// On success the lead's owner becomes the customer's account officer, which is the
// whole point: the person who won the customer keeps them. That step is still keyed on
// CIF, since customer_officers is the CARD book — a loan or FD conversion records the
// sale and the party without inventing a card ownership row.
func convertLead(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req convertReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		// `cif` is the legacy alias for the cards reference; either field works.
		ref := strings.TrimSpace(req.Ref)
		if ref == "" {
			ref = strings.TrimSpace(req.CIF)
		}
		line, ref, reason := convertedProduct(r.Context(), db, req.Line, ref)
		if reason != "" {
			respondErr(w, 400, reason)
			return
		}
		// Only a cards conversion yields a CIF; the other two lines leave it empty so
		// nothing downstream mistakes a Udara account number for one.
		cif := ""
		if line == LineCards {
			cif = ref
		}

		id := chi.URLParam(r, "id")
		var current string
		var owner sql.NullInt64
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT lead_stage, sales_owner_id FROM crm_contacts WHERE id=$1`, id).
			Scan(&current, &owner); err != nil {
			respondErr(w, 404, "Lead not found")
			return
		}
		if current == "converted" {
			respondErr(w, 409, "This lead has already converted")
			return
		}
		if u := core.UserFromCtx(r.Context()); !canWorkLead(u, owner) {
			respondErr(w, 403, "You can only convert a lead you own")
			return
		}

		var actor sql.NullInt64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			actor = sql.NullInt64{Int64: u.ID, Valid: true}
		}

		tx, err := db.PG.BeginTx(r.Context(), nil)
		if err != nil {
			respondErr(w, 500, "Could not start transaction")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// converted_cif and cif_number take the CARDS reference only — empty for a loan
		// or FD. Writing a Udara account number into a column every other module reads as
		// a card CIF would quietly corrupt the card book with keys from another namespace.
		if _, err := tx.ExecContext(r.Context(), `
			UPDATE crm_contacts
			   SET lead_stage = 'converted', status = 'customer',
			       stage_changed_at = NOW(),
			       converted_at = NOW(),
			       converted_line = $2, converted_ref = $3,
			       converted_cif = NULLIF($4,''),
			       cif_number = COALESCE(NULLIF(cif_number,''), NULLIF($4,'')),
			       account_manager_id = COALESCE(account_manager_id, sales_owner_id),
			       last_activity_at = NOW(), updated_at = NOW()
			 WHERE id = $1`, id, line, ref, cif); err != nil {
			respondErrLog(w, 500, "Conversion failed", err)
			return
		}

		// Pin the converted customer to a party. This is the identity that survives them
		// taking a second product on a different line later — the reference above only
		// identifies them within the book that product lives in.
		if _, err := tx.ExecContext(r.Context(),
			`SELECT app.ensure_lead_party($1)`, id); err != nil {
			respondErrLog(w, 500, "Could not link the customer to a party", err)
			return
		}

		// The lead's owner inherits the customer — but never overwrite an existing
		// assignment, which a head may have set deliberately.
		//
		// Cards only: customer_officers is keyed by CIF and IS the card book. A loan or
		// FD conversion has no CIF, and manufacturing one from a Udara account number
		// would put a row in the card book for a customer who holds no card.
		var assignedOfficer any
		if owner.Valid && cif != "" {
			var prev sql.NullInt64
			_ = tx.QueryRowContext(r.Context(),
				`SELECT officer_id FROM customer_officers WHERE cif=$1`, cif).Scan(&prev)
			if !prev.Valid {
				if _, err := tx.ExecContext(r.Context(), `
					INSERT INTO customer_officers (cif, officer_id, assigned_by, source, note)
					VALUES ($1,$2,$3,'converted','Inherited from the lead this officer converted')
					ON CONFLICT (cif) DO NOTHING`, cif, owner.Int64, actor); err != nil {
					respondErr(w, 500, "Could not assign account officer")
					return
				}
				if _, err := tx.ExecContext(r.Context(), `
					INSERT INTO customer_officer_history (cif, to_officer_id, changed_by, reason)
					VALUES ($1,$2,$3,'Lead conversion')`, cif, owner.Int64, actor); err != nil {
					respondErr(w, 500, "History write failed")
					return
				}
				assignedOfficer = owner.Int64
			}
		}

		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
			VALUES ($1,'converted',$2,'converted',$3,$4)`,
			id, current, nullIfEmpty(req.Note), actor); err != nil {
			respondErr(w, 500, "Could not record lead event")
			return
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		// If this lead reached Sales via a call-centre hand-off, close the loop so the
		// agent who forwarded it sees it converted.
		{
			var own *int64
			if actor.Valid {
				v := actor.Int64
				own = &v
			}
			// Names the line as well as the reference, so the agent who forwarded the
			// lead sees "converted on a salary loan", not a bare account number they
			// would reasonably read as a CIF.
			markForwardResolved(r.Context(), db, toInt64FromStr(id), "converted", own,
				"Converted on "+ProductLineLabel(line)+" "+ref)
		}

		respond(w, map[string]any{
			"ok": true, "line": line, "ref": ref, "cif": cif,
			"assigned_officer_id": assignedOfficer,
		}, "pg")
	}
}

type disqualifyReq struct {
	Reason string `json:"reason"`
}

func disqualifyLead(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req disqualifyReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(req.Reason) == "" {
			respondErr(w, 400, "A reason is required to disqualify a lead")
			return
		}

		id := chi.URLParam(r, "id")
		var current string
		var owner sql.NullInt64
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT lead_stage, sales_owner_id FROM crm_contacts WHERE id=$1`, id).Scan(&current, &owner); err != nil {
			respondErr(w, 404, "Lead not found")
			return
		}
		if current == "converted" {
			respondErr(w, 409, "A converted lead cannot be disqualified")
			return
		}
		if u := core.UserFromCtx(r.Context()); !canWorkLead(u, owner) {
			respondErr(w, 403, "You can only disqualify a lead you own")
			return
		}

		var actor sql.NullInt64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			actor = sql.NullInt64{Int64: u.ID, Valid: true}
		}

		tx, err := db.PG.BeginTx(r.Context(), nil)
		if err != nil {
			respondErr(w, 500, "Could not start transaction")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		if _, err := tx.ExecContext(r.Context(), `
			UPDATE crm_contacts
			   SET lead_stage = 'disqualified', disqualified_at = NOW(),
			       stage_changed_at = CASE WHEN lead_stage <> 'disqualified' THEN NOW() ELSE stage_changed_at END,
			       disqualify_reason = $2, next_action_at = NULL,
			       last_activity_at = NOW(), updated_at = NOW()
			 WHERE id = $1`, id, req.Reason); err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
			VALUES ($1,'stage_change',$2,'disqualified',$3,$4)`,
			id, current, req.Reason, actor); err != nil {
			respondErr(w, 500, "Could not record lead event")
			return
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}
		// Reflect a rejection back to the call-centre hand-off tracker.
		markForwardResolved(r.Context(), db, toInt64FromStr(id), "rejected", nil, req.Reason)
		respond(w, map[string]any{"ok": true, "from": current, "to": "disqualified"}, "pg")
	}
}

func leadEvents(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT e.id, e.event, e.from_stage, e.to_stage, e.note, e.created_at,
			       e.from_owner, e.to_owner,
			       fu.full_name AS from_owner_name,
			       tu.full_name AS to_owner_name,
			       cb.full_name AS created_by_name
			  FROM crm_lead_events e
			  LEFT JOIN o3c_users fu ON fu.id = e.from_owner
			  LEFT JOIN o3c_users tu ON tu.id = e.to_owner
			  LEFT JOIN o3c_users cb ON cb.id = e.created_by
			 WHERE e.contact_id = $1
			 ORDER BY e.created_at DESC`, chi.URLParam(r, "id"))
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, rows, "pg")
	}
}

// leadIDFromPath is a small guard used by the application-submission flow to confirm a
// path parameter really is a number before it reaches a query.
func leadIDFromPath(r *http.Request) (int64, error) {
	return strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
}
