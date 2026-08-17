package core

import "testing"

func TestRiskAccessMatrix(t *testing.T) {
	guard := []string{"risk_all", "risk_officer", "risk_head", "credit_portfolio"}
	for _, role := range []string{
		"risk_officer", "risk_head", "collections_head", "recovery_head",
		"finance_officer", "finance_head", "settlement_officer", "coo", "md",
		"sales_officer", "call_center_agent", "compliance_officer",
	} {
		pages := map[string]bool{}
		for _, p := range RolePages[role] {
			pages[p] = true
		}
		api := false
		for _, g := range guard {
			if pages[g] {
				api = true
			}
		}
		t.Logf("%-20s api=%-5v route(credit_portfolio)=%-5v los=%-5v los_risk_review=%v",
			role, api, pages["credit_portfolio"], pages["los"], pages["los_risk_review"])
		// The bug: route said yes, API said no.
		if pages["credit_portfolio"] && !api {
			t.Errorf("%s can open the Risk page but the API would 403", role)
		}
	}
}
