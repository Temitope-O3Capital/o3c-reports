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
// ADMIN IS DELIBERATELY NOT ROUTED THROUGH HERE. core.HasPage and
// core.RequirePages treat admin as a PRIMARY-role superuser only (`c.Role ==
// "admin"`), so widening admin here would hand out more than the page system does.
// Every `user.Role != "admin"` comparison is therefore left exactly as it was. No
// account currently holds admin as a secondary role, so nothing changes in
// practice either way — but admin.go's roleGrantsAdmin() DOES count admin in
// extra_roles when deciding who may grant it, so the two halves disagree. That is
// a real inconsistency and a product decision (is admin primary-only, or not?),
// not something to settle silently inside a helper.
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
