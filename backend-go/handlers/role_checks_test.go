package handlers

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

func claimsWith(primary string, extras ...string) *core.Claims {
	return &core.Claims{ID: 1, Role: primary, ExtraRoles: extras}
}

func TestCallerHasRoleCountsSecondaryRoles(t *testing.T) {
	cases := []struct {
		name  string
		user  *core.Claims
		roles []string
		want  bool
	}{
		{"primary matches", claimsWith("call_center_head"), []string{"call_center_head"}, true},
		{"no match at all", claimsWith("cards_agent"), []string{"call_center_head"}, false},

		// The two live accounts these gates used to refuse. Of 52 staff, 6 hold
		// secondary roles; these are the ones the handler checks got wrong.
		{"cards head who also runs the call centre",
			claimsWith("cards_head", "call_center_head", "care_head"),
			[]string{"call_center_head"}, true},
		{"CMO who oversees sales and BD",
			claimsWith("cmo", "sales_head", "bd_head"),
			[]string{"sales_head", "head_sales"}, true},

		{"second role in a multi-role gate", claimsWith("care_agent", "cards_agent"),
			[]string{"nobody", "cards_agent"}, true},
		{"nil caller is never allowed", nil, []string{"call_center_head"}, false},
		{"no roles named means no match", claimsWith("admin"), nil, false},

		// A blank role must never match a user with a blank primary role, or an
		// unauthenticated-ish Claims would satisfy a gate.
		{"blank never matches", claimsWith(""), []string{""}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := callerHasRole(c.user, c.roles...); got != c.want {
				t.Errorf("callerHasRole(%v, %v) = %v, want %v", c.user, c.roles, got, c.want)
			}
		})
	}
}

// core.HasPage and core.RequirePages treat admin as a PRIMARY-role superuser only
// (`c.Role == "admin"`). Routing admin through callerHasRole would hand out more
// access than the page system does, silently and in one commit. So the convention
// is: widen department roles, leave every `Role != "admin"` comparison alone.
//
// This is the kind of decision that gets undone by someone tidying up, so it is
// asserted rather than written in a comment and hoped for. If admin should become
// a role like any other, that is a deliberate change: update core.HasPage,
// admin.go's roleGrantsAdmin (which already counts admin in extra_roles, and so
// currently disagrees with HasPage), and then this test.
func TestAdminIsNeverWidenedToSecondaryRoles(t *testing.T) {
	// Allow the word inside the helper's own explanatory comment.
	call := regexp.MustCompile(`callerHasRole\([^)]*"admin"`)

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the handlers package: %v", err)
	}
	checked := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		checked++
		for _, hit := range call.FindAllString(string(src), -1) {
			t.Errorf("%s passes admin to callerHasRole (%q). core.HasPage grants admin on the "+
				"primary role only, so this would widen admin beyond the page system.", name, hit)
		}
	}
	if checked == 0 {
		t.Fatal("scanned no handler files, so this test proves nothing")
	}
	t.Logf("%d handler files scanned, admin not widened in any", checked)
}
