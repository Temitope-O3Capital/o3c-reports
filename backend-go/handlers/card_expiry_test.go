package handlers

import (
	"context"
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

// The MD's request, run through the export engine exactly as the Report Builder
// would run it.
//
// "All expired O3 credit cards with zero balance" was unaskable here until
// 2026-10-25: the card dataset exposed limit, balance, utilisation and days
// overdue but not the expiry date, and the date-range filter is wired to
// opened_date. These tests pin the two halves of the fix — that expiry is now a
// column, and that the Expired filter compares against current_date so a saved
// report stays correct tomorrow.

func cardTestDB(t *testing.T) *core.DB {
	t.Helper()
	return teamTestDB(t)
}

func TestTheCardBookExposesExpiry(t *testing.T) {
	d, ok := exportDatasetByKey("card_accounts")
	if !ok {
		t.Fatal("card_accounts is not a dataset")
	}
	if _, ok := d.colByKey("card_expiry_date"); !ok {
		t.Error("card_expiry_date is not a column, so the Report Builder cannot show or filter on it")
	}
	if _, ok := d.filterByKey("expiry_state"); !ok {
		t.Error("there is no expiry_state filter, so expired cards can only be found by typing a date")
	}
}

// A saved report must not rot. A filter written as "expiry before 2026-10-25" is
// wrong the next day and silently so: it keeps the cards that expired before that
// date and drops everything that expired since.
func TestTheExpiredFilterIsRelativeToToday(t *testing.T) {
	d, _ := exportDatasetByKey("card_accounts")
	f, ok := d.filterByKey("expiry_state")
	if !ok {
		t.Fatal("no expiry_state filter")
	}
	if !cardContains(f.Expr, "current_date") {
		t.Errorf("the expiry filter does not compare to current_date, so a saved report goes stale: %q", f.Expr)
	}
}

func cardContains(hay, needle string) bool {
	return len(hay) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(hay); i++ {
			if hay[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}

// The whole request, end to end through the same builder the export endpoint
// uses, checked against a hand-written count.
func TestExpiredZeroBalanceMatchesAHandCount(t *testing.T) {
	db := cardTestDB(t)
	d, _ := exportDatasetByKey("card_accounts")

	req := exportRequest{
		Dataset: "card_accounts",
		Filters: map[string]string{"expiry_state": "Expired"},
		ColFilters: []colFilter{
			{Column: "current_dr_balance", Op: "lte", Value: "0"},
		},
	}
	q, args, _, err := buildExportCountQuery(d, req)
	if err != nil {
		t.Fatalf("the engine refused the request: %v", err)
	}
	rows, err := db.PGQuery(context.Background(), q, args...)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	got := asInt(rows[0]["n"])

	hand, err := db.PGQuery(context.Background(), `
		SELECT COUNT(*) AS n FROM app.accounts
		WHERE card_expiry_date < current_date
		  AND COALESCE(current_dr_balance, 0) <= 0`)
	if err != nil {
		t.Fatalf("hand count: %v", err)
	}
	want := asInt(hand[0]["n"])

	t.Logf("engine %d, hand-written %d", got, want)
	if got != want {
		t.Errorf("the Report Builder would return %d rows where the direct query returns %d", got, want)
	}
	if got == 0 {
		t.Error("the filter matched nothing, which cannot be right for this book")
	}
}

// Current and expired must partition the book with the no-expiry rows, or one of
// the three options is quietly dropping cards.
func TestTheThreeExpiryStatesAccountForEveryCard(t *testing.T) {
	db := cardTestDB(t)
	d, _ := exportDatasetByKey("card_accounts")

	total := int64(0)
	for _, state := range []string{"Expired", "Current", "No expiry date"} {
		q, args, _, err := buildExportCountQuery(d, exportRequest{
			Dataset: "card_accounts",
			Filters: map[string]string{"expiry_state": state},
		})
		if err != nil {
			t.Fatalf("%s: %v", state, err)
		}
		rows, err := db.PGQuery(context.Background(), q, args...)
		if err != nil {
			t.Fatalf("%s: %v", state, err)
		}
		n := asInt(rows[0]["n"])
		t.Logf("%-16s %d", state, n)
		total += n
	}

	all, err := db.PGQuery(context.Background(), `SELECT COUNT(*) AS n FROM app.accounts`)
	if err != nil {
		t.Fatal(err)
	}
	if want := asInt(all[0]["n"]); total != want {
		t.Errorf("the three states sum to %d but the book holds %d", total, want)
	}
}

// The cardholder join, added so the MD's report can carry a BVN column.
//
// A join on CIF is the thing this codebase has been bitten by before, so these
// test the two failure modes rather than the happy path: that adding the relation
// cannot change the number of cards returned, and that the BVN never comes back
// whole.
func TestTheCardholderJoinCannotDuplicateACard(t *testing.T) {
	db := cardTestDB(t)
	admin := &core.Claims{ID: 1, Role: "admin", FullName: "Test Admin"}

	base, _ := exportDatasetByKey("card_accounts")
	plain, args, _, err := buildExportCountQuery(base, exportRequest{Dataset: "card_accounts"})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := db.PGQuery(context.Background(), plain, args...)
	if err != nil {
		t.Fatal(err)
	}
	want := asInt(rows[0]["n"])

	joined, err := datasetWithRelations(base, []string{"cardholder"}, admin)
	if err != nil {
		t.Fatalf("the cardholder relation was refused: %v", err)
	}
	q2, a2, _, err := buildExportCountQuery(joined, exportRequest{
		Dataset: "card_accounts", Relations: []string{"cardholder"},
	})
	if err != nil {
		t.Fatal(err)
	}
	rows2, err := db.PGQuery(context.Background(), q2, a2...)
	if err != nil {
		t.Fatalf("joined count: %v", err)
	}
	got := asInt(rows2[0]["n"])

	t.Logf("cards %d, cards with the cardholder join %d", want, got)
	if got != want {
		t.Errorf("joining the cardholder changed the row count from %d to %d, so it is duplicating cards", want, got)
	}
}

// A whole BVN must never leave this report, however it is asked for. The column
// is last-four only, plus a yes/no for whether one is held.
func TestTheCardholderJoinNeverReturnsAWholeBVN(t *testing.T) {
	db := cardTestDB(t)
	admin := &core.Claims{ID: 1, Role: "admin", FullName: "Test Admin"}

	base, _ := exportDatasetByKey("card_accounts")
	joined, err := datasetWithRelations(base, []string{"cardholder"}, admin)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range joined.Cols {
		if c.Key == "cardholder__bvn" || c.Label == "BVN" {
			t.Errorf("the join exposes %q, which would put whole BVNs in a spreadsheet", c.Key)
		}
	}

	q, args, cols, err := buildExportQuery(joined, exportRequest{
		Dataset:   "card_accounts",
		Relations: []string{"cardholder"},
		Filters:   map[string]string{"expiry_state": "Expired"},
	}, 200)
	if err != nil {
		t.Fatal(err)
	}
	_ = cols
	rows, err := db.PGQuery(context.Background(), q, args...)
	if err != nil {
		t.Fatalf("joined query: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("no rows came back")
	}
	var held int
	for _, r := range rows {
		for k, v := range r {
			s, _ := v.(string)
			// A Nigerian mobile number is also 11 digits, so the shape test has to
			// skip the phone columns or it flags every row. What matters is that no
			// BVN-derived column ever carries one.
			if strings.Contains(k, "phone") {
				continue
			}
			// An NDPR BVN is 11 digits. Nothing here may ever be one.
			if len(s) == 11 && isAllDigits(s) {
				t.Errorf("column %q returned an 11-digit value, which is the shape of a whole BVN", k)
			}
		}
		// The relation prefixes its columns with its key and a double underscore.
		if asString(r["cardholder__bvn_on_record"]) == "Yes" {
			held++
		}
	}
	t.Logf("of %d expired cards sampled, %d have a BVN on record", len(rows), held)
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
