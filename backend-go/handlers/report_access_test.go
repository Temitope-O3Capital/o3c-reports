package handlers

import (
	"testing"

	"github.com/o3c/workspace/core"
)

func reportClaims(roles ...string) *core.Claims {
	return &core.Claims{ID: 1, Role: roles[0], ExtraRoles: roles[1:]}
}

// Every data source has to say who may report on it. Without this, a dataset added to
// the registry would quietly be BI-only — or someone would "fix" that by treating a
// missing entry as open to everyone.
func TestReportDatasetsEachDeclareWhoMayUseThem(t *testing.T) {
	inRegistry := map[string]bool{}
	for _, d := range exportDatasets {
		inRegistry[d.Key] = true
		_, mapped := reportDatasetPages[d.Key]
		if mapped == reportBIOnlyDatasets[d.Key] {
			t.Errorf("data source %q must be in exactly one of reportDatasetPages and reportBIOnlyDatasets", d.Key)
		}
	}
	for key, pages := range reportDatasetPages {
		if !inRegistry[key] {
			t.Errorf("reportDatasetPages names %q, which is not in the export registry", key)
		}
		if len(pages) == 0 {
			t.Errorf("%q lists no pages, so nobody outside BI could use it; move it to reportBIOnlyDatasets", key)
		}
		for _, p := range pages {
			if !core.IsValidPage(p) {
				t.Errorf("%q is opened by page %q, which is not in the page catalog", key, p)
			}
		}
	}
	for key := range reportBIOnlyDatasets {
		if !inRegistry[key] {
			t.Errorf("reportBIOnlyDatasets names %q, which is not in the export registry", key)
		}
	}
}

func TestReportBuilderScopesSupervisorsToTheirDepartments(t *testing.T) {
	cases := []struct {
		name    string
		user    *core.Claims
		dataset string
		want    bool
	}{
		{"collections head, collections payments", reportClaims("collections_head"), "collections_payments", true},
		{"collections head, loan book", reportClaims("collections_head"), "loan_book", true},
		{"collections head, card transactions", reportClaims("collections_head"), "card_transactions", false},
		{"collections head, customer master", reportClaims("collections_head"), "customers", false},
		{"cards head, card transactions", reportClaims("cards_head"), "card_transactions", true},
		{"cards head, collections payments", reportClaims("cards_head"), "collections_payments", false},
		{"cards head alone, call log", reportClaims("cards_head"), "helpdesk_calls", false},
		{"cards head who also runs the call centre, call log", reportClaims("cards_head", "call_center_head"), "helpdesk_calls", true},
		{"sales head, leads", reportClaims("sales_head"), "crm_contacts", true},
		{"compliance head, audit trail", reportClaims("compliance_head"), "audit_trail", true},
		{"compliance head, loan book", reportClaims("compliance_head"), "loan_book", false},
		{"COO, collections payments", reportClaims("coo"), "collections_payments", true},
		{"BI analyst, customer master", reportClaims("bi_analyst"), "customers", true},
		{"admin, customer master", reportClaims("admin"), "customers", true},
		{"sales officer has no builder", reportClaims("sales_officer"), "crm_contacts", false},
		{"call centre agent has no builder", reportClaims("call_center_agent"), "helpdesk_calls", false},
		{"exec overview alone has no department", reportClaims("exec_overview"), "loan_book", false},
		{"no user", nil, "loan_book", false},
	}
	for _, c := range cases {
		if got := reportDatasetAllowed(c.user, c.dataset); got != c.want {
			t.Errorf("%s: allowed=%v, want %v", c.name, got, c.want)
		}
	}
}

// A custom role an admin builds in User Management (a team lead, say) gets report
// access from the pages it holds — they arrive through the token — with no code change.
func TestReportBuilderHonoursCustomRolePages(t *testing.T) {
	lead := &core.Claims{ID: 7, Role: "collections_team_lead", Pages: []string{"report_builder", "collections"}}
	if !reportDatasetAllowed(lead, "collections_payments") {
		t.Error("a custom role holding report_builder and collections should reach collections payments")
	}
	if reportDatasetAllowed(lead, "loan_book") {
		t.Error("a custom role without a credit page must not reach the loan book")
	}
	lead.Pages = []string{"collections"}
	if reportDatasetAllowed(lead, "collections_payments") {
		t.Error("without report_builder, holding the module page alone must not open the builder")
	}
}

func TestOnlyOwnersAndAdminManageReportItems(t *testing.T) {
	owner := &core.Claims{ID: 5, Role: "cards_head"}
	other := &core.Claims{ID: 6, Role: "cards_head"}
	admin := &core.Claims{ID: 1, Role: "admin"}
	if !canManageReportItem(owner, 5) {
		t.Error("the owner must be able to manage their own report")
	}
	if canManageReportItem(other, 5) {
		t.Error("another head must not manage someone else's report")
	}
	if !canManageReportItem(other, 0, 6) {
		t.Error("a schedule's creator must be able to manage it even when the report is someone else's")
	}
	if !canManageReportItem(admin, 5) {
		t.Error("admin must be able to manage any report")
	}
	if canManageReportItem(nil, 5) || canManageReportItem(other, 0) {
		t.Error("no user, or an unowned item, must not be manageable by a non-admin")
	}
}
