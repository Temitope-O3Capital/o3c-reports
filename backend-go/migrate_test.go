package main

import (
	"io/fs"
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
	"258": true,
	"261": true,
	"275": true,
	"278": true,
	"280": true,
	"281": true,
	"287": true,
	"288": true,
	"289": true,
	"290": true,
}

var migrationNumberRE = regexp.MustCompile(`^(\d+)_`)

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
		t.Errorf("two migrations share a number, rename the newer one to the next free number:\n  %s", o)
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
