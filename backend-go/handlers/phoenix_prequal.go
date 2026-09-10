package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/o3c/workspace/core"
)

// losCreditReport serves Phoenix's prequalification report for an application — the
// affordability and bureau case behind the decision.
//
// It is read live from Phoenix whenever Phoenix answers. The copy the webhook stores
// is taken as the decision is posted, before Phoenix has written the decision record
// the report's route, decision trace, recommended amount and policy version are read
// from — so for a decided application the stored copy lacked exactly the fields that
// say what was decided and why. Each live read is stored over it, so when Phoenix
// cannot be reached the page falls back to a copy as fresh as the last read, and
// says how old it is and why it is not live.
func losCreditReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := losParseID(r)
		if err != nil {
			respondErr(w, 400, "Invalid application ID")
			return
		}
		var phoenixID string
		err = db.PG.QueryRowContext(r.Context(),
			`SELECT COALESCE(phoenix_id, '') FROM app.loan_applications WHERE id = $1`, id).Scan(&phoenixID)
		if err == sql.ErrNoRows {
			respondErr(w, 404, "Application not found")
			return
		}
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}

		// Why the page is showing the stored copy rather than the live report.
		staleReason := ""
		if phoenixID != "" {
			raw, perr := phoenixCall(r.Context(), http.MethodGet,
				"/credit-requests/"+phoenixID+"/prequalification-report", nil)
			var ce phoenixCallError
			switch {
			case perr == nil:
				// The report carries no identity numbers today. Masked anyway, so the
				// day Phoenix adds one it does not reach the browser.
				safe, merr := maskPhoenixIdentifiers(raw)
				if merr != nil {
					slog.Error("prequalification report: could not mask the live report", "application_id", id, "err", merr)
					staleReason = "The live report could not be prepared safely, so this is the stored copy."
					break
				}
				if _, serr := db.PGExec(r.Context(), `
					INSERT INTO app.loan_application_reports (application_id, source, report, updated_at)
					VALUES ($1, 'phoenix', $2::jsonb, NOW())
					ON CONFLICT (application_id) DO UPDATE
					   SET report = EXCLUDED.report, source = EXCLUDED.source, updated_at = NOW()`,
					id, []byte(raw)); serr != nil {
					slog.Warn("prequalification report: could not refresh the stored copy", "application_id", id, "err", serr)
				}
				respond(w, map[string]any{
					"report": json.RawMessage(safe), "live": true, "source": "phoenix", "updated_at": time.Now().UTC(),
				}, "phoenix")
				return
			case errors.As(perr, &ce) && ce.Status == http.StatusNotFound:
				// Not scored yet. No report is the truth here, not a fault.
			default:
				staleReason = classifyPhoenixErr(perr, "read the live report", false).Message
			}
		}

		var stored []byte
		var updatedAt time.Time
		err = db.PG.QueryRowContext(r.Context(),
			`SELECT report, updated_at FROM app.loan_application_reports WHERE application_id = $1`, id).
			Scan(&stored, &updatedAt)
		if err == sql.ErrNoRows || (err == nil && len(stored) == 0) {
			respond(w, map[string]any{"report": nil, "stale_reason": staleReason}, "pg")
			return
		}
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		safe, merr := maskPhoenixIdentifiers(stored)
		if merr != nil {
			respondErrLog(w, 500, "Could not prepare the stored report safely", merr)
			return
		}
		respond(w, map[string]any{
			"report": json.RawMessage(safe), "live": false, "source": "phoenix",
			"updated_at": updatedAt, "stale_reason": staleReason,
		}, "pg")
	}
}
