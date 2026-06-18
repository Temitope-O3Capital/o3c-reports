package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterCompliance(r chi.Router, db *core.DB) {
	all := core.RequirePages("compliance_all", "compliance_head")
	checklists := core.RequirePages("compliance_checklists", "compliance_all")
	cbn := core.RequirePages("cbn_reports", "compliance_all")
	sars := core.RequirePages("sars", "compliance_all")
	watchList := core.RequirePages("watch_list", "compliance_all")
	findings := core.RequirePages("audit_findings", "compliance_all")
	auditRead := core.RequirePages("audit_trail", "compliance_all")
	auditExport := core.RequirePages("audit_export", "compliance_all")

	// Audit log
	r.With(auditRead).Get("/audit-log", complianceAuditLogList(db))
	r.With(all).Post("/audit-log", complianceAuditLogInsert(db))
	r.With(auditExport).Get("/audit-log/export", complianceAuditLogExport(db))

	// CBN reports
	r.With(cbn).Get("/cbn-reports", complianceCBNList(db))
	r.With(cbn).Get("/cbn-reports/{id}", complianceCBNGet(db))
	r.With(cbn).Post("/cbn-reports", complianceCBNCreate(db))
	r.With(cbn).Put("/cbn-reports/{id}/sign-off", complianceCBNSignOff(db))
	r.With(cbn).Put("/cbn-reports/{id}/submit", complianceCBNSubmit(db))

	// SARs
	r.With(sars).Get("/sars", complianceSARList(db))
	r.With(sars).Get("/sars/{id}", complianceSARGet(db))
	r.With(sars).Post("/sars", complianceSARCreate(db))
	r.With(sars).Put("/sars/{id}/escalate", complianceSAREscalate(db))

	// Watch list
	r.With(watchList).Get("/watch-list", complianceWatchList(db))
	r.With(watchList).Post("/watch-list", complianceWatchListAdd(db))
	r.With(watchList).Put("/watch-list/{id}/deactivate", complianceWatchListDeactivate(db))

	// Audit findings
	r.With(findings).Get("/findings", complianceFindingList(db))
	r.With(findings).Get("/findings/{id}", complianceFindingGet(db))
	r.With(findings).Post("/findings", complianceFindingCreate(db))
	r.With(findings).Post("/findings/{id}/response", complianceFindingRespond(db))
	r.With(findings).Put("/findings/{id}/close", complianceFindingClose(db))

	// Checklists
	r.With(checklists).Get("/checklists", complianceChecklistList(db))
	r.With(checklists).Get("/checklists/{id}", complianceChecklistGet(db))
	r.With(checklists).Post("/checklists/{id}/respond", complianceChecklistRespond(db))

	// Dashboard
	r.With(all).Get("/dashboard", complianceDashboard(db))
}

// ── Audit Log ─────────────────────────────────────────────────────────────────

func complianceAuditLogList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID := qstr(r, "actor_id")
		entityType := qstr(r, "entity_type")
		action := qstr(r, "action")
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		limit := qint(r, "limit", 100, 1, 1000)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `SELECT id, actor_id, actor_role, actor_name, action, entity_type,
		                 entity_id, ip_address, created_at
		          FROM audit_logs WHERE 1=1`
		args := []any{}
		n := 1

		if actorID != "" {
			query += fmt.Sprintf(" AND actor_id = $%d", n)
			args = append(args, actorID)
			n++
		}
		if entityType != "" {
			query += fmt.Sprintf(" AND entity_type = $%d", n)
			args = append(args, entityType)
			n++
		}
		if action != "" {
			query += fmt.Sprintf(" AND action = $%d", n)
			args = append(args, action)
			n++
		}
		if dateFrom != "" {
			query += fmt.Sprintf(" AND created_at::date >= $%d", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			query += fmt.Sprintf(" AND created_at::date <= $%d", n)
			args = append(args, dateTo)
			n++
		}
		query += fmt.Sprintf(" ORDER BY created_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
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

func complianceAuditLogInsert(db *core.DB) http.HandlerFunc {
	type body struct {
		ActorID    int64          `json:"actor_id"`
		ActorRole  string         `json:"actor_role"`
		ActorName  string         `json:"actor_name"`
		Action     string         `json:"action"`
		EntityType string         `json:"entity_type"`
		EntityID   string         `json:"entity_id"`
		Changes    map[string]any `json:"changes"`
		IPAddress  string         `json:"ip_address"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Action == "" || b.EntityType == "" {
			respondErr(w, 422, "action and entity_type are required")
			return
		}

		changesJSON, err := json.Marshal(b.Changes)
		if err != nil {
			changesJSON = []byte("{}")
		}

		// audit_logs is append-only — never UPDATE or DELETE
		_, err = db.PGExec(r.Context(), `
			INSERT INTO audit_logs (actor_id, actor_role, actor_name, action, entity_type,
				entity_id, changes, ip_address, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
			b.ActorID, b.ActorRole, b.ActorName, b.Action, b.EntityType,
			b.EntityID, string(changesJSON), b.IPAddress)
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}
		respondErr(w, 201, "Audit log entry created")
	}
}

func complianceAuditLogExport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		actorID := qstr(r, "actor_id")
		entityType := qstr(r, "entity_type")
		action := qstr(r, "action")
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}

		query := `SELECT id, actor_id, actor_role, actor_name, action, entity_type,
		                 entity_id, ip_address, created_at
		          FROM audit_logs WHERE 1=1`
		args := []any{}
		n := 1

		if actorID != "" {
			query += fmt.Sprintf(" AND actor_id = $%d", n)
			args = append(args, actorID)
			n++
		}
		if entityType != "" {
			query += fmt.Sprintf(" AND entity_type = $%d", n)
			args = append(args, entityType)
			n++
		}
		if action != "" {
			query += fmt.Sprintf(" AND action = $%d", n)
			args = append(args, action)
			n++
		}
		if dateFrom != "" {
			query += fmt.Sprintf(" AND created_at::date >= $%d", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			query += fmt.Sprintf(" AND created_at::date <= $%d", n)
			args = append(args, dateTo)
			n++
		}
		query += " ORDER BY created_at DESC"

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Export failed")
			return
		}
		fname := fmt.Sprintf("audit_log_%s_%s.csv", coalesce(dateFrom, "all"), coalesce(dateTo, "all"))
		streamCSV(w, fname, rows)
	}
}

// ── CBN Reports ───────────────────────────────────────────────────────────────

func complianceCBNList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		year := qstr(r, "year")
		status := qstr(r, "status")

		query := `SELECT * FROM cbn_reports WHERE 1=1`
		args := []any{}
		n := 1

		if year != "" {
			query += fmt.Sprintf(" AND EXTRACT(YEAR FROM period_start) = $%d", n)
			args = append(args, year)
			n++
		}
		if status != "" {
			query += fmt.Sprintf(" AND status = $%d", n)
			args = append(args, status)
			n++
		}
		query += " ORDER BY created_at DESC"

		rows, err := db.PGQuery(r.Context(), query, args...)
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

func complianceCBNGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid report ID")
			return
		}
		rows, err := db.PGQuery(r.Context(), `SELECT * FROM cbn_reports WHERE id = $1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Report not found")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func complianceCBNCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		ReportType  string `json:"report_type"`
		PeriodStart string `json:"period_start"`
		PeriodEnd   string `json:"period_end"`
		Notes       string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ReportType == "" || b.PeriodStart == "" || b.PeriodEnd == "" {
			respondErr(w, 422, "report_type, period_start, period_end are required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO cbn_reports (report_type, period_start, period_end, status, notes, created_at, updated_at)
			VALUES ($1, $2, $3, 'draft', $4, NOW(), NOW())
			RETURNING id, report_type, status, period_start, period_end`,
			b.ReportType, b.PeriodStart, b.PeriodEnd, b.Notes)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func complianceCBNSignOff(db *core.DB) http.HandlerFunc {
	type body struct {
		Notes string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid report ID")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		user := core.UserFromCtx(r.Context())

		_, err = db.PGExec(r.Context(), `
			UPDATE cbn_reports SET status = 'signed_off', signed_off_by = $1,
				notes = COALESCE(NULLIF($2,''), notes), updated_at = NOW()
			WHERE id = $3`, user.ID, b.Notes, id)
		if err != nil {
			respondErr(w, 500, "Sign-off failed")
			return
		}
		respondErr(w, 200, "Report signed off")
	}
}

func complianceCBNSubmit(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid report ID")
			return
		}
		_, err = db.PGExec(r.Context(), `
			UPDATE cbn_reports SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
			WHERE id = $1`, id)
		if err != nil {
			respondErr(w, 500, "Submit failed")
			return
		}
		respondErr(w, 200, "Report submitted")
	}
}

// ── SARs ──────────────────────────────────────────────────────────────────────

// complianceSARList returns SARs with subject details masked.
// Tipping-off rule: subject_name is redacted in list views.
// Full details are only available via the single-record endpoint.
func complianceSARList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")

		query := `SELECT id, sar_ref, reporter_id, subject_id_type, account_number,
		                 amount_kobo, transaction_date, status,
		                 compliance_head_user_id, md_user_id,
		                 nfiu_ref, nfiu_submitted_at, created_at, updated_at,
		                 '[REDACTED]' AS subject_name
		          FROM sars WHERE 1=1`
		// Note: subject_name_encrypted and subject_id_encrypted are intentionally
		// omitted from the list view to prevent tipping off. Real decryption is TBD.
		args := []any{}
		if status != "" {
			query += fmt.Sprintf(" AND status = $%d", len(args)+1)
			args = append(args, status)
		}
		query += " ORDER BY created_at DESC"

		rows, err := db.PGQuery(r.Context(), query, args...)
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

// complianceSARGet returns full SAR detail including subject fields.
// subject_name_encrypted and subject_id_encrypted are returned as-is
// (real decryption is TBD — values are stored encrypted at rest).
func complianceSARGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid SAR ID")
			return
		}
		ctx := r.Context()

		rows, err := db.PGQuery(ctx, `SELECT * FROM sars WHERE id = $1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "SAR not found")
			return
		}

		escalations, _ := db.PGQuery(ctx, `
			SELECT sel.*, u.full_name AS actor_name
			FROM sar_escalation_log sel
			LEFT JOIN o3c_users u ON sel.actor_id = u.id
			WHERE sel.sar_id = $1 ORDER BY sel.created_at ASC`, id)
		if escalations == nil {
			escalations = []core.Row{}
		}

		respond(w, map[string]any{"sar": rows[0], "escalations": escalations}, "pg")
	}
}

func complianceSARCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		SubjectNameEncrypted string `json:"subject_name_encrypted"`
		SubjectIDType        string `json:"subject_id_type"`
		SubjectIDEncrypted   string `json:"subject_id_encrypted"`
		AccountNumber        string `json:"account_number"`
		AmountKobo           int64  `json:"amount_kobo"`
		TransactionDate      string `json:"transaction_date"`
		SummaryEncrypted     string `json:"summary_encrypted"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.SummaryEncrypted == "" {
			respondErr(w, 422, "summary_encrypted is required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Generate SAR ref: SAR-YYYYMM-XXXX
		import_time_now := "NOW()"
		_ = import_time_now
		countRows, _ := db.PGQuery(ctx,
			`SELECT COUNT(*) AS c FROM sars WHERE sar_ref LIKE $1`,
			"SAR-%")
		seq := int64(1)
		if len(countRows) > 0 {
			seq = toInt64(countRows[0]["c"]) + 1
		}

		sarRef := fmt.Sprintf("SAR-%04d", seq)

		rows, err := db.PGQuery(ctx, `
			INSERT INTO sars (sar_ref, reporter_id, subject_name_encrypted, subject_id_type,
				subject_id_encrypted, account_number, amount_kobo, transaction_date,
				summary_encrypted, status, created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',NOW(),NOW())
			RETURNING id, sar_ref, status, created_at`,
			sarRef, user.ID, b.SubjectNameEncrypted, b.SubjectIDType,
			b.SubjectIDEncrypted, b.AccountNumber, b.AmountKobo, b.TransactionDate,
			b.SummaryEncrypted)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func complianceSAREscalate(db *core.DB) http.HandlerFunc {
	type body struct {
		ToStatus string `json:"to_status"`
		Notes    string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid SAR ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ToStatus == "" {
			respondErr(w, 422, "to_status is required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		sarRows, err := db.PGQuery(ctx, `SELECT status FROM sars WHERE id = $1`, id)
		if err != nil || len(sarRows) == 0 {
			respondErr(w, 404, "SAR not found")
			return
		}
		fromStatus := str(sarRows[0]["status"])

		_, err = db.PGExec(ctx,
			`UPDATE sars SET status = $1, updated_at = NOW() WHERE id = $2`,
			b.ToStatus, id)
		if err != nil {
			respondErr(w, 500, "Escalate failed")
			return
		}

		db.PGExec(ctx, `
			INSERT INTO sar_escalation_log (sar_id, from_status, to_status, actor_id, notes, created_at)
			VALUES ($1, $2, $3, $4, $5, NOW())`,
			id, fromStatus, b.ToStatus, user.ID, b.Notes) //nolint:errcheck

		respondErr(w, 200, "SAR escalated")
	}
}

// ── Watch List ────────────────────────────────────────────────────────────────

func complianceWatchList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := qstr(r, "q")
		isActive := qstr(r, "is_active")

		query := `SELECT * FROM watch_list_entries WHERE 1=1`
		args := []any{}
		n := 1

		if isActive == "true" || isActive == "" {
			query += fmt.Sprintf(" AND is_active = $%d", n)
			args = append(args, true)
			n++
		} else if isActive == "false" {
			query += fmt.Sprintf(" AND is_active = $%d", n)
			args = append(args, false)
			n++
		}
		if q != "" {
			query += fmt.Sprintf(" AND (entity_name ILIKE $%d OR id_value ILIKE $%d)", n, n)
			args = append(args, "%"+q+"%")
			n++
		}
		query += " ORDER BY created_at DESC"

		rows, err := db.PGQuery(r.Context(), query, args...)
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

func complianceWatchListAdd(db *core.DB) http.HandlerFunc {
	type body struct {
		EntityType string `json:"entity_type"`
		EntityName string `json:"entity_name"`
		IDType     string `json:"id_type"`
		IDValue    string `json:"id_value"`
		Reason     string `json:"reason"`
		Source     string `json:"source"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.EntityName == "" || b.Reason == "" {
			respondErr(w, 422, "entity_name and reason are required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO watch_list_entries (entity_type, entity_name, id_type, id_value,
				reason, source, added_by, is_active, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,NOW())
			RETURNING id, entity_name, is_active, created_at`,
			b.EntityType, b.EntityName, b.IDType, b.IDValue, b.Reason, b.Source, user.ID)
		if err != nil {
			respondErr(w, 500, "Add failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func complianceWatchListDeactivate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid entry ID")
			return
		}
		_, err = db.PGExec(r.Context(),
			`UPDATE watch_list_entries SET is_active = FALSE WHERE id = $1`, id)
		if err != nil {
			respondErr(w, 500, "Deactivate failed")
			return
		}
		respondErr(w, 200, "Entry deactivated")
	}
}

// ── Audit Findings ────────────────────────────────────────────────────────────

func complianceFindingList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		severity := qstr(r, "severity")
		assignedTo := qstr(r, "assigned_to")

		query := `SELECT af.*, u.full_name AS assigned_to_name
		          FROM audit_findings af
		          LEFT JOIN o3c_users u ON af.assigned_to = u.id
		          WHERE 1=1`
		args := []any{}
		n := 1

		if status != "" {
			query += fmt.Sprintf(" AND af.status = $%d", n)
			args = append(args, status)
			n++
		}
		if severity != "" {
			query += fmt.Sprintf(" AND af.severity = $%d", n)
			args = append(args, severity)
			n++
		}
		if assignedTo != "" {
			query += fmt.Sprintf(" AND af.assigned_to = $%d", n)
			args = append(args, assignedTo)
			n++
		}
		query += " ORDER BY af.created_at DESC"

		rows, err := db.PGQuery(r.Context(), query, args...)
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

func complianceFindingGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid finding ID")
			return
		}
		ctx := r.Context()

		findings, err := db.PGQuery(ctx, `
			SELECT af.*, u.full_name AS assigned_to_name
			FROM audit_findings af
			LEFT JOIN o3c_users u ON af.assigned_to = u.id
			WHERE af.id = $1`, id)
		if err != nil || len(findings) == 0 {
			respondErr(w, 404, "Finding not found")
			return
		}

		responses, _ := db.PGQuery(ctx, `
			SELECT afr.*, u.full_name AS responder_name
			FROM audit_finding_responses afr
			LEFT JOIN o3c_users u ON afr.responder_id = u.id
			WHERE afr.finding_id = $1 ORDER BY afr.created_at ASC`, id)
		if responses == nil {
			responses = []core.Row{}
		}

		respond(w, map[string]any{"finding": findings[0], "responses": responses}, "pg")
	}
}

func complianceFindingCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		Source         string `json:"source"`
		AssignedTo     int64  `json:"assigned_to"`
		Severity       string `json:"severity"`
		Description    string `json:"description"`
		Recommendation string `json:"recommendation"`
		DueDate        string `json:"due_date"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Description == "" || b.Severity == "" {
			respondErr(w, 422, "description and severity are required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Generate finding ref
		countRows, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS c FROM audit_findings`)
		seq := int64(1)
		if len(countRows) > 0 {
			seq = toInt64(countRows[0]["c"]) + 1
		}
		findingRef := fmt.Sprintf("AF-%04d", seq)

		rows, err := db.PGQuery(ctx, `
			INSERT INTO audit_findings (finding_ref, source, assigned_to, assigned_by, severity,
				description, recommendation, status, due_date, created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,NOW(),NOW())
			RETURNING id, finding_ref, severity, status, created_at`,
			findingRef, b.Source, b.AssignedTo, user.ID, b.Severity,
			b.Description, b.Recommendation, b.DueDate)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func complianceFindingRespond(db *core.DB) http.HandlerFunc {
	type body struct {
		Response   string `json:"response"`
		ActionPlan string `json:"action_plan"`
		TargetDate string `json:"target_date"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid finding ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Response == "" {
			respondErr(w, 422, "response is required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO audit_finding_responses (finding_id, responder_id, response, action_plan, target_date, created_at)
			VALUES ($1,$2,$3,$4,$5,NOW())
			RETURNING id, created_at`,
			id, user.ID, b.Response, b.ActionPlan, b.TargetDate)
		if err != nil {
			respondErr(w, 500, "Respond failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func complianceFindingClose(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid finding ID")
			return
		}
		_, err = db.PGExec(r.Context(), `
			UPDATE audit_findings SET status = 'closed', closed_at = NOW(), updated_at = NOW()
			WHERE id = $1`, id)
		if err != nil {
			respondErr(w, 500, "Close failed")
			return
		}
		respondErr(w, 200, "Finding closed")
	}
}

// ── Checklists ────────────────────────────────────────────────────────────────

func complianceChecklistList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		assignedTo := qstr(r, "assigned_to")

		query := `SELECT cc.*, u.full_name AS assigned_to_name
		          FROM compliance_checklists cc
		          LEFT JOIN o3c_users u ON cc.assigned_to = u.id
		          WHERE 1=1`
		args := []any{}
		n := 1

		if status != "" {
			query += fmt.Sprintf(" AND cc.status = $%d", n)
			args = append(args, status)
			n++
		}
		if assignedTo != "" {
			query += fmt.Sprintf(" AND cc.assigned_to = $%d", n)
			args = append(args, assignedTo)
			n++
		}
		query += " ORDER BY cc.due_date ASC"

		rows, err := db.PGQuery(r.Context(), query, args...)
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

func complianceChecklistGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid checklist ID")
			return
		}
		ctx := r.Context()

		checklists, err := db.PGQuery(ctx, `SELECT * FROM compliance_checklists WHERE id = $1`, id)
		if err != nil || len(checklists) == 0 {
			respondErr(w, 404, "Checklist not found")
			return
		}

		// Get template items with any existing responses
		items, _ := db.PGQuery(ctx, `
			SELECT ti.id, ti.item_text, ti.is_required, ti.display_order,
			       cr.response, cr.notes, cr.created_at AS responded_at
			FROM compliance_checklist_template_items ti
			LEFT JOIN compliance_checklist_responses cr
				ON cr.item_id = ti.id AND cr.checklist_id = $1
			WHERE ti.template_id = (
				SELECT template_id FROM compliance_checklists WHERE id = $1
			)
			ORDER BY ti.display_order`, id, id)
		if items == nil {
			items = []core.Row{}
		}

		respond(w, map[string]any{"checklist": checklists[0], "items": items}, "pg")
	}
}

func complianceChecklistRespond(db *core.DB) http.HandlerFunc {
	type item struct {
		ItemID   int    `json:"item_id"`
		Response string `json:"response"`
		Notes    string `json:"notes"`
	}
	type body struct {
		Items []item `json:"items"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid checklist ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}

		ctx := r.Context()
		for _, it := range b.Items {
			db.PGExec(ctx, `
				INSERT INTO compliance_checklist_responses (checklist_id, item_id, response, notes, created_at)
				VALUES ($1, $2, $3, $4, NOW())
				ON CONFLICT (checklist_id, item_id) DO UPDATE
					SET response = EXCLUDED.response, notes = EXCLUDED.notes`,
				id, it.ItemID, it.Response, it.Notes) //nolint:errcheck
		}

		// Mark checklist complete if all required items have responses
		db.PGExec(ctx, `
			UPDATE compliance_checklists SET status = 'completed', updated_at = NOW()
			WHERE id = $1
			  AND NOT EXISTS (
				SELECT 1 FROM compliance_checklist_template_items ti
				WHERE ti.template_id = (SELECT template_id FROM compliance_checklists WHERE id = $1)
				  AND ti.is_required = TRUE
				  AND NOT EXISTS (
					SELECT 1 FROM compliance_checklist_responses cr
					WHERE cr.checklist_id = $1 AND cr.item_id = ti.id AND cr.response IS NOT NULL
				  )
			  )`, id) //nolint:errcheck

		respondErr(w, 200, "Responses saved")
	}
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

func complianceDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		dash := map[string]any{}

		// Overdue checklists
		overdueRows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS count FROM compliance_checklists
			WHERE status = 'pending' AND due_date < CURRENT_DATE`)
		if len(overdueRows) > 0 {
			dash["overdue_checklists"] = overdueRows[0]["count"]
		}

		// Open findings by severity
		findingsRows, _ := db.PGQuery(ctx, `
			SELECT severity, COUNT(*) AS count FROM audit_findings
			WHERE status = 'open' GROUP BY severity ORDER BY severity`)
		if findingsRows == nil {
			findingsRows = []core.Row{}
		}
		dash["open_findings_by_severity"] = findingsRows

		// Pending SARs
		sarRows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS count FROM sars WHERE status = 'draft'`)
		if len(sarRows) > 0 {
			dash["pending_sars"] = sarRows[0]["count"]
		}

		// Active watch list entries
		watchRows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS count FROM watch_list_entries WHERE is_active = TRUE`)
		if len(watchRows) > 0 {
			dash["active_watch_list"] = watchRows[0]["count"]
		}

		respond(w, dash, "pg")
	}
}
