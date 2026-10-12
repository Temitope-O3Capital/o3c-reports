package core

import "testing"

// Admin is a primary role or it is nothing.
//
// Before 2026-10-12, putting "admin" in someone's extra_roles made them a near-total
// superuser by accident. HasPage's `c.Role == "admin"` check is only a fast path; the
// loop after it resolves RolePages[role] for every role in AllRoles(), and
// RolePages["admin"] is AllCatalogPages() — so a secondary admin got EVERY page.
// scope.go's seesAllRoles has the same shape via CanSeeAllRows, so they also got
// every ROW. Meanwhile the in-body `user.Role != "admin"` guards scattered through
// handlers still refused them, which is why it never looked like full admin.
//
// In the user editor a secondary role reads as a small additive grant. This one was
// a silent privilege escalation, and no account held it — so these tests exist to
// keep it that way rather than to fix a live incident.

func TestAdminIsNotHonouredAsASecondaryRole(t *testing.T) {
	// A page this user's own role does not grant, and which only a superuser would
	// reach through RolePages["admin"].
	const adminOnlyPage = "admin_users"

	secondary := &Claims{ID: 1, Role: "care_agent", ExtraRoles: []string{"admin"}}

	if secondary.HasPage(adminOnlyPage) {
		t.Errorf("a care_agent with admin in extra_roles was granted %q — "+
			"admin in extra_roles must grant nothing", adminOnlyPage)
	}
	if secondary.CanSeeAllRows() {
		t.Error("a care_agent with admin in extra_roles sees every row — " +
			"seesAllRoles must not be reachable through extra_roles")
	}
	for _, r := range secondary.AllRoles() {
		if r == RoleAdmin {
			t.Error("AllRoles() returned admin from extra_roles; every role-derived " +
				"decision in the app reads this method, so it must not appear here")
		}
	}
}

// The fix must not break the real admin, and must not drop anyone's other secondary
// roles while filtering this one out.
func TestPrimaryAdminAndOtherSecondaryRolesStillWork(t *testing.T) {
	admin := &Claims{ID: 1, Role: RoleAdmin}
	if !admin.HasPage("admin_users") {
		t.Error("a primary admin lost page access")
	}
	if !admin.CanSeeAllRows() {
		t.Error("a primary admin lost row access")
	}

	// The live multi-team case: cards_head who also runs the call centre.
	multi := &Claims{ID: 2, Role: "cards_head", ExtraRoles: []string{"call_center_head", "care_head"}}
	got := multi.AllRoles()
	want := map[string]bool{"cards_head": true, "call_center_head": true, "care_head": true}
	if len(got) != len(want) {
		t.Fatalf("AllRoles() = %v, want the 3 real roles", got)
	}
	for _, r := range got {
		if !want[r] {
			t.Errorf("AllRoles() returned unexpected role %q", r)
		}
	}
	if !multi.HasPage("call_center_stats") {
		t.Error("a secondary call_center_head lost the page its role grants — " +
			"the admin filter must not drop legitimate secondary roles")
	}

	// Admin filtered out, the rest kept.
	mixed := &Claims{ID: 3, Role: "care_agent", ExtraRoles: []string{"admin", "cards_agent"}}
	if !mixed.HasPage("cards") {
		t.Error("filtering admin out of extra_roles also dropped cards_agent")
	}
	if mixed.HasPage("admin_users") {
		t.Error("admin still leaked through alongside another secondary role")
	}
}
