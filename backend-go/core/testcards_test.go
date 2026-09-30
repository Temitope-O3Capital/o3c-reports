package core

import (
	"database/sql"
	"os"
	"regexp"
	"strings"
	"testing"
)

// The corpus. Every entry is either a name observed in the live card/customer feed or a
// near-miss that an over-eager pattern would swallow. The near-misses are the reason this
// is a word-boundary match and not a substring match, and they are the cases a future
// "simplification" of the pattern would break.
var testCardCorpus = []struct {
	name string
	want bool
	why  string
}{
	// Real test artefacts that must stay out of the books.
	{"O3CAPITAL TEST CARD", true, "the canonical test card"},
	{"Test", true, "bare token"},
	{"BEVERTEC CST", true, "the card vendor's own cards"},
	{"Bevertec", true, "vendor, mixed case"},
	{"DUMMY ACCOUNT", true, "dummy"},
	{"O3TESTCARD01", true, "testcard glued to other text — why that token is unbounded"},
	{"questtest", true, "vendor test harness, also unbounded"},
	{"QUESTTEST001", true, "questtest with a suffix"},

	// The migration-312 regression. These are six real 2018 race-prize cardholders who
	// carried balances and made ATM withdrawals. While app.is_test_card_name included
	// 'fastest', the SQL copies hid them from the customer directory and kept their
	// withdrawals out of the ledger while Go's ingest admitted them. If 'fastest' ever
	// comes back, this is what says so.
	{"FASTEST MALE", false, "2018 race prize winner, a real cardholder"},
	{"FASTEST FEMALE", false, "2018 race prize winner, a real cardholder"},
	{"FASTEST JNR MALE", false, "2018 race prize winner, a real cardholder"},
	{"FASTEST SNR FEMALE", false, "2018 race prize winner, a real cardholder"},

	// Real people whose names contain the letters but not the word. A substring match on
	// 'test' deletes all of these from the card book.
	{"Ernest Okoro", false, "Ernest contains 'nest', not the word test"},
	{"Protest Ventures Ltd", false, "Protest is not test"},
	{"Latest Choice Enterprises", false, "Latest is not test"},
	{"Contestant Holdings", false, "Contestant is not test"},
	{"Adedummy", false, "not the word dummy"},

	// Ordinary names, the overwhelming majority of the book.
	{"Onafowokan Olayiwola", false, "ordinary name"},
	{"GLISTER HOME APPLIANCES", false, "ordinary corporate name"},
	{"", false, "blank name is not a test card"},
}

func TestIsTestCardName(t *testing.T) {
	for _, c := range testCardCorpus {
		if got := IsTestCardName(c.name); got != c.want {
			t.Errorf("IsTestCardName(%q) = %v, want %v — %s", c.name, got, c.want, c.why)
		}
	}
}

// TestGoAndSQLFormsAgree is the point of the whole file. Postgres spells a word boundary
// \m…\M and RE2 spells it \b…\b; for ASCII input the word-character classes are identical,
// so translating the boundaries is a faithful conversion. Translate the SQL rendering into
// RE2 and it must accept and reject exactly what IsTestCardName does.
//
// This is what the four "Must stay identical to" comments used to assert and could not
// enforce. If someone edits TestCardNamePattern without touching the token lists, or adds
// a token that behaves differently bounded than unbounded, this fails.
func TestGoAndSQLFormsAgree(t *testing.T) {
	pg := TestCardNamePattern()
	if strings.Contains(pg, `\b`) {
		t.Fatalf("pattern %q uses RE2's \b; Postgres does not understand it", pg)
	}
	translated := strings.NewReplacer(`\m`, `\b`, `\M`, `\b`).Replace(pg)
	re, err := regexp.Compile(`(?i)` + translated)
	if err != nil {
		t.Fatalf("SQL rendering does not translate to a valid RE2 pattern: %v", err)
	}
	for _, c := range testCardCorpus {
		if got := re.MatchString(c.name); got != IsTestCardName(c.name) {
			t.Errorf("Go and SQL renderings disagree on %q: SQL=%v Go=%v — %s",
				c.name, got, IsTestCardName(c.name), c.why)
		}
	}
}

// The negation is generated, so a caller cannot forget the NOT. Assert it actually inverts
// rather than trusting the two string literals to stay in step.
func TestSQLRenderingsAreOppositeOperators(t *testing.T) {
	pos, neg := SQLIsTestCardName("c.name"), SQLIsNotTestCardName("c.name")
	if !strings.Contains(pos, ` ~* '`) || strings.Contains(pos, `!~*`) {
		t.Errorf("SQLIsTestCardName should use ~*, got %q", pos)
	}
	if !strings.Contains(neg, ` !~* '`) {
		t.Errorf("SQLIsNotTestCardName should use !~*, got %q", neg)
	}
	if strings.Replace(neg, `!~*`, `~*`, 1) != pos {
		t.Errorf("the two renderings differ by more than the operator:\n pos %q\n neg %q", pos, neg)
	}
}

// TestSQLFunctionMatchesGo closes the last gap: app.is_test_card_name is declared canonical
// and has no Go caller at all, so nothing has ever compared the deployed function against
// the Go pattern. Migration 293 and the Go regexps disagreed over 'fastest' for a period,
// and the only reason anybody found out was reading all five copies by hand.
//
// Read-only — it calls a pure function, touches no table. Skipped without DATABASE_URL so
// `go test ./core/` stays green on a machine with no database.
func TestSQLFunctionMatchesGo(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping the live check against app.is_test_card_name")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close() //nolint:errcheck

	for _, c := range testCardCorpus {
		var got bool
		if err := db.QueryRow(`SELECT app.is_test_card_name($1)`, c.name).Scan(&got); err != nil {
			t.Fatalf("app.is_test_card_name(%q): %v", c.name, err)
		}
		if got != c.want {
			t.Errorf("app.is_test_card_name(%q) = %v, want %v — %s (the deployed SQL function "+
				"has drifted from core.IsTestCardName)", c.name, got, c.want, c.why)
		}
	}
}

// ── Card stock ────────────────────────────────────────────────────────────────

// cardStockCorpus pins the boundary cases. The two that matter are the last four: a real person
// or company whose name merely starts with "blink" must NOT be treated as stock, because the
// consequence of a false positive here is a paying customer vanishing from the directory.
var cardStockCorpus = []struct {
	name  string
	stock bool
}{
	{"Blink 10", true},
	{"BLINK 1000", true},
	{"blink 7", true},
	{"Blink10", true},      // the missing space seen in the feed
	{"  Blink 21  ", true}, // trimmed before matching
	{"Blink", false},       // no number
	{"Blink 10A", false},   // trailing letter
	{"Blinks Ltd", false},
	{"Mary Blink", false},
	{"Blink Nigeria Limited", false},
	{"", false},
}

func TestIsCardStockName(t *testing.T) {
	for _, c := range cardStockCorpus {
		if got := IsCardStockName(c.name); got != c.stock {
			t.Errorf("IsCardStockName(%q) = %v, want %v", c.name, got, c.stock)
		}
	}
}

// The SQL function is a separate declaration and SQL cannot read Go, so this is what stops the
// two drifting — the same guard the test-card pattern has, and the same reason: a pattern that
// exists twice has already started to disagree.
func TestSQLCardStockFunctionMatchesGo(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping the live check against app.is_card_stock_name")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close() //nolint:errcheck

	for _, c := range cardStockCorpus {
		var fromFunction, fromPattern bool
		if err := db.QueryRow(`SELECT app.is_card_stock_name($1)`, c.name).Scan(&fromFunction); err != nil {
			t.Fatalf("app.is_card_stock_name(%q): %v", c.name, err)
		}
		// The rendered predicate is the negation, so invert it to compare.
		q := `SELECT NOT (` + SQLIsNotCardStockName(`$1::text`) + `)`
		if err := db.QueryRow(q, c.name).Scan(&fromPattern); err != nil {
			t.Fatalf("rendered predicate for %q: %v", c.name, err)
		}
		if fromFunction != c.stock {
			t.Errorf("app.is_card_stock_name(%q) = %v, want %v — the SQL function has drifted from Go",
				c.name, fromFunction, c.stock)
		}
		if fromPattern != c.stock {
			t.Errorf("SQLIsNotCardStockName(%q) says stock=%v, want %v", c.name, fromPattern, c.stock)
		}
	}
}
