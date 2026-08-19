package core

import "testing"

// The Reports & BI module is the only place the workspace produces a data file.
// That makes the "reports" page a security boundary, not just a nav entry, so
// these tests pin the decision rather than leaving it to be widened by accident
// the next time someone adds a role.
//
// O3's decision (2026-08-17): data extraction is concentrated in BI — only the
// BI roles and admin hold the page.

func hasPage(role, page string) bool {
	if role == "admin" {
		return true // super-user: bypasses page gating entirely
	}
	for _, p := range RolePages[role] {
		if p == page {
			return true
		}
	}
	return false
}

func TestReportsPageIsLimitedToBIAndAdmin(t *testing.T) {
	allowed := map[string]bool{
		"bi_analyst": true,
		"bi_head":    true,
		"admin":      true,
		"md":         true, // AllCatalogPages by definition; a separate, pre-existing policy
	}
	for role := range RolePages {
		got := hasPage(role, "reports")
		if got && !allowed[role] {
			t.Errorf("role %q holds the reports page: it can open Reports & BI and export "+
				"every dataset. Only BI roles and admin should.", role)
		}
	}
	for role := range allowed {
		if !hasPage(role, "reports") {
			t.Errorf("role %q lost the reports page but must keep it", role)
		}
	}
}

// Narrowing "reports" must not have taken away the dashboards and statements the
// operational heads use daily — those are separate page keys and were never part
// of the export decision.
func TestNarrowingReportsDidNotRemoveDashboardsFromHeads(t *testing.T) {
	for _, role := range []string{
		"sales_head", "collections_head", "recovery_head",
		"finance_head", "compliance_head", "coo", "cfo", "cmo",
	} {
		if !hasPage(role, "kpi_dashboard") {
			t.Errorf("role %q lost kpi_dashboard", role)
		}
		if !hasPage(role, "executive") {
			t.Errorf("role %q lost the executive dashboard", role)
		}
	}
	// Compliance keeps its regulatory pages: the CBN report and the audit trail
	// are statutory duties, not ad-hoc reporting.
	for _, page := range []string{"cbn_reports", "audit_trail", "audit_export"} {
		if !hasPage("compliance_head", page) {
			t.Errorf("compliance_head lost %q", page)
		}
	}
	// Statements are a customer-facing artefact, not a data extract.
	for _, role := range []string{"finance_head", "collections_head", "recovery_head", "sales_head"} {
		if !hasPage(role, "statements") {
			t.Errorf("role %q lost statements", role)
		}
	}
}
