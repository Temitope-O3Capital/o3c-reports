package cbswrite

import (
	"context"
	"testing"

	"github.com/o3c/reports/udara"
)

// TestDryRunSendsNothing verifies that with CBS_WRITE_ENABLED unset (the default),
// BookLoan/CreateFD return the planned CBS calls without sending any request.
func TestDryRunSendsNothing(t *testing.T) {
	if Enabled() {
		t.Skip("CBS_WRITE_ENABLED is set; skipping dry-run test")
	}
	// Unconfigured client is fine: dry-run must not touch it.
	c := udara.New("", "", "")
	ctx := context.Background()

	// Loan with existing customer -> add + disburse (2 steps).
	p, err := BookLoan(ctx, c, LoanBooking{CustomerID: "00000557", ProductCode: "401", AmountKobo: 200000000, TenureDays: 90, StartDate: "2026-08-01"}, "idem-1")
	if err != nil {
		t.Fatalf("BookLoan: %v", err)
	}
	if !p.DryRun {
		t.Error("expected DryRun=true by default")
	}
	if len(p.Steps) != 2 {
		t.Errorf("expected 2 steps (add, disburse), got %d", len(p.Steps))
	}
	for _, s := range p.Steps {
		if s.Sent {
			t.Errorf("step %q was sent in dry-run mode", s.Purpose)
		}
	}

	// Loan with no customer -> create-customer first (3 steps).
	p2, _ := BookLoan(ctx, c, LoanBooking{ProductCode: "401", NewFirstName: "Test", NewLastName: "User"}, "idem-2")
	if len(p2.Steps) != 3 || p2.Steps[0].Purpose != "create-customer" {
		t.Errorf("expected create-customer + add + disburse, got %d steps (first=%q)", len(p2.Steps), stepPurpose(p2))
	}

	// FD -> single fd/add step.
	p3, _ := CreateFD(ctx, c, FDBooking{CustomerID: "00000549", ProductCode: "301", PrincipalKobo: 5000000000, TenureDays: 30, LiquidationAccount: "1000005475"}, "idem-3")
	if len(p3.Steps) != 1 || p3.Steps[0].Purpose != "fd/add" || p3.Steps[0].Sent {
		t.Errorf("unexpected FD plan: %+v", p3.Steps)
	}
}

func stepPurpose(p *Plan) string {
	if len(p.Steps) == 0 {
		return ""
	}
	return p.Steps[0].Purpose
}
