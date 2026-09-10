package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

func RegisterRecoveryOps(r chi.Router, db *core.DB) {
	base := core.RequirePages("recovery")
	assign := core.RequirePages("recovery_assign")
	writeOff := core.RequirePages("recovery_write_off")

	r.With(base).Get("/cases", recoveryOpsCases(db))
	r.With(base).Get("/repayment-pattern", repaymentPatternHandler(db))
	r.With(base).Get("/cases/{id}", recoveryOpsCaseDetail(db))
	r.With(base).Get("/cases/{id}/full", recoveryOpsCaseDetailFull(db))
	r.With(assign).Put("/cases/{id}/assign", recoveryOpsAssign(db))
	r.With(base).Post("/cases/{id}/payment", recoveryOpsPayment(db))
	r.With(base).Post("/cases/{id}/legal", recoveryOpsAddLegal(db))
	r.With(base).Put("/legal/{lid}/status", recoveryOpsUpdateLegal(db))
	r.With(base).Get("/visits", recoveryOpsVisitsList(db))
	r.With(base).Post("/cases/{id}/visit", recoveryOpsVisit(db))
	r.With(base).Post("/cases/{id}/write-off", recoveryOpsWriteOff(db))
	r.With(writeOff).Put("/write-off/{wid}/approve", recoveryOpsApproveWriteOff(db))
	r.With(writeOff).Put("/write-off/{wid}/reject", recoveryOpsRejectWriteOff(db))
	r.With(base).Get("/payments/pending", recoveryOpsPendingPayments(db))
	r.With(base).Put("/payments/{pid}/approve", recoveryOpsApprovePayment(db))
	r.With(base).Put("/payments/{pid}/reject", recoveryOpsRejectPayment(db))
	r.With(base).Get("/dashboard", recoveryOpsDashboard(db))
	r.With(base).Get("/agent-dashboard", recoveryOpsAgentDashboard(db))
	r.With(base).Get("/agents", recoveryOpsAgents(db))
	r.With(assign).Post("/generate-cases", recoveryOpsGenerateCases(db))
	r.With(assign).Post("/cases", recoveryOpsOpenCase(db))
}

// recoveryOpsAgents returns the staff who can own recovery cases. As with Collections,
// there may be no users holding a dedicated recovery role yet, so the pool is broadened
// to any recovery/collections/call-centre operative plus admin/management — otherwise
// the assign dropdown would be permanently empty. Read by the Cases page.
func recoveryOpsAgents(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, full_name, role
			FROM o3c_users
			WHERE is_active = TRUE
			  AND (role ILIKE '%recovery%' OR role ILIKE '%collection%' OR role ILIKE '%call_center%'
			       OR role IN ('admin','management','coo','head_ops','md'))
			ORDER BY full_name`)
		if err != nil {
			respondErrLog(w, 500, "recovery agents query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// escalateSevereToRecovery opens a recovery case for every customer at/beyond minDPD
// in the unified delinquency book who is not already in an open case, then moves any
// active collection assignment for an in-recovery customer to 'sent_to_recovery' so
// the account leaves the collections queue (mirroring the manual per-account hand-off).
// Returns the number of NEW cases opened. Idempotent and self-healing — the second
// UPDATE also cleans up accounts escalated before this coupling existed. Shared by the
// head's "Generate Cases" button and the nightly auto-escalation worker.
func escalateSevereToRecovery(ctx context.Context, db *core.DB, minDPD int) (int64, error) {
	res, err := db.PG.ExecContext(ctx, `
		WITH sev AS (
			SELECT v.cif, MAX(v.dpd) AS dpd, SUM(v.outstanding_kobo) AS outstanding_kobo,
			       (SELECT ca.id FROM collection_assignments ca
			        WHERE ca.account_cif = v.cif AND ca.status = 'active'
			        ORDER BY ca.updated_at DESC LIMIT 1) AS assignment_id
			FROM app.collections_delinquent_unified v
			WHERE v.dpd >= $1 AND v.cif IS NOT NULL AND v.cif <> ''
			GROUP BY v.cif
		)
		INSERT INTO recovery_cases
		  (case_ref, cif_number, account_cif, outstanding_kobo, total_outstanding_kobo,
		   source_assignment_id, dpd_at_handoff, status, opened_at, created_at, updated_at)
		SELECT 'RC-' || LPAD(NEXTVAL('sar_ref_seq')::TEXT, 6, '0'),
		       s.cif, s.cif, s.outstanding_kobo, s.outstanding_kobo,
		       -- 'active' (not 'open') to match the UI's status vocabulary + filter.
		       s.assignment_id, s.dpd::text, 'active', NOW(), NOW(), NOW()
		FROM sev s
		WHERE NOT EXISTS (
			SELECT 1 FROM recovery_cases rc
			WHERE rc.account_cif = s.cif AND rc.status NOT IN ('closed','recovered','written_off')
		)`, minDPD)
	if err != nil {
		return 0, err
	}
	created, _ := res.RowsAffected()

	// Take every active collection assignment that is now in an open recovery case out
	// of the collections queue, so no account is worked by both teams at once.
	if _, err := db.PG.ExecContext(ctx, `
		UPDATE collection_assignments ca
		   SET status = 'sent_to_recovery', updated_at = NOW()
		 WHERE ca.status = 'active'
		   AND EXISTS (SELECT 1 FROM recovery_cases rc
		               WHERE rc.account_cif = ca.account_cif
		                 AND rc.status NOT IN ('closed','recovered','written_off'))`); err != nil {
		return created, err
	}
	return created, nil
}

// recoveryOpsGenerateCases is Recovery's analogue of Collections' generate-assignments:
// a head-triggered bulk seed at DPD >= min_dpd (default 90). Idempotent. The nightly
// worker (ScheduleRecoveryEscalation) does the same automatically.
func recoveryOpsGenerateCases(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		minDPD := qint(r, "min_dpd", 90, 1, 100000)
		created, err := escalateSevereToRecovery(r.Context(), db, minDPD)
		if err != nil {
			respondErrLog(w, 500, "generate recovery cases failed", err)
			return
		}
		respond(w, core.Row{"created": created, "min_dpd": minDPD}, "pg")
	}
}

// recoveryOpsOpenCase manually moves a specific customer into recovery, regardless of
// DPD — for the accounts a head decides to pull in by hand. Idempotent: returns the
// existing open case if there is one. Pulls the outstanding/DPD snapshot from the
// delinquency view when available, and takes the account out of the collections queue.
func recoveryOpsOpenCase(db *core.DB) http.HandlerFunc {
	type body struct {
		CIF string `json:"cif"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		cif := strings.TrimSpace(b.CIF)
		if cif == "" {
			respondErr(w, 400, "cif is required")
			return
		}
		ctx := r.Context()

		if rows, _ := db.PGQuery(ctx, `SELECT id, case_ref FROM recovery_cases
			WHERE account_cif = $1 AND status NOT IN ('closed','recovered','written_off')
			ORDER BY opened_at DESC LIMIT 1`, cif); len(rows) > 0 {
			respond(w, core.Row{"case_id": rows[0]["id"], "case_ref": rows[0]["case_ref"], "existing": true}, "pg")
			return
		}

		var outstanding int64
		var dpd int
		if rows, _ := db.PGQuery(ctx, `SELECT COALESCE(MAX(dpd),0) AS dpd, COALESCE(SUM(outstanding_kobo),0) AS outstanding
			FROM app.collections_delinquent_unified WHERE cif = $1`, cif); len(rows) > 0 {
			dpd = int(toInt64(rows[0]["dpd"]))
			outstanding = toInt64(rows[0]["outstanding"])
		}

		caseRef, caseID, err := openRecoveryCase(ctx, db, cif, strconv.Itoa(dpd), outstanding, nil)
		if err != nil {
			respondErrLog(w, 500, "open recovery case failed", err)
			return
		}
		// Take the account out of the collections queue if it was being worked there.
		db.PG.ExecContext(ctx, `UPDATE collection_assignments SET status='sent_to_recovery', updated_at=NOW()
			WHERE account_cif=$1 AND status='active'`, cif) //nolint:errcheck

		respond(w, core.Row{"case_id": caseID, "case_ref": caseRef, "existing": false}, "pg")
	}
}

// ScheduleRecoveryEscalation runs daily at 02:00 and automatically opens recovery
// cases for any account that has crossed 90 DPD and is not already in recovery,
// moving it out of the collections queue. Manual hand-off still works alongside it:
// per-account "Send to Recovery" in Collections, the head's "Generate Cases" bulk
// button, and "Add Customer" for a specific CIF.
func ScheduleRecoveryEscalation(db *core.DB) {
	now := time.Now()
	next := time.Date(now.Year(), now.Month(), now.Day(), 2, 0, 0, 0, now.Location())
	if now.After(next) {
		next = next.Add(24 * time.Hour)
	}
	time.Sleep(next.Sub(now))
	for {
		runRecoveryEscalation(db)
		time.Sleep(24 * time.Hour)
	}
}

func runRecoveryEscalation(db *core.DB) {
	ctx := context.Background()
	WorkerBeat(ctx, db, "recovery_escalation", "running", "", "")
	created, err := escalateSevereToRecovery(ctx, db, 90)
	if err != nil {
		slog.Error("recovery auto-escalation failed", "err", err)
		WorkerBeat(ctx, db, "recovery_escalation", "error", err.Error(), "")
		return
	}
	slog.Info("recovery auto-escalation swept", "cases_opened", created)
	WorkerBeat(ctx, db, "recovery_escalation", "ok", fmt.Sprintf("%d case(s) opened at 90+ DPD", created), "")
}

func recoveryOpsCases(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		status := qstr(r, "status")
		legalStage := qstr(r, "legal_stage")
		productType := qstr(r, "product_type") // 'card' | 'loan'
		agentID := qstr(r, "agent_id")
		q := qstr(r, "q")
		from := qstr(r, "from")
		to := qstr(r, "to")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `
			SELECT rc.id, rc.case_ref, rc.account_cif,
			       -- The row's own customer_name wins first (loans have no CIF to join a
			       -- name from), then the CIF-joined name, then the raw account id.
			       COALESCE(NULLIF(TRIM(rc.customer_name),''), NULLIF(TRIM(CONCAT(c.first_name,' ',c.last_name)),''), rc.account_cif) AS customer_name,
			       COALESCE(rc.product_type,'card') AS product_type,
			       COALESCE(rc.data_source,'core') AS data_source,
			       rc.officer_name, rc.loan_ref, rc.loan_amount_kobo, rc.maturity_date,
			       rc.assigned_agent_id,
			       u.full_name AS agent_name, rc.assigned_by, rc.legal_stage,
			       rc.outstanding_kobo, rc.recovered_kobo, rc.write_off_amount_kobo,
			       rc.status, rc.opened_at, rc.closed_at, rc.created_at, rc.updated_at,
			       -- Per-row enrichment: clean address, card billing, last payment and
			       -- the collections agent who worked it before hand-off — same picture
			       -- Customer 360 carries. app.accounts money is NAIRA, not kobo.
			       COALESCE(NULLIF(TRIM(c.full_address),''),
			                NULLIF(TRIM(CONCAT_WS(', ', NULLIF(c.address_1,''), NULLIF(c.address_2,''), NULLIF(c.city,''), NULLIF(c.state,''))),'')) AS full_address,
			       c.city, c.state, c.phone,
			       bill.current_dr_balance AS current_bill,
			       bill.cycle_balance      AS bill_balance,
			       bill.min_payment_due    AS min_payment,
			       bill.card_limit         AS credit_limit,
			       bill.last_amount_paid   AS last_payment_amount,
			       bill.last_payment_date,
			       col.collections_agent_name,
			       lc.agent_name  AS last_call_agent,
			       lc.started_at::text AS last_call_at
			FROM recovery_cases rc
			LEFT JOIN o3c_users u ON rc.assigned_agent_id = u.id
			LEFT JOIN app.customers c ON c.cif = rc.account_cif
			LEFT JOIN LATERAL (
			    SELECT a2.current_dr_balance, a2.cycle_balance, a2.min_payment_due,
			           a2.card_limit, a2.last_amount_paid,
			           a2.last_payment_date::text AS last_payment_date
			    FROM app.accounts a2 WHERE a2.cif = rc.account_cif
			    ORDER BY (LOWER(a2.status) IN ('active','open')) DESC LIMIT 1
			) bill ON TRUE
			LEFT JOIN LATERAL (
			    SELECT cu.full_name AS collections_agent_name
			    FROM collection_assignments ca2
			    LEFT JOIN o3c_users cu ON cu.id = ca2.agent_user_id
			    WHERE ca2.account_cif = rc.account_cif AND ca2.status = 'active'
			    ORDER BY ca2.updated_at DESC LIMIT 1
			) col ON TRUE
			-- Last call-centre call for this customer (card cases carry a real CIF; a
			-- direct customer_cif match keeps this index-friendly for the 50-row page).
			LEFT JOIN LATERAL (
			    SELECT h.agent_name, h.started_at
			    FROM app.helpdesk_calls h
			    WHERE h.customer_cif = rc.account_cif
			      AND h.merged_into_call_id IS NULL AND h.voided_at IS NULL
			    ORDER BY h.started_at DESC LIMIT 1
			) lc ON TRUE
			WHERE 1=1`
		args := []any{}
		n := 1
		where := ""

		// Individual agents see only their own cases; heads/managers see all.
		if !user.HasPage("recovery_assign") {
			where += fmt.Sprintf(" AND rc.assigned_agent_id = $%d", n)
			args = append(args, user.ID)
			n++
		}

		if status != "" {
			vals := strings.Split(status, ",")
			placeholders := make([]string, len(vals))
			for i, v := range vals {
				placeholders[i] = fmt.Sprintf("$%d", n)
				args = append(args, strings.TrimSpace(v))
				n++
			}
			where += " AND rc.status IN (" + strings.Join(placeholders, ",") + ")"
		}
		if legalStage != "" {
			where += fmt.Sprintf(" AND rc.legal_stage = $%d", n)
			args = append(args, legalStage)
			n++
		}
		if productType != "" {
			where += fmt.Sprintf(" AND COALESCE(rc.product_type,'card') = $%d", n)
			args = append(args, productType)
			n++
		}
		if agentID != "" {
			where += fmt.Sprintf(" AND rc.assigned_agent_id = $%d", n)
			args = append(args, agentID)
			n++
		}
		if q != "" {
			// Search must cover the SAME name the row DISPLAYS. When rc.customer_name is
			// blank the shown name comes from the joined app.customers first/last name, so
			// searching it must ILIKE that joined name too — otherwise a visible name
			// returns zero hits (mirrors the Collections list, which already does this).
			if clause, sargs, nn := buildCustomerSearch(q,
				[]string{"rc.account_cif", "rc.customer_name", "CONCAT(c.first_name,' ',c.last_name)", "rc.officer_name", "rc.loan_ref"}, "c.phone", n); clause != "" {
				where += " AND " + clause
				args = append(args, sargs...)
				n = nn
			}
		}
		if from != "" {
			where += fmt.Sprintf(" AND rc.opened_at::date >= $%d", n)
			args = append(args, from)
			n++
		}
		if to != "" {
			where += fmt.Sprintf(" AND rc.opened_at::date <= $%d", n)
			args = append(args, to)
			n++
		}

		// Total matching the current filters (before pagination) so the UI shows the
		// whole queue size, not just the current page.
		total := 0
		// Must carry the SAME app.customers join as the list query — the search clause
		// below matches the joined first/last name, so the count query needs `c` too or
		// it 500s on an unknown alias (and would otherwise miss the same rows).
		if crows, cerr := db.PGQuery(r.Context(),
			`SELECT COUNT(*) AS n FROM recovery_cases rc
			 LEFT JOIN app.customers c ON c.cif = rc.account_cif
			 WHERE 1=1`+where, args...); cerr == nil && len(crows) > 0 {
			total = int(toInt64(crows[0]["n"]))
		}

		query += where + fmt.Sprintf(" ORDER BY rc.updated_at DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respondPaginated(w, rows, total, "pg")
	}
}

func recoveryOpsCaseDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		ctx := r.Context()

		cases, err := db.PGQuery(ctx, `
			SELECT rc.*, u.full_name AS agent_name
			FROM recovery_cases rc
			LEFT JOIN o3c_users u ON rc.assigned_agent_id = u.id
			WHERE rc.id = $1`, id)
		if err != nil || len(cases) == 0 {
			respondErr(w, 404, "Case not found")
			return
		}

		payments, _ := db.PGQuery(ctx, `
			SELECT * FROM recovery_payments WHERE case_id = $1 AND status = 'approved' ORDER BY payment_date DESC`, id)
		proceedings, _ := db.PGQuery(ctx, `
			SELECT * FROM legal_proceedings WHERE case_id = $1 ORDER BY filing_date DESC`, id)
		visits, _ := db.PGQuery(ctx, `
			SELECT rfv.*, u.full_name AS agent_name
			FROM recovery_field_visits rfv
			LEFT JOIN o3c_users u ON rfv.agent_user_id = u.id
			WHERE rfv.case_id = $1 ORDER BY rfv.visit_date DESC`, id)
		writeoffs, _ := db.PGQuery(ctx, `
			SELECT * FROM recovery_write_off_approvals WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`, id)

		nilToEmpty := func(rows []core.Row) []core.Row {
			if rows == nil {
				return []core.Row{}
			}
			return rows
		}

		result := map[string]any{
			"case":        cases[0],
			"payments":    nilToEmpty(payments),
			"proceedings": nilToEmpty(proceedings),
			"visits":      nilToEmpty(visits),
		}
		if len(writeoffs) > 0 {
			result["write_off_approval"] = writeoffs[0]
		} else {
			result["write_off_approval"] = nil
		}

		respond(w, result, "pg")
	}
}

// recoveryOpsCaseDetailFull returns everything recoveryOpsCaseDetail returns, plus
// the full cross-team credit_activity_log for the account CIF so agents can see
// the complete lifecycle including the collections phase.
func recoveryOpsCaseDetailFull(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		ctx := r.Context()

		cases, err := db.PGQuery(ctx, `
			SELECT rc.*, u.full_name AS agent_name, au.full_name AS assigned_by_name
			FROM recovery_cases rc
			LEFT JOIN o3c_users u  ON rc.assigned_agent_id = u.id
			LEFT JOIN o3c_users au ON rc.assigned_by = au.id
			WHERE rc.id = $1`, id)
		if err != nil || len(cases) == 0 {
			respondErr(w, 404, "Case not found")
			return
		}

		cif := fmt.Sprint(cases[0]["account_cif"])

		payments, _ := db.PGQuery(ctx, `SELECT rp.*, u.full_name AS agent_name FROM recovery_payments rp LEFT JOIN o3c_users u ON rp.agent_user_id = u.id WHERE rp.case_id = $1 ORDER BY rp.payment_date DESC`, id)
		proceedings, _ := db.PGQuery(ctx, `SELECT * FROM legal_proceedings WHERE case_id = $1 ORDER BY filing_date DESC`, id)
		visits, _ := db.PGQuery(ctx, `
			SELECT rfv.*, u.full_name AS agent_name
			FROM recovery_field_visits rfv
			LEFT JOIN o3c_users u ON rfv.agent_user_id = u.id
			WHERE rfv.case_id = $1 ORDER BY rfv.visit_date DESC`, id)
		writeoffs, _ := db.PGQuery(ctx, `
			SELECT rwo.*, u.full_name AS approver_name
			FROM recovery_write_off_approvals rwo
			LEFT JOIN o3c_users u ON rwo.approved_by = u.id
			WHERE rwo.case_id = $1 ORDER BY rwo.created_at DESC LIMIT 1`, id)

		// Full cross-team activity log for this CIF (collections + recovery phases,
		// incl. the write-off request + every approval stage).
		//
		// The real columns are `description`, `ts` and `actor_name` — this query used to
		// select `detail`, `created_at` and join on `actor_user_id`, none of which exist,
		// so it errored on every call and the case showed NO activity. Aliased back to the
		// field names the frontend expects.
		activityLog, _ := db.PGQuery(ctx, `
			SELECT cal.id, cal.module, cal.entity_type, cal.entity_id, cal.account_cif,
			       cal.action, cal.description AS detail, cal.ts AS created_at, cal.actor_name
			FROM credit_activity_log cal
			WHERE cal.account_cif = $1
			ORDER BY cal.ts DESC
			LIMIT 200`, cif)

		// Collections-phase contacts and promises for context
		contacts, _ := db.PGQuery(ctx, `
			SELECT cc.*, u.full_name AS agent_name
			FROM collection_contacts cc
			LEFT JOIN o3c_users u ON cc.agent_user_id = u.id
			WHERE cc.cif_number = $1 ORDER BY cc.created_at DESC LIMIT 50`, cif)
		promises, _ := db.PGQuery(ctx, `
			SELECT cp.*, u.full_name AS agent_name
			FROM collection_promises cp
			LEFT JOIN o3c_users u ON cp.agent_user_id = u.id
			WHERE cp.cif_number = $1 ORDER BY cp.promised_date DESC LIMIT 20`, cif)

		// Debtor identity + live delinquency snapshot. recovery_cases carries only the
		// CIF, so without this the case page can't show who the person is, how to reach
		// them, or how deep they currently are — the essentials for actually working it.
		// Identity + address + card billing (current bill, balance, min payment, limit,
		// last payment) — the same picture the Cases side-panel shows, so the full page
		// isn't missing it. app.accounts money is NAIRA, not kobo.
		customer := core.Row{}
		if crows, _ := db.PGQuery(ctx, `
			SELECT TRIM(CONCAT(COALESCE(c.first_name,''),' ',COALESCE(c.last_name,''))) AS name,
			       c.phone, c.email, c.state, c.city,
			       COALESCE(NULLIF(TRIM(c.full_address),''),
			                NULLIF(TRIM(CONCAT_WS(', ', NULLIF(c.address_1,''), NULLIF(c.address_2,''), NULLIF(c.city,''), NULLIF(c.state,''))),'')) AS full_address,
			       bill.current_dr_balance AS current_bill,
			       bill.cycle_balance      AS bill_balance,
			       bill.min_payment_due    AS min_payment,
			       bill.card_limit         AS credit_limit,
			       bill.last_amount_paid   AS last_payment_amount,
			       bill.last_payment_date::text AS last_payment_date
			FROM app.customers c
			LEFT JOIN LATERAL (
			    SELECT a2.current_dr_balance, a2.cycle_balance, a2.min_payment_due,
			           a2.card_limit, a2.last_amount_paid, a2.last_payment_date
			    FROM app.accounts a2 WHERE a2.cif = c.cif
			    ORDER BY (LOWER(a2.status) IN ('active','open')) DESC LIMIT 1
			) bill ON TRUE
			WHERE c.cif = $1 LIMIT 1`, cif); len(crows) > 0 {
			customer = crows[0]
		}
		var dpdCurrent, bookOutstanding int64
		if drows, _ := db.PGQuery(ctx, `SELECT COALESCE(MAX(dpd),0) AS dpd, COALESCE(SUM(outstanding_kobo),0) AS outstanding
			FROM app.collections_delinquent_unified WHERE cif = $1`, cif); len(drows) > 0 {
			dpdCurrent = toInt64(drows[0]["dpd"])
			bookOutstanding = toInt64(drows[0]["outstanding"])
		}
		// The customer's actual facilities behind the debt (loans from the CBS book,
		// cards from the account book) so the agent sees what they're recovering against.
		loans, _ := db.PGQuery(ctx, `
			SELECT cbs_account_number AS reference, product_name, status,
			       outstanding_principal_kobo AS outstanding_kobo, loan_amount_kobo,
			       start_date, maturity_date
			FROM cbs_loans WHERE cbs_customer_id = $1
			ORDER BY outstanding_principal_kobo DESC`, cif)

		nilToEmpty := func(rows []core.Row) []core.Row {
			if rows == nil {
				return []core.Row{}
			}
			return rows
		}

		result := map[string]any{
			"case":                  cases[0],
			"customer":              customer,
			"dpd_current":           dpdCurrent,
			"book_outstanding_kobo": bookOutstanding,
			"loans":                 nilToEmpty(loans),
			"payments":              nilToEmpty(payments),
			"proceedings":           nilToEmpty(proceedings),
			"visits":                nilToEmpty(visits),
			"activity_log":          nilToEmpty(activityLog),
			"coll_contacts":         nilToEmpty(contacts),
			"coll_promises":         nilToEmpty(promises),
		}
		if len(writeoffs) > 0 {
			result["write_off_approval"] = writeoffs[0]
		} else {
			result["write_off_approval"] = nil
		}

		respond(w, result, "pg")
	}
}

func recoveryOpsAssign(db *core.DB) http.HandlerFunc {
	type body struct {
		AgentID int64  `json:"agent_id"`
		Notes   string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AgentID == 0 {
			respondErr(w, 422, "agent_id is required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		rows, err := db.PGQuery(ctx, `SELECT id FROM recovery_cases WHERE id = $1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Case not found")
			return
		}

		_, err = db.PGExec(ctx, `
			UPDATE recovery_cases
			SET assigned_agent_id = $1, assigned_by = $2, updated_at = NOW()
			WHERE id = $3`,
			b.AgentID, user.ID, id)
		if err != nil {
			respondErr(w, 500, "Assign failed")
			return
		}

		sendNotification(ctx, db, b.AgentID, "recovery_assigned", //nolint:errcheck
			"Recovery Case Assigned",
			fmt.Sprintf("A recovery case has been assigned to you"),
			"recovery_case", id)

		go NotifyRole(context.Background(), db, "recovery_head", NotifPayload{
			EventType: EvtRecoveryCaseAssigned,
			Title:     "Recovery Case Assigned",
			Body:      fmt.Sprintf("Case #%d has been assigned to an agent", id),
			ActionURL: fmt.Sprintf("/recovery/cases/%d", id),
			EntityRef: fmt.Sprintf("recovery_case:%d", id),
		})

		respondOK(w, "Assigned successfully")
	}
}

func recoveryOpsPayment(db *core.DB) http.HandlerFunc {
	type body struct {
		AmountKobo  int64  `json:"amount_kobo"`
		PaymentDate string `json:"payment_date"`
		Channel     string `json:"channel"`
		Reference   string `json:"reference"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AmountKobo == 0 || b.PaymentDate == "" || b.Channel == "" {
			respondErr(w, 422, "amount_kobo, payment_date and channel are required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Wrap INSERT + UPDATE in a transaction so neither can succeed without the other
		tx, err := db.PG.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
		if err != nil {
			respondErr(w, 500, "Transaction start failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Recovery payments enter the SAME HOP → COO → CFO chain as write-offs: the GL is
		// posted and the case recovered_kobo updated only when the final (CFO) approval lands.
		var payID int64
		var payDate, payChannel, payRef, createdAt any
		err = tx.QueryRowContext(ctx, `
			INSERT INTO recovery_payments (case_id, amount_kobo, payment_date, channel, reference, posted_by, status, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
			RETURNING id, amount_kobo, payment_date, channel, reference, created_at`,
			id, b.AmountKobo, b.PaymentDate, b.Channel, b.Reference, user.ID, writeOffChainStart,
		).Scan(&payID, &b.AmountKobo, &payDate, &payChannel, &payRef, &createdAt)
		if err != nil {
			respondErr(w, 500, "Log payment failed")
			return
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		cif := ""
		if cifRows, _ := db.PGQuery(ctx, `SELECT account_cif FROM recovery_cases WHERE id = $1`, id); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(ctx, db, r, "recovery", "recovery_payment", fmt.Sprint(payID), cif, "payment_logged",
			fmt.Sprintf("Recovery payment of ₦%s submitted via %s — pending approval", fmtKoboStr(b.AmountKobo), b.Channel), nil, map[string]any{"amount_kobo": b.AmountKobo, "channel": b.Channel})
		if firstStage, ok := stageProgressions[writeOffChainStart]; ok {
			NotifyRole(ctx, db, firstStage.required, NotifPayload{
				EventType: "payment_approval_pending",
				Title:     "Recovery payment awaiting approval",
				Body:      fmt.Sprintf("A ₦%s recovery payment needs %s sign-off.", fmtKoboStr(b.AmountKobo), firstStage.label),
				ActionURL: "/collections/recovery-approvals",
				EntityRef: fmt.Sprint(payID),
				Priority:  "high",
			})
		}

		respond(w, core.Row{
			"id":           payID,
			"amount_kobo":  b.AmountKobo,
			"payment_date": payDate,
			"channel":      payChannel,
			"reference":    payRef,
			"status":       writeOffChainStart,
			"created_at":   createdAt,
		}, "pg")
	}
}

func recoveryOpsPendingPayments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			    rp.id, rp.case_id, rc.account_cif,
			    rp.amount_kobo, rp.payment_date, rp.channel, rp.reference,
			    rp.status, rp.created_at,
			    u.full_name AS posted_by_name
			FROM recovery_payments rp
			JOIN recovery_cases rc ON rc.id = rp.case_id
			LEFT JOIN o3c_users u ON u.id = rp.posted_by
			WHERE `+chainStatusClause(qstr(r, "status"), "rp")+`
			ORDER BY rp.created_at DESC
			LIMIT 200`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		// Annotate each with its chain stage + the role due to sign next, so the approvals
		// UI can show "Awaiting COO" and gate the approve button per-stage.
		for _, row := range rows {
			st := str(row["status"])
			row["stage_label"] = writeOffStageLabel(st)
			if prog, ok := stageProgressions[st]; ok {
				row["required_role"] = prog.required
			} else {
				row["required_role"] = ""
			}
		}
		respond(w, rows, "pg")
	}
}

func recoveryOpsApprovePayment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pid, err := strconv.ParseInt(chi.URLParam(r, "pid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid payment ID")
			return
		}
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Fetch the pending payment
		pmtRows, err := db.PGQuery(ctx,
			`SELECT id, case_id, amount_kobo, status, posted_by FROM recovery_payments WHERE id = $1`, pid)
		if err != nil || len(pmtRows) == 0 {
			respondErr(w, 404, "Payment not found")
			return
		}
		pmt := pmtRows[0]
		currentStatus := str(pmt["status"])
		prog, ok := paymentStageProgressions[currentStatus] // payments: HOP → COO (final, posts GL)
		if !ok {
			respondErr(w, 422, fmt.Sprintf("Payment is already '%s' and cannot be advanced", currentStatus))
			return
		}
		if user.Role != prog.required && user.Role != "admin" {
			respondErr(w, 403, fmt.Sprintf("This approval stage requires the '%s' (%s) role", prog.required, prog.label))
			return
		}
		// Self-approval prevention — the person who logged the payment can't sign ANY of its stages.
		postedBy := toInt64(pmt["posted_by"])
		if postedBy == user.ID {
			respondErr(w, 403, "Cannot approve a payment you submitted")
			return
		}
		caseID := toInt64(pmt["case_id"])
		amtKobo := toInt64(pmt["amount_kobo"])
		isFinal := prog.next == "approved"

		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "Transaction start failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Advance the stage. On the final (CFO) approval, stamp approved_by/at; the CAS on
		// status guards against a concurrent double-advance.
		var updatedID int64
		var scanErr error
		if isFinal {
			scanErr = tx.QueryRowContext(ctx, `
				UPDATE recovery_payments SET status = $1, approved_by = $2, approved_at = NOW()
				WHERE id = $3 AND status = $4 RETURNING id`, prog.next, user.ID, pid, currentStatus).Scan(&updatedID)
		} else {
			scanErr = tx.QueryRowContext(ctx, `
				UPDATE recovery_payments SET status = $1
				WHERE id = $2 AND status = $3 RETURNING id`, prog.next, pid, currentStatus).Scan(&updatedID)
		}
		if scanErr == sql.ErrNoRows {
			respondErr(w, 409, "Payment status changed concurrently — please refresh and try again")
			return
		}
		if scanErr != nil {
			respondErr(w, 500, "Update failed")
			return
		}

		// Money moves ONLY at final approval: bump the case recovered totals and post GL.
		if isFinal {
			if _, err = tx.ExecContext(ctx, `
				UPDATE recovery_cases
				SET recovered_kobo = COALESCE(recovered_kobo, 0) + $1,
				    total_recovered_kobo = COALESCE(total_recovered_kobo, 0) + $1,
				    updated_at = NOW()
				WHERE id = $2`, amtKobo, caseID); err != nil {
				respondErr(w, 500, "Update case totals failed")
				return
			}
			if glErr := postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   fmt.Sprintf("Recovery payment approved — payment %d", pid),
				Reference:     fmt.Sprintf("RCOV-PAY-%d", pid),
				DebitAccount:  "1001",
				CreditAccount: "1100",
				AmountKobo:    amtKobo,
				SourceType:    "recovery_payment",
				SourceID:      pid,
				PostedBy:      user.ID,
			}); glErr != nil {
				respondErr(w, 500, "GL post failed")
				return
			}
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}
		cif := ""
		if cifRows, _ := db.PGQuery(ctx, `SELECT account_cif FROM recovery_cases WHERE id = $1`, caseID); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(ctx, db, r, "recovery", "recovery_payment", fmt.Sprint(pid), cif, "payment_approved",
			fmt.Sprintf("Recovery payment of ₦%s — %s", fmtKoboStr(amtKobo), writeOffStageLabel(prog.next)), nil, map[string]any{"stage": prog.next})

		// Notify the next approver, or the submitter on final approval.
		if nextStage, ok := stageProgressions[prog.next]; ok {
			NotifyRole(ctx, db, nextStage.required, NotifPayload{
				EventType: "payment_approval_pending",
				Title:     "Recovery payment awaiting approval",
				Body:      fmt.Sprintf("A ₦%s recovery payment now needs %s sign-off.", fmtKoboStr(amtKobo), nextStage.label),
				ActionURL: "/collections/recovery-approvals",
				EntityRef: fmt.Sprint(pid),
				Priority:  "high",
			})
		} else if isFinal && postedBy > 0 {
			NotifyUsers(ctx, db, []int64{postedBy}, NotifPayload{
				EventType: "payment_approved",
				Title:     "Recovery payment approved",
				Body:      fmt.Sprintf("The ₦%s recovery payment you logged was fully approved and posted.", fmtKoboStr(amtKobo)),
				ActionURL: "/collections/recovery-approvals",
				EntityRef: fmt.Sprint(pid),
				Priority:  "normal",
			})
		}
		respond(w, map[string]any{"id": pid, "status": prog.next}, "json")
	}
}

func recoveryOpsRejectPayment(db *core.DB) http.HandlerFunc {
	type body struct {
		RejectionReason string `json:"rejection_reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		pid, err := strconv.ParseInt(chi.URLParam(r, "pid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid payment ID")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		prows, perr := db.PGQuery(ctx, `SELECT status, amount_kobo, posted_by FROM recovery_payments WHERE id = $1`, pid)
		if perr != nil || len(prows) == 0 {
			respondErr(w, 404, "Payment not found")
			return
		}
		cur := str(prows[0]["status"])
		prog, ok := stageProgressions[cur]
		if !ok {
			respondErr(w, 422, "Payment is already finalised")
			return
		}
		// Only the approver whose stage it is (or admin) can reject it.
		if user.Role != prog.required && user.Role != "admin" {
			respondErr(w, 403, fmt.Sprintf("This stage requires the '%s' (%s) role", prog.required, prog.label))
			return
		}
		rows, err := db.PGQuery(ctx, `
			UPDATE recovery_payments
			SET status = 'rejected', approved_by = $1, approved_at = NOW(), rejection_reason = $2
			WHERE id = $3 AND status = $4
			RETURNING id, status`,
			user.ID, b.RejectionReason, pid, cur)
		if err != nil || len(rows) == 0 {
			respondErr(w, 409, "Payment status changed — please refresh")
			return
		}
		cif := ""
		if cifRows, _ := db.PGQuery(ctx, `SELECT rc.account_cif FROM recovery_payments rp JOIN recovery_cases rc ON rc.id = rp.case_id WHERE rp.id = $1`, pid); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(ctx, db, r, "recovery", "recovery_payment", fmt.Sprint(pid), cif, "payment_rejected",
			fmt.Sprintf("Recovery payment rejected — reason: %s", b.RejectionReason), nil, map[string]any{"reason": b.RejectionReason})
		if postedBy := toInt64(prows[0]["posted_by"]); postedBy > 0 {
			NotifyUsers(ctx, db, []int64{postedBy}, NotifPayload{
				EventType: "payment_rejected",
				Title:     "Recovery payment rejected",
				Body:      fmt.Sprintf("The ₦%s recovery payment you logged was rejected.", fmtKoboStr(toInt64(prows[0]["amount_kobo"]))),
				ActionURL: "/collections/recovery-approvals",
				EntityRef: fmt.Sprint(pid),
				Priority:  "normal",
			})
		}
		respond(w, rows[0], "pg")
	}
}

func recoveryOpsAddLegal(db *core.DB) http.HandlerFunc {
	type body struct {
		ProceedingType  string `json:"proceeding_type"`
		CourtName       string `json:"court_name"`
		CaseNumber      string `json:"case_number"`
		FilingDate      string `json:"filing_date"`
		NextHearingDate string `json:"next_hearing_date"`
		Notes           string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ProceedingType == "" || b.FilingDate == "" {
			respondErr(w, 422, "proceeding_type and filing_date are required")
			return
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO legal_proceedings
				(case_id, proceeding_type, court_name, case_number, filing_date, next_hearing_date, status, notes, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, NOW())
			RETURNING id, proceeding_type, court_name, case_number, filing_date, next_hearing_date, status, created_at`,
			id, b.ProceedingType, b.CourtName, b.CaseNumber, b.FilingDate, b.NextHearingDate, b.Notes)
		if err != nil {
			respondErr(w, 500, "Add legal proceeding failed")
			return
		}
		cif := ""
		if cifRows, _ := db.PGQuery(r.Context(), `SELECT account_cif FROM recovery_cases WHERE id = $1`, id); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(r.Context(), db, r, "recovery", "legal_milestone", fmt.Sprint(rows[0]["id"]), cif, "legal_milestone_added",
			fmt.Sprintf("Legal milestone added: %s", b.ProceedingType), nil, map[string]any{"milestone": b.ProceedingType})
		go NotifyRoles(context.Background(), db, []string{"recovery_head", "compliance_officer"}, NotifPayload{
			EventType: EvtRecoveryLegalMilestone,
			Title:     "Legal Proceeding Filed",
			Body:      fmt.Sprintf("New '%s' proceeding filed for recovery case #%d", b.ProceedingType, id),
			ActionURL: "/recovery/legal",
			EntityRef: fmt.Sprintf("recovery_case:%d", id),
		})
		respond(w, rows[0], "pg")
	}
}

func recoveryOpsUpdateLegal(db *core.DB) http.HandlerFunc {
	type body struct {
		Status          string `json:"status"`
		NextHearingDate string `json:"next_hearing_date"`
		Notes           string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		lid, err := strconv.ParseInt(chi.URLParam(r, "lid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid proceeding ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Status == "" {
			respondErr(w, 422, "status is required")
			return
		}

		_, err = db.PGExec(r.Context(), `
			UPDATE legal_proceedings
			SET status = $1, next_hearing_date = $2, notes = $3
			WHERE id = $4`,
			b.Status, b.NextHearingDate, b.Notes, lid)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		respondOK(w, "Legal proceeding updated")
	}
}

func recoveryOpsVisitsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		visitType := qstr(r, "visit_type")
		outcome := qstr(r, "outcome")
		agentID := qstr(r, "agent_id")
		dateFrom := qstr(r, "date_from")
		dateTo := qstr(r, "date_to")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `
			SELECT rfv.id, rfv.case_id, rc.case_ref, rfv.agent_user_id,
			       u.full_name AS agent_name, rfv.visit_date, rfv.visit_type,
			       rfv.outcome, rfv.notes, rfv.created_at
			FROM recovery_field_visits rfv
			LEFT JOIN recovery_cases rc ON rfv.case_id = rc.id
			LEFT JOIN o3c_users u ON rfv.agent_user_id = u.id
			WHERE 1=1`
		args := []any{}
		n := 1

		if visitType != "" {
			query += fmt.Sprintf(" AND rfv.visit_type = $%d", n)
			args = append(args, visitType)
			n++
		}
		if outcome != "" {
			query += fmt.Sprintf(" AND rfv.outcome = $%d", n)
			args = append(args, outcome)
			n++
		}
		if agentID != "" {
			query += fmt.Sprintf(" AND rfv.agent_user_id = $%d", n)
			args = append(args, agentID)
			n++
		}
		if dateFrom != "" {
			query += fmt.Sprintf(" AND rfv.visit_date >= $%d", n)
			args = append(args, dateFrom)
			n++
		}
		if dateTo != "" {
			query += fmt.Sprintf(" AND rfv.visit_date <= $%d", n)
			args = append(args, dateTo)
			n++
		}

		query += fmt.Sprintf(" ORDER BY rfv.visit_date DESC LIMIT $%d OFFSET $%d", n, n+1)
		args = append(args, limit, offset)

		rows, err := db.PGQuery(r.Context(), query, args...)
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

func recoveryOpsVisit(db *core.DB) http.HandlerFunc {
	type body struct {
		VisitDate string `json:"visit_date"`
		VisitType string `json:"visit_type"`
		Outcome   string `json:"outcome"`
		Notes     string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.VisitDate == "" || b.VisitType == "" {
			respondErr(w, 422, "visit_date and visit_type are required")
			return
		}

		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO recovery_field_visits (case_id, agent_user_id, visit_date, visit_type, outcome, notes, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, NOW())
			RETURNING id, visit_date, visit_type, outcome, notes, created_at`,
			id, user.ID, b.VisitDate, b.VisitType, b.Outcome, b.Notes)
		if err != nil {
			respondErr(w, 500, "Log visit failed")
			return
		}
		cif := ""
		if cifRows, _ := db.PGQuery(r.Context(), `SELECT account_cif FROM recovery_cases WHERE id = $1`, id); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(r.Context(), db, r, "recovery", "recovery_visit", fmt.Sprint(rows[0]["id"]), cif, "field_visit_logged",
			fmt.Sprintf("Field visit logged — outcome: %s", b.Outcome), nil, map[string]any{"outcome": b.Outcome, "notes": b.Notes})
		respond(w, rows[0], "pg")
	}
}

func recoveryOpsWriteOff(db *core.DB) http.HandlerFunc {
	type body struct {
		AmountKobo int64  `json:"amount_kobo"`
		Reason     string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid case ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AmountKobo == 0 || b.Reason == "" {
			respondErr(w, 422, "amount_kobo and reason are required")
			return
		}

		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO recovery_write_off_approvals
				(case_id, amount_kobo, reason, requested_by, status, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
			RETURNING id, case_id, amount_kobo, reason, status, created_at`,
			id, b.AmountKobo, b.Reason, user.ID, writeOffChainStart)
		if err != nil {
			respondErr(w, 500, "Create write-off request failed")
			return
		}
		// Ping the first approver in the chain (HOP) so it doesn't sit unseen until
		// someone happens to open the approvals page.
		if firstStage, ok := stageProgressions[writeOffChainStart]; ok {
			NotifyRole(r.Context(), db, firstStage.required, NotifPayload{
				EventType: "writeoff_approval_pending",
				Title:     "Write-off awaiting your approval",
				Body:      fmt.Sprintf("A ₦%s write-off request needs %s sign-off.", fmtKoboStr(b.AmountKobo), firstStage.label),
				ActionURL: "/collections/writeoffs",
				EntityRef: fmt.Sprint(rows[0]["id"]),
				Priority:  "high",
			})
		}
		cif := ""
		if cifRows, _ := db.PGQuery(r.Context(), `SELECT account_cif FROM recovery_cases WHERE id = $1`, id); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(r.Context(), db, r, "recovery", "writeoff_request", fmt.Sprint(rows[0]["id"]), cif, "writeoff_requested",
			fmt.Sprintf("Write-off request submitted for ₦%s", fmtKoboStr(b.AmountKobo)), nil, map[string]any{"amount_kobo": b.AmountKobo})
		respond(w, rows[0], "pg")
	}
}

// writeOffChainStart is the status a new write-off request enters at — the first
// stage of the approval chain below.
const writeOffChainStart = "pending_hop"

type approvalStage struct {
	next     string
	roleCol  string
	required string
	label    string
}

// stageProgressions maps current status → next status and the role required to advance it.
//
// The WRITE-OFF and DEBT-SALE chain is HOP → COO → CFO (decided with the business):
// these are large, infrequent money decisions the CFO signs off. These are the roles that
// actually have users; the earlier code targeted recovery_head/finance_head/md, none of
// which exist, so every request silently dead-ended at stage 1. The three per-stage
// approver columns on recovery_write_off_approvals predate this remap, so their NAMES
// (recovery_head_/finance_/md_approved_by) no longer describe the role — they now simply
// record the stage-1/2/3 approver in order. `label` drives the approver notification.
var stageProgressions = map[string]approvalStage{
	"pending_hop": {
		next:     "pending_coo",
		roleCol:  "recovery_head_approved_by", // stage-1 approver (HOP)
		required: "head_ops",
		label:    "Head of Operations",
	},
	"pending_coo": {
		next:     "pending_cfo",
		roleCol:  "finance_approved_by", // stage-2 approver (COO)
		required: "coo",
		label:    "COO",
	},
	"pending_cfo": {
		next:     "approved",
		roleCol:  "md_approved_by", // stage-3 approver (CFO) — final
		required: "cfo",
		label:    "CFO",
	},
}

// paymentStageProgressions is the chain for COLLECTION and RECOVERY PAYMENTS: HOP → COO,
// where the COO is the FINAL approver and posts the GL. CFO was removed from payment
// approvals — a routine, high-volume operational step — while remaining the final
// signatory on write-offs and debt sales (stageProgressions above). The GL post is bound
// to "the last stage" (isFinal := prog.next == "approved"), so making COO final moves the
// posting to COO with no GL-code change. The pending-list endpoints read only `required`,
// which is identical for pending_hop/pending_coo in both chains, so only the two payment
// APPROVE handlers switch to this map.
var paymentStageProgressions = map[string]approvalStage{
	"pending_hop": {
		next:     "pending_coo",
		roleCol:  "recovery_head_approved_by",
		required: "head_ops",
		label:    "Head of Operations",
	},
	"pending_coo": {
		next:     "approved", // COO is final for payments — posts the GL
		roleCol:  "finance_approved_by",
		required: "coo",
		label:    "COO",
	},
}

// chainStatusClause returns a SQL WHERE fragment that filters an approval-chain table by
// the requested status view: pending (default) | approved | rejected | all. `alias` is the
// table alias holding the `status` column. Shared by every approval-queue list so they all
// offer the same Pending/Approved/Rejected/All tabs.
func chainStatusClause(status, alias string) string {
	switch strings.ToLower(status) {
	case "approved":
		return alias + ".status = 'approved'"
	case "rejected":
		return alias + ".status = 'rejected'"
	case "all":
		return "TRUE"
	default:
		return alias + ".status NOT IN ('approved','rejected')"
	}
}

// writeOffStageLabel gives a human "awaiting X" label for a pending status, for the UI
// and notifications. Keeps the frontend from having to hardcode the chain.
func writeOffStageLabel(status string) string {
	if prog, ok := stageProgressions[status]; ok {
		return "Awaiting " + prog.label
	}
	switch status {
	case "approved":
		return "Approved"
	case "rejected":
		return "Rejected"
	}
	return status
}

func recoveryOpsApproveWriteOff(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		wid, err := strconv.ParseInt(chi.URLParam(r, "wid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid write-off ID")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		wrows, err := db.PGQuery(ctx, `SELECT status, amount_kobo FROM recovery_write_off_approvals WHERE id = $1`, wid)
		if err != nil || len(wrows) == 0 {
			respondErr(w, 404, "Write-off request not found")
			return
		}

		currentStatus := str(wrows[0]["status"])
		writeOffKobo := toInt64(wrows[0]["amount_kobo"])
		prog, ok := stageProgressions[currentStatus]
		if !ok {
			respondErr(w, 422, fmt.Sprintf("Write-off is already '%s' and cannot be advanced", currentStatus))
			return
		}
		// The stage's designated approver acts; admin is the break-glass override so a
		// single approver being unavailable can't freeze the whole chain.
		if user.Role != prog.required && user.Role != "admin" {
			respondErr(w, 403, fmt.Sprintf("This approval stage requires the '%s' (%s) role", prog.required, prog.label))
			return
		}

		// Wrap the status UPDATE (and any final-approval side-effects) in a transaction
		// so the status never changes without the GL entry being posted.
		tx, txErr := db.PG.BeginTx(ctx, nil)
		if txErr != nil {
			respondErr(w, 500, "Transaction failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		var updatedID int64
		updateErr := tx.QueryRowContext(ctx,
			fmt.Sprintf(`UPDATE recovery_write_off_approvals
				SET status = $1, %s = $2, updated_at = NOW()
				WHERE id = $3 AND status = $4 RETURNING id`, prog.roleCol),
			prog.next, user.ID, wid, currentStatus).Scan(&updatedID)
		if updateErr == sql.ErrNoRows {
			respondErr(w, 409, "Write-off status changed concurrently — please refresh and try again")
			return
		}
		if updateErr != nil {
			respondErr(w, 500, "Approval failed")
			return
		}

		// If fully approved, update the case and post GL entry inside the same transaction.
		if prog.next == "approved" {
			tx.ExecContext(ctx, `
				UPDATE recovery_cases rc
				SET write_off_amount_kobo = wa.amount_kobo,
				    outstanding_kobo      = GREATEST(0, rc.outstanding_kobo - wa.amount_kobo),
				    status = 'closed', closed_at = NOW(), updated_at = NOW()
				FROM recovery_write_off_approvals wa
				WHERE wa.id = $1 AND rc.id = wa.case_id`,
				wid) //nolint:errcheck
			postJournalTx(ctx, tx, glEntry{ //nolint:errcheck
				Date:          time.Now(),
				Description:   fmt.Sprintf("Loan write-off approved — request %d", wid),
				Reference:     fmt.Sprintf("WO-%d", wid),
				DebitAccount:  "5200", // Loan Loss Provision
				CreditAccount: "1100", // Loan Receivable
				AmountKobo:    writeOffKobo,
				SourceType:    "recovery_write_off",
				SourceID:      wid,
				PostedBy:      user.ID,
			})
		}

		if commitErr := tx.Commit(); commitErr != nil {
			respondErr(w, 500, "Write-off commit failed — please retry")
			return
		}

		cif := ""
		if cifRows, _ := db.PGQuery(ctx, `SELECT rc.account_cif FROM recovery_write_off_approvals wa JOIN recovery_cases rc ON rc.id = wa.case_id WHERE wa.id = $1`, wid); len(cifRows) > 0 {
			cif = str(cifRows[0]["account_cif"])
		}
		logCreditEvent(ctx, db, r, "recovery", "writeoff_approval", fmt.Sprint(wid), cif, "writeoff_approved",
			fmt.Sprintf("Write-off of ₦%s — %s", fmtKoboStr(writeOffKobo), writeOffStageLabel(prog.next)), nil, map[string]any{"stage": prog.next})

		// Hand off notice: tell the NEXT approver it's their turn, or — on final
		// approval — tell the original requester the write-off cleared. Without this the
		// next approver only learns by chance, which is how the old chain stalled.
		if nextStage, ok := stageProgressions[prog.next]; ok {
			NotifyRole(ctx, db, nextStage.required, NotifPayload{
				EventType: "writeoff_approval_pending",
				Title:     "Write-off awaiting your approval",
				Body:      fmt.Sprintf("A ₦%s write-off now needs %s sign-off.", fmtKoboStr(writeOffKobo), nextStage.label),
				ActionURL: "/collections/writeoffs",
				EntityRef: fmt.Sprint(wid),
				Priority:  "high",
			})
		} else if prog.next == "approved" {
			if rrows, _ := db.PGQuery(ctx, `SELECT requested_by FROM recovery_write_off_approvals WHERE id = $1`, wid); len(rrows) > 0 {
				if reqID := toInt64(rrows[0]["requested_by"]); reqID > 0 {
					NotifyUsers(ctx, db, []int64{reqID}, NotifPayload{
						EventType: "writeoff_approved",
						Title:     "Write-off approved",
						Body:      fmt.Sprintf("Your ₦%s write-off request was fully approved and posted.", fmtKoboStr(writeOffKobo)),
						ActionURL: "/collections/writeoffs",
						EntityRef: fmt.Sprint(wid),
						Priority:  "normal",
					})
				}
			}
		}

		respondOK(w, fmt.Sprintf("Write-off advanced — %s", writeOffStageLabel(prog.next)))
	}
}

func recoveryOpsRejectWriteOff(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		wid, err := strconv.ParseInt(chi.URLParam(r, "wid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid write-off ID")
			return
		}

		wrows, err := db.PGQuery(r.Context(), `SELECT status, amount_kobo, requested_by FROM recovery_write_off_approvals WHERE id = $1`, wid)
		if err != nil || len(wrows) == 0 {
			respondErr(w, 404, "Write-off request not found")
			return
		}
		currentSt := str(wrows[0]["status"])
		if currentSt == "approved" || currentSt == "rejected" {
			respondErr(w, 422, "Write-off is already finalised")
			return
		}

		_, err = db.PGExec(r.Context(),
			`UPDATE recovery_write_off_approvals SET status = 'rejected', updated_at = NOW() WHERE id = $1`, wid)
		if err != nil {
			respondErr(w, 500, "Reject failed")
			return
		}
		// Tell the requester it was declined so they aren't left waiting on a dead request.
		if reqID := toInt64(wrows[0]["requested_by"]); reqID > 0 {
			NotifyUsers(r.Context(), db, []int64{reqID}, NotifPayload{
				EventType: "writeoff_rejected",
				Title:     "Write-off declined",
				Body:      fmt.Sprintf("Your ₦%s write-off request was declined.", fmtKoboStr(toInt64(wrows[0]["amount_kobo"]))),
				ActionURL: "/collections/writeoffs",
				EntityRef: fmt.Sprint(wid),
				Priority:  "normal",
			})
		}
		respondOK(w, "Write-off rejected")
	}
}

func recoveryOpsDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		type stat struct {
			key, sql string
		}
		stats := []stat{
			{"total_open_cases", `SELECT COUNT(*) AS val FROM recovery_cases WHERE status IN ('active','legal')`},
			// Net of what has already been recovered, so this reconciles with the Overview's
			// "total in recovery" (recovery.go) instead of showing the raw handoff balance.
			{"total_outstanding_kobo", `SELECT COALESCE(SUM(GREATEST(outstanding_kobo - recovered_kobo, 0)), 0) AS val FROM recovery_cases WHERE status IN ('active','legal')`},
			{"total_recovered_kobo", `SELECT COALESCE(SUM(recovered_kobo), 0) AS val FROM recovery_cases`},
			{"pending_write_offs", `
				SELECT COUNT(*) AS val FROM recovery_write_off_approvals
				WHERE status NOT IN ('approved', 'rejected')`},
			{"visits_this_month", `
				SELECT COUNT(*) AS val FROM recovery_field_visits
				WHERE DATE_TRUNC('month', visit_date::date) = DATE_TRUNC('month', CURRENT_DATE)`},
		}

		// H9: individual stat failures return 0 rather than aborting the whole dashboard.
		result := map[string]any{}
		for _, s := range stats {
			rows, err := db.PGQuery(ctx, s.sql)
			if err != nil || len(rows) == 0 {
				result[s.key] = 0
				continue
			}
			result[s.key] = rows[0]["val"]
		}

		respond(w, result, "pg")
	}
}

func recoveryOpsAgentDashboard(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		var assignedCases, closedMTD, callsMTD int
		var collectedMTD int64

		db.PG.QueryRowContext(ctx, `SELECT COUNT(*) FROM recovery_cases WHERE assigned_agent_id = $1 AND status IN ('active','legal')`, user.ID).Scan(&assignedCases)                                                                                                                                                                      //nolint:errcheck
		db.PG.QueryRowContext(ctx, `SELECT COUNT(*) FROM recovery_cases WHERE assigned_agent_id = $1 AND status = 'closed' AND DATE_TRUNC('month', closed_at) = DATE_TRUNC('month', CURRENT_DATE)`, user.ID).Scan(&closedMTD)                                                                                                              //nolint:errcheck
		db.PG.QueryRowContext(ctx, `SELECT COUNT(*) FROM recovery_field_visits WHERE agent_user_id = $1 AND DATE_TRUNC('month', visit_date::date) = DATE_TRUNC('month', CURRENT_DATE)`, user.ID).Scan(&callsMTD)                                                                                                                           //nolint:errcheck
		db.PG.QueryRowContext(ctx, `SELECT COALESCE(SUM(rp.amount_kobo),0) FROM recovery_payments rp JOIN recovery_cases rc ON rc.id = rp.case_id WHERE rc.assigned_agent_id = $1 AND rp.status IN ('approved','posted') AND DATE_TRUNC('month', rp.payment_date::date) = DATE_TRUNC('month', CURRENT_DATE)`, user.ID).Scan(&collectedMTD) //nolint:errcheck

		// Debtor name resolved EXACTLY as the Cases list does (rc.customer_name →
		// app.customers → CIF), so My Dashboard and Cases never show different names for
		// the same case. The old collection_assignments.customer_name lookup diverged from
		// the Cases page for ~60% of assigned cases.
		caseRows, _ := db.PGQuery(ctx, `
			SELECT
				rc.id, rc.case_ref,
				COALESCE(NULLIF(TRIM(rc.customer_name),''), NULLIF(TRIM(CONCAT(c.first_name,' ',c.last_name)),''), rc.account_cif) AS debtor_name,
				rc.outstanding_kobo,
				COALESCE(NULLIF(REGEXP_REPLACE(COALESCE(rc.dpd_at_handoff,''),'\D','','g'),'')::INT, 0) AS dpd,
				'' AS next_action, NULL::date AS next_action_date,
				rc.status
			FROM recovery_cases rc
			LEFT JOIN app.customers c ON c.cif = rc.account_cif
			WHERE rc.assigned_agent_id = $1 AND rc.status IN ('active','legal')
			ORDER BY rc.outstanding_kobo DESC
			LIMIT 50`, user.ID)

		visitRows, _ := db.PGQuery(ctx, `
			SELECT
				v.id, rc.case_ref,
				COALESCE(NULLIF(TRIM(rc.customer_name),''), NULLIF(TRIM(CONCAT(c.first_name,' ',c.last_name)),''), rc.account_cif) AS debtor_name,
				v.outcome, v.visit_date AS visited_at,
				0 AS amount_promised_kobo
			FROM recovery_field_visits v
			JOIN recovery_cases rc ON rc.id = v.case_id
			LEFT JOIN app.customers c ON c.cif = rc.account_cif
			WHERE COALESCE(v.agent_user_id, v.officer_id) = $1
			ORDER BY v.created_at DESC
			LIMIT 10`, user.ID)

		trendRows, _ := db.PGQuery(ctx, `
			SELECT
				TO_CHAR(gs, 'Mon YYYY') AS month,
				COALESCE(SUM(rp.amount_kobo) FILTER (WHERE rp.status IN ('approved','posted')), 0) AS collected,
				COUNT(DISTINCT v.id)                                                    AS calls
			FROM GENERATE_SERIES(
				DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '5 months',
				DATE_TRUNC('month', CURRENT_DATE),
				'1 month'
			) AS gs
			LEFT JOIN recovery_payments rp
				ON DATE_TRUNC('month', rp.payment_date::date) = gs
				AND rp.case_id IN (SELECT id FROM recovery_cases WHERE assigned_agent_id = $1)
			LEFT JOIN recovery_field_visits v
				ON DATE_TRUNC('month', v.visit_date::date) = gs
				AND v.agent_user_id = $1
			GROUP BY gs
			ORDER BY gs`, user.ID)

		if caseRows == nil {
			caseRows = []core.Row{}
		}
		if visitRows == nil {
			visitRows = []core.Row{}
		}
		if trendRows == nil {
			trendRows = []core.Row{}
		}

		respond(w, core.Row{
			"assigned_cases":            assignedCases,
			"cases_closed_mtd":          closedMTD,
			"calls_made_mtd":            callsMTD,
			"amount_collected_mtd_kobo": collectedMTD,
			"cases":                     caseRows,
			"recent_visits":             visitRows,
			"monthly_trend":             trendRows,
		}, "pg")
	}
}
