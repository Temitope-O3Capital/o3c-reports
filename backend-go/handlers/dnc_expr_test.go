package handlers

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// ccNotOnDNCExpr drops its argument into a subquery over dnc_list, which has its own
// `phone` column. An UNQUALIFIED argument therefore resolves to dnc_list.phone and the
// comparison collapses to norm_phone(d.phone) = norm_phone(d.phone) — true for every
// listed row — so the expression reads FALSE for everyone and suppresses the whole
// table it was meant to filter.
//
// This is not a theoretical hazard. Three call sites in call_center_outbound.go passed
// "phone", and measured on the live database on 2026-09-23 the outbound queue served
// 0 of its 14,965 pending contacts while exactly 0 of them were genuinely on the
// do-not-call list. The campaign suppression added the same day nearly shipped with
// the identical mistake (23,188 of 23,188 contacts would have been skipped).
//
// The rule: the argument must be a qualified reference (alias.column or table.column)
// or a bind parameter. Anything else is rejected here rather than in production.
var dncExprCall = regexp.MustCompile(`ccNotOnDNCExpr\(\s*"([^"]*)"\s*\)`)

func TestDNCExprIsAlwaysQualified(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	checked := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		for _, m := range dncExprCall.FindAllStringSubmatch(string(src), -1) {
			arg := strings.TrimSpace(m[1])
			checked++
			// A bind parameter carries no column name, so it cannot be shadowed.
			if strings.HasPrefix(arg, "$") {
				continue
			}
			if !strings.Contains(arg, ".") {
				t.Errorf(`%s: ccNotOnDNCExpr(%q) is UNQUALIFIED — inside the subquery `+
					`that resolves to dnc_list.phone, so the check matches every listed `+
					`row and suppresses the entire table. Qualify it (e.g. `+
					`"call_center_contacts.phone").`, f, arg)
			}
		}
	}
	if checked == 0 {
		t.Fatal("found no ccNotOnDNCExpr call sites — the guard is not actually scanning anything")
	}
}

// The shape of the rendered SQL is what makes qualification necessary, so pin it:
// if the subquery ever stops selecting from a table with a `phone` column, this test
// and the rule it enforces should be revisited together.
func TestDNCExprShapeStillShadows(t *testing.T) {
	sql := ccNotOnDNCExpr("call_center_contacts.phone")
	if !strings.Contains(sql, "FROM dnc_list d") {
		t.Fatalf("ccNotOnDNCExpr no longer reads dnc_list; revisit TestDNCExprIsAlwaysQualified: %s", sql)
	}
	if !strings.Contains(sql, "length(norm_phone(d.phone)) = 10") {
		t.Error("the length()=10 guard is gone — a blank phone would match a blank listed " +
			"phone and suppress every contact with no number on file")
	}
	if !strings.Contains(sql, "norm_phone(call_center_contacts.phone)") {
		t.Errorf("argument was not interpolated where expected: %s", sql)
	}
}
