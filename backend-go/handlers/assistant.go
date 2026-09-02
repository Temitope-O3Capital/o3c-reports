package handlers

// assistant.go — the in-workspace AI assistant.
//
// Runs against a LOCAL Ollama server (127.0.0.1:11434) so that customer PII —
// PAN, BVN, phone numbers, call notes — never leaves the building. That privacy
// property, not cost, is the reason this is self-hosted.
//
// THE CENTRAL DESIGN RULE: the model is never the source of a figure.
//
// A 4B model asked "how many collections cases are overdue" will happily invent
// a confident number. So it is given no data in its prompt and is told it has
// none; to answer anything factual it must call one of the vetted tools in
// assistantTools(). Each tool is a fixed, reviewed Go function running a fixed
// query. The model chooses WHICH tool and with WHICH arguments — it never
// supplies SQL, and it never supplies numbers. Everything it states as fact came
// out of Postgres on this request.
//
// Every tool re-checks the caller's page permissions at execution time, not just
// at registration time, so the assistant can never become a way around the RBAC
// that gates the rest of the workspace. A collections agent asking about the
// recovery book gets told the data is not available to them, the same as if they
// had navigated to the page.
//
// Every turn — question, tool call, tool result, answer — is written to
// assistant_messages (migration 196). That table is the audit trail.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// ── configuration ───────────────────────────────────────────────────────────

// assistantMaxToolRounds bounds the tool loop. Two rounds is enough for
// "call a tool, read the result, answer", plus one for a follow-up lookup.
// Without a bound a confused model can ping-pong tool calls forever, and at
// ~7 tok/s that would hold the single inference slot for minutes.
const assistantMaxToolRounds = 3

// assistantHistoryTurns caps how much conversation is replayed to the model.
//
// This is a latency control, not a storage one. Prefill on this CPU-only box
// runs at roughly 32 tok/s, and chat re-processes the whole history every turn,
// so an unbounded transcript walks the time-to-first-word from ~10s to over a
// minute. Keeping the replayed window small keeps every turn roughly as fast as
// the first. The full transcript is still persisted and still shown in the UI —
// only what the MODEL sees is trimmed.
const assistantHistoryTurns = 8

// assistantQueueWait is how long a request will wait for the single inference
// slot before giving up. Ollama runs with OLLAMA_NUM_PARALLEL=1, so requests
// serialise; without a bound, ten people clicking at once means the tenth waits
// ten minutes behind a dead-looking spinner. Better to say "busy, try again".
const assistantQueueWait = 45 * time.Second

// assistantSlot is the single inference slot, mirroring OLLAMA_NUM_PARALLEL=1.
// Queueing here rather than inside Ollama lets us return a clean 429 with a
// useful message instead of leaving the HTTP request hanging.
var assistantSlot = make(chan struct{}, 1)

func assistantBaseURL() string {
	if v := strings.TrimSpace(os.Getenv("OLLAMA_URL")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "http://127.0.0.1:11434"
}

func assistantModel() string {
	if v := strings.TrimSpace(os.Getenv("ASSISTANT_MODEL")); v != "" {
		return v
	}
	// The INSTRUCT tag deliberately. Plain qwen3:4b is a hybrid thinking model:
	// it spends hundreds of tokens reasoning out loud before answering, which on
	// this hardware turned a 31-second answer into a 136-second truncated one.
	// think:false does not fix it — it only stops the reasoning being tagged.
	return "qwen3:4b-instruct"
}

// assistantThreads sets how many of the 8 vCPUs inference may use. It controls
// BOTH generation and prefill, and those scale very differently.
//
// Re-measured 2026-09-02 after the box went 6 vCPU/24 GiB -> 8 vCPU/64 GiB.
// Measure at a REALISTIC context: with a 31-token prompt generation reads 15.8
// tok/s, but the real preamble is ~1,850 tokens and attention grows with the KV
// cache, so the number that matters is the one on the right:
//
//	threads   prefill tok/s @1.8k ctx    generation tok/s @1.8k ctx
//	  6            52.4                       8.0
//	  7            60.5                       9.0
//	  8            65.1                       7.6-9.6 (noisy)
//
// Generation is flat from 6 to 8 — it is memory-bandwidth-bound and the cores
// are no longer the constraint. Prefill still scales, so threads mainly buy back
// the uncached paths: a cold model load, and the tool result read in on round 2.
//
// 7 takes 93% of peak prefill while leaving one vCPU for Postgres, the API and
// the OS. Going to 8 measured *worse* generation in one of three runs, which is
// the same starvation tail that made 6-of-6 unstable on the old box. Prefer the
// stable optimum; this is not the setting that decides whether the assistant
// feels fast — the KV prefix cache is (see assistantSystemPrompt).
func assistantThreads() int {
	if v := strings.TrimSpace(os.Getenv("ASSISTANT_THREADS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 32 {
			return n
		}
	}
	return 7
}

// assistantKeepAlive decides how long Ollama holds the model in RAM after a
// question. It costs ~3 GB resident on a box with little genuinely free memory,
// which is a real trade -- but the alternative is paying a 18-80s reload on the
// first question after any 5 minute lull, which is most questions in practice.
func assistantKeepAlive() string {
	if v := strings.TrimSpace(os.Getenv("ASSISTANT_KEEP_ALIVE")); v != "" {
		return v
	}
	return "4h"
}

// ── Ollama wire types ───────────────────────────────────────────────────────

type ollamaFunctionCall struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

type ollamaToolCall struct {
	Function ollamaFunctionCall `json:"function"`
}

type ollamaMessage struct {
	Role      string           `json:"role"`
	Content   string           `json:"content"`
	ToolCalls []ollamaToolCall `json:"tool_calls,omitempty"`
	ToolName  string           `json:"tool_name,omitempty"`
}

type ollamaChatRequest struct {
	Model    string          `json:"model"`
	Messages []ollamaMessage `json:"messages"`
	Tools    []any           `json:"tools,omitempty"`
	Stream   bool            `json:"stream"`
	Options  map[string]any  `json:"options,omitempty"`
	// KeepAlive pins the model in RAM between questions. Ollama defaults to 5
	// minutes, so in sporadic office use almost every question paid a cold
	// start: measured 18-80s to reload the 3 GB model, plus the loss of the KV
	// cache that makes the stable system+tools prefix nearly free to re-read.
	// A warm repeat of the same prompt took 0.3s against 108s cold.
	KeepAlive string `json:"keep_alive,omitempty"`
}

type ollamaChatResponse struct {
	Model           string        `json:"model"`
	Message         ollamaMessage `json:"message"`
	PromptEvalCount int           `json:"prompt_eval_count"`
	EvalCount       int           `json:"eval_count"`
	Error           string        `json:"error,omitempty"`
}

// ── tool registry ───────────────────────────────────────────────────────────

// assistantTool is one thing the assistant is allowed to do. Pages lists the
// page keys that grant access; an empty Pages means everyone (used only for
// things that expose no business data, like the clock).
type assistantTool struct {
	Name        string
	Description string
	Params      map[string]any
	Pages       []string
	Run         func(ctx context.Context, db *core.DB, user *core.Claims, args map[string]any) (any, error)
}

// argInt pulls an integer argument tolerantly. Small models emit numbers as
// JSON numbers, quoted strings, or floats depending on mood, so accept all three
// rather than failing a lookup over formatting.
func argInt(args map[string]any, key string, def, min, max int) int {
	v, ok := args[key]
	if !ok || v == nil {
		return def
	}
	n := def
	switch t := v.(type) {
	case float64:
		n = int(t)
	case int:
		n = t
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(t))
		if err != nil {
			return def
		}
		n = parsed
	default:
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

func argStr(args map[string]any, key string) string {
	if v, ok := args[key]; ok && v != nil {
		return strings.TrimSpace(fmt.Sprint(v))
	}
	return ""
}

// assistantCallEpisodeCTE is the collapsed-episode base every call tool reads
// from. It mirrors hdListCalls exactly, and that is the entire point: the
// assistant must never quote a different number from the Call Log page.
//
// Zoho writes one helpdesk_calls row per dialing ACTIVITY, not per conversation,
// so a single attempt lands as several rows and an unanswered redial can be a
// dozen. Rows for the same agent + number inside a 15-minute window are one
// episode, represented by the leg that actually connected (longest, or the
// recorded one), else the latest.
//
// This was measured, not assumed. Over 7 days the earlier naive version reported
// 15,366 calls and 6,190 connected, where the Call Log showed 4,613 and 1,387 --
// a 3.3x and 4.5x overcount, told to staff as fact. Connection status likewise
// comes from callConnectedExpr, the documented single source of truth, not from
// outcome='completed', which counts a 2-second dropped dial as a conversation.
//
// $1 is the day window. Callers append their own SELECT ... FROM base WHERE
// leg_rn = 1, and may use $2 onward for their own filters.
func assistantCallEpisodeCTE() string {
	np := normalizedPhoneExpr("hc.customer_phone")
	return fmt.Sprintf(`
		WITH base AS (
		  SELECT hc.*,
		         ROW_NUMBER() OVER (PARTITION BY
		           CASE WHEN %[1]s <> ''
		                THEN COALESCE(hc.agent_id,0)::text||'|'||%[1]s||'|'||floor(extract(epoch FROM hc.started_at)/900)::text
		                ELSE 'row:'||hc.id::text END
		           ORDER BY COALESCE(hc.duration_sec,0) DESC,
		                    (hc.recording_filename IS NOT NULL) DESC,
		                    hc.started_at DESC, hc.id DESC) AS leg_rn
		  FROM helpdesk_calls hc
		  -- A manually logged call merged onto the real Voice call is hidden (the
		  -- same conversation listed twice); voided calls are withdrawn.
		  WHERE hc.merged_into_call_id IS NULL AND hc.voided_at IS NULL
		    AND hc.created_at >= now() - make_interval(days => $1)
		)`, np)
}

func assistantTools() []assistantTool {
	return []assistantTool{
		{
			Name: "get_current_datetime",
			Description: "Returns the current date, time and weekday in Lagos. " +
				"Call this whenever the question involves today, yesterday, this week, or any relative date.",
			Params: map[string]any{"type": "object", "properties": map[string]any{}},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				// The model has no clock and will otherwise guess a date, usually
				// its training cutoff, and then reason confidently from it.
				loc, err := time.LoadLocation("Africa/Lagos")
				if err != nil {
					loc = time.UTC
				}
				now := time.Now().In(loc)
				return map[string]any{
					"date":       now.Format("2006-01-02"),
					"time":       now.Format("15:04"),
					"weekday":    now.Format("Monday"),
					"is_weekend": now.Weekday() == time.Saturday || now.Weekday() == time.Sunday,
					"timezone":   "Africa/Lagos",
				}, nil
			},
		},
		{
			Name: "get_collections_summary",
			Description: "Live totals for the collections book: how many cases are open, " +
				"the outstanding balance in naira, and the breakdown by case status.",
			Params: map[string]any{"type": "object", "properties": map[string]any{}},
			Pages:  []string{"collections"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				rows, err := db.PGQuery(ctx, `
					SELECT status,
					       COUNT(*)                                   AS cases,
					       ROUND(SUM(outstanding_kobo)/100.0, 2)      AS outstanding_ngn
					FROM collection_assignments
					GROUP BY status
					ORDER BY cases DESC`)
				if err != nil {
					return nil, err
				}
				// The grand totals are computed HERE, in SQL, and handed over ready
				// to quote. Asked to add up a per-status breakdown itself, the model
				// quoted the largest single row (984) as if it were the whole book
				// (1,280) — small models are unreliable at arithmetic, so never make
				// one do sums it can misread. Every tool that returns a breakdown
				// must also return the total.
				totals, err := db.PGQuery(ctx, `
					SELECT COUNT(*)                              AS total_cases,
					       ROUND(SUM(outstanding_kobo)/100.0, 2) AS total_outstanding_ngn
					FROM collection_assignments`)
				if err != nil {
					return nil, err
				}
				out := map[string]any{
					"by_status": rows,
					"note":      "Amounts are Nigerian naira. Use total_cases and total_outstanding_ngn for the whole book; do not add up the by_status rows yourself.",
				}
				if len(totals) > 0 {
					out["totals"] = totals[0]
				}
				return out, nil
			},
		},
		{
			Name: "get_recovery_summary",
			Description: "Live totals for the recovery book: case counts, outstanding and " +
				"recovered amounts in naira, broken down by status and legal stage.",
			Params: map[string]any{"type": "object", "properties": map[string]any{}},
			Pages:  []string{"recovery"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				rows, err := db.PGQuery(ctx, `
					SELECT status,
					       COUNT(*)                              AS cases,
					       ROUND(SUM(outstanding_kobo)/100.0, 2) AS outstanding_ngn,
					       ROUND(SUM(recovered_kobo)/100.0, 2)   AS recovered_ngn
					FROM recovery_cases
					GROUP BY status
					ORDER BY cases DESC`)
				if err != nil {
					return nil, err
				}
				// "How much is in recovery" must not include cases that have left it.
				// recovery.go counts open cases and live exposure with the filter
				// below; without it the assistant quotes the whole historical book -
				// closed, recovered and written-off cases included - as though it were
				// still outstanding. open_cases/in_recovery_ngn mirror recovery.go
				// exactly so the two agree.
				totals, err := db.PGQuery(ctx, `
					SELECT COUNT(*) FILTER (WHERE status NOT IN ('closed','recovered','written_off')) AS open_cases,
					       ROUND(COALESCE(SUM(GREATEST(outstanding_kobo - recovered_kobo, 0))
					             FILTER (WHERE status NOT IN ('closed','recovered','written_off')), 0)/100.0, 2) AS in_recovery_ngn,
					       COUNT(*)                              AS all_cases_ever,
					       ROUND(SUM(recovered_kobo)/100.0, 2)   AS total_recovered_ngn
					FROM recovery_cases`)
				if err != nil {
					return nil, err
				}
				out := map[string]any{
					"by_status": rows,
					"note":      "Amounts are naira. in_recovery_ngn and open_cases are the live recovery book; all_cases_ever includes closed, recovered and written-off cases. Never add up the by_status rows yourself.",
				}
				if len(totals) > 0 {
					out["totals"] = totals[0]
				}
				return out, nil
			},
		},
		{
			Name: "get_call_centre_stats",
			Description: "Daily call-centre volume for the last N days: total calls and how many " +
				"connected, per day, with the weekday for each date.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"days": map[string]any{"type": "integer", "description": "How many days back, 1 to 90. Default 7."},
				},
			},
			Pages: []string{"call_center"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				days := argInt(a, "days", 7, 1, 90)
				rows, err := db.PGQuery(ctx, assistantCallEpisodeCTE()+`
					SELECT to_char(created_at::date, 'YYYY-MM-DD') AS date,
					       to_char(created_at::date, 'Dy')         AS weekday,
					       COUNT(*)                                AS total_calls,
					       COUNT(*) FILTER (WHERE `+callConnectedExpr("")+`) AS connected
					FROM base WHERE leg_rn = 1
					GROUP BY 1, 2
					ORDER BY 1`, days)
				if err != nil {
					return nil, err
				}
				totals, err := db.PGQuery(ctx, assistantCallEpisodeCTE()+`
					SELECT COUNT(*)                                AS total_calls,
					       COUNT(*) FILTER (WHERE `+callConnectedExpr("")+`) AS total_connected
					FROM base WHERE leg_rn = 1`, days)
				if err != nil {
					return nil, err
				}
				out := map[string]any{
					"days":  days,
					"daily": rows,
					"note":  "The contact centre operates Monday to Friday. Near-zero volume on Sat/Sun is expected and is not an incident. Use the totals object for period totals; do not add up the daily rows yourself.",
				}
				if len(totals) > 0 {
					out["totals"] = totals[0]
				}
				return out, nil
			},
		},
		{
			Name: "get_agent_call_stats",
			Description: "Call activity per agent for the last N days: how many calls each agent " +
				"handled, how many connected, and total talk time. Use this for questions about " +
				"one person's or the team's call performance. Pass agent to narrow to one person " +
				"by name; leave it out for the whole team.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"days":  map[string]any{"type": "integer", "description": "How many days back, 1 to 90. Default 7."},
					"agent": map[string]any{"type": "string", "description": "Part of the agent's name, e.g. 'Ramat'. Omit for all agents."},
				},
			},
			Pages: []string{"call_center"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				days := argInt(a, "days", 7, 1, 90)
				agent := strings.TrimSpace(argStr(a, "agent"))
				rows, err := db.PGQuery(ctx, assistantCallEpisodeCTE()+`
					SELECT COALESCE(NULLIF(agent_name,''),'unassigned')     AS agent,
					       COUNT(*)                                         AS calls,
					       COUNT(*) FILTER (WHERE `+callConnectedExpr("")+`) AS connected,
					       ROUND(SUM(COALESCE(duration_sec,0))/60.0)         AS talk_minutes
					FROM base
					WHERE leg_rn = 1 AND ($2 = '' OR agent_name ILIKE '%' || $2 || '%')
					GROUP BY 1
					ORDER BY calls DESC
					LIMIT 50`, days, agent)
				if err != nil {
					return nil, err
				}
				if len(rows) == 0 {
					return map[string]any{
						"days":  days,
						"agent": agent,
						"note":  "No agent matched that name in this period. Check the spelling, or ask without a name to see the whole team.",
					}, nil
				}
				totals, err := db.PGQuery(ctx, assistantCallEpisodeCTE()+`
					SELECT COUNT(*)                                         AS total_calls,
					       COUNT(*) FILTER (WHERE `+callConnectedExpr("")+`) AS total_connected,
					       COUNT(DISTINCT agent_name)                        AS agents
					FROM base
					WHERE leg_rn = 1 AND ($2 = '' OR agent_name ILIKE '%' || $2 || '%')`, days, agent)
				if err != nil {
					return nil, err
				}
				out := map[string]any{
					"days":     days,
					"agent":    agent,
					"by_agent": rows,
					"note":     "One row per agent. Use the totals object for period totals; do not add up the rows yourself.",
				}
				if len(totals) > 0 {
					out["totals"] = totals[0]
				}
				return out, nil
			},
		},
		{
			Name: "get_ticket_stats",
			Description: "Helpdesk ticket counts for the last N days, grouped by status, " +
				"including how many breached SLA.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"days": map[string]any{"type": "integer", "description": "How many days back, 1 to 180. Default 30."},
				},
			},
			Pages: []string{"care"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				days := argInt(a, "days", 30, 1, 180)
				rows, err := db.PGQuery(ctx, `
					SELECT status,
					       COUNT(*)                                AS tickets,
					       COUNT(*) FILTER (WHERE sla_breached)     AS sla_breached
					FROM helpdesk_tickets
					WHERE deleted_at IS NULL AND merged_into_ticket_id IS NULL
					  AND created_at >= now() - make_interval(days => $1)
					GROUP BY status
					ORDER BY tickets DESC`, days)
				if err != nil {
					return nil, err
				}
				totals, err := db.PGQuery(ctx, `
					SELECT COUNT(*)                            AS total_tickets,
					       COUNT(*) FILTER (WHERE sla_breached) AS total_sla_breached
					FROM helpdesk_tickets
					WHERE deleted_at IS NULL AND merged_into_ticket_id IS NULL
					  AND created_at >= now() - make_interval(days => $1)`, days)
				if err != nil {
					return nil, err
				}
				out := map[string]any{
					"days":      days,
					"by_status": rows,
					"note":      "Use the totals object for overall counts; do not add up the by_status rows yourself.",
				}
				if len(totals) > 0 {
					out["totals"] = totals[0]
				}
				return out, nil
			},
		},
		{
			Name: "get_card_portfolio_summary",
			Description: "Portfolio-level totals for the card book: number of accounts, total " +
				"outstanding balance in naira, and delinquency counts by days overdue.",
			Params: map[string]any{"type": "object", "properties": map[string]any{}},
			Pages:  []string{"cards"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				// NOTE: current_dr_balance on the card book is already in NAIRA, not
				// kobo, unlike the collections and recovery tables. Dividing by 100
				// here would understate the book by two orders of magnitude.
				//
				// The delinquency buckets require a POSITIVE balance as well as a
				// days_overdue. days_overdue alone is a stale field: settled accounts
				// keep the last value they had, so counting on it inflates the book by
				// more than 4x -- 4,692 "delinquent" against 1,123 real, and 4,453 at
				// 90+ days against 977. This tool fed a board-pack paragraph claiming
				// 21.5% of the portfolio was 90+ days overdue when the truth was 4.7%.
				// The rule below is the one call_center_outbound.go already uses to
				// build genuine collections targets; keep them in step.
				//
				// accounts and outstanding_ngn stay unfiltered on purpose: they match
				// cards.go's total_issued and reports_business.go's balance totals, so
				// the assistant agrees with the Cards page and the BI reports.
				//
				// The percentages are computed HERE rather than left to the model. It
				// will reach for a share-of-book figure when writing any summary, and
				// it cannot be trusted to divide.
				// Keep this result LEAN. Adding two more balance columns and a longer
				// note measurably made the answers worse: the model reported dpd_1_30
				// as 1,370 when the tool said 137, mixed delinquent exposure up with
				// the wrong denominator, and quoted a sentence of this note back as if
				// it were analysis. A 4B model degrades as the field count rises, so
				// every column here has to earn its place.
				rows, err := db.PGQuery(ctx, `
					SELECT COUNT(*)                          AS accounts,
					       ROUND(SUM(current_dr_balance), 2) AS outstanding_ngn,
					       COUNT(*) FILTER (WHERE owing)                                   AS delinquent_accounts,
					       COUNT(*) FILTER (WHERE owing AND days_overdue <= 30)            AS dpd_1_30,
					       COUNT(*) FILTER (WHERE owing AND days_overdue BETWEEN 31 AND 90) AS dpd_31_90,
					       COUNT(*) FILTER (WHERE owing AND days_overdue > 90)             AS dpd_90_plus,
					       ROUND(100.0 * COUNT(*) FILTER (WHERE owing) / NULLIF(COUNT(*), 0), 1)            AS delinquent_pct_of_book,
					       ROUND(100.0 * COUNT(*) FILTER (WHERE owing AND days_overdue > 90) / NULLIF(COUNT(*), 0), 1) AS dpd_90_plus_pct_of_book
					FROM (
					  SELECT current_dr_balance, days_overdue,
					         (days_overdue > 0 AND COALESCE(current_dr_balance,0) > 0) AS owing
					  FROM app.accounts
					) a`)
				if err != nil {
					return nil, err
				}
				out := map[string]any{"note": "Amounts are naira. Delinquent counts cover accounts that are overdue and still owing. Percentages are already worked out; quote them as given."}
				if len(rows) > 0 {
					out["summary"] = rows[0]
				}
				return out, nil
			},
		},
		{
			Name: "get_lead_ownership",
			Description: "Who is holding which leads: how many leads each sales officer owns, " +
				"and how many they are actively working. Use for questions about a named " +
				"officer's leads, workload, or how leads are distributed across the team.",
			Params: map[string]any{"type": "object", "properties": map[string]any{}},
			Pages:  []string{"sales"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				// Same scope as get_sales_pipeline and the Sales page: an officer sees
				// their own book, a head sees their team, executives see everything.
				// Without this the assistant would happily tell one officer how many
				// leads each of their colleagues is sitting on.
				r, err := http.NewRequestWithContext(ctx, http.MethodGet, "/", nil)
				if err != nil {
					return nil, err
				}
				where := []string{"c.lead_stage <> 'converted'", "COALESCE(c.already_customer, false) = false"}
				args := []any{}
				n := 1
				where, args, n = applyLeadScope(r, db, u, where, args, n)
				cond := strings.Join(where, " AND ")

				rows, err := db.PGQuery(ctx, `
					SELECT COALESCE(NULLIF(usr.full_name,''),'unassigned pool') AS owner,
					       COUNT(*)                                             AS leads_owned,
					       COUNT(*) FILTER (WHERE c.lead_stage IN ('contacted','qualified')) AS working_now
					FROM crm_contacts c
					LEFT JOIN o3c_users usr ON usr.id = c.lead_owner_id AND usr.deleted_at IS NULL
					WHERE `+cond+`
					GROUP BY 1 ORDER BY leads_owned DESC LIMIT 30`, args...)
				if err != nil {
					return nil, err
				}
				return map[string]any{
					"by_owner": rows,
					"note": "Leads with no owner appear as 'unassigned pool'. leads_owned is the officer's whole book; " +
						"working_now is only those at contacted or qualified stage, which is always a smaller number. " +
						"Do not describe leads_owned as being worked. Quote the rows as given; never add them up yourself.",
				}, nil
			},
		},
		{
			Name: "get_sales_pipeline",
			Description: "Sales lead pipeline: how many leads sit in each stage, scoped to what " +
				"this user is allowed to see. Use for questions about leads, prospects or the sales funnel.",
			Params: map[string]any{"type": "object", "properties": map[string]any{}},
			Pages:  []string{"sales"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				// This used to read call_center_leads.status and call the result the
				// "sales pipeline". Wrong table and wrong vocabulary: the Sales page
				// reads crm_contacts.lead_stage, the two books are ~99% disjoint, and
				// the counts differ by more than 3x (6,656 against 21,363). It also
				// ignored owner scope, so an officer asking the assistant saw the whole
				// firm's pipeline while the Sales page showed only their own.
				//
				// Both are fixed by reusing the module's own predicates rather than
				// re-deriving them: same lead_stage filter, same already_customer
				// exclusion, same applyLeadScope. A bare request carries ctx into
				// teamHeadOfficerIDs; with no query string, owner_id reads as empty,
				// which is the Sales page's own default.
				r, err := http.NewRequestWithContext(ctx, http.MethodGet, "/", nil)
				if err != nil {
					return nil, err
				}
				where := []string{"c.lead_stage <> 'converted'", "COALESCE(c.already_customer, false) = false"}
				args := []any{}
				n := 1
				where, args, n = applyLeadScope(r, db, u, where, args, n)
				cond := strings.Join(where, " AND ")

				rows, err := db.PGQuery(ctx, `
					SELECT COALESCE(NULLIF(c.lead_stage,''),'unset') AS stage, COUNT(*) AS leads
					FROM crm_contacts c WHERE `+cond+`
					GROUP BY 1 ORDER BY leads DESC`, args...)
				if err != nil {
					return nil, err
				}
				totals, err := db.PGQuery(ctx, `
					SELECT COUNT(*) AS total_leads FROM crm_contacts c WHERE `+cond, args...)
				if err != nil {
					return nil, err
				}
				out := map[string]any{
					"by_stage": rows,
					"note":     "Converted leads and contacts who are already customers are excluded, matching the Sales page. Use total_leads for the overall count; never add up the by_stage rows yourself.",
				}
				if len(totals) > 0 {
					out["totals"] = totals[0]
				}
				return out, nil
			},
		},
		{
			Name: "get_revenue_summary",
			Description: "Revenue actually earned over the last N days, split by income category " +
				"(interest, fees) and product. Use for questions about revenue, income or earnings.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"days": map[string]any{"type": "integer", "description": "How many days back, 1 to 365. Default 30."},
				},
			},
			Pages: []string{"income", "finance", "executive"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				days := argInt(a, "days", 30, 1, 365)
				// The $1::int cast is load-bearing. "current_date - $1" is ambiguous:
				// Postgres can resolve the minus as date-date->integer and then infers $1 as a
				// date, so the comparison becomes "date >= integer" and the tool errors out on
				// every call. This tool and get_transaction_volume were both dead because of it.
				// income_daily is already in NAIRA (amount_ngn), unlike the cbs_*
				// and recon_* tables which are kobo. Do not divide by 100 here.
				rows, err := db.PGQuery(ctx, `
					SELECT category, product_name,
					       SUM(txn_count)          AS transactions,
					       ROUND(SUM(amount_ngn),2) AS amount_ngn
					FROM income_daily
					WHERE income_date >= current_date - $1::int
					GROUP BY 1,2 ORDER BY 4 DESC LIMIT 12`, days)
				if err != nil {
					return nil, err
				}
				totals, err := db.PGQuery(ctx, `
					SELECT SUM(txn_count)           AS total_transactions,
					       ROUND(SUM(amount_ngn),2) AS total_revenue_ngn
					FROM income_daily WHERE income_date >= current_date - $1::int`, days)
				if err != nil {
					return nil, err
				}
				out := map[string]any{"days": days, "by_category": rows,
					"note": "Amounts are naira. by_category lists only the 12 largest category/product pairs by amount; smaller ones are omitted, so say so if asked about one that is not listed. Use the totals object for the period total; do not add up the rows yourself."}
				if len(totals) > 0 {
					out["totals"] = totals[0]
				}
				return out, nil
			},
		},
		{
			Name: "get_loan_portfolio_summary",
			Description: "The loan book: how many loans in each status and the outstanding " +
				"principal, interest and fees in naira.",
			Params: map[string]any{"type": "object", "properties": map[string]any{}},
			Pages:  []string{"loans", "credit_portfolio", "active_loan_book", "executive"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				rows, err := db.PGQuery(ctx, `
					SELECT status, COUNT(*) AS loans,
					       ROUND(SUM(outstanding_principal_kobo)/100.0,2) AS outstanding_principal_ngn,
					       ROUND(SUM(outstanding_interest_kobo)/100.0,2)  AS outstanding_interest_ngn
					FROM cbs_loans GROUP BY 1 ORDER BY 2 DESC`)
				if err != nil {
					return nil, err
				}
				totals, err := db.PGQuery(ctx, `
					SELECT COUNT(*) AS total_loans,
					       ROUND(SUM(outstanding_principal_kobo)/100.0,2) AS total_principal_ngn,
					       ROUND(SUM(outstanding_interest_kobo)/100.0,2)  AS total_interest_ngn
					FROM cbs_loans`)
				if err != nil {
					return nil, err
				}
				out := map[string]any{"by_status": rows,
					"note": "The loan book is new and small. Use the totals object; do not add up the rows yourself."}
				if len(totals) > 0 {
					out["totals"] = totals[0]
				}
				return out, nil
			},
		},
		{
			Name: "get_fixed_deposit_summary",
			Description: "The fixed-deposit book: how many deposits in each status, the principal " +
				"held and the interest accrued, in naira.",
			Params: map[string]any{"type": "object", "properties": map[string]any{}},
			Pages:  []string{"fixed_deposit", "finance", "executive"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				rows, err := db.PGQuery(ctx, `
					SELECT status, COUNT(*) AS deposits,
					       ROUND(SUM(principal_kobo)/100.0,2)         AS principal_ngn,
					       ROUND(SUM(accrued_interest_kobo)/100.0,2)  AS accrued_interest_ngn
					FROM cbs_fixed_deposits GROUP BY 1 ORDER BY 2 DESC`)
				if err != nil {
					return nil, err
				}
				totals, err := db.PGQuery(ctx, `
					SELECT COUNT(*) AS total_deposits,
					       ROUND(SUM(principal_kobo)/100.0,2)        AS total_principal_ngn,
					       ROUND(SUM(accrued_interest_kobo)/100.0,2) AS total_accrued_interest_ngn
					FROM cbs_fixed_deposits`)
				if err != nil {
					return nil, err
				}
				out := map[string]any{"by_status": rows,
					"note": "Amounts converted from kobo to naira. Use the totals object; do not add up the rows yourself."}
				if len(totals) > 0 {
					out["totals"] = totals[0]
				}
				return out, nil
			},
		},
		{
			Name: "get_transaction_volume",
			Description: "Daily customer transaction activity for the last N days: how many " +
				"transactions, money in and money out, in naira.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"days": map[string]any{"type": "integer", "description": "How many days back, 1 to 90. Default 7."},
				},
			},
			Pages: []string{"cards", "executive", "kpi_dashboard", "finance"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				days := argInt(a, "days", 7, 1, 90)
				// See the note on get_revenue_summary: the $1::int casts below are required,
				// not decoration.
				// Debit and credit are reported SEPARATELY on purpose. The ledger stores
				// credits as negatives, so a single SUM(amount) returns a net figure that
				// reads as "we did negative business" — the model would then repeat that as
				// fact. Both columns are fully populated.
				//
				// Beyond a month, bucket by week. One row per day is fine for 7 days,
				// but a 90-day question returns 90 rows — roughly 3,700 tokens, which
				// on this CPU is over a minute of prefill before the model writes a
				// word. The totals are exact either way; only the shape of the series
				// changes, and the note tells the model which it is looking at.
				grain, label := "day", "daily"
				if days > 31 {
					grain, label = "week", "weekly"
				}
				rows, err := db.PGQuery(ctx, `
					SELECT to_char(date_trunc($2, txn_date),'YYYY-MM-DD') AS period,
					       COUNT(*)                                AS transactions,
					       ROUND(SUM(COALESCE(amount_credit,0)),2) AS money_in_ngn,
					       ROUND(SUM(COALESCE(amount_debit,0)),2)  AS money_out_ngn
					FROM app.transactions
					WHERE txn_date >= current_date - $1::int
					GROUP BY 1 ORDER BY 1`, days, grain)
				if err != nil {
					return nil, err
				}
				// bad_credit_rows detects a live data-quality fault rather than a code
				// bug. app.transactions carries TWO sign conventions in amount_credit:
				// the ~1M-row baseline import stores credits as negatives, while the
				// feed loader (txnfeed.go) writes them as positive magnitudes. Summing
				// across both nets one against the other, which is why a 90-day window
				// currently reports money in as MINUS NGN 101m against NGN 752m of
				// actual credit magnitude.
				//
				// finance.go and bi.go sum this column exactly the same way, so the
				// figure is not changed here — diverging would make the assistant
				// contradict the Finance page, which is a worse failure. Instead the
				// model is told the inflow is unreliable so it caveats it rather than
				// stating a negative inflow as fact. The real fix is to settle on one
				// convention and migrate the baseline rows.
				totals, err := db.PGQuery(ctx, `
					SELECT COUNT(*)                                AS total_transactions,
					       ROUND(SUM(COALESCE(amount_credit,0)),2) AS total_money_in_ngn,
					       ROUND(SUM(COALESCE(amount_debit,0)),2)  AS total_money_out_ngn,
					       COUNT(*) FILTER (WHERE amount_credit < 0) AS bad_credit_rows
					FROM app.transactions WHERE txn_date >= current_date - $1::int`, days)
				if err != nil {
					return nil, err
				}
				note := "Amounts are naira. Each row covers one " + grain +
					", from its period date. Money in and money out are separate figures, not a net. " +
					"Use totals; never add up rows yourself."
				if len(totals) > 0 {
					if n, _ := strconv.Atoi(fmt.Sprint(totals[0]["bad_credit_rows"])); n > 0 {
						delete(totals[0], "bad_credit_rows")
						note += " DATA WARNING: money-in figures for this period are unreliable because " +
							"some credit rows are recorded with the wrong sign. Report money out and the " +
							"transaction count normally, but say the money-in figure cannot be trusted " +
							"and should be checked with Finance. Never present a negative money-in as a real figure."
					} else {
						delete(totals[0], "bad_credit_rows")
					}
				}
				out := map[string]any{"days": days, "granularity": label, "series": rows, "note": note}
				if len(totals) > 0 {
					out["totals"] = totals[0]
				}
				return out, nil
			},
		},
		{
			Name: "get_settlement_exceptions",
			Description: "Reconciliation exceptions: settlement or payment records that could not " +
				"be matched, grouped by status and reason, with the value at stake in naira.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"days": map[string]any{"type": "integer", "description": "How many days back, 1 to 365. Default 30."},
				},
			},
			Pages: []string{"reconciliation", "payments", "finance"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				days := argInt(a, "days", 30, 1, 365)
				rows, err := db.PGQuery(ctx, `
					SELECT status, reason, COUNT(*) AS exceptions,
					       ROUND(SUM(amount_kobo)/100.0,2) AS amount_ngn
					FROM recon_exceptions
					WHERE created_at >= now() - make_interval(days => $1)
					GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`, days)
				if err != nil {
					return nil, err
				}
				totals, err := db.PGQuery(ctx, `
					SELECT COUNT(*)                                    AS total_exceptions,
					       COUNT(*) FILTER (WHERE status = 'open')     AS open_exceptions,
					       ROUND(SUM(amount_kobo)/100.0,2)             AS total_amount_ngn
					FROM recon_exceptions WHERE created_at >= now() - make_interval(days => $1)`, days)

				if err != nil {
					return nil, err
				}
				out := map[string]any{"days": days, "by_status": rows,
					"note": "Amounts converted from kobo to naira. Use the totals object; do not add up the rows yourself."}
				if len(totals) > 0 {
					out["totals"] = totals[0]
				}
				return out, nil
			},
		},
		{
			Name: "find_staff",
			Description: "Look up a colleague in the staff directory by name, to find out who " +
				"someone is, what they do, or which department or office they are in. Use this " +
				"whenever a question names a person who is not a customer, such as 'who is Esther'.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name": map[string]any{"type": "string", "description": "Full or partial name of the colleague."},
				},
				"required": []string{"name"},
			},
			// No page key: every member of staff may look up a colleague, exactly as
			// they can in the people directory. Only non-sensitive columns are
			// selected -- never the password hash, MFA secret or SIP credentials that
			// also live on this table.
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				name := argStr(a, "name")
				if name == "" {
					return nil, fmt.Errorf("a name is required")
				}
				rows, err := db.PGQuery(ctx, `
					SELECT full_name, role, department, office_location,
					       CASE WHEN is_active THEN 'active' ELSE 'inactive' END AS account_status
					FROM o3c_users
					WHERE deleted_at IS NULL
					  AND (full_name ILIKE '%' || $1 || '%'
					       OR first_name ILIKE '%' || $1 || '%'
					       OR last_name  ILIKE '%' || $1 || '%')
					ORDER BY is_active DESC, full_name
					LIMIT 8`, name)
				if err != nil {
					return nil, err
				}
				return map[string]any{"matches": rows, "count": len(rows),
					"note": "These are colleagues, not customers. If nobody matched, say so plainly."}, nil
			},
		},
		{
			Name: "get_customer_transactions",
			Description: "How much a named customer transacted over a period: how many " +
				"transactions, money in and money out. Accepts a name or a CIF. Use for " +
				"questions like 'how much did X transact last month'.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"customer": map[string]any{"type": "string", "description": "Customer name or CIF."},
					"days":     map[string]any{"type": "integer", "description": "How many days back, 1 to 365. Default 30."},
				},
				"required": []string{"customer"},
			},
			Pages: []string{"customer360"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				who := argStr(a, "customer")
				if who == "" {
					return nil, fmt.Errorf("a customer name or CIF is required")
				}
				days := argInt(a, "days", 30, 1, 365)

				// Resolve to a PERSON first, then to all of that person's cards.
				//
				// Keying straight off the argument was the bug. A CIF identifies a
				// card, not a person: the model searches for a customer, gets one CIF
				// back and passes it here. Abimbola Pinheiro holds 21 cards and made
				// 158 transactions in the last 30 days, but keyed on the single CIF the
				// model happened to pick this returned 0, and the assistant reported
				// "no transactions" as fact.
				people, err := db.PGQuery(ctx, `
					SELECT DISTINCT upper(full_name) AS full_name FROM app.customers
					WHERE cif = $1 OR full_name ILIKE '%' || $1 || '%'
					ORDER BY 1 LIMIT 6`, who)
				if err != nil {
					return nil, err
				}
				if len(people) == 0 {
					return map[string]any{"matched": 0,
						"note": "No customer matched that name or CIF. Say so plainly; do not guess."}, nil
				}
				// More than one person matches: do NOT pick one. Guessing here silently
				// answers about the wrong customer, which is worse than not answering.
				if len(people) > 1 {
					names := make([]string, 0, len(people))
					for _, p := range people {
						names = append(names, fmt.Sprint(p["full_name"]))
					}
					return map[string]any{"matched": len(people), "candidates": names,
						"note": "Several different customers match. Do not answer with figures. " +
							"List these names and ask which one is meant."}, nil
				}
				name := fmt.Sprint(people[0]["full_name"])

				cifs, err := db.PGQuery(ctx, `
					SELECT cif FROM app.customers WHERE upper(full_name) = $1 ORDER BY cif LIMIT 500`, name)
				if err != nil {
					return nil, err
				}
				// Built as an IN-list rather than ANY(): this codebase has no array
				// parameter helper, and business_dev.go already does it this way.
				ph := make([]string, len(cifs))
				args := make([]any, 0, len(cifs)+1)
				for i, r := range cifs {
					ph[i] = fmt.Sprintf("$%d", i+1)
					args = append(args, fmt.Sprint(r["cif"]))
				}
				args = append(args, days)
				totals, err := db.PGQuery(ctx, fmt.Sprintf(`
					SELECT COUNT(*)                                AS transactions,
					       ROUND(SUM(COALESCE(amount_credit,0)),2) AS money_in_ngn,
					       ROUND(SUM(COALESCE(amount_debit,0)),2)  AS money_out_ngn,
					       MAX(txn_date)::text                     AS last_transaction_date
					FROM app.transactions
					WHERE cif IN (%s) AND txn_date >= current_date - $%d::int`,
					strings.Join(ph, ","), len(cifs)+1), args...)
				if err != nil {
					return nil, err
				}
				out := map[string]any{
					"customer":   name,
					"cards_held": len(cifs),
					"days":       days,
					"note": "Amounts are naira. A CIF is a card, not a person, so these figures cover every " +
						"card this customer holds. Money in and money out are separate figures, not a net.",
				}
				if len(totals) > 0 {
					out["totals"] = totals[0]
				}
				return out, nil
			},
		},
		{
			Name: "search_customers",
			Description: "Find customers by name, phone number or CIF. Returns at most a " +
				"handful of matches. Card numbers and BVN are masked.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{"type": "string", "description": "Name, phone number or CIF to search for."},
					"limit": map[string]any{"type": "integer", "description": "Max results, 1 to 10. Default 5."},
				},
				"required": []string{"query"},
			},
			Pages: []string{"customer360"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				q := argStr(a, "query")
				if q == "" {
					return nil, fmt.Errorf("a search term is required")
				}
				limit := argInt(a, "limit", 5, 1, 10)
				// BVN masked for the same reason exports mask it: the shape stays
				// useful for identification, the value is useless if it leaks.
				rows, err := db.PGQuery(ctx, `
					SELECT c.cif,
					       c.full_name,
					       c.phone,
					       c.city,
					       c.state,
					       c.account_status,
					       CASE WHEN NULLIF(c.bvn,'') IS NULL THEN NULL
					            ELSE '*******' || RIGHT(c.bvn, 4) END AS bvn_masked
					FROM app.customers c
					WHERE c.cif = $1
					   OR c.full_name ILIKE '%' || $1 || '%'
					   OR regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g')
					      LIKE '%' || RIGHT(regexp_replace($1, '[^0-9]', '', 'g'), 10) || '%'
					      AND length(regexp_replace($1, '[^0-9]', '', 'g')) >= 7
					ORDER BY c.full_name
					LIMIT $2`, q, limit)
				if err != nil {
					return nil, err
				}
				return map[string]any{"matches": rows, "count": len(rows)}, nil
			},
		},
		{
			Name: "get_customer_overview",
			Description: "Everything on file for one customer, by CIF: identity, their card " +
				"accounts with balances, and recent ticket and call counts. Card numbers masked.",
			Params: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"cif": map[string]any{"type": "string", "description": "The customer's CIF number."},
				},
				"required": []string{"cif"},
			},
			Pages: []string{"customer360"},
			Run: func(ctx context.Context, db *core.DB, u *core.Claims, a map[string]any) (any, error) {
				cif := argStr(a, "cif")
				if cif == "" {
					return nil, fmt.Errorf("a cif is required")
				}
				cust, err := db.PGQuery(ctx, `
					SELECT cif, full_name, phone, email, city, state, account_status
					FROM app.customers WHERE cif = $1 LIMIT 1`, cif)
				if err != nil {
					return nil, err
				}
				if len(cust) == 0 {
					return map[string]any{"found": false, "cif": cif}, nil
				}
				accts, err := db.PGQuery(ctx, `
					SELECT a.product_name,
					       CASE WHEN NULLIF(a.card_pan,'') IS NULL THEN NULL
					            ELSE '****' || RIGHT(a.card_pan, 4) END AS card_masked,
					       a.current_dr_balance AS balance_ngn,
					       a.days_overdue,
					       a.status
					FROM app.accounts a WHERE a.cif = $1 ORDER BY a.opened_date DESC LIMIT 10`, cif)
				if err != nil {
					return nil, err
				}
				act, err := db.PGQuery(ctx, `
					SELECT (SELECT COUNT(*) FROM helpdesk_tickets WHERE customer_cif = $1 AND deleted_at IS NULL AND merged_into_ticket_id IS NULL) AS tickets_total,
					       (SELECT COUNT(*) FROM helpdesk_tickets WHERE customer_cif = $1 AND status = 'open' AND deleted_at IS NULL AND merged_into_ticket_id IS NULL) AS tickets_open,
					       (SELECT COUNT(*) FROM helpdesk_calls   WHERE customer_cif = $1 AND voided_at IS NULL) AS calls_total`, cif)
				if err != nil {
					return nil, err
				}
				out := map[string]any{"found": true, "customer": cust[0], "accounts": accts}
				if len(act) > 0 {
					out["activity"] = act[0]
				}
				return out, nil
			},
		},
	}
}

// userCanUseTool re-checks page access at execution time. Registration-time
// filtering alone is not enough: a tool name could arrive from a replayed or
// hand-crafted request, and the assistant must never be a hole in the RBAC that
// gates every other route.
func userCanUseTool(user *core.Claims, t assistantTool) bool {
	if len(t.Pages) == 0 {
		return true
	}
	if user == nil {
		return false
	}
	if user.Role == "admin" {
		return true
	}
	allowed := make(map[string]bool)
	for _, role := range user.AllRoles() {
		for _, p := range core.RolePages[role] {
			allowed[p] = true
		}
	}
	for _, p := range user.Pages {
		allowed[p] = true
	}
	for _, p := range t.Pages {
		if allowed[p] {
			return true
		}
	}
	return false
}

// toolsForUser builds the tool list advertised to the model, filtered to what
// this caller may actually see. Tools the user cannot use are not described at
// all — offering them and then refusing produces a worse experience than the
// model simply not knowing they exist.
func toolsForUser(user *core.Claims) ([]any, map[string]assistantTool) {
	wire := make([]any, 0, 8)
	byName := make(map[string]assistantTool, 8)
	for _, t := range assistantTools() {
		if !userCanUseTool(user, t) {
			continue
		}
		byName[t.Name] = t
		wire = append(wire, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"parameters":  t.Params,
			},
		})
	}
	return wire, byName
}

// ── system prompt ───────────────────────────────────────────────────────────

// assistantSystemPrompt builds the FIXED half of the preamble. Nothing written
// here may vary between users or between days.
//
// The reason is the KV prefix cache. The qwen3 chat template renders the system
// message BEFORE the tool schemas, so the first byte that differs from the
// cached prompt throws away everything after it — including all ~1,750 tokens of
// tool definitions. Measured on this box: 28s to re-prefill that preamble versus
// 0.12s when it is reused. Who is asking and what today's date is therefore live
// in assistantTurnContext(), which rides on the user's own message, after the
// tools, where changing it costs a few tokens instead of the whole turn.
func assistantSystemPrompt(toolNames []string) string {
	var b strings.Builder
	b.WriteString("You are the O3 Capital workspace assistant, helping staff at a Nigerian card-issuing bank.\n\n")
	b.WriteString("HOW YOU WORK:\n")
	b.WriteString("- You do NOT know any live figures. You have no memory of balances, counts or customer records.\n")
	b.WriteString("- To answer anything factual you MUST call a tool. Never guess, estimate or recall a number.\n")
	b.WriteString("- State figures exactly as the tool returned them. Do not round or adjust them.\n")
	b.WriteString("- If no tool can answer the question, say plainly that you cannot look that up.\n")
	// "I cannot look up that information" was being used as a first resort, not a
	// last one. Real examples that failed while the tools to answer them existed:
	// "Who is Esther?" (find_staff), "How much transaction did Abimbola Pinh do
	// last month?" (get_customer_transactions). The model saw an unfamiliar name
	// and gave up instead of searching for it.
	b.WriteString("- Before saying you cannot look something up, check whether a tool would find it. A question about a PERSON almost always can be: use find_staff for a colleague and search_customers or get_customer_transactions for a customer. Try the search first; only report that you could not find them after a tool has come back empty.\n")
	b.WriteString("- Tools can be used one after another in the same reply. If you need a customer's CIF, search for them first and then use the result. Do not stop halfway and ask the user for the CIF.\n")
	b.WriteString("- A name you do not recognise is a reason to search, never a reason to refuse.\n")
	b.WriteString("- If a tool reports the data is not available to this user, say so; do not speculate about the values.\n")
	// Multi-turn is where this model breaks. Once its own earlier answer sits in
	// the context carrying figures, it reads that as "I have data" and stops
	// calling tools: asked to compare the collections book with recovery, it
	// invented 1,032 cases and NGN 1,892,345,678.21 out of nothing, then a
	// different count two turns later. The rules below are aimed squarely at that.
	b.WriteString("- Figures you gave earlier in this conversation came from tools, NOT from your own knowledge. You still know nothing.\n")
	b.WriteString("- For EVERY new figure — including a follow-up, a comparison, or a 'what about X' — you MUST call the tool again. Never reuse, adjust or extrapolate an earlier number to answer a new question.\n")
	b.WriteString("- Never compare two things unless a tool has returned data for BOTH of them in this same reply. If you can only get one side, give that side and say you could not look up the other.\n\n")
	// Writing prose is where this model stops being careful. Asked for a
	// two-paragraph board summary of the card portfolio it produced accurate
	// figures and then invented a whole second paragraph: "the delinquency rate
	// is consistent with recent trends", "remains within the bank's acceptable
	// risk threshold", "no further action is required at this time". No tool
	// returned a trend, a threshold, or a recommendation. Fabricated numbers are
	// caught by the rules above; fabricated JUDGEMENT reads as authoritative and
	// would have gone into a board pack unchallenged.
	b.WriteString("- Write only what the tools returned. Do NOT add assessments, trends, risk ratings, thresholds, benchmarks, causes or recommendations of your own. You have no history to compare against and no view on what is acceptable.\n")
	b.WriteString("- Never say a figure is normal, improving, worsening, in line with trend, within appetite, or that no action is needed. If someone asks for that judgement, give them the figures and say the interpretation is theirs to make.\n")
	b.WriteString("- Do not explain WHY a number is what it is unless a tool told you. A quiet day is not evidence of an outage, a holiday, or a system fault.\n")
	b.WriteString("- Never calculate. No percentages, shares, averages, growth rates, differences or totals of your own. If a figure you want is not in the tool output, say it is not available rather than working it out.\n\n")

	b.WriteString("BUSINESS CONTEXT:\n")
	b.WriteString("- All amounts are Nigerian naira (NGN) unless a tool says otherwise.\n")
	b.WriteString("- The contact centre operates Monday to Friday. Near-zero call volume on Saturday and Sunday, or on public holidays, is EXPECTED and is never an incident. Only treat a weekday as anomalous.\n")
	b.WriteString("- A CIF identifies a card, not a person: one person can hold several CIFs.\n\n")

	b.WriteString("STYLE:\n")
	b.WriteString("- Be brief and concrete. Lead with the answer, then context.\n")
	b.WriteString("- Plain text only. No markdown, no bold, no bullet symbols other than a simple hyphen.\n")
	b.WriteString("- You assist and draft; you never approve, authorise or decide anything. For any money movement, write-off or approval, tell the user to use the proper workflow.\n")

	if len(toolNames) > 0 {
		fmt.Fprintf(&b, "\nTools available to this user: %s.\n", strings.Join(toolNames, ", "))
	}
	return b.String()
}

// assistantTurnContext carries the VOLATILE facts — who is asking, and what day
// it is — into the user turn. That sits after the tool block, so a change of
// staff member or a midnight rollover costs a handful of tokens of prefill
// rather than invalidating the whole cached preamble. Keep it out of the system
// message; see the note on assistantSystemPrompt.
func assistantTurnContext(user *core.Claims) string {
	loc, err := time.LoadLocation("Africa/Lagos")
	if err != nil {
		loc = time.UTC
	}
	now := time.Now().In(loc)

	name, role := "a colleague", "staff"
	if user != nil {
		if user.FullName != "" {
			name = user.FullName
		}
		if user.Role != "" {
			role = user.Role
		}
	}
	return fmt.Sprintf("(You are speaking with %s, role: %s. Today is %s, %s.)\n\n",
		name, role, now.Format("Monday"), now.Format("2 January 2006"))
}

// ── Ollama call ─────────────────────────────────────────────────────────────

var assistantHTTP = &http.Client{Timeout: 6 * time.Minute}

// assistantNumCtx is the context window. The fixed preamble alone is ~1,850
// tokens, so the old 4096 overflowed once a conversation carried a few turns of
// history plus tool results — and an overflow makes Ollama shift the context,
// which throws away the prefix cache the rest of this file works to preserve.
//
// It MUST be identical everywhere. Changing num_ctx between requests forces a
// runner reload and wipes the cache, which shows up as a mysterious 28s stall.
const assistantNumCtx = 8192

func ollamaChat(ctx context.Context, msgs []ollamaMessage, tools []any) (*ollamaChatResponse, error) {
	return ollamaChatOpts(ctx, msgs, tools, nil)
}

// ollamaChatWarm runs a turn purely for its effect on the KV cache: generation
// is capped at a single token because the warm-up wants the prefill, not an
// answer. See StartAssistantWarmer.
func ollamaChatWarm(ctx context.Context, msgs []ollamaMessage, tools []any) (*ollamaChatResponse, error) {
	return ollamaChatOpts(ctx, msgs, tools, map[string]any{"num_predict": 1})
}

func ollamaChatOpts(ctx context.Context, msgs []ollamaMessage, tools []any, extra map[string]any) (*ollamaChatResponse, error) {
	opts := map[string]any{
		"num_thread":  assistantThreads(),
		"temperature": 0.2, // factual work; we want the tool call, not creativity
		"num_ctx":     assistantNumCtx,
	}
	for k, v := range extra {
		opts[k] = v
	}
	body := ollamaChatRequest{
		Model:     assistantModel(),
		Messages:  msgs,
		Tools:     tools,
		Stream:    false,
		KeepAlive: assistantKeepAlive(),
		Options:   opts,
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, assistantBaseURL()+"/api/chat", bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := assistantHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("assistant model unreachable: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("assistant model returned %d", resp.StatusCode)
	}
	var out ollamaChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("could not read model response: %w", err)
	}
	if out.Error != "" {
		return nil, fmt.Errorf("assistant model error: %s", out.Error)
	}
	return &out, nil
}

// ── persistence ─────────────────────────────────────────────────────────────

type assistantLogEntry struct {
	Role       string
	Content    string
	ToolName   string
	ToolArgs   any
	ToolResult any
	Model      string
	PromptTok  int
	OutputTok  int
	LatencyMS  int
	Err        string
}

// logAssistantMessage appends one row to the audit trail. Failures are logged
// and swallowed: an audit write must never be the reason a user's answer is
// lost, and the slog line preserves the event either way.
func logAssistantMessage(ctx context.Context, db *core.DB, convID int64, user *core.Claims, e assistantLogEntry) {
	var args, result any
	if e.ToolArgs != nil {
		if b, err := json.Marshal(e.ToolArgs); err == nil {
			args = string(b)
		}
	}
	if e.ToolResult != nil {
		if b, err := json.Marshal(e.ToolResult); err == nil {
			result = string(b)
		}
	}
	var uid any
	var uname, urole string
	if user != nil {
		uid = user.ID
		uname = user.FullName
		urole = user.Role
	}
	_, err := db.PGExec(ctx, `
		INSERT INTO assistant_messages
		  (conversation_id, role, content, tool_name, tool_args, tool_result,
		   actor_user_id, actor_name, actor_role, model,
		   prompt_tokens, output_tokens, latency_ms, error)
		VALUES ($1,$2,$3,NULLIF($4,''),$5::jsonb,$6::jsonb,$7,$8,$9,NULLIF($10,''),$11,$12,$13,NULLIF($14,''))`,
		convID, e.Role, e.Content, e.ToolName, args, result,
		uid, uname, urole, e.Model, e.PromptTok, e.OutputTok, e.LatencyMS, e.Err)
	if err != nil {
		slog.Error("assistant: audit write failed", "conversation", convID, "role", e.Role, "err", err)
	}
}

// ── routes ──────────────────────────────────────────────────────────────────

// RegisterAssistant wires the assistant. Mounted behind auth in main.go; each
// tool then applies its own page gate, so there is no single page key that
// unlocks all data.
func RegisterAssistant(r chi.Router, db *core.DB) {
	r.Get("/health", assistantHealth())
	r.Get("/conversations", assistantListConversations(db))
	r.Post("/conversations", assistantCreateConversation(db))
	r.Get("/conversations/{id}", assistantGetConversation(db))
	r.Delete("/conversations/{id}", assistantArchiveConversation(db))
	r.Post("/chat", assistantChat(db))
	r.Post("/chat/stream", assistantChatStream(db))
}

// assistantHealth reports whether the local model server is up and which model
// is configured. The UI uses this to show an honest "assistant offline" state
// rather than failing on first message.
func assistantHealth() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, assistantBaseURL()+"/api/version", nil)
		if err != nil {
			respondErr(w, 500, "Could not build health request")
			return
		}
		resp, err := assistantHTTP.Do(req)
		if err != nil {
			respond(w, map[string]any{"online": false, "model": assistantModel(),
				"detail": "The assistant service is not running on this server."}, "assistant")
			return
		}
		defer resp.Body.Close() //nolint:errcheck
		respond(w, map[string]any{
			"online": resp.StatusCode == http.StatusOK,
			"model":  assistantModel(),
			"queued": len(assistantSlot) > 0,
		}, "assistant")
	}
}

func assistantListConversations(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, title, created_at, updated_at
			FROM assistant_conversations
			WHERE user_id = $1 AND archived_at IS NULL
			ORDER BY updated_at DESC LIMIT 50`, user.ID)
		if err != nil {
			respondErrLog(w, 500, "Could not load conversations", err)
			return
		}
		respond(w, rows, "assistant")
	}
}

func assistantCreateConversation(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO assistant_conversations (user_id) VALUES ($1)
			RETURNING id, title, created_at, updated_at`, user.ID)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 500, "Could not start a conversation", err)
			return
		}
		respond(w, rows[0], "assistant")
	}
}

// assistantGetConversation returns the full transcript. Ownership is enforced in
// the WHERE clause: conversations can contain customer data pulled under the
// owner's permissions, so they are never readable by another user.
func assistantGetConversation(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid conversation id")
			return
		}
		owned, err := db.PGQuery(r.Context(),
			`SELECT id FROM assistant_conversations WHERE id = $1 AND user_id = $2`, id, user.ID)
		if err != nil {
			respondErrLog(w, 500, "Could not load conversation", err)
			return
		}
		if len(owned) == 0 {
			respondErr(w, 404, "Conversation not found")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, role, content, tool_name, created_at
			FROM assistant_messages
			WHERE conversation_id = $1 AND role IN ('user','assistant')
			ORDER BY id`, id)
		if err != nil {
			respondErrLog(w, 500, "Could not load messages", err)
			return
		}
		respond(w, rows, "assistant")
	}
}

// assistantArchiveConversation hides a conversation from the user's list. It is
// deliberately an archive, not a delete: the messages are the audit trail, and a
// user must not be able to erase a record of what they asked.
func assistantArchiveConversation(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid conversation id")
			return
		}
		if _, err := db.PGExec(r.Context(),
			`UPDATE assistant_conversations SET archived_at = now()
			 WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`, id, user.ID); err != nil {
			respondErrLog(w, 500, "Could not archive conversation", err)
			return
		}
		respondOK(w, "Conversation archived")
	}
}

// assistantChat is the main turn handler: take a question, let the model call
// vetted tools until it can answer, persist every step, return the answer.
func assistantChat(db *core.DB) http.HandlerFunc {
	type chatReq struct {
		ConversationID int64  `json:"conversation_id"`
		Message        string `json:"message"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		// The server-wide WriteTimeout is 60s (main.go), sized for CSV exports. A
		// single assistant turn on this CPU-only box routinely runs longer than
		// that — the first measured turn took 68.6s — and the connection was being
		// closed before the body was written, so the caller got an EMPTY response
		// even though the answer had been produced and audited. Extend the write
		// deadline for this route only; raising the global one would weaken every
		// other endpoint.
		if rc := http.NewResponseController(w); rc != nil {
			if err := rc.SetWriteDeadline(time.Now().Add(8 * time.Minute)); err != nil {
				slog.Warn("assistant: could not extend write deadline", "err", err)
			}
		}

		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		var req chatReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		question := strings.TrimSpace(req.Message)
		if question == "" {
			respondErr(w, 422, "Message cannot be empty")
			return
		}
		if len(question) > 4000 {
			respondErr(w, 422, "Message is too long — please shorten it")
			return
		}
		ctx := r.Context()

		// Resolve or create the conversation, always scoped to this user.
		convID := req.ConversationID
		if convID > 0 {
			owned, err := db.PGQuery(ctx,
				`SELECT id FROM assistant_conversations WHERE id = $1 AND user_id = $2`, convID, user.ID)
			if err != nil {
				respondErrLog(w, 500, "Could not load conversation", err)
				return
			}
			if len(owned) == 0 {
				respondErr(w, 404, "Conversation not found")
				return
			}
		} else {
			rows, err := db.PGQuery(ctx, `
				INSERT INTO assistant_conversations (user_id, title) VALUES ($1, $2) RETURNING id`,
				user.ID, assistantTitle(question))
			if err != nil || len(rows) == 0 {
				respondErrLog(w, 500, "Could not start a conversation", err)
				return
			}
			convID = toInt64(rows[0]["id"])
		}

		logAssistantMessage(ctx, db, convID, user, assistantLogEntry{Role: "user", Content: question})

		// Wait for the single inference slot. Ollama serialises requests anyway;
		// bounding the wait here turns a silent multi-minute hang into an honest
		// "busy right now".
		select {
		case assistantSlot <- struct{}{}:
			defer func() { <-assistantSlot }()
		case <-time.After(assistantQueueWait):
			respondErr(w, 429, "The assistant is busy answering someone else. Please try again in a moment.")
			return
		case <-ctx.Done():
			return
		}

		wireTools, byName := toolsForUser(user)
		names := make([]string, 0, len(byName))
		for n := range byName {
			names = append(names, n)
		}

		// Map iteration order is randomised by Go, and this list is printed into the
		// system prompt. Unsorted it made the preamble differ on every single request,
		// so the KV prefix cache never hit and every turn paid ~28s of re-prefill.
		sort.Strings(names)

		msgs := []ollamaMessage{{Role: "system", Content: assistantSystemPrompt(names)}}
		msgs = append(msgs, assistantHistory(ctx, db, convID)...)
		msgs = append(msgs, ollamaMessage{Role: "user", Content: assistantTurnContext(user) + question})

		started := time.Now()
		used := make([]string, 0, 2)
		var answer string
		var promptTok, outputTok int

		for round := 0; round < assistantMaxToolRounds; round++ {
			resp, err := ollamaChat(ctx, msgs, wireTools)
			if err != nil {
				slog.Error("assistant: model call failed", "conversation", convID, "err", err)
				logAssistantMessage(ctx, db, convID, user, assistantLogEntry{
					Role: "assistant", Err: err.Error(), Model: assistantModel(),
					LatencyMS: int(time.Since(started).Milliseconds())})
				respondErr(w, 503, "The assistant is unavailable right now. Please try again shortly.")
				return
			}
			promptTok += resp.PromptEvalCount
			outputTok += resp.EvalCount

			if len(resp.Message.ToolCalls) == 0 {
				answer = strings.TrimSpace(resp.Message.Content)
				break
			}

			// Echo the assistant's tool-call turn back before the results, or the
			// model loses track of what it asked for.
			msgs = append(msgs, resp.Message)

			for _, tc := range resp.Message.ToolCalls {
				name := tc.Function.Name
				tool, ok := byName[name]

				var payload any
				switch {
				case !ok:
					// Either a hallucinated tool name or one this user may not use.
					// Same reply either way: do not reveal that a tool exists but is
					// barred, which would leak the shape of other teams' data.
					payload = map[string]any{"error": "That information is not available to you."}
				case !userCanUseTool(user, tool):
					payload = map[string]any{"error": "That information is not available to you."}
				default:
					result, err := tool.Run(ctx, db, user, tc.Function.Arguments)
					if err != nil {
						slog.Error("assistant: tool failed", "tool", name, "err", err)
						payload = map[string]any{"error": "That lookup failed."}
					} else {
						payload = result
						used = append(used, name)
					}
				}

				logAssistantMessage(ctx, db, convID, user, assistantLogEntry{
					Role: "tool", ToolName: name,
					ToolArgs: tc.Function.Arguments, ToolResult: payload,
				})

				body, err := json.Marshal(payload)
				if err != nil {
					body = []byte(`{"error":"result could not be encoded"}`)
				}
				msgs = append(msgs, ollamaMessage{Role: "tool", ToolName: name, Content: string(body)})
			}
		}

		if answer == "" {
			// Ran out of tool rounds without settling on an answer. Say so rather
			// than returning an empty bubble.
			answer = "I could not put together an answer for that. Please try rephrasing it, or ask for one thing at a time."
		}

		latency := int(time.Since(started).Milliseconds())
		logAssistantMessage(ctx, db, convID, user, assistantLogEntry{
			Role: "assistant", Content: answer, Model: assistantModel(),
			PromptTok: promptTok, OutputTok: outputTok, LatencyMS: latency,
		})
		if _, err := db.PGExec(ctx,
			`UPDATE assistant_conversations SET updated_at = now() WHERE id = $1`, convID); err != nil {
			slog.Warn("assistant: could not touch conversation", "id", convID, "err", err)
		}

		respond(w, map[string]any{
			"conversation_id": convID,
			"answer":          answer,
			"tools_used":      used,
			"latency_ms":      latency,
			"model":           assistantModel(),
		}, "assistant")
	}
}

// assistantHistory replays a bounded slice of the conversation. Tool rows are
// deliberately excluded: their payloads are large, they are already reflected in
// the assistant's earlier reply, and replaying them would blow the prefill
// budget that keeps each turn fast.
func assistantHistory(ctx context.Context, db *core.DB, convID int64) []ollamaMessage {
	rows, err := db.PGQuery(ctx, `
		SELECT role, content FROM (
			SELECT id, role, content
			FROM assistant_messages
			WHERE conversation_id = $1 AND role IN ('user','assistant') AND content <> ''
			ORDER BY id DESC
			LIMIT $2
		) recent ORDER BY id`, convID, assistantHistoryTurns)
	if err != nil {
		slog.Warn("assistant: could not load history", "conversation", convID, "err", err)
		return nil
	}
	out := make([]ollamaMessage, 0, len(rows))
	for _, row := range rows {
		role := fmt.Sprint(row["role"])
		content := fmt.Sprint(row["content"])
		if content == "" || content == "<nil>" {
			continue
		}
		out = append(out, ollamaMessage{Role: role, Content: content})
	}
	return out
}

// assistantTitle derives a short conversation title from the first question so
// the sidebar is scannable.
func assistantTitle(q string) string {
	q = strings.Join(strings.Fields(q), " ")
	if len(q) > 60 {
		return q[:57] + "..."
	}
	if q == "" {
		return "New conversation"
	}
	return q
}
