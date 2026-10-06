package handlers

import (
	"database/sql"
	"os"
	"sort"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/workspace/core"
)

// The Go-side vocabulary lists must match the CHECK constraints on
// helpdesk_tickets exactly.
//
// When they drifted, the Zoho importer mapped Zoho's "escalated" to a status the
// column rejects and every such ticket was dropped on import — visible only as a
// warning line. This reads the constraints straight out of the database, so the
// two cannot diverge again without the build failing.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestTicketVocabularyMatchesConstraints -v
func TestTicketVocabularyMatchesConstraints(t *testing.T) {
	if os.Getenv("EXPORT_LIVE_TEST") != "1" {
		t.Skip("set EXPORT_LIVE_TEST=1")
	}
	env := readEnv(t, "../.env")
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}

	cases := []struct {
		constraint string
		got        []string
	}{
		{"helpdesk_tickets_status_check", ticketStatuses},
		{"helpdesk_tickets_priority_check", ticketPriorities},
		{"helpdesk_tickets_channel_check", ticketChannels},
	}

	for _, c := range cases {
		rows, err := db.PGQuery(t.Context(),
			`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
			  WHERE conrelid='app.helpdesk_tickets'::regclass AND conname=$1`, c.constraint)
		if err != nil || len(rows) == 0 {
			t.Errorf("%s: not found in the database", c.constraint)
			continue
		}
		def := str(rows[0]["def"])

		// Every value the Go list offers must be one the column accepts.
		for _, v := range c.got {
			if !strings.Contains(def, "'"+v+"'") {
				t.Errorf("%s rejects %q, but the importer can produce it — such a ticket "+
					"is dropped on import:\n  %s", c.constraint, v, def)
			}
		}

		// And the reverse: a value the column accepts but the list omits is a
		// mapping we silently downgrade to the fallback.
		var missing []string
		for _, v := range constraintValues(def) {
			found := false
			for _, g := range c.got {
				if g == v {
					found = true
				}
			}
			if !found {
				missing = append(missing, v)
			}
		}
		if len(missing) > 0 {
			sort.Strings(missing)
			t.Logf("%s also accepts %v — not offered by the importer (not an error, "+
				"but a value we will never write)", c.constraint, missing)
		}
	}
}

// constraintValues pulls the quoted literals out of a CHECK definition.
func constraintValues(def string) []string {
	var out []string
	for i := 0; i < len(def); i++ {
		if def[i] != '\'' {
			continue
		}
		j := strings.IndexByte(def[i+1:], '\'')
		if j < 0 {
			break
		}
		v := def[i+1 : i+1+j]
		if v != "" && !strings.Contains(v, "::") {
			out = append(out, v)
		}
		i += j + 1
	}
	return out
}

// inSQLList reports whether a wording appears in one of the rendered SQL IN lists.
// Package-level rather than a closure so both tests below read the same lists the same
// way — a second copy of this three-line comparison is how two tests come to disagree
// about what a list contains.
func inSQLList(list, s string) bool {
	return strings.Contains(list, "'"+strings.ToLower(strings.TrimSpace(s))+"'")
}

// TestDispositionVocabularyAgrees keeps the Go classifier and its SQL twin in
// step. They make the same judgement in two languages — Go for the HTTP path,
// SQL for the absorb query — and a disposition that drifts into only one of them
// is how a write-up silently lands on the wrong call again.
func TestDispositionVocabularyAgrees(t *testing.T) {
	// DERIVED from the catalogue, not frozen.
	//
	// This was a hand-written literal whose comment claimed it held "every disposition the
	// frontend can send". It did not, and because it never read ccDispositions, ADDING a
	// disposition could not fail this test. Eleven were added on 2026-09-28 and none was
	// covered — the gap surfaced only when a supervisor's screen began printing
	// `call_rejected` as a label. It also asserted on "Callback Scheduled", which is not a
	// label in ccDispositions at all.
	//
	// Every catalogue label AND code now flows through, so a new entry is covered the moment
	// it is added. The literals below are the legacy STORED forms — values still in the
	// column that the catalogue no longer produces — which is the only thing a frozen list
	// is the right tool for.
	all := []string{
		"Interested", "Not Interested", "Callback Scheduled", "Unreachable / No Answer",
		"Pending / Follow-up", "Issue Resolved", "no_answer", "wrong_number", "voicemail", "",
	}
	legacy := len(all)
	for _, d := range ccDispositions {
		all = append(all, d.Label, d.Code)
	}
	// Guards the derivation itself: if someone re-freezes the list, this fails loudly rather
	// than quietly covering nothing.
	if len(all) != legacy+2*len(ccDispositions) {
		t.Fatalf("the list is no longer derived from ccDispositions (%d entries for %d "+
			"dispositions) — a frozen list cannot fail when a disposition is added",
			len(all), len(ccDispositions))
	}
	for _, d := range all {
		expects, known := dispositionExpectsConversation(d)
		switch {
		case strings.TrimSpace(d) == "":
			if known {
				t.Errorf("empty disposition should be unknown")
			}
		case inSQLList(sqlNoContactDispositions(), d):
			if !known || expects {
				t.Errorf("%q is in the SQL no-contact list but Go says expects=%v known=%v", d, expects, known)
			}
		case inSQLList(sqlAmbiguousDispositions(), d):
			if known {
				t.Errorf("%q is in the SQL ambiguous list but Go treats it as known", d)
			}
		case inSQLList(sqlConversationDispositions(), d):
			if !known || !expects {
				t.Errorf("%q is in the SQL conversation list but Go says expects=%v known=%v", d, expects, known)
			}
		default:
			// SQL has no opinion on this exact wording — the SQL lists compare literal
			// text while Go normalises first, so a legacy stored form like "Interested"
			// reaches none of them. What must hold is that Go's answer comes from the
			// CATALOGUE ENTRY it resolved to, and never from a fall-through default.
			//
			// This branch is what the change is about. It used to read "in neither SQL
			// list, so Go must treat it as implying a conversation" — the deny-list
			// assumption, asserted as a test, which is why adding a disposition with
			// Connected:false could pass while behaving wrongly.
			code := ccDispositionCode(d)
			cat, ok := ccDispositionByCode(code)
			if !ok || code == "connected" || ccNoEvidenceDispositionCodes[code] {
				if known {
					t.Errorf("%q resolves to %q, which is no evidence either way, "+
						"but Go claims to know (expects=%v)", d, code, expects)
				}
				continue
			}
			if !known || expects != cat.Connected {
				t.Errorf("%q resolves to %q (Connected=%v) but Go says expects=%v known=%v",
					d, code, cat.Connected, expects, known)
			}
		}
	}
}

// TestSQLDispositionListsAreExhaustive is the allow-list property itself, as a test.
//
// EVERY WORDING THAT REACHES THE COLUMN must sit in exactly ONE of the three SQL lists,
// and Go must classify it the same way. While the lists were hand-typed consts and the
// CASE ended on `ELSE connected`, a new disposition belonged to no list and silently
// inherited "a human spoke" — which is how "Customer Rejected the Call" came to pull
// write-ups off zero-second rejected calls onto answered ones.
//
// The first version of this test only walked catalogue codes and labels, and that is
// exactly why it passed while the fix was still broken: the Call Log form's own wording
// ("not interested", "interested", "issue resolved" — 4,475 live rows) is in NEITHER form,
// so it fell to the ELSE and nothing noticed. It now walks ccAllDispositionWordings,
// which includes the legacy stored forms.
func TestSQLDispositionListsAreExhaustive(t *testing.T) {
	noContact, ambiguous, conversation := sqlNoContactDispositions(), sqlAmbiguousDispositions(), sqlConversationDispositions()
	for _, form := range ccAllDispositionWordings() {
		n := 0
		for _, list := range []string{noContact, ambiguous, conversation} {
			if inSQLList(list, form) {
				n++
			}
		}
		if n != 1 {
			t.Errorf("%q is in %d of the three SQL lists, want exactly 1 — a wording in "+
				"none of them is judged by the CASE's ELSE branch rather than by a rule "+
				"anyone wrote", form, n)
			continue
		}
		// And the list it landed in must be the one Go's own answer implies.
		expects, known := dispositionExpectsConversation(form)
		switch {
		case !known && !inSQLList(ambiguous, form):
			t.Errorf("%q: Go says it is no evidence, but SQL does not treat it as ambiguous", form)
		case known && expects && !inSQLList(conversation, form):
			t.Errorf("%q: Go says a human spoke, but SQL does not list it as a conversation", form)
		case known && !expects && !inSQLList(noContact, form):
			t.Errorf("%q: Go says nobody spoke, but SQL does not list it as no-contact", form)
		}
	}
}

// TestTheCallLogFormsOwnWordingIsCovered pins the three specific spellings the bug was
// about, by name and with their measured size, so a future refactor that rebuilds the
// lists from the catalogue alone fails here instead of in production.
//
// Measured 2026-10-06 in app.helpdesk_calls: "not interested" 3,768 rows (2nd most common
// disposition in the table), "interested" 696 (6th), "issue resolved" 11 — all three still
// arriving that day. Each is a conclusion you can only reach by speaking to someone, so
// each must classify as a conversation, in both languages.
func TestTheCallLogFormsOwnWordingIsCovered(t *testing.T) {
	for _, form := range []string{"not interested", "interested", "issue resolved"} {
		expects, known := dispositionExpectsConversation(form)
		if !known || !expects {
			t.Errorf("%q: expects=%v known=%v — the Call Log form sends this and it means "+
				"a conversation happened", form, expects, known)
		}
		if !inSQLList(sqlConversationDispositions(), form) {
			t.Errorf("%q is not in the SQL conversation list, so the absorb query cannot "+
				"tell it apart from a no-answer", form)
		}
	}
}

// TestEveryLiveDispositionIsClassified is the test the bug actually needed: it walks the
// wordings that are IN THE COLUMN, not the ones in the catalogue.
//
// Every distinct value of app.helpdesk_calls.disposition as measured 2026-10-06, with its
// row count. Each must land in exactly one of the three SQL lists, so none of them reaches
// the CASE's ELSE branch. Checking the catalogue instead of the column is precisely how
// "not interested" (3,768 rows) and "interested" (696) came to be classified by a
// fall-through — they are the Call Log form's own wording and appear in the catalogue in
// neither form.
//
// A new spelling appearing in the column will NOT fail this test, because the test cannot
// see the database. That is a real limit and the reason the counts are written down: when
// this list is next refreshed from a live query, a value that has to be added to
// ccLegacyDispositionWordings to pass is a value that was being judged by the ELSE.
func TestEveryLiveDispositionIsClassified(t *testing.T) {
	live := map[string]int{
		"unreachable / no answer":           29273,
		"not interested":                    3768,
		"callback scheduled":                2480,
		"not ready yet":                     2177,
		"not eligible":                      1672,
		"interested":                        696,
		"call dropped":                      680,
		"wrong number":                      387,
		"customer rejected the call":        282,
		"promise to pay":                    259,
		"do not call":                       132,
		"other — describe what happened":    113,
		"information sent — awaiting reply": 71,
		"closed":                            61,
		"rate or charges too high":          35,
		"paid":                              32,
		"converted":                         12,
		"issue resolved":                    11,
		"information provided":              10,
		"pending / follow-up":               7,
		"complaint logged":                  5,
		"escalated":                         4,
		"wants a product we do not offer":   4,
		"registration not completed":        2,
		"dispute":                           1,
	}
	lists := map[string]string{
		"no-contact":   sqlNoContactDispositions(),
		"ambiguous":    sqlAmbiguousDispositions(),
		"conversation": sqlConversationDispositions(),
	}
	for d, rows := range live {
		in := make([]string, 0, 3)
		for name, list := range lists {
			if inSQLList(list, d) {
				in = append(in, name)
			}
		}
		if len(in) != 1 {
			t.Errorf("%q (%d live rows) is in %v — want exactly one list. In none of them "+
				"it is judged by the CASE's ELSE branch, which is the bug this test exists "+
				"for; in more than one the lists overlap and the first branch silently wins.",
				d, rows, in)
		}
	}
}
