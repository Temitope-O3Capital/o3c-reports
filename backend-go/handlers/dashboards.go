package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

/*
Dashboards — a page of tiles, where every tile is a view of something already saved.

THE ACCESS RULE, WHICH IS THE WHOLE DESIGN. A tile never carries a query. It points at a
saved pivot report or a saved SQL query, and the data endpoint re-checks THE VIEWER
against THE TILE'S OWN SOURCE on every read:

  - a pivot report needs (is_public OR mine) AND reportDatasetAllowed() — the per-dataset
    department scoping the Report Builder already enforces;
  - a saved SQL query needs the "reports" page, which is BI and admin only, AND
    (is_shared OR mine).

So sharing a dashboard cannot widen anybody's data access. A dashboard shared with a
department head renders the tiles they could have built themselves and refuses the rest,
by tile, with a reason. If a tile carried its own SQL instead, saving a dashboard would
be a way to run anything under whatever permission the dashboard happened to have, and
every guard built in the previous two phases would be bypassable. That is why the schema
has two nullable source columns and a CHECK that exactly one is set, rather than a
`query` column (migration 358).

WHAT THE MODULE GATE DOES AND DOES NOT DO. RegisterDashboards admits "reports" OR
"report_builder" — BI and department heads both — because RequirePages is any-of. That
gate decides who may own a dashboard; it decides nothing about what the tiles show. The
two checks above do that, and they run per tile per viewer.

Ownership is scoped IN THE WHERE CLAUSE on every mutation, not read-then-check. That is
the shape the legacy BI module got wrong: it deleted schedules by id alone and answered
{"ok": true} either way, so one analyst could silently stop another's report.
*/

// dashTileRowCap is how many rows a tile may draw. A tile is a glance, not an export:
// nobody reads a 5,000-slice donut, and the Report Library and the SQL console are both
// one click away for the full result. It also bounds what a shared dashboard can cost —
// a page of twelve tiles is twelve queries.
const dashTileRowCap = 500

func RegisterDashboards(r chi.Router, db *core.DB) {
	// Any-of: BI (reports) or a department head (report_builder). Tile-level checks do
	// the filtering — see the file comment.
	access := core.RequirePages("reports", "report_builder")

	r.With(access).Get("/", dashList(db))
	r.With(access).Post("/", dashCreate(db))
	r.With(access).Get("/sources", dashSources(db))
	r.With(access).Get("/{id}", dashGet(db))
	r.With(access).Put("/{id}", dashUpdate(db))
	r.With(access).Delete("/{id}", dashDelete(db))
	r.With(access).Post("/{id}/tiles", dashTileCreate(db))
	// Building a tile from a data source rather than from an already-saved report. It
	// writes the report for you and points the tile at it — see dashboard_from_dataset.go
	// for why that is the only safe way to grant it.
	r.With(access).Post("/{id}/tiles/from-dataset", dashTileFromDataset(db))
	r.With(access).Put("/tiles/{tid}/dataset", dashTileConfigSave(db))
	// The builder's live preview. Runs an UNSAVED config through the same path a real
	// tile uses, so the visual being composed and the field wells both match what the
	// saved tile will produce — see dashboard_tile_preview.go.
	r.With(access).Post("/tile-preview", dashTilePreview(db))
	r.With(access).Put("/{id}/layout", dashLayoutSave(db))
	r.With(access).Put("/tiles/{tid}", dashTileUpdate(db))
	r.With(access).Delete("/tiles/{tid}", dashTileDelete(db))
	r.With(access).Get("/tiles/{tid}/data", dashTileData(db))
	r.With(access).Post("/{id}/email", dashEmail(db))
}

// dashEmail renders the dashboard as a PDF and emails it.
//
// The PDF is produced by printing the real page as the REQUESTER (see dashboard_pdf.go),
// so a board whose tiles render differently for different people emails what the sender
// sees — not what the most privileged viewer would see. That is the honest reading of a
// per-tile access model: the person pressing Send is the person vouching for the figures.
//
// Recipients go through the same company-domain rule as a report, because a dashboard is
// a report with a layout and there is no argument for it being looser.
func dashEmail(db *core.DB) http.HandlerFunc {
	type body struct {
		Recipients []string `json:"recipients"`
		Subject    string   `json:"subject"`
		Message    string   `json:"message"`
		// NoAttach sends the note alone. Pointless for a dashboard, whose whole content
		// is the attachment, so it is NOT offered — the field would only let a caller
		// send an empty email. Kept out deliberately rather than forgotten.
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		id := chi.URLParam(r, "id")

		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		to := cleanRecipients(b.Recipients)
		if len(to) == 0 {
			respondErr(w, 400, "Add at least one valid recipient email")
			return
		}
		if bad := reportRecipientsNotAllowed(ctx, db, u, to); len(bad) > 0 {
			respondErr(w, 422, reportRecipientsDeniedMessage(bad))
			return
		}

		// Read it the same way dashGet does, so "not shared with you" and "does not
		// exist" stay indistinguishable here too.
		boards, err := db.PGQuery(ctx, `
			SELECT d.id, d.name FROM app.dashboards d
			 WHERE d.id = $1 AND (d.is_shared OR d.created_by = $2)`, id, u.ID)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if len(boards) == 0 {
			respondErr(w, 404, "Dashboard not found")
			return
		}
		name := str(boards[0]["name"])
		if name == "" {
			name = "Dashboard"
		}

		pdf, err := renderDashboardPDF(ctx, id, u)
		if err != nil {
			// The renderer's messages are written to be read by the person who pressed
			// the button ("took too long", "set CHROME_PATH"), so they are passed through
			// rather than replaced with something generic.
			respondErrLog(w, 502, err.Error(), err)
			return
		}
		if enc := base64.StdEncoding.EncodedLen(len(pdf)); enc > reportMailMaxBytes {
			respondErr(w, 422, fmt.Sprintf(
				"This dashboard comes to %d MB as a PDF and a message can carry %d MB. "+
					"Remove a tile or two, or send the tiles as separate reports.",
				enc>>20, reportMailMaxBytes>>20))
			return
		}

		subject := clampRunes(strings.TrimSpace(b.Subject), reportSubjectMaxRunes)
		if subject == "" {
			subject = fmt.Sprintf("Dashboard: %s (%s)", name, time.Now().In(reportTZ).Format("2006-01-02"))
		}
		// The same house sheet and the same body as a report email: a dashboard is a
		// report with a layout, and there is no reason for the two to land in the same
		// inbox looking like different systems. The unit is "tiles" because that is what
		// a dashboard's size is.
		tiles, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM app.dashboard_tiles WHERE dashboard_id = $1`, id)
		tileCount := 0
		if len(tiles) > 0 {
			tileCount = int(toInt64(tiles[0]["n"]))
		}
		htmlBody, textBody := reportMailBody(name, b.Message,
			"The attached PDF is this dashboard as it stood when the email was sent.",
			tileCount, "tiles", u, time.Now().In(reportTZ))

		addrs := make([]MailAddress, 0, len(to))
		for _, e := range to {
			addrs = append(addrs, MailAddress{Email: e})
		}
		result := SendMail(ctx, db, SendMailOptions{
			To: addrs, Subject: subject, HTMLBody: htmlBody, TextBody: textBody,
			Kind: "report", Category: "dashboard_pdf", CreatedBy: u.ID,
			Attachments: []MailAttachment{{
				Filename:    exportSafeFilename(name) + ".pdf",
				ContentType: "application/pdf",
				Content:     base64.StdEncoding.EncodeToString(pdf),
				Disposition: "attachment",
			}},
		})
		if !result.OK && result.Error != "" {
			respondErrLog(w, 502, "Could not send the dashboard", fmt.Errorf("%s", result.Error))
			return
		}
		respond(w, map[string]any{"ok": true, "recipients": len(to), "bytes": len(pdf)}, "json")
	}
}

// ── Access helpers ────────────────────────────────────────────────────────────

// dashOwns answers "may this user change this dashboard?". Reading is wider than
// writing: a shared dashboard is readable by anyone the module admits, and editable only
// by its author. A dashboard someone else arranged should not rearrange itself under
// them.
func dashOwns(ctx context.Context, db *core.DB, id string, uid int64) bool {
	rows, err := db.PGQuery(ctx,
		`SELECT 1 FROM app.dashboards WHERE id = $1 AND created_by = $2`, id, uid)
	return err == nil && len(rows) > 0
}

// dashSourceReadable re-checks the VIEWER against a tile's source. The second return is
// a reason fit to show on the tile — a blank tile with no explanation reads as a bug.
func dashSourceReadable(u *core.Claims, kind string, src core.Row) (bool, string) {
	if u == nil || src == nil {
		return false, "Not authorised"
	}
	switch kind {
	case "report":
		isPublic, _ := src["is_public"].(bool)
		if !isPublic && toInt64(src["created_by"]) != u.ID {
			return false, "This tile reads a private report belonging to someone else"
		}
		if !reportDatasetAllowed(u, str(src["dataset"])) {
			return false, "This tile reads " + str(src["dataset"]) + ", which is outside your department"
		}
		return true, ""
	case "sql":
		// The console's own gate, restated here because a dashboard is a different
		// doorway to the same data. "reports" is BI and admin; report_builder is not
		// enough, which is exactly the escalation this prevents.
		if !u.HasPage("reports") && !core.IsManagement(u.Role) {
			return false, "This tile runs a saved SQL query, which is restricted to the BI team"
		}
		isShared, _ := src["is_shared"].(bool)
		if !isShared && toInt64(src["created_by"]) != u.ID {
			return false, "This tile runs a private query belonging to someone else"
		}
		return true, ""
	}
	return false, "Unknown tile source"
}

// dashLoadTileSource reads a tile plus whichever source it points at, in one place, so
// every caller gets the same shape and the same checks.
func dashLoadTileSource(ctx context.Context, db *core.DB, tid string) (tile core.Row, kind string, src core.Row, err error) {
	tiles, err := db.PGQuery(ctx, `
		SELECT t.id, t.dashboard_id, t.title, t.viz, t.config,
		       t.source_report_id, t.source_sql_id
		  FROM app.dashboard_tiles t
		 WHERE t.id = $1`, tid)
	if err != nil {
		return nil, "", nil, err
	}
	if len(tiles) == 0 {
		return nil, "", nil, nil
	}
	tile = tiles[0]

	if rid := tile["source_report_id"]; rid != nil {
		kind = "report"
		rows, qErr := db.PGQuery(ctx,
			`SELECT id, name, dataset, config, is_public, created_by
			   FROM app.pivot_reports WHERE id = $1`, toInt64(rid))
		if qErr != nil {
			return tile, kind, nil, qErr
		}
		if len(rows) > 0 {
			src = rows[0]
		}
		return tile, kind, src, nil
	}

	kind = "sql"
	rows, qErr := db.PGQuery(ctx,
		`SELECT id, name, sql_text, is_shared, created_by
		   FROM app.bi_sql_queries WHERE id = $1`, toInt64(tile["source_sql_id"]))
	if qErr != nil {
		return tile, kind, nil, qErr
	}
	if len(rows) > 0 {
		src = rows[0]
	}
	return tile, kind, src, nil
}

// ── Dashboards ────────────────────────────────────────────────────────────────

func dashList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if u == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT d.id, d.name, d.description, d.is_shared, d.created_by,
			       d.created_at, d.updated_at,
			       (d.created_by = $1) AS is_mine,
			       usr.full_name AS created_by_name,
			       (SELECT COUNT(*) FROM app.dashboard_tiles t WHERE t.dashboard_id = d.id) AS tile_count
			  FROM app.dashboards d
			  LEFT JOIN app.o3c_users usr ON usr.id = d.created_by
			 WHERE d.is_shared OR d.created_by = $1
			 ORDER BY d.updated_at DESC`, u.ID)
		if err != nil {
			respondErrLog(w, 500, "Could not list dashboards", err)
			return
		}
		respond(w, rowsOrEmpty(rows), "pg")
	}
}

func dashCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		IsShared    bool   `json:"is_shared"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Name == "" {
			respondErr(w, 400, "A dashboard needs a name")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.dashboards (name, description, is_shared, created_by)
			VALUES ($1, $2, $3, $4)
			RETURNING id, name, description, is_shared, created_at, updated_at`,
			b.Name, b.Description, b.IsShared, u.ID)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 500, "Could not create the dashboard", err)
			return
		}
		respond(w, rows[0], "pg")
	}
}

func dashGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		id := chi.URLParam(r, "id")

		boards, err := db.PGQuery(ctx, `
			SELECT d.id, d.name, d.description, d.is_shared, d.created_by,
			       d.created_at, d.updated_at, d.config,
			       (d.created_by = $2) AS is_mine,
			       usr.full_name AS created_by_name
			  FROM app.dashboards d
			  LEFT JOIN app.o3c_users usr ON usr.id = d.created_by
			 WHERE d.id = $1 AND (d.is_shared OR d.created_by = $2)`, id, u.ID)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		// Not found and not shared with you answer the same way on purpose: a distinct
		// 403 would confirm that a dashboard exists under that id.
		if len(boards) == 0 {
			respondErr(w, 404, "Dashboard not found")
			return
		}

		// Tiles carry their source's NAME and a per-viewer readable flag, so the page can
		// draw the grid — and say which tiles it cannot show — without firing a data
		// request per tile to find out.
		tiles, err := db.PGQuery(ctx, `
			SELECT t.id, t.title, t.viz, t.config,
			       t.grid_x, t.grid_y, t.grid_w, t.grid_h,
			       t.source_report_id, t.source_sql_id,
			       p.name AS report_name, p.dataset AS report_dataset,
			       p.is_public AS report_is_public, p.created_by AS report_created_by,
			       p.tile_only AS report_tile_only, p.config AS report_config,
			       q.name AS sql_name, q.is_shared AS sql_is_shared,
			       q.created_by AS sql_created_by
			  FROM app.dashboard_tiles t
			  LEFT JOIN app.pivot_reports  p ON p.id = t.source_report_id
			  LEFT JOIN app.bi_sql_queries q ON q.id = t.source_sql_id
			 WHERE t.dashboard_id = $1
			 ORDER BY t.grid_y, t.grid_x, t.id`, id)
		if err != nil {
			respondErrLog(w, 500, "Could not load the tiles", err)
			return
		}

		out := make([]core.Row, 0, len(tiles))
		for _, t := range tiles {
			kind, name := "sql", str(t["sql_name"])
			var src core.Row
			if t["source_report_id"] != nil {
				kind, name = "report", str(t["report_name"])
				src = core.Row{
					"is_public":  t["report_is_public"],
					"created_by": t["report_created_by"],
					"dataset":    t["report_dataset"],
				}
			} else {
				src = core.Row{
					"is_shared":  t["sql_is_shared"],
					"created_by": t["sql_created_by"],
				}
			}
			ok, why := dashSourceReadable(u, kind, src)
			row := core.Row{
				"id": t["id"], "viz": t["viz"], "config": t["config"],
				"grid_x": t["grid_x"], "grid_y": t["grid_y"],
				"grid_w": t["grid_w"], "grid_h": t["grid_h"],
				"source_kind": kind,
				"source_name": name,
				// The tile's own title wins; empty means "use the source's name", so a
				// renamed report renames its tiles instead of leaving a stale caption.
				"title":    firstNonEmpty(str(t["title"]), name),
				"readable": ok,
			}
			if !ok {
				row["reason"] = why
			}
			if kind == "report" {
				row["source_report_id"] = t["source_report_id"]
				row["dataset"] = t["report_dataset"]
				// A report the dashboard wrote for this tile can be edited in place, so the
				// page is given what it needs to reopen the builder on it. A tile pointing
				// at a library report gets neither: editing that one belongs in the Report
				// Builder, where its other tiles and schedules are visible.
				if own, _ := t["report_tile_only"].(bool); own && ok {
					row["tile_only"] = true
					row["report_config"] = t["report_config"]
				}
			} else {
				row["source_sql_id"] = t["source_sql_id"]
			}
			out = append(out, row)
		}

		board := boards[0]
		board["tiles"] = out
		// Which slicers this board COULD offer, derived from the datasets its own
		// readable tiles read — so the filter bar can never offer one that would apply
		// to nothing, and a viewer is not shown the shape of a tile they are refused.
		// See dashboard_filters.go.
		board["available_slicers"] = dashAvailableSlicers(u, out)
		respond(w, board, "pg")
	}
}

func dashUpdate(db *core.DB) http.HandlerFunc {
	type body struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
		IsShared    *bool   `json:"is_shared"`
		// Which slicers this board offers, and its default period (migration 384). The
		// current SELECTION is never stored — see dashboard_filters.go for why.
		Config json.RawMessage `json:"config"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Could not read the request")
			return
		}
		var cfg *string
		if len(b.Config) > 0 {
			// Bounded, because this is a per-board blob a caller supplies. The shape is
			// the UI's business; the size is not.
			if len(b.Config) > 8000 {
				respondErr(w, 422, "That dashboard configuration is too large")
				return
			}
			s := string(b.Config)
			cfg = &s
		}
		// Scoped in the WHERE clause, so a dashboard that is not yours is simply not
		// found — no read-then-check, and no 403 that confirms it exists.
		rows, err := db.PGQuery(r.Context(), `
			UPDATE app.dashboards
			   SET name        = COALESCE($3, name),
			       description = COALESCE($4, description),
			       is_shared   = COALESCE($5, is_shared),
			       config      = COALESCE($6::jsonb, config),
			       updated_at  = NOW()
			 WHERE id = $1 AND created_by = $2
			RETURNING id, name, description, is_shared, config, updated_at`,
			id, u.ID, b.Name, b.Description, b.IsShared, cfg)
		if err != nil {
			respondErrLog(w, 500, "Could not save the dashboard", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "Dashboard not found")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func dashDelete(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(),
			`DELETE FROM app.dashboards WHERE id = $1 AND created_by = $2 RETURNING id`,
			chi.URLParam(r, "id"), u.ID)
		if err != nil {
			respondErrLog(w, 500, "Could not delete the dashboard", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "Dashboard not found")
			return
		}
		respond(w, map[string]any{"ok": true}, "pg")
	}
}

// ── Tiles ─────────────────────────────────────────────────────────────────────

// The visuals a tile may be. Widened by migration 381 to the kinds the chart library in
// components/echarts.tsx already had: barh (EBarH, ranked horizontal bars), combo
// (ECombo, bars plus lines with an optional right axis) and funnel (EFunnel).
//
// THIS MAP AND THE DATABASE CHECK MUST AGREE, and both must agree with the renderer's
// branches in DashboardView. A kind accepted here but not drawn there produces a blank
// tile, which is worse than a refused request — TestTileFromDatasetKeepsTheTileInvariants
// pins the pairing.
var dashVizKinds = map[string]bool{
	"kpi": true, "bar": true, "line": true, "area": true, "donut": true, "table": true,
	"barh": true, "combo": true, "funnel": true,
}

func dashTileCreate(db *core.DB) http.HandlerFunc {
	type body struct {
		Viz            string          `json:"viz"`
		Title          string          `json:"title"`
		SourceReportID *int64          `json:"source_report_id"`
		SourceSQLID    *int64          `json:"source_sql_id"`
		Config         json.RawMessage `json:"config"`
		GridX          int             `json:"grid_x"`
		GridY          int             `json:"grid_y"`
		GridW          int             `json:"grid_w"`
		GridH          int             `json:"grid_h"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		id := chi.URLParam(r, "id")
		if !dashOwns(ctx, db, id, u.ID) {
			respondErr(w, 404, "Dashboard not found")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Could not read the request")
			return
		}
		if !dashVizKinds[b.Viz] {
			respondErr(w, 422, "Choose a visual: KPI, bar, line, area, donut or table")
			return
		}
		// Exactly one source. The database enforces this too (migration 358), but a 422
		// naming the problem beats a 500 carrying a constraint name.
		if (b.SourceReportID == nil) == (b.SourceSQLID == nil) {
			respondErr(w, 422, "A tile reads exactly one source — a saved report or a saved query")
			return
		}

		// YOU CANNOT ADD A TILE YOU COULD NOT READ. Without this, a BI analyst could put
		// a restricted query on a dashboard and share it, and the per-read check would be
		// the only thing standing between a department head and the data. Checking here
		// too means the dashboard never contains a tile its author cannot see, which is
		// also what makes the "readable" flag meaningful rather than routine.
		kind := "sql"
		var srcRows []core.Row
		var err error
		if b.SourceReportID != nil {
			kind = "report"
			srcRows, err = db.PGQuery(ctx,
				`SELECT id, dataset, is_public, created_by FROM app.pivot_reports WHERE id = $1`,
				*b.SourceReportID)
		} else {
			srcRows, err = db.PGQuery(ctx,
				`SELECT id, is_shared, created_by FROM app.bi_sql_queries WHERE id = $1`,
				*b.SourceSQLID)
		}
		if err != nil {
			respondErrLog(w, 500, "Could not read the tile source", err)
			return
		}
		if len(srcRows) == 0 {
			respondErr(w, 404, "That source no longer exists")
			return
		}
		if ok, why := dashSourceReadable(u, kind, srcRows[0]); !ok {
			respondErr(w, 403, why)
			return
		}

		if b.GridW == 0 {
			b.GridW = 6
		}
		if b.GridH == 0 {
			b.GridH = 4
		}
		cfg := "{}"
		if len(b.Config) > 0 {
			cfg = string(b.Config)
		}
		rows, err := db.PGQuery(ctx, `
			INSERT INTO app.dashboard_tiles
				(dashboard_id, title, viz, source_report_id, source_sql_id,
				 grid_x, grid_y, grid_w, grid_h, config)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
			RETURNING id, title, viz, grid_x, grid_y, grid_w, grid_h, config`,
			id, b.Title, b.Viz, b.SourceReportID, b.SourceSQLID,
			b.GridX, b.GridY, b.GridW, b.GridH, cfg)
		if err != nil {
			respondErrLog(w, 500, "Could not add the tile", err)
			return
		}
		touchDashboard(ctx, db, id)
		respond(w, rows[0], "pg")
	}
}

func dashTileUpdate(db *core.DB) http.HandlerFunc {
	type body struct {
		Title  *string         `json:"title"`
		Viz    *string         `json:"viz"`
		Config json.RawMessage `json:"config"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Could not read the request")
			return
		}
		if b.Viz != nil && !dashVizKinds[*b.Viz] {
			respondErr(w, 422, "Choose a visual: KPI, bar, line, area, donut or table")
			return
		}
		var cfg *string
		if len(b.Config) > 0 {
			s := string(b.Config)
			cfg = &s
		}
		// Ownership reaches the tile through its dashboard, in the same statement.
		rows, err := db.PGQuery(ctx, `
			UPDATE app.dashboard_tiles t
			   SET title  = COALESCE($3, t.title),
			       viz    = COALESCE($4, t.viz),
			       config = COALESCE($5::jsonb, t.config),
			       updated_at = NOW()
			  FROM app.dashboards d
			 WHERE d.id = t.dashboard_id
			   AND t.id = $1 AND d.created_by = $2
			RETURNING t.id, t.title, t.viz, t.config, t.dashboard_id`,
			chi.URLParam(r, "tid"), u.ID, b.Title, b.Viz, cfg)
		if err != nil {
			respondErrLog(w, 500, "Could not save the tile", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "Tile not found")
			return
		}
		touchDashboard(ctx, db, str(rows[0]["dashboard_id"]))
		respond(w, rows[0], "pg")
	}
}

func dashTileDelete(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		rows, err := db.PGQuery(ctx, `
			DELETE FROM app.dashboard_tiles t
			 USING app.dashboards d
			 WHERE d.id = t.dashboard_id
			   AND t.id = $1 AND d.created_by = $2
			RETURNING t.dashboard_id, t.source_report_id`,
			chi.URLParam(r, "tid"), u.ID)
		if err != nil {
			respondErrLog(w, 500, "Could not remove the tile", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "Tile not found")
			return
		}
		// A report the dashboard wrote for this tile goes with it. Nothing else can reach
		// such a row — it is hidden from the library and the source picker — so leaving it
		// behind would accumulate reports nobody can see or delete. The "AND tile_only"
		// is what keeps this from touching a report somebody built and named: deleting a
		// tile must never remove a library report other tiles or schedules depend on.
		if rid := rows[0]["source_report_id"]; rid != nil {
			if _, delErr := db.PGExec(ctx,
				`DELETE FROM app.pivot_reports WHERE id = $1 AND tile_only`, rid); delErr != nil {
				// The tile is already gone and that is what the caller asked for; a report
				// left behind is untidy, not a failure to report back as one.
				slog.WarnContext(ctx, "could not remove the report behind a deleted tile",
					"report_id", rid, "error", delErr)
			}
		}
		touchDashboard(ctx, db, str(rows[0]["dashboard_id"]))
		respond(w, map[string]any{"ok": true}, "pg")
	}
}

// dashLayoutSave takes the whole grid in one request, because a drag moves several tiles
// at once: dropping a tile into the middle of a column pushes the ones below it down, and
// saving those one at a time would leave the layout half-written if the second call
// failed. One statement per tile inside one transaction, all scoped on ownership.
func dashLayoutSave(db *core.DB) http.HandlerFunc {
	type tileLayout struct {
		ID    int64 `json:"id"`
		GridX int   `json:"grid_x"`
		GridY int   `json:"grid_y"`
		GridW int   `json:"grid_w"`
		GridH int   `json:"grid_h"`
	}
	type body struct {
		Tiles []tileLayout `json:"tiles"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		id := chi.URLParam(r, "id")
		if !dashOwns(ctx, db, id, u.ID) {
			respondErr(w, 404, "Dashboard not found")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Could not read the layout")
			return
		}
		for _, t := range b.Tiles {
			// Validated here as well as by the CHECK constraints, so a bad drag is a 422
			// about the grid rather than a 500 about a constraint.
			if t.GridX < 0 || t.GridW < 1 || t.GridW > 12 || t.GridX+t.GridW > 12 ||
				t.GridY < 0 || t.GridH < 1 || t.GridH > 24 {
				respondErr(w, 422, fmt.Sprintf("Tile %d does not fit the 12-column grid", t.ID))
				return
			}
		}
		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErrLog(w, 500, "Could not save the layout", err)
			return
		}
		defer tx.Rollback() //nolint:errcheck
		for _, t := range b.Tiles {
			if _, err := tx.ExecContext(ctx, `
				UPDATE app.dashboard_tiles
				   SET grid_x = $3, grid_y = $4, grid_w = $5, grid_h = $6, updated_at = NOW()
				 WHERE id = $1 AND dashboard_id = $2`,
				t.ID, id, t.GridX, t.GridY, t.GridW, t.GridH); err != nil {
				respondErrLog(w, 500, "Could not save the layout", err)
				return
			}
		}
		if err := tx.Commit(); err != nil {
			respondErrLog(w, 500, "Could not save the layout", err)
			return
		}
		touchDashboard(ctx, db, id)
		respond(w, map[string]any{"ok": true, "tiles": len(b.Tiles)}, "pg")
	}
}

// touchDashboard keeps updated_at meaningful: the list is ordered by it, and "last
// touched" should mean the arrangement changed, not just the title.
func touchDashboard(ctx context.Context, db *core.DB, id string) {
	db.PGExec(ctx, `UPDATE app.dashboards SET updated_at = NOW() WHERE id = $1`, id) //nolint:errcheck
}

// ── Tile data ─────────────────────────────────────────────────────────────────

// dashTileData runs a tile's source and returns columns and rows in one shape, whichever
// kind it is. The response deliberately looks the same as the SQL console's, so
// src/lib/reportFormat.ts formats both with no special cases: a key ending _kobo is
// minor units wherever it came from.
func dashTileData(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)
		tid := chi.URLParam(r, "tid")

		tile, kind, src, err := dashLoadTileSource(ctx, db, tid)
		if err != nil {
			respondErrLog(w, 500, "Could not load the tile", err)
			return
		}
		if tile == nil {
			respondErr(w, 404, "Tile not found")
			return
		}
		if src == nil {
			// The CASCADE in migration 358 means this should be unreachable; it is
			// handled anyway, because "the report was deleted" is a thing a reader
			// deserves to be told rather than a 500.
			respondErr(w, 404, "That tile's source no longer exists")
			return
		}
		// THE CHECK THAT MATTERS: the viewer against the source, every read, regardless
		// of who owns the dashboard or whether it is shared.
		if ok, why := dashSourceReadable(u, kind, src); !ok {
			respondErr(w, 403, why)
			return
		}

		if kind == "sql" {
			res, runErr := biSQLExecute(ctx, db, str(src["sql_text"]), dashTileRowCap)
			if runErr != nil {
				respondErr(w, 422, biSQLFriendlyError(runErr).Error())
				return
			}
			// The result screen runs here too. A saved query that was safe when it was
			// written can start returning a credential-shaped column after a schema
			// change, and a dashboard reads it on a timer with nobody watching.
			if bad := biSQLCheckResult(res.Columns, res.Rows); bad != nil {
				respondErr(w, 403, bad.Error())
				return
			}
			respond(w, map[string]any{
				"columns": res.Columns, "rows": res.Rows,
				"row_count": res.RowCount, "truncated": res.Truncated,
				"source_kind": "sql", "source_name": str(src["name"]),
			}, "pg")
			return
		}

		// A saved pivot report. Its config decides whether it is a flat table or a
		// summary; both come back as columns + rows. The run itself is shared with the
		// builder's live preview — see dashboard_tile_preview.go for why that matters.
		out, status, runErr := runTileReport(ctx, db, u, str(src["dataset"]), str(src["config"]),
			dashReadSelection(r))
		if runErr != nil {
			if status >= 500 {
				respondErrLog(w, status, runErr.Error(), runErr)
			} else {
				respondErr(w, status, runErr.Error())
			}
			return
		}
		out["source_kind"] = "report"
		out["source_name"] = str(src["name"])
		respond(w, out, "pg")
	}
}

// ── Sources ───────────────────────────────────────────────────────────────────

// dashSources lists what this viewer may actually put on a dashboard. It is filtered by
// the same rules the data endpoint enforces, so the picker cannot offer a tile that would
// then refuse to draw — an empty picker is a clearer message than a grid of locked tiles.
func dashSources(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		u := core.UserFromCtx(ctx)

		// tile_only reports are excluded: those were written by a dashboard to back one
		// tile, and offering them here as sources would fill the picker with entries
		// nobody chose to create. See migration 379.
		reports, err := db.PGQuery(ctx, `
			SELECT p.id, p.name, p.description, p.dataset, p.is_public, p.created_by,
			       p.updated_at, usr.full_name AS created_by_name
			  FROM app.pivot_reports p
			  LEFT JOIN app.o3c_users usr ON usr.id = p.created_by
			 WHERE (p.is_public OR p.created_by = $1)
			   AND NOT p.tile_only
			 ORDER BY p.updated_at DESC`, u.ID)
		if err != nil {
			respondErrLog(w, 500, "Could not list saved reports", err)
			return
		}
		okReports := make([]core.Row, 0, len(reports))
		for _, p := range reports {
			if allowed, _ := dashSourceReadable(u, "report", p); allowed {
				okReports = append(okReports, core.Row{
					"id": p["id"], "name": p["name"], "description": p["description"],
					"dataset": p["dataset"], "is_public": p["is_public"],
					"created_by_name": p["created_by_name"], "updated_at": p["updated_at"],
				})
			}
		}

		// Saved queries are only offered to someone who could run them in the console.
		okQueries := []core.Row{}
		if u.HasPage("reports") || core.IsManagement(u.Role) {
			queries, qErr := db.PGQuery(ctx, `
				SELECT q.id, q.name, q.description, q.is_shared, q.created_by,
				       q.updated_at, usr.full_name AS created_by_name
				  FROM app.bi_sql_queries q
				  LEFT JOIN app.o3c_users usr ON usr.id = q.created_by
				 WHERE q.is_shared OR q.created_by = $1
				 ORDER BY q.updated_at DESC`, u.ID)
			if qErr != nil {
				respondErrLog(w, 500, "Could not list saved queries", qErr)
				return
			}
			okQueries = rowsOrEmpty(queries)
		}

		respond(w, map[string]any{"reports": okReports, "queries": okQueries}, "pg")
	}
}
