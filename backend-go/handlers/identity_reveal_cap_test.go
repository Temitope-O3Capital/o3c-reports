package handlers

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

/*
The identity reveal records every disclosure, which answers "who looked at this
customer". It did not answer "is someone copying the book" — the same page grant
that lets an agent verify one caller let them walk all 21,000 customers one BVN
at a time, leaving a tidy record of the theft. c360RevealDailyCap is the breadth
limit that closes that, and these tests pin its two load-bearing properties.
*/

// Counted per customer rather than per field: reading a caller's BVN and date of
// birth in one conversation must cost one, not two, or the limit starts biting
// ordinary verification instead of harvesting.
func TestTheRevealCapCountsCustomersNotFields(t *testing.T) {
	src, err := os.ReadFile("identity_reveal.go")
	if err != nil {
		t.Fatalf("read identity_reveal.go: %v", err)
	}
	s := string(src)
	if !strings.Contains(s, "count(DISTINCT entity_id)") {
		t.Error("the budget no longer counts distinct customers — a multi-field " +
			"verification would consume the whole allowance")
	}
	// An entity_id already revealed today must not be charged again.
	if !strings.Contains(s, "bool_or(entity_id = $2)") {
		t.Error("the budget no longer recognises an already-revealed customer")
	}
	if !strings.Contains(s, "!already && used >= c360RevealDailyCap") {
		t.Error("returning to an already-revealed customer now consumes budget")
	}
}

// Nothing may be disclosed before the limit has been checked, and the check must
// fail closed — the same stance the audit write already takes.
func TestTheRevealCapIsCheckedBeforeAnythingIsDisclosed(t *testing.T) {
	src, err := os.ReadFile("identity_reveal.go")
	if err != nil {
		t.Fatalf("read identity_reveal.go: %v", err)
	}
	s := string(src)
	budget := strings.Index(s, "c360RevealBudget(ctx, db, user.ID, entityID)")
	respond := strings.Index(s, `respond(w, out, "pg")`)
	audit := strings.Index(s, "c360AuditIdentityReveal(ctx, db, r,")
	if budget < 0 || respond < 0 || audit < 0 {
		t.Fatal("the reveal handler no longer has the shape these tests assume")
	}
	if budget > audit {
		t.Error("the limit is checked after the disclosure is recorded")
	}
	if budget > respond {
		t.Error("the limit is checked after the value is returned to the caller")
	}
}

// The cap has to be reachable only by breadth. A value small enough to hit during
// a busy shift would push people to work around the feature, which is how the
// masking stops being used at all.
func TestTheRevealCapIsSizedForBreadthNotDepth(t *testing.T) {
	if c360RevealDailyCap < 25 {
		t.Errorf("cap %d is low enough to catch ordinary verification work", c360RevealDailyCap)
	}
	if c360RevealDailyCap > 200 {
		t.Errorf("cap %d is high enough to harvest the customer base in weeks", c360RevealDailyCap)
	}
}

// The empty case is the one that must never block a first reveal: with no rows,
// count() is 0 but bool_or() is NULL, so the COALESCE is load-bearing. Read-only
// against a real database — it asserts the query's shape, and writes nothing.
func TestRevealBudgetHandlesAUserWithNoRevealsYet(t *testing.T) {
	url := os.Getenv("PGURL")
	if url == "" {
		t.Skip("set PGURL")
	}
	db, err := core.Open(&core.Config{PGURL: url, DirectPGURL: url})
	if err != nil {
		t.Fatal(err)
	}

	// An actor id that cannot have reveals, so the zero-row branch is exercised.
	used, already, err := c360RevealBudget(context.Background(), db, -1, "nobody")
	if err != nil {
		t.Fatalf("budget query failed against the real schema: %v", err)
	}
	if used != 0 {
		t.Errorf("used = %d for an actor with no reveals, want 0", used)
	}
	if already {
		t.Error("already = true for an actor with no reveals — NULL leaked through as true")
	}
	if used >= c360RevealDailyCap {
		t.Error("a user with no reveals would be refused their first one")
	}
}
