package core

import "strings"

// Row-level data scoping.
//
// Page gating (RequirePages) decides WHICH modules a user can enter. This layer
// decides WHICH ROWS within an accessible module a user may see. The app runs on
// a single shared DB role, so scoping is enforced in the application: handlers
// ask DataScopeForRole how much a caller may see and inject an ownership filter.
type DataScope int

const (
	// ScopeOwn — only rows the user owns / is assigned to (leaf officer/agent).
	ScopeOwn DataScope = iota
	// ScopeTeam — reserved for department/team-wide visibility (needs a team
	// model; not yet used — treated as ScopeAll by DataScopeForRole for now).
	ScopeTeam
	// ScopeAll — every row within modules the user's pages grant.
	ScopeAll
)

// seesAllRoles are senior/oversight roles that view every row within any module
// their pages grant. Every "*_head" and "head_*" role is included implicitly by
// DataScopeForRole, so only the non-suffixed seniors are listed here.
var seesAllRoles = map[string]bool{
	"admin":      true,
	"md":         true,
	"coo":        true,
	"cfo":        true,
	"cmo":        true,
	"executive":  true,
	"management": true,
	"it_admin":   true,
}

// DataScopeForRole maps a role to how many rows it may see. Leaf officer/agent
// roles are scoped to their own rows; senior and departmental-head roles see all
// rows in the modules they can already access.
func DataScopeForRole(role string) DataScope {
	if seesAllRoles[role] || strings.HasSuffix(role, "_head") || strings.HasPrefix(role, "head_") {
		return ScopeAll
	}
	return ScopeOwn
}

// SeesAllRows is the common two-tier convenience: true when the role is not
// restricted to its own rows.
func SeesAllRows(role string) bool { return DataScopeForRole(role) == ScopeAll }

// managementRoles is the cross-company executive tier permitted to view the
// General Overview and executive dashboards. This is a NARROWER concept than
// SeesAllRows: a sales_head sees all sales rows but is not management. Kept in
// sync with the frontend MGMT set (lib/roles.ts).
var managementRoles = map[string]bool{
	"admin":      true,
	"md":         true,
	"coo":        true,
	"cfo":        true,
	"cmo":        true,
	"executive":  true,
	"management": true,
	"head_ops":   true,
	"head_it":    true,
	"head_hr":    true,
}

// IsManagement reports whether a role belongs to the executive/management tier
// that may access company-wide overview dashboards.
func IsManagement(role string) bool { return managementRoles[role] }
