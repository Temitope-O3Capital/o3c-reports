package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// ─────────────────────────────────────────────────────────────────────────────
// Sales teams — the flexible head→officers structure that scopes the Leads book.
//
// A team has one head and many member officers. A head may run more than one team;
// an officer belongs to at most one team (uq_sales_team_member_user). This is what
// turns "a sales head sees ALL leads" into "a sales head sees THEIR TEAM's leads",
// while executives (management) still see everything.
//
// Scope tiers for the Leads queue (salesLeadScope):
//   • all  — admin + management (md/coo/cfo/cmo/head_ops): every lead.
//   • team — a head who runs ≥1 team: their officers' leads + the unowned pool.
//   • own  — an officer: their own leads + the unowned pool (claimable).
// A sales_head who has NOT been given a team yet falls back to 'all', so nothing
// is stranded before an admin configures the teams.
// ─────────────────────────────────────────────────────────────────────────────

type leadScopeMode string

const (
	scopeAll  leadScopeMode = "all"
	scopeTeam leadScopeMode = "team"
	scopeOwn  leadScopeMode = "own"
)

// canManageTeams gates team CRUD: sales heads and the executive/admin tier.
func canManageTeams(u *core.Claims) bool {
	return u != nil && (isSalesHead(u) || u.CanSeeAllRows())
}

// teamHeadOfficerIDs returns the distinct member user-ids across every ACTIVE team
// this user heads (the head themselves is always included, since a head also works
// and owns leads). Empty slice → this user heads no team.
func teamHeadOfficerIDs(r *http.Request, db *core.DB, headID int64) []int64 {
	rows, err := db.PGQuery(r.Context(), `
		SELECT DISTINCT m.user_id
		  FROM app.sales_teams t
		  JOIN app.sales_team_members m ON m.team_id = t.id
		 WHERE t.head_user_id = $1 AND t.is_active`, headID)
	if err != nil {
		return nil
	}
	ids := []int64{}
	seen := map[int64]bool{}
	for _, row := range rows {
		if id := toInt64(row["user_id"]); id != 0 && !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	if len(ids) > 0 && !seen[headID] {
		ids = append(ids, headID) // a head owns/works leads too
	}
	return ids
}

// salesLeadScope decides how much of the lead book a caller may see. Returns the
// mode and, for 'team', the officer ids that belong to the caller's team(s).
func salesLeadScope(r *http.Request, db *core.DB, u *core.Claims) (leadScopeMode, []int64) {
	if u == nil {
		return scopeOwn, nil
	}
	// Executives / admin see everything, always.
	if u.CanSeeAllRows() && !isSalesHead(u) {
		return scopeAll, nil
	}
	// A head scoped to their team — unless they run no team yet (fallback to all so
	// the 2 existing sales heads aren't stranded before teams are configured).
	if isSalesHead(u) {
		if ids := teamHeadOfficerIDs(r, db, u.ID); len(ids) > 0 {
			return scopeTeam, ids
		}
		return scopeAll, nil
	}
	return scopeOwn, nil
}

// applyLeadScope appends the owner-scope predicate for the caller to a WHERE builder
// (leads are aliased `c`). A head may narrow with ?owner_id=<id>|unassigned within
// whatever their scope already permits.
func applyLeadScope(r *http.Request, db *core.DB, u *core.Claims, where []string, args []any, n int) ([]string, []any, int) {
	mode, ids := salesLeadScope(r, db, u)
	owner := qstr(r, "owner_id")
	switch mode {
	case scopeAll:
		switch owner {
		case "":
		case "unassigned":
			where = append(where, "c.lead_owner_id IS NULL")
		default:
			if id, err := parseUserID(owner); err == nil {
				where = append(where, fmt.Sprintf("c.lead_owner_id = $%d", n))
				args = append(args, id)
				n++
			}
		}
	case scopeTeam:
		switch owner {
		case "unassigned":
			where = append(where, "c.lead_owner_id IS NULL")
		case "":
			where = append(where, fmt.Sprintf("(c.lead_owner_id = ANY($%d) OR c.lead_owner_id IS NULL)", n))
			args = append(args, ids)
			n++
		default:
			// A head narrowing to one officer — allowed regardless of team so a
			// mis-typed id simply returns nothing rather than leaking another team.
			if id, err := parseUserID(owner); err == nil {
				where = append(where, fmt.Sprintf("c.lead_owner_id = $%d", n))
				args = append(args, id)
				n++
			}
		}
	default: // own
		where = append(where, fmt.Sprintf("(c.lead_owner_id = $%d OR c.lead_owner_id IS NULL)", n))
		args = append(args, u.ID)
		n++
	}
	return where, args, n
}

// canWorkLead gates the actions that change a lead's fate (advance / convert /
// disqualify): the lead's owner, a head, or anyone on an UNOWNED lead (picking it up
// is part of working it). Prevents one officer converting or killing another's lead.
func canWorkLead(u *core.Claims, owner sql.NullInt64) bool {
	if u == nil || u.ID == 0 {
		return false
	}
	if isSalesHead(u) || u.CanSeeAllRows() {
		return true
	}
	if !owner.Valid {
		return true
	}
	return owner.Int64 == u.ID
}

func RegisterSalesTeams(r chi.Router, db *core.DB) {
	access := core.RequirePages("sales", "crm_contacts")
	r.With(access).Get("/teams", listSalesTeams(db))
	r.With(access).Post("/teams", createSalesTeam(db))
	r.With(access).Patch("/teams/{id}", updateSalesTeam(db))
	r.With(access).Delete("/teams/{id}", deleteSalesTeam(db))
	r.With(access).Post("/teams/{id}/members", addTeamMember(db))
	r.With(access).Delete("/teams/{id}/members/{userId}", removeTeamMember(db))
}

// listSalesTeams returns every team with its head and members. Any sales user may
// read the roster (they need to know who's on the floor); only managers mutate it.
func listSalesTeams(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		teams, err := db.PGQuery(r.Context(), `
			SELECT t.id, t.name, t.head_user_id, h.full_name AS head_name,
			       t.is_active, t.created_at,
			       COALESCE(mc.members, 0) AS member_count
			  FROM app.sales_teams t
			  LEFT JOIN o3c_users h ON h.id = t.head_user_id
			  LEFT JOIN (SELECT team_id, COUNT(*) AS members
			              FROM app.sales_team_members GROUP BY team_id) mc ON mc.team_id = t.id
			 ORDER BY t.is_active DESC, t.name`)
		if err != nil {
			respondErrLog(w, 500, "Could not load teams", err)
			return
		}
		members, err := db.PGQuery(r.Context(), `
			SELECT m.team_id, m.user_id, u.full_name, u.role, u.is_active
			  FROM app.sales_team_members m
			  JOIN o3c_users u ON u.id = m.user_id
			 ORDER BY u.full_name`)
		if err != nil {
			respondErrLog(w, 500, "Could not load members", err)
			return
		}
		byTeam := map[int64][]map[string]any{}
		for _, m := range members {
			tid := toInt64(m["team_id"])
			byTeam[tid] = append(byTeam[tid], map[string]any{
				"user_id": toInt64(m["user_id"]), "full_name": str(m["full_name"]),
				"role": str(m["role"]), "is_active": m["is_active"],
			})
		}
		out := make([]map[string]any, 0, len(teams))
		for _, t := range teams {
			tid := toInt64(t["id"])
			mem := byTeam[tid]
			if mem == nil {
				mem = []map[string]any{}
			}
			out = append(out, map[string]any{
				"id": tid, "name": str(t["name"]), "head_user_id": toInt64(t["head_user_id"]),
				"head_name": str(t["head_name"]), "is_active": t["is_active"],
				"member_count": toInt64(t["member_count"]), "members": mem,
			})
		}
		respond(w, out, "pg")
	}
}

func createSalesTeam(db *core.DB) http.HandlerFunc {
	type body struct {
		Name       string `json:"name"`
		HeadUserID *int64 `json:"head_user_id"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if !canManageTeams(u) {
			respondErr(w, 403, "Only a sales head or manager can create teams")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if strings.TrimSpace(b.Name) == "" {
			respondErr(w, 400, "Team name is required")
			return
		}
		var head any
		if b.HeadUserID != nil && *b.HeadUserID > 0 {
			head = *b.HeadUserID
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.sales_teams (name, head_user_id, created_by)
			VALUES ($1,$2,$3) RETURNING id`,
			strings.TrimSpace(b.Name), head, u.ID)
		if err != nil {
			respondErrLog(w, 500, "Could not create team", err)
			return
		}
		respond(w, map[string]any{"id": toInt64(rows[0]["id"])}, "pg")
	}
}

func updateSalesTeam(db *core.DB) http.HandlerFunc {
	type body struct {
		Name       *string `json:"name"`
		HeadUserID *int64  `json:"head_user_id"`
		IsActive   *bool   `json:"is_active"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if !canManageTeams(u) {
			respondErr(w, 403, "Only a sales head or manager can edit teams")
			return
		}
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid team id")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		sets := []string{"updated_at = now()"}
		args := []any{id}
		n := 2
		if b.Name != nil && strings.TrimSpace(*b.Name) != "" {
			sets = append(sets, "name = $"+strconv.Itoa(n))
			args = append(args, strings.TrimSpace(*b.Name))
			n++
		}
		if b.HeadUserID != nil {
			sets = append(sets, "head_user_id = $"+strconv.Itoa(n))
			if *b.HeadUserID > 0 {
				args = append(args, *b.HeadUserID)
			} else {
				args = append(args, nil)
			}
			n++
		}
		if b.IsActive != nil {
			sets = append(sets, "is_active = $"+strconv.Itoa(n))
			args = append(args, *b.IsActive)
			n++
		}
		if _, err := db.PGExec(r.Context(),
			`UPDATE app.sales_teams SET `+strings.Join(sets, ", ")+` WHERE id = $1`, args...); err != nil {
			respondErrLog(w, 500, "Could not update team", err)
			return
		}
		respondOK(w, "Team updated")
	}
}

func deleteSalesTeam(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if !canManageTeams(u) {
			respondErr(w, 403, "Only a sales head or manager can delete teams")
			return
		}
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid team id")
			return
		}
		if _, err := db.PGExec(r.Context(), `DELETE FROM app.sales_teams WHERE id = $1`, id); err != nil {
			respondErrLog(w, 500, "Could not delete team", err)
			return
		}
		respondOK(w, "Team removed")
	}
}

func addTeamMember(db *core.DB) http.HandlerFunc {
	type body struct {
		UserID int64 `json:"user_id"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if !canManageTeams(u) {
			respondErr(w, 403, "Only a sales head or manager can change team membership")
			return
		}
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid team id")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.UserID == 0 {
			respondErr(w, 400, "user_id is required")
			return
		}
		// An officer sits on one team; moving them re-homes rather than erroring.
		if _, err := db.PGExec(r.Context(), `
			INSERT INTO app.sales_team_members (team_id, user_id, added_by)
			VALUES ($1,$2,$3)
			ON CONFLICT (user_id) DO UPDATE
			   SET team_id = EXCLUDED.team_id, added_at = now(), added_by = EXCLUDED.added_by`,
			id, b.UserID, u.ID); err != nil {
			respondErrLog(w, 500, "Could not add member", err)
			return
		}
		respondOK(w, "Member added")
	}
}

func removeTeamMember(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := core.UserFromCtx(r.Context())
		if !canManageTeams(u) {
			respondErr(w, 403, "Only a sales head or manager can change team membership")
			return
		}
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid team id")
			return
		}
		uid, err := strconv.ParseInt(chi.URLParam(r, "userId"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid user id")
			return
		}
		if _, err := db.PGExec(r.Context(),
			`DELETE FROM app.sales_team_members WHERE team_id = $1 AND user_id = $2`, id, uid); err != nil {
			respondErrLog(w, 500, "Could not remove member", err)
			return
		}
		respondOK(w, "Member removed")
	}
}
