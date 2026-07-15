package handlers

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterSOC2 adds SOC 2, policy, and pentest routes to the compliance router.
func RegisterSOC2(r chi.Router, db *core.DB) {
	all := core.RequirePages("compliance_all", "compliance_head")

	// SOC 2 overview + controls
	r.With(all).Get("/soc2/overview",             soc2Overview(db))
	r.With(all).Get("/soc2/controls",             soc2ControlList(db))
	r.With(all).Get("/soc2/controls/{id}",        soc2ControlGet(db))
	r.With(all).Patch("/soc2/controls/{id}",      soc2ControlUpdate(db))
	r.With(all).Post("/soc2/controls",            soc2ControlCreate(db))
	r.With(all).Get("/soc2/export",               soc2Export(db))

	// Evidence
	r.With(all).Post("/soc2/controls/{id}/evidence", soc2EvidenceAdd(db))
	r.With(all).Delete("/soc2/evidence/{eid}",        soc2EvidenceDelete(db))

	// Policy documents
	r.With(all).Get("/soc2/policies",          soc2PolicyList(db))
	r.With(all).Post("/soc2/policies",         soc2CreatePolicy(db))
	r.With(all).Patch("/soc2/policies/{id}",   soc2PolicyUpdate(db))

	// Pentest engagements
	r.With(all).Get("/pentests",       pentestList(db))
	r.With(all).Post("/pentests",      pentestCreate(db))
	r.With(all).Get("/pentests/{id}",  pentestGet(db))
	r.With(all).Patch("/pentests/{id}", pentestUpdate(db))

	// Pentest findings
	r.With(all).Get("/pentest-findings",              pentestFindingListAll(db))
	r.With(all).Post("/pentests/{id}/findings",       pentestFindingCreate(db))
	r.With(all).Patch("/pentest-findings/{fid}",      pentestFindingUpdate(db))
	r.With(all).Delete("/pentest-findings/{fid}",     pentestFindingDelete(db))
}

// ── SOC 2 overview ────────────────────────────────────────────────────────────

func soc2Overview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  trust_criteria,
			  COUNT(*)                                              AS total,
			  COUNT(*) FILTER (WHERE status='complete')            AS done,
			  COUNT(*) FILTER (WHERE status='in_progress')         AS in_progress,
			  COUNT(*) FILTER (WHERE status='not_started')         AS not_started,
			  COUNT(*) FILTER (WHERE status='waived')              AS waived
			FROM soc2_controls
			GROUP BY trust_criteria
			ORDER BY trust_criteria`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		// Totals
		totals, _ := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*)                                              AS total,
			  COUNT(*) FILTER (WHERE status='complete')            AS done,
			  COUNT(*) FILTER (WHERE status='in_progress')         AS in_progress,
			  COUNT(*) FILTER (WHERE status='not_started')         AS not_started,
			  COUNT(*) FILTER (WHERE status='waived')              AS waived
			FROM soc2_controls`)
		// Policy stats
		policyRows, _ := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*)                                              AS total,
			  COUNT(*) FILTER (WHERE status='approved')            AS approved,
			  COUNT(*) FILTER (WHERE status NOT IN ('approved','waived')) AS pending
			FROM soc2_policy_documents`)
		// Pentest open findings
		findingRows, _ := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*) FILTER (WHERE status='open' AND severity='critical') AS open_critical,
			  COUNT(*) FILTER (WHERE status='open' AND severity='high')     AS open_high,
			  COUNT(*) FILTER (WHERE status='open' AND sla_deadline < CURRENT_DATE AND status!='resolved') AS overdue
			FROM pentest_findings`)
		respond(w, map[string]any{
			"by_criteria": rows,
			"totals":      first(totals),
			"policies":    first(policyRows),
			"findings":    first(findingRows),
		}, "supabase")
	}
}

func first(rows []map[string]any) map[string]any {
	if len(rows) > 0 {
		return rows[0]
	}
	return map[string]any{}
}

// ── SOC 2 controls ────────────────────────────────────────────────────────────

func soc2ControlList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		criteria := qstr(r, "criteria")

		where := " WHERE 1=1"
		args := []any{}
		n := 1
		if status != "" {
			where += fmt.Sprintf(" AND c.status=$%d", n)
			args = append(args, status)
			n++
		}
		if criteria != "" {
			where += fmt.Sprintf(" AND c.trust_criteria=$%d", n)
			args = append(args, criteria)
			n++
		}

		rows, err := db.PGQuery(r.Context(), `
			SELECT c.*,
			  u.full_name AS owner_name,
			  COALESCE(ev.ev_count, 0) AS evidence_count
			FROM soc2_controls c
			LEFT JOIN o3c_users u ON c.owner_id = u.id
			LEFT JOIN (
			  SELECT control_id, COUNT(*) AS ev_count FROM soc2_evidence GROUP BY control_id
			) ev ON ev.control_id = c.id`+where+` ORDER BY c.sort_order`, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, rows, "supabase")
	}
}

func soc2ControlGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT c.*, u.full_name AS owner_name
			FROM soc2_controls c
			LEFT JOIN o3c_users u ON c.owner_id = u.id
			WHERE c.id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Control not found")
			return
		}
		evidence, _ := db.PGQuery(r.Context(), `
			SELECT e.*, u.full_name AS collected_by_name
			FROM soc2_evidence e
			LEFT JOIN o3c_users u ON e.collected_by = u.id
			WHERE e.control_id=$1
			ORDER BY e.created_at DESC`, id)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"control":  rows[0],
			"evidence": evidence,
		})
	}
}

func soc2ControlUpdate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b struct {
			Status          *string `json:"status"`
			OwnerID         *int64  `json:"owner_id"`
			TargetDate      *string `json:"target_date"`
			EvidenceSummary *string `json:"evidence_summary"`
			WaiverReason    *string `json:"waiver_reason"`
			Notes           *string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		sets := " updated_at=NOW()"
		args := []any{}
		n := 1
		if b.Status != nil {
			sets += fmt.Sprintf(", status=$%d", n)
			args = append(args, *b.Status)
			n++
			if *b.Status == "complete" {
				sets += fmt.Sprintf(", completed_at=NOW()")
			}
		}
		if b.OwnerID != nil {
			sets += fmt.Sprintf(", owner_id=$%d", n)
			args = append(args, *b.OwnerID)
			n++
		}
		if b.TargetDate != nil {
			sets += fmt.Sprintf(", target_date=$%d", n)
			args = append(args, *b.TargetDate)
			n++
		}
		if b.EvidenceSummary != nil {
			sets += fmt.Sprintf(", evidence_summary=$%d", n)
			args = append(args, *b.EvidenceSummary)
			n++
		}
		if b.WaiverReason != nil {
			sets += fmt.Sprintf(", waiver_reason=$%d", n)
			args = append(args, *b.WaiverReason)
			n++
		}
		// M3: notes was in the struct but missing from the SET clause — fixed.
		if b.Notes != nil {
			sets += fmt.Sprintf(", notes=$%d", n)
			args = append(args, *b.Notes)
			n++
		}
		// H4: require at least one evidence item before marking a control as implemented.
		if b.Status != nil && *b.Status == "implemented" {
			var evidenceCount int
			db.PG.QueryRowContext(r.Context(),
				`SELECT COUNT(*) FROM soc2_evidence WHERE control_id=$1`, id).Scan(&evidenceCount) //nolint:errcheck
			if evidenceCount == 0 {
				respondErr(w, 422, "At least one evidence item is required before marking a control as implemented")
				return
			}
		}
		args = append(args, id)
		_, err := db.PGExec(r.Context(),
			fmt.Sprintf("UPDATE soc2_controls SET%s WHERE id=$%d", sets, n), args...)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		rows, _ := db.PGQuery(r.Context(), `
			SELECT c.*, u.full_name AS owner_name
			FROM soc2_controls c LEFT JOIN o3c_users u ON c.owner_id=u.id WHERE c.id=$1`, id)
		if len(rows) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func soc2ControlCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			CriteriaCode    string `json:"criteria_code"`
			CriteriaGroup   string `json:"criteria_group"`
			TrustCriteria   string `json:"trust_criteria"`
			Title           string `json:"title"`
			Description     string `json:"description"`
			ControlType     string `json:"control_type"`
			Frequency       string `json:"frequency"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Title == "" || b.CriteriaCode == "" {
			respondErr(w, 422, "criteria_code and title are required")
			return
		}
		if b.ControlType == "" { b.ControlType = "preventive" }
		if b.Frequency == "" { b.Frequency = "continuous" }
		if b.TrustCriteria == "" { b.TrustCriteria = "security" }
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO soc2_controls
			  (criteria_code, criteria_group, trust_criteria, title, description, control_type, frequency, is_standard, sort_order)
			VALUES ($1,$2,$3,$4,$5,$6,$7,false,(SELECT COALESCE(MAX(sort_order),0)+10 FROM soc2_controls))
			RETURNING *`,
			b.CriteriaCode, b.CriteriaGroup, b.TrustCriteria, b.Title, b.Description, b.ControlType, b.Frequency)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func soc2Export(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT c.criteria_code, c.criteria_group, c.trust_criteria, c.title,
			  c.status, c.control_type, c.frequency,
			  u.full_name AS owner,
			  c.target_date::text, c.completed_at::text,
			  c.evidence_summary,
			  COALESCE(ev.ev_count,0)::text AS evidence_count
			FROM soc2_controls c
			LEFT JOIN o3c_users u ON c.owner_id=u.id
			LEFT JOIN (SELECT control_id, COUNT(*) AS ev_count FROM soc2_evidence GROUP BY control_id) ev ON ev.control_id=c.id
			ORDER BY c.sort_order`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		w.Header().Set("Content-Type", "text/csv")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="soc2-controls-%s.csv"`, time.Now().Format("2006-01-02")))
		cw := csv.NewWriter(w)
		cw.Write([]string{"Code", "Group", "Criteria", "Title", "Status", "Type", "Frequency", "Owner", "Target Date", "Completed", "Evidence Summary", "Evidence Count"}) //nolint:errcheck
		for _, row := range rows {
			cw.Write([]string{ //nolint:errcheck
				fmt.Sprint(row["criteria_code"]), fmt.Sprint(row["criteria_group"]),
				fmt.Sprint(row["trust_criteria"]), fmt.Sprint(row["title"]),
				fmt.Sprint(row["status"]), fmt.Sprint(row["control_type"]),
				fmt.Sprint(row["frequency"]), fmt.Sprint(row["owner"]),
				fmt.Sprint(row["target_date"]), fmt.Sprint(row["completed_at"]),
				fmt.Sprint(row["evidence_summary"]), fmt.Sprint(row["evidence_count"]),
			})
		}
		cw.Flush()
	}
}

// ── Evidence ──────────────────────────────────────────────────────────────────

func soc2EvidenceAdd(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		var b struct {
			Title         string  `json:"title"`
			EvidenceType  string  `json:"evidence_type"`
			Description   string  `json:"description"`
			FileURL       string  `json:"file_url"`
			CodeReference string  `json:"code_reference"`
			ValidFrom     *string `json:"valid_from"`
			ValidTo       *string `json:"valid_to"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Title == "" {
			respondErr(w, 422, "title is required")
			return
		}
		if b.EvidenceType == "" { b.EvidenceType = "note" }
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO soc2_evidence
			  (control_id, title, evidence_type, description, file_url, code_reference, collected_by, valid_from, valid_to)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
			id, b.Title, b.EvidenceType,
			nullIfBlank(b.Description), nullIfBlank(b.FileURL), nullIfBlank(b.CodeReference),
			user.ID, nilIfEmpty(b.ValidFrom), nilIfEmpty(b.ValidTo))
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		// Bump control updated_at so list refreshes
		db.PGExec(r.Context(), "UPDATE soc2_controls SET updated_at=NOW() WHERE id=$1", id) //nolint:errcheck
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func nilIfEmpty(s *string) interface{} {
	if s == nil || *s == "" {
		return nil
	}
	return *s
}

func nullIfBlank(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func soc2EvidenceDelete(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		eid := chi.URLParam(r, "eid")
		// Get control_id before deleting so we can bump updated_at
		rows, _ := db.PGQuery(r.Context(), "SELECT control_id FROM soc2_evidence WHERE id=$1", eid)
		if len(rows) == 0 {
			respondErr(w, 404, "Evidence not found")
			return
		}
		db.PGExec(r.Context(), "DELETE FROM soc2_evidence WHERE id=$1", eid)            //nolint:errcheck
		db.PGExec(r.Context(), "UPDATE soc2_controls SET updated_at=NOW() WHERE id=$1", //nolint:errcheck
			rows[0]["control_id"])
		w.WriteHeader(204)
	}
}

// ── Policy documents ──────────────────────────────────────────────────────────

func soc2PolicyList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT p.*,
			  u.full_name   AS owner_name,
			  a.full_name   AS approved_by_name
			FROM soc2_policy_documents p
			LEFT JOIN o3c_users u ON p.owner_id = u.id
			LEFT JOIN o3c_users a ON p.approved_by = a.id
			ORDER BY p.sort_order`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, rows, "supabase")
	}
}

func soc2PolicyUpdate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		var b struct {
			Status         *string `json:"status"`
			OwnerID        *int64  `json:"owner_id"`
			NextReviewDate *string `json:"next_review_date"`
			DocumentURL    *string `json:"document_url"`
			Version        *string `json:"version"`
			Notes          *string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		sets := " updated_at=NOW()"
		args := []any{}
		n := 1
		if b.Status != nil {
			// H3: policy owner cannot approve their own policy.
			if *b.Status == "approved" {
				var ownerID int64
				db.PG.QueryRowContext(r.Context(), //nolint:errcheck
					`SELECT owner_id FROM soc2_policy_documents WHERE id=$1`, id).Scan(&ownerID)
				if ownerID == user.ID {
					respondErr(w, 422, "Policy owner cannot approve their own policy")
					return
				}
			}
			sets += fmt.Sprintf(", status=$%d", n)
			args = append(args, *b.Status)
			n++
			if *b.Status == "approved" {
				sets += fmt.Sprintf(", approved_by=$%d, approved_at=NOW()", n)
				args = append(args, user.ID)
				n++
			}
		}
		if b.OwnerID != nil   { sets += fmt.Sprintf(", owner_id=$%d", n);        args = append(args, *b.OwnerID);        n++ }
		if b.NextReviewDate != nil { sets += fmt.Sprintf(", next_review_date=$%d", n); args = append(args, *b.NextReviewDate); n++ }
		if b.DocumentURL != nil { sets += fmt.Sprintf(", document_url=$%d", n);  args = append(args, *b.DocumentURL);  n++ }
		if b.Version != nil   { sets += fmt.Sprintf(", version=$%d", n);          args = append(args, *b.Version);        n++ }
		if b.Notes != nil     { sets += fmt.Sprintf(", notes=$%d", n);            args = append(args, *b.Notes);          n++ }
		args = append(args, id)
		if _, err := db.PGExec(r.Context(),
			fmt.Sprintf("UPDATE soc2_policy_documents SET%s WHERE id=$%d", sets, n), args...); err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		rows, _ := db.PGQuery(r.Context(), `
			SELECT p.*, u.full_name AS owner_name, a.full_name AS approved_by_name
			FROM soc2_policy_documents p
			LEFT JOIN o3c_users u ON p.owner_id=u.id
			LEFT JOIN o3c_users a ON p.approved_by=a.id
			WHERE p.id=$1`, id)
		if len(rows) == 0 { respondErr(w, 404, "Not found"); return }
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

// ── Pentest engagements ───────────────────────────────────────────────────────

func pentestList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT e.*,
			  u.full_name AS created_by_name,
			  COUNT(f.id)                                                   AS total_findings,
			  COUNT(f.id) FILTER (WHERE f.severity='critical')             AS critical,
			  COUNT(f.id) FILTER (WHERE f.severity='high')                 AS high,
			  COUNT(f.id) FILTER (WHERE f.severity='medium')               AS medium,
			  COUNT(f.id) FILTER (WHERE f.severity='low')                  AS low,
			  COUNT(f.id) FILTER (WHERE f.status='open')                   AS open_findings,
			  COUNT(f.id) FILTER (WHERE f.status='resolved')               AS resolved_findings
			FROM pentest_engagements e
			LEFT JOIN o3c_users u    ON e.created_by = u.id
			LEFT JOIN pentest_findings f ON f.engagement_id = e.id
			GROUP BY e.id, u.full_name
			ORDER BY e.created_at DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, rows, "supabase")
	}
}

func pentestCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		var b struct {
			Title              string  `json:"title"`
			VendorName         string  `json:"vendor_name"`
			EngagementType     string  `json:"engagement_type"`
			StartDate          *string `json:"start_date"`
			EndDate            *string `json:"end_date"`
			ScopeNotes         string  `json:"scope_notes"`
			RulesOfEngagement  string  `json:"rules_of_engagement"`
			EngagementCostKobo *int64  `json:"engagement_cost_kobo"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Title == "" || b.VendorName == "" {
			respondErr(w, 422, "title and vendor_name are required")
			return
		}
		if b.EngagementType == "" { b.EngagementType = "external_blackbox" }
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO pentest_engagements
			  (title, vendor_name, engagement_type, start_date, end_date, scope_notes, rules_of_engagement, engagement_cost_kobo, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
			b.Title, b.VendorName, b.EngagementType, b.StartDate, b.EndDate,
			nullIfBlank(b.ScopeNotes), nullIfBlank(b.RulesOfEngagement),
			b.EngagementCostKobo, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func pentestGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT e.*, u.full_name AS created_by_name
			FROM pentest_engagements e
			LEFT JOIN o3c_users u ON e.created_by=u.id
			WHERE e.id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Engagement not found")
			return
		}
		findings, _ := db.PGQuery(r.Context(), `
			SELECT f.*, u.full_name AS assigned_to_name
			FROM pentest_findings f
			LEFT JOIN o3c_users u ON f.assigned_to=u.id
			WHERE f.engagement_id=$1
			ORDER BY
			  CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
			  f.created_at`, id)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"engagement": rows[0],
			"findings":   findings,
		})
	}
}

func pentestUpdate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b struct {
			Status             *string `json:"status"`
			ReportURL          *string `json:"report_url"`
			ReportReceivedAt   *string `json:"report_received_at"`
			RetestDeadline     *string `json:"retest_deadline"`
			RetestCompletedAt  *string `json:"retest_completed_at"`
			ScopeNotes         *string `json:"scope_notes"`
			RulesOfEngagement  *string `json:"rules_of_engagement"`
			StartDate          *string `json:"start_date"`
			EndDate            *string `json:"end_date"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		sets := " updated_at=NOW()"
		args := []any{}
		n := 1
		patch := func(field string, val *string) {
			if val != nil { sets += fmt.Sprintf(", %s=$%d", field, n); args = append(args, *val); n++ }
		}
		if b.Status != nil { sets += fmt.Sprintf(", status=$%d", n); args = append(args, *b.Status); n++ }
		patch("report_url", b.ReportURL)
		patch("report_received_at", b.ReportReceivedAt)
		patch("retest_deadline", b.RetestDeadline)
		patch("retest_completed_at", b.RetestCompletedAt)
		patch("scope_notes", b.ScopeNotes)
		patch("rules_of_engagement", b.RulesOfEngagement)
		patch("start_date", b.StartDate)
		patch("end_date", b.EndDate)
		args = append(args, id)
		if _, err := db.PGExec(r.Context(),
			fmt.Sprintf("UPDATE pentest_engagements SET%s WHERE id=$%d", sets, n), args...); err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		rows, _ := db.PGQuery(r.Context(), "SELECT * FROM pentest_engagements WHERE id=$1", id)
		if len(rows) == 0 { respondErr(w, 404, "Not found"); return }
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

// ── Pentest findings ──────────────────────────────────────────────────────────

func pentestFindingListAll(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		severity := qstr(r, "severity")
		status := qstr(r, "status")
		where := " WHERE 1=1"
		args := []any{}
		n := 1
		if severity != "" { where += fmt.Sprintf(" AND f.severity=$%d", n); args = append(args, severity); n++ }
		if status != "" { where += fmt.Sprintf(" AND f.status=$%d", n);   args = append(args, status);   n++ }
		rows, err := db.PGQuery(r.Context(), `
			SELECT f.*, e.title AS engagement_title, e.vendor_name,
			  u.full_name AS assigned_to_name
			FROM pentest_findings f
			JOIN pentest_engagements e ON e.id = f.engagement_id
			LEFT JOIN o3c_users u ON f.assigned_to = u.id`+
			where+`
			ORDER BY
			  CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
			  f.sla_deadline NULLS LAST`, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, rows, "supabase")
	}
}

func pentestFindingCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		engID := chi.URLParam(r, "id")
		var b struct {
			Title              string   `json:"title"`
			Severity           string   `json:"severity"`
			CVSSScore          *float64 `json:"cvss_score"`
			AffectedComponent  string   `json:"affected_component"`
			Description        string   `json:"description"`
			BusinessImpact     string   `json:"business_impact"`
			Recommendation     string   `json:"recommendation"`
			AssignedTo         *int64   `json:"assigned_to"`
			SLADeadline        *string  `json:"sla_deadline"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Title == "" {
			respondErr(w, 422, "title is required")
			return
		}
		if b.Severity == "" { b.Severity = "medium" }
		// Auto-compute SLA deadline if not provided
		if b.SLADeadline == nil {
			days := map[string]int{"critical": 1, "high": 3, "medium": 14, "low": 30}[b.Severity]
			if days == 0 { days = 30 }
			d := time.Now().AddDate(0, 0, days).Format("2006-01-02")
			b.SLADeadline = &d
		}
		// Auto-generate finding ref
		refRow, _ := db.PGQuery(r.Context(),
			"SELECT COUNT(*)+1 AS n FROM pentest_findings WHERE engagement_id=$1", engID)
		ref := fmt.Sprintf("PT-%d-%03d", time.Now().Year(), toInt64(first(refRow)["n"]))

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO pentest_findings
			  (engagement_id, finding_ref, title, severity, cvss_score, affected_component,
			   description, business_impact, recommendation, assigned_to, sla_deadline)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
			engID, ref, b.Title, b.Severity, b.CVSSScore,
			nullIfBlank(b.AffectedComponent), nullIfBlank(b.Description),
			nullIfBlank(b.BusinessImpact), nullIfBlank(b.Recommendation),
			b.AssignedTo, b.SLADeadline)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func pentestFindingUpdate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fid := chi.URLParam(r, "fid")
		var b struct {
			Status        *string  `json:"status"`
			AssignedTo    *int64   `json:"assigned_to"`
			RetestStatus  *string  `json:"retest_status"`
			RetestNotes   *string  `json:"retest_notes"`
			ResolvedAt    *string  `json:"resolved_at"`
			Recommendation *string `json:"recommendation"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		sets := " updated_at=NOW()"
		args := []any{}
		n := 1
		if b.Status != nil {
			sets += fmt.Sprintf(", status=$%d", n); args = append(args, *b.Status); n++
			if *b.Status == "resolved" {
				sets += fmt.Sprintf(", resolved_at=COALESCE($%d, CURRENT_DATE)", n)
				if b.ResolvedAt != nil { args = append(args, *b.ResolvedAt) } else { args = append(args, nil) }
				n++
			}
		}
		if b.AssignedTo != nil  { sets += fmt.Sprintf(", assigned_to=$%d", n);   args = append(args, *b.AssignedTo);   n++ }
		if b.RetestStatus != nil { sets += fmt.Sprintf(", retest_status=$%d", n); args = append(args, *b.RetestStatus); n++ }
		if b.RetestNotes != nil { sets += fmt.Sprintf(", retest_notes=$%d", n);   args = append(args, *b.RetestNotes);  n++ }
		if b.Recommendation != nil { sets += fmt.Sprintf(", recommendation=$%d", n); args = append(args, *b.Recommendation); n++ }
		args = append(args, fid)
		if _, err := db.PGExec(r.Context(),
			fmt.Sprintf("UPDATE pentest_findings SET%s WHERE id=$%d", sets, n), args...); err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		rows, _ := db.PGQuery(r.Context(), `
			SELECT f.*, u.full_name AS assigned_to_name
			FROM pentest_findings f LEFT JOIN o3c_users u ON f.assigned_to=u.id
			WHERE f.id=$1`, fid)
		if len(rows) == 0 { respondErr(w, 404, "Not found"); return }
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func pentestFindingDelete(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fid := chi.URLParam(r, "fid")
		if rows, _ := db.PGQuery(r.Context(), "SELECT 1 FROM pentest_findings WHERE id=$1", fid); len(rows) == 0 {
			respondErr(w, 404, "Finding not found")
			return
		}
		db.PGExec(r.Context(), "DELETE FROM pentest_findings WHERE id=$1", fid) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// ── SOC 2 policy creation (H2) ────────────────────────────────────────────────

// soc2CreatePolicy creates a new SOC 2 policy document at draft status.
// Note: the soc2_policy_documents table (migration 063) does not have a content
// or policy_type column. Those fields are accepted but not persisted until a
// migration adds them. The handler uses the existing name/version/notes columns.
func soc2CreatePolicy(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		var b struct {
			Name       string `json:"name"`
			Version    string `json:"version"`
			Content    string `json:"content"`     // stored in notes until schema supports it
			OwnerID    int64  `json:"owner_id"`
			PolicyType string `json:"policy_type"` // used as category
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Name == "" {
			respondErr(w, 422, "name is required")
			return
		}
		if b.Version == "" {
			b.Version = "1.0"
		}
		ownerID := b.OwnerID
		if ownerID == 0 {
			ownerID = user.ID
		}
		category := b.PolicyType
		if category == "" {
			category = "general"
		}
		// content is stored in notes (no dedicated column yet in soc2_policy_documents).
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO soc2_policy_documents
			  (name, version, category, owner_id, status, notes, sort_order, created_at, updated_at)
			VALUES ($1,$2,$3,$4,'draft',$5,
			        (SELECT COALESCE(MAX(sort_order),0)+10 FROM soc2_policy_documents),
			        NOW(),NOW())
			RETURNING *`,
			b.Name, b.Version, category, ownerID, nullIfBlank(b.Content))
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}
