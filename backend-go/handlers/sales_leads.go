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

// Lead capture and lifecycle.
//
// Leads reach Sales from Business Development, from campaigns, from the call centre,
// and from officers profiling a walk-in or referral themselves. They live in
// crm_contacts and move new → contacted → qualified → converted, or leave via
// disqualified. Every move is recorded in crm_lead_events, so "how long did this sit in
// Qualified?" and "who had it before me?" are answerable.
//
// Conversion is the hinge between this file and sales_book.go: when a lead becomes a
// customer, the officer who worked it becomes that customer's account officer.

// leadStages is the permitted set, matching the CHECK constraint in migration 128.
var leadStages = map[string]bool{
	"new": true, "contacted": true, "qualified": true,
	"converted": true, "disqualified": true,
}

// leadStageOrder gates forward movement. Conversion and disqualification are handled by
// their own endpoints, which do more than move a stage.
var leadStageOrder = map[string]int{
	"new": 0, "contacted": 1, "qualified": 2, "converted": 3, "disqualified": 3,
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
	r.With(access).Post("/leads/{id}/convert", convertLead(db))
	r.With(access).Post("/leads/{id}/disqualify", disqualifyLead(db))
	r.With(access).Get("/leads/{id}/events", leadEvents(db))

	// Bulk distribution of the unowned lead pool. Head-only (enforced in-handler,
	// like the book's assign routes). Static path — no conflict with /leads/{id}.
	r.With(access).Post("/leads/distribute", distributeLeads(db))
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
//   - It only ever touches leads with no owner (lead_owner_id IS NULL). Re-running
//     never reshuffles work an officer has already started — it just picks up
//     whatever is still unassigned.
//   - The whole batch is one transaction. A half-applied distribution would leave
//     the book in a state nobody chose.
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
		q := `SELECT id, COALESCE(NULLIF(TRIM(state),''),'—') AS state
		        FROM crm_contacts
		       WHERE lead_owner_id IS NULL AND status = 'lead'`
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
			// The lead_owner_id IS NULL guard in the WHERE clause makes this a no-op
			// on anything a concurrent request grabbed first — re-running is safe.
			if _, err := tx.ExecContext(r.Context(), `
				UPDATE crm_contacts
				   SET lead_owner_id = $1,
				       assigned_to   = COALESCE(assigned_to, $1),
				       updated_at    = NOW()
				 WHERE id = ANY($2) AND lead_owner_id IS NULL`, id, ids); err != nil {
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

		if isSalesHead(user) {
			switch q := qstr(r, "owner_id"); q {
			case "":
			case "unassigned":
				where = append(where, "c.lead_owner_id IS NULL")
			default:
				id, err := parseUserID(q)
				if err != nil {
					respondErr(w, 400, "owner_id must be a number, 'unassigned', or omitted")
					return
				}
				where = append(where, fmt.Sprintf("c.lead_owner_id = $%d", n))
				args = append(args, id)
				n++
			}
		} else {
			// An officer sees leads they own plus anything unclaimed, so a new lead is
			// visible to the team rather than invisible until someone assigns it.
			where = append(where, fmt.Sprintf("(c.lead_owner_id = $%d OR c.lead_owner_id IS NULL)", n))
			args = append(args, user.ID)
			n++
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
			       c.lead_owner_id, c.estimated_value_kobo,
			       c.next_action_at, c.last_activity_at,
			       c.qualified_at, c.created_at, c.updated_at,
			       u.full_name AS owner_name,
			       e.name      AS employer_name
			  FROM crm_contacts c
			  LEFT JOIN o3c_users u ON u.id = c.lead_owner_id
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
		scope, args := "TRUE", []any{}
		if !isSalesHead(user) {
			scope = "c.lead_owner_id = $1"
			args = append(args, user.ID)
		} else if q := qstr(r, "owner_id"); q != "" && q != "unassigned" {
			id, err := parseUserID(q)
			if err != nil {
				respondErr(w, 400, "owner_id must be a number, 'unassigned', or omitted")
				return
			}
			scope = "c.lead_owner_id = $1"
			args = append(args, id)
		} else if q == "unassigned" {
			scope = "c.lead_owner_id IS NULL"
		}

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
	OwnerID      *int64 `json:"lead_owner_id"`
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
			respondErr(w, 400, "lead_source is required — origination cannot be credited without it")
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

		var id int64
		err = tx.QueryRowContext(r.Context(), `
			INSERT INTO crm_contacts (
			    first_name, last_name, phone, email, state, city, address,
			    occupation, employer, employer_id, income_range,
			    status, lead_stage, lead_source, source, source_type,
			    lead_owner_id, assigned_to, estimated_value_kobo, next_action_at,
			    product_interest, notes, created_by, last_activity_at, created_at, updated_at
			) VALUES (
			    $1,$2,$3,$4,$5,$6,$7,
			    $8,$9,$10,$11,
			    'lead','new',$12,'workspace','manual',
			    $13,$13,$14,NULLIF($15,'')::timestamptz,
			    $16,$17,$18,NOW(),NOW(),NOW()
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

func getLead(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT c.*, u.full_name AS owner_name, e.name AS employer_name,
			       cb.full_name AS created_by_name
			  FROM crm_contacts c
			  LEFT JOIN o3c_users u  ON u.id  = c.lead_owner_id
			  LEFT JOIN o3c_users cb ON cb.id = c.created_by
			  LEFT JOIN employers e  ON e.id  = c.employer_id
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
			"lead_owner_id", "estimated_value_kobo", "next_action_at", "notes", "tags",
			"product_interest",
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

// moveLeadStage advances a lead through new → contacted → qualified.
//
// It refuses to move backwards and refuses to reach 'converted' or 'disqualified',
// which have their own endpoints because they do more than change a label.
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
			respondErr(w, 400, "Use /leads/{id}/convert — conversion needs a CIF")
			return
		}
		if req.Stage == "disqualified" {
			respondErr(w, 400, "Use /leads/{id}/disqualify — a reason is required")
			return
		}

		id := chi.URLParam(r, "id")
		var current string
		var owner sql.NullInt64
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT lead_stage, lead_owner_id FROM crm_contacts WHERE id=$1`, id).
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
		if leadStageOrder[req.Stage] < leadStageOrder[current] {
			respondErr(w, 400, fmt.Sprintf("Cannot move a lead back from %s to %s", current, req.Stage))
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
			       qualified_at = CASE WHEN $2 = 'qualified' AND qualified_at IS NULL
			                           THEN NOW() ELSE qualified_at END,
			       last_activity_at = NOW(),
			       updated_at = NOW()
			 WHERE id = $1`, id, req.Stage); err != nil {
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
	CIF  string `json:"cif"`
	Note string `json:"note"`
}

// convertLead closes the loop between a lead and the customer book.
//
// The CIF must already exist in app.customers — customers are created in the card
// system and arrive through the cust_file feed, not here. Requiring a real CIF is what
// stops the book filling with conversions that point at nothing.
//
// On success the lead's owner becomes the customer's account officer, which is the
// whole point: the person who won the customer keeps them.
func convertLead(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req convertReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		req.CIF = strings.TrimSpace(req.CIF)
		if req.CIF == "" {
			respondErr(w, 400, "cif is required to convert a lead")
			return
		}

		var exists bool
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM app.customers WHERE cif=$1)`, req.CIF).Scan(&exists); err != nil {
			respondErr(w, 500, "Lookup failed")
			return
		}
		if !exists {
			respondErr(w, 400,
				"No customer with that CIF yet. The customer must exist in the card system "+
					"and arrive through the feed before the lead can be converted.")
			return
		}

		id := chi.URLParam(r, "id")
		var current string
		var owner sql.NullInt64
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT lead_stage, lead_owner_id FROM crm_contacts WHERE id=$1`, id).
			Scan(&current, &owner); err != nil {
			respondErr(w, 404, "Lead not found")
			return
		}
		if current == "converted" {
			respondErr(w, 409, "This lead has already converted")
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
			   SET lead_stage = 'converted', status = 'customer',
			       converted_at = NOW(), converted_cif = $2,
			       cif_number = COALESCE(NULLIF(cif_number,''), $2),
			       account_manager_id = COALESCE(account_manager_id, lead_owner_id),
			       last_activity_at = NOW(), updated_at = NOW()
			 WHERE id = $1`, id, req.CIF); err != nil {
			respondErr(w, 500, "Conversion failed")
			return
		}

		// The lead's owner inherits the customer — but never overwrite an existing
		// assignment, which a head may have set deliberately.
		var assignedOfficer any
		if owner.Valid {
			var prev sql.NullInt64
			_ = tx.QueryRowContext(r.Context(),
				`SELECT officer_id FROM customer_officers WHERE cif=$1`, req.CIF).Scan(&prev)
			if !prev.Valid {
				if _, err := tx.ExecContext(r.Context(), `
					INSERT INTO customer_officers (cif, officer_id, assigned_by, source, note)
					VALUES ($1,$2,$3,'converted','Inherited from the lead this officer converted')
					ON CONFLICT (cif) DO NOTHING`, req.CIF, owner.Int64, actor); err != nil {
					respondErr(w, 500, "Could not assign account officer")
					return
				}
				if _, err := tx.ExecContext(r.Context(), `
					INSERT INTO customer_officer_history (cif, to_officer_id, changed_by, reason)
					VALUES ($1,$2,$3,'Lead conversion')`, req.CIF, owner.Int64, actor); err != nil {
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

		respond(w, map[string]any{
			"ok": true, "cif": req.CIF, "assigned_officer_id": assignedOfficer,
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
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT lead_stage FROM crm_contacts WHERE id=$1`, id).Scan(&current); err != nil {
			respondErr(w, 404, "Lead not found")
			return
		}
		if current == "converted" {
			respondErr(w, 409, "A converted lead cannot be disqualified")
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
