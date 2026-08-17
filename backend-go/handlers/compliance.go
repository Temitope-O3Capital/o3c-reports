// Package handlers — Compliance module (~2600 lines)
// Sections: Audit Log · CBN Reports · SARs · Watch List · Audit Findings ·
//           Checklists · Dashboard · Prudential Ratios · Bureau Export ·
//           Bureau Submission Logs · DSAR · Retention Schedule · DPA Register ·
//           NDPR Erasure Worker · AML Rules · Board Pack
// See "// ── <Section>" dividers throughout.

package handlers

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

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

	// My Dashboard — personal compliance station (any compliance staff)
	mine := core.RequirePages("watch_list", "audit_findings", "compliance_checklists", "compliance_all")
	r.With(mine).Get("/my-dashboard", complianceMyDashboard(db))

	// Phase 12 — Regulatory
	r.With(cbn).Get("/prudential-ratios",            compliancePrudentialRatios(db))
	r.With(cbn).Get("/credit-bureau-export",         complianceCreditBureauExport(db))
	r.With(cbn).Get("/bureau-submissions",           complianceBureauSubmissionList(db))
	r.With(cbn).Post("/bureau-submissions",          complianceBureauSubmissionCreate(db))
	r.With(all).Get("/data-subject-requests",         complianceDSARList(db))
	r.With(all).Post("/data-subject-requests",        complianceDSARCreate(db))
	r.With(all).Patch("/data-subject-requests/{id}", complianceDSARUpdate(db))
	r.With(all).Get("/retention-schedule",           complianceRetentionSchedule(db))
	r.With(cbn).Get("/concentration-risk",           complianceConcentrationRisk(db))
	r.With(all).Get("/dpa-register",                 complianceDPARegister(db))
	r.With(all).Post("/dpa-register",                complianceDPARegisterCreate(db))
	r.With(all).Patch("/dpa-register/{id}",          complianceDPARegisterUpdate(db))

	// Phase 12 — AML Rules (C1)
	aml := core.RequirePages("compliance_all", "compliance_head")
	r.With(aml).Get("/aml/rules",          complianceListAMLRules(db))
	r.With(aml).Post("/aml/rules",         complianceCreateAMLRule(db))
	r.With(aml).Delete("/aml/rules/{id}", complianceDeleteAMLRule(db))
	r.With(aml).Get("/aml/stats",          complianceAMLStats(db))
	r.With(aml).Get("/aml-rules",          complianceListAMLRules(db))
	r.With(aml).Post("/aml-rules",         complianceCreateAMLRule(db))
	r.With(aml).Delete("/aml-rules/{id}",  complianceDeleteAMLRule(db))

	// Phase 12 — KYC Expiry (C2)
	r.With(all).Get("/kyc-expiry",               complianceListKYCExpiry(db))
	r.With(all).Post("/kyc-expiry/{cif}/action", complianceKYCExpiryAction(db))

	// M34: Board Pack — JSON data + printable HTML export
	r.With(all).Get("/board-pack", complianceBoardPack(db))

	// DSAR assignment (H6)
	r.With(all).Post("/data-subject-requests/{id}/assign", complianceDSARAssign(db))

	// R4: Data breach incident management
	r.With(all).Get("/breach-incidents",         complianceListBreachIncidents(db))
	r.With(all).Post("/breach-incidents",        complianceCreateBreachIncident(db))
	r.With(all).Patch("/breach-incidents/{id}", complianceUpdateBreachIncident(db))

	// DSAR worker stats
	r.With(all).Get("/dsar-stats", complianceDSARStats(db))

	// P12-08/09 — SOC 2 readiness + pentest tracker
	RegisterSOC2(r, db)
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

		// Actor identity always comes from the authenticated JWT, never the request body.
		user := core.UserFromCtx(r.Context())

		changesJSON, err := json.Marshal(b.Changes)
		if err != nil {
			changesJSON = []byte("{}")
		}

		// audit_logs is append-only — never UPDATE or DELETE
		_, err = db.PGExec(r.Context(), `
			INSERT INTO audit_logs (actor_id, actor_role, actor_name, action, entity_type,
				entity_id, changes, ip_address, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
			user.ID, user.Role, user.FullName, b.Action, b.EntityType,
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
		from, _ := validDate(r, "from")
		to, _   := validDate(r, "to")
		limit := qint(r, "limit", 200, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `
			SELECT c.id,
			       COALESCE(c.report_name, c.report_type) AS report_name,
			       COALESCE(c.regulatory_body, '')         AS regulatory_body,
			       COALESCE(c.due_date, c.period_end)      AS due_date,
			       c.status, c.notes, c.submitted_at,
			       c.period_start, c.period_end, c.report_type,
			       c.created_at, c.updated_at,
			       u.full_name AS owner_name
			FROM cbn_reports c
			LEFT JOIN o3c_users u ON u.id = c.owner_id
			WHERE 1=1`
		args := []any{}
		n := 1

		if year != "" {
			query += fmt.Sprintf(" AND EXTRACT(YEAR FROM COALESCE(c.due_date, c.period_end)) = $%d", n)
			args = append(args, year)
			n++
		}
		if status != "" {
			query += fmt.Sprintf(" AND c.status = $%d", n)
			args = append(args, status)
			n++
		}
		if from != "" {
			query += fmt.Sprintf(" AND COALESCE(c.due_date, c.period_end)::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			query += fmt.Sprintf(" AND COALESCE(c.due_date, c.period_end)::date <= $%d::date", n)
			args = append(args, to)
			n++
		}
		query += fmt.Sprintf(" ORDER BY COALESCE(c.due_date, c.period_end) ASC NULLS LAST LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
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
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func complianceCBNCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		// Calendar-style fields (from RegulatoryCalendar.tsx)
		ReportName     string `json:"report_name"`
		RegulatoryBody string `json:"regulatory_body"`
		DueDate        string `json:"due_date"`
		// Legacy CBN submission fields
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
		// Require either the calendar fields or the legacy CBN fields.
		if b.ReportName == "" && b.ReportType == "" {
			respondErr(w, 422, "report_name is required")
			return
		}
		// Normalise: calendar mode uses report_name → report_type, due_date → period_end.
		if b.ReportType == "" {
			b.ReportType = b.ReportName
		}
		if b.ReportName == "" {
			b.ReportName = b.ReportType
		}
		if b.PeriodEnd == "" && b.DueDate != "" {
			b.PeriodEnd = b.DueDate
		}
		if b.PeriodStart == "" {
			b.PeriodStart = time.Now().Format("2006-01-02")
		}
		if b.PeriodEnd == "" {
			b.PeriodEnd = b.PeriodStart
		}
		if b.DueDate == "" {
			b.DueDate = b.PeriodEnd
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO cbn_reports
			    (report_type, report_name, regulatory_body, due_date,
			     period_start, period_end, status, notes, owner_id, created_at, updated_at)
			VALUES ($1, $2, $3, $4::date, $5::date, $6::date, 'pending', $7, $8, NOW(), NOW())
			RETURNING id, report_name, regulatory_body, due_date, status`,
			b.ReportType, b.ReportName, b.RegulatoryBody, b.DueDate,
			b.PeriodStart, b.PeriodEnd, b.Notes, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
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

		res, err := db.PGExec(r.Context(), `
			UPDATE cbn_reports SET status = 'signed_off', signed_off_by = $1,
				notes = COALESCE(NULLIF($2,''), notes), updated_at = NOW()
			WHERE id = $3`, user.ID, b.Notes, id)
		if err != nil {
			respondErr(w, 500, "Sign-off failed")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 404, "Report not found")
			return
		}
		respondOK(w, "Report signed off")
	}
}

func complianceCBNSubmit(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid report ID")
			return
		}
		res, err := db.PGExec(r.Context(), `
			UPDATE cbn_reports SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
			WHERE id = $1 AND status IN ('pending', 'draft', 'signed_off')`, id)
		if err != nil {
			respondErr(w, 500, "Submit failed")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 409, "Report not found or not in signed_off status")
			return
		}
		respondOK(w, "Report submitted")
	}
}

// ── SARs ──────────────────────────────────────────────────────────────────────

// complianceSARList returns SARs with subject details masked.
// Tipping-off rule: subject_name is redacted in list views.
// Full details are only available via the single-record endpoint.
func complianceSARList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		// M2: support page/per_page as well as legacy limit/offset.
		perPage := qint(r, "per_page", 50, 1, 500)
		page := qint(r, "page", 1, 1, 1<<30)
		limit := qint(r, "limit", perPage, 1, 500)
		offset := qint(r, "offset", (page-1)*perPage, 0, 1<<30)

		query := `SELECT id, sar_ref, reporter_id, subject_id_type, account_number,
		                 amount_kobo, transaction_date, status,
		                 compliance_head_user_id, md_user_id,
		                 nfiu_ref, nfiu_submitted_at, created_at, updated_at,
		                 '[REDACTED]' AS subject_name
		          FROM sars WHERE 1=1`
		// Note: subject_name_encrypted and subject_id_encrypted are intentionally
		// omitted from the list view to prevent tipping off. Real decryption is TBD.
		args := []any{}
		n := 1
		if status != "" {
			query += fmt.Sprintf(" AND status = $%d", n)
			args = append(args, status)
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
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

// complianceSARGet returns full SAR detail. Encrypted fields are decrypted server-side
// and returned as plain-text alongside the raw encrypted columns.
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

		sar := rows[0]
		for src, dst := range map[string]string{
			"subject_name_encrypted": "subject_name",
			"subject_id_encrypted":   "subject_id",
			"summary_encrypted":      "summary",
		} {
			if enc, _ := sar[src].(string); enc != "" {
				if plain, err := decryptValue(enc); err == nil {
					sar[dst] = plain
				}
			}
		}

		escalations, _ := db.PGQuery(ctx, `
			SELECT sel.*, u.full_name AS actor_name
			FROM sar_escalation_log sel
			LEFT JOIN o3c_users u ON sel.actor_id = u.id
			WHERE sel.sar_id = $1 ORDER BY sel.created_at ASC`, id)
		if escalations == nil {
			escalations = []core.Row{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"sar": sar, "escalations": escalations}) //nolint:errcheck
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

		// Generate SAR ref using the sequence created in migration 015 to avoid race conditions.
		seqRows, err := db.PGQuery(ctx, `SELECT nextval('sar_ref_seq') AS seq`)
		if err != nil || len(seqRows) == 0 {
			respondErr(w, 500, "Could not generate SAR reference")
			return
		}
		seq := toInt64(seqRows[0]["seq"])
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

		newID := toInt64(rows[0]["id"])
		go NotifyRole(ctx, db, "compliance_head", NotifPayload{
			EventType: EvtSARFiled,
			Title:     "New SAR Filed: " + sarRef,
			Body:      "A suspicious activity report has been submitted and requires review.",
			ActionURL: fmt.Sprintf("/compliance/sars/%d", newID),
			EntityRef: sarRef,
		})

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func complianceSAREscalate(db *core.DB) http.HandlerFunc {
	type body struct {
		ToStatus string `json:"to_status"`
		Notes    string `json:"notes"`
		// M46: populated when transitioning to submitted_to_nfiu
		NFIURef  string `json:"nfiu_ref"`
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
		validStatuses := map[string]bool{
			"draft": true, "under_review": true, "submitted_to_nfiu": true,
			"nfiu_acknowledged": true, "closed": true,
		}
		if b.ToStatus == "" || !validStatuses[b.ToStatus] {
			respondErr(w, 422, "to_status must be one of: draft, under_review, submitted_to_nfiu, nfiu_acknowledged, closed")
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

		// C5: enforce state machine transitions.
		validTransitions := map[string][]string{
			"draft":             {"under_review"},
			"under_review":      {"submitted_to_nfiu", "draft"},
			"submitted_to_nfiu": {"nfiu_acknowledged"},
			"nfiu_acknowledged": {"closed"},
		}
		allowed := validTransitions[fromStatus]
		transitionOK := false
		for _, s := range allowed {
			if s == b.ToStatus {
				transitionOK = true
				break
			}
		}
		if !transitionOK {
			respondErr(w, 422, "Invalid status transition from "+fromStatus+" to "+b.ToStatus)
			return
		}

		// M46: capture NFIU submission metadata when moving to submitted_to_nfiu.
		if b.ToStatus == "submitted_to_nfiu" && b.NFIURef == "" {
			respondErr(w, 422, "nfiu_ref is required when submitting to NFIU")
			return
		}

		var execErr error
		var res interface{ RowsAffected() (int64, error) }
		if b.ToStatus == "submitted_to_nfiu" {
			res, execErr = db.PGExec(ctx,
				`UPDATE sars SET status=$1, nfiu_ref=$2, nfiu_submitted_at=NOW(), updated_at=NOW()
				 WHERE id=$3 AND status=$4`,
				b.ToStatus, b.NFIURef, id, fromStatus)
		} else {
			res, execErr = db.PGExec(ctx,
				`UPDATE sars SET status=$1, updated_at=NOW() WHERE id=$2 AND status=$3`,
				b.ToStatus, id, fromStatus)
		}
		if execErr != nil {
			respondErr(w, 500, "Escalate failed")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 409, "SAR status has changed — please refresh and retry")
			return
		}

		db.PGExec(ctx, `
			INSERT INTO sar_escalation_log (sar_id, from_status, to_status, actor_id, notes, created_at)
			VALUES ($1, $2, $3, $4, $5, NOW())`,
			id, fromStatus, b.ToStatus, user.ID, b.Notes) //nolint:errcheck

		respondOK(w, "SAR escalated")
	}
}

// ── Watch List ────────────────────────────────────────────────────────────────

func complianceWatchList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := qstr(r, "q")
		isActive := qstr(r, "is_active")
		entityType := qstr(r, "entity_type")
		from, _ := validDate(r, "from")
		to, _   := validDate(r, "to")
		limit := qint(r, "limit", 50, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

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
		if entityType != "" {
			query += fmt.Sprintf(" AND entity_type = $%d", n)
			args = append(args, entityType)
			n++
		}
		if q != "" {
			query += fmt.Sprintf(" AND (entity_name ILIKE $%d OR id_value ILIKE $%d)", n, n)
			args = append(args, "%"+q+"%")
			n++
		}
		if from != "" {
			query += fmt.Sprintf(" AND created_at::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			query += fmt.Sprintf(" AND created_at::date <= $%d::date", n)
			args = append(args, to)
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
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
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
			RETURNING id, entity_type, entity_name, is_active, created_at`,
			b.EntityType, b.EntityName, b.IDType, b.IDValue, b.Reason, b.Source, user.ID)
		if err != nil {
			respondErr(w, 500, "Add failed")
			return
		}
		entryID := toInt64(rows[0]["id"])
		notifCtx := context.Background()
		payload := NotifPayload{
			EventType: EvtAMLWatchlistHit,
			Title:     fmt.Sprintf("Watchlist entry added: %s", b.EntityName),
			Body:      fmt.Sprintf("%s (%s) has been added to the AML watchlist. Reason: %s", b.EntityName, b.EntityType, b.Reason),
			ActionURL: fmt.Sprintf("/compliance/watch-list/%d", entryID),
			EntityRef: b.IDValue,
		}
		go NotifyRole(notifCtx, db, "compliance_officer", payload)
		go NotifyRole(notifCtx, db, "compliance_head", NotifPayload{
			EventType: EvtAMLWatchlistHit,
			Title:     fmt.Sprintf("Watchlist entry added: %s", b.EntityName),
			Body:      fmt.Sprintf("%s (%s) added to AML watchlist. Reason: %s", b.EntityName, b.EntityType, b.Reason),
			ActionURL: fmt.Sprintf("/compliance/watch-list/%d", entryID),
			EntityRef: b.IDValue,
		})

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func complianceWatchListDeactivate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid entry ID")
			return
		}
		res, err := db.PGExec(r.Context(),
			`UPDATE watch_list_entries SET is_active = FALSE WHERE id = $1`, id)
		if err != nil {
			respondErr(w, 500, "Deactivate failed")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 404, "Entry not found")
			return
		}
		respondOK(w, "Entry deactivated")
	}
}

// ── Audit Findings ────────────────────────────────────────────────────────────

func complianceFindingList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		severity := qstr(r, "severity")
		assignedTo := qstr(r, "assigned_to")
		from, _ := validDate(r, "from")
		to, _   := validDate(r, "to")
		limit := qint(r, "limit", 50, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

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
		if from != "" {
			query += fmt.Sprintf(" AND af.created_at::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			query += fmt.Sprintf(" AND af.created_at::date <= $%d::date", n)
			args = append(args, to)
			n++
		}
		query += fmt.Sprintf(" ORDER BY af.created_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
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

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"finding": findings[0], "responses": responses}) //nolint:errcheck
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

		// Use a sequence for the finding ref to avoid race conditions under concurrent inserts.
		db.PGExec(ctx, `CREATE SEQUENCE IF NOT EXISTS finding_ref_seq`) //nolint:errcheck
		seqRows, _ := db.PGQuery(ctx, `SELECT nextval('finding_ref_seq') AS n`)
		seq := int64(1)
		if len(seqRows) > 0 {
			seq = toInt64(seqRows[0]["n"])
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

		newID := toInt64(rows[0]["id"])
		go NotifyRole(ctx, db, "compliance_officer", NotifPayload{
			EventType: EvtFindingCreated,
			Title:     "New Audit Finding: " + findingRef,
			Body:      fmt.Sprintf("Severity: %s — %s", b.Severity, b.Description),
			ActionURL: fmt.Sprintf("/compliance/findings/%d", newID),
			EntityRef: findingRef,
		})

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
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
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func complianceFindingClose(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid finding ID")
			return
		}
		// H1: remediation notes are mandatory when closing a finding.
		var b struct {
			RemediationNotes string `json:"remediation_notes"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		if b.RemediationNotes == "" {
			respondErr(w, 422, "Remediation notes are required to close a finding")
			return
		}
		ctx := r.Context()

		// Fetch finding info for notification before closing.
		findingRows, err := db.PGQuery(ctx,
			`SELECT assigned_by, finding_ref, description FROM audit_findings WHERE id = $1`, id)
		if err != nil || len(findingRows) == 0 {
			respondErr(w, 404, "Finding not found")
			return
		}
		assignedBy := toInt64(findingRows[0]["assigned_by"])
		ref := str(findingRows[0]["finding_ref"])

		res, err := db.PGExec(ctx, `
			UPDATE audit_findings SET status = 'closed', closed_at = NOW(), updated_at = NOW()
			WHERE id = $1`, id)
		if err != nil {
			respondErr(w, 500, "Close failed")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 404, "Finding not found")
			return
		}

		// Notify the person who created the finding.
		if assignedBy > 0 {
			go Notify(ctx, db, NotifPayload{
				EventType: EvtFindingClosed,
				UserID:    assignedBy,
				Title:     "Audit Finding Closed: " + ref,
				Body:      "The audit finding has been marked as resolved/closed.",
				ActionURL: fmt.Sprintf("/compliance/findings/%d", id),
				EntityRef: ref,
			})
		}

		respondOK(w, "Finding closed")
	}
}

// ── Checklists ────────────────────────────────────────────────────────────────

func complianceChecklistList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		assignedTo := qstr(r, "assigned_to")
		limit := qint(r, "limit", 50, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

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
		query += fmt.Sprintf(" ORDER BY cc.due_date ASC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
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

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"checklist": checklists[0], "items": items}) //nolint:errcheck
	}
}

func complianceChecklistRespond(db *core.DB) http.HandlerFunc {
	type item struct {
		ItemID   int     `json:"item_id"`
		Response *string `json:"response"` // null = uncheck (sets response to NULL)
		Notes    string  `json:"notes"`
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

		respondOK(w, "Responses saved")
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

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(dash) //nolint:errcheck
	}
}

// complianceMyDashboard — the signed-in officer's personal station: findings and
// checklists assigned to them, regulatory deadlines they own, plus team-wide
// context (KYC expiries, active watch-list, pending SARs). Every query is
// defensive — a missing table simply yields no rows and that key is omitted.
func complianceMyDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var uid int64
		if u := core.UserFromCtx(ctx); u != nil {
			uid = u.ID
		}
		dash := map[string]any{}
		scalar := func(key, sql string, args ...any) {
			rows, _ := db.PGQuery(ctx, sql, args...)
			if len(rows) > 0 {
				dash[key] = rows[0]["count"]
			}
		}

		// Findings assigned to me
		scalar("my_open_findings", `SELECT COUNT(*) AS count FROM audit_findings WHERE assigned_to=$1 AND status='open'`, uid)
		scalar("my_findings_overdue", `SELECT COUNT(*) AS count FROM audit_findings WHERE assigned_to=$1 AND status='open' AND due_date < CURRENT_DATE`, uid)
		sev, _ := db.PGQuery(ctx, `SELECT severity, COUNT(*) AS count FROM audit_findings WHERE assigned_to=$1 AND status='open' GROUP BY severity`, uid)
		if sev == nil {
			sev = []core.Row{}
		}
		dash["my_findings_by_severity"] = sev
		recent, _ := db.PGQuery(ctx, `SELECT finding_ref, description, severity, status, due_date FROM audit_findings WHERE assigned_to=$1 AND status='open' ORDER BY (due_date IS NULL), due_date ASC LIMIT 8`, uid)
		if recent == nil {
			recent = []core.Row{}
		}
		dash["my_findings"] = recent

		// Checklists assigned to me
		scalar("my_checklists_due", `SELECT COUNT(*) AS count FROM compliance_checklists WHERE assigned_to=$1 AND status='pending'`, uid)
		scalar("my_checklists_overdue", `SELECT COUNT(*) AS count FROM compliance_checklists WHERE assigned_to=$1 AND status='pending' AND due_date < CURRENT_DATE`, uid)

		// Regulatory deadlines I own (CBN reports not yet filed)
		scalar("my_reg_open", `SELECT COUNT(*) AS count FROM cbn_reports WHERE owner_id=$1 AND COALESCE(status,'') NOT IN ('submitted','signed_off')`, uid)
		scalar("my_reg_overdue", `SELECT COUNT(*) AS count FROM cbn_reports WHERE owner_id=$1 AND COALESCE(status,'') NOT IN ('submitted','signed_off') AND due_date < CURRENT_DATE`, uid)
		deadlines, _ := db.PGQuery(ctx, `SELECT report_name, regulatory_body, due_date, status FROM cbn_reports WHERE owner_id=$1 AND COALESCE(status,'') NOT IN ('submitted','signed_off') ORDER BY (due_date IS NULL), due_date ASC LIMIT 8`, uid)
		if deadlines == nil {
			deadlines = []core.Row{}
		}
		dash["my_deadlines"] = deadlines

		// Team-wide context
		scalar("kyc_expiring_30d", `SELECT COUNT(*) AS count FROM kyc_records WHERE expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`)
		scalar("active_watch_list", `SELECT COUNT(*) AS count FROM watch_list_entries WHERE is_active = TRUE`)
		scalar("pending_sars", `SELECT COUNT(*) AS count FROM sars WHERE status='draft'`)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(dash) //nolint:errcheck
	}
}

// ── Phase 12: Prudential Ratios ───────────────────────────────────────────────

func compliancePrudentialRatios(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// NPL ratio: loans with DPD > 90 / total active loan book
		nplRows, _ := db.PGQuery(ctx, `
			SELECT
			  COALESCE(SUM(outstanding_balance_kobo) FILTER (WHERE days_past_due > 90), 0) AS npl_kobo,
			  COALESCE(SUM(outstanding_balance_kobo), 0)                                   AS total_kobo
			FROM loan_accounts WHERE status = 'active'`)

		// PAR30, PAR60, PAR90
		parRows, _ := db.PGQuery(ctx, `
			SELECT
			  COALESCE(SUM(outstanding_balance_kobo) FILTER (WHERE days_past_due > 30), 0) AS par30_kobo,
			  COALESCE(SUM(outstanding_balance_kobo) FILTER (WHERE days_past_due > 60), 0) AS par60_kobo,
			  COALESCE(SUM(outstanding_balance_kobo) FILTER (WHERE days_past_due > 90), 0) AS par90_kobo,
			  COALESCE(SUM(outstanding_balance_kobo), 0)                                   AS total_kobo
			FROM loan_accounts WHERE status = 'active'`)

		// Fixed deposit liabilities (liquidity denominator proxy)
		fdRows, _ := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(principal_kobo), 0) AS total_fd_kobo
			FROM fixed_deposits WHERE status = 'active'`)

		// Total disbursed (loan book)
		bookRows, _ := db.PGQuery(ctx, `
			SELECT COALESCE(SUM(loan_amount_kobo), 0) AS total_disbursed_kobo,
			       COUNT(*) AS active_loans
			FROM loan_accounts WHERE status = 'active'`)

		result := map[string]any{}

		if len(nplRows) > 0 {
			nplKobo := toFloat64(nplRows[0]["npl_kobo"])
			totalKobo := toFloat64(nplRows[0]["total_kobo"])
			nplRatio := 0.0
			if totalKobo > 0 {
				nplRatio = nplKobo / totalKobo * 100
			}
			result["npl_kobo"] = int64(nplKobo)
			result["total_loan_book_kobo"] = int64(totalKobo)
			result["npl_ratio_pct"] = round2(nplRatio)
		}

		if len(parRows) > 0 {
			total := toFloat64(parRows[0]["total_kobo"])
			calcPAR := func(key string) float64 {
				if total == 0 {
					return 0
				}
				return toFloat64(parRows[0][key]) / total * 100
			}
			result["par30_pct"] = round2(calcPAR("par30_kobo"))
			result["par60_pct"] = round2(calcPAR("par60_kobo"))
			result["par90_pct"] = round2(calcPAR("par90_kobo"))
		}

		if len(fdRows) > 0 {
			result["total_fd_liabilities_kobo"] = fdRows[0]["total_fd_kobo"]
		}
		if len(bookRows) > 0 {
			result["total_disbursed_kobo"] = bookRows[0]["total_disbursed_kobo"]
			result["active_loans"] = bookRows[0]["active_loans"]
		}

		// CBN thresholds for reference
		result["cbn_thresholds"] = map[string]any{
			"npl_max_pct":   5.0,
			"par90_max_pct": 5.0,
			"car_min_pct":   10.0,
		}

		// Compute CAR: equity capital / risk-weighted assets (loan portfolio) * 100.
		// Uses gl_accounts type='equity' for capital and loan_applications outstanding for RWA.
		carPct := 0.0
		carRows, carErr := db.PGQuery(ctx, `
			SELECT
			    COALESCE((SELECT SUM(je.amount_kobo) FROM gl_journal_entries je
			              JOIN gl_accounts ga ON ga.id = je.account_id
			              WHERE ga.type = 'equity' AND je.direction = 'CR'), 0) AS equity_kobo,
			    COALESCE((SELECT SUM(outstanding_kobo) FROM loan_applications
			              WHERE stage = 'active' AND outstanding_kobo > 0), 0)  AS rwa_kobo`)
		if carErr == nil && len(carRows) > 0 {
			equity := float64(toInt64(carRows[0]["equity_kobo"]))
			rwa := float64(toInt64(carRows[0]["rwa_kobo"]))
			if rwa > 0 {
				carPct = round1(equity / rwa * 100)
			}
		}
		result["car_pct"] = carPct
		result["cbn_thresholds"].(map[string]any)["car_min_pct"] = 10.0

		// H7: breach detection — NPL and PAR90 are max thresholds (breach if above).
		// CAR is a min threshold (breach if below).
		type breach struct {
			RatioType string  `json:"ratio_type"`
			Value     float64 `json:"value"`
			Threshold float64 `json:"threshold"`
			Direction string  `json:"direction"`
		}
		var breaches []breach
		if v, ok := result["npl_ratio_pct"].(float64); ok && v > 5.0 {
			breaches = append(breaches, breach{"NPL", v, 5.0, "above_max"})
		}
		if v, ok := result["par90_pct"].(float64); ok && v > 5.0 {
			breaches = append(breaches, breach{"PAR90", v, 5.0, "above_max"})
		}
		if carPct > 0 && carPct < 10.0 {
			breaches = append(breaches, breach{"CAR", carPct, 10.0, "below_min"})
		}
		if breaches == nil {
			breaches = []breach{}
		}
		result["breaches"] = breaches
		if len(breaches) > 0 {
			go NotifyRole(ctx, db, "compliance_head", NotifPayload{
				EventType: "prudential_breach",
				Title:     fmt.Sprintf("%d Prudential Ratio Breach(es) Detected", len(breaches)),
				Body:      "One or more CBN prudential thresholds have been breached. Review required.",
				ActionURL: "/compliance/prudential-ratios",
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result) //nolint:errcheck
	}
}

// ── Phase 12: Credit Bureau Export ───────────────────────────────────────────

func complianceCreditBureauExport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		bureau := qstr(r, "bureau") // CRC or FirstCentral
		if bureau == "" {
			bureau = "CRC"
		}
		month := qstr(r, "month") // YYYY-MM format
		if month == "" {
			now := time.Now().UTC()
			month = fmt.Sprintf("%d-%02d", now.Year(), int(now.Month()))
		}

		// CRC/FirstCentral 40-field export spec (CBN Credit Risk Management guidelines).
		// Monetary fields converted from kobo to Naira in the export.
		rows, err := db.PGQuery(ctx, `
			SELECT
			  la.id                                                AS account_id,
			  c.cif_number,
			  c.full_name,
			  COALESCE(c.bvn, '')                                  AS bvn,
			  COALESCE(c.nin, '')                                  AS nin,
			  COALESCE(c.date_of_birth::text, '')                  AS date_of_birth,
			  COALESCE(c.gender, '')                               AS gender,
			  COALESCE(c.phone, '')                                AS phone,
			  COALESCE(c.email, '')                                AS email,
			  COALESCE(c.address, '')                              AS residential_address,
			  COALESCE(c.state_of_origin, '')                      AS state,
			  COALESCE(c.lga, '')                                  AS lga,
			  COALESCE(c.nationality, 'Nigerian')                  AS nationality,
			  COALESCE(c.employment_status, '')                    AS employment_status,
			  COALESCE(c.employer_name, '')                        AS employer_name,
			  COALESCE(c.employer_address, '')                     AS employer_address,
			  COALESCE(c.monthly_income_kobo, 0) / 100.0           AS monthly_income,
			  'NGN'                                                AS currency,
			  CASE la.loan_type
			    WHEN 'salary'   THEN 'Personal Loan'
			    WHEN 'business' THEN 'Business Loan'
			    ELSE 'Consumer Loan'
			  END                                                  AS account_type,
			  la.id                                                AS account_number,
			  COALESCE(la.loan_amount_kobo, 0) / 100.0             AS credit_limit,
			  COALESCE(la.loan_amount_kobo, 0) / 100.0             AS sanctioned_amount,
			  COALESCE(la.outstanding_balance_kobo, 0) / 100.0     AS outstanding_balance,
			  COALESCE(la.monthly_instalment_kobo, 0) / 100.0      AS instalment_amount,
			  la.created_at::date                                  AS open_date,
			  COALESCE(la.disbursed_at::date::text, '')            AS disbursement_date,
			  COALESCE(la.maturity_date::text, '')                 AS maturity_date,
			  COALESCE(la.next_payment_date::text, '')             AS next_payment_date,
			  COALESCE(la.last_payment_date::text, '')             AS last_payment_date,
			  COALESCE(la.last_payment_amount_kobo, 0) / 100.0     AS last_payment_amount,
			  COALESCE(la.days_past_due, 0)                        AS days_past_due,
			  COALESCE(la.missed_payments_count, 0)                AS missed_payments,
			  CASE
			    WHEN COALESCE(la.days_past_due, 0) = 0   THEN 'CURRENT'
			    WHEN la.days_past_due BETWEEN 1  AND 30  THEN 'WATCHLIST'
			    WHEN la.days_past_due BETWEEN 31 AND 90  THEN 'SUBSTANDARD'
			    WHEN la.days_past_due BETWEEN 91 AND 180 THEN 'DOUBTFUL'
			    ELSE 'LOST'
			  END                                                  AS classification,
			  COALESCE(la.loan_purpose, '')                        AS loan_purpose,
			  COALESCE(la.collateral_type, '')                     AS collateral_type,
			  COALESCE(la.collateral_value_kobo, 0) / 100.0        AS collateral_value,
			  COALESCE(la.interest_rate, 0)                        AS interest_rate,
			  COALESCE(la.tenor_months, 0)                         AS tenor_months,
			  la.status                                            AS account_status,
			  COALESCE(la.closed_at::date::text, '')               AS close_date,
			  la.updated_at::date                                  AS report_date
			FROM loan_accounts la
			JOIN customers c ON c.cif_number = la.cif_number
			WHERE la.status IN ('active', 'closed', 'written_off')
			ORDER BY la.id`)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		fname := fmt.Sprintf("credit_bureau_%s_%s.csv", bureau, month)
		w.Header().Set("Content-Type", "text/csv")
		w.Header().Set("Content-Disposition", `attachment; filename="`+fname+`"`)

		enc := csv.NewWriter(w)
		_ = enc.Write([]string{
			"AccountID", "CIFNumber", "FullName", "BVN", "NIN",
			"DateOfBirth", "Gender", "Phone", "Email", "ResidentialAddress",
			"State", "LGA", "Nationality", "EmploymentStatus", "EmployerName",
			"EmployerAddress", "MonthlyIncome", "Currency", "AccountType", "AccountNumber",
			"CreditLimit", "SanctionedAmount", "OutstandingBalance", "InstalmentAmount",
			"OpenDate", "DisbursementDate", "MaturityDate", "NextPaymentDate", "LastPaymentDate",
			"LastPaymentAmount", "DaysPastDue", "MissedPayments", "Classification",
			"LoanPurpose", "CollateralType", "CollateralValue", "InterestRate", "TenorMonths",
			"AccountStatus", "CloseDate", "ReportDate",
		})
		s := func(v any) string {
			if v == nil {
				return ""
			}
			return fmt.Sprint(v)
		}
		for _, row := range rows {
			_ = enc.Write([]string{
				s(row["account_id"]), s(row["cif_number"]), s(row["full_name"]),
				s(row["bvn"]), s(row["nin"]), s(row["date_of_birth"]),
				s(row["gender"]), s(row["phone"]), s(row["email"]),
				s(row["residential_address"]), s(row["state"]), s(row["lga"]),
				s(row["nationality"]), s(row["employment_status"]), s(row["employer_name"]),
				s(row["employer_address"]), s(row["monthly_income"]), s(row["currency"]),
				s(row["account_type"]), s(row["account_number"]), s(row["credit_limit"]),
				s(row["sanctioned_amount"]), s(row["outstanding_balance"]), s(row["instalment_amount"]),
				s(row["open_date"]), s(row["disbursement_date"]), s(row["maturity_date"]),
				s(row["next_payment_date"]), s(row["last_payment_date"]), s(row["last_payment_amount"]),
				s(row["days_past_due"]), s(row["missed_payments"]), s(row["classification"]),
				s(row["loan_purpose"]), s(row["collateral_type"]), s(row["collateral_value"]),
				s(row["interest_rate"]), s(row["tenor_months"]), s(row["account_status"]),
				s(row["close_date"]), s(row["report_date"]),
			})
		}
		enc.Flush()
	}
}

// ── Phase 12: Bureau Submission Logs ─────────────────────────────────────────

func complianceBureauSubmissionList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, month, bureau, submitted_by, submitted_at, file_name, row_count, notes, status
			FROM bureau_submission_logs
			ORDER BY submitted_at DESC
			LIMIT 200`)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		if rows == nil { rows = []core.Row{} }
		respond(w, rows, "")
	}
}

func complianceBureauSubmissionCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Month     string `json:"month"`
			Bureau    string `json:"bureau"`
			FileName  string `json:"file_name"`
			RowCount  int    `json:"row_count"`
			Notes     string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid body"); return
		}
		if b.Month == "" { respondErr(w, 400, "month is required"); return }

		user := core.UserFromCtx(r.Context())
		submittedBy := ""
		if user != nil { submittedBy = user.FullName }
		if b.Bureau == "" { b.Bureau = "CRC" }

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO bureau_submission_logs (month, bureau, submitted_by, file_name, row_count, notes)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING id, month, bureau, submitted_by, submitted_at, file_name, row_count, notes, status`,
			b.Month, b.Bureau, submittedBy, b.FileName, b.RowCount, b.Notes)
		if err != nil {
			respondErr(w, 500, "Insert failed"); return
		}
		if len(rows) == 0 { respondErr(w, 500, "No row returned"); return }
		respond(w, rows[0], "")
	}
}

// ── Phase 12: DSAR (Data Subject Access Requests) ────────────────────────────

func complianceDSARStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Aggregate counts and last-processed timestamp in one query.
		rows, err := db.PGQuery(ctx, `
			SELECT
			  COUNT(*)                                                          AS total,
			  COUNT(*) FILTER (WHERE status = 'pending')                       AS pending,
			  COUNT(*) FILTER (WHERE status = 'in_progress')                   AS in_progress,
			  COUNT(*) FILTER (WHERE status = 'resolved')                      AS resolved,
			  COUNT(*) FILTER (WHERE status = 'rejected')                      AS rejected,
			  COUNT(*) FILTER (WHERE request_type = 'erasure')                 AS total_erasure,
			  COUNT(*) FILTER (WHERE request_type = 'erasure' AND processed_at IS NOT NULL) AS erasures_processed,
			  COUNT(*) FILTER (WHERE request_type = 'erasure' AND status = 'resolved' AND processed_at IS NULL) AS erasures_pending_purge,
			  MAX(processed_at)                                                AS last_purge_run
			FROM data_subject_requests`)
		if err != nil {
			respondErr(w, 500, "Stats query failed"); return
		}
		if len(rows) == 0 {
			respond(w, map[string]any{
				"total": 0, "pending": 0, "in_progress": 0, "resolved": 0,
				"erasures_pending_purge": 0, "last_purge_run": nil,
			}, "")
			return
		}
		respond(w, rows[0], "")
	}
}

func complianceDSARList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		from, _ := validDate(r, "from")
		to, _   := validDate(r, "to")
		limit := qint(r, "limit", 50, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `
			SELECT d.id, d.subject_cif, d.subject_name, d.subject_email,
			       d.request_type, d.status, d.notes, d.created_at, d.resolved_at,
			       u.full_name AS assigned_to_name
			FROM data_subject_requests d
			LEFT JOIN o3c_users u ON d.assigned_to = u.id
			WHERE 1=1`
		args := []any{}
		n := 1
		if status != "" {
			query += fmt.Sprintf(" AND d.status=$%d", n)
			args = append(args, status)
			n++
		}
		if from != "" {
			query += fmt.Sprintf(" AND d.created_at::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			query += fmt.Sprintf(" AND d.created_at::date <= $%d::date", n)
			args = append(args, to)
			n++
		}
		query += fmt.Sprintf(" ORDER BY d.created_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func complianceDSARCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		SubjectCIF   string `json:"subject_cif"`
		SubjectName  string `json:"subject_name"`
		SubjectEmail string `json:"subject_email"`
		RequestType  string `json:"request_type"` // access, erasure, rectification, portability
		Notes        string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.RequestType == "" {
			respondErr(w, 400, "request_type is required"); return
		}
		rows, err := db.PGQuery(ctx, `
			INSERT INTO data_subject_requests
				(subject_cif, subject_name, subject_email, request_type, notes, status, sla_due_at)
			VALUES ($1,$2,$3,$4,$5,'pending', NOW() + INTERVAL '30 days')
			RETURNING id, request_type, status, created_at, sla_due_at`,
			b.SubjectCIF, b.SubjectName, b.SubjectEmail, b.RequestType, b.Notes)
		if err != nil {
			respondErr(w, 500, "Create failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func complianceDSARUpdate(db *core.DB) http.HandlerFunc {
	type body struct {
		Status     *string `json:"status"`
		Notes      *string `json:"notes"`
		AssignedTo *int64  `json:"assigned_to"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		set := "updated_at=NOW()"
		args := []any{}
		n := 1
		add := func(col string, v any) {
			set += fmt.Sprintf(", %s=$%d", col, n); args = append(args, v); n++
		}
		if b.Status != nil {
			add("status", *b.Status)
			if *b.Status == "resolved" {
				set += ", resolved_at=NOW()"
			}
		}
		if b.Notes != nil      { add("notes", *b.Notes)           }
		if b.AssignedTo != nil { add("assigned_to", *b.AssignedTo) }
		args = append(args, id)
		_, err := db.PGExec(r.Context(), fmt.Sprintf(`UPDATE data_subject_requests SET %s WHERE id=$%d`, set, n), args...)
		if err != nil {
			respondErr(w, 500, "Update failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true}) //nolint:errcheck
	}
}

// ── Phase 12: Retention Schedule ─────────────────────────────────────────────

func complianceRetentionSchedule(_ *core.DB) http.HandlerFunc {
	// Static retention policy per NDPR / CBN guidelines.
	schedule := []map[string]any{
		{"category": "Loan Applications",      "table": "loan_applications",   "retention_years": 7,  "basis": "CBN Prudential Guidelines"},
		{"category": "KYC Documents",          "table": "kyc_documents",        "retention_years": 7,  "basis": "CBN KYC Circular"},
		{"category": "Transaction Records",    "table": "financial_transactions","retention_years": 7,  "basis": "CBN & CAMA"},
		{"category": "Customer PII",           "table": "customers",            "retention_years": 7,  "basis": "NDPR Art. 2.1(1)(b)"},
		{"category": "Audit Logs",             "table": "audit_logs",           "retention_years": 5,  "basis": "CBN Guidelines"},
		{"category": "Compliance Findings",    "table": "compliance_findings",  "retention_years": 10, "basis": "CBN Examination"},
		{"category": "SAR Records",            "table": "sars",                 "retention_years": 10, "basis": "EFCC Act"},
		{"category": "Helpdesk Tickets",       "table": "helpdesk_tickets",     "retention_years": 3,  "basis": "NDPR proportionality"},
		{"category": "Marketing Contacts",     "table": "campaign_contacts",    "retention_years": 2,  "basis": "NDPR consent-based"},
		{"category": "Session Logs",           "table": "user_sessions",        "retention_years": 1,  "basis": "Security best practice"},
	}
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(schedule) //nolint:errcheck
	}
}

// ── DPA Processing Register (P12-07) ──────────────────────────────────────────

func complianceDPARegister(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, _ := validDate(r, "from")
		to, _   := validDate(r, "to")
		limit := qint(r, "limit", 50, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `SELECT d.*, u.full_name AS created_by_name
			 FROM dpa_processing_register d
			 LEFT JOIN o3c_users u ON u.id = d.created_by
			 WHERE 1=1`
		args := []any{}
		n := 1
		if from != "" {
			query += fmt.Sprintf(" AND d.created_at::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			query += fmt.Sprintf(" AND d.created_at::date <= $%d::date", n)
			args = append(args, to)
			n++
		}
		query += fmt.Sprintf(" ORDER BY d.created_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func complianceDPARegisterCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			ProcessingName         string   `json:"processing_name"`
			Purpose                string   `json:"purpose"`
			LegalBasis             string   `json:"legal_basis"`
			DataCategories         []string `json:"data_categories"`
			DataSubjects           string   `json:"data_subjects"`
			Recipients             string   `json:"recipients"`
			ThirdCountryTransfers  bool     `json:"third_country_transfers"`
			RetentionPeriod        string   `json:"retention_period"`
			SecurityMeasures       string   `json:"security_measures"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.ProcessingName == "" || b.Purpose == "" || b.LegalBasis == "" {
			respondErr(w, 400, "processing_name, purpose, legal_basis required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			`INSERT INTO dpa_processing_register
			   (processing_name, purpose, legal_basis, data_categories, data_subjects,
			    recipients, third_country_transfers, retention_period, security_measures, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
			b.ProcessingName, b.Purpose, b.LegalBasis, b.DataCategories, b.DataSubjects,
			b.Recipients, b.ThirdCountryTransfers, b.RetentionPeriod, b.SecurityMeasures, user.ID)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		if len(rows) > 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(201)
			json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
		}
	}
}

func complianceDPARegisterUpdate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		// Use *bool so we can distinguish "field absent" from "field set to false".
		var b struct {
			Status           string `json:"status"`
			DPOReviewed      *bool  `json:"dpo_reviewed"`
			SecurityMeasures string `json:"security_measures"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid body")
			return
		}
		sets := []string{"updated_at=NOW()"}
		args := []any{}
		if b.Status != "" {
			args = append(args, b.Status)
			sets = append(sets, fmt.Sprintf("status=$%d", len(args)))
		}
		if b.DPOReviewed != nil {
			args = append(args, *b.DPOReviewed)
			sets = append(sets, fmt.Sprintf("dpo_reviewed=$%d", len(args)))
		}
		if b.SecurityMeasures != "" {
			args = append(args, b.SecurityMeasures)
			sets = append(sets, fmt.Sprintf("security_measures=$%d", len(args)))
		}
		args = append(args, id)
		_, err := db.PGExec(r.Context(),
			fmt.Sprintf("UPDATE dpa_processing_register SET %s WHERE id=$%d",
				strings.Join(sets, ","), len(args)), args...)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// complianceConcentrationRisk returns the CBN-required concentration risk metrics:
// top obligors by exposure, loan book breakdown by loan type, and employer concentration.
func complianceConcentrationRisk(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Total active loan book for percentage calculations.
		bookRows, _ := db.PGQuery(ctx,
			`SELECT COALESCE(SUM(disbursed_amount_kobo), 0) AS total FROM loan_applications WHERE status='disbursed'`)
		var totalKobo int64
		if len(bookRows) > 0 {
			totalKobo = toInt64(bookRows[0]["total"])
		}

		// Top 10 obligors (by applicant_cif, falling back to applicant_name).
		obligorRows, _ := db.PGQuery(ctx, `
			SELECT
			    COALESCE(NULLIF(applicant_cif,''), applicant_name) AS obligor,
			    applicant_name                                      AS name,
			    SUM(disbursed_amount_kobo)                          AS exposure_kobo,
			    COUNT(*)                                            AS loan_count
			FROM loan_applications
			WHERE status = 'disbursed' AND disbursed_amount_kobo > 0
			GROUP BY 1, 2
			ORDER BY 3 DESC
			LIMIT 10`)

		for i, row := range obligorRows {
			exp := toInt64(row["exposure_kobo"])
			pct := 0.0
			if totalKobo > 0 {
				pct = float64(exp) / float64(totalKobo) * 100
			}
			obligorRows[i]["exposure_pct"] = pct
		}

		// Loan type breakdown (salary, personal, business, etc.)
		typeRows, _ := db.PGQuery(ctx, `
			SELECT
			    COALESCE(NULLIF(loan_type,''), NULLIF(product_type,''), 'Other') AS loan_type,
			    SUM(disbursed_amount_kobo)                                        AS exposure_kobo,
			    COUNT(*)                                                          AS count
			FROM loan_applications
			WHERE status = 'disbursed' AND disbursed_amount_kobo > 0
			GROUP BY 1
			ORDER BY 2 DESC`)

		for i, row := range typeRows {
			exp := toInt64(row["exposure_kobo"])
			pct := 0.0
			if totalKobo > 0 {
				pct = float64(exp) / float64(totalKobo) * 100
			}
			typeRows[i]["exposure_pct"] = pct
		}

		// Employer concentration — top 10 employers.
		// M1: COUNT(DISTINCT applicant_cif) counts unique borrowers per employer, not loans.
		empRows, _ := db.PGQuery(ctx, `
			SELECT
			    COALESCE(NULLIF(employer,''), 'Unknown')          AS employer,
			    SUM(disbursed_amount_kobo)                        AS exposure_kobo,
			    COUNT(DISTINCT NULLIF(applicant_cif,''))          AS borrower_count
			FROM loan_applications
			WHERE status = 'disbursed' AND disbursed_amount_kobo > 0
			GROUP BY 1
			ORDER BY 2 DESC
			LIMIT 10`)

		for i, row := range empRows {
			exp := toInt64(row["exposure_kobo"])
			pct := 0.0
			if totalKobo > 0 {
				pct = float64(exp) / float64(totalKobo) * 100
			}
			empRows[i]["exposure_pct"] = pct
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"total_loan_book_kobo":         totalKobo,
			"cbn_single_obligor_limit_pct": 20,
			"top_obligors":                 obligorRows,
			"by_loan_type":                 typeRows,
			"by_employer":                  empRows,
		})
	}
}

// ── NDPR Erasure Worker ───────────────────────────────────────────────────────

// StartNDPRErasureWorker processes approved data erasure DSARs daily at midnight.
// It anonymizes PII in crm_contacts for the subject CIF and marks each request processed.
func StartNDPRErasureWorker(db *core.DB) {
	for {
		now  := time.Now()
		next := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, now.Location())
		time.Sleep(time.Until(next))
		runNDPRErasure(db)
	}
}

func runNDPRErasure(db *core.DB) {
	ctx := context.Background()
	WorkerBeat(ctx, db, "ndpr_erasure", "running", "", "")

	rows, err := db.PGQuery(ctx, `
		SELECT id, subject_cif
		FROM data_subject_requests
		WHERE request_type = 'erasure'
		  AND status       = 'resolved'
		  AND processed_at IS NULL`)
	if err != nil {
		slog.Error("ndpr_erasure: query failed", "error", err)
		WorkerBeat(ctx, db, "ndpr_erasure", "error", err.Error(), "")
		return
	}

	for _, row := range rows {
		id  := toInt64(row["id"])
		cif := str(row["subject_cif"])

		if cif != "" {
			// C4: anonymise all PII tables inside a single transaction.
			tx, txErr := db.PG.BeginTx(ctx, nil)
			if txErr != nil {
				slog.Error("ndpr_erasure: begin tx failed", "dsar_id", id, "error", txErr)
				continue
			}

			eraseErr := func() error {
				// crm_contacts
				if _, err := tx.ExecContext(ctx, `
					UPDATE crm_contacts
					SET first_name = '[ERASED]',
					    last_name  = '[ERASED]',
					    phone      = NULL,
					    email      = NULL
					WHERE cif_number = $1`, cif); err != nil {
					return fmt.Errorf("crm_contacts: %w", err)
				}
				// customers: full_name, phone, email, bvn confirmed from schema.
				// NOTE: bvn_hash, nin_hash, bvn_encrypted, nin_encrypted not found in schema — skipped.
				if _, err := tx.ExecContext(ctx, `
					UPDATE customers
					SET full_name = '[ERASED]',
					    phone     = '[ERASED]',
					    email     = '[ERASED]',
					    bvn       = '[ERASED]'
					WHERE cif_number = $1`, cif); err != nil {
					// Non-fatal: columns may not all exist in all deployments.
					slog.Warn("ndpr_erasure: customers anonymize warning", "dsar_id", id, "cif", cif, "error", err)
				}
				// loan_applications: applicant_name, applicant_phone confirmed in migration 004.
				// NOTE: applicant_bvn_hash not found in schema — skipped.
				if _, err := tx.ExecContext(ctx, `
					UPDATE loan_applications
					SET applicant_name  = '[ERASED]',
					    applicant_phone = '[ERASED]'
					WHERE applicant_cif = $1`, cif); err != nil {
					slog.Warn("ndpr_erasure: loan_applications warning", "dsar_id", id, "cif", cif, "error", err)
				}
				// NOTE: financial_transactions table not present in schema — skipped.
				// audit_logs: redact the 'changes' JSON where entity_type='customer'.
				// (column is 'changes', not 'action_data' — verified from INSERT in audit log handler)
				if _, err := tx.ExecContext(ctx, `
					UPDATE audit_logs
					SET changes = NULL
					WHERE entity_id = $1 AND entity_type = 'customer'`, cif); err != nil {
					slog.Warn("ndpr_erasure: audit_logs warning", "dsar_id", id, "cif", cif, "error", err)
				}
				// R3: helpdesk_tickets — anonymise subject and customer PII fields.
				if _, err := tx.ExecContext(ctx, `
					UPDATE helpdesk_tickets
					SET subject        = '[ERASED]',
					    customer_name  = '[ERASED]',
					    customer_email = NULL,
					    customer_phone = NULL
					WHERE customer_cif = $1`, cif); err != nil {
					slog.Warn("ndpr_erasure: helpdesk_tickets warning", "dsar_id", id, "cif", cif, "error", err)
				}
				// R3: campaign_contacts — anonymise PII; cif_number becomes the lookup key.
				if _, err := tx.ExecContext(ctx, `
					UPDATE campaign_contacts
					SET first_name = '[ERASED]',
					    last_name  = '[ERASED]',
					    phone      = NULL,
					    email      = NULL,
					    merge_data = NULL
					WHERE cif_number = $1`, cif); err != nil {
					slog.Warn("ndpr_erasure: campaign_contacts warning", "dsar_id", id, "cif", cif, "error", err)
				}
				return nil
			}()

			if eraseErr != nil {
				tx.Rollback() //nolint:errcheck
				slog.Error("ndpr_erasure: anonymize failed", "dsar_id", id, "cif", cif, "error", eraseErr)
				continue
			}
			if err := tx.Commit(); err != nil {
				slog.Error("ndpr_erasure: commit failed", "dsar_id", id, "cif", cif, "error", err)
				continue
			}
		}

		if _, err := db.PGExec(ctx,
			`UPDATE data_subject_requests SET processed_at = NOW() WHERE id = $1`, id); err != nil {
			slog.Error("ndpr_erasure: mark processed failed", "dsar_id", id, "error", err)
			continue
		}

		slog.Info("ndpr_erasure: processed", "dsar_id", id, "cif", cif)
	}

	WorkerBeat(ctx, db, "ndpr_erasure", "ok", fmt.Sprintf("%d request(s) processed", len(rows)), "")
}

// ── AML Rules (C1) ───────────────────────────────────────────────────────────

// complianceListAMLRules lists all AML screening rules from the aml_rules table.
// Returns an empty list gracefully if the table does not yet exist.
func complianceListAMLRules(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, _ := validDate(r, "from")
		to, _   := validDate(r, "to")

		query := `SELECT id, name, description, threshold_kobo, is_active, created_at
			FROM aml_rules WHERE 1=1`
		args := []any{}
		n := 1
		if from != "" {
			query += fmt.Sprintf(" AND created_at::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			query += fmt.Sprintf(" AND created_at::date <= $%d::date", n)
			args = append(args, to)
			n++
		}
		query += " ORDER BY created_at DESC"

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			// Table may not exist yet — return empty list rather than 500.
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]core.Row{}) //nolint:errcheck
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func complianceCreateAMLRule(db *core.DB) http.HandlerFunc {
	type body struct {
		Name           string `json:"name"`
		Description    string `json:"description"`
		ThresholdKobo  int64  `json:"threshold_kobo"`
		RuleType       string `json:"rule_type"`
		IsActive       bool   `json:"is_active"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Name == "" {
			respondErr(w, 422, "name is required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO aml_rules (name, description, threshold_kobo, rule_type, is_active, created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
			RETURNING id, name, threshold_kobo, is_active, created_at`,
			b.Name, b.Description, b.ThresholdKobo, b.RuleType, b.IsActive)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func complianceDeleteAMLRule(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid rule ID")
			return
		}
		res, err := db.PGExec(r.Context(), `DELETE FROM aml_rules WHERE id = $1`, id)
		if err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 404, "Rule not found")
			return
		}
		w.WriteHeader(204)
	}
}

func complianceAMLStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*)                                                  AS total_rules,
			  SUM(CASE WHEN is_active THEN 1 ELSE 0 END)::int          AS active_rules
			FROM aml_rules`)
		if err != nil {
			// Table may not exist yet.
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"total_rules": 0, "active_rules": 0}) //nolint:errcheck
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(first(rows)) //nolint:errcheck
	}
}

// ── M47: AML Engine + SAR Auto-Trigger ───────────────────────────────────────

// RunAMLEngine evaluates active AML rules against yesterday's transactions and
// creates aml_flags for any matches. For high/critical flags it auto-creates a
// SAR draft so compliance staff don't have to manually initiate one.
// Called from the nightly batch job.
func RunAMLEngine(ctx context.Context, db *core.DB) error {
	// Fetch enabled rules
	rules, err := db.PGQuery(ctx, `
		SELECT id, name, rule_type, threshold, period_days, severity
		FROM aml_rules WHERE enabled = TRUE`)
	if err != nil {
		return err
	}

	for _, rule := range rules {
		ruleID := toInt64(rule["id"])
		ruleType := str(rule["rule_type"])
		threshold := toInt64(rule["threshold"])
		severity := str(rule["severity"])

		var matches []core.Row

		switch ruleType {
		case "amount_threshold":
			// Flag individual transactions above threshold
			matches, _ = db.PGQuery(ctx, `
				SELECT la.applicant_cif AS cif, la.applicant_name AS customer_name,
				       lr.amount_kobo, lr.payment_ref AS transaction_ref
				FROM loan_repayments lr
				JOIN loan_applications la ON la.id = lr.loan_id
				WHERE lr.amount_kobo >= $1
				  AND lr.paid_at >= NOW() - INTERVAL '1 day'
				  AND NOT EXISTS (
				    SELECT 1 FROM aml_flags f
				    WHERE f.cif = la.applicant_cif AND f.rule_id = $2
				      AND f.triggered_at >= NOW() - INTERVAL '1 day'
				  )`, threshold, ruleID)

		case "velocity_daily":
			// Flag CIFs with more than threshold transactions in rolling period_days
			periodDays := toInt64(rule["period_days"])
			if periodDays == 0 {
				periodDays = 1
			}
			matches, _ = db.PGQuery(ctx, `
				SELECT la.applicant_cif AS cif, la.applicant_name AS customer_name,
				       COUNT(*) AS tx_count, SUM(lr.amount_kobo) AS amount_kobo,
				       NULL::TEXT AS transaction_ref
				FROM loan_repayments lr
				JOIN loan_applications la ON la.id = lr.loan_id
				WHERE lr.paid_at >= NOW() - ($1 || ' days')::INTERVAL
				GROUP BY la.applicant_cif, la.applicant_name
				HAVING COUNT(*) > $2
				  AND NOT EXISTS (
				    SELECT 1 FROM aml_flags f
				    WHERE f.cif = la.applicant_cif AND f.rule_id = $3
				      AND f.triggered_at >= NOW() - ($1 || ' days')::INTERVAL
				  )`,
				fmt.Sprintf("%d", periodDays), threshold, ruleID)
		}

		for _, m := range matches {
			cif := str(m["cif"])
			amtKobo := toInt64(m["amount_kobo"])
			txRef := str(m["transaction_ref"])
			customerName := str(m["customer_name"])

			flagRows, err := db.PGQuery(ctx, `
				INSERT INTO aml_flags (rule_id, cif, customer_name, amount_kobo,
				             transaction_ref, status, triggered_at)
				VALUES ($1,$2,$3,$4,$5,'open',NOW())
				RETURNING id`,
				ruleID, cif, customerName, amtKobo, txRef)
			if err != nil || len(flagRows) == 0 {
				slog.Error("AML: flag insert failed", "rule", rule["name"], "cif", cif, "err", err)
				continue
			}
			flagID := toInt64(flagRows[0]["id"])

			// Notify compliance team
			go NotifyRole(ctx, db, "compliance_head", NotifPayload{
				EventType: EvtAMLWatchlistHit,
				Title:     "AML Flag: " + str(rule["name"]),
				Body:      fmt.Sprintf("CIF %s triggered rule '%s'", cif, rule["name"]),
				ActionURL: fmt.Sprintf("/compliance/aml-rules?flag=%d", flagID),
			})

			// M47: auto-create SAR draft for high/critical severity flags
			if severity == "high" || severity == "critical" {
				seqRows, _ := db.PGQuery(ctx, `SELECT nextval('sar_ref_seq') AS seq`)
				if len(seqRows) == 0 {
					continue
				}
				sarRef := fmt.Sprintf("SAR-%04d", toInt64(seqRows[0]["seq"]))
				summary := fmt.Sprintf("Auto-triggered by AML rule '%s'. CIF: %s. Amount: ₦%.2f",
					rule["name"], cif, float64(amtKobo)/100)
				summaryEnc, _ := encryptValue(summary)
				nameEnc, _ := encryptValue(customerName)

				sarRows, err := db.PGQuery(ctx, `
					INSERT INTO sars (sar_ref, subject_name_encrypted, account_number,
					         amount_kobo, summary_encrypted, status, created_at, updated_at)
					VALUES ($1,$2,$3,$4,$5,'draft',NOW(),NOW())
					RETURNING id, sar_ref`,
					sarRef, nameEnc, cif, amtKobo, summaryEnc)
				if err != nil {
					slog.Error("AML: auto-SAR create failed", "flag", flagID, "err", err)
					continue
				}
				// Link flag to SAR and mark as escalated
				if len(sarRows) > 0 {
					newSARID := toInt64(sarRows[0]["id"])
					db.PGExec(ctx, //nolint:errcheck
						`UPDATE aml_flags SET status='escalated',
						   notes=$1 WHERE id=$2`,
						fmt.Sprintf("Auto-SAR created: %s (id=%d)", sarRef, newSARID), flagID)
					slog.Info("AML: auto-SAR created", "sar_ref", sarRef, "flag", flagID)
				}
			}
		}
	}
	return nil
}

// ── KYC Expiry (C2) ──────────────────────────────────────────────────────────

// complianceListKYCExpiry returns customers whose KYC is expiring within 90 days.
// Queries the kyc_records table; returns empty list gracefully if absent.
func complianceListKYCExpiry(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, _ := validDate(r, "from")
		to, _   := validDate(r, "to")

		query := `SELECT
			  k.cif_number,
			  c.full_name      AS customer_name,
			  k.expiry_date    AS kyc_expiry_date,
			  (k.expiry_date::date - CURRENT_DATE)::int AS days_until_expiry,
			  k.status
			FROM kyc_records k
			LEFT JOIN customers c ON c.cif_number = k.cif_number
			WHERE k.expiry_date IS NOT NULL
			  AND k.expiry_date::date <= CURRENT_DATE + INTERVAL '90 days'`
		args := []any{}
		n := 1
		if from != "" {
			query += fmt.Sprintf(" AND k.expiry_date::date >= $%d::date", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			query += fmt.Sprintf(" AND k.expiry_date::date <= $%d::date", n)
			args = append(args, to)
			n++
		}
		query += " ORDER BY k.expiry_date ASC"

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			// kyc_records may not exist yet — return empty list.
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]core.Row{}) //nolint:errcheck
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows) //nolint:errcheck
	}
}

func complianceKYCExpiryAction(db *core.DB) http.HandlerFunc {
	type body struct {
		Action        string `json:"action"`          // extend | flag | suspend
		Notes         string `json:"notes"`
		NewExpiryDate string `json:"new_expiry_date"` // required for extend
	}
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Action == "" {
			respondErr(w, 422, "action is required (extend|flag|suspend)")
			return
		}

		var sets string
		var args []any

		switch b.Action {
		case "extend":
			if b.NewExpiryDate == "" {
				respondErr(w, 422, "new_expiry_date is required for action=extend")
				return
			}
			sets = "expiry_date=$1, status='active', notes=$2, updated_at=NOW()"
			args = []any{b.NewExpiryDate, b.Notes, cif}
		case "flag":
			sets = "status='flagged', notes=$1, updated_at=NOW()"
			args = []any{b.Notes, cif}
		case "suspend":
			sets = "status='suspended', notes=$1, updated_at=NOW()"
			args = []any{b.Notes, cif}
		default:
			respondErr(w, 422, "action must be one of: extend, flag, suspend")
			return
		}

		res, err := db.PGExec(r.Context(),
			fmt.Sprintf("UPDATE kyc_records SET %s WHERE cif_number=$%d", sets, len(args)), args...)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 404, "KYC record not found for CIF "+cif)
			return
		}
		respondOK(w, "KYC action applied: "+b.Action)
	}
}

// ── R4: Data Breach Incident Management ──────────────────────────────────────

func complianceListBreachIncidents(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT i.*,
			       u.full_name  AS reported_by_name,
			       au.full_name AS assigned_name
			FROM data_breach_incidents i
			LEFT JOIN o3c_users u  ON u.id = i.reported_by
			LEFT JOIN o3c_users au ON au.id = i.assigned_to
			ORDER BY i.discovered_at DESC
			LIMIT 200`)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "")
	}
}

func complianceCreateBreachIncident(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Title            string   `json:"title"`
			Description      string   `json:"description"`
			DiscoveredAt     string   `json:"discovered_at"`
			AffectedRecords  *int     `json:"affected_records"`
			DataCategories   []string `json:"data_categories"`
			BreachType       string   `json:"breach_type"`
			Severity         string   `json:"severity"`
			AssignedTo       *int64   `json:"assigned_to"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.Title == "" {
			respondErr(w, 422, "title is required"); return
		}
		user := core.UserFromCtx(r.Context())
		if b.BreachType == "" {
			b.BreachType = "unauthorized_access"
		}
		if b.Severity == "" {
			b.Severity = "medium"
		}
		discoveredAt := b.DiscoveredAt
		if discoveredAt == "" {
			discoveredAt = time.Now().UTC().Format(time.RFC3339)
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO data_breach_incidents
			  (title, description, discovered_at, affected_records, data_categories,
			   breach_type, severity, reported_by, assigned_to)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			RETURNING *`,
			b.Title, b.Description, discoveredAt, b.AffectedRecords, b.DataCategories,
			b.BreachType, b.Severity, user.ID, b.AssignedTo)
		if err != nil {
			respondErr(w, 500, "Create failed"); return
		}
		// Fire EvtBreach notification to compliance head.
		go NotifyRole(r.Context(), db, "head_compliance", NotifPayload{
			EventType: "data_breach",
			Title:     fmt.Sprintf("Data Breach Incident Reported: %s", b.Title),
			Body:      fmt.Sprintf("A data breach incident has been reported. NDPC must be notified within 72 hours. Severity: %s", b.Severity),
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func complianceUpdateBreachIncident(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b struct {
			Status             string   `json:"status"`
			ContainmentSteps   string   `json:"containment_steps"`
			RemediationSteps   string   `json:"remediation_steps"`
			NDPCNotified       *bool    `json:"ndpc_notified"`
			NDPCRefNumber      string   `json:"ndpc_ref_number"`
			AssignedTo         *int64   `json:"assigned_to"`
			AffectedRecords    *int     `json:"affected_records"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		sets := []string{"updated_at=NOW()"}
		args := []any{}
		n := 1
		add := func(col string, val any) { sets = append(sets, fmt.Sprintf("%s=$%d", col, n)); args = append(args, val); n++ }
		if b.Status != "" { add("status", b.Status) }
		if b.ContainmentSteps != "" { add("containment_steps", b.ContainmentSteps) }
		if b.RemediationSteps != "" { add("remediation_steps", b.RemediationSteps) }
		if b.NDPCNotified != nil && *b.NDPCNotified {
			add("ndpc_notified", true)
			add("ndpc_notified_at", time.Now().UTC())
		}
		if b.NDPCRefNumber != "" { add("ndpc_ref_number", b.NDPCRefNumber) }
		if b.AssignedTo != nil { add("assigned_to", *b.AssignedTo) }
		if b.AffectedRecords != nil { add("affected_records", *b.AffectedRecords) }
		if b.Status == "closed" { add("closed_at", time.Now().UTC()) }
		args = append(args, id)
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("UPDATE data_breach_incidents SET %s WHERE id=$%d RETURNING *",
				strings.Join(sets, ","), n), args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Incident not found"); return
		}
		respond(w, rows[0], "")
	}
}

// ── DSAR Assignment (H6) ─────────────────────────────────────────────────────

// ── M34: Board Pack ──────────────────────────────────────────────────────────

// complianceBoardPack returns the key KPIs for a board pack summary.
// ?month=YYYY-MM selects the reporting month (defaults to previous calendar month).
// ?format=html returns a print-optimised HTML page suitable for browser PDF export.
func complianceBoardPack(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Parse month param — default to previous month
		monthParam := r.URL.Query().Get("month")
		var refTime time.Time
		if monthParam != "" {
			t, err := time.Parse("2006-01", monthParam)
			if err != nil {
				respondErr(w, 400, "month must be YYYY-MM")
				return
			}
			refTime = t
		} else {
			refTime = time.Now().AddDate(0, -1, 0)
		}
		monthLabel := refTime.Format("January 2006")
		ctx := r.Context()

		type Metric struct {
			Label string `json:"label"`
			Value string `json:"value"`
		}
		var metrics []Metric

		// Loan book
		if rows, err := db.PGQuery(ctx, `
			SELECT
			    COUNT(*) FILTER (WHERE status NOT IN ('declined','draft')) AS total_apps,
			    COALESCE(SUM(amount_approved_kobo) FILTER (WHERE status='active'),0) AS book_kobo,
			    COUNT(*) FILTER (WHERE status='active') AS active_loans,
			    COALESCE(SUM(amount_approved_kobo) FILTER (
			        WHERE status='active' AND GREATEST(0, CURRENT_DATE - booked_at::date) > 30),0) AS par30_kobo
			FROM loan_applications`); err == nil && len(rows) > 0 {
			row := rows[0]
			bookKobo := toInt64(row["book_kobo"])
			par30Kobo := toInt64(row["par30_kobo"])
			par30Pct := 0.0
			if bookKobo > 0 {
				par30Pct = float64(par30Kobo) / float64(bookKobo) * 100
			}
			metrics = append(metrics,
				Metric{"Active Loans", fmt.Sprintf("%d", toInt64(row["active_loans"]))},
				Metric{"Loan Book (₦)", fmt.Sprintf("%.2f", float64(bookKobo)/100)},
				Metric{"PAR30 (%)", fmt.Sprintf("%.1f%%", par30Pct)},
				Metric{"Total Applications", fmt.Sprintf("%d", toInt64(row["total_apps"]))},
			)
		}

		// Fixed deposits
		if rows, err := db.PGQuery(ctx, `
			SELECT COUNT(*) AS fd_count,
			       COALESCE(SUM(principal),0) AS total_principal
			FROM fd_transactions WHERE transaction_type='inflow'`); err == nil && len(rows) > 0 {
			row := rows[0]
			metrics = append(metrics,
				Metric{"FD Count", fmt.Sprintf("%d", toInt64(row["fd_count"]))},
				Metric{"FD Book (₦)", fmt.Sprintf("%.2f", toFloat64(row["total_principal"]))},
			)
		}

		// Collections: overdue accounts
		if rows, err := db.PGQuery(ctx, `
			SELECT COUNT(*) AS dpd30 FROM loan_applications
			WHERE status='active' AND GREATEST(0, CURRENT_DATE - booked_at::date) > 30`); err == nil && len(rows) > 0 {
			metrics = append(metrics, Metric{"Accounts DPD>30", fmt.Sprintf("%d", toInt64(rows[0]["dpd30"]))})
		}

		// Open support tickets
		if rows, err := db.PGQuery(ctx, `
			SELECT COUNT(*) AS c FROM helpdesk_tickets WHERE status NOT IN ('resolved','closed')`); err == nil && len(rows) > 0 {
			metrics = append(metrics, Metric{"Open Support Tickets", fmt.Sprintf("%d", toInt64(rows[0]["c"]))})
		}

		// Open compliance findings
		if rows, err := db.PGQuery(ctx, `
			SELECT COUNT(*) AS c FROM compliance_findings WHERE status NOT IN ('closed')`); err == nil && len(rows) > 0 {
			metrics = append(metrics, Metric{"Open Compliance Findings", fmt.Sprintf("%d", toInt64(rows[0]["c"]))})
		}

		// Open SARs
		if rows, err := db.PGQuery(ctx, `
			SELECT COUNT(*) AS c FROM sars WHERE status NOT IN ('filed','closed')`); err == nil && len(rows) > 0 {
			metrics = append(metrics, Metric{"Pending SARs", fmt.Sprintf("%d", toInt64(rows[0]["c"]))})
		}

		if r.URL.Query().Get("format") == "html" {
			rowsHTML := ""
			for _, m := range metrics {
				rowsHTML += fmt.Sprintf(
					`<tr><td class="label">%s</td><td class="value">%s</td></tr>`,
					m.Label, m.Value)
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			fmt.Fprintf(w, `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>O3 Capital Board Pack — %s</title>
<style>
 @media print { @page { size: A4; margin: 20mm; } }
 body { font-family: DM Sans, sans-serif; max-width: 720px; margin: 40px auto; color: #1E293B }
 h1 { color: #0E2841; margin-bottom: 4px; font-size: 22px }
 .subtitle { color: #64748B; font-size: 13px; margin-bottom: 24px }
 table { width: 100%%; border-collapse: collapse }
 th { background: #0E2841; color: white; padding: 10px 16px; text-align: left; font-size: 12px }
 th:last-child { text-align: right }
 td { padding: 10px 16px; border-bottom: 1px solid #E2E8F0; font-size: 14px }
 td.value { text-align: right; font-weight: 600; font-family: DM Mono, monospace }
 .footer { margin-top: 24px; font-size: 11px; color: #94A3B8 }
 .print-btn { margin-bottom: 20px; padding: 8px 16px; background: #0E2841; color: white;
              border: none; border-radius: 6px; cursor: pointer; font-size: 13px }
 @media print { .print-btn { display: none } }
</style></head><body>
<button class="print-btn" onclick="window.print()">Download PDF</button>
<h1>O3 Capital Board Pack</h1>
<div class="subtitle">%s — Key Performance Indicators</div>
<table>
 <thead><tr><th>Metric</th><th>Value</th></tr></thead>
 <tbody>%s</tbody>
</table>
<div class="footer">Auto-generated by O3 Capital Workspace on %s</div>
</body></html>`, monthLabel, monthLabel, rowsHTML, time.Now().Format("2 January 2006"))
			return
		}

		respond(w, map[string]any{
			"month":   monthLabel,
			"metrics": metrics,
		}, "")
	}
}

// ── DSAR Assignment (H6) ─────────────────────────────────────────────────────

func complianceDSARAssign(db *core.DB) http.HandlerFunc {
	type body struct {
		AssignedTo int64 `json:"assigned_to"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AssignedTo == 0 {
			respondErr(w, 422, "assigned_to is required")
			return
		}
		_, err := db.PGExec(r.Context(), `
			UPDATE data_subject_requests SET assigned_to=$1, updated_at=NOW() WHERE id=$2`,
			b.AssignedTo, id)
		if err != nil {
			respondErr(w, 500, "Assign failed")
			return
		}
		// Return the assignee name for immediate UI feedback.
		userRows, _ := db.PGQuery(r.Context(),
			`SELECT full_name FROM o3c_users WHERE id=$1`, b.AssignedTo)
		assignedName := ""
		if len(userRows) > 0 {
			assignedName = str(userRows[0]["full_name"])
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"ok":             true,
			"assigned_to":    b.AssignedTo,
			"assigned_name":  assignedName,
		}) //nolint:errcheck
	}
}
