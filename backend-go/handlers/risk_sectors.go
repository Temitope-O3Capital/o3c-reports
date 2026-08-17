package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// Sector code registry.
//
// Udara sends economic_sector as a bare CBN numeric code with no label, so O3 owns the
// code→name mapping. These endpoints are the maintenance path: every code seen on the
// loan book is auto-registered on read, and the Risk team names them here.
//
// Read is open to anyone who can see the Risk module; writing is restricted to risk
// leadership, because a sector name is reference data that shows up on every
// concentration report and regulatory extract.
func RegisterRiskSectors(r chi.Router, db *core.DB) {
	read := core.RequirePages("risk_all", "risk_officer", "risk_head", "credit_portfolio")
	write := core.RequirePages("risk_all", "risk_head")

	r.With(read).Get("/sector-codes", riskListSectorCodes(db))
	r.With(write).Put("/sector-codes/{code}", riskUpsertSectorCode(db))
	r.With(write).Post("/sector-codes", riskUpsertSectorCode(db))
	r.With(write).Delete("/sector-codes/{code}", riskDeleteSectorCode(db))
}

func riskListSectorCodes(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Pick up any code that has appeared on the book since the last look, so the
		// list is always the full set of things needing a name.
		if _, err := db.PGExec(ctx, `SELECT app.sync_sector_codes()`); err != nil {
			respondErr(w, 500, "Failed to sync sector codes")
			return
		}

		// Usage comes from the open book so the team can name the codes that carry real
		// exposure first, rather than working through the list alphabetically.
		rows, err := db.PGQuery(ctx, `
			SELECT
				c.code,
				COALESCE(c.name, '')        AS name,
				COALESCE(c.description, '') AS description,
				c.source,
				c.is_active,
				(NULLIF(TRIM(c.name), '') IS NOT NULL) AS is_mapped,
				COALESCE(u.loan_count, 0)   AS loan_count,
				COALESCE(u.book_kobo, 0)    AS book_kobo,
				c.updated_at::text          AS updated_at
			FROM app.cbn_sector_codes c
			LEFT JOIN (
				SELECT economic_sector AS code,
				       COUNT(*)                              AS loan_count,
				       COALESCE(SUM(outstanding_principal_kobo), 0) AS book_kobo
				FROM cbs_loans
				WHERE status NOT IN ('Closed','Revoked')
				GROUP BY economic_sector
			) u ON u.code = c.code
			ORDER BY COALESCE(u.book_kobo, 0) DESC, c.code`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}

		unmapped := 0
		for _, row := range rows {
			if mapped, _ := row["is_mapped"].(bool); !mapped {
				unmapped++
			}
		}
		respond(w, map[string]any{
			"data":           rows,
			"unmapped_count": unmapped,
		}, "pg")
	}
}

func riskUpsertSectorCode(db *core.DB) http.HandlerFunc {
	type body struct {
		Code        string `json:"code"`
		Name        string `json:"name"`
		Description string `json:"description"`
		IsActive    *bool  `json:"is_active"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		// PUT carries the code in the path; POST carries it in the body.
		code := strings.TrimSpace(chi.URLParam(r, "code"))
		if code == "" {
			code = strings.TrimSpace(b.Code)
		}
		if code == "" {
			respondErr(w, 422, "code is required")
			return
		}
		name := strings.TrimSpace(b.Name)
		if name == "" {
			respondErr(w, 422, "name is required — to clear a name, delete the code instead")
			return
		}

		active := true
		if b.IsActive != nil {
			active = *b.IsActive
		}
		user := core.UserFromCtx(r.Context())
		var userID int64
		if user != nil {
			userID = user.ID
		}

		// source stays 'udara' for codes that came off the book — the name is ours, the
		// code's provenance is not, and losing that distinction hides where gaps come from.
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.cbn_sector_codes (code, name, description, source, is_active, first_seen_at, updated_at, updated_by)
			VALUES ($1, $2, NULLIF($3,''), 'manual', $4, NOW(), NOW(), $5)
			ON CONFLICT (code) DO UPDATE SET
				name        = EXCLUDED.name,
				description = EXCLUDED.description,
				is_active   = EXCLUDED.is_active,
				updated_at  = NOW(),
				updated_by  = EXCLUDED.updated_by
			RETURNING code, name, COALESCE(description,'') AS description, source, is_active`,
			code, name, b.Description, active, userID)
		if err != nil {
			respondErr(w, 500, "Save failed")
			return
		}
		if len(rows) == 0 {
			respondErr(w, 500, "Save failed")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func riskDeleteSectorCode(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := strings.TrimSpace(chi.URLParam(r, "code"))
		if code == "" {
			respondErr(w, 422, "code is required")
			return
		}

		// A code still present on the loan book cannot be removed — it would silently
		// reappear on the next read via sync_sector_codes(). Clear its name instead, so
		// the row survives as an explicit unmapped entry.
		inUse, err := db.PGQuery(r.Context(),
			`SELECT EXISTS (SELECT 1 FROM cbs_loans WHERE economic_sector = $1) AS in_use`, code)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		used, _ := inUse[0]["in_use"].(bool)
		if used {
			if _, err := db.PGExec(r.Context(),
				`UPDATE app.cbn_sector_codes SET name = NULL, description = NULL, updated_at = NOW() WHERE code = $1`,
				code); err != nil {
				respondErr(w, 500, "Update failed")
				return
			}
			respond(w, map[string]any{"code": code, "cleared": true, "in_use": true}, "pg")
			return
		}

		if _, err := db.PGExec(r.Context(),
			`DELETE FROM app.cbn_sector_codes WHERE code = $1`, code); err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		respond(w, map[string]any{"code": code, "deleted": true}, "pg")
	}
}
