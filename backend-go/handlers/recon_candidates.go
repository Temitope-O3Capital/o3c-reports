package handlers

// The evidence behind one exception.
//
// The Exceptions page has a column headed "What the Matcher Found" that renders
// recon_exceptions.detail — "10 candidate ledger rows within ±3 days, none
// uniquely matchable on amount". That sentence is where triage stopped: it states
// that ten rows exist and gives an officer no way to see one of them, so the only
// resolution path available was to rebuild the matcher's residual join by hand.
//
// This endpoint serves those rows. It derives nothing of its own — recon.Candidates
// re-runs the pair's own Residual predicate, so the evidence on screen is the
// evidence the matcher weighed.

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/recon"
)

func reconExceptionCandidates(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil || id <= 0 {
			respondErr(w, 422, "A numeric exception id is required")
			return
		}

		set, err := recon.Candidates(r.Context(), db, id)
		if err != nil {
			// A missing exception is the caller's mistake, not a server fault, and
			// saying so plainly keeps a stale bookmark out of the error log.
			if strings.Contains(err.Error(), "not found") {
				respondErr(w, 404, "Exception not found")
				return
			}
			respondErrLog(w, 500, "Could not read the candidate ledger rows", err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(set) //nolint:errcheck
	}
}
