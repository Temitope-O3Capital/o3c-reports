package handlers

import (
	"os"
	"strings"
	"testing"
)

/*
Udara loan repayments are captured into app.loan_repayments by cbssync/repayments.go,
and they carry NO application_id and NO loan_id — a core banking facility is not a
workspace loan application. Every reader that joined on either of those columns
therefore returned zero rows for them, silently: 46 postings, ₦687,967,488.32 across
17 people, captured hourly and displayed on no screen. A borrower who had repaid in
full read as having never paid anything, on the customer timeline, in the collections
credit file, and on the credit portfolio.

The only link those rows carry is cbs_loan_account -> cbs_loans. These tests pin that
join in the three readers that were fixed, because the failure mode is an empty list
rather than an error — nothing breaks, the money just stops being visible.
*/

// readHandlerSource is the package's own convention: read the file next door.
func readHandlerSource(t *testing.T, name string) string {
	t.Helper()
	src, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(src)
}

// The customer credit portfolio must reach repayments through cbs_loan_account. It must
// also not go back to deriving "repaid" from the balance: disbursed less outstanding
// principal counts a write-off as a payment and counts an interest-only payment as zero.
func TestTheCustomerPortfolioReadsRepaymentsFromTheLedger(t *testing.T) {
	s := readHandlerSource(t, "los.go")
	if !strings.Contains(s, "lr.cbs_loan_account = cl.cbs_account_number") {
		t.Error("losCustomerPortfolio no longer joins repayments on cbs_loan_account — " +
			"Udara postings carry no application_id or loan_id, so any other join returns nothing")
	}
	if !strings.Contains(s, "repaid_principal_kobo") || !strings.Contains(s, "repaid_interest_kobo") {
		t.Error("the portfolio no longer reports principal and interest separately; " +
			"they are different money and the ledger states which is which")
	}
	if !strings.Contains(s, "lr.ledger_key IS NOT NULL") {
		t.Error("the repayment join no longer restricts to ledger-captured rows, so " +
			"manually-mirrored collections rows would be double-counted as GL postings")
	}
}

// The portfolio used to compute its own DPD, so the same borrower could read as current
// here and 180 days past due on the list page that linked to it.
func TestTheCustomerPortfolioUsesTheCanonicalDPD(t *testing.T) {
	s := readHandlerSource(t, "los.go")
	i := strings.Index(s, "func losCustomerPortfolio")
	if i < 0 {
		t.Fatal("losCustomerPortfolio is gone — these tests no longer describe this file")
	}
	body := s[i:]
	if j := strings.Index(body, "\nfunc "); j > 0 {
		body = body[:j]
	}
	// Comments are stripped before the check: the code comment explaining why the inline
	// DPD was removed quotes the expression it removed, and matching prose would fail the
	// test for describing the fix.
	var code []string
	for _, line := range strings.Split(body, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "//") {
			code = append(code, line)
		}
	}
	body = strings.Join(code, "\n")
	if strings.Contains(body, "CURRENT_DATE - maturity_date") {
		t.Error("the portfolio is computing DPD inline again; app.cbs_loan_dpd is the one " +
			"the loan book, the risk bands and the dashboards all use")
	}
	// The source interpolates the shared constant by name, so that is what is asserted
	// here — comparing against its expanded value would never match.
	if !strings.Contains(body, "+cbsLoanDPD+") {
		t.Error("the portfolio no longer uses the shared cbsLoanDPD expression")
	}
}

// The Customer 360 timeline branch must bridge through app.cbs_links, NOT through CIF.
// A Udara customer id and a cards CIF share the same digit shape and usually name a
// DIFFERENT REAL PERSON, so a CIF match here would put one customer's repayments on a
// stranger's timeline — the same defect that once showed FOLTI's loan book under an
// unrelated person's name.
func TestTheTimelineBridgesUdaraRepaymentsByPartyNotByCIF(t *testing.T) {
	s := readHandlerSource(t, "customer360.go")
	if !strings.Contains(s, "gcl.cbs_account_number = glr.cbs_loan_account") {
		t.Fatal("the timeline no longer reads Udara repayments through cbs_loan_account")
	}
	branch := s[strings.Index(s, "FROM app.loan_repayments glr"):]
	if j := strings.Index(branch, "UNION ALL"); j > 0 {
		branch = branch[:j]
	}
	if !strings.Contains(branch, "gk.entity_id = ids.party_id") {
		t.Error("the Udara repayment branch no longer bridges through app.cbs_links by party")
	}
	if strings.Contains(branch, "ids.cifs") {
		t.Error("the Udara repayment branch is matching on ids.cifs — a Udara customer id " +
			"is not a cards CIF, and matching them attributes repayments to the wrong person")
	}
}

// Collections is the reason this matters operationally: an agent who cannot see a
// repayment duns a customer for money they have already paid.
func TestTheCollectionsCreditFileShowsUdaraRepayments(t *testing.T) {
	s := readHandlerSource(t, "collections_credit.go")
	if !strings.Contains(s, "FROM app.loan_repayments lr") {
		t.Error("the collections credit file no longer reads app.loan_repayments at all; " +
			"it shows collection receipts and card payments only, so a core banking loan " +
			"repayment is invisible to the agent on the phone")
	}
	if !strings.Contains(s, `lr.cbs_loan_account = ANY($1)`) {
		t.Error("the collections credit file no longer keys Udara repayments on cbs_loan_account")
	}
	if !strings.Contains(s, `Source:      "udara"`) {
		t.Error("Udara repayments are no longer tagged as such, so they cannot be told " +
			"apart from what an agent logged by hand")
	}
}
