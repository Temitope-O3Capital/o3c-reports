package handlers

import (
	"strings"
	"testing"
)

// THE PARTY LEADS, AND THAT IS A DECISION, NOT AN ACCIDENT.
//
// debtorNameSQL used to read recovery_cases.customer_name first, which looks like the
// right instinct — the row's own stored name, written by the arm that owns the row. It
// was measured and it was the weaker source:
//
//	recovery_cases.customer_name   85 of 1,617 cases (5.3%)
//	app.parties via party_id       97.3%
//	disagreeing where both exist   16 of 89 payments — same person, different
//	                               word order or spelling
//
// Because the Payment Approvals screen resolved the party directly while the Cases list
// came through this helper, one debtor appeared under two spellings on two screens of the
// same module. Both now call this function, so they cannot drift apart again.
//
// This test exists because nothing pinned the old ordering, so nothing would have caught
// it being flipped back — and flipping it back is a one-word change that would silently
// reintroduce two names for one person.
func TestDebtorNameLeadsWithTheParty(t *testing.T) {
	sql := debtorNameSQL("rc")

	iParty := strings.Index(sql, "pty.full_name")
	iStored := strings.Index(sql, "rc.customer_name")

	if iParty < 0 {
		t.Fatal("debtorNameSQL no longer reads the party name at all")
	}
	if iStored < 0 {
		t.Fatal("debtorNameSQL no longer falls back to the row's own stored name; " +
			"it names the rows whose party was never linked and must stay")
	}
	if iParty > iStored {
		t.Error("the party name must come BEFORE rc.customer_name: the stored column is " +
			"5.3% populated and disagrees with the party on 16 of 89 payments, so leading " +
			"with it reintroduces two spellings of one debtor across Recovery")
	}

	// The fallback chain must still end at the key itself rather than NULL: a nameless
	// row is a bug someone reports, but a row with neither name nor id is unactionable.
	if !strings.Contains(sql, "rc.account_cif") {
		t.Error("the chain must still fall back to the identifier, so no row renders blank")
	}

	// And it must never reach across namespaces. cbs.name and the cards master are
	// joined on namespace-guarded keys (see debtorJoinsSQL); what matters here is that
	// the party — which is keyed on the row's OWN party_id — is what leads.
	if strings.Index(sql, "cbs.name") < iParty {
		t.Error("a CBS name must not be preferred over the row's own party")
	}
}
