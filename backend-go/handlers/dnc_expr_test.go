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

// This canary did its job, and is rewritten here to match what it caught.
//
// It used to pin that the expression selected `FROM dnc_list d`, precisely so that if the
// subquery ever stopped reading a table with a `phone` column, this test and
// TestDNCExprIsAlwaysQualified would be revisited together. On 2026-09-29 the expression was
// changed to delegate to app.is_suppressed — which checks contact_suppressions AND dnc_list,
// closing a gap where the dialler and the campaign sender honoured only the latter while
// dunning honoured both — and this test failed exactly as intended.
//
// All three of its original concerns are still enforced, now inside the SQL function:
// dnc_list is read by app.is_suppressed for call/sms/whatsapp, and the length()=10 blank-phone
// guard lives there too (`length(app.norm_phone(p_phone)) = 10` on both branches). What is
// pinned here is the delegation itself — if it ever unwinds back to an inline subquery, the
// shadowing hazard returns and the qualification rule becomes load-bearing again.
func TestDNCExprDelegatesToTheOneSuppressionRule(t *testing.T) {
	sql := ccNotOnDNCExpr("call_center_contacts.phone")

	// Schema-qualified: unqualified would resolve through search_path, and this decides
	// whether someone who opted out gets called.
	if !strings.Contains(sql, "app.is_suppressed(") {
		t.Fatalf("ccNotOnDNCExpr no longer delegates to app.is_suppressed — if it has gone "+
			"back to an inline dnc_list subquery the shadowing hazard is live again, and "+
			"TestDNCExprIsAlwaysQualified becomes load-bearing rather than belt-and-braces: %s", sql)
	}
	if !strings.Contains(sql, "call_center_contacts.phone") {
		t.Errorf("argument was not interpolated where expected: %s", sql)
	}
	// The voice channel, so app.is_suppressed's dnc_list branch applies at all.
	if !strings.Contains(sql, "'call'") {
		t.Errorf("the dial path must ask about the 'call' channel or dnc_list is skipped: %s", sql)
	}
	// It must NEGATE. A missing NOT inverts the rule and calls exactly the people who asked
	// not to be called — the same shape of failure as the shadowing bug.
	if !strings.HasPrefix(strings.TrimSpace(sql), "NOT ") {
		t.Errorf("expression does not negate: %s", sql)
	}

	// Each channel the campaign sender uses must carry its own value, or a suppression
	// recorded specifically against 'sms' is silently missed on an SMS send.
	for _, ch := range []string{"sms", "whatsapp"} {
		got := ccNotSuppressedExpr("campaign_contacts.phone", ch)
		if !strings.Contains(got, "'"+ch+"'") {
			t.Errorf("channel %q not carried into the expression: %s", ch, got)
		}
	}
}
