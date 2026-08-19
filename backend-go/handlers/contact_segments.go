package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// Saved contact segments — a reusable, refreshable audience definition over the
// loan book. A segment stores its filter criteria (segmentCriteria) as JSONB and
// can be materialised into a contact list on demand, keeping the list current
// without re-entering the filters. See migration 114_marketing_enhancements.sql.

type segmentSaveReq struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Criteria    segmentCriteria `json:"criteria"`
}

func listSegments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT s.id, s.name, s.description, s.criteria, s.last_count,
			       s.last_list_id, s.last_refreshed_at, s.created_at, s.updated_at,
			       u.full_name AS created_by_name,
			       cl.name AS list_name, cl.member_count AS list_member_count
			FROM contact_segments s
			LEFT JOIN o3c_users u ON s.created_by = u.id
			LEFT JOIN contact_lists cl ON s.last_list_id = cl.id
			ORDER BY s.updated_at DESC`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		jsonRows(w, rows)
	}
}

func getSegment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid := chi.URLParam(r, "sid")
		rows, err := db.PGQuery(r.Context(),
			`SELECT id, name, description, criteria, last_count, last_list_id,
			        last_refreshed_at, created_at, updated_at
			 FROM contact_segments WHERE id=$1`, sid)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Segment not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func createSegment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b segmentSaveReq
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Name == "" {
			respondErr(w, 422, "name is required")
			return
		}
		user := core.UserFromCtx(r.Context())
		critJSON, _ := json.Marshal(b.Criteria)
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO contact_segments (name, description, criteria, created_by)
			VALUES ($1,$2,$3::jsonb,$4) RETURNING *`,
			b.Name, b.Description, string(critJSON), user.ID)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Create failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func updateSegment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid := chi.URLParam(r, "sid")
		var b segmentSaveReq
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Name == "" {
			respondErr(w, 422, "name is required")
			return
		}
		critJSON, _ := json.Marshal(b.Criteria)
		rows, err := db.PGQuery(r.Context(), `
			UPDATE contact_segments
			SET name=$1, description=$2, criteria=$3::jsonb, updated_at=NOW()
			WHERE id=$4 RETURNING *`,
			b.Name, b.Description, string(critJSON), sid)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Segment not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func deleteSegment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid := chi.URLParam(r, "sid")
		db.PGExec(r.Context(), "DELETE FROM contact_segments WHERE id=$1", sid) //nolint:errcheck
		w.WriteHeader(204)
	}
}

// materializeSegmentHandler builds (or refreshes) the segment's contact list.
// If the segment already has a live list, its members are replaced in place so
// the same list_id stays wired to any campaigns; otherwise a new list is created.
func materializeSegmentHandler(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid := chi.URLParam(r, "sid")
		ctx := r.Context()
		rows, err := db.PGQuery(ctx,
			`SELECT id, name, criteria, last_list_id FROM contact_segments WHERE id=$1`, sid)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Segment not found")
			return
		}
		seg := rows[0]
		var c segmentCriteria
		if raw, ok := seg["criteria"].(string); ok {
			json.Unmarshal([]byte(raw), &c) //nolint:errcheck
		} else if raw, ok := seg["criteria"].([]byte); ok {
			json.Unmarshal(raw, &c) //nolint:errcheck
		}
		c.Name = str(seg["name"])
		user := core.UserFromCtx(ctx)

		// Reuse the existing list if it still exists, else create a fresh one.
		var listID int64
		existing := toInt64(seg["last_list_id"])
		if existing > 0 {
			chk, _ := db.PGQuery(ctx, "SELECT id FROM contact_lists WHERE id=$1", existing)
			if len(chk) > 0 {
				listID = existing
				// Clear current members before refill so counts stay accurate.
				db.PGExec(ctx, "DELETE FROM contact_list_members WHERE list_id=$1", listID) //nolint:errcheck
			}
		}
		if listID == 0 {
			lr, err := db.PGQuery(ctx,
				`INSERT INTO contact_lists (name, description, created_by, created_at, updated_at)
				 VALUES ($1,$2,$3,NOW(),NOW()) RETURNING id`,
				str(seg["name"]), "Segment: "+str(seg["name"]), user.ID)
			if err != nil || len(lr) == 0 {
				respondErr(w, 500, "Failed to create list")
				return
			}
			listID = toInt64(lr[0]["id"])
		}

		imported, err := materializeSegmentToList(ctx, db, listID, c)
		if err != nil {
			respondErr(w, 500, "Failed to build segment members")
			return
		}

		db.PGExec(ctx, `
			UPDATE contact_segments
			SET last_count=$1, last_list_id=$2, last_refreshed_at=$3, updated_at=NOW()
			WHERE id=$4`, imported, listID, time.Now(), sid) //nolint:errcheck

		respond(w, map[string]any{
			"segment_id": sid,
			"list_id":    listID,
			"imported":   imported,
		}, "pg")
	}
}
