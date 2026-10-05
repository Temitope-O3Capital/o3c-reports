package handlers

import (
	"database/sql"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/workspace/core"
)

// The three copies of the collections contact vocabulary must agree: the Go whitelist, the
// CHECK constraint, and the TypeScript list the screen offers.
//
// This is the defect this whole area keeps producing. A value the screen can send but the
// column rejects is a 500 the agent cannot act on; a value the column accepts but the screen
// never offers is a category that silently splits every report. Neither is visible by reading
// one file, which is why it is asserted here instead.

// TestCollectionContactVocabularyMatchesTypeScript needs no database: it reads the TS source
// and compares it with the Go lists.
func TestCollectionContactVocabularyMatchesTypeScript(t *testing.T) {
	src, err := os.ReadFile("../../frontend/src/lib/contactVocab.ts")
	if err != nil {
		t.Fatalf("read contactVocab.ts: %v", err)
	}
	ts := string(src)

	cases := []struct {
		constName string
		goList    []string
	}{
		{"COLLECTION_CONTACT_OUTCOMES", collectionContactOutcomes},
		{"COLLECTION_CONTACT_DISPOSITIONS", collectionContactDispositions()},
		{"COLLECTION_CONTACT_TYPES", collectionContactTypes},
	}

	for _, c := range cases {
		got := tsVocabValues(t, ts, c.constName)
		if len(got) == 0 {
			t.Errorf("%s: found no values in contactVocab.ts — has it been renamed?", c.constName)
			continue
		}
		want := append([]string(nil), c.goList...)
		sort.Strings(want)
		sort.Strings(got)
		if strings.Join(want, ",") != strings.Join(got, ",") {
			t.Errorf("%s has drifted from its Go list.\n  Go: %v\n  TS: %v\n"+
				"A value in only one of these is either a 422 the agent cannot fix, or a "+
				"category that never gets offered.", c.constName, want, got)
		}
	}
}

// tsVocabValues pulls the `value:` strings out of one exported VocabOption array, or the plain
// strings out of a string array, so either shape in contactVocab.ts can be compared.
func tsVocabValues(t *testing.T, ts, constName string) []string {
	t.Helper()
	start := strings.Index(ts, "export const "+constName)
	if start < 0 {
		return nil
	}
	open := strings.Index(ts[start:], "[")
	if open < 0 {
		return nil
	}
	rest := ts[start+open:]
	end := strings.Index(rest, "\n]")
	if end < 0 {
		return nil
	}
	block := rest[:end]

	// { value: 'x', label: '…' } — the VocabOption shape.
	out := []string{}
	for _, m := range regexp.MustCompile(`value:\s*'([^']+)'`).FindAllStringSubmatch(block, -1) {
		out = append(out, m[1])
	}
	if len(out) > 0 {
		return out
	}
	// A bare string array.
	for _, m := range regexp.MustCompile(`'([^']+)'`).FindAllStringSubmatch(block, -1) {
		out = append(out, m[1])
	}
	return out
}

// TestCollectionContactVocabularyMatchesConstraints reads the CHECK constraints straight out of
// the database, the way TestTicketVocabularyMatchesConstraints does.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestCollectionContactVocabularyMatchesConstraints -v
func TestCollectionContactVocabularyMatchesConstraints(t *testing.T) {
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
		{"collection_contacts_outcome_chk", collectionContactOutcomes},
		{"collection_contacts_disposition_chk", collectionContactDispositions()},
		{"collection_contacts_type_chk", collectionContactTypes},
	}

	for _, c := range cases {
		rows, err := db.PGQuery(t.Context(),
			`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
			  WHERE conrelid='app.collection_contacts'::regclass AND conname=$1`, c.constraint)
		if err != nil || len(rows) == 0 {
			t.Errorf("%s: not found in the database", c.constraint)
			continue
		}
		def := str(rows[0]["def"])
		for _, v := range c.got {
			if !strings.Contains(def, "'"+v+"'") {
				t.Errorf("%s rejects %q, but the handler accepts it — the agent gets a 500:\n  %s",
					c.constraint, v, def)
			}
		}
	}
}
