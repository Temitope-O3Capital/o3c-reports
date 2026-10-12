package main

import (
	"io/fs"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Migrations are applied in filename order and recorded by filename, so two files
// sharing a number are not a hard error: the order is still deterministic. They are
// a hazard all the same. Whoever writes the second one has not seen the first, so
// neither author knows their work is adjacent, and if the two touch the same table
// the order that decides the outcome is whatever the rest of the filename sorts to.
//
// 44 pairs already exist and every one is applied in production. Renaming an applied
// migration makes the runner treat it as new and run it a second time, so history
// stays as it is. This test grandfathers those and fails on the 45th, which keeps the
// problem from growing while several people add migrations on the same day.
//
// If this fails: rename YOUR new file to the next free number. Do not add it below.
//
// And do not pick the number by hand next time — that is what loses this race. Picking
// from a directory listing and writing the file minutes later is a window other
// sessions land in, which is how 358 and 364 were both lost on 2026-10-12:
//
//	go run ./cmd/newmigration -name the_thing_it_does   # claims the number atomically
//	go run ./cmd/newmigration -promote 368              # draft -> live, when ready
//
// The claim is the file creation itself (O_EXCL), and it lands as .sql.draft so the
// number is reserved without the half-written migration becoming runnable. This list
// should not need another entry.
var grandfatheredDuplicateMigrations = map[string]bool{
	"079": true,
	"110": true,
	"124": true,
	"125": true,
	"126": true,
	"128": true,
	"132": true,
	"139": true,
	"141": true,
	"144": true,
	"149": true,
	"150": true,
	"152": true,
	"153": true,
	"154": true,
	"157": true,
	"159": true,
	"160": true,
	"161": true,
	"165": true,
	"176": true,
	"177": true,
	"181": true,
	"190": true,
	"201": true,
	"202": true,
	"203": true,
	"204": true,
	"205": true,
	"206": true,
	"207": true,
	"210": true,
	"211": true,
	"212": true,
	"216": true,
	"223": true,
	"239": true,
	"255": true,
	// 257, 259 and 260 were surfaced by the merge to main, not written against it:
	// each branch carried only part of the pair, so neither side collided on its own
	// and the union does. All eight files are recorded in schema_migrations on
	// production under their current names, so the rule above applies exactly as
	// written — renaming an applied migration would make the runner treat it as new
	// and run it a second time. Grandfathered for the same reason as the other 44.
	"257": true,
	"258": true,
	"259": true,
	"260": true,
	"261": true,
	"275": true,
	"278": true,
	"280": true,
	"281": true,
	"287": true,
	"288": true,
	"289": true,
	"290": true,
	// 291_feed_continuity and 291_odometa_follows_udara were both applied on
	// 2026-09-23 at 16:24:33, seconds apart, by two sessions working the same day.
	// Both are recorded in schema_migrations under their current names, so the rule
	// above applies: renaming either would make the runner treat it as new and run
	// it a second time. Grandfathered for the same reason as 290 just above.
	"291": true,
	// 321_say_what_actually_happens_next_and_nothing_else and
	// 321_a_dropdown_was_never_a_constraint were applied on 2026-09-30 at 11:31 and
	// 11:41, ten minutes apart, by two sessions working the same day — 291 all over
	// again. Both are recorded in schema_migrations under their current names, so the
	// rule above applies unchanged.
	//
	// A ledger-rewriting migration was written to rename one properly, then thrown
	// away: it would have been a third mechanism for something this list already
	// solves, and its own guard caught that 60 numbers are ALREADY shared in this
	// ledger going back to 079 — so "no number may be shared" was never the project's
	// rule. 'a_dropdown' re-adds CHECK constraints over a column it has already
	// rewritten, which is precisely the second run the rule exists to prevent.
	"321": true,
	// 358_a_dashboard_is_tiles_over_saved_sources and
	// 358_a_qualified_lead_actually_reaches_sales, 2026-10-12. Two sessions claimed
	// 358 on the same afternoon and BOTH were applied in the same restart, at
	// 15:37:05.59 and 15:37:05.97 — under a second apart, so neither author saw this
	// test go red before production had run both.
	//
	// That timing is what forces the entry. The instruction above is to rename your own
	// new file, and it is the right instruction while a file is still unapplied. Once
	// schema_migrations holds a filename, renaming it makes the runner treat the file
	// as new and run it a SECOND time — which for 'a_dashboard' means re-creating
	// objects it has already created. So renaming is now the unsafe option and this
	// list is the safe one, exactly as it was for 291 and 321.
	//
	// Authorised by Temitope on 2026-10-12 after the alternative was explained.
	"358": true,
	// 364_every_open_lead_sits_with_someone_who_can_visit_it and
	// 364_one_ledger_for_every_whatsapp_message, 2026-10-12. The same evening as 358
	// and for the same reason: both were applied — 20:22:31 and 20:31:05, nine minutes
	// apart — before either author saw this test go red, so renaming either one now
	// makes the runner treat it as new and run it a second time.
	//
	// Two collisions in one evening is the signal worth reading here. This is not
	// carelessness, it is several sessions picking the next free number from the same
	// directory within minutes of each other. If it keeps happening, the fix is to
	// stop numbering by hand, not to keep extending this list.
	"364": true,
	// 365_an_approved_payment_names_its_approver and
	// 365_every_held_lead_has_a_first_action, 2026-10-12. Applied 20:17:05 and 21:02:14.
	//
	// The THIRD collision of the same evening, after 358 and 364. Three in one day is
	// not three mistakes; it is one broken mechanism, and the entry above saying "if it
	// keeps happening, the fix is to stop numbering by hand" was written forty minutes
	// before this one happened. So that is now done: cmd/newmigration claims a number by
	// creating the file with O_EXCL, which is a claim nobody can lose, and lands it as
	// .sql.draft so reserving a number does not also schedule a half-written migration.
	// TestNoLiveMigrationTakesAClaimedNumber enforces the reservation, because the
	// embedded FS the test above reads cannot see a draft.
	//
	// This should be the last entry in this list.
	"365": true,
}

var migrationNumberRE = regexp.MustCompile(`^(\d+)_`)

// A .sql must not land on a number a .sql.draft has already claimed.
//
// This reads the REAL directory rather than migrationFiles, and that is the point:
// //go:embed migrations/*.sql cannot see a draft, so the collision test above is blind
// to exactly the reservations that exist to prevent collisions. Without this, claiming
// a number would be advisory.
func TestNoLiveMigrationTakesAClaimedNumber(t *testing.T) {
	entries, err := os.ReadDir("migrations")
	if err != nil {
		t.Fatalf("read migrations from disk: %v", err)
	}

	drafts := map[string]string{}
	live := map[string][]string{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		m := migrationNumberRE.FindStringSubmatch(name)
		if m == nil {
			continue
		}
		switch {
		case strings.HasSuffix(name, ".sql.draft"):
			drafts[m[1]] = name
		case strings.HasSuffix(name, ".sql"):
			live[m[1]] = append(live[m[1]], name)
		}
	}

	for number, draft := range drafts {
		if names, clash := live[number]; clash {
			t.Errorf("%s is claimed by %s but %s also uses it. Claim a fresh number with "+
				"`go run ./cmd/newmigration -name ...` rather than taking a reserved one.",
				number, draft, strings.Join(names, ", "))
		}
	}

	// Two drafts on one number would mean the atomic claim is not atomic.
	seen := map[string]string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".sql.draft") {
			continue
		}
		m := migrationNumberRE.FindStringSubmatch(name)
		if m == nil {
			continue
		}
		if prev, dup := seen[m[1]]; dup {
			t.Errorf("two drafts claim %s (%s and %s) — the O_EXCL claim in "+
				"cmd/newmigration should make this impossible", m[1], prev, name)
		}
		seen[m[1]] = name
	}

	if len(drafts) > 0 {
		t.Logf("%d migration number(s) reserved by a draft", len(drafts))
	}
}

func TestMigrationNumbersDoNotCollide(t *testing.T) {
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}

	byNumber := map[string][]string{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		if m := migrationNumberRE.FindStringSubmatch(e.Name()); m != nil {
			byNumber[m[1]] = append(byNumber[m[1]], e.Name())
		}
	}

	var offenders []string
	for number, names := range byNumber {
		if len(names) > 1 && !grandfatheredDuplicateMigrations[number] {
			sort.Strings(names)
			offenders = append(offenders, number+": "+strings.Join(names, ", "))
		}
	}
	sort.Strings(offenders)

	for _, o := range offenders {
		t.Errorf("two migrations share a number:\n  %s\nRename YOUR new file, and claim the "+
			"replacement with `go run ./cmd/newmigration -name ...` so it cannot happen "+
			"again. If BOTH files are already in schema_migrations, renaming would run one "+
			"a second time — grandfather the number instead and say why.", o)
	}
}

// A migration that only moves data can opt out of halting startup. Guard the marker
// so a rename or a refactor of the helper cannot quietly disarm it.
func TestNonBlockingMarkerIsRecognised(t *testing.T) {
	cases := []struct {
		name string
		sql  string
		want bool
	}{
		{"plain schema migration", "ALTER TABLE app.x ADD COLUMN y int;", false},
		{"marked in the header", "-- 284 — collapse dupes. @nonblocking: data only.\nUPDATE app.x SET y = 1;", true},
		{"marker past the header window", "-- " + strings.Repeat("padding ", 700) + "\n-- @nonblocking\n", false},
	}
	for _, c := range cases {
		if got := migrationIsNonBlocking([]byte(c.sql)); got != c.want {
			t.Errorf("%s: migrationIsNonBlocking = %v, want %v", c.name, got, c.want)
		}
	}
}
