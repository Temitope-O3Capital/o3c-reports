package handlers

// Zoho→workspace agent crosswalk. Agent attribution used to be re-derived by email
// equality on every import; when emails differed or the Zoho agent wasn't a
// workspace user, the record landed unattributed with no trace of who it should
// have been. zoho_agent_map (migration 139) is the durable map: resolved once by
// a multi-signal match (manual → email → name), reused thereafter, and it retains
// UNMATCHED agents so a supervisor can map them from the admin view.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/workspace/core"
)

// zohoPollInterval is the cadence of the fast incremental Zoho poll. Near-real-time
// by default (60s); tunable via ZOHO_POLL_INTERVAL (seconds), clamped to [30,3600].
// The hourly deep-reconcile sweep is separate and always runs.
func zohoPollInterval() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ZOHO_POLL_INTERVAL")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 30 && n <= 3600 {
			return time.Duration(n) * time.Second
		}
	}
	return 60 * time.Second
}

// zohoLookupUser tries to resolve a Zoho agent to a workspace user by email first,
// then by an unambiguous full-name match. Returns (0,"unmatched") when nothing
// confidently matches. Name is only trusted when it hits exactly one active user.
func zohoLookupUser(ctx context.Context, db *core.DB, email, name string) (int64, string) {
	email = strings.ToLower(strings.TrimSpace(email))
	name = strings.TrimSpace(name)
	if email != "" {
		if rows, _ := db.PGQuery(ctx,
			`SELECT id FROM o3c_users WHERE lower(email)=$1 AND deleted_at IS NULL LIMIT 1`, email); len(rows) > 0 {
			return toInt64(rows[0]["id"]), "email"
		}
	}
	if name != "" {
		rows, _ := db.PGQuery(ctx,
			`SELECT id FROM o3c_users WHERE lower(trim(full_name))=lower(trim($1)) AND deleted_at IS NULL LIMIT 2`, name)
		if len(rows) == 1 {
			return toInt64(rows[0]["id"]), "name"
		}
	}
	return 0, "unmatched"
}

// zohoResolveAgent resolves a Zoho agent to a workspace user id via the durable
// crosswalk, creating/refreshing the map row as a side effect. Manual mappings are
// authoritative and never re-derived. Returns nil when the agent can't be matched
// yet (the map row is still written as 'unmatched' so it shows in the admin view).
func zohoResolveAgent(ctx context.Context, db *core.DB, zohoAgentID, email, name string) *int64 {
	zohoAgentID = strings.TrimSpace(zohoAgentID)
	email = strings.ToLower(strings.TrimSpace(email))
	name = strings.TrimSpace(name)

	// No stable Zoho id — fall back to a one-off lookup, don't pollute the map.
	if zohoAgentID == "" {
		if uid, _ := zohoLookupUser(ctx, db, email, name); uid != 0 {
			return &uid
		}
		return nil
	}

	// Existing map row?
	if rows, _ := db.PGQuery(ctx,
		`SELECT o3c_user_id, match_method FROM zoho_agent_map WHERE zoho_agent_id=$1`, zohoAgentID); len(rows) > 0 {
		method := str(rows[0]["match_method"])
		if method == "manual" {
			// Human-set — authoritative. Only refresh bookkeeping.
			//
			// call_count is deliberately NOT incremented here (nor in the two writes
			// below). This function runs once per RESOLVE — every call, every ticket,
			// and again for each on every re-sync — so the counter tracked how often the
			// importer swept, not how much the agent worked: a single call re-synced
			// hourly added dozens. The admin view derives the real figure from
			// helpdesk_calls instead. The column is left in place, just no longer fed.
			db.PGExec(ctx, `UPDATE zoho_agent_map
			   SET zoho_email=COALESCE(NULLIF($2,''),zoho_email),
			       zoho_name =COALESCE(NULLIF($3,''),zoho_name),
			       updated_at=NOW()
			   WHERE zoho_agent_id=$1`, zohoAgentID, email, name) //nolint:errcheck
			if uid := toInt64(rows[0]["o3c_user_id"]); uid != 0 {
				return &uid
			}
			return nil
		}
		// Non-manual — re-resolve in case a workspace user now exists.
		uid, m := zohoLookupUser(ctx, db, email, name)
		db.PGExec(ctx, `UPDATE zoho_agent_map
		   SET zoho_email=COALESCE(NULLIF($2,''),zoho_email),
		       zoho_name =COALESCE(NULLIF($3,''),zoho_name),
		       o3c_user_id=$4, match_method=$5, updated_at=NOW()
		   WHERE zoho_agent_id=$1`, zohoAgentID, email, name, nilIfZero(uid), m) //nolint:errcheck
		if uid != 0 {
			return &uid
		}
		return nil
	}

	// First sighting — resolve and insert (retains unmatched).
	uid, m := zohoLookupUser(ctx, db, email, name)
	db.PGExec(ctx, `INSERT INTO zoho_agent_map
	     (zoho_agent_id, zoho_email, zoho_name, o3c_user_id, match_method)
	   VALUES ($1, NULLIF($2,''), NULLIF($3,''), $4, $5)
	   ON CONFLICT (zoho_agent_id) DO UPDATE SET updated_at=NOW()`,
		zohoAgentID, email, name, nilIfZero(uid), m) //nolint:errcheck
	if uid != 0 {
		return &uid
	}
	if m == "unmatched" {
		// Say so once, at the point it happens. This case used to be entirely silent:
		// the call was stored with agent_id NULL and the importer moved on, which is
		// how ~300 calls a month end up belonging to nobody. The digest raised by
		// zohoAlertUnattributedCalls is the other half of making it visible.
		slog.Warn("zoho agent did not resolve to a workspace user — call attribution dropped",
			"zoho_agent_id", zohoAgentID, "zoho_name", name, "zoho_email", email)
	}
	return nil
}

// zohoAlertUnattributedCalls surfaces the agent-attribution backlog rather than
// letting it accumulate unseen.
//
// When a Zoho agent id resolves to no workspace user the call is stored with
// agent_id NULL and nothing anywhere reports it, so those calls count towards no
// agent's volume and appear in no supervisor's view. The crosswalk already keeps
// the unmatched agent, and Agent Matching already fixes it in one click and
// re-links the history — the only missing piece was telling somebody it is owed.
//
// A grouped digest, not one alert per call: the GroupKey collapses repeats into a
// single in-app row (a per-call alert here would be ~300 notifications a month).
// Raised only from the hourly deep cycle, so the 60-second poll cannot turn it
// into a stream.
func zohoAlertUnattributedCalls(ctx context.Context, db *core.DB) {
	rows, err := db.PGQuery(ctx, `
		SELECT COUNT(*)                                 AS calls,
		       COUNT(DISTINCT NULLIF(zoho_agent_id,'')) AS agents
		  FROM helpdesk_calls
		 WHERE agent_id IS NULL
		   AND source_system = 'zoho_desk'
		   AND COALESCE(zoho_agent_id,'') <> ''
		   AND started_at >= NOW() - INTERVAL '30 days'`)
	if err != nil || len(rows) == 0 {
		return
	}
	calls, agents := toInt64(rows[0]["calls"]), toInt64(rows[0]["agents"])
	if calls == 0 {
		return
	}
	slog.Warn("zoho import: calls with no workspace agent", "calls_30d", calls, "unmapped_agents", agents)
	NotifyRoles(ctx, db, []string{"call_center_head", "it_admin"}, NotifPayload{
		EventType: EvtSystemAlert,
		Title:     "Calls Are Arriving Without an Agent",
		Body: fmt.Sprintf("%d call(s) in the last 30 days came from %d Zoho agent(s) that map to no workspace "+
			"user, so they count towards nobody's volume. Map them under Helpdesk → Supervisor → Agent "+
			"Matching; calls already imported are re-linked automatically.", calls, agents),
		ActionURL: "/helpdesk/supervisor",
		GroupKey:  "zoho_unmatched_agents",
		Priority:  "normal",
	})
}

// nilIfZero returns nil for a zero id (so pgx writes SQL NULL into a nullable FK)
// and the value otherwise.
func nilIfZero(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}

// zohoUnmatchedAgents lists Zoho agents with no confident workspace match, plus a
// few candidate users (by email/name) to make one-click mapping easy. Read-only.
func zohoUnmatchedAgents(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		// call_count is DERIVED from the call ledger, not read from zoho_agent_map.
		// The stored counter incremented on every resolve — including every re-sync of
		// a call already seen — so it measured sweeps, not work, and the screen ordered
		// the backlog by the wrong thing. These are real calls, with the recent window
		// broken out so an agent who is active NOW sorts above one who left months ago.
		rows, _ := db.PGQuery(ctx, `
			SELECT m.zoho_agent_id, m.zoho_email, m.zoho_name, m.match_method,
			       COALESCE(c.calls, 0)     AS call_count,
			       COALESCE(c.calls_30d, 0) AS calls_30d,
			       m.o3c_user_id, u.full_name AS o3c_name, u.email AS o3c_email
			FROM zoho_agent_map m
			LEFT JOIN o3c_users u ON u.id = m.o3c_user_id
			LEFT JOIN LATERAL (
			  SELECT COUNT(*) AS calls,
			         COUNT(*) FILTER (WHERE h.started_at >= NOW() - INTERVAL '30 days') AS calls_30d
			    FROM helpdesk_calls h
			   WHERE h.zoho_agent_id = m.zoho_agent_id
			) c ON TRUE
			ORDER BY (m.o3c_user_id IS NULL) DESC, calls_30d DESC, call_count DESC, m.zoho_name`)
		if rows == nil {
			rows = []core.Row{}
		}
		// The backlog this screen exists to clear, stated plainly. Split in two
		// because only the first half is fixable here: a call carrying a Zoho agent id
		// can be mapped below, whereas one that arrived with no ownerId at all cannot
		// be — showing them as one number would promise a fix that does not exist.
		summary := map[string]any{}
		if sr, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) FILTER (WHERE COALESCE(zoho_agent_id,'') <> '') AS mappable_calls,
			       COUNT(*) FILTER (WHERE COALESCE(zoho_agent_id,'') =  '') AS no_agent_id_calls,
			       COUNT(DISTINCT NULLIF(zoho_agent_id,''))                 AS unmapped_agents
			  FROM helpdesk_calls
			 WHERE agent_id IS NULL
			   AND source_system = 'zoho_desk'
			   AND started_at >= NOW() - INTERVAL '90 days'`); len(sr) > 0 {
			summary = sr[0]
		}
		// Candidate workspace users for the mapping dropdown (active only).
		users, _ := db.PGQuery(ctx, `
			SELECT id, full_name, email FROM o3c_users
			WHERE deleted_at IS NULL AND is_active=TRUE
			ORDER BY full_name`)
		if users == nil {
			users = []core.Row{}
		}
		respond(w, map[string]any{"agents": rows, "users": users, "summary": summary}, "zoho_agents")
	}
}

// zohoMapAgent sets (or clears) the workspace user for a Zoho agent and back-fills
// every call already imported under that agent id. Head/admin only. This is the
// action behind the unmatched-agents screen.
func zohoMapAgent(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		caller := core.UserFromCtx(ctx)
		if caller == nil || (caller.Role != "call_center_head" && caller.Role != "admin") {
			respondErr(w, 403, "insufficient role")
			return
		}
		var b struct {
			ZohoAgentID string `json:"zoho_agent_id"`
			O3CUserID   int64  `json:"o3c_user_id"` // 0 → clear the mapping
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		b.ZohoAgentID = strings.TrimSpace(b.ZohoAgentID)
		if b.ZohoAgentID == "" {
			respondErr(w, 422, "zoho_agent_id is required")
			return
		}
		if b.O3CUserID != 0 {
			if ex, _ := db.PGQuery(ctx, `SELECT 1 FROM o3c_users WHERE id=$1 AND deleted_at IS NULL`, b.O3CUserID); len(ex) == 0 {
				respondErr(w, 422, "unknown user")
				return
			}
		}
		method := "manual"
		if b.O3CUserID == 0 {
			method = "unmatched"
		}
		if _, err := db.PGExec(ctx, `
			INSERT INTO zoho_agent_map (zoho_agent_id, o3c_user_id, match_method, updated_at)
			VALUES ($1, $2, $3, NOW())
			ON CONFLICT (zoho_agent_id) DO UPDATE SET o3c_user_id=$2, match_method=$3, updated_at=NOW()`,
			b.ZohoAgentID, nilIfZero(b.O3CUserID), method); err != nil {
			respondErr(w, 500, "failed to save mapping")
			return
		}
		// Back-fill historical records stamped with this Zoho agent id: calls carry
		// zoho_agent_id, tickets carry zoho_assignee_id (same Zoho user id).
		calls := int64(0)
		if res, _ := db.PGExec(ctx,
			`UPDATE helpdesk_calls SET agent_id=$2 WHERE zoho_agent_id=$1`, b.ZohoAgentID, nilIfZero(b.O3CUserID)); res != nil {
			calls, _ = res.RowsAffected()
		}
		tickets := int64(0)
		if res, _ := db.PGExec(ctx,
			`UPDATE helpdesk_tickets SET assigned_to=$2 WHERE zoho_assignee_id=$1`, b.ZohoAgentID, nilIfZero(b.O3CUserID)); res != nil {
			tickets, _ = res.RowsAffected()
		}
		respond(w, map[string]any{"ok": true, "calls_relinked": calls, "tickets_relinked": tickets}, "zoho_agents")
	}
}
