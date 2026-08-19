package handlers

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Scripted edits twice stripped the $1..$n placeholders out of SQL in this
// package — once from an INSERT (`VALUES (,,,,,,,,,,,,,,,,)`) and once from the
// call-log WHERE clause (`AND ( = ” OR customer_cif = )`). Both compiled, both
// shipped, and each broke a live page: Go cannot type-check the inside of a SQL
// string.
//
// These patterns are what that damage looks like. The check is syntactic and
// cheap — it does not parse SQL — but it catches the exact failure that reached
// production, which a compiler never will.
func TestNoStrippedSQLPlaceholders(t *testing.T) {
	patterns := []struct {
		name string
		re   *regexp.Regexp
	}{
		// VALUES (,,,)  — an argument list with empty slots.
		{"empty VALUES slot", regexp.MustCompile(`VALUES\s*\([^)]*(\(\s*,|,\s*,|,\s*\))`)},
		// ( = '' ...)   — a comparison whose left side vanished.
		{"comparison with no left side", regexp.MustCompile(`\(\s*=\s*'`)},
		// col = )  or  col = AND — a comparison whose right side vanished.
		{"comparison with no right side", regexp.MustCompile(`=\s*\)|=\s+(AND|OR)\s`)},
		// >= ::date — a cast with nothing to cast.
		{"cast with no operand", regexp.MustCompile(`(>=|<=|=|<|>)\s*::`)},
		// || || — a concatenation missing its middle.
		{"empty concatenation", regexp.MustCompile(`\|\|\s*\|\|`)},
	}

	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		for i, line := range strings.Split(string(src), "\n") {
			trimmed := strings.TrimSpace(line)
			// Skip Go comments; prose legitimately contains these shapes.
			if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "--") {
				continue
			}
			for _, p := range patterns {
				if p.re.MatchString(line) {
					t.Errorf("%s:%d: %s — SQL placeholders look stripped:\n  %s",
						f, i+1, p.name, trimmed)
				}
			}
		}
	}
}

// TestNoConcatenatedIntervalParams guards a bug that reached production twice: a
// bound parameter concatenated into a string and cast to interval, as in
// ($1 || ' months')::interval. The concatenation makes Postgres infer the
// parameter as text, and pgx then refuses to encode a number into it —
// "unable to encode 24 into text format for text (OID 25)". The query fails at
// execution, not compilation, so nothing catches it until a page 500s. It put
// "Internal server error" across the Sales Overview and silently disabled two
// SLA rules in batch.go whose errors were discarded.
//
// Use make_interval(months => $1) for whole units, or ($1 * interval '1 hour')
// when the value may be fractional.
func TestNoConcatenatedIntervalParams(t *testing.T) {
	// $n only — a plain identifier like (i || ' months') from generate_series is
	// an int column, which Postgres concatenates happily.
	bad := regexp.MustCompile(`\$\d+\s*\|\|\s*'[^']*'\s*\)\s*::\s*interval`)
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(src), "\n") {
			// Skip comments in both languages — the fixes carry the broken form in
			// a comment so the next reader knows what not to write.
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "--") {
				continue
			}
			if bad.MatchString(line) {
				t.Errorf("%s:%d: bound parameter concatenated into an interval — "+
					"pgx cannot encode a number as text. Use make_interval(...) or "+
					"($n * interval '1 unit').\n  %s", f, i+1, strings.TrimSpace(line))
			}
		}
	}
}
