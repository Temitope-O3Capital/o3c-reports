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

// TestEmploymentTypesMatchTypeScript keeps the form's list and the Go whitelist identical.
// A value only the form offers is a 422 the applicant cannot fix; a value only Go accepts is
// one nobody can ever choose.
func TestEmploymentTypesMatchTypeScript(t *testing.T) {
	src, err := os.ReadFile("../../frontend/src/lib/employmentTypes.ts")
	if err != nil {
		t.Fatalf("read employmentTypes.ts: %v", err)
	}
	got := []string{}
	for _, m := range regexp.MustCompile(`value:\s*'([^']+)'`).FindAllStringSubmatch(string(src), -1) {
		got = append(got, m[1])
	}
	want := append([]string(nil), employmentTypes...)
	sort.Strings(want)
	sort.Strings(got)
	if strings.Join(want, ",") != strings.Join(got, ",") {
		t.Errorf("EMPLOYMENT_TYPES has drifted from employmentTypes.\n  Go: %v\n  TS: %v", want, got)
	}
}

// TestPhoenixEmploymentTypeSpeaksPhoenix pins the boundary translation.
//
// Phoenix's resolveEmploymentType accepts exactly employed / self_employed / business_owner /
// unemployed. Anything else becomes not_specified, and the scorer then reads a 0.20 variance
// threshold instead of employed's 0.15 — so a salaried borrower sent as "salaried" was judged
// less predictable than the model intends. That is the whole reason this function exists.
func TestPhoenixEmploymentTypeSpeaksPhoenix(t *testing.T) {
	phoenixAccepts := map[string]bool{
		"employed": true, "self_employed": true, "business_owner": true, "unemployed": true,
	}

	// Every value a form can now submit, and what Phoenix should receive.
	cases := map[string]string{
		"salaried":       "employed",
		"self_employed":  "self_employed",
		"business_owner": "business_owner",
		"unemployed":     "unemployed",
		// Deliberately NOT mapped — see employment_vocab.go. Phoenix has no category, and
		// inventing one would be a credit judgement dressed up as a data mapping.
		"contract": "contract",
		"retired":  "retired",
		// Legacy and hand-inserted spellings for salaried work.
		"permanent": "employed",
		"FULL_TIME": "employed",
	}
	for in, want := range cases {
		if got := phoenixEmploymentType(in); got != want {
			t.Errorf("phoenixEmploymentType(%q) = %q, want %q", in, got, want)
		}
	}

	// The one that was actually costing money: a salaried borrower must arrive as a word
	// Phoenix recognises, or the salaried model never runs.
	if !phoenixAccepts[phoenixEmploymentType("salaried")] {
		t.Error("a salaried applicant still reaches Phoenix as a word it does not accept, " +
			"so it scores them on the unknown 0.20 variance threshold instead of 0.15")
	}

	// Blank must stay blank: Phoenix's own fallback is better than a guess of ours.
	if got := phoenixEmploymentType(""); got != "" {
		t.Errorf("phoenixEmploymentType(\"\") = %q, want empty", got)
	}
}

// TestEmploymentTypeConstraintMatchesGo reads the CHECK out of the database.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestEmploymentTypeConstraintMatchesGo -v
func TestEmploymentTypeConstraintMatchesGo(t *testing.T) {
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

	rows, err := db.PGQuery(t.Context(),
		`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
		  WHERE conrelid='app.loan_applications'::regclass
		    AND conname='loan_applications_employment_type_chk'`)
	if err != nil || len(rows) == 0 {
		t.Fatal("loan_applications_employment_type_chk not found in the database")
	}
	def := str(rows[0]["def"])
	for _, v := range employmentTypes {
		if !strings.Contains(def, "'"+v+"'") {
			t.Errorf("the CHECK rejects %q but the handler accepts it — the applicant gets a 500:\n  %s", v, def)
		}
	}
}
