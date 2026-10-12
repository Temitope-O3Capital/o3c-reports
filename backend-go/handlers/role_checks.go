package handlers

import "github.com/o3c/workspace/core"

// callerHasRole reports whether the caller holds any of the named roles, counting
// their secondary roles as well as their primary one.
//
// WHY THIS EXISTS. A user's roles are `role` plus `extra_roles`, and the page
// system has always honoured both: core.HasPage walks Claims.AllRoles(). Handler
// gates, though, were written as `user.Role == "call_center_head"`, which sees only
// the primary role. So a page grant and the endpoint behind it could disagree — the
// user is shown a page and then refused by the API that fills it.
//
// That is not hypothetical. Of 52 staff accounts, 6 hold secondary roles, and two
// of them are exactly the case these gates get wrong:
//
//	cards_head        extra: call_center_head, care_head
//	cmo               extra: sales_head, bd_head
//
// The cards head also runs the call centre, so every `caller.Role !=
// "call_center_head"` check refused them. report_access_test.go already carries a
// case named "cards head who also runs the call centre" — the reports layer learned
// this lesson; the handlers had not.
//
// ADMIN IS DELIBERATELY NOT ROUTED THROUGH HERE, and the reason is now simple:
// admin is a PRIMARY role or it is nothing. core.Claims.AllRoles drops "admin"
// from extra_roles, and handlers/admin.go refuses to store it there, so a caller
// who holds admin holds it as `user.Role` — which every `user.Role != "admin"`
// comparison already reads correctly. Passing admin through this helper would
// therefore add nothing, and TestAdminIsNeverWidenedToSecondaryRoles asserts no
// call site does.
//
// The earlier version of this comment said HasPage treats admin as primary-only
// and that admin.go disagreed with it. Both halves of that were wrong, and in the
// dangerous direction: HasPage's `c.Role == "admin"` is only a fast path, and the
// loop after it resolves RolePages["admin"] — AllCatalogPages() — for ANY role in
// AllRoles(). So admin in extra_roles used to grant every page and, through
// seesAllRoles in scope.go, every row. admin.go's roleGrantsAdmin was the one piece
// behaving conservatively: it describes the role being GRANTED, and required a
// primary admin to grant it. The fix was to make the state unrepresentable rather
// than to pick a side.
func callerHasRole(c *core.Claims, roles ...string) bool {
	if c == nil {
		return false
	}
	for _, have := range c.AllRoles() {
		for _, want := range roles {
			if want != "" && have == want {
				return true
			}
		}
	}
	return false
}
