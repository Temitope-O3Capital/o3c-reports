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
// Every catalogue code and label must sit in exactly ONE of the three SQL lists. While
// those lists were hand-typed consts and the SQL CASE ended on `ELSE connected`, a new
// disposition belonged to no list and silently inherited "a human spoke" — which is how
// "Customer Rejected the Call" came to pull write-ups off zero-second rejected calls onto
// answered ones. Now the lists are derived from ccDisposition.Connected, so this test
// cannot fail for a newly added disposition; it fails if someone re-freezes them, or
// introduces a fourth state with nowhere to go.
func TestSQLDispositionListsAreExhaustive(t *testing.T) {
	noContact, ambiguous, conversation := sqlNoContactDispositions(), sqlAmbiguousDispositions(), sqlConversationDispositions()
	for _, d := range ccDispositions {
		for _, form := range []string{d.Code, d.Label} {
			n := 0
			for _, list := range []string{noContact, ambiguous, conversation} {
				if inSQLList(list, form) {
					n++
				}
			}
			if n != 1 {
				t.Errorf("%q (code %q) is in %d of the three SQL lists, want exactly 1 — "+
					"a disposition in none of them would be judged by the CASE's ELSE branch "+
					"rather than by a rule anyone wrote", form, d.Code, n)
			}
		}
	}
}
