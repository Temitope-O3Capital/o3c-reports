// Package cbswrite implements write-through of workspace-originated loans and fixed
// deposits to the Udara360 core banking system.
//
// SAFETY: writes are OFF by default. Unless CBS_WRITE_ENABLED=true, every call runs
// in DRY-RUN mode: it returns the exact ordered CBS requests it WOULD send, but sends
// nothing. This lets the payloads be reviewed against the Udara360 API before any real
// booking touches production. The exact field names/units below are best-effort from
// the CBS surface and MUST be validated against Udara360 docs (ideally against the
// test host openapi.test.udara360.io) before enabling live writes.
package cbswrite

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/o3c/reports/udara"
)

// Enabled reports whether live writes are on. Default false => dry-run/shadow mode.
func Enabled() bool { return strings.EqualFold(os.Getenv("CBS_WRITE_ENABLED"), "true") }

// LoanBooking is the workspace-side input for booking a loan on the CBS.
type LoanBooking struct {
	// Existing CBS customer id (CIF). If empty, a customer is created first from the
	// New* fields below.
	CustomerID  string `json:"customerId"`
	ProductCode string `json:"productCode"`
	AmountKobo  int64  `json:"amountKobo"`
	TenureDays  int    `json:"tenureDays"`
	StartDate   string `json:"startDate"` // ISO date, e.g. 2026-08-01

	// Only used when CustomerID is empty (create-customer path).
	NewBVN       string `json:"bvn,omitempty"`
	NewNIN       string `json:"nin,omitempty"`
	NewFirstName string `json:"firstName,omitempty"`
	NewLastName  string `json:"lastName,omitempty"`
	NewPhone     string `json:"phone,omitempty"`
	BranchCode   string `json:"branchCode,omitempty"`
}

// FDBooking is the workspace-side input for creating a fixed deposit on the CBS.
type FDBooking struct {
	CustomerID         string `json:"customerId"`
	ProductCode        string `json:"productCode"`
	PrincipalKobo      int64  `json:"principalKobo"`
	TenureDays         int    `json:"tenureDays"`
	LiquidationAccount string `json:"liquidationAccount"`
}

// Step is one CBS request in a write-through plan.
type Step struct {
	Purpose string          `json:"purpose"`
	Method  string          `json:"method"`
	Path    string          `json:"path"`
	Payload map[string]any  `json:"payload"`
	Sent    bool            `json:"sent"`
	Status  int             `json:"status,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
}

// Plan is the full ordered set of CBS calls for one workspace action.
type Plan struct {
	Action      string `json:"action"`
	DryRun      bool   `json:"dryRun"`
	Idempotency string `json:"idempotency"`
	Steps       []Step `json:"steps"`
}

// BookLoan plans (and, when enabled, executes) booking a loan: optionally create the
// customer, then loan/add, then loan/disburse. In dry-run mode no request is sent.
func BookLoan(ctx context.Context, c *udara.Client, b LoanBooking, idempotency string) (*Plan, error) {
	p := &Plan{Action: "book_loan", DryRun: !Enabled(), Idempotency: idempotency}

	if strings.TrimSpace(b.CustomerID) == "" {
		p.Steps = append(p.Steps, Step{
			Purpose: "create-customer", Method: "POST", Path: "/api/account/v1/createcustomeraccount",
			Payload: map[string]any{
				"bvn": b.NewBVN, "nin": b.NewNIN, "firstName": b.NewFirstName,
				"lastName": b.NewLastName, "phoneNumber": b.NewPhone,
				"productCode": b.ProductCode, "branchCode": b.BranchCode,
			},
		})
	}
	p.Steps = append(p.Steps, Step{
		Purpose: "loan/add", Method: "POST", Path: "/api/loanaccount/v1/add",
		Payload: map[string]any{
			"customerId": orPlaceholder(b.CustomerID, "<customerId from create-customer>"),
			"productCode": b.ProductCode, "loanAmount": b.AmountKobo,
			"tenure": b.TenureDays, "startDate": b.StartDate,
		},
	})
	p.Steps = append(p.Steps, Step{
		Purpose: "loan/disburse", Method: "POST", Path: "/api/loanaccount/v1/disburseloan",
		Payload: map[string]any{"loanAccountNumber": "<accountNumber from loan/add>"},
	})

	return execute(ctx, c, p)
}

// CreateFD plans (and, when enabled, executes) creating a fixed deposit.
func CreateFD(ctx context.Context, c *udara.Client, b FDBooking, idempotency string) (*Plan, error) {
	p := &Plan{Action: "create_fd", DryRun: !Enabled(), Idempotency: idempotency}
	p.Steps = append(p.Steps, Step{
		Purpose: "fd/add", Method: "POST", Path: "/api/fixeddepositaccount/v1/add",
		Payload: map[string]any{
			"customerId": b.CustomerID, "productCode": b.ProductCode,
			"principalAmount": b.PrincipalKobo, "tenure": b.TenureDays,
			"liquidationAccount": b.LiquidationAccount,
		},
	})
	return execute(ctx, c, p)
}

// execute sends the plan's steps when live writes are enabled, chaining the CBS
// account number from loan/add into loan/disburse. In dry-run mode it returns the
// plan unchanged (nothing sent).
func execute(ctx context.Context, c *udara.Client, p *Plan) (*Plan, error) {
	if p.DryRun {
		return p, nil
	}
	if !c.IsConfigured() {
		return p, fmt.Errorf("cbswrite: CBS client not configured")
	}
	var lastAccountNumber string
	for i := range p.Steps {
		s := &p.Steps[i]
		// Chain: disburse needs the account number produced by loan/add.
		if s.Purpose == "loan/disburse" && lastAccountNumber != "" {
			s.Payload["loanAccountNumber"] = lastAccountNumber
		}
		data, code, err := c.Do(ctx, s.Method, s.Path, s.Payload, nil)
		s.Sent = true
		s.Status = code
		s.Result = data
		if err != nil {
			s.Error = err.Error()
			return p, fmt.Errorf("cbswrite: step %q failed: %w", s.Purpose, err)
		}
		if code < 200 || code >= 300 {
			return p, fmt.Errorf("cbswrite: step %q returned HTTP %d", s.Purpose, code)
		}
		if acct := extractAccountNumber(data); acct != "" {
			lastAccountNumber = acct
		}
	}
	return p, nil
}

// extractAccountNumber pulls an account number out of a CBS response (envelope-aware).
func extractAccountNumber(data json.RawMessage) string {
	var top map[string]json.RawMessage
	if json.Unmarshal(data, &top) != nil {
		return ""
	}
	search := top
	if d, ok := top["data"]; ok {
		var inner map[string]json.RawMessage
		if json.Unmarshal(d, &inner) == nil {
			search = inner
		}
	}
	for _, k := range []string{"accountNumber", "loanAccountNumber", "AccountNumber"} {
		if v, ok := search[k]; ok {
			var s string
			if json.Unmarshal(v, &s) == nil && s != "" {
				return s
			}
		}
	}
	return ""
}

func orPlaceholder(v, placeholder string) string {
	if strings.TrimSpace(v) == "" {
		return placeholder
	}
	return v
}
