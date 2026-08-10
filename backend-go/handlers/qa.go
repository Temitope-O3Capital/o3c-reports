package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// ── Call-Centre QA (quality assurance) module ────────────────────────────────────
// An evaluator scores a call against weighted parameters; the system computes a
// 0–100 score, a performance band and a pass/fail. Config (section weights,
// parameters, points, pass threshold) is stored in DB and editable by supervisors.

// qaSeed is the default parameter set from the QA spec. Section weights sum to 100.
var qaSeed = []struct {
	Section, SectionLabel string
	Weight                int
	Param, Label          string
	MaxPoints, Order      int
}{
	{"opening", "Opening & Professionalism", 20, "greeting", "Greeting & Introduction", 5, 1},
	{"opening", "Opening & Professionalism", 20, "verification", "Identity Verification", 5, 2},
	{"opening", "Opening & Professionalism", 20, "purpose", "Purpose of the Call", 5, 3},
	{"opening", "Opening & Professionalism", 20, "tone", "Professional Tone", 5, 4},

	{"communication", "Communication Skills", 30, "listening", "Active Listening", 5, 5},
	{"communication", "Communication Skills", 30, "clear_comm", "Clear Communication", 5, 6},
	{"communication", "Communication Skills", 30, "empathy", "Empathy", 5, 7},
	{"communication", "Communication Skills", 30, "probing", "Appropriate Probing Questions", 5, 8},
	{"communication", "Communication Skills", 30, "call_control", "Call Control", 5, 9},
	{"communication", "Communication Skills", 30, "etiquette", "Professional Language & Etiquette", 5, 10},

	{"handling", "Call Handling & Resolution", 35, "knowledge", "Product/Process Knowledge", 5, 11},
	{"handling", "Call Handling & Resolution", 35, "accuracy", "Accuracy of Information Provided", 5, 12},
	{"handling", "Call Handling & Resolution", 35, "compliance", "Compliance with Procedure", 5, 13},
	{"handling", "Call Handling & Resolution", 35, "resolution", "Resolution / Achievement of Call Objective", 10, 14},
	{"handling", "Call Handling & Resolution", 35, "objection", "Complaint/Objection Handling", 5, 15},
	{"handling", "Call Handling & Resolution", 35, "sales_technique", "Sales or Collection Technique", 5, 16},

	{"closing", "Closing & Documentation", 15, "next_steps", "Confirmation of Next Steps", 5, 17},
	{"closing", "Closing & Documentation", 15, "closing", "Professional Closing", 5, 18},
	{"closing", "Closing & Documentation", 15, "crm_doc", "Accurate CRM Documentation", 5, 19},
}

func ensureQASchema(ctx context.Context, db *core.DB) {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS qa_parameters (
			id BIGSERIAL PRIMARY KEY,
			section_key TEXT NOT NULL,
			section_label TEXT NOT NULL,
			section_weight NUMERIC NOT NULL DEFAULT 0,
			param_key TEXT UNIQUE NOT NULL,
			param_label TEXT NOT NULL,
			max_points NUMERIC NOT NULL DEFAULT 5,
			sort_order INT NOT NULL DEFAULT 0,
			active BOOLEAN NOT NULL DEFAULT TRUE
		)`,
		`CREATE TABLE IF NOT EXISTS qa_settings (
			id INT PRIMARY KEY DEFAULT 1,
			pass_threshold NUMERIC NOT NULL DEFAULT 70,
			critical_error_auto_fail BOOLEAN NOT NULL DEFAULT TRUE,
			CONSTRAINT qa_settings_single CHECK (id = 1)
		)`,
		`CREATE TABLE IF NOT EXISTS qa_evaluations (
			id BIGSERIAL PRIMARY KEY,
			call_id BIGINT,
			zoho_call_id TEXT,
			agent_id BIGINT,
			agent_name TEXT,
			evaluator_id BIGINT,
			evaluator_name TEXT,
			call_direction TEXT,
			call_started_at TIMESTAMPTZ,
			customer_name TEXT,
			call_type TEXT,
			scores JSONB NOT NULL DEFAULT '{}'::jsonb,
			total_score NUMERIC NOT NULL DEFAULT 0,
			rating_band TEXT,
			passed BOOLEAN NOT NULL DEFAULT FALSE,
			critical_error BOOLEAN NOT NULL DEFAULT FALSE,
			strengths TEXT,
			improvements TEXT,
			coaching_notes TEXT,
			coaching_status TEXT NOT NULL DEFAULT 'open',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS qa_eval_agent_idx ON qa_evaluations(agent_id)`,
		`CREATE INDEX IF NOT EXISTS qa_eval_call_idx ON qa_evaluations(call_id)`,
		`CREATE INDEX IF NOT EXISTS qa_eval_created_idx ON qa_evaluations(created_at DESC)`,
	}
	for _, s := range stmts {
		db.PGExec(ctx, s) //nolint:errcheck
	}
	db.PGExec(ctx, `INSERT INTO qa_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`) //nolint:errcheck
	// Seed default parameters (ON CONFLICT DO NOTHING keeps any admin edits).
	for _, p := range qaSeed {
		db.PGExec(ctx, `
			INSERT INTO qa_parameters (section_key, section_label, section_weight, param_key, param_label, max_points, sort_order, active)
			VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE) ON CONFLICT (param_key) DO NOTHING`,
			p.Section, p.SectionLabel, p.Weight, p.Param, p.Label, p.MaxPoints, p.Order) //nolint:errcheck
	}
}

// qaEvaluator reports whether the user may create/edit evaluations and config.
func qaEvaluator(u *core.Claims) bool {
	if u == nil {
		return false
	}
	switch u.Role {
	case "call_center_head", "admin", "md", "coo", "cfo", "cmo", "management", "head_ops", "head_it":
		return true
	}
	return u.CanSeeAllRows()
}

// RegisterQA mounts the QA routes; the caller provides the /api/qa prefix + gating.
func RegisterQA(r chi.Router, db *core.DB) {
	ensureQASchema(context.Background(), db)
	r.Get("/config", qaConfig(db))
	r.Put("/config", qaSaveConfig(db))
	r.Post("/evaluations", qaCreateEvaluation(db))
	r.Get("/evaluations", qaListEvaluations(db))
	r.Get("/evaluations/{id}", qaGetEvaluation(db))
	r.Get("/by-call/{callId}", qaByCall(db))
	r.Get("/stats", qaStats(db))
	r.Get("/my", qaMy(db))
	r.Get("/coaching", qaCoaching(db))
	r.Patch("/evaluations/{id}/coaching", qaUpdateCoaching(db))
}

// ── Config ──────────────────────────────────────────────────────────────────────

type qaParam struct {
	SectionKey   string  `json:"section_key"`
	SectionLabel string  `json:"section_label"`
	SectionWt    float64 `json:"section_weight"`
	ParamKey     string  `json:"param_key"`
	ParamLabel   string  `json:"param_label"`
	MaxPoints    float64 `json:"max_points"`
	Order        int     `json:"sort_order"`
	Active       bool    `json:"active"`
}

func qaLoadParams(ctx context.Context, db *core.DB) []qaParam {
	rows, _ := db.PGQuery(ctx, `SELECT section_key, section_label, section_weight, param_key, param_label, max_points, sort_order, active FROM qa_parameters WHERE active ORDER BY sort_order`)
	out := make([]qaParam, 0, len(rows))
	for _, r := range rows {
		out = append(out, qaParam{
			SectionKey: str(r["section_key"]), SectionLabel: str(r["section_label"]),
			SectionWt: toFloat(r["section_weight"]), ParamKey: str(r["param_key"]),
			ParamLabel: str(r["param_label"]), MaxPoints: toFloat(r["max_points"]),
			Order: int(toInt64(r["sort_order"])), Active: true,
		})
	}
	return out
}

func qaLoadSettings(ctx context.Context, db *core.DB) (float64, bool) {
	pass, autoFail := 70.0, true
	if rows, _ := db.PGQuery(ctx, `SELECT pass_threshold, critical_error_auto_fail FROM qa_settings WHERE id=1`); len(rows) > 0 {
		pass = toFloat(rows[0]["pass_threshold"])
		autoFail = rows[0]["critical_error_auto_fail"] == true
	}
	return pass, autoFail
}

func qaConfig(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		params := qaLoadParams(ctx, db)
		pass, autoFail := qaLoadSettings(ctx, db)
		// Group params by section preserving order.
		type section struct {
			Key    string    `json:"key"`
			Label  string    `json:"label"`
			Weight float64   `json:"weight"`
			Params []qaParam `json:"params"`
		}
		var sections []section
		idx := map[string]int{}
		for _, p := range params {
			if i, ok := idx[p.SectionKey]; ok {
				sections[i].Params = append(sections[i].Params, p)
			} else {
				idx[p.SectionKey] = len(sections)
				sections = append(sections, section{Key: p.SectionKey, Label: p.SectionLabel, Weight: p.SectionWt, Params: []qaParam{p}})
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"sections": sections,
			"settings": map[string]any{"pass_threshold": pass, "critical_error_auto_fail": autoFail},
			"scale": []map[string]any{
				{"value": 5, "label": "Excellent"}, {"value": 4, "label": "Good"},
				{"value": 3, "label": "Meets Expectations"}, {"value": 2, "label": "Needs Improvement"},
				{"value": 1, "label": "Poor"}, {"value": 0, "label": "Not Demonstrated"},
			},
			"can_evaluate": qaEvaluator(core.UserFromCtx(ctx)),
		})
	}
}

func qaSaveConfig(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !qaEvaluator(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Only supervisors can edit QA settings")
			return
		}
		var b struct {
			Sections []struct {
				Key    string  `json:"key"`
				Weight float64 `json:"weight"`
			} `json:"sections"`
			Params []struct {
				ParamKey  string  `json:"param_key"`
				Label     string  `json:"param_label"`
				MaxPoints float64 `json:"max_points"`
				Active    *bool   `json:"active"`
			} `json:"params"`
			Settings *struct {
				PassThreshold         *float64 `json:"pass_threshold"`
				CriticalErrorAutoFail *bool    `json:"critical_error_auto_fail"`
			} `json:"settings"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		ctx := r.Context()
		for _, s := range b.Sections {
			db.PGExec(ctx, `UPDATE qa_parameters SET section_weight=$1 WHERE section_key=$2`, s.Weight, s.Key) //nolint:errcheck
		}
		for _, p := range b.Params {
			if p.Active != nil {
				db.PGExec(ctx, `UPDATE qa_parameters SET param_label=COALESCE(NULLIF($1,''),param_label), max_points=$2, active=$3 WHERE param_key=$4`, p.Label, p.MaxPoints, *p.Active, p.ParamKey) //nolint:errcheck
			} else {
				db.PGExec(ctx, `UPDATE qa_parameters SET param_label=COALESCE(NULLIF($1,''),param_label), max_points=$2 WHERE param_key=$3`, p.Label, p.MaxPoints, p.ParamKey) //nolint:errcheck
			}
		}
		if b.Settings != nil {
			if b.Settings.PassThreshold != nil {
				db.PGExec(ctx, `UPDATE qa_settings SET pass_threshold=$1 WHERE id=1`, *b.Settings.PassThreshold) //nolint:errcheck
			}
			if b.Settings.CriticalErrorAutoFail != nil {
				db.PGExec(ctx, `UPDATE qa_settings SET critical_error_auto_fail=$1 WHERE id=1`, *b.Settings.CriticalErrorAutoFail) //nolint:errcheck
			}
		}
		respond(w, map[string]any{"ok": true}, "qa")
	}
}

// ── Scoring ─────────────────────────────────────────────────────────────────────

type qaScore struct {
	Rating  *int   `json:"rating"` // nil = N/A
	NA      bool   `json:"na"`
	Comment string `json:"comment"`
}

// qaCompute recomputes the authoritative total (0–100), band and pass from the
// submitted ratings + live config. Section weights are rescaled when a whole
// section is N/A; within a section, N/A params drop out of the denominator.
func qaCompute(params []qaParam, scores map[string]qaScore, pass float64, autoFail, critical bool) (float64, string, bool) {
	secEarned := map[string]float64{}
	secMax := map[string]float64{}
	secWeight := map[string]float64{}
	for _, p := range params {
		secWeight[p.SectionKey] = p.SectionWt
		sc, ok := scores[p.ParamKey]
		if !ok || sc.NA || sc.Rating == nil {
			continue // N/A or unrated → excluded
		}
		rating := float64(*sc.Rating)
		if rating < 0 {
			rating = 0
		}
		if rating > 5 {
			rating = 5
		}
		secEarned[p.SectionKey] += (rating / 5.0) * p.MaxPoints
		secMax[p.SectionKey] += p.MaxPoints
	}
	var weightedPct, totalWeight float64
	for sec, wt := range secWeight {
		if secMax[sec] <= 0 {
			continue // whole section N/A → excluded, its weight redistributes
		}
		pct := secEarned[sec] / secMax[sec] // 0..1
		weightedPct += pct * wt
		totalWeight += wt
	}
	total := 0.0
	if totalWeight > 0 {
		total = (weightedPct / totalWeight) * 100
	}
	total = math.Round(total*10) / 10
	band := qaBand(total)
	passed := total >= pass
	if critical && autoFail {
		passed = false
	}
	return total, band, passed
}

func qaBand(score float64) string {
	switch {
	case score >= 95:
		return "Outstanding"
	case score >= 90:
		return "Excellent"
	case score >= 80:
		return "Good"
	case score >= 70:
		return "Fair"
	default:
		return "Needs Improvement"
	}
}

// ── Evaluations ─────────────────────────────────────────────────────────────────

func qaCreateEvaluation(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if !qaEvaluator(user) {
			respondErr(w, 403, "Only supervisors can evaluate calls")
			return
		}
		var b struct {
			CallID        int64              `json:"call_id"`
			Scores        map[string]qaScore `json:"scores"`
			CriticalError bool               `json:"critical_error"`
			Strengths     string             `json:"strengths"`
			Improvements  string             `json:"improvements"`
			CoachingNotes string             `json:"coaching_notes"`
			CallType      string             `json:"call_type"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.CallID == 0 {
			respondErr(w, 400, "call_id and scores are required")
			return
		}
		ctx := r.Context()

		// Pull the call for denormalised context on the evaluation.
		var agentID int64
		var agentName, direction, custName, zohoID string
		var startedAt any
		if rows, _ := db.PGQuery(ctx,
			`SELECT agent_id, agent_name, direction, customer_name, zoho_call_id, started_at FROM helpdesk_calls WHERE id=$1`, b.CallID); len(rows) > 0 {
			agentID = toInt64(rows[0]["agent_id"])
			agentName = str(rows[0]["agent_name"])
			direction = str(rows[0]["direction"])
			custName = str(rows[0]["customer_name"])
			zohoID = str(rows[0]["zoho_call_id"])
			startedAt = rows[0]["started_at"]
		} else {
			respondErr(w, 404, "Call not found")
			return
		}

		params := qaLoadParams(ctx, db)
		passThresh, autoFail := qaLoadSettings(ctx, db)
		total, band, passed := qaCompute(params, b.Scores, passThresh, autoFail, b.CriticalError)

		scoresJSON, _ := json.Marshal(b.Scores)
		rows, err := db.PGQuery(ctx, `
			INSERT INTO qa_evaluations
			  (call_id, zoho_call_id, agent_id, agent_name, evaluator_id, evaluator_name,
			   call_direction, call_started_at, customer_name, call_type,
			   scores, total_score, rating_band, passed, critical_error, strengths, improvements, coaching_notes)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18)
			RETURNING id`,
			b.CallID, zohoID, nullIfZero(agentID), agentName, user.ID, user.FullName,
			direction, startedAt, custName, b.CallType,
			string(scoresJSON), total, band, passed, b.CriticalError,
			b.Strengths, b.Improvements, b.CoachingNotes)
		if err != nil {
			respondErr(w, 500, "Could not save evaluation: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"id": rows[0]["id"], "total_score": total, "rating_band": band, "passed": passed,
		})
	}
}

func qaListEvaluations(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		where := "1=1"
		var args []any
		n := 1
		// Non-evaluators only ever see their own scorecards.
		if !qaEvaluator(user) {
			where += fmt.Sprintf(" AND agent_id = $%d", n)
			args = append(args, user.ID)
			n++
		} else if a := qstr(r, "agent"); a != "" {
			where += fmt.Sprintf(" AND agent_id = $%d", n)
			args = append(args, a)
			n++
		}
		if v := qstr(r, "from"); v != "" {
			where += fmt.Sprintf(" AND created_at::date >= $%d::date", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "to"); v != "" {
			where += fmt.Sprintf(" AND created_at::date <= $%d::date", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "result"); v == "pass" {
			where += " AND passed"
		} else if v == "fail" {
			where += " AND NOT passed"
		}
		limit := qint(r, "limit", 100, 1, 500)
		rows, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT id, call_id, agent_id, agent_name, evaluator_name, call_direction, customer_name,
			       total_score, rating_band, passed, critical_error, coaching_status, created_at
			FROM qa_evaluations WHERE %s ORDER BY created_at DESC LIMIT $%d`, where, n), append(args, limit)...)
		jsonRows(w, rows)
	}
}

func qaGetEvaluation(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, _ := db.PGQuery(r.Context(), `SELECT * FROM qa_evaluations WHERE id=$1`, id)
		if len(rows) == 0 {
			respondErr(w, 404, "Not found")
			return
		}
		user := core.UserFromCtx(r.Context())
		if !qaEvaluator(user) && toInt64(rows[0]["agent_id"]) != user.ID {
			respondErr(w, 403, "Forbidden")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func qaByCall(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		callID := chi.URLParam(r, "callId")
		rows, _ := db.PGQuery(r.Context(),
			`SELECT id, total_score, rating_band, passed, evaluator_name, created_at FROM qa_evaluations WHERE call_id=$1 ORDER BY created_at DESC`, callID)
		jsonRows(w, rows)
	}
}

// ── Dashboards ──────────────────────────────────────────────────────────────────

func qaDateFilter(r *http.Request) (string, []any, int) {
	where := "1=1"
	var args []any
	n := 1
	if v := qstr(r, "from"); v != "" {
		where += fmt.Sprintf(" AND created_at::date >= $%d::date", n)
		args = append(args, v)
		n++
	}
	if v := qstr(r, "to"); v != "" {
		where += fmt.Sprintf(" AND created_at::date <= $%d::date", n)
		args = append(args, v)
		n++
	}
	return where, args, n
}

func qaStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !qaEvaluator(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Forbidden")
			return
		}
		ctx := r.Context()
		where, args, _ := qaDateFilter(r)

		summary := map[string]any{}
		if rows, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT COUNT(*)::int AS evaluations,
			       COALESCE(ROUND(AVG(total_score),1),0) AS avg_score,
			       COUNT(*) FILTER (WHERE passed)::int AS passed,
			       COUNT(*) FILTER (WHERE NOT passed)::int AS failed,
			       COUNT(*) FILTER (WHERE critical_error)::int AS critical_errors,
			       COUNT(DISTINCT agent_id)::int AS agents_evaluated
			FROM qa_evaluations WHERE %s`, where), args...); len(rows) > 0 {
			summary = rows[0]
		}
		byAgent, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT agent_id, COALESCE(NULLIF(agent_name,''),'Unknown') AS agent_name,
			       COUNT(*)::int AS evaluations,
			       ROUND(AVG(total_score),1) AS avg_score,
			       COUNT(*) FILTER (WHERE passed)::int AS passed,
			       COUNT(*) FILTER (WHERE critical_error)::int AS critical_errors
			FROM qa_evaluations WHERE %s
			GROUP BY agent_id, agent_name ORDER BY avg_score DESC NULLS LAST`, where), args...)
		byBand, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT rating_band, COUNT(*)::int AS count FROM qa_evaluations WHERE %s GROUP BY rating_band`, where), args...)
		trend, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT created_at::date AS day, ROUND(AVG(total_score),1) AS avg_score, COUNT(*)::int AS count
			FROM qa_evaluations WHERE %s GROUP BY day ORDER BY day`, where), args...)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"summary": summary, "by_agent": orEmpty(byAgent), "by_band": orEmpty(byBand), "trend": orEmpty(trend),
		})
	}
}

func qaMy(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		ctx := r.Context()
		summary := map[string]any{}
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*)::int AS evaluations,
			       COALESCE(ROUND(AVG(total_score),1),0) AS avg_score,
			       COUNT(*) FILTER (WHERE passed)::int AS passed,
			       COUNT(*) FILTER (WHERE critical_error)::int AS critical_errors,
			       MAX(total_score) AS best_score
			FROM qa_evaluations WHERE agent_id=$1`, user.ID); len(rows) > 0 {
			summary = rows[0]
		}
		recent, _ := db.PGQuery(ctx, `
			SELECT id, call_id, call_direction, customer_name, total_score, rating_band, passed,
			       critical_error, strengths, improvements, coaching_notes, evaluator_name, created_at
			FROM qa_evaluations WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 20`, user.ID)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"summary": summary, "recent": orEmpty(recent)}) //nolint:errcheck
	}
}

func qaCoaching(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !qaEvaluator(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Forbidden")
			return
		}
		// Coaching items = evaluations that carry a coaching note, failed, or had a
		// critical error — i.e. those needing follow-up.
		status := qstr(r, "status")
		where := "(COALESCE(coaching_notes,'') <> '' OR NOT passed OR critical_error)"
		var args []any
		n := 1
		if status == "open" || status == "done" {
			where += fmt.Sprintf(" AND coaching_status = $%d", n)
			args = append(args, status)
			n++
		}
		rows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT id, agent_id, agent_name, evaluator_name, total_score, rating_band, passed,
			       critical_error, improvements, coaching_notes, coaching_status, created_at
			FROM qa_evaluations WHERE %s ORDER BY (coaching_status='done'), created_at DESC LIMIT 200`, where), args...)
		jsonRows(w, rows)
	}
}

func qaUpdateCoaching(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !qaEvaluator(core.UserFromCtx(r.Context())) {
			respondErr(w, 403, "Forbidden")
			return
		}
		id := chi.URLParam(r, "id")
		var b struct {
			Status        string  `json:"coaching_status"`
			CoachingNotes *string `json:"coaching_notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		st := strings.ToLower(b.Status)
		if st != "open" && st != "done" {
			st = "open"
		}
		if b.CoachingNotes != nil {
			db.PGExec(r.Context(), `UPDATE qa_evaluations SET coaching_status=$1, coaching_notes=$2, updated_at=NOW() WHERE id=$3`, st, *b.CoachingNotes, id) //nolint:errcheck
		} else {
			db.PGExec(r.Context(), `UPDATE qa_evaluations SET coaching_status=$1, updated_at=NOW() WHERE id=$2`, st, id) //nolint:errcheck
		}
		respond(w, map[string]any{"ok": true}, "qa")
	}
}

func orEmpty(rows []core.Row) []core.Row {
	if rows == nil {
		return []core.Row{}
	}
	return rows
}
