package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	netmail "net/mail"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/o3c/workspace/core"
)

// Management reports: the six scheduled emails to management and the sales team.
//
// The report bodies are built by the Node generator in scripts/management-reports, which
// already carries the validated SQL, charts and email layout. The workspace owns
// everything around it: the schedule, the recipient list, and a record of every send.
// A run row is always created here first; the generator is started with that row's id,
// sends to the recipients captured on it, and writes the outcome and rendered body back.
// The generator refuses to send any other way, so nothing reaches management that the
// Reports page cannot show.

// mrWAT is West Africa Time. Nigeria keeps no daylight saving, so a fixed offset is
// exact, and it avoids relying on a time-zone database the Windows host may not ship.
var mrWAT = time.FixedZone("WAT", 60*60)

const (
	// A 09:00 report still goes out if the service comes up by 12:00. Later than that a
	// "morning" email arriving mid-afternoon does more harm than good, so the day is
	// skipped and the page shows the send as missed.
	mrCatchUp = 3 * time.Hour
	// A failed scheduled send is retried, but never in a tight loop against an outage.
	mrMaxDailyAttempts = 3
	mrRetryGap         = 10 * time.Minute
	// Chart rendering and the heavier queries take a minute or two; fifteen is generous.
	// A run still marked running after twice that died with its process.
	mrRunTimeout   = 15 * time.Minute
	mrStaleRunning = 30 * time.Minute
)

// mrSlot runs one generator at a time. Builds share a chart-rendering directory and the
// same heavy queries, and a queue at 09:00 beats several Chrome processes at once.
var mrSlot = make(chan struct{}, 1)

// RegisterManagementReports mounts under /api/management-reports.
//
// Reading is open to BI, management and every operating head (all hold "executive").
// Changing who receives a report, pausing one, or sending on demand is limited to
// management and BI.
func RegisterManagementReports(r chi.Router, db *core.DB) {
	read := core.RequirePages("reports", "executive")
	manage := core.RequireManagementOrPage("reports")

	r.With(read).Get("/", mrList(db))
	r.With(read).Get("/summary", mrSummary(db))
	r.With(read).Get("/catalogue", mrCatalogueHandler())
	r.With(read).Get("/runs", mrRuns(db))
	r.With(read).Get("/runs/{id}", mrRun(db))
	r.With(read).Get("/runs/{id}/preview", mrPreview(db))
	r.With(read).Get("/{key}", mrGet(db))
	r.With(manage).Post("/", mrCreate(db))
	r.With(manage).Post("/preview", mrDraftPreview(db))
	r.With(manage).Put("/{key}", mrUpdate(db))
	r.With(manage).Delete("/{key}", mrArchive(db))
	r.With(manage).Post("/{key}/duplicate", mrDuplicate(db))
	r.With(manage).Post("/{key}/send", mrSend(db))
}

// StartManagementReportScheduler checks once a minute for reports due to go out. It
// lives in the backend because the backend already runs as a service around the clock;
// a desktop scheduled task would stop sending whenever nobody was logged on.
func StartManagementReportScheduler(ctx context.Context, db *core.DB) {
	go func() {
		// Let migrations and the connection pool settle before the first look.
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
		}
		slog.Info("Management reports: scheduler started")
		tick := time.NewTicker(time.Minute)
		defer tick.Stop()
		for {
			mrScheduleTick(ctx, db)
			select {
			case <-ctx.Done():
				slog.Info("Management reports: shutdown signal received, stopping scheduler")
				return
			case <-tick.C:
			}
		}
	}()
}

func mrScheduleTick(ctx context.Context, db *core.DB) {
	qctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	mrSweepInterrupted(qctx, db)

	now := time.Now().In(mrWAT)
	rows, err := db.PGQuery(qctx, `
		SELECT m.report_key, m.due_rule, to_char(m.send_time, 'HH24:MI') AS send_time,
		       COUNT(r.id)::int AS attempts,
		       COALESCE(BOOL_OR(r.status IN ('running', 'sent')), FALSE) AS done,
		       MAX(COALESCE(r.finished_at, r.started_at)) AS last_attempt
		  FROM management_reports m
		  LEFT JOIN management_report_runs r
		         ON r.report_key = m.report_key
		        AND r.run_trigger = 'schedule'
		        AND r.run_date = (NOW() AT TIME ZONE 'Africa/Lagos')::date
		 WHERE m.is_active AND m.archived_at IS NULL
		 GROUP BY m.report_key, m.due_rule, m.send_time`)
	if err != nil {
		slog.Error("Management reports: schedule check failed", "err", err)
		return
	}
	for _, row := range rows {
		key := str(row["report_key"])
		if !mrDueOn(str(row["due_rule"]), now) {
			continue
		}
		sendAt := mrSendAt(now, str(row["send_time"]))
		if now.Before(sendAt) || now.Sub(sendAt) > mrCatchUp {
			continue
		}
		if done, _ := row["done"].(bool); done {
			continue
		}
		attempts := toInt64(row["attempts"])
		if attempts >= mrMaxDailyAttempts {
			continue
		}
		if last, ok := row["last_attempt"].(time.Time); ok && attempts > 0 && time.Since(last) < mrRetryGap {
			continue
		}
		id, started, err := mrStartRun(qctx, db, key, "schedule", nil)
		if err != nil {
			slog.Error("Management reports: could not start scheduled run", "report", key, "err", err)
			continue
		}
		if started {
			slog.Info("Management reports: scheduled send starting", "report", key, "run_id", id, "attempt", attempts+1)
			go mrExecute(db, id)
		}
	}
}

// mrSweepInterrupted fails runs whose process died with a service restart. Left alone,
// a dead "running" row would hold the once-a-day slot and stop that report for the day.
func mrSweepInterrupted(ctx context.Context, db *core.DB) {
	if _, err := db.PGExec(ctx, `
		UPDATE management_report_runs
		   SET status = 'failed', finished_at = NOW(),
		       error = 'Interrupted: the service stopped before this run finished.'
		 WHERE status = 'running' AND started_at < NOW() - $1::interval`,
		fmt.Sprintf("%d minutes", int(mrStaleRunning.Minutes()))); err != nil {
		slog.Error("Management reports: sweep of interrupted runs failed", "err", err)
	}
}

// mrDueOn reports whether a report with this rule goes out on the given WAT day.
func mrDueOn(rule string, day time.Time) bool {
	d := day.In(mrWAT)
	wd := d.Weekday()
	switch rule {
	case "tue_to_sat":
		return wd >= time.Tuesday && wd <= time.Saturday
	case "weekdays":
		return wd >= time.Monday && wd <= time.Friday
	case "every_day":
		return true
	case "monday":
		return wd == time.Monday
	case "tuesday":
		return wd == time.Tuesday
	case "wednesday":
		return wd == time.Wednesday
	case "thursday":
		return wd == time.Thursday
	case "friday":
		return wd == time.Friday
	case "first_of_month":
		return d.Day() == 1
	}
	return false
}

// mrSendAt is the send time on the given WAT day. An unreadable time falls back to 09:00,
// the time every report is agreed to go out, rather than silently never sending.
func mrSendAt(day time.Time, hhmm string) time.Time {
	h, m := 9, 0
	if t, err := time.Parse("15:04", hhmm); err == nil {
		h, m = t.Hour(), t.Minute()
	}
	d := day.In(mrWAT)
	return time.Date(d.Year(), d.Month(), d.Day(), h, m, 0, 0, mrWAT)
}

// mrNextDue is when the report will next go out. Today counts only while it has not been
// handled and the catch-up window is still open, so an overdue send shows as today (and
// the page can call it late) instead of quietly jumping to tomorrow.
func mrNextDue(rule, hhmm string, now time.Time, handledToday bool) time.Time {
	now = now.In(mrWAT)
	for i := 0; i <= 40; i++ {
		day := time.Date(now.Year(), now.Month(), now.Day()+i, 12, 0, 0, 0, mrWAT)
		if !mrDueOn(rule, day) {
			continue
		}
		at := mrSendAt(day, hhmm)
		if i == 0 && (handledToday || now.Sub(at) > mrCatchUp) {
			continue
		}
		return at
	}
	return time.Time{}
}

// mrStartRun records a run, snapshotting the recipients as they stand now. For the
// schedule, the partial unique index turns a second insert for the same report and day
// into a no-op, so two overlapping ticks cannot mail management twice.
func mrStartRun(ctx context.Context, db *core.DB, key, trigger string, userID *int64) (int64, bool, error) {
	rows, err := db.PGQuery(ctx, `
		INSERT INTO management_report_runs (report_key, run_trigger, requested_by, recipients)
		SELECT report_key, $2, $3, recipients FROM management_reports WHERE report_key = $1
		ON CONFLICT (report_key, run_date) WHERE run_trigger = 'schedule' AND status IN ('running', 'sent')
		DO NOTHING
		RETURNING id`, key, trigger, userID)
	if err != nil {
		return 0, false, err
	}
	if len(rows) == 0 {
		return 0, false, nil
	}
	return toInt64(rows[0]["id"]), true, nil
}

// mrScriptPath finds the generator. The backend runs from backend-go (run_backend.ps1
// sets the working directory) and the generator sits beside it in the repository.
func mrScriptPath() string {
	if p := os.Getenv("MGMT_REPORTS_SCRIPT"); p != "" {
		return p
	}
	rel := filepath.Join("..", "scripts", "management-reports", "build-reports.js")
	if abs, err := filepath.Abs(rel); err == nil {
		return abs
	}
	return rel
}

func mrExecute(db *core.DB, runID int64) {
	mrSlot <- struct{}{}
	defer func() { <-mrSlot }()

	ctx, cancel := context.WithTimeout(context.Background(), mrRunTimeout)
	defer cancel()

	node := os.Getenv("NODE_BIN")
	if node == "" {
		node = `C:\Program Files\nodejs\node.exe`
	}
	script := mrScriptPath()

	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, node, script, "--run-id", strconv.FormatInt(runID, 10))
	cmd.Dir = filepath.Dir(script)
	cmd.Stdout = &out
	cmd.Stderr = &out

	started := time.Now()
	err := cmd.Run()
	if err == nil {
		slog.Info("Management reports: run finished", "run_id", runID, "took", time.Since(started).Round(time.Second))
		return
	}

	// The generator records its own outcome, a failed delivery included (exit code 2).
	// This covers what it cannot: node missing, a crash before it reached the database,
	// or the timeout. The status guard leaves an outcome the generator already wrote.
	tail := strings.TrimSpace(out.String())
	if len(tail) > 4000 {
		tail = tail[len(tail)-4000:]
	}
	msg := fmt.Sprintf("The report generator stopped: %v", err)
	if ctx.Err() == context.DeadlineExceeded {
		msg = fmt.Sprintf("The report generator ran longer than %s and was stopped.", mrRunTimeout)
	}
	if tail != "" {
		msg += "\n" + tail
	}
	if _, uerr := db.PGExec(context.Background(), `
		UPDATE management_report_runs
		   SET status = 'failed', error = $2, finished_at = NOW()
		 WHERE id = $1 AND status = 'running'`, runID, msg); uerr != nil {
		slog.Error("Management reports: could not record failed run", "run_id", runID, "err", uerr)
	}
	slog.Error("Management reports: run failed", "run_id", runID, "err", err)
}

// ── Read ─────────────────────────────────────────────────────────────────────

const mrListSQL = `
SELECT m.report_key, m.name, m.audience, m.cadence, m.due_rule,
       to_char(m.send_time, 'HH24:MI') AS send_time, m.description,
       m.recipients::text AS recipients_json, m.is_active, m.sort_order,
       m.template, m.sections::text AS sections_json, m.is_builtin,
       COALESCE(cu.full_name, '') AS created_by_name,
       m.updated_at, COALESCE(u.full_name, '') AS updated_by_name,
       lr.id AS last_run_id, lr.run_trigger AS last_run_trigger, lr.status AS last_run_status,
       lr.subject AS last_run_subject, lr.started_at AS last_run_started_at,
       lr.finished_at AS last_run_finished_at, lr.error AS last_run_error,
       COALESCE(lr.requested_by_name, '') AS last_run_requested_by_name,
       pv.id AS preview_run_id, pv.started_at AS preview_at,
       (SELECT COUNT(*) FROM management_report_runs x
         WHERE x.report_key = m.report_key AND x.status = 'sent'
           AND x.run_trigger NOT IN ('preview', 'test')
           AND x.started_at > NOW() - INTERVAL '7 days')::int AS sent_7d,
       (SELECT COUNT(*) FROM management_report_runs x
         WHERE x.report_key = m.report_key AND x.status = 'failed'
           AND x.run_trigger NOT IN ('preview', 'test')
           AND x.started_at > NOW() - INTERVAL '7 days')::int AS failed_7d,
       EXISTS (SELECT 1 FROM management_report_runs s
                WHERE s.report_key = m.report_key AND s.run_trigger = 'schedule'
                  AND s.status IN ('running', 'sent')
                  AND s.run_date = (NOW() AT TIME ZONE 'Africa/Lagos')::date) AS scheduled_today
  FROM management_reports m
  LEFT JOIN o3c_users u ON u.id = m.updated_by
  LEFT JOIN o3c_users cu ON cu.id = m.created_by
  LEFT JOIN LATERAL (
       SELECT r.id, r.run_trigger, r.status, r.subject, r.started_at, r.finished_at, r.error,
              ru.full_name AS requested_by_name
         FROM management_report_runs r
         LEFT JOIN o3c_users ru ON ru.id = r.requested_by
        WHERE r.report_key = m.report_key AND r.run_trigger NOT IN ('preview', 'test')
        ORDER BY r.started_at DESC
        LIMIT 1) lr ON TRUE
  LEFT JOIN LATERAL (
       SELECT p.id, p.started_at
         FROM management_report_runs p
        WHERE p.report_key = m.report_key AND p.preview_html IS NOT NULL
          AND p.config IS NULL
        ORDER BY p.started_at DESC
        LIMIT 1) pv ON TRUE
 WHERE m.archived_at IS NULL`

func mrParseRecipients(raw string) []string {
	out := []string{}
	if raw == "" {
		return out
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return []string{}
	}
	return out
}

// mrDecorate swaps the recipients JSON for a real list and adds the next send time.
func mrDecorate(row core.Row, now time.Time) {
	row["recipients"] = mrParseRecipients(str(row["recipients_json"]))
	delete(row, "recipients_json")
	row["sections"] = mrParseRecipients(str(row["sections_json"])) // same shape: a JSON string array
	delete(row, "sections_json")
	row["next_due_at"] = nil
	active, _ := row["is_active"].(bool)
	handled, _ := row["scheduled_today"].(bool)
	if active {
		if t := mrNextDue(str(row["due_rule"]), str(row["send_time"]), now, handled); !t.IsZero() {
			row["next_due_at"] = t.Format(time.RFC3339)
		}
	}
}

func mrList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), mrListSQL+` ORDER BY m.sort_order, m.report_key`)
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		now := time.Now()
		for _, row := range rows {
			mrDecorate(row, now)
		}
		writeJSON(w, rows)
	}
}

func mrSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		reports, err := db.PGQuery(ctx, mrListSQL+` ORDER BY m.sort_order, m.report_key`)
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		now := time.Now()
		active := 0
		var next map[string]any
		var nextAt time.Time
		for _, row := range reports {
			mrDecorate(row, now)
			if on, _ := row["is_active"].(bool); on {
				active++
			}
			if s, ok := row["next_due_at"].(string); ok {
				if t, perr := time.Parse(time.RFC3339, s); perr == nil && (nextAt.IsZero() || t.Before(nextAt)) {
					nextAt = t
					next = map[string]any{"report_key": row["report_key"], "name": row["name"], "at": s}
				}
			}
		}

		out := map[string]any{
			"active": active, "total": len(reports),
			"sent_today": 0, "failed_7d": 0, "running": 0,
			"last_sent": nil, "next_due": nil,
		}
		if next != nil {
			out["next_due"] = next
		}
		if stats, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) FILTER (WHERE status = 'sent' AND run_trigger NOT IN ('preview', 'test')
			                          AND run_date = (NOW() AT TIME ZONE 'Africa/Lagos')::date)::int AS sent_today,
			       COUNT(*) FILTER (WHERE status = 'failed' AND run_trigger NOT IN ('preview', 'test')
			                          AND started_at > NOW() - INTERVAL '7 days')::int AS failed_7d,
			       COUNT(*) FILTER (WHERE status = 'running')::int AS running
			  FROM management_report_runs`); len(stats) > 0 {
			out["sent_today"] = toInt64(stats[0]["sent_today"])
			out["failed_7d"] = toInt64(stats[0]["failed_7d"])
			out["running"] = toInt64(stats[0]["running"])
		}
		if last, _ := db.PGQuery(ctx, `
			SELECT r.report_key, m.name, r.subject, r.finished_at
			  FROM management_report_runs r
			  JOIN management_reports m ON m.report_key = r.report_key
			 WHERE r.status = 'sent' AND r.run_trigger NOT IN ('preview', 'test')
			 ORDER BY r.finished_at DESC NULLS LAST
			 LIMIT 1`); len(last) > 0 {
			out["last_sent"] = last[0]
		}
		writeJSON(w, out)
	}
}

func mrRuns(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := qstr(r, "report_key")
		limit := qint(r, "limit", 50, 1, 200)
		rows, err := db.PGQuery(r.Context(), `
			SELECT r.id, r.report_key, m.name, r.run_trigger, r.status, r.run_date::text AS run_date,
			       r.subject, r.recipients::text AS recipients_json,
			       r.body_kb::float8 AS body_kb, r.chart_count, r.provider_message_id, r.error,
			       (r.preview_html IS NOT NULL) AS has_preview,
			       COALESCE(u.full_name, '') AS requested_by_name,
			       r.started_at, r.finished_at
			  FROM management_report_runs r
			  JOIN management_reports m ON m.report_key = r.report_key
			  LEFT JOIN o3c_users u ON u.id = r.requested_by
			 WHERE ($1 = '' OR r.report_key = $1)
			 ORDER BY r.started_at DESC
			 LIMIT $2`, key, limit)
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		for _, row := range rows {
			row["recipients"] = mrParseRecipients(str(row["recipients_json"]))
			delete(row, "recipients_json")
		}
		writeJSON(w, rows)
	}
}

// mrRun is one run's progress. Drafts (no report_key) are included: the editor polls this
// after a draft preview or test to see it built or failed, and /runs leaves drafts out.
func mrRun(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "invalid run id")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, report_key, run_trigger, status, subject, error,
			       (preview_html IS NOT NULL) AS has_preview, started_at, finished_at
			  FROM management_report_runs
			 WHERE id = $1`, id)
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "no such run")
			return
		}
		writeJSON(w, rows[0])
	}
}

// mrPreview returns the body exactly as built, charts inlined, for the page's preview.
func mrPreview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "invalid run id")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, report_key, subject, preview_html AS html
			  FROM management_report_runs
			 WHERE id = $1 AND preview_html IS NOT NULL`, id)
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "this run has no saved preview")
			return
		}
		writeJSON(w, rows[0])
	}
}

// ── Change ───────────────────────────────────────────────────────────────────

// mrCleanRecipients trims, lower-cases and de-duplicates addresses, keeping order.
// "Name <a@b.com>" is accepted and reduced to the address. Anything unparseable is
// returned so the page can name it, rather than being dropped silently.
func mrCleanRecipients(in []string) (clean []string, bad []string) {
	clean = []string{}
	seen := map[string]bool{}
	for _, raw := range in {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		addr, err := netmail.ParseAddress(s)
		if err != nil || !strings.Contains(addr.Address[strings.LastIndex(addr.Address, "@")+1:], ".") {
			bad = append(bad, s)
			continue
		}
		a := strings.ToLower(addr.Address)
		if seen[a] {
			continue
		}
		seen[a] = true
		clean = append(clean, a)
	}
	return clean, bad
}

// ── Catalogue and validation ─────────────────────────────────────────────────

// mrDueRule is one schedule rule, with the cadence it belongs to.
type mrDueRule struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Cadence string `json:"cadence"`
}

var mrDueRules = []mrDueRule{
	{"tue_to_sat", "Tuesday to Saturday", "daily"},
	{"weekdays", "Every Weekday", "daily"},
	{"every_day", "Every Day", "daily"},
	{"monday", "Every Monday", "weekly"},
	{"tuesday", "Every Tuesday", "weekly"},
	{"wednesday", "Every Wednesday", "weekly"},
	{"thursday", "Every Thursday", "weekly"},
	{"friday", "Every Friday", "weekly"},
	{"first_of_month", "1st of Each Month", "monthly"},
}

type mrLabel struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

var mrAudiences = []mrLabel{
	{"management", "Management"},
	{"sales", "Sales Team"},
	{"collections", "Collections"},
	{"cards", "Cards"},
	{"risk", "Risk"},
	{"operations", "Operations"},
	{"other", "Other"},
}

// mrTemplates are the templates a report may be built from. "management" and "sales" are
// the original built-ins, each with its own frame; the five after them are the split of
// the long management report (2026-09-21); "custom" is a report assembled section by
// section. Anything that is not management/sales renders through customFrame, so adding
// one here needs no generator change — but it DOES need the matching
// management_reports_template_check constraint (migration 257), or the insert is refused.
// sections.json's templates block must name exactly this set: TestMRCatalogueFile pins it.
var mrTemplates = []string{
	"management", "sales", "custom",
	"executive_briefing", "sales_products", "collections_recovery",
	"leads_contact_centre", "customers_demographics",
}
var mrCadences = []string{"daily", "weekly", "monthly"}

// mrReservedKeys can never be given to a new report: the six built-ins, and the words
// that are routes of their own under /api/management-reports.
var mrReservedKeys = []string{
	"daily", "weekly", "monthly", "sales-daily", "sales-weekly", "sales-monthly",
	"summary", "catalogue", "runs", "preview",
}

const (
	mrNameMin        = 3
	mrNameMax        = 80
	mrKeyMax         = 40
	mrMaxSections    = 40
	mrMaxRecipients  = 100
	mrDescriptionMax = 1000
)

// mrCatalogue is sections.json as the generator reads it. Groups, sections and templates
// are passed to the page untouched; only the section ids are pulled out, for validation.
type mrCatalogue struct {
	Groups    json.RawMessage `json:"groups"`
	Sections  json.RawMessage `json:"sections"`
	Templates json.RawMessage `json:"templates"`
	ids       map[string]bool
}

var mrCat struct {
	sync.Mutex
	path string
	mod  time.Time
	size int64
	data *mrCatalogue
}

// mrLoadCatalogue reads sections.json from beside the generator, re-reading it only when
// the file has changed, so an edit to the catalogue shows without a restart.
func mrLoadCatalogue() (*mrCatalogue, error) {
	path := filepath.Join(filepath.Dir(mrScriptPath()), "sections.json")
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	mrCat.Lock()
	defer mrCat.Unlock()
	if mrCat.data != nil && mrCat.path == path && mrCat.mod.Equal(fi.ModTime()) && mrCat.size == fi.Size() {
		return mrCat.data, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cat, err := mrParseCatalogue(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	mrCat.path, mrCat.mod, mrCat.size, mrCat.data = path, fi.ModTime(), fi.Size(), cat
	return cat, nil
}

func mrParseCatalogue(raw []byte) (*mrCatalogue, error) {
	var cat mrCatalogue
	if err := json.Unmarshal(raw, &cat); err != nil {
		return nil, err
	}
	var secs []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(cat.Sections, &secs); err != nil {
		return nil, fmt.Errorf("sections: %w", err)
	}
	cat.ids = make(map[string]bool, len(secs))
	for _, s := range secs {
		if s.ID != "" {
			cat.ids[s.ID] = true
		}
	}
	return &cat, nil
}

func mrCatalogueHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cat, err := mrLoadCatalogue()
		if err != nil {
			respondErrLog(w, 500, "the section catalogue could not be read", err)
			return
		}
		writeJSON(w, map[string]any{
			"groups":    cat.Groups,
			"sections":  cat.Sections,
			"templates": cat.Templates,
			"due_rules": mrDueRules,
			"audiences": mrAudiences,
		})
	}
}

func mrIn(v string, set []string) bool {
	for _, s := range set {
		if s == v {
			return true
		}
	}
	return false
}

func mrRuleLabel(rule string) string {
	for _, d := range mrDueRules {
		if d.ID == rule {
			return d.Label
		}
	}
	return rule
}

// mrCheckName trims the name and returns it with "" or the message to show.
func mrCheckName(name string) (string, string) {
	name = strings.TrimSpace(name)
	if n := utf8.RuneCountInString(name); n < mrNameMin || n > mrNameMax {
		return name, fmt.Sprintf("The report name must be between %d and %d characters.", mrNameMin, mrNameMax)
	}
	return name, ""
}

func mrCheckTemplate(t string) string {
	if !mrIn(t, mrTemplates) {
		return "Unknown template. Choose one of: " + strings.Join(mrTemplates, ", ") + "."
	}
	return ""
}

func mrCheckAudience(a string) string {
	for _, x := range mrAudiences {
		if x.ID == a {
			return ""
		}
	}
	return "The audience must be one of: management, sales, collections, cards, risk, operations, other."
}

func mrCheckCadence(c string) string {
	if !mrIn(c, mrCadences) {
		return `The cadence must be "daily", "weekly" or "monthly".`
	}
	return ""
}

// mrCheckSchedule checks that the rule exists and belongs to the cadence.
func mrCheckSchedule(cadence, rule string) string {
	if msg := mrCheckCadence(cadence); msg != "" {
		return msg
	}
	known := false
	fits := []string{}
	for _, d := range mrDueRules {
		if d.ID == rule {
			known = true
		}
		if d.Cadence == cadence {
			fits = append(fits, d.Label)
		}
	}
	if !known {
		return fmt.Sprintf("%q is not a schedule. Choose one of: %s.", rule, strings.Join(fits, ", "))
	}
	for _, d := range mrDueRules {
		if d.ID == rule && d.Cadence != cadence {
			return fmt.Sprintf("A %s report cannot go out \"%s\". Choose one of: %s.",
				cadence, mrRuleLabel(rule), strings.Join(fits, ", "))
		}
	}
	return ""
}

// mrCheckSendTime accepts a 24-hour HH:MM (a single-digit hour too) and returns it as HH:MM.
func mrCheckSendTime(s string) (string, string) {
	s = strings.TrimSpace(s)
	const msg = "The send time must be a 24-hour time such as 09:00."
	parts := strings.Split(s, ":")
	if len(parts) != 2 || len(parts[0]) < 1 || len(parts[0]) > 2 || len(parts[1]) != 2 {
		return s, msg
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 ||
		strings.ContainsAny(s, "+- ") {
		return s, msg
	}
	return fmt.Sprintf("%02d:%02d", h, m), ""
}

// mrCheckSections checks a section list against the catalogue's ids.
func mrCheckSections(sections []string, known map[string]bool) string {
	if len(sections) == 0 {
		return "Choose at least one section for the report."
	}
	if len(sections) > mrMaxSections {
		return fmt.Sprintf("A report can have at most %d sections.", mrMaxSections)
	}
	seen := map[string]bool{}
	unknown := []string{}
	for _, s := range sections {
		if !known[s] {
			unknown = append(unknown, s)
			continue
		}
		if seen[s] {
			return fmt.Sprintf("The section %q is included more than once.", s)
		}
		seen[s] = true
	}
	if len(unknown) > 0 {
		return "Not a section in the catalogue: " + strings.Join(unknown, ", ") + "."
	}
	return ""
}

// mrCheckRecipients cleans the list and returns the message for bad or too many addresses.
func mrCheckRecipients(in []string) ([]string, string) {
	clean, bad := mrCleanRecipients(in)
	if len(bad) > 0 {
		return clean, "not a valid email address: " + strings.Join(bad, ", ")
	}
	if len(clean) > mrMaxRecipients {
		return clean, fmt.Sprintf("a report can go to at most %d addresses", mrMaxRecipients)
	}
	return clean, ""
}

// mrSlug turns a name into a report key: lowercase a-z, 0-9 and single hyphens, at most
// 40 characters, never empty.
func mrSlug(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			dash = false
		default:
			if b.Len() > 0 && !dash {
				b.WriteByte('-')
				dash = true
			}
		}
	}
	s := strings.Trim(b.String(), "-")
	if len(s) > mrKeyMax {
		s = strings.TrimRight(s[:mrKeyMax], "-")
	}
	if s == "" {
		s = "report"
	}
	return s
}

// mrUniqueKey makes base unique against the taken keys with -2, -3 …, keeping to 40
// characters. Reserved keys always count as taken.
func mrUniqueKey(base string, taken map[string]bool) string {
	isTaken := func(k string) bool { return taken[k] || mrIn(k, mrReservedKeys) }
	if !isTaken(base) {
		return base
	}
	for i := 2; ; i++ {
		suffix := "-" + strconv.Itoa(i)
		stem := base
		if len(stem)+len(suffix) > mrKeyMax {
			stem = strings.TrimRight(stem[:mrKeyMax-len(suffix)], "-")
		}
		if k := stem + suffix; !isTaken(k) {
			return k
		}
	}
}

// mrReportInput is the body of create and update, and a run's draft config. Pointers keep
// "not sent" apart from "sent empty".
type mrReportInput struct {
	Name        *string   `json:"name"`
	Description *string   `json:"description"`
	Audience    *string   `json:"audience"`
	Template    *string   `json:"template"`
	Cadence     *string   `json:"cadence"`
	DueRule     *string   `json:"due_rule"`
	SendTime    *string   `json:"send_time"`
	Sections    *[]string `json:"sections"`
	Recipients  *[]string `json:"recipients"`
	IsActive    *bool     `json:"is_active"`
}

func (in *mrReportInput) empty() bool {
	return in.Name == nil && in.Description == nil && in.Audience == nil && in.Template == nil &&
		in.Cadence == nil && in.DueRule == nil && in.SendTime == nil && in.Sections == nil &&
		in.Recipients == nil && in.IsActive == nil
}

func mrDeref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// mrReport is a complete, validated report definition.
type mrReport struct {
	Name, Description, Audience, Template, Cadence, DueRule, SendTime string
	Sections, Recipients                                              []string
	IsActive                                                          bool
}

func mrCheckDescription(d string) (string, string) {
	d = strings.TrimSpace(d)
	if utf8.RuneCountInString(d) > mrDescriptionMax {
		return d, fmt.Sprintf("The description can be at most %d characters.", mrDescriptionMax)
	}
	return d, ""
}

// mrValidateCreate checks a create body. Absent name, template, audience, cadence, due_rule
// and sections fail their checks; description defaults to empty, send_time to 09:00,
// recipients to none, and is_active to off.
func mrValidateCreate(in mrReportInput, known map[string]bool) (mrReport, string) {
	var rep mrReport
	var msg string
	if rep.Name, msg = mrCheckName(mrDeref(in.Name)); msg != "" {
		return rep, msg
	}
	if rep.Description, msg = mrCheckDescription(mrDeref(in.Description)); msg != "" {
		return rep, msg
	}
	rep.Template = strings.TrimSpace(mrDeref(in.Template))
	if msg = mrCheckTemplate(rep.Template); msg != "" {
		return rep, msg
	}
	rep.Audience = strings.TrimSpace(mrDeref(in.Audience))
	if msg = mrCheckAudience(rep.Audience); msg != "" {
		return rep, msg
	}
	rep.Cadence = strings.TrimSpace(mrDeref(in.Cadence))
	rep.DueRule = strings.TrimSpace(mrDeref(in.DueRule))
	if msg = mrCheckSchedule(rep.Cadence, rep.DueRule); msg != "" {
		return rep, msg
	}
	rep.SendTime = "09:00"
	if in.SendTime != nil {
		if rep.SendTime, msg = mrCheckSendTime(*in.SendTime); msg != "" {
			return rep, msg
		}
	}
	if in.Sections != nil {
		rep.Sections = *in.Sections
	}
	if msg = mrCheckSections(rep.Sections, known); msg != "" {
		return rep, msg
	}
	rep.Recipients = []string{}
	if in.Recipients != nil {
		if rep.Recipients, msg = mrCheckRecipients(*in.Recipients); msg != "" {
			return rep, msg
		}
	}
	if in.IsActive != nil {
		rep.IsActive = *in.IsActive
	}
	return rep, ""
}

// mrRunConfig is the draft a preview or test run carries; the generator reads it in
// place of the saved report.
type mrRunConfig struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Template    string   `json:"template"`
	Cadence     string   `json:"cadence"`
	Sections    []string `json:"sections"`
	IsBuiltin   *bool    `json:"is_builtin,omitempty"`
	ReportKey   string   `json:"report_key,omitempty"`
}

// mrValidateDraft checks the parts of a draft that shape the email: name, template,
// cadence and sections. Schedule and recipients are not taken from a draft.
func mrValidateDraft(in mrReportInput, known map[string]bool) (mrRunConfig, string) {
	var cfg mrRunConfig
	var msg string
	if cfg.Name, msg = mrCheckName(mrDeref(in.Name)); msg != "" {
		return cfg, msg
	}
	if cfg.Description, msg = mrCheckDescription(mrDeref(in.Description)); msg != "" {
		return cfg, msg
	}
	cfg.Template = strings.TrimSpace(mrDeref(in.Template))
	if msg = mrCheckTemplate(cfg.Template); msg != "" {
		return cfg, msg
	}
	cfg.Cadence = strings.TrimSpace(mrDeref(in.Cadence))
	if msg = mrCheckCadence(cfg.Cadence); msg != "" {
		return cfg, msg
	}
	if in.Sections != nil {
		cfg.Sections = *in.Sections
	}
	if msg = mrCheckSections(cfg.Sections, known); msg != "" {
		return cfg, msg
	}
	return cfg, ""
}

// mrDecodeDraft reads a draft config from a request body field. An absent or null config
// returns nil with no message.
func mrDecodeDraft(raw json.RawMessage, known map[string]bool) (*mrRunConfig, string) {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return nil, ""
	}
	var in mrReportInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, "The draft report could not be read: " + mrJSONProblem(err)
	}
	cfg, msg := mrValidateDraft(in, known)
	if msg != "" {
		return nil, msg
	}
	return &cfg, ""
}

func mrJSONProblem(err error) string {
	var te *json.UnmarshalTypeError
	if errors.As(err, &te) && te.Field != "" {
		return fmt.Sprintf("%s has the wrong type.", te.Field)
	}
	return "it is not valid JSON."
}

func mrPgCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

func mrWriteStatus(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

// mrDecodeBody decodes a JSON body; an empty body leaves v untouched. It writes the error
// response itself and returns false when the body is unreadable.
func mrDecodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil && !errors.Is(err, io.EOF) {
		var te *json.UnmarshalTypeError
		if errors.As(err, &te) {
			respondErr(w, 422, mrJSONProblem(err))
			return false
		}
		respondErr(w, 400, "invalid JSON")
		return false
	}
	return true
}

// ── Reports: read one, create, update, archive, duplicate ────────────────────

// mrFetch returns one live report in the list's shape, or nil when there is none.
func mrFetch(ctx context.Context, db *core.DB, key string) (core.Row, error) {
	rows, err := db.PGQuery(ctx, mrListSQL+` AND m.report_key = $1`, key)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	mrDecorate(rows[0], time.Now())
	return rows[0], nil
}

func mrGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		row, err := mrFetch(r.Context(), db, chi.URLParam(r, "key"))
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		if row == nil {
			respondErr(w, 404, "no such report")
			return
		}
		writeJSON(w, row)
	}
}

// mrInsertReport stores a new report under a fresh key made from its name. A key taken
// between the look and the insert (two people creating the same name at once) is retried.
func mrInsertReport(ctx context.Context, db *core.DB, rep mrReport, userID int64) (string, error) {
	recipients, _ := json.Marshal(rep.Recipients)
	sections, _ := json.Marshal(rep.Sections)
	base := mrSlug(rep.Name)
	for attempt := 0; attempt < 5; attempt++ {
		existing, err := db.PGQuery(ctx, `SELECT report_key FROM management_reports`)
		if err != nil {
			return "", err
		}
		taken := make(map[string]bool, len(existing))
		for _, row := range existing {
			taken[str(row["report_key"])] = true
		}
		key := mrUniqueKey(base, taken)
		rows, err := db.PGQuery(ctx, `
			INSERT INTO management_reports
			       (report_key, name, audience, cadence, due_rule, send_time, description,
			        recipients, is_active, sort_order, template, sections, is_builtin,
			        created_by, updated_by)
			VALUES ($1, $2, $3, $4, $5, $6::time, $7, $8::jsonb, $9,
			        COALESCE((SELECT MAX(sort_order) FROM management_reports), 0) + 10,
			        $10, $11::jsonb, FALSE, $12, $12)
			ON CONFLICT (report_key) DO NOTHING
			RETURNING report_key`,
			key, rep.Name, rep.Audience, rep.Cadence, rep.DueRule, rep.SendTime, rep.Description,
			string(recipients), rep.IsActive, rep.Template, string(sections), userID)
		if err != nil {
			return "", err
		}
		if len(rows) > 0 {
			return str(rows[0]["report_key"]), nil
		}
	}
	return "", errors.New("could not find a free report key")
}

func mrCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in mrReportInput
		if !mrDecodeBody(w, r, &in) {
			return
		}
		cat, err := mrLoadCatalogue()
		if err != nil {
			respondErrLog(w, 500, "the section catalogue could not be read", err)
			return
		}
		rep, msg := mrValidateCreate(in, cat.ids)
		if msg != "" {
			respondErr(w, 422, msg)
			return
		}
		user := core.UserFromCtx(r.Context())
		key, err := mrInsertReport(r.Context(), db, rep, user.ID)
		if err != nil {
			respondErrLog(w, 500, "save failed", err)
			return
		}
		row, err := mrFetch(r.Context(), db, key)
		if err != nil || row == nil {
			respondErrLog(w, 500, "the report was saved but could not be read back", err)
			return
		}

		aid, aname, ateam := actorOf(user)
		logActivitySafe(r.Context(), db, Activity{
			ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "note", Outcome: "created",
			Subject: "Management report created — " + rep.Name,
			Source:  "reports", EntityType: "management_report", EntityID: key,
			Metadata: map[string]any{
				"template": rep.Template, "audience": rep.Audience, "cadence": rep.Cadence,
				"due_rule": rep.DueRule, "send_time": rep.SendTime, "sections": rep.Sections,
				"recipients": rep.Recipients, "is_active": rep.IsActive,
			},
		})
		mrWriteStatus(w, http.StatusCreated, row)
	}
}

// mrUpdate changes any subset of a report. The original body {recipients?, is_active?}
// still works unchanged.
func mrUpdate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")
		var in mrReportInput
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			var te *json.UnmarshalTypeError
			if errors.As(err, &te) {
				respondErr(w, 422, mrJSONProblem(err))
				return
			}
			respondErr(w, 400, "invalid JSON")
			return
		}
		if in.empty() {
			respondErr(w, 422, "nothing to change")
			return
		}

		cur, err := db.PGQuery(r.Context(), `
			SELECT template, cadence, due_rule, is_builtin
			  FROM management_reports WHERE report_key = $1 AND archived_at IS NULL`, key)
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		if len(cur) == 0 {
			respondErr(w, 404, "no such report")
			return
		}
		builtin, _ := cur[0]["is_builtin"].(bool)

		sets := []string{}
		args := []any{}
		meta := map[string]any{}
		set := func(expr string, val any, field string, shown any) {
			args = append(args, val)
			sets = append(sets, fmt.Sprintf(expr, len(args)))
			meta[field] = shown
		}

		if in.Name != nil {
			name, msg := mrCheckName(*in.Name)
			if msg != "" {
				respondErr(w, 422, msg)
				return
			}
			set("name = $%d", name, "name", name)
		}
		if in.Description != nil {
			d, msg := mrCheckDescription(*in.Description)
			if msg != "" {
				respondErr(w, 422, msg)
				return
			}
			set("description = $%d", d, "description", d)
		}
		if in.Template != nil {
			t := strings.TrimSpace(*in.Template)
			if msg := mrCheckTemplate(t); msg != "" {
				respondErr(w, 422, msg)
				return
			}
			if t != str(cur[0]["template"]) {
				if builtin {
					respondErr(w, 422, "The template of a built-in report cannot be changed.")
					return
				}
				set("template = $%d", t, "template", t)
			}
		}
		if in.Audience != nil {
			a := strings.TrimSpace(*in.Audience)
			if msg := mrCheckAudience(a); msg != "" {
				respondErr(w, 422, msg)
				return
			}
			set("audience = $%d", a, "audience", a)
		}
		if in.Cadence != nil || in.DueRule != nil {
			cadence, rule := str(cur[0]["cadence"]), str(cur[0]["due_rule"])
			if in.Cadence != nil {
				cadence = strings.TrimSpace(*in.Cadence)
			}
			if in.DueRule != nil {
				rule = strings.TrimSpace(*in.DueRule)
			}
			if msg := mrCheckSchedule(cadence, rule); msg != "" {
				respondErr(w, 422, msg)
				return
			}
			if in.Cadence != nil {
				set("cadence = $%d", cadence, "cadence", cadence)
			}
			if in.DueRule != nil {
				set("due_rule = $%d", rule, "due_rule", rule)
			}
		}
		if in.SendTime != nil {
			t, msg := mrCheckSendTime(*in.SendTime)
			if msg != "" {
				respondErr(w, 422, msg)
				return
			}
			set("send_time = $%d::time", t, "send_time", t)
		}
		if in.Sections != nil {
			cat, err := mrLoadCatalogue()
			if err != nil {
				respondErrLog(w, 500, "the section catalogue could not be read", err)
				return
			}
			if msg := mrCheckSections(*in.Sections, cat.ids); msg != "" {
				respondErr(w, 422, msg)
				return
			}
			b, _ := json.Marshal(*in.Sections)
			set("sections = $%d::jsonb", string(b), "sections", *in.Sections)
		}
		if in.Recipients != nil {
			clean, msg := mrCheckRecipients(*in.Recipients)
			if msg != "" {
				respondErr(w, 422, msg)
				return
			}
			b, _ := json.Marshal(clean)
			set("recipients = $%d::jsonb", string(b), "recipients", clean)
		}
		if in.IsActive != nil {
			set("is_active = $%d", *in.IsActive, "is_active", *in.IsActive)
		}

		user := core.UserFromCtx(r.Context())
		args = append(args, user.ID)
		sets = append(sets, fmt.Sprintf("updated_by = $%d", len(args)), "updated_at = NOW()")
		args = append(args, key)

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			UPDATE management_reports SET %s WHERE report_key = $%d AND archived_at IS NULL
			RETURNING report_key, name`,
			strings.Join(sets, ", "), len(args)), args...)
		if err != nil {
			if mrPgCode(err) == "23514" {
				// A concurrent edit changed the cadence or rule between the check and the save.
				respondErr(w, 422, "The schedule no longer fits the report's cadence. Reload the report and try again.")
				return
			}
			respondErrLog(w, 500, "save failed", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "no such report")
			return
		}
		row, err := mrFetch(r.Context(), db, key)
		if err != nil || row == nil {
			respondErrLog(w, 500, "the report was saved but could not be read back", err)
			return
		}

		aid, aname, ateam := actorOf(user)
		logActivitySafe(r.Context(), db, Activity{
			ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "note", Outcome: "updated",
			Subject: "Management report settings changed — " + str(rows[0]["name"]),
			Source:  "reports", EntityType: "management_report", EntityID: key,
			Metadata: meta,
		})
		writeJSON(w, row)
	}
}

// mrArchive "deletes" a report by archiving it, so its send history stays readable.
func mrArchive(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")
		cur, err := db.PGQuery(r.Context(), `
			SELECT name, is_builtin FROM management_reports
			 WHERE report_key = $1 AND archived_at IS NULL`, key)
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		if len(cur) == 0 {
			respondErr(w, 404, "no such report")
			return
		}
		if builtin, _ := cur[0]["is_builtin"].(bool); builtin {
			respondErr(w, 409, "The built-in reports can be paused, not deleted.")
			return
		}
		user := core.UserFromCtx(r.Context())
		res, err := db.PGExec(r.Context(), `
			UPDATE management_reports
			   SET archived_at = NOW(), is_active = FALSE, updated_by = $2, updated_at = NOW()
			 WHERE report_key = $1 AND archived_at IS NULL AND NOT is_builtin`, key, user.ID)
		if err != nil {
			respondErrLog(w, 500, "archive failed", err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 404, "no such report")
			return
		}

		aid, aname, ateam := actorOf(user)
		logActivitySafe(r.Context(), db, Activity{
			ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "note", Outcome: "archived",
			Subject: "Management report deleted — " + str(cur[0]["name"]),
			Source:  "reports", EntityType: "management_report", EntityID: key,
		})
		writeJSON(w, map[string]any{"report_key": key, "archived": true})
	}
}

// mrCopyName is "Copy of <name>", kept within the 80-character limit.
func mrCopyName(name string) string {
	n := []rune("Copy of " + strings.TrimSpace(name))
	if len(n) > mrNameMax {
		n = n[:mrNameMax]
	}
	return strings.TrimSpace(string(n))
}

func mrDuplicate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")
		src, err := db.PGQuery(r.Context(), `
			SELECT name, description, audience, template, cadence, due_rule,
			       to_char(send_time, 'HH24:MI') AS send_time,
			       sections::text AS sections_json, recipients::text AS recipients_json
			  FROM management_reports WHERE report_key = $1 AND archived_at IS NULL`, key)
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		if len(src) == 0 {
			respondErr(w, 404, "no such report")
			return
		}
		s := src[0]
		rep := mrReport{
			Name:        mrCopyName(str(s["name"])),
			Description: str(s["description"]),
			Audience:    str(s["audience"]),
			Template:    str(s["template"]),
			Cadence:     str(s["cadence"]),
			DueRule:     str(s["due_rule"]),
			SendTime:    str(s["send_time"]),
			Sections:    mrParseRecipients(str(s["sections_json"])),
			Recipients:  mrParseRecipients(str(s["recipients_json"])),
			IsActive:    false,
		}
		user := core.UserFromCtx(r.Context())
		newKey, err := mrInsertReport(r.Context(), db, rep, user.ID)
		if err != nil {
			respondErrLog(w, 500, "duplicate failed", err)
			return
		}
		row, err := mrFetch(r.Context(), db, newKey)
		if err != nil || row == nil {
			respondErrLog(w, 500, "the copy was saved but could not be read back", err)
			return
		}

		aid, aname, ateam := actorOf(user)
		logActivitySafe(r.Context(), db, Activity{
			ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "note", Outcome: "duplicated",
			Subject: "Management report duplicated — " + str(s["name"]) + " as " + rep.Name,
			Source:  "reports", EntityType: "management_report", EntityID: newKey,
			Metadata: map[string]any{"copied_from": key},
		})
		mrWriteStatus(w, http.StatusCreated, row)
	}
}

// ── Sending ──────────────────────────────────────────────────────────────────

// mrStartAdhocRun records a preview or test run, optionally carrying a draft config. A
// nil key is a draft of a report not yet saved. Recipients default to the report's own.
func mrStartAdhocRun(ctx context.Context, db *core.DB, key *string, trigger string, userID int64,
	recipients []string, cfg *mrRunConfig) (int64, error) {
	var recip, config *string
	if recipients != nil {
		b, _ := json.Marshal(recipients)
		s := string(b)
		recip = &s
	}
	if cfg != nil {
		b, _ := json.Marshal(cfg)
		s := string(b)
		config = &s
	}
	rows, err := db.PGQuery(ctx, `
		INSERT INTO management_report_runs (report_key, run_trigger, requested_by, recipients, config)
		VALUES ($1, $2, $3,
		        COALESCE($4::jsonb, (SELECT m.recipients FROM management_reports m WHERE m.report_key = $1), '[]'::jsonb),
		        $5::jsonb)
		RETURNING id`, key, trigger, userID, recip, config)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, errors.New("the run was not recorded")
	}
	return toInt64(rows[0]["id"]), nil
}

// mrSend builds a report on demand. mode "send" delivers it to the current recipients;
// "preview" builds it with today's figures and delivers nothing; "test" delivers it only
// to the person asking, marked as a test. A preview or test may carry a draft config.
func mrSend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")
		var req struct {
			Mode   string          `json:"mode"`
			Config json.RawMessage `json:"config"`
		}
		if !mrDecodeBody(w, r, &req) {
			return
		}
		mode := req.Mode
		if mode == "" {
			mode = "send"
		}
		if mode != "send" && mode != "preview" && mode != "test" {
			respondErr(w, 422, `mode must be "send", "preview" or "test"`)
			return
		}
		hasConfig := len(bytes.TrimSpace(req.Config)) > 0 && string(bytes.TrimSpace(req.Config)) != "null"
		if mode == "send" && hasConfig {
			respondErr(w, 422, "A draft can be previewed or sent as a test, not sent to the recipients. Save the report first.")
			return
		}

		rep, err := db.PGQuery(r.Context(), `
			SELECT name, template, is_builtin, jsonb_array_length(recipients) AS recipient_count
			  FROM management_reports WHERE report_key = $1 AND archived_at IS NULL`, key)
		if err != nil {
			respondErrLog(w, 500, "query failed", err)
			return
		}
		if len(rep) == 0 {
			respondErr(w, 404, "no such report")
			return
		}
		name := str(rep[0]["name"])
		count := toInt64(rep[0]["recipient_count"])
		builtin, _ := rep[0]["is_builtin"].(bool)
		if mode == "send" && count == 0 {
			respondErr(w, 422, "add at least one recipient before sending")
			return
		}

		var cfg *mrRunConfig
		if hasConfig {
			cat, err := mrLoadCatalogue()
			if err != nil {
				respondErrLog(w, 500, "the section catalogue could not be read", err)
				return
			}
			var msg string
			if cfg, msg = mrDecodeDraft(req.Config, cat.ids); msg != "" {
				respondErr(w, 422, msg)
				return
			}
			if builtin && cfg.Template != str(rep[0]["template"]) {
				respondErr(w, 422, "The template of a built-in report cannot be changed.")
				return
			}
			cfg.ReportKey = key
			cfg.IsBuiltin = &builtin
		}

		user := core.UserFromCtx(r.Context())
		uid := user.ID
		var id int64
		switch {
		case mode == "test":
			me, err := db.PGQuery(r.Context(), `SELECT COALESCE(email, '') AS email FROM o3c_users WHERE id = $1`, uid)
			if err != nil {
				respondErrLog(w, 500, "query failed", err)
				return
			}
			email := ""
			if len(me) > 0 {
				email = strings.ToLower(strings.TrimSpace(str(me[0]["email"])))
			}
			if email == "" {
				respondErr(w, 422, "Your account has no email address to send a test to.")
				return
			}
			if id, err = mrStartAdhocRun(r.Context(), db, &key, "test", uid, []string{email}, cfg); err != nil {
				respondErrLog(w, 500, "could not start the run", err)
				return
			}
			aid, aname, ateam := actorOf(user)
			logActivitySafe(r.Context(), db, Activity{
				ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
				Type: "note", Outcome: "test_sent",
				Subject: "Management report test sent — " + name,
				Source:  "reports", EntityType: "management_report", EntityID: key,
				Metadata: map[string]any{"run_id": id, "to": email, "draft": cfg != nil},
			})
		case mode == "preview" && cfg != nil:
			if id, err = mrStartAdhocRun(r.Context(), db, &key, "preview", uid, nil, cfg); err != nil {
				respondErrLog(w, 500, "could not start the run", err)
				return
			}
		default:
			trigger := "manual"
			if mode == "preview" {
				trigger = "preview"
			}
			var started bool
			id, started, err = mrStartRun(r.Context(), db, key, trigger, &uid)
			if err != nil {
				respondErrLog(w, 500, "could not start the run", err)
				return
			}
			if !started {
				respondErr(w, 409, "this report is already being sent")
				return
			}
			if mode == "send" {
				aid, aname, ateam := actorOf(user)
				logActivitySafe(r.Context(), db, Activity{
					ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
					Type: "note", Outcome: "sent",
					Subject: "Management report sent on demand — " + name,
					Source:  "reports", EntityType: "management_report", EntityID: key,
					Metadata: map[string]any{"run_id": id, "recipients": count},
				})
			}
		}
		go mrExecute(db, id)

		mrWriteStatus(w, http.StatusAccepted, map[string]any{"run_id": id, "status": "running", "mode": mode})
	}
}

// mrDraftPreview builds a report that has not been saved yet, from its draft config alone.
func mrDraftPreview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Config json.RawMessage `json:"config"`
		}
		if !mrDecodeBody(w, r, &req) {
			return
		}
		cat, err := mrLoadCatalogue()
		if err != nil {
			respondErrLog(w, 500, "the section catalogue could not be read", err)
			return
		}
		cfg, msg := mrDecodeDraft(req.Config, cat.ids)
		if msg != "" {
			respondErr(w, 422, msg)
			return
		}
		if cfg == nil {
			respondErr(w, 422, "Send the draft report as config to preview it.")
			return
		}
		user := core.UserFromCtx(r.Context())
		id, err := mrStartAdhocRun(r.Context(), db, nil, "preview", user.ID, nil, cfg)
		if err != nil {
			respondErrLog(w, 500, "could not start the run", err)
			return
		}
		go mrExecute(db, id)
		mrWriteStatus(w, http.StatusAccepted, map[string]any{"run_id": id, "status": "running", "mode": "preview"})
	}
}
