// newmigration claims a migration number that nobody else can take.
//
// THE PROBLEM IT SOLVES. Migration numbers were picked by hand: list the directory,
// take the next free number, write the file some minutes later. With several sessions
// working the same repository on the same afternoon that is a race, and it was lost
// twice on 2026-10-12 alone — 358 and 364 both claimed by two sessions, and in both
// cases BOTH files were applied in production before anyone saw the collision test go
// red. By then renaming is unsafe: schema_migrations records migrations by filename,
// so a rename makes the runner treat the file as new and run it a second time. Hence
// the grandfathered list in migrate_test.go, which should now stop growing.
//
// HOW THE CLAIM IS ATOMIC. The number is taken by CREATING the file with O_EXCL, so
// two sessions racing cannot both succeed — the loser gets EEXIST and tries the next
// number. The gap between choosing and claiming goes from minutes to nothing.
//
// WHY THE FILE IS .sql.draft AND NOT .sql. Writing a .sql file into migrations/ does
// not just claim a number, it SCHEDULES the migration: the backend embeds
// migrations/*.sql and applies every pending one at startup, so any session's deploy
// would run your half-written file. Both the embed pattern and migrate.Apply match on
// a .sql suffix, so a .sql.draft is invisible to them. The number is claimed, the SQL
// cannot run, and you promote it when you mean it:
//
//	go run ./cmd/newmigration -name the_thing_it_does   # claims the next free number
//	go run ./cmd/newmigration -promote 368              # draft -> live, when ready
//
// Promotion re-checks that no .sql has taken the number in the meantime, because the
// whole point is to never create the collision this tool exists to prevent.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const draftSuffix = ".sql.draft"

var numberPrefix = regexp.MustCompile(`^(\d+)_`)

// claimedNumbers returns every migration number already taken in dir, counting both
// live .sql files and .sql.draft claims. Counting the drafts is the point: a number a
// peer claimed two minutes ago is not free.
func claimedNumbers(dir string) (map[int]string, int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, 0, err
	}
	taken := map[int]string{}
	highest := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".sql") && !strings.HasSuffix(name, draftSuffix) {
			continue
		}
		m := numberPrefix.FindStringSubmatch(name)
		if m == nil {
			continue
		}
		n, convErr := strconv.Atoi(m[1])
		if convErr != nil {
			continue
		}
		// A number can legitimately be held by more than one file (the grandfathered
		// duplicates); first one seen is enough to mark it taken.
		if _, seen := taken[n]; !seen {
			taken[n] = name
		}
		if n > highest {
			highest = n
		}
	}
	return taken, highest, nil
}

// claim creates the draft for the first free number at or above start, using O_EXCL so
// the creation itself is the claim. Returns the number and the path.
func claim(dir, slug string, start int) (int, string, error) {
	taken, _, err := claimedNumbers(dir)
	if err != nil {
		return 0, "", err
	}
	for n := start; n < start+500; n++ {
		if _, busy := taken[n]; busy {
			continue
		}
		path := filepath.Join(dir, fmt.Sprintf("%03d_%s%s", n, slug, draftSuffix))
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if errors.Is(err, os.ErrExist) {
			continue // somebody claimed it between the listing and now; that is the race, handled
		}
		if err != nil {
			return 0, "", err
		}
		defer f.Close() //nolint:errcheck
		if _, err := f.WriteString(draftTemplate(n, slug)); err != nil {
			return 0, "", err
		}
		return n, path, nil
	}
	return 0, "", fmt.Errorf("no free migration number found from %d", start)
}

func draftTemplate(n int, slug string) string {
	title := strings.ReplaceAll(slug, "_", " ")
	return fmt.Sprintf(`-- %s
--
-- Write what this changes and WHY, in enough detail that the next person does not
-- have to reconstruct the reasoning from the SQL. The migrations in this directory
-- are the record of why the schema looks the way it does.
--
-- While this file ends in %s it is invisible to the migrator: the backend embeds
-- migrations/*.sql and applies every pending one at startup, so a half-written .sql
-- here would be run by the next deploy from any session. Promote it when it is ready:
--
--     go run ./cmd/newmigration -promote %d
--
-- Before you do, re-derive the blast radius against the LIVE schema rather than
-- trusting a dry run from yesterday — other sessions add tables and indexes daily.
-- Assert inside the migration (RAISE EXCEPTION) so it fails loudly rather than by luck.

`, title, draftSuffix, n)
}

// promote renames the draft to a live .sql, refusing if a .sql has taken the number in
// the meantime — which would be creating the very collision this tool prevents.
func promote(dir string, n int) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	prefix := fmt.Sprintf("%03d_", n)
	var draft, live string
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		switch {
		case strings.HasSuffix(name, draftSuffix):
			draft = name
		case strings.HasSuffix(name, ".sql"):
			live = name
		}
	}
	if draft == "" {
		return "", fmt.Errorf("no %s*%s to promote", prefix, draftSuffix)
	}
	if live != "" {
		return "", fmt.Errorf("%s already exists, so promoting %s would collide: "+
			"claim a fresh number instead", live, draft)
	}
	final := strings.TrimSuffix(draft, draftSuffix) + ".sql"
	if err := os.Rename(filepath.Join(dir, draft), filepath.Join(dir, final)); err != nil {
		return "", err
	}
	return final, nil
}

func main() {
	dir := flag.String("dir", "migrations", "migrations directory")
	name := flag.String("name", "", "snake_case description, e.g. a_dashboard_is_tiles")
	promoteN := flag.Int("promote", 0, "promote this migration number from draft to live")
	flag.Parse()

	if *promoteN > 0 {
		final, err := promote(*dir, *promoteN)
		if err != nil {
			fmt.Fprintln(os.Stderr, "promote failed:", err)
			os.Exit(1)
		}
		fmt.Println("promoted:", filepath.Join(*dir, final))
		fmt.Println("it is now LIVE: the next deploy from any session will apply it.")
		return
	}

	slug := strings.Trim(strings.ToLower(strings.ReplaceAll(*name, " ", "_")), "_")
	if slug == "" {
		fmt.Fprintln(os.Stderr, "need -name, e.g. -name the_thing_it_does")
		flag.Usage()
		os.Exit(2)
	}

	_, highest, err := claimedNumbers(*dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "reading", *dir, ":", err)
		os.Exit(1)
	}
	n, path, err := claim(*dir, slug, highest+1)
	if err != nil {
		fmt.Fprintln(os.Stderr, "claim failed:", err)
		os.Exit(1)
	}

	// The rollback stub is a draft too, so the pair is promoted together by hand and a
	// rollback never ships for a migration that was abandoned.
	rbDir := filepath.Join(*dir, "rollback")
	if _, statErr := os.Stat(rbDir); statErr == nil {
		rb := filepath.Join(rbDir, fmt.Sprintf("rollback_%03d%s", n, draftSuffix))
		if f, err := os.OpenFile(rb, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644); err == nil {
			fmt.Fprintf(f, "-- Undo %03d. Say what it does NOT undo, and why.\n", n)
			f.Close() //nolint:errcheck
			fmt.Println("rollback stub:", rb)
		}
	}

	fmt.Println("claimed:", path)
	fmt.Printf("number %d is now yours; nobody else can take it.\n", n)
	fmt.Printf("when ready:  go run ./cmd/newmigration -promote %d\n", n)
}
