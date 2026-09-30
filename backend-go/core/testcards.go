package core

import (
	"regexp"
	"strings"
)

// Test-card name detection — one pattern, two renderings.
//
// WHY THIS FILE EXISTS. This pattern decides what is held OUT of the card book, the
// transaction ledger, the customer directory and therefore out of app.income_daily,
// app.income_by_currency and app.card_balances. It existed in SEVEN places:
//
//	backend-go/acctfeed/acctfeed.go     Go regexp — skips the card at ingest
//	backend-go/custfeed/ingest.go       Go regexp — skips the customer at ingest
//	backend-go/txnfeed/txnfeed.go       inline SQL ~* — keeps the txn out of the ledger
//	backend-go/handlers/customer360.go  inline SQL !~* — hides it from the directory
//	app.is_test_card_name               the SQL function, declared canonical (migration 293)
//	app."Accounts"                      inline SQL !~* (migration 213)
//	app."Products"                      inline SQL !~* (migration 214)
//
// Each of the four Go sites carried a comment reading "Must stay identical to
// app.is_test_card_name and the three other copies". That comment was the only thing holding
// them together, and grep for `is_test_card_name` in Go returned only those comments — the
// canonical function had no Go caller at all.
//
// THEY HAD ALREADY DRIFTED. Migration 293 built the SQL function around
// test|bevertec|dummy|fastest; the Go regexps never had `fastest`. So for a period the SQL
// excluded six real 2018 race-prize cards (FASTEST MALE/FEMALE, JNR/SNR — carrying balances and
// ATM withdrawals) from the books and the directory, while Go's ingest happily admitted them.
// Migration 312 removed `fastest` and brought the function and the four Go copies into
// agreement — but it counted five copies and there were seven, so the two views went on hiding
// those six people for another two weeks. Migration 316 pointed both views at the function.
//
// Both renderings here are derived from the token lists below, so the Go form and the SQL form
// cannot disagree, and there is one Go-side truth instead of four. The SQL FUNCTION remains a
// separate declaration — SQL cannot read Go — so two things watch it instead:
// TestSQLFunctionMatchesGo calls the deployed function over the corpus below when DATABASE_URL
// is set, and migration 316's guard fails the deploy if any other database object inlines the
// pattern again.
//
// The moral, at the cost of six customers: counting the copies is not finding them. Ask the
// catalogue (pg_get_viewdef, pg_proc.prosrc, pg_get_constraintdef), not a comment.

// Word-bounded tokens: matched only as whole words, so "Protest", "Latest" and "Ernest" are
// people rather than test artefacts. That boundary is the whole reason this is not a substring
// match.
var testCardWordTokens = []string{"test", "bevertec", "dummy"}

// Unbounded tokens: matched anywhere, because they appear glued to other text in real feed
// data ("O3TESTCARD01") and are unambiguous enough not to need a boundary.
var testCardSubstringTokens = []string{"testcard", "questtest"}

// Go form. RE2 uses \b for word boundaries; Postgres uses \m and \M. For ASCII input the two
// are equivalent — both word-character classes are [0-9A-Za-z_] — which is why the Go and SQL
// renderings can be generated from one token list.
var testCardNameRE = regexp.MustCompile(
	`(?i)\b(` + strings.Join(testCardWordTokens, "|") + `)\b|` +
		strings.Join(testCardSubstringTokens, "|"))

// IsTestCardName reports whether a cardholder or customer name is a test artefact rather than a
// person. Used at ingest by acctfeed and custfeed to keep the row out of the book entirely.
func IsTestCardName(name string) bool {
	return testCardNameRE.MatchString(name)
}

// TestCardNamePattern returns the pattern in POSTGRES syntax, for embedding in SQL that cannot
// call IsTestCardName — a predicate evaluated inside a statement, where pulling every row into
// Go to filter it would be absurd.
//
// Prefer app.is_test_card_name(col) in new SQL. This exists for the two places that already
// inline the pattern and for anything built before the function is reachable.
func TestCardNamePattern() string {
	return `\m(` + strings.Join(testCardWordTokens, "|") + `)\M|` +
		strings.Join(testCardSubstringTokens, "|")
}

// SQLIsTestCardName renders "this expression looks like a test name" for a WHERE clause.
// expr must be a column reference or a SQL expression, already qualified by the caller.
func SQLIsTestCardName(expr string) string {
	return expr + ` ~* '` + TestCardNamePattern() + `'`
}

// SQLIsNotTestCardName is the negation, which is what almost every caller actually wants —
// spelled out rather than left to each site to write, because a missing NOT here silently
// inverts a revenue filter and shows only the test cards.
func SQLIsNotTestCardName(expr string) string {
	return expr + ` !~* '` + TestCardNamePattern() + `'`
}

// ── Card stock ────────────────────────────────────────────────────────────────
//
// Pre-personalised Blink cards are loaded into app.customers with a sequential placeholder
// identity — "Blink 10", "BLINK 1000" — the placeholder phone 08000000000 and no email. There
// were 1,127 of them on 2026-09-30. They are card stock awaiting a real cardholder, not people.
//
// app.is_card_stock_name (migration 306, "card stock is not a customer") is the canonical
// declaration. It had ONE caller, app.customer_acquisition, so every other customer-facing
// query counted stock as customers: the retention heatmap read 665 new customers for Sep 2026
// where 591 were stock, and the Customer 360 directory listed all 1,127 with a canonical
// CUST-<party_id> beside each one.
//
// Rendered here for the same reason the test-card pattern is: so the Go side has one truth
// rather than a comment asking each site to stay in step.
//
// TWO THINGS THIS PATTERN DEPENDS ON, both easy to get wrong:
//
// It is anchored at BOTH ends and requires digits and nothing after them, so a real person or
// company cannot be caught — "Blinks Ltd" and a customer actually surnamed Blink do not match.
// Loosen the anchors and it starts hiding customers.
//
// It must be applied to the NAME COLUMN ALONE, not to the concatenation of
// full_name/first_name/last_name that the test-card predicate uses. Stock rows populate all
// three — full_name "Blink 21", first_name "Blink", last_name "21" — so the concatenation reads
// "Blink 21 Blink 21", which an anchored pattern correctly refuses to match. Passing the
// concatenation here silently matches nothing and the filter does nothing at all.
func CardStockNamePattern() string {
	return `^blink[[:space:]]*[0-9]+$`
}

// IsCardStockName is the Go rendering, for callers holding a name in memory.
func IsCardStockName(name string) bool {
	return cardStockRe.MatchString(strings.TrimSpace(name))
}

var cardStockRe = regexp.MustCompile(`(?i)` + CardStockNamePattern())

// SQLIsNotCardStockName renders "this name is not card stock" for a WHERE clause. btrim mirrors
// app.is_card_stock_name, which trims before matching, so a trailing space cannot smuggle a
// stock row through. Pass a single name column — see the note above.
func SQLIsNotCardStockName(expr string) string {
	return `btrim(COALESCE(` + expr + `,'')) !~* '` + CardStockNamePattern() + `'`
}
