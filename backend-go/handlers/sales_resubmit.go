package handlers

// Resubmitting a declined application.
//
// A declined application cannot simply be sent to Phoenix again: the workspace
// submits with Idempotency-Key "wsapp-{application id}", so re-sending the same row
// would replay Phoenix's original answer rather than ask again. A resubmission is a
// new application. This makes it cheap: it copies the declined one into a new draft
// — every field, including the identity and employment detail the quick form does
// not show — links the two on both activity trails, and hands the draft back so the
// officer can change whatever needs changing before submitting it through the
// normal draft flow.

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

func resubmitSalesApp(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		ctx := r.Context()
		id := strings.TrimSpace(chi.URLParam(r, "id"))

		var (
			origID                  int64
			origRef, stage, product string
			officer                 sql.NullInt64
			declineReason           sql.NullString
		)
		err := db.PG.QueryRowContext(ctx, `
			SELECT id, reference, stage, product_type, sales_officer_id, decline_reason
			  FROM loan_applications WHERE id = $1`, id).
			Scan(&origID, &origRef, &stage, &product, &officer, &declineReason)
		if err == sql.ErrNoRows {
			respondErr(w, 404, "Application not found")
			return
		}
		if err != nil {
			respondErrLog(w, 500, "Could not read the application", err)
			return
		}

		// Only a declined application is resubmitted. One still open is still being
		// decided — change it there — and an active facility is not an application.
		if stage != "declined" {
			respondErr(w, 409, "Only a declined application can be resubmitted; this one is at "+strings.ReplaceAll(stage, "_", " "))
			return
		}
		// The same rule as raising one: the officer who owns it, or a sales head.
		if !isSalesHead(user) && (!officer.Valid || officer.Int64 != user.ID) {
			respondErr(w, 403, "Only the application's sales officer or a sales head can resubmit it")
			return
		}

		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "Could not start transaction")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// One open resubmission at a time. A second press — or a colleague pressing
		// too — reopens the draft already made rather than minting another. The lock
		// makes two simultaneous presses see each other.
		if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, fmt.Sprintf("resubmit:%d", origID)); err != nil {
			respondErr(w, 500, "Could not acquire the resubmission lock")
			return
		}

		out := map[string]any{"resubmitted_from": map[string]any{"id": origID, "reference": origRef}}
		scan := func(row *sql.Row) error {
			var (
				nid                         int64
				nref, nprod, ncif, nname    string
				namount, nincome            int64
				ntenor                      int
				npurpose, nemployer, nstage string
			)
			if err := row.Scan(&nid, &nref, &nprod, &ncif, &nname, &namount, &ntenor, &npurpose, &nemployer, &nincome, &nstage); err != nil {
				return err
			}
			for k, v := range map[string]any{
				"id": nid, "reference": nref, "product_type": nprod, "applicant_cif": ncif,
				"applicant_name": nname, "amount_requested_kobo": namount, "tenor_months": ntenor,
				"purpose": npurpose, "employer": nemployer, "monthly_income_kobo": nincome, "stage": nstage,
			} {
				out[k] = v
			}
			return nil
		}
		const cols = `id, reference, product_type, COALESCE(applicant_cif,''), COALESCE(applicant_name,''),
		              amount_requested_kobo, COALESCE(tenor_months,0), COALESCE(purpose,''),
		              COALESCE(employer,''), COALESCE(monthly_income_kobo,0), stage`

		// Is there already an open resubmission of this application?
		err = scan(tx.QueryRowContext(ctx, `
			SELECT `+cols+`
			  FROM loan_applications la
			 WHERE la.stage NOT IN ('declined', 'active')
			   AND EXISTS (SELECT 1 FROM application_events e
			                WHERE e.application_id = la.id AND e.event_type = 'resubmission'
			                  AND e.notes LIKE $1)
			 ORDER BY la.id DESC LIMIT 1`, "Resubmission of "+origRef+"%"))
		if err == nil {
			if cerr := tx.Commit(); cerr != nil {
				respondErr(w, 500, "Commit failed")
				return
			}
			out["existing"] = true
			respond(w, out, "pg")
			return
		}
		if err != sql.ErrNoRows {
			respondErrLog(w, 500, "Could not check for an existing resubmission", err)
			return
		}

		var seq int64
		if err := tx.QueryRowContext(ctx, `SELECT nextval('los_ref_seq')`).Scan(&seq); err != nil {
			respondErr(w, 500, "Reference generation failed")
			return
		}
		newRef := fmt.Sprintf("LOS-%s-%04d", time.Now().UTC().Format("200601"), seq)

		// Copied server-side, column for column, so nothing the officer or the
		// applicant already gave is lost — including what the quick form cannot show.
		// Decision, Phoenix and offer state are deliberately not copied: this is a new
		// application and gets a new decision.
		if err := scan(tx.QueryRowContext(ctx, `
			INSERT INTO loan_applications (
			    reference, applicant_name, applicant_cif, applicant_email, applicant_phone,
			    product_type, amount_requested_kobo, tenor_months, interest_rate_bps,
			    purpose, employer, monthly_income_kobo, monthly_obligation_kobo,
			    bvn, nin, date_of_birth, residential_address, job_title,
			    employment_type, employment_start_date, sector_code, source_lead_id, lead_source,
			    status, stage, sales_officer_id, assigned_to_user_id, created_by, created_at, updated_at)
			SELECT $2, applicant_name, applicant_cif, applicant_email, applicant_phone,
			       product_type, amount_requested_kobo, tenor_months, interest_rate_bps,
			       purpose, employer, monthly_income_kobo, monthly_obligation_kobo,
			       bvn, nin, date_of_birth, residential_address, job_title,
			       employment_type, employment_start_date, sector_code, source_lead_id, lead_source,
			       'draft', 'draft', COALESCE(sales_officer_id, $3), $3, $3, NOW(), NOW()
			  FROM loan_applications WHERE id = $1
			RETURNING `+cols, origID, newRef, user.ID)); err != nil {
			respondErrLog(w, 500, "Could not create the resubmission", err)
			return
		}
		newID, _ := out["id"].(int64)

		reason := strings.TrimSpace(declineReason.String)
		newNote := "Resubmission of " + origRef + ", which was declined"
		if reason != "" {
			newNote += ": " + reason
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO application_events (application_id, event_type, actor_user_id, actor_source, notes, created_at)
			VALUES ($1, 'resubmitted', $3, 'workspace', $4, NOW()),
			       ($2, 'resubmission', $3, 'workspace', $5, NOW())`,
			origID, newID, user.ID,
			"Resubmitted as "+newRef+" — a new draft copied from this application", newNote); err != nil {
			respondErrLog(w, 500, "Could not record the resubmission", err)
			return
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}
		out["existing"] = false
		respond(w, out, "pg")
	}
}
