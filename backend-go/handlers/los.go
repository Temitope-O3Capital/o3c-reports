package handlers

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

func RegisterLOS(r chi.Router, db *core.DB) {
	base := core.RequirePages("los")
	all := core.RequirePages("los_all")
	assign := core.RequirePages("los_all", "los_assign")

	// door = "may open and act on an individual application". The base `los` page is
	// held only by Sales and Risk; Finance (los_finance/los_finance_approve) and Card
	// Ops (los_booking) own the back half of the pipeline but do NOT hold `los`, so a
	// door of RequirePages("los") locked them out at the route before the per-transition
	// check in losAdvance ever ran — leaving pending_conditions→…→active executable only
	// by admin/md/coo. This widens the door to every LOS action page (RequirePages is
	// OR); the specific transition each user may perform is still enforced inside
	// losAdvance via transitionRequiredPage.
	door := core.RequirePages("los", "los_all", "los_risk_review", "los_risk_head",
		"los_finance", "los_finance_approve", "los_booking")
	// riskDoor gates the manual credit-assessment write — a Risk-only action (it writes
	// the same eye_* columns Phoenix populates), so Finance/Ops must not reach it.
	riskDoor := core.RequirePages("los_risk_review", "los_risk_head", "los_all")
	// viewDoor = door + read-only observers. Compliance audits credit files but is not
	// part of the origination chain, so it holds los_view and nothing else here: every
	// route that changes an application keeps `door`, and los_view appears only on the
	// GETs below. Widening `door` instead would have handed compliance the write routes.
	viewDoor := core.RequirePages("los", "los_all", "los_risk_review", "los_risk_head",
		"los_finance", "los_finance_approve", "los_booking", "los_view")

	r.With(base).Get("/stats", losStats(db))
	r.With(base).Get("/funnel", losFunnel(db))
	r.With(base).Get("/overview", losOverview(db))
	r.With(base).Get("/queue", losQueue(db))
	// inbox = "applications awaiting THIS user's action", resolved from their pages.
	// Powers the per-role My Approvals queue (Sales, Risk officer/head, Finance, Ops).
	r.With(door).Get("/inbox", losInbox(db))
	r.With(all).Get("/all", losAll(db))
	r.With(base).Post("/", losCreate(db))
	// Running-credit portfolio for a customer with no workspace application (booked
	// directly on the CBS). Powers the app page in "portfolio mode".
	r.With(core.RequirePages("los", "credit_portfolio")).Get("/portfolio/{cif}", losCustomerPortfolio(db))
	r.With(viewDoor).Get("/{id}", losGet(db))
	r.With(assign).Put("/{id}/assign", losAssign(db))
	r.With(door).Put("/{id}/advance", losAdvance(db))
	r.With(door).Put("/{id}/decline", losDecline(db))
	r.With(door).Put("/{id}/request-info", losRequestInfo(db))
	r.With(door).Post("/{id}/conditions", losAddCondition(db))
	r.With(door).Put("/{id}/conditions/{cid}", losMarkConditionMet(db))
	r.With(door).Post("/{id}/notes", losAddNote(db))
	r.With(viewDoor).Get("/{id}/events", losGetEvents(db))
	r.With(riskDoor).Put("/{id}/credit-assessment", losSaveCreditAssessment(db))
	r.With(viewDoor).Get("/{id}/documents", losGetDocuments(db))
	// Streams the file itself. Read-only and on viewDoor for the same reason the
	// list is: auditing a credit file means opening the evidence, not just seeing
	// that a row exists.
	r.With(viewDoor).Get("/documents/{doc_id}/content", losDocumentContent(db))
	r.With(door).Post("/{id}/documents", losUploadDocument(db))
	r.With(door).Delete("/documents/{doc_id}", losDeleteDocument(db))
	r.With(door).Get("/team-users", losTeamUsers(db))
	r.With(viewDoor).Get("/{id}/messages", losGetMessages(db))
	r.With(door).Post("/{id}/messages", losPostMessage(db))
	r.With(viewDoor).Get("/{id}/eye-report", losEyeReport(db))
	// Phoenix's full Eye decision, passed through verbatim so the workspace can
	// render the identical credit report rather than an approximation of it.
	r.With(viewDoor).Get("/{id}/eye-decision", losEyeDecision(db))

	// Customer-journey actions. Phoenix owns these steps and stays the system of
	// record; these let staff take them without leaving the workspace, and record
	// each on the activity trail against the user who did it. Same door as every
	// other per-application action — whoever may act on the file may act on it here.
	r.With(door).Get("/{id}/mandate", losMandate(db))
	r.With(door).Post("/{id}/mandate", losMandateSetup(db))
	r.With(door).Post("/{id}/mandate/{mandate_id}/remind", losMandateAction(db, "remind"))
	r.With(door).Post("/{id}/mandate/{mandate_id}/check-status", losMandateAction(db, "check-status"))
	r.With(door).Post("/{id}/confirm-amount", losConfirmAmount(db))
	r.With(door).Post("/{id}/consent", losRecordConsent(db))
	r.With(door).Get("/{id}/cards", losCards(db))
	r.With(door).Post("/{id}/cards/{card_id}/activate", losCardAction(db, "activate"))
	r.With(door).Post("/{id}/cards/{card_id}/freeze", losCardAction(db, "freeze"))
	r.With(door).Post("/{id}/cards/{card_id}/unfreeze", losCardAction(db, "unfreeze"))
	r.With(door).Post("/{id}/cards/{card_id}/cancel", losCardAction(db, "cancel"))
	// Offer & acceptance CAPTURE (capture-only; Phoenix owns the process, this records it
	// in the workspace). Does not transition the stage or gate booking.
	r.With(door).Put("/{id}/offer", losSetOffer(db))
	// Phoenix's real Offer — the document the customer actually received, with its
	// frozen terms, version and expiry. Read is on viewDoor because compliance
	// auditing a file needs to see what was put to the customer; the resend is an
	// action, so it keeps the origination door.
	r.With(viewDoor).Get("/{id}/offers", losOffers(db))
	r.With(door).Post("/{id}/offers/{offer_id}/resend", losOfferResend(db))
	// The letter itself, as Phoenix renders it. Reading, so viewDoor like the list.
	r.With(viewDoor).Get("/{id}/offers/{offer_id}/pdf", losOfferPDF(db))
	// The customer's answer. Phoenix confirms the amount and activates the credit
	// account on accept, and declines the credit request on decline, so these are
	// the two most consequential actions on this page.
	r.With(door).Post("/{id}/offers/{offer_id}/accept", losOfferDecision(db, "accept"))
	r.With(door).Post("/{id}/offers/{offer_id}/decline", losOfferDecision(db, "decline"))
	// Mandate cancellation instructs the provider to stop debiting a real account,
	// so it is separated from the remind/check-status nudges and demands a reason.
	r.With(door).Post("/{id}/mandate/{mandate_id}/cancel", losMandateCancel(db))
	r.With(viewDoor).Get("/{id}/mandate/{mandate_id}/collections", losMandateCollections(db))
	r.With(viewDoor).Get("/{id}/consent", losConsentTrail(db))
	// Full Phoenix credit report (PrequalificationReport) stored verbatim, if any.
	r.With(viewDoor).Get("/{id}/credit-report", losCreditReport(db))
}

// losSetOffer records the offer/acceptance step in the workspace (CRM). It writes the
// offer terms + status onto the application and an event to the trail, but does NOT
// advance the LOS stage or gate booking — Phoenix is the system of record for this step,
// and offer_source='crm' marks a workspace-captured offer so a later Phoenix mirror is
// distinguishable. Actions: issue | accept | decline | expire.
func losSetOffer(db *core.DB) http.HandlerFunc {
	type body struct {
		Action        string `json:"action"`
		OfferedAmount int64  `json:"offered_amount_kobo"`
		OfferedRate   int    `json:"offered_rate_bps"`
		OfferedTenor  int    `json:"offered_tenor_months"`
		ExpiresAt     string `json:"offer_expires_at"`
		Ref           string `json:"offer_ref"`
		Note          string `json:"note"`
	}
	newStatus := map[string]string{"issue": "issued", "accept": "accepted", "decline": "declined", "expire": "expired"}
	evtName := map[string]string{"issue": "offer_issued", "accept": "offer_accepted", "decline": "offer_declined", "expire": "offer_expired"}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if newStatus[b.Action] == "" {
			respondErr(w, 400, "action must be issue, accept, decline or expire")
			return
		}
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		var cur string
		if err := db.PG.QueryRowContext(ctx, `SELECT status FROM loan_applications WHERE id=$1`, id).Scan(&cur); err != nil {
			respondErr(w, 404, "Application not found")
			return
		}
		note := strings.TrimSpace(b.Note)

		switch b.Action {
		case "issue":
			if b.OfferedAmount <= 0 {
				respondErr(w, 400, "offered_amount_kobo must be greater than zero")
				return
			}
			var expiry any // nil → NULL
			if s := strings.TrimSpace(b.ExpiresAt); s != "" {
				for _, layout := range []string{time.RFC3339, "2006-01-02"} {
					if t, e := time.Parse(layout, s); e == nil {
						expiry = t
						break
					}
				}
			}
			_, err = db.PG.ExecContext(ctx, `
				UPDATE loan_applications
				   SET offer_status='issued', offered_amount_kobo=$2, offered_rate_bps=$3,
				       offered_tenor_months=$4, offer_expires_at=$5, offer_ref=$6, offer_note=$7,
				       offer_source='crm', offer_issued_at=NOW(), updated_at=NOW()
				 WHERE id=$1`,
				id, b.OfferedAmount, b.OfferedRate, b.OfferedTenor, expiry, strings.TrimSpace(b.Ref), note)
		case "accept":
			_, err = db.PG.ExecContext(ctx, `
				UPDATE loan_applications
				   SET offer_status='accepted', offer_accepted_at=NOW(),
				       offer_note=COALESCE(NULLIF($2,''), offer_note), updated_at=NOW()
				 WHERE id=$1`, id, note)
		case "decline":
			_, err = db.PG.ExecContext(ctx, `
				UPDATE loan_applications
				   SET offer_status='declined', offer_note=COALESCE(NULLIF($2,''), offer_note), updated_at=NOW()
				 WHERE id=$1`, id, note)
		case "expire":
			_, err = db.PG.ExecContext(ctx, `UPDATE loan_applications SET offer_status='expired', updated_at=NOW() WHERE id=$1`, id)
		}
		if err != nil {
			respondErr(w, 500, "Could not record the offer: "+err.Error())
			return
		}

		// Trail entry (best-effort — the offer itself is already recorded).
		_, _ = db.PG.ExecContext(ctx, `
			INSERT INTO application_events (application_id, event_type, actor_user_id, notes, created_at)
			VALUES ($1,$2,$3,$4,NOW())`, id, evtName[b.Action], user.ID, note)

		respond(w, map[string]any{"ok": true, "offer_status": newStatus[b.Action]}, "pg")
	}
}

// losStageForwardPage maps a from-stage to the page that authorises its forward
// transition — derived from allowedTransitions + transitionRequiredPage so it can
// never drift from what losAdvance actually enforces.
func losStageForwardPage(stage string) string {
	next := allowedTransitions[stage]
	if len(next) != 1 {
		return ""
	}
	return transitionRequiredPage[stage+":"+next[0]]
}

// losActionableStages returns the set of stages the user may act on (advance), based
// on the page that authorises each stage's forward transition. los_all sees them all.
func losActionableStages(user *core.Claims) []string {
	var out []string
	for stage := range allowedTransitions {
		page := losStageForwardPage(stage)
		if page == "" {
			continue
		}
		if user.HasPage("los_all") || user.HasPage(page) {
			out = append(out, stage)
		}
	}
	return out
}

// losInbox lists the applications sitting at a stage the caller is authorised to move
// forward — i.e. "waiting on me". This is the per-role My Approvals queue; a Finance
// head sees finance_approval, a Risk officer sees document_collection + risk_review,
// and so on. When the caller can act on no stage, it returns an empty list rather than
// erroring.
func losInbox(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		limit := qint(r, "limit", 200, 1, 500)

		stages := losActionableStages(user)
		if len(stages) == 0 {
			writeRiskList(w, []core.Row{}, 0)
			return
		}

		ph := make([]string, len(stages))
		args := make([]any, 0, len(stages)+1)
		for i, s := range stages {
			ph[i] = fmt.Sprintf("$%d", i+1)
			args = append(args, s)
		}
		args = append(args, limit)

		q := fmt.Sprintf(`
			SELECT la.id, la.reference, la.applicant_name, la.applicant_cif,
			       COALESCE(la.product_type, la.loan_type, '') AS product_type,
			       COALESCE(la.amount_requested_kobo, 0) AS amount_requested_kobo,
			       COALESCE(la.amount_approved_kobo, 0)  AS amount_approved_kobo,
			       la.status, la.stage,
			       la.eye_score, la.eye_rating AS risk_band, la.dti_pct,
			       la.decision, la.phoenix_sync_state, la.source_system,
			       COALESCE(la.monthly_income_kobo, 0) AS monthly_income_kobo,
			       la.submitted_at, la.updated_at,
			       EXTRACT(DAY FROM NOW() - COALESCE(la.updated_at, la.submitted_at))::int AS days_in_stage,
			       u.full_name AS assigned_officer_name
			FROM loan_applications la
			LEFT JOIN o3c_users u ON u.id = la.assigned_to_user_id
			WHERE la.stage IN (%s)
			  AND la.status NOT IN ('declined','active','closed','written_off')
			ORDER BY la.submitted_at ASC NULLS LAST, la.id ASC
			LIMIT %s`, strings.Join(ph, ","), fmt.Sprintf("$%d", len(stages)+1))

		rows, err := db.PGQuery(ctx, q, args...)
		if err != nil {
			// Tolerate the pre-Phoenix schema (decision/phoenix_sync_state/source_system
			// may not exist yet) by retrying without those columns.
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "column") {
				q2 := strings.Replace(q, "la.decision, la.phoenix_sync_state, la.source_system,", "", 1)
				rows, err = db.PGQuery(ctx, q2, args...)
			}
			if err != nil {
				respondErrLog(w, 500, "Query failed", err)
				return
			}
		}
		if rows == nil {
			rows = []core.Row{}
		}
		// A real count, not len(rows). The list is capped (200 by default) and the page
		// renders this total as "Waiting on You" — so an officer with more than a page of
		// work was told they had exactly one page of it, and the number stopped moving.
		total := int64(len(rows))
		if cnt, cerr := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT COUNT(*) AS total
			  FROM loan_applications la
			 WHERE la.stage IN (%s)
			   AND la.status NOT IN ('declined','active','closed','written_off')`,
			strings.Join(ph, ",")), args[:len(stages)]...); cerr == nil && len(cnt) > 0 {
			total = toInt64(cnt[0]["total"])
		}
		writeRiskList(w, rows, total)
	}
}

// allowedTransitions maps from_stage → []to_stage
//
// POLICY (2026-09-21): every application follows this one ladder, whatever the exposure.
// There is deliberately NO approval-authority threshold and nothing branches by amount —
// the controls that matter apply at every size instead: the originator cannot approve, the
// approved amount is captured and recorded, and a decision taken by one pair of eyes names
// itself in the trail. Do not add an amount-based branch here without revisiting that.
//
// pending_committee is a stage the KPI queries have always counted but that had no exit:
// nothing routes into it, and nothing could move a file out of it, so anything that
// landed there — a legacy row, a manual correction — was counted as pending for ever and
// appeared in nobody's inbox. Rather than invent new routing into it (which would make
// the risk head's approval ambiguous and break every "next stage" default), it is given
// the one thing it lacked: a way out, to exactly where the risk head's own approval goes.
var allowedTransitions = map[string][]string{
	"draft":               {"submitted"},
	"submitted":           {"document_collection"},
	"document_collection": {"risk_review"},
	"risk_review":         {"risk_head_review"},
	"risk_head_review":    {"pending_conditions"},
	"pending_committee":   {"pending_conditions"},
	"pending_conditions":  {"finance_approval"},
	"finance_approval":    {"booking"},
	"booking":             {"active"},
}

// decisionTransitions are the steps that ARE a credit decision rather than an
// administrative move. They carry the maker-checker rule: whoever raised the file may
// not also be the one who decides it. Booking→active is deliberately absent — that is
// disbursement, carried out by Card Ops on a decision someone else already took.
var decisionTransitions = map[string]bool{
	"risk_review:risk_head_review":         true,
	"risk_head_review:pending_conditions":  true,
	"pending_committee:pending_conditions": true,
	"pending_conditions:finance_approval":  true,
	"finance_approval:booking":             true,
}

// The credit is granted, and its amount fixed, when a file moves INTO pending_conditions:
// normally by the risk head, or by the committee clearing one that was referred to it.
// Everything downstream (conditions, finance, booking) acts on the figure agreed there.
const approvalTo = "pending_conditions"

func isApprovalTransition(from, to string) bool {
	return to == approvalTo && (from == "risk_head_review" || from == "pending_committee")
}

// enteredStageBy returns whoever moved this application INTO the stage it now sits in, or
// 0 when that is unknown (a file older than the event trail).
//
// It answers the one separation-of-duties question a two-person risk function can usefully
// ask: is the person about to decide this file the same person who handed it to
// themselves? O3C runs ONE risk officer and ONE risk head, so blocking that would stop
// work dead the first time either covers for the other — and an override the head uses
// daily records nothing but friction. Recording it does the real job: it makes "which
// credits were decided by a single pair of eyes?" a question with an answer.
func enteredStageBy(ctx context.Context, db *core.DB, appID int64, stage string) int64 {
	rows, err := db.PGQuery(ctx, `
		SELECT COALESCE(actor_user_id, 0) AS actor
		  FROM application_events
		 WHERE application_id = $1 AND to_stage = $2 AND event_type = 'stage_advance'
		 ORDER BY created_at DESC
		 LIMIT 1`, appID, stage)
	if err != nil || len(rows) == 0 {
		return 0
	}
	return toInt64(rows[0]["actor"])
}

// declineRequiredPage answers "who may kill a file sitting HERE" with the same page that
// authorises moving it forward from here — the role already deciding on it. Returns ""
// for a stage with no single mapped successor, which the caller treats as deny-by-default.
func declineRequiredPage(fromStage string) string {
	next := allowedTransitions[fromStage]
	if len(next) != 1 {
		return ""
	}
	return transitionRequiredPage[fromStage+":"+next[0]]
}

// transitionRequiredPage maps "from:to" → the LOS page that authorises that transition.
// Any user with "los_all" may bypass the per-transition check (supervisor override).
var transitionRequiredPage = map[string]string{
	"draft:submitted":                      "los",
	"submitted:document_collection":        "los",
	"document_collection:risk_review":      "los_risk_review",
	"risk_review:risk_head_review":         "los_risk_review",
	"risk_head_review:pending_conditions":  "los_risk_head",
	"pending_committee:pending_conditions": "los_risk_head",
	"pending_conditions:finance_approval":  "los_finance",
	"finance_approval:booking":             "los_finance_approve",
	"booking:active":                       "los_booking",
}

func losParseID(r *http.Request) (int64, error) {
	return strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
}

func losStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		byStatus, err := db.PGQuery(ctx, `
			SELECT status, COUNT(*) AS count
			FROM loan_applications
			GROUP BY status
			ORDER BY status`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if byStatus == nil {
			byStatus = []core.Row{}
		}

		// Pipeline value grouped by stage — used for funnel and header KPI.
		byStage, err := db.PGQuery(ctx, `
			SELECT stage,
			       COUNT(*)                                          AS count,
			       COALESCE(SUM(amount_requested_kobo), 0)          AS pipeline_kobo,
			       COALESCE(SUM(amount_approved_kobo),  0)          AS approved_kobo
			FROM loan_applications
			WHERE stage NOT IN ('declined', 'active', 'closed')
			GROUP BY stage
			ORDER BY stage`)
		if err != nil {
			respondErr(w, 500, "Stage query failed")
			return
		}
		if byStage == nil {
			byStage = []core.Row{}
		}

		// Total pipeline and avg days to close
		totals, _ := db.PGQuery(ctx, `
			SELECT
				COALESCE(SUM(CASE WHEN stage NOT IN ('declined','active','closed') THEN amount_requested_kobo END), 0) AS total_pipeline_kobo,
				COALESCE(SUM(CASE WHEN stage = 'active' THEN amount_approved_kobo END), 0)                           AS total_disbursed_kobo,
				COUNT(CASE WHEN stage NOT IN ('declined','active','closed') THEN 1 END)                              AS open_count,
				COALESCE(AVG(CASE WHEN stage IN ('active','declined') THEN EXTRACT(EPOCH FROM (updated_at - created_at))/86400 END), 0) AS avg_days_to_close
			FROM loan_applications`)

		resp := map[string]any{
			"by_status": byStatus,
			"by_stage":  byStage,
		}
		if len(totals) > 0 {
			resp["total_pipeline_kobo"] = totals[0]["total_pipeline_kobo"]
			resp["total_disbursed_kobo"] = totals[0]["total_disbursed_kobo"]
			resp["open_count"] = totals[0]["open_count"]
			resp["avg_days_to_close"] = totals[0]["avg_days_to_close"]
		}
		respond(w, resp, "pg")
	}
}

// losQueueScope decides which applications the Sales Applications page shows.
// $1 is the caller's user id; $2 is true when the caller holds los_all.
//
// This was a bare `assigned_to_user_id = $1`, which made the page a personal
// queue. That is too narrow twice over. Sales originates applications and has to
// keep tracking them after they move on to Risk — the stage moves, the ownership
// does not. And because NULL = $1 is never true, an application with no assignee
// matched NOBODY: it could sit in Risk's review list while appearing nowhere in
// Sales for any user at all, which is exactly how one went missing.
//
// So: holders of los_all — sales_head, admin, COO — see the whole book. An agent
// sees only their own: assigned to them, or originated by them. Ownership follows
// the person, not the stage, so an agent keeps seeing their application after it
// moves to Risk.
//
// Unclaimed applications are deliberately NOT shown to agents. They are the
// supervisor's to distribute, and los_all already sees them.
const losQueueScope = `$2
			   OR la.assigned_to_user_id = $1
			   OR la.sales_officer_id    = $1
			   OR la.created_by          = $1`

func losQueue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		limit := qint(r, "limit", 50, 1, 200)
		// Passed as a bound parameter, not spliced into the SQL, so both pagination
		// branches keep one fixed placeholder layout regardless of the caller's role.
		seeAll := user.HasPage("los_all")
		// M10: cursor-based pagination via after_id (keyset on updated_at + id).
		// Falls back to offset-based when after_id is absent for backwards compatibility.
		afterID := qint(r, "after_id", 0, 0, 1<<62)

		var rows []core.Row
		var err error
		if afterID > 0 {
			// Keyset pagination: fetch records older than the cursor row.
			rows, err = db.PGQuery(r.Context(), `
				SELECT la.id, la.reference, la.applicant_name, la.applicant_cif, la.product_type,
				       la.amount_requested_kobo, la.amount_approved_kobo, la.status, la.stage,
				       la.assigned_to_user_id, la.submitted_at, la.disbursed_at, la.created_at, la.updated_at, la.decision, la.phoenix_sync_state,
				       u.full_name AS assigned_officer_name
				FROM loan_applications la
				LEFT JOIN o3c_users u ON u.id = la.assigned_to_user_id
				WHERE (`+losQueueScope+`)
				  AND (la.updated_at, la.id) < (
				      SELECT updated_at, id FROM loan_applications WHERE id = $3
				  )
				ORDER BY la.updated_at DESC, la.id DESC
				LIMIT $4`,
				user.ID, seeAll, afterID, limit)
		} else {
			offset := qint(r, "offset", 0, 0, 1<<30)
			// H3: join users table so assigned_officer_name is available without a second fetch.
			rows, err = db.PGQuery(r.Context(), `
				SELECT la.id, la.reference, la.applicant_name, la.applicant_cif, la.product_type,
				       la.amount_requested_kobo, la.amount_approved_kobo, la.status, la.stage,
				       la.assigned_to_user_id, la.submitted_at, la.disbursed_at, la.created_at, la.updated_at, la.decision, la.phoenix_sync_state,
				       u.full_name AS assigned_officer_name
				FROM loan_applications la
				LEFT JOIN o3c_users u ON u.id = la.assigned_to_user_id
				WHERE (`+losQueueScope+`)
				ORDER BY la.updated_at DESC, la.id DESC
				LIMIT $3 OFFSET $4`,
				user.ID, seeAll, limit, offset)
		}
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		// Include next cursor in response so frontend knows how to fetch next page.
		var nextCursor int64
		if len(rows) == limit {
			nextCursor = toInt64(rows[len(rows)-1]["id"])
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data":        rows,
			"next_cursor": nextCursor,
			"has_more":    nextCursor > 0,
		})
	}
}

func losAll(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		stage := qstr(r, "stage")
		limit := qint(r, "limit", 100, 1, 500)
		// M24: cursor-based pagination via after_id; falls back to offset.
		afterID := qint(r, "after_id", 0, 0, 1<<62)
		offset := qint(r, "offset", 0, 0, 1<<30)

		query := `SELECT id, reference, applicant_name, applicant_cif, product_type,
		                 amount_requested_kobo, amount_approved_kobo, status, stage,
		                 assigned_to_user_id, submitted_at, created_at, updated_at
		          FROM loan_applications WHERE 1=1`
		args := []any{}
		n := 1
		if status != "" {
			query += fmt.Sprintf(" AND status = $%d", n)
			args = append(args, status)
			n++
		}
		if stage != "" {
			query += fmt.Sprintf(" AND stage = $%d", n)
			args = append(args, stage)
			n++
		}
		if afterID > 0 {
			query += fmt.Sprintf(` AND (updated_at, id) < (SELECT updated_at, id FROM loan_applications WHERE id=$%d)`, n)
			args = append(args, afterID)
			n++
			query += fmt.Sprintf(" ORDER BY updated_at DESC, id DESC LIMIT $%d", n)
			args = append(args, limit)
		} else {
			query += fmt.Sprintf(" ORDER BY updated_at DESC LIMIT $%d OFFSET $%d", n, n+1)
			args = append(args, limit, offset)
		}

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

func losGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		ctx := r.Context()

		apps, err := db.PGQuery(ctx, `
			SELECT * FROM loan_applications WHERE id = $1`, id)
		if err != nil || len(apps) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}

		events, _ := db.PGQuery(ctx, `
			SELECT * FROM application_events
			WHERE application_id = $1 ORDER BY created_at ASC`, id)

		conditions, _ := db.PGQuery(ctx, `
			SELECT * FROM application_conditions
			WHERE application_id = $1 ORDER BY created_at ASC`, id)

		notes, _ := db.PGQuery(ctx, `
			SELECT * FROM application_notes
			WHERE application_id = $1 ORDER BY created_at ASC`, id)

		if events == nil {
			events = []core.Row{}
		}
		if conditions == nil {
			conditions = []core.Row{}
		}
		if notes == nil {
			notes = []core.Row{}
		}

		// Did the viewer put this file into the stage it is in? The decision modal uses it
		// to say, before the click, that approving will be recorded as a single-reviewer
		// decision. Computed here rather than compared in the browser so the page never
		// has to reason about who it is.
		enteredByMe := false
		if u := core.UserFromCtx(ctx); u != nil {
			enteredByMe = enteredStageBy(ctx, db, id, str(apps[0]["stage"])) == u.ID
		}

		result := map[string]any{
			"application":         apps[0],
			"events":              events,
			"conditions":          conditions,
			"notes":               notes,
			"entered_stage_by_me": enteredByMe,
		}
		respond(w, result, "pg")
	}
}

// losCustomerPortfolio returns a customer's running-credit portfolio from the CBS loan
// book (cbs_loans). These customers were booked directly on Udara, so there is no
// workspace loan_application — the app page shows this portfolio instead of erroring.
func losCustomerPortfolio(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		if cif == "" {
			respondErr(w, 400, "cif required")
			return
		}
		ctx := r.Context()

		// IDENTITY (2026-09-21). The {cif} path param is used BELOW as a Udara
		// cbs_customer_id, but this block was reading app.customers.cif with the SAME
		// string. Those are two different id namespaces and they collide: of the 44
		// Udara customers holding loans, all 44 also exist as a card CIF and 39 of
		// those are a DIFFERENT REAL PERSON. So this page rendered FOLTI TECHNOLOGIES'
		// loan book under Olabode Sanusi's name, phone, email and address — a stranger.
		//
		// app.cbs_links (entity_type='party') is the only correct bridge. The borrower
		// NAME comes from cbs_customers, which is authoritative for a Udara facility.
		// Contact detail comes from the linked party's own customer row when it has one
		// (only 31 of the 295 linked parties do) and is otherwise left blank — a blank
		// phone number is correct, a stranger's phone number is not. A direct cif match
		// is used only when the id is not a Udara customer id at all, which is the
		// genuine cards arm of this endpoint.
		customer := core.Row{}
		if crows, _ := db.PGQuery(ctx, `
			WITH owner AS (
			    SELECT k.entity_id AS party_id
			      FROM app.cbs_links k
			     WHERE k.entity_type = 'party' AND k.cbs_customer_id = $1
			     LIMIT 1
			), contact AS (
			    SELECT c.*
			      FROM app.customers c
			     WHERE (    EXISTS (SELECT 1 FROM owner) AND c.party_id = (SELECT party_id FROM owner))
			        OR (NOT EXISTS (SELECT 1 FROM owner) AND c.cif = $1)
			     ORDER BY (c.party_id IS NULL), c.cif
			     LIMIT 1
			)
			SELECT $1::text AS cif,
			       (SELECT party_id FROM owner) AS party_id,
			       COALESCE(
			           (SELECT NULLIF(TRIM(cc.name),'') FROM cbs_customers cc
			             WHERE cc.cbs_customer_id = $1 LIMIT 1),
			           NULLIF(TRIM(CONCAT(COALESCE(ct.first_name,''),' ',COALESCE(ct.last_name,''))),'')
			       ) AS name,
			       ct.phone, ct.email, ct.state, ct.city,
			       COALESCE(NULLIF(TRIM(ct.full_address),''),
			                NULLIF(TRIM(CONCAT_WS(', ', NULLIF(ct.address_1,''), NULLIF(ct.address_2,''), NULLIF(ct.city,''), NULLIF(ct.state,''))),'')) AS full_address
			  FROM (SELECT 1) _one
			  LEFT JOIN contact ct ON TRUE`, cif); len(crows) > 0 {
			customer = crows[0]
		}

		loans, _ := db.PGQuery(ctx, `
			SELECT cbs_account_number AS account_number, reference_number, product_name, status,
			       loan_amount_kobo, outstanding_principal_kobo, outstanding_interest_kobo, outstanding_fee_kobo,
			       (COALESCE(outstanding_principal_kobo,0)+COALESCE(outstanding_interest_kobo,0)+COALESCE(outstanding_fee_kobo,0)) AS total_outstanding_kobo,
			       interest_rate, tenor_days, installment_amount_kobo,
			       start_date, approved_date, maturity_date, officer_name, branch_name, economic_sector,
			       GREATEST(0, (CURRENT_DATE - maturity_date::date))::int AS dpd
			FROM cbs_loans
			WHERE cbs_customer_id = $1
			ORDER BY outstanding_principal_kobo DESC NULLS LAST`, cif)
		if loans == nil {
			loans = []core.Row{}
		}

		var totalOutstanding, totalDisbursed int64
		worstDPD, openCount := 0, 0
		for _, l := range loans {
			totalOutstanding += toInt64(l["total_outstanding_kobo"])
			totalDisbursed += toInt64(l["loan_amount_kobo"])
			if d := int(toInt64(l["dpd"])); d > worstDPD {
				worstDPD = d
			}
			if st := strings.ToLower(fmt.Sprint(l["status"])); st != "closed" && st != "revoked" {
				openCount++
			}
		}

		respond(w, map[string]any{
			"cif":      cif,
			"customer": customer,
			"loans":    loans,
			"summary": core.Row{
				"loan_count":             len(loans),
				"open_count":             openCount,
				"total_outstanding_kobo": totalOutstanding,
				"total_disbursed_kobo":   totalDisbursed,
				"worst_dpd":              worstDPD,
			},
		}, "pg")
	}
}

func losCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		ApplicantName   string `json:"applicant_name"`
		ApplicantCIF    string `json:"applicant_cif"`
		ApplicantEmail  string `json:"applicant_email"`
		ApplicantPhone  string `json:"applicant_phone"`
		ProductType     string `json:"product_type"`
		AmountRequested int64  `json:"amount_requested_kobo"`
		TenorMonths     int    `json:"tenor_months"`
		InterestRateBPS int    `json:"interest_rate_bps"`
		Purpose         string `json:"purpose"`
		Employer        string `json:"employer"`
		MonthlyIncome   int64  `json:"monthly_income_kobo"`
		// Everything below was already being POSTed by NewApplication.tsx and
		// silently discarded: the struct did not name the fields, so
		// encoding/json dropped them without error. Staff completed the whole
		// Personal Info and Employment steps and none of it was stored.
		// Columns added in migration 216.
		BVN                 string `json:"bvn"`
		NIN                 string `json:"nin"`
		DateOfBirth         string `json:"date_of_birth"`
		Gender              string `json:"gender"`
		Address             string `json:"address"`
		JobTitle            string `json:"job_title"`
		EmploymentType      string `json:"employment_type"`
		EmploymentStartDate string `json:"employment_start_date"`
		// Existing monthly debt service. The column already existed but was only
		// writable later, at credit assessment — while the Phoenix outbox submits
		// at risk_review. An application therefore reached the decision engine
		// with obligations of zero, overstating affordability on the one input
		// that most directly drives DTI.
		MonthlyObligation int64  `json:"monthly_obligation_kobo"`
		SectorCode        string `json:"sector_code"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ApplicantName == "" || b.ProductType == "" {
			respondErr(w, 422, "applicant_name and product_type are required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// Generate reference: LOS-YYYYMM-XXXX using a sequence to avoid TOCTOU races
		now := time.Now().UTC()
		seqRow, err := db.PGQuery(ctx, `SELECT nextval('los_ref_seq') AS seq`)
		if err != nil || len(seqRow) == 0 {
			respondErr(w, 500, "Reference generation failed")
			return
		}
		seq := toInt64(seqRow[0]["seq"])
		ref := fmt.Sprintf("LOS-%s-%04d", now.Format("200601"), seq)

		rows, err := db.PGQuery(ctx, `
			INSERT INTO loan_applications (
				reference, applicant_name, applicant_cif, applicant_email, applicant_phone,
				product_type, amount_requested_kobo, tenor_months, interest_rate_bps,
				purpose, employer, monthly_income_kobo,
				bvn, nin, date_of_birth, residential_address,
				job_title, employment_type, employment_start_date,
				monthly_obligation_kobo, sector_code, gender,
				status, stage, sales_officer_id, assigned_to_user_id,
				created_at, updated_at
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
				NULLIF($13,''), NULLIF($14,''), NULLIF($15,'')::date, NULLIF($16,''),
				NULLIF($17,''), NULLIF($18,''), NULLIF($19,'')::date,
				NULLIF($20,0)::bigint, NULLIF($21,''), NULLIF($23,''),
				'draft','draft',$22,$22,NOW(),NOW())
			RETURNING id, reference, status, stage`,
			ref, b.ApplicantName, b.ApplicantCIF, b.ApplicantEmail, b.ApplicantPhone,
			// A revolving product has no tenor, and the form leaves it blank. Storing
			// the resulting 0 would claim a zero-month term (see migration 217), so an
			// absent tenor goes in as NULL.
			b.ProductType, b.AmountRequested, nullIfZero(int64(b.TenorMonths)), b.InterestRateBPS,
			b.Purpose, b.Employer, b.MonthlyIncome,
			b.BVN, b.NIN, b.DateOfBirth, b.Address,
			b.JobTitle, b.EmploymentType, b.EmploymentStartDate,
			b.MonthlyObligation, b.SectorCode, user.ID, b.Gender)
		if err != nil {
			respondErr(w, 500, "Create failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func losAssign(db *core.DB) http.HandlerFunc {
	type body struct {
		AssignToUserID int64  `json:"assign_to_user_id"`
		Notes          string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AssignToUserID == 0 {
			respondErr(w, 422, "assign_to_user_id is required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		_, err = db.PGExec(ctx,
			`UPDATE loan_applications SET assigned_to_user_id = $1, updated_at = NOW() WHERE id = $2`,
			b.AssignToUserID, id)
		if err != nil {
			respondErr(w, 500, "Assign failed")
			return
		}

		db.PGExec(ctx, `
			INSERT INTO application_events (application_id, event_type, actor_user_id, notes, created_at)
			VALUES ($1, 'assigned', $2, $3, NOW())`,
			id, user.ID, b.Notes) //nolint:errcheck

		// Notify new assignee
		sendNotification(ctx, db, b.AssignToUserID, "los_assigned",
			"Application Assigned",
			fmt.Sprintf("A loan application has been assigned to you"),
			"loan_application", id) //nolint:errcheck

		respondOK(w, "Assigned successfully")
	}
}

func losAdvance(db *core.DB) http.HandlerFunc {
	type body struct {
		ToStage string `json:"to_stage"`
		Notes   string `json:"notes"`
		// Required on the risk head's approval: the amount actually being granted.
		// Pointer so "not sent" is distinguishable from an explicit zero.
		AmountApprovedKobo *int64 `json:"amount_approved_kobo"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		// source_system is read so the Phoenix hand-off below can skip applications
		// Phoenix originated — sending one back would create a duplicate over there.
		apps, err := db.PGQuery(ctx, `SELECT stage, status, reference, amount_approved_kobo, amount_requested_kobo, sales_officer_id, COALESCE(created_by,0) AS created_by, COALESCE(source_system,'workspace') AS source_system FROM loan_applications WHERE id = $1`, id)
		if err != nil || len(apps) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		fromStage := str(apps[0]["stage"])

		// The pipeline is linear — every stage has exactly one successor — so an omitted
		// to_stage resolves to that successor rather than failing. The Risk App Review
		// screen posted only {notes} and got a 422 on every click; rather than teach one
		// caller the stage machine, the server answers the question it already knows.
		// Ambiguity (0 or >1 successors) still 422s, so branching stages added later
		// cannot silently pick a path.
		if b.ToStage == "" {
			next := allowedTransitions[fromStage]
			if len(next) != 1 {
				respondErr(w, 422, fmt.Sprintf(
					"to_stage is required: stage '%s' has %d possible next stages", fromStage, len(next)))
				return
			}
			b.ToStage = next[0]
		}
		loanRef := str(apps[0]["reference"])
		loanKobo := toInt64(apps[0]["amount_approved_kobo"])
		if loanKobo == 0 {
			loanKobo = toInt64(apps[0]["amount_requested_kobo"])
		}
		salesOfficerID := toInt64(apps[0]["sales_officer_id"])

		// Validate transition
		allowed := allowedTransitions[fromStage]
		ok := false
		for _, s := range allowed {
			if s == b.ToStage {
				ok = true
				break
			}
		}
		if !ok {
			respondErr(w, 422, fmt.Sprintf("Transition from '%s' to '%s' is not allowed", fromStage, b.ToStage))
			return
		}

		// Check that the user's role is authorised for this specific transition.
		// los_all acts as a supervisor override (managers can advance any stage).
		if reqPage := transitionRequiredPage[fromStage+":"+b.ToStage]; reqPage != "" {
			if !user.HasPage(reqPage) && !user.HasPage("los_all") {
				respondErr(w, 403, fmt.Sprintf("Your role is not authorised to advance from '%s' to '%s'", fromStage, b.ToStage))
				return
			}
		} else {
			// Transition is allowed but has no mapped page requirement — deny by default so
			// future transitions added to allowedTransitions without a corresponding entry in
			// transitionRequiredPage don't silently become open to all authenticated users.
			if !user.HasPage("los_all") {
				respondErr(w, 403, fmt.Sprintf("Your role is not authorised to advance from '%s' to '%s'", fromStage, b.ToStage))
				return
			}
		}

		// Maker-checker. Nothing here ever compared the actor to the originator, and
		// risk_head/coo hold every stage page at once, so one person could raise a file,
		// review it, and approve it alone. An admin may still push it through — but never
		// silently: the override is written to the audit trail as its own event below.
		makerCheckerOverride := false
		if decisionTransitions[fromStage+":"+b.ToStage] {
			creator := toInt64(apps[0]["created_by"])
			if (salesOfficerID != 0 && salesOfficerID == user.ID) || (creator != 0 && creator == user.ID) {
				if !strings.Contains(strings.ToLower(user.Role), "admin") {
					respondErr(w, 403, "You raised this application, so you cannot also approve it — it needs a second pair of eyes.")
					return
				}
				makerCheckerOverride = true
			}
		}

		// Separation of duties — recorded, not enforced (see enteredStageBy). If the same
		// person moved this file into its current stage and is now deciding it onward, the
		// decision went through one pair of eyes, and the trail says so.
		singleReviewer := decisionTransitions[fromStage+":"+b.ToStage] &&
			enteredStageBy(ctx, db, id, fromStage) == user.ID

		// The credit decision has to name a figure. amount_approved_kobo was written by no
		// handler in this codebase, so the disbursement journal fell through to
		// amount_requested_kobo: the bank booked what the customer asked for, confirmed by
		// nobody. The risk head's approval is where that number is now set and recorded.
		requestedKobo := toInt64(apps[0]["amount_requested_kobo"])
		approvedKobo := int64(0)
		if isApprovalTransition(fromStage, b.ToStage) {
			if b.AmountApprovedKobo == nil || *b.AmountApprovedKobo <= 0 {
				respondErr(w, 422, "Enter the amount you are approving before approving this application")
				return
			}
			if requestedKobo > 0 && *b.AmountApprovedKobo > requestedKobo {
				respondErr(w, 422, "The approved amount cannot exceed the amount requested")
				return
			}
			approvedKobo = *b.AmountApprovedKobo
		}

		// Build extra field updates based on transition
		extra := ""
		switch b.ToStage {
		case "submitted":
			extra = ", submitted_at = NOW()"
		case "risk_review":
			extra = ", risk_officer_id = assigned_to_user_id"
		case "risk_head_review":
			// Risk review is complete at this point. risk_reviewed_at was declared in
			// migration 004 and read by thirteen KPI queries, but written by no line of
			// Go anywhere — so every "Reviewed" figure in the module sat at zero.
			extra = ", risk_reviewed_at = NOW()"
		case "finance_approval":
			extra = ", finance_officer_id = assigned_to_user_id"
		case "booking":
			extra = ", finance_approved_at = NOW(), cards_ops_officer_id = assigned_to_user_id"
		case "active":
			extra = ", booked_at = NOW()"
		}

		// Wrap UPDATE + event INSERT in a transaction so the audit trail is always consistent.
		tx, err := db.PG.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
		if err != nil {
			respondErr(w, 500, "Transaction failed")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Conditional UPDATE: only succeeds if stage hasn't changed since we read it (optimistic lock).
		var updatedID int64
		err = tx.QueryRowContext(ctx,
			fmt.Sprintf(`UPDATE loan_applications SET stage = $1, status = $2%s, updated_at = NOW()
			             WHERE id = $3 AND stage = $4 RETURNING id`, extra),
			b.ToStage, losStageToStatus(b.ToStage), id, fromStage).Scan(&updatedID)
		if err == sql.ErrNoRows {
			respondErr(w, 409, "Application stage changed concurrently — please refresh and try again")
			return
		}
		if err != nil {
			respondErr(w, 500, "Advance failed")
			return
		}

		_, err = tx.ExecContext(ctx, `
			INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
			VALUES ($1, 'stage_advance', $2, $3, $4, $5, NOW())`,
			id, fromStage, b.ToStage, user.ID, b.Notes)
		if err != nil {
			respondErr(w, 500, "Event log failed")
			return
		}

		// Record the approved amount in the same transaction as the approval itself, and
		// book the journal against it rather than against what was requested.
		if approvedKobo > 0 {
			if _, err = tx.ExecContext(ctx,
				`UPDATE loan_applications SET amount_approved_kobo = $1 WHERE id = $2`, approvedKobo, id); err != nil {
				respondErr(w, 500, "Could not record the approved amount")
				return
			}
			if _, err = tx.ExecContext(ctx, `
				INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
				VALUES ($1, 'amount_approved', $2, $3, $4, $5, NOW())`,
				id, fromStage, b.ToStage, user.ID,
				fmt.Sprintf("Approved NGN %.2f of NGN %.2f requested", float64(approvedKobo)/100, float64(requestedKobo)/100)); err != nil {
				respondErr(w, 500, "Event log failed")
				return
			}
			loanKobo = approvedKobo
		}

		// One pair of eyes on a credit decision is a fact an auditor asks about directly,
		// so it gets its own row and can be counted, filtered and reported on.
		if singleReviewer {
			if _, err = tx.ExecContext(ctx, `
				INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
				VALUES ($1, 'single_reviewer', $2, $3, $4, $5, NOW())`,
				id, fromStage, b.ToStage, user.ID,
				"Decided by the same person who performed the previous step on this application"); err != nil {
				respondErr(w, 500, "Event log failed")
				return
			}
		}

		// An override of the second-pair-of-eyes rule is a fact an auditor must be able to
		// find, so it is its own row rather than a note on the advance.
		if makerCheckerOverride {
			if _, err = tx.ExecContext(ctx, `
				INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
				VALUES ($1, 'maker_checker_override', $2, $3, $4, $5, NOW())`,
				id, fromStage, b.ToStage, user.ID,
				"Decided by the person who raised this application, under admin override"); err != nil {
				respondErr(w, 500, "Event log failed")
				return
			}
		}

		// Post GL entry when loan is activated (disbursed)
		if b.ToStage == "active" && loanKobo > 0 {
			if err = postJournalTx(ctx, tx, glEntry{
				Date:          time.Now(),
				Description:   fmt.Sprintf("Loan disbursement — %s", loanRef),
				Reference:     loanRef,
				DebitAccount:  "1100", // Loan Receivable
				CreditAccount: "1001", // Cash/Bank Clearing
				AmountKobo:    loanKobo,
				SourceType:    "loan_disbursement",
				SourceID:      id,
				PostedBy:      user.ID,
			}); err != nil {
				respondErr(w, 500, "GL journal post failed")
				return
			}
		}

		if err = tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		// A decision closes the originator's hand-off either way. Only DECLINE did this
		// before — resolveHandoffsForApplication had exactly one caller — so an APPROVED
		// lead left the call-centre hand-off open for ever and the good outcome never
		// reached whoever raised it.
		if isApprovalTransition(fromStage, b.ToStage) {
			resolveHandoffsForApplication(context.WithoutCancel(ctx), db, id, "resolved", "approved")
		}

		// Tell Phoenix where OUR chain has reached, on every transition.
		//
		// Phoenix runs the customer journey; this is the internal approval chain it
		// has no concept of. Only the initial risk_review hand-off was ever sent, so
		// Phoenix showed MANUAL_REVIEW for an application that had already cleared
		// risk here and was waiting on a finance signature — each side blind to the
		// other half of the same file.
		//
		// Post-commit and fire-and-forget, for the same reason the notifications
		// below are: the stage has already changed here, and an officer's click must
		// not fail because the other system is slow. A missed push costs a stale
		// label over there, which the next transition corrects.
		go phoenixPushStage(context.WithoutCancel(ctx), db, id, b.ToStage, "")

		// Post-commit notifications (non-blocking)
		switch b.ToStage {
		case "submitted":
			go NotifyRoles(context.Background(), db, []string{"risk_officer", "risk_head"}, NotifPayload{
				EventType: EvtLoanSubmitted,
				Title:     "New Loan Application Submitted",
				Body:      fmt.Sprintf("Application %s is ready for risk review", loanRef),
				ActionURL: fmt.Sprintf("/operations/risk/applications/%d", id),
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
		case "risk_review":
			if salesOfficerID != 0 && salesOfficerID != user.ID {
				go Notify(context.Background(), db, NotifPayload{
					EventType: EvtLoanStageChanged,
					UserID:    salesOfficerID,
					Title:     "Application sent to Risk Review",
					Body:      fmt.Sprintf("Application %s has been sent to risk review", loanRef),
					ActionURL: fmt.Sprintf("/sales/applications/%d", id),
					EntityRef: fmt.Sprintf("loan_application:%d", id),
				})
			}
			// Hand off to Phoenix for a credit decision. risk_review is the right
			// trigger: documents have been collected, so this is the first moment the
			// application is complete enough to decide on.
			//
			// Queued, not called inline — a Phoenix restart or a slow decision must not
			// fail the officer's click. Skipped for applications Phoenix originated
			// (they are already decisioned there) and a no-op until Phoenix is
			// configured, at which point the worker drains the backlog.
			if str(apps[0]["source_system"]) != "phoenix" {
				go func() {
					if err := phoenixEnqueue(context.WithoutCancel(ctx), db, id); err != nil {
						slog.Error("phoenix enqueue failed", "application_id", id, "err", err)
					}
				}()
			}
		case "pending_conditions":
			go NotifyRole(context.Background(), db, "risk_head", NotifPayload{
				EventType: EvtLoanStageChanged,
				Title:     "Application ready for condition tracking",
				Body:      fmt.Sprintf("Application %s is ready for condition tracking", loanRef),
				ActionURL: fmt.Sprintf("/operations/risk/applications/%d", id),
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
		case "finance_approval":
			go NotifyRole(context.Background(), db, "finance_officer", NotifPayload{
				EventType: EvtLoanStageChanged,
				Title:     "Application ready for finance approval",
				Body:      fmt.Sprintf("Application %s is ready for finance approval", loanRef),
				ActionURL: fmt.Sprintf("/operations/risk/applications/%d", id),
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
		case "booking":
			go NotifyRole(context.Background(), db, "finance_head", NotifPayload{
				EventType: EvtLoanStageChanged,
				Title:     "Application approved — ready for booking",
				Body:      fmt.Sprintf("Application %s has been approved and is ready for booking", loanRef),
				ActionURL: fmt.Sprintf("/operations/risk/applications/%d", id),
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
		case "active":
			go NotifyRole(context.Background(), db, "finance_head", NotifPayload{
				EventType: EvtLoanApproved,
				Title:     "Loan Disbursed",
				Body:      fmt.Sprintf("Application %s has been disbursed", loanRef),
				ActionURL: fmt.Sprintf("/sales/applications/%d", id),
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
			if salesOfficerID != 0 && salesOfficerID != user.ID {
				go Notify(context.Background(), db, NotifPayload{
					EventType: EvtLoanApproved,
					UserID:    salesOfficerID,
					Title:     "Loan Application Disbursed",
					Body:      fmt.Sprintf("Application %s has been approved and disbursed", loanRef),
					ActionURL: fmt.Sprintf("/sales/applications/%d", id),
					EntityRef: fmt.Sprintf("loan_application:%d", id),
				})
			}
		}

		respondOK(w, "Stage advanced")
	}
}

func losDecline(db *core.DB) http.HandlerFunc {
	type body struct {
		Reason string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Reason == "" {
			respondErr(w, 422, "reason is required")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		apps, err := db.PGQuery(ctx, `SELECT stage, sales_officer_id, reference FROM loan_applications WHERE id = $1`, id)
		if err != nil || len(apps) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		fromStage := str(apps[0]["stage"])
		declSalesID := toInt64(apps[0]["sales_officer_id"])
		loanRefDecl := str(apps[0]["reference"])

		// Declining is the most final thing anyone can do to an application, and it was
		// the only action on the file with NO per-stage authorisation: the route sits on
		// the wide LOS door, so Sales or Card Ops could terminally kill a file sitting in
		// risk head review. Whoever may decide on a file at this stage may decline it —
		// nobody else. Deny-by-default for any stage with no mapped forward transition.
		if reqPage := declineRequiredPage(fromStage); reqPage == "" || (!user.HasPage(reqPage) && !user.HasPage("los_all")) {
			respondErr(w, 403, fmt.Sprintf("Your role is not authorised to decline an application at stage '%s'", fromStage))
			return
		}

		// UPDATE + audit event in one transaction: the event INSERT used to run separately
		// with its error discarded, so a decline could land with no trail behind it.
		dtx, err := db.PG.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
		if err != nil {
			respondErr(w, 500, "Transaction failed")
			return
		}
		defer dtx.Rollback() //nolint:errcheck

		// Atomic decline: guard against concurrent state changes and terminal stages
		var declinedID int64
		err = dtx.QueryRowContext(ctx,
			`UPDATE loan_applications SET status = 'declined', stage = 'declined',
			 decline_reason = $1, updated_at = NOW()
			 WHERE id = $2 AND stage = $3 AND stage NOT IN ('active', 'declined')
			 RETURNING id`,
			b.Reason, id, fromStage).Scan(&declinedID)
		if err == sql.ErrNoRows {
			respondErr(w, 409, "Application is already in a terminal state or was updated concurrently")
			return
		}
		if err != nil {
			respondErr(w, 500, "Decline failed")
			return
		}

		if _, err = dtx.ExecContext(ctx, `
			INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
			VALUES ($1, 'declined', $2, 'declined', $3, $4, NOW())`,
			id, fromStage, user.ID, b.Reason); err != nil {
			respondErr(w, 500, "Event log failed")
			return
		}
		if err = dtx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		// Phoenix runs the customer journey and only ever heard about advances, so it kept
		// showing MANUAL_REVIEW for a file this side had already declined.
		go phoenixPushStage(context.WithoutCancel(ctx), db, id, "declined", b.Reason)

		// Reflect-back: close any open hand-off for this customer (e.g. the call-centre
		// agent who forwarded the lead) so the ineligible outcome reaches the originator
		// instead of the application dying silently in LOS.
		resolveHandoffsForApplication(ctx, db, id, "returned", "ineligible")

		if declSalesID != 0 && declSalesID != user.ID {
			go Notify(context.Background(), db, NotifPayload{
				EventType: EvtLoanRejected,
				UserID:    declSalesID,
				Title:     "Loan Application Declined",
				Body:      fmt.Sprintf("Application %s has been declined: %s", loanRefDecl, b.Reason),
				ActionURL: fmt.Sprintf("/sales/applications/%d", id),
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
		}

		respondOK(w, "Application declined")
	}
}

func losRequestInfo(db *core.DB) http.HandlerFunc {
	type body struct {
		Notes string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		apps, err := db.PGQuery(ctx, `
			SELECT stage, request_info_count, COALESCE(sales_officer_id,0) AS sales_officer_id,
			       COALESCE(assigned_to_user_id,0) AS assigned_to_user_id, COALESCE(reference,'') AS reference
			  FROM loan_applications WHERE id = $1`, id)
		if err != nil || len(apps) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}

		count := int(toInt64(apps[0]["request_info_count"]))
		if count >= 2 {
			respondErr(w, 422, "Maximum request-info cycles (2) already reached")
			return
		}

		fromStage := str(apps[0]["stage"])

		// A closed file is not somewhere information can be sent back to. There was no
		// terminal guard at all, and 'declined'/'active' appear nowhere in the stage list
		// below — so the old default resurrected a declined, or already disbursed,
		// application back into document_collection on one API call.
		if fromStage == "declined" || fromStage == "active" || fromStage == "closed" {
			respondErr(w, 409, "This application is closed — it cannot be sent back for more information")
			return
		}

		stageOrder := []string{
			"draft", "submitted", "document_collection", "risk_review",
			"risk_head_review", "pending_conditions", "finance_approval", "booking",
		}
		idx := -1
		for i, s := range stageOrder {
			if s == fromStage {
				idx = i
				break
			}
		}
		// A draft has nowhere to go back TO. The old loop skipped index 0 and left the
		// default of "document_collection" standing, so "send back for more information"
		// pushed a draft FORWARD two stages, past submitted, with no permission check.
		if idx <= 0 {
			respondErr(w, 422, "This application is still a draft — there is nothing to send it back to")
			return
		}
		prevStage := stageOrder[idx-1]

		// Optimistic lock, like every other stage move in this file.
		res, err := db.PGExec(ctx,
			`UPDATE loan_applications SET stage = $1, status = $2,
			 request_info_count = request_info_count + 1, updated_at = NOW()
			 WHERE id = $3 AND stage = $4`,
			prevStage, losStageToStatus(prevStage), id, fromStage)
		if err != nil {
			respondErr(w, 500, "Request info failed")
			return
		}
		if n, rerr := res.RowsAffected(); rerr == nil && n == 0 {
			respondErr(w, 409, "Application stage changed concurrently — please refresh and try again")
			return
		}

		db.PGExec(ctx, `
			INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
			VALUES ($1, 'request_info', $2, $3, $4, $5, NOW())`,
			id, fromStage, prevStage, user.ID, b.Notes) //nolint:errcheck

		// The file has just landed back on someone else's desk. Nothing told them — while
		// the dialog that sends it promises "the assigned officer will be notified" — so
		// it simply sat there until somebody happened to refresh the queue.
		NotifyExcept(context.WithoutCancel(ctx), db,
			[]int64{toInt64(apps[0]["assigned_to_user_id"]), toInt64(apps[0]["sales_officer_id"])}, user.ID,
			NotifPayload{
				EventType: EvtLoanStageChanged,
				Title:     "More Information Needed",
				Body:      fmt.Sprintf("Application %s was sent back for more information: %s", str(apps[0]["reference"]), b.Notes),
				ActionURL: fmt.Sprintf("/sales/applications/%d", id),
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})

		respondOK(w, "Sent back for more information")
	}
}

func losAddCondition(db *core.DB) http.HandlerFunc {
	type body struct {
		ConditionText string `json:"condition_text"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.ConditionText == "" {
			respondErr(w, 422, "condition_text is required")
			return
		}

		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO application_conditions (application_id, condition_text, is_met, created_by, created_at)
			VALUES ($1, $2, FALSE, $3, NOW())
			RETURNING id, condition_text, is_met, created_by, created_at`,
			id, b.ConditionText, user.ID)
		if err != nil {
			respondErr(w, 500, "Create condition failed")
			return
		}
		// A condition is a term of the credit: who attached it belongs in the trail, not
		// just the text of it. Nothing recorded either before.
		db.PGExec(r.Context(), `
			INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
			SELECT $1, 'condition_added', la.stage, la.stage, $2, $3, NOW()
			  FROM loan_applications la WHERE la.id = $1`,
			id, user.ID, b.ConditionText) //nolint:errcheck
		respond(w, rows[0], "pg")
	}
}

func losMarkConditionMet(db *core.DB) http.HandlerFunc {
	// A condition ticked off by mistake used to be permanent: this endpoint ignored its
	// body and could only ever set is_met = TRUE. It now carries the state being set, so
	// the same control can undo itself.
	type body struct {
		IsMet *bool `json:"is_met"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		cid, err := strconv.ParseInt(chi.URLParam(r, "cid"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid condition ID")
			return
		}
		var b body
		_ = json.NewDecoder(r.Body).Decode(&b) // an empty body still means "met", as before
		met := b.IsMet == nil || *b.IsMet

		user := core.UserFromCtx(r.Context())

		// met_by/met_at are cleared when a condition is reopened, so they never describe
		// a state the row is no longer in.
		res, err := db.PGExec(r.Context(), `
			UPDATE application_conditions
			SET is_met = $1,
			    met_by = CASE WHEN $1 THEN $2::BIGINT ELSE NULL END,
			    met_at = CASE WHEN $1 THEN NOW()       ELSE NULL END
			WHERE id = $3 AND application_id = $4`,
			met, user.ID, cid, id)
		if err != nil {
			respondErr(w, 500, "Update failed")
			return
		}
		// A wrong condition id used to return 200 and a success toast, having changed
		// nothing at all.
		if n, rerr := res.RowsAffected(); rerr == nil && n == 0 {
			respondErr(w, 404, "That condition is not on this application")
			return
		}
		evt := "condition_met"
		if !met {
			evt = "condition_reopened"
		}
		db.PGExec(r.Context(), `
			INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
			SELECT $1, $2, la.stage, la.stage, $3, c.condition_text, NOW()
			  FROM loan_applications la, application_conditions c
			 WHERE la.id = $1 AND c.id = $4`,
			id, evt, user.ID, cid) //nolint:errcheck
		if !met {
			respondOK(w, "Condition reopened")
			return
		}
		respondOK(w, "Condition marked as met")
	}
}

func losAddNote(db *core.DB) http.HandlerFunc {
	type body struct {
		Body       string `json:"body"`
		IsInternal bool   `json:"is_internal"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Body == "" {
			respondErr(w, 422, "body is required")
			return
		}

		user := core.UserFromCtx(r.Context())

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO application_notes (application_id, author_id, body, is_internal, created_at)
			VALUES ($1, $2, $3, $4, NOW())
			RETURNING id, body, is_internal, created_at`,
			id, user.ID, b.Body, b.IsInternal)
		if err != nil {
			respondErr(w, 500, "Add note failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func losGetEvents(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT e.*, COALESCE(u.full_name, e.actor_label) AS actor_name
			FROM application_events e
			LEFT JOIN o3c_users u ON e.actor_user_id = u.id
			WHERE e.application_id = $1
			ORDER BY e.created_at ASC`, id)
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

func losFunnel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
				stage,
				COUNT(*)                                                                     AS count,
				COALESCE(SUM(amount_requested_kobo), 0)                                     AS pipeline_kobo,
				COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400.0), 0)  AS avg_days_in_stage
			FROM loan_applications
			GROUP BY stage
			ORDER BY
				CASE stage
					WHEN 'draft'             THEN 1
					WHEN 'submitted'         THEN 2
					WHEN 'document_collection' THEN 3
					WHEN 'risk_review'       THEN 4
					WHEN 'risk_head_review'  THEN 5
					WHEN 'pending_conditions' THEN 6
					WHEN 'finance_approval'  THEN 7
					WHEN 'booking'           THEN 8
					WHEN 'active'            THEN 9
					WHEN 'declined'          THEN 10
					ELSE 11
				END`)
		if err != nil {
			respondErr(w, 500, "Funnel query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// losOverview returns the loan pipeline as { by_stage: [{stage, count}] } in
// canonical stage order, excluding terminal (declined/closed) applications.
// Consumed by the marketing acquisition funnel (LOS Pipeline column).
func losOverview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT stage, COUNT(*) AS count
			FROM loan_applications
			WHERE stage NOT IN ('declined', 'closed')
			GROUP BY stage
			ORDER BY
				CASE stage
					WHEN 'draft'               THEN 1
					WHEN 'submitted'           THEN 2
					WHEN 'document_collection' THEN 3
					WHEN 'risk_review'         THEN 4
					WHEN 'risk_head_review'    THEN 5
					WHEN 'pending_conditions'  THEN 6
					WHEN 'finance_approval'    THEN 7
					WHEN 'booking'             THEN 8
					WHEN 'active'              THEN 9
					ELSE 10
				END`)
		if err != nil {
			respondErr(w, 500, "LOS overview query failed")
			return
		}
		byStage := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			byStage = append(byStage, map[string]any{
				"stage": str(row["stage"]), "count": toInt64(row["count"]),
			})
		}
		respond(w, map[string]any{"by_stage": byStage}, "pg")
	}
}

func losSaveCreditAssessment(db *core.DB) http.HandlerFunc {
	type body struct {
		EyeScore              *int     `json:"eye_score"`
		EyeRating             string   `json:"eye_rating"`
		BureauSummary         string   `json:"bureau_summary"`
		DtiPct                *float64 `json:"dti_pct"`
		MonthlyIncomeKobo     *int64   `json:"monthly_income_kobo"`
		MonthlyObligationKobo *int64   `json:"monthly_obligation_kobo"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		ns := func(s string) any {
			if s == "" {
				return nil
			}
			return s
		}
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		// What the numbers were before this override. eye_score and eye_rating are what
		// the entire review queue sorts, filters and decides on, and a manual change to
		// them recorded no actor and no event — so a hand-edited score was
		// indistinguishable from Phoenix's own, which is exactly what the UI claims it
		// flags. Read first, so the trail can say what it replaced.
		before, _ := db.PGQuery(ctx, `
			SELECT COALESCE(eye_score,0) AS eye_score, COALESCE(eye_rating,'') AS eye_rating,
			       dti_pct, COALESCE(stage,'') AS stage
			  FROM loan_applications WHERE id = $1`, id)

		rows, err := db.PGQuery(ctx,
			`UPDATE loan_applications
			 SET eye_score=$1, eye_rating=$2, bureau_summary=$3, dti_pct=$4,
			     monthly_income_kobo=$5, monthly_obligation_kobo=$6, updated_at=NOW()
			 WHERE id=$7 RETURNING id, eye_score, eye_rating, bureau_summary, dti_pct,
			     monthly_income_kobo, monthly_obligation_kobo`,
			b.EyeScore, ns(b.EyeRating), ns(b.BureauSummary),
			b.DtiPct, b.MonthlyIncomeKobo, b.MonthlyObligationKobo, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Update failed")
			return
		}

		if len(before) > 0 && user != nil {
			newScore := int64(0)
			if b.EyeScore != nil {
				newScore = int64(*b.EyeScore)
			}
			var newDti any
			if b.DtiPct != nil {
				newDti = *b.DtiPct
			}
			db.PGExec(ctx, `
				INSERT INTO application_events (application_id, event_type, from_stage, to_stage, actor_user_id, notes, created_at)
				VALUES ($1, 'credit_assessment_override', $2, $2, $3, $4, NOW())`,
				id, str(before[0]["stage"]), user.ID,
				fmt.Sprintf("Eye score %d → %d; rating %q → %q; DTI %v → %v",
					toInt64(before[0]["eye_score"]), newScore,
					str(before[0]["eye_rating"]), b.EyeRating,
					before[0]["dti_pct"], newDti)) //nolint:errcheck
		}
		respond(w, rows[0], "json")
	}
}

// losStageToStatus maps a LOS workflow stage to its canonical status value.
func losStageToStatus(stage string) string {
	switch stage {
	case "approved", "booking":
		return "approved"
	case "declined", "rejected":
		return "declined"
	case "active":
		return "active"
	default:
		return "pending"
	}
}

// ── LOS Document Upload ────────────────────────────────────────────────────────

func losGetDocuments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		appID, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "invalid application id")
			return
		}
		// Documents collected BEFORE the application existed live in app.lead_documents,
		// anchored to the lead/CIF/phone rather than to an application id. Nothing ever
		// copied or re-anchored them when a lead converted — migration 232 promised they
		// would "follow the person", and no code implemented it — so the credit officer
		// saw every slot as Pending and asked the customer for papers Sales already held.
		//
		// They are surfaced live rather than copied: one file, one truth, and anything
		// collected after conversion appears too. Each row says where it came from and
		// how to fetch it, because the two stores are served by different routes and
		// their ids overlap (both are plain serials).
		rows, err := db.PGQuery(r.Context(), `
			WITH la AS (
			  SELECT id,
			         NULLIF(applicant_cif,'')                   AS cif,
			         NULLIF(app.norm_phone(applicant_phone),'') AS phone,
			         source_lead_id
			    FROM loan_applications WHERE id = $1
			)
			SELECT d.id, d.application_id, d.doc_type, d.file_name, d.file_url,
			       d.file_size_bytes, d.created_at,
			       u.full_name AS uploaded_by_name,
			       'application'::text AS source,
			       '/api/los/documents/' || d.id || '/content' AS content_url
			  FROM los_documents d
			  LEFT JOIN o3c_users u ON u.id = d.uploaded_by
			 WHERE d.application_id = $1
			UNION ALL
			SELECT ld.id, NULL::bigint AS application_id, ld.doc_type, ld.file_name, ld.file_url,
			       ld.file_size_bytes, ld.created_at,
			       u2.full_name AS uploaded_by_name,
			       'pre_application'::text AS source,
			       '/api/activities/documents/' || ld.id || '/content' AS content_url
			  FROM app.lead_documents ld
			  LEFT JOIN o3c_users u2 ON u2.id = ld.uploaded_by
			  CROSS JOIN la
			 WHERE (la.source_lead_id IS NOT NULL AND ld.lead_id = la.source_lead_id)
			    OR (la.cif   IS NOT NULL AND ld.cif = la.cif)
			    -- length(10) guard: app.norm_phone returns '' rather than NULL, and a
			    -- short/malformed number would otherwise match another malformed one.
			    OR (la.phone IS NOT NULL AND length(la.phone) = 10 AND ld.phone = la.phone)
			 ORDER BY created_at ASC`, appID)
		if err != nil {
			respondErr(w, 500, "query failed: "+err.Error())
			return
		}
		jsonRows(w, rows)
	}
}

func losUploadDocument(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		appID, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "invalid application id")
			return
		}
		user := core.UserFromCtx(r.Context())

		if err := r.ParseMultipartForm(20 << 20); err != nil {
			respondErr(w, 400, "failed to parse form")
			return
		}
		docType := r.FormValue("doc_type")
		if docType == "" {
			respondErr(w, 400, "doc_type is required")
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			respondErr(w, 400, "field 'file' is required")
			return
		}
		defer file.Close()

		data, err := io.ReadAll(file)
		if err != nil {
			respondErr(w, 500, "failed to read file")
			return
		}

		contentType := header.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "application/octet-stream"
		}

		filename := strings.ReplaceAll(header.Filename, " ", "_")
		uid := fmt.Sprintf("%d", time.Now().UnixNano())

		accountID := os.Getenv("R2_ACCOUNT_ID")
		bucketName := os.Getenv("R2_BUCKET_NAME")
		accessKey := os.Getenv("R2_ACCESS_KEY_ID")
		secretKey := os.Getenv("R2_SECRET_ACCESS_KEY")
		r2Configured := accountID != "" && bucketName != "" && accessKey != "" && secretKey != ""

		var fileURL, storageKey string

		if r2Configured {
			storageKey = fmt.Sprintf("los-documents/%d/%s/%s", appID, uid, filename)
			endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com/%s/%s",
				accountID, bucketName, storageKey)
			if err := r2Put(endpoint, accessKey, secretKey, accountID, bucketName, storageKey, contentType, data); err != nil {
				slog.Warn("losUploadDocument: R2 upload failed", "err", err)
				respondErr(w, 502, "file upload failed: "+err.Error())
				return
			}
			publicBase := strings.TrimRight(os.Getenv("R2_PUBLIC_BASE_URL"), "/")
			if publicBase != "" {
				fileURL = publicBase + "/" + storageKey
			} else {
				fileURL = endpoint
			}
		} else {
			// Local fallback. Was "/tmp/los-documents", which on Windows resolves
			// against whatever the current drive is and sits in a directory the OS
			// may clear — losDocumentDir() points at the data drive instead.
			dir := fmt.Sprintf("%s/%d/%s", strings.TrimRight(losDocumentDir(), "/"), appID, uid)
			if err := os.MkdirAll(dir, 0755); err != nil {
				respondErr(w, 500, "storage error")
				return
			}
			dest := fmt.Sprintf("%s/%s", dir, filename)
			if err := os.WriteFile(dest, data, 0644); err != nil {
				respondErr(w, 500, "write error")
				return
			}
			storageKey = dest
			// file_url is filled in below, once the row has an id: documents are
			// addressed by id, not by a path built from the filename, so there is
			// no caller-controlled path segment to traverse.
			fileURL = ""
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO los_documents
			    (application_id, doc_type, file_name, file_url, storage_key, file_size_bytes, uploaded_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING id, application_id, doc_type, file_name, file_url, file_size_bytes, created_at`,
			appID, docType, filename, fileURL, storageKey, len(data), user.ID)
		if err != nil {
			respondErr(w, 500, "db insert failed: "+err.Error())
			return
		}
		if len(rows) == 0 {
			respondErr(w, 500, "insert returned no rows")
			return
		}
		// A locally-stored document is addressed by its row id. That is only known
		// after the insert, so file_url is backfilled here rather than guessed
		// beforehand from a path.
		if fileURL == "" {
			newID := toInt64(rows[0]["id"])
			contentURL := fmt.Sprintf("/api/los/documents/%d/content", newID)
			if _, uerr := db.PGExec(r.Context(),
				`UPDATE los_documents SET file_url=$1 WHERE id=$2`, contentURL, newID); uerr != nil {
				slog.Error("losUploadDocument: could not set file_url", "doc_id", newID, "err", uerr)
			}
			rows[0]["file_url"] = contentURL
		}
		// Activity stream: a document collected on the application → the customer's timeline
		// (this is the "collected documents" step). Anchored on the application; the DB
		// trigger resolves the party from applicant_cif.
		{
			docID := toInt64(rows[0]["id"])
			aid, aname, ateam := actorOf(user)
			logActivitySafe(r.Context(), db, Activity{
				ApplicationID: &appID, ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
				Type: "document", Subject: "Document uploaded — " + docType, Source: "los",
				EntityType: "los_document", EntityID: strconv.FormatInt(docID, 10),
				Metadata: map[string]any{"doc_type": docType, "file_name": filename},
			})
		}
		respond(w, rows[0], "json")
	}
}

func losDeleteDocument(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		docID, err := strconv.ParseInt(chi.URLParam(r, "doc_id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "invalid doc id")
			return
		}
		user := core.UserFromCtx(r.Context())

		// Allow deleting own uploads or if user has los_all permission.
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, uploaded_by FROM los_documents WHERE id = $1`, docID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "document not found")
			return
		}
		uploadedBy := toInt64(rows[0]["uploaded_by"])
		if uploadedBy != user.ID && !user.HasPage("los_all") {
			respondErr(w, 403, "cannot delete another user's upload")
			return
		}

		if _, err := db.PGExec(r.Context(),
			`DELETE FROM los_documents WHERE id = $1`, docID); err != nil {
			respondErr(w, 500, "delete failed: "+err.Error())
			return
		}
		w.WriteHeader(204)
	}
}

// ── LOS Messaging ─────────────────────────────────────────────────────────────

func losTeamUsers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, full_name, role FROM o3c_users WHERE is_active = TRUE ORDER BY full_name ASC`)
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

func losGetMessages(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT * FROM application_messages
			WHERE application_id = $1
			ORDER BY created_at ASC`, id)
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

func losPostMessage(db *core.DB) http.HandlerFunc {
	type body struct {
		Body       string  `json:"body"`
		MentionIDs []int64 `json:"mention_ids"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Body == "" {
			respondErr(w, 422, "body is required")
			return
		}
		if b.MentionIDs == nil {
			b.MentionIDs = []int64{}
		}

		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		apps, err := db.PGQuery(ctx, `SELECT reference FROM loan_applications WHERE id = $1`, id)
		if err != nil || len(apps) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		loanRef := str(apps[0]["reference"])

		mentionJSON, _ := json.Marshal(b.MentionIDs)
		rows, err := db.PGQuery(ctx, `
			INSERT INTO application_messages
			    (application_id, author_user_id, author_name, author_role, body, mention_ids, msg_type)
			VALUES ($1, $2, $3, $4, $5, $6, 'message')
			RETURNING id, application_id, author_user_id, author_name, author_role, body, mention_ids, msg_type, created_at`,
			id, user.ID, user.FullName, user.Role, b.Body, string(mentionJSON))
		if err != nil {
			respondErr(w, 500, "Insert failed")
			return
		}

		// Notify mentioned users (skip self)
		actionURL := fmt.Sprintf("/operations/risk/applications/%d", id)
		if loanRef == "" {
			actionURL = fmt.Sprintf("/sales/applications/%d", id)
		}
		for _, mentionID := range b.MentionIDs {
			if mentionID == user.ID {
				continue
			}
			mid := mentionID
			go Notify(context.Background(), db, NotifPayload{
				EventType: EvtLoanStageChanged,
				UserID:    mid,
				Title:     fmt.Sprintf("You were mentioned in %s", loanRef),
				Body:      fmt.Sprintf("%s mentioned you: %.100s", user.FullName, b.Body),
				ActionURL: actionURL,
				EntityRef: fmt.Sprintf("loan_application:%d", id),
			})
		}

		respond(w, rows[0], "pg")
	}
}

// losEyeReport proxies to the Phoenix OS Eye scoring service.
// On the first call it scores on demand and caches the Eye application_id (eye_report_id).
// Subsequent calls retrieve the cached decision via GET instead of re-scoring.
// losEyeDecision returns Phoenix's full Eye decision for an application, exactly as
// Phoenix returns it.
//
// The payload is passed through and rendered by a port of Phoenix's own credit-report
// panel. Reshaping it here would mean staff read a different report from the one
// Phoenix shows for the same decision, which is precisely the drift this path exists
// to avoid. The single exception is national identity numbers: Phoenix returns BVN
// and NIN in plain text, so they are masked to the last four before sending, the same
// rule every other workspace screen follows.
//
// Two states are "no report" rather than failures, and both answer 200 with a null
// body so the page can say so plainly: an application never submitted to Phoenix
// (no phoenix_id), and one submitted but not yet scored (Phoenix 404s).
func losEyeDecision(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}

		var phoenixID string
		err = db.PG.QueryRowContext(r.Context(),
			`SELECT COALESCE(phoenix_id, '') FROM app.loan_applications WHERE id = $1`, id).
			Scan(&phoenixID)
		if err == sql.ErrNoRows {
			respondErr(w, 404, "Application not found")
			return
		}
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if strings.TrimSpace(phoenixID) == "" {
			respond(w, map[string]any{"decision": nil, "reason": "not_submitted"}, "pg")
			return
		}

		raw, err := phoenixEyeDecision(r.Context(), phoenixID)
		if err != nil {
			respondPhoenixErr(w, r, err, "read the Eye decision")
			return
		}
		if raw == nil {
			respond(w, map[string]any{"decision": nil, "reason": "not_scored"}, "pg")
			return
		}

		// Mirror Phoenix's customer-journey stage from the payload we just fetched.
		phoenixSyncStage(r.Context(), db, id, raw)

		// Mask national identity numbers before anything reaches the browser — see
		// maskPhoenixIdentifiers. Fail closed: a payload that cannot be safely masked
		// is not sent at all.
		safe, err := maskPhoenixIdentifiers(raw)
		if err != nil {
			respondErrLog(w, 502, "Could not prepare the Eye report safely", err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"decision":`)) //nolint:errcheck
		w.Write(safe)                           //nolint:errcheck
		w.Write([]byte(`}}`))                   //nolint:errcheck
	}
}

func losEyeReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		eyeURL := strings.TrimRight(os.Getenv("EYE_SERVICE_URL"), "/")
		eyeKey := os.Getenv("EYE_SERVICE_KEY")
		eyeTenant := os.Getenv("EYE_TENANT_ID")

		if eyeURL == "" {
			// Not respondErr: its 5xx scrubbing turned this into "Internal server error".
			writePhoenixFailure(w, phoenixFailure{http.StatusServiceUnavailable, "EYE_NOT_CONFIGURED",
				"The Eye scoring service is not configured on this workspace server (EYE_SERVICE_URL), so there is no Eye report to show."}, nil)
			return
		}

		appID, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}

		appRows, err := db.PGQuery(r.Context(), `
			SELECT applicant_cif,
			       COALESCE(amount_requested_kobo, 0)   AS amount_requested_kobo,
			       COALESCE(tenor_months, 0)             AS tenor_months,
			       COALESCE(monthly_income_kobo, 0)      AS monthly_income_kobo,
			       COALESCE(monthly_obligation_kobo, 0)  AS monthly_obligation_kobo,
			       COALESCE(eye_report_id, '')            AS eye_report_id
			FROM loan_applications WHERE id = $1`, appID)
		if err != nil || len(appRows) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		app := appRows[0]

		eyeReportID := str(app["eye_report_id"])

		var eyeHTTPReq *http.Request
		if eyeReportID != "" {
			eyeHTTPReq, err = http.NewRequestWithContext(r.Context(), "GET",
				eyeURL+"/score/internal/"+eyeReportID, nil)
		} else {
			incomeKobo := int64(0)
			obligKobo := int64(0)
			amountKobo := int64(0)
			tenorMonths := int64(0)
			if v, ok := app["monthly_income_kobo"].(int64); ok {
				incomeKobo = v
			}
			if v, ok := app["monthly_obligation_kobo"].(int64); ok {
				obligKobo = v
			}
			if v, ok := app["amount_requested_kobo"].(int64); ok {
				amountKobo = v
			}
			if v, ok := app["tenor_months"].(int64); ok {
				tenorMonths = v
			}

			payload, _ := json.Marshal(map[string]any{
				"customer_id":       str(app["applicant_cif"]),
				"tenant_id":         eyeTenant,
				"requested_amount":  amountKobo,
				"tenor_months":      tenorMonths,
				"borrower_category": "individual",
				"open_banking": map[string]any{
					"avg_monthly_inflow":  incomeKobo,
					"avg_monthly_outflow": obligKobo,
				},
			})

			eyeHTTPReq, err = http.NewRequestWithContext(r.Context(), "POST",
				eyeURL+"/score/internal", bytes.NewReader(payload))
			if err == nil {
				eyeHTTPReq.Header.Set("Content-Type", "application/json")
			}
		}
		if err != nil {
			respondErr(w, 500, "Failed to build Eye request")
			return
		}
		eyeHTTPReq.Header.Set("X-Service-Key", eyeKey)

		eyeResp, err := http.DefaultClient.Do(eyeHTTPReq)
		if err != nil {
			respondEyeServiceErr(w, err)
			return
		}
		defer eyeResp.Body.Close()

		respBody, err := io.ReadAll(eyeResp.Body)
		if err != nil {
			writePhoenixFailure(w, phoenixFailure{http.StatusBadGateway, "EYE_BAD_REPLY",
				"The Eye scoring service answered, but its reply could not be read. Try again."}, err)
			return
		}

		// Cache the Eye application_id so future calls retrieve the same decision.
		if eyeReportID == "" && eyeResp.StatusCode == http.StatusOK {
			var parsed map[string]any
			if json.Unmarshal(respBody, &parsed) == nil {
				if eyeAppID, ok := parsed["application_id"].(string); ok && eyeAppID != "" {
					_, _ = db.PGQuery(r.Context(),
						`UPDATE loan_applications SET eye_report_id = $1 WHERE id = $2`,
						eyeAppID, appID)
				}
			}
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(eyeResp.StatusCode)
		_, _ = w.Write(respBody)
	}
}
