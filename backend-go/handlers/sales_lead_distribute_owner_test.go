package handlers

import (
	"strings"
	"testing"
)

// Whose leads a distribution may move is the one rule in this handler that can cause
// irreversible harm if it is wrong: too narrow and a head cannot deal their own stack,
// too wide and pressing Distribute takes work off a colleague with no warning and no
// undo. It is also built twice, for the pool query and for the UPDATE, with different
// placeholder numbers — so it lives in one function and is asserted here.
//
// The case behind include_mine: migration 317 dealt 185 unowned forwarded leads to the
// four hub heads, saying a head "allocates within their own team, which is a decision
// about people that belongs to them and not to this migration". Nothing was built for
// them to make that allocation, because Distribute read only sales_owner_id IS NULL. 161
// leads were still parked on four heads weeks later, two of them holding 72 each, while
// five Abuja officers had never been given a single lead.
func TestDistributeOwnerClauseWidensOnlyToTheCaller(t *testing.T) {
	// Default: the unowned pool and nothing else. This is the behaviour every existing
	// caller gets, and it must not change.
	plain := distributeOwnerClause(false, 9)
	if plain != "AND sales_owner_id IS NULL" {
		t.Fatalf("the default clause changed: %q — every Distribute press now has a "+
			"different reach than the one the page was written against", plain)
	}
	if strings.Contains(plain, "$") {
		t.Error("the default clause binds a parameter it was not given an argument for")
	}

	mine := distributeOwnerClause(true, 3)

	// Unowned leads must still be included: include_mine ADDS the caller's stack, it does
	// not swap the pool out for it. Losing this would mean a head who ticks the box stops
	// dealing the pool they actually came to deal.
	if !strings.Contains(mine, "sales_owner_id IS NULL") {
		t.Error("include_mine dropped the unowned pool — ticking the box would stop the " +
			"leads nobody owns from being dealt at all")
	}

	// And it must widen to the CALLER, by parameter, at the index it was handed. A
	// hard-coded index is how the pool query (which numbers its own arguments) and the
	// UPDATE (which does not) silently disagree.
	if !strings.Contains(mine, "sales_owner_id = $3") {
		t.Errorf("include_mine does not bind the caller at the index it was given: %q", mine)
	}

	// The whole safety property, stated once: there is no third party in this clause.
	// Everything it can reach is either unowned or the caller's own.
	for _, forbidden := range []string{"ANY(", "IN (SELECT", "sales_owner_id IS NOT NULL", "!=", "<>"} {
		if strings.Contains(mine, forbidden) {
			t.Errorf("include_mine clause contains %q — it can reach leads that are neither "+
				"unowned nor the caller's, which is the one thing it must never do: %q",
				forbidden, mine)
		}
	}

	// The index is honoured rather than ignored, so the two call sites cannot drift.
	if other := distributeOwnerClause(true, 7); !strings.Contains(other, "$7") {
		t.Errorf("the argument index is ignored: %q", other)
	}
}
