package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/cbswrite"
	"github.com/o3c/reports/core"
	"github.com/o3c/reports/udara"
)

// RegisterCBSWrite mounts the write-through endpoints under /api/cbs. All are
// admin-gated. Writes are OFF unless CBS_WRITE_ENABLED=true; otherwise these return
// the exact CBS request plan that WOULD be sent (dry-run), sending nothing. Wire the
// LOS booking transition and FD creation to cbswrite.BookLoan / CreateFD when the
// workspace begins originating loans/FDs.
func RegisterCBSWrite(r chi.Router, c *udara.Client, db *core.DB) {
	r.Get("/write/status", cbsWriteStatus())
	r.With(core.RequirePages("admin")).Post("/write/loan", cbsWriteLoan(c))
	r.With(core.RequirePages("admin")).Post("/write/fd", cbsWriteFD(c))
}

func cbsWriteStatus() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		mode := "dry-run"
		if cbswrite.Enabled() {
			mode = "live"
		}
		cbsWriteJSON(w, http.StatusOK, map[string]any{
			"live_writes_enabled": cbswrite.Enabled(),
			"mode":                mode,
			"note":                "Set CBS_WRITE_ENABLED=true to send real bookings to Udara360. Validate payloads in dry-run first.",
		})
	}
}

func cbsWriteLoan(c *udara.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b cbswrite.LoanBooking
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			cbsWriteJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
			return
		}
		idem := r.Header.Get("X-Idempotency-Key")
		plan, err := cbswrite.BookLoan(r.Context(), c, b, idem)
		respondPlan(w, plan, err)
	}
}

func cbsWriteFD(c *udara.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b cbswrite.FDBooking
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			cbsWriteJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
			return
		}
		idem := r.Header.Get("X-Idempotency-Key")
		plan, err := cbswrite.CreateFD(r.Context(), c, b, idem)
		respondPlan(w, plan, err)
	}
}

func respondPlan(w http.ResponseWriter, plan *cbswrite.Plan, err error) {
	status := http.StatusOK
	body := map[string]any{"plan": plan}
	if err != nil {
		status = http.StatusBadGateway
		body["error"] = err.Error()
	}
	cbsWriteJSON(w, status, body)
}
