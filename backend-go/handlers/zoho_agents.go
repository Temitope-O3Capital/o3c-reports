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
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/reports/core"
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
			db.PGExec(ctx, `UPDATE zoho_agent_map
			   SET zoho_email=COALESCE(NULLIF($2,''),zoho_email),
			       zoho_name =COALESCE(NULLIF($3,''),zoho_name),
			       call_count=call_count+1, updated_at=NOW()
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
		       o3c_user_id=$4, match_method=$5, call_count=call_count+1, updated_at=NOW()
		   WHERE zoho_agent_id=$1`, zohoAgentID, email, name, nilIfZero(uid), m) //nolint:errcheck
		if uid != 0 {
			return &uid
		}
		return nil
	}

	// First sighting — resolve and insert (retains unmatched).
	uid, m := zohoLookupUser(ctx, db, email, name)
	db.PGExec(ctx, `INSERT INTO zoho_agent_map
	     (zoho_agent_id, zoho_email, zoho_name, o3c_user_id, match_method, call_count)
	   VALUES ($1, NULLIF($2,''), NULLIF($3,''), $4, $5, 1)
	   ON CONFLICT (zoho_agent_id) DO UPDATE SET call_count=zoho_agent_map.call_count+1, updated_at=NOW()`,
		zohoAgentID, email, name, nilIfZero(uid), m) //nolint:errcheck
	if uid != 0 {
		return &uid
	}
	return nil
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
		rows, _ := db.PGQuery(ctx, `
			SELECT m.zoho_agent_id, m.zoho_email, m.zoho_name, m.match_method, m.call_count,
			       m.o3c_user_id, u.full_name AS o3c_name, u.email AS o3c_email
			FROM zoho_agent_map m
			LEFT JOIN o3c_users u ON u.id = m.o3c_user_id
			ORDER BY (m.o3c_user_id IS NULL) DESC, m.call_count DESC, m.zoho_name`)
		if rows == nil {
			rows = []core.Row{}
		}
		// Candidate workspace users for the mapping dropdown (active only).
		users, _ := db.PGQuery(ctx, `
			SELECT id, full_name, email FROM o3c_users
			WHERE deleted_at IS NULL AND is_active=TRUE
			ORDER BY full_name`)
		if users == nil {
			users = []core.Row{}
		}
		respond(w, map[string]any{"agents": rows, "users": users}, "zoho_agents")
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
