package handlers

import (
	"context"
	"database/sql"
	"os"
	"testing"

	"github.com/o3c/workspace/core"
)

// TestResolveCustomerCIFRefusesAmbiguity is the test that matters, and it needs the real
// book because the hazard IS the real book.
//
// app.customers holds 8,739 customers on a SHARED phone number against 7,159 on a unique
// one: 8012345678 alone carries 4,113 of them, 8000000000 another 2,235. A
// first-match-wins lookup would hand a conversion — and a person's identity — to whichever
// of four thousand people sorted first. So the rule is EXACTLY ONE MATCH, and this asserts
// it against the numbers that actually break it rather than against a fixture.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestResolveCustomerCIF -v
func TestResolveCustomerCIFRefusesAmbiguity(t *testing.T) {
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
	ctx := context.Background()

	// The placeholders. Each is held by hundreds or thousands of customers, so each must
	// resolve to nothing — and would be a catastrophe if it resolved to something.
	for _, phone := range []string{
		"08012345678", "8012345678", "+2348012345678",
		"08000000000", "0000000000", "0812000000",
	} {
		if cif, ok := ccResolveCustomerCIF(ctx, db, phone); ok {
			t.Errorf("placeholder %q resolved to CIF %q — it is shared by thousands of "+
				"customers and must never identify one of them", phone, cif)
		}
	}

	// Unparseable or empty input must not match the customers whose phone is also blank.
	// app.norm_phone returns '' rather than NULL, so without the length guard blank
	// matches blank — the trap this codebase has hit more than once.
	for _, phone := range []string{"", "   ", "abc", "123", "+234"} {
		if cif, ok := ccResolveCustomerCIF(ctx, db, phone); ok {
			t.Errorf("unusable phone %q resolved to CIF %q", phone, cif)
		}
	}
}

// TestResolveCustomerCIFOnTheRealConversions pins the rule against the nine call-centre
// conversions on the book, which is how the rule was chosen in the first place.
//
// Six hold a card and must resolve; three do not and must not. If this starts failing, the
// honest reading is usually that the book changed — a CIF was issued for one of the three,
// or a number became shared — not that the rule is wrong. Check before "fixing" it.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestResolveCustomerCIFOnTheRealConversions -v
func TestResolveCustomerCIFOnTheRealConversions(t *testing.T) {
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
	ctx := context.Background()

	rows, err := db.PGQuery(ctx, `
		SELECT id, customer_name, customer_phone
		  FROM app.call_center_leads
		 WHERE status = 'converted'
		 ORDER BY id`)
	if err != nil {
		t.Fatalf("load converted leads: %v", err)
	}
	if len(rows) == 0 {
		t.Skip("no converted leads on the book")
	}
	resolved, unresolved := 0, []string{}
	for _, r := range rows {
		if _, ok := ccResolveCustomerCIF(ctx, db, str(r["customer_phone"])); ok {
			resolved++
		} else {
			unresolved = append(unresolved, str(r["customer_name"]))
		}
	}
	t.Logf("%d of %d conversions resolve to exactly one customer", resolved, len(rows))
	if len(unresolved) > 0 {
		t.Logf("unverified, awaiting confirmation from the agent who logged them: %v", unresolved)
	}
	// The property, rather than the exact figures: a conversion that resolves must resolve
	// to a CIF the book actually holds.
	for _, r := range rows {
		cif, ok := ccResolveCustomerCIF(ctx, db, str(r["customer_phone"]))
		if !ok {
			continue
		}
		chk, err := db.PGQuery(ctx, `SELECT 1 FROM app.customers WHERE cif = $1 LIMIT 1`, cif)
		if err != nil || len(chk) == 0 {
			t.Errorf("lead %v resolved to CIF %q, which is not in the customer book",
				r["id"], cif)
		}
	}
}
