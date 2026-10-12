package cbssync

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/o3c/workspace/udara"
)

/*
	Does app.loan_repayments still hold every repayment Udara actually reports?

	This exists because "is the capture complete?" was asked on 2026-10-12 and could
	not be answered from the data alone. The call-over ledger held 135 loan repayment
	legs against 88 captured rows, which looks like a 47-leg hole and is not one: the
	47 are the CREDIT halves of double entry, pairing 1:1 with a captured debit leg on
	the same posting reference and amount. Capturing them would double every repayment.

	So the test asserts the two things that would actually be wrong:

	  1. Every credit leg pairs with a debit leg. A credit leg with no debit partner is
	     real money we are not capturing.
	  2. Every DEBIT leg in the ledger is in app.loan_repayments. A debit leg we never
	     stored is a repayment the product cannot see.

	It also reports how far back the ledger reaches. The floor was 2026-07-01 when
	measured on both 2026-09-22 and 2026-10-12, and 13 uploaded-spreadsheet receipts
	worth 75,530,477.78 naira sit BEFORE it — they are kept precisely because Udara has
	no record of them (migration 366). If this floor ever moves earlier, those receipts
	should be re-examined against the ledger, and this test is where that shows up.

	Read-only against both Udara and Postgres.

	    CBS_LIVE_TEST=1 go test ./cbssync -run TestLedgerCoverage -v
*/
func TestLedgerCoverage(t *testing.T) {
	if os.Getenv("CBS_LIVE_TEST") != "1" {
		t.Skip("set CBS_LIVE_TEST=1")
	}
	env := readDotEnv(t, "../.env")
	c := udara.New(env["UDARA360_BASE_URL"], env["UDARA360_CLIENT_ID"], env["UDARA360_CLIENT_SECRET"])
	ctx := context.Background()

	type leg struct {
		FinancialDate string `json:"financialDate"`
		AccountName   string `json:"accountName"`
		EntryCode     string `json:"entryCode"`
		Narration      string `json:"narration"`
		Amount         string `json:"amount"`
		PostingRef     string `json:"postingReferenceNumber"`
	}

	// Page to the end. recordCount is always 0 on this endpoint, so a short page is the
	// only end-of-data signal there is.
	var all []leg
	for page := 1; page <= 60; page++ {
		q := url.Values{}
		q.Set("PageNumber", fmt.Sprint(page))
		q.Set("PageSize", "1000")
		raw, code, err := c.Do(ctx, "GET", "/api/Report/v1/GetTransactionCallOverReport", nil, q)
		if err != nil || code < 200 || code >= 300 {
			t.Fatalf("ledger page %d: http %d err %v", page, code, err)
		}
		var envl struct {
			Data json.RawMessage `json:"data"`
		}
		if json.Unmarshal(raw, &envl) != nil {
			t.Fatalf("ledger page %d: bad envelope", page)
		}
		var batch []leg
		if json.Unmarshal(envl.Data, &batch) != nil {
			t.Fatalf("ledger page %d: bad item array", page)
		}
		all = append(all, batch...)
		if len(batch) < 1000 {
			break
		}
	}
	if len(all) == 0 {
		t.Fatal("ledger returned nothing at all")
	}

	isRepayment := func(l leg) bool {
		n := strings.ToLower(l.Narration)
		return strings.Contains(n, "loan principal repayment") ||
			strings.Contains(n, "loan interest repayment")
	}

	dates := []string{}
	type key struct{ ref, amt string }
	debits := map[key]leg{}
	credits := map[key][]leg{}
	for _, l := range all {
		if l.FinancialDate != "" {
			dates = append(dates, l.FinancialDate[:10])
		}
		if !isRepayment(l) {
			continue
		}
		k := key{l.PostingRef, l.Amount}
		if strings.HasPrefix(l.EntryCode, "D-") {
			debits[k] = l
		} else {
			credits[k] = append(credits[k], l)
		}
	}
	sort.Strings(dates)
	t.Logf("ledger: %d legs, financialDate %s .. %s; %d repayment debit leg(s), %d credit leg(s)",
		len(all), dates[0], dates[len(dates)-1], len(debits), len(credits))

	if dates[0] < "2026-07-01" {
		t.Errorf("THE LEDGER NOW REACHES BACK TO %s, earlier than the 2026-07-01 floor migration 366 "+
			"relied on. Re-examine the 13 pre-floor uploaded receipts against it.", dates[0])
	}

	// 1. A credit leg with no debit partner is money we are not capturing.
	orphans := 0
	for k, legs := range credits {
		if _, ok := debits[k]; !ok {
			orphans += len(legs)
			if orphans <= 10 {
				t.Errorf("ORPHAN CREDIT LEG: ref %s amount %s (%s) has no debit partner — real uncaptured money",
					k.ref, k.amt, legs[0].AccountName)
			}
		}
	}
	if orphans == 0 {
		t.Logf("ok   every credit leg pairs with a debit leg, so none of them is uncaptured money")
	}

	// 2. Every debit leg must be stored.
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()

	missing := 0
	for k, l := range debits {
		var n int
		if err := pg.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM app.loan_repayments
			  WHERE posting_reference = $1 AND amount_kobo = ($2::numeric)::bigint`,
			k.ref, k.amt).Scan(&n); err != nil {
			t.Fatalf("lookup %s: %v", k.ref, err)
		}
		if n == 0 {
			missing++
			if missing <= 10 {
				t.Errorf("UNCAPTURED REPAYMENT: ref %s amount %s on %s (%s, %s) is in the ledger and not in app.loan_repayments",
					k.ref, k.amt, l.FinancialDate[:10], l.AccountName, l.EntryCode)
			}
		}
	}
	if missing == 0 {
		t.Logf("ok   all %d ledger debit leg(s) are present in app.loan_repayments", len(debits))
	}
}
