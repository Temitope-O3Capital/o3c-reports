package core

import (
	"net/http"
	"testing"
)

// Head of Internal Control audits the whole business: it reads every module except
// Administration, and writes nothing. Both halves are load-bearing — pages alone would
// make internal control an approver, since a page carries its own write endpoints.

func TestInternalControlReadsEveryModuleButAdmin(t *testing.T) {
	const role = "internal_control_head"

	// A page from each operating module, so a module added to the catalog and missed
	// here shows up as internal control being unable to audit it.
	for _, page := range []string{
		"overview", "executive", "kpi_dashboard", "statements", "approvals",
		"sales", "bd", "crm_contacts", "mail", "campaigns",
		"los", "loans", "credit_portfolio", "active_loan_book",
		"collections", "recovery", "recovery_write_off",
		"cards", "card_trends", "income", "finance", "transactions",
		"settlement", "reconciliation", "payroll",
		"call_center", "helpdesk", "customer360", "care", "surveys",
		"risk_all", "compliance_all", "audit_trail", "audit_export", "sars",
	} {
		if !hasPage(role, page) {
			t.Errorf("internal control cannot reach %q: it audits every module", page)
		}
	}

	// Administration is the exception the user asked for, and "uploads" is a bulk write.
	for _, page := range []string{"admin_users", "admin_api_keys", "settings", "sync_status", "uploads"} {
		if hasPage(role, page) {
			t.Errorf("internal control holds admin page %q: administration is excluded", page)
		}
	}

	// Bulk extraction stays with BI (exportaccess_test.go pins this), but the builder is
	// held because every *_head holds it.
	if hasPage(role, "reports") {
		t.Error("internal control holds the reports page: bulk export belongs to BI and admin")
	}
	if !hasPage(role, "report_builder") {
		t.Error("internal control lost report_builder: every *_head builds its own reports")
	}

	// It reads the company-wide dashboards, like the rest of the oversight tier.
	if !IsManagement(role) {
		t.Error("internal control is not management tier: it would lose the General Overview")
	}
	// And it sees every row, not just its own — an auditor scoped to their own records
	// audits nothing.
	if !SeesAllRows(role) {
		t.Error("internal control is scoped to its own rows")
	}
}

func TestInternalControlCannotWriteAnything(t *testing.T) {
	const role = "internal_control_head"

	for _, m := range []string{http.MethodGet, http.MethodHead, http.MethodOptions} {
		if WriteBlocked(role, m, "/api/collections") {
			t.Errorf("%s was blocked: internal control must be able to read", m)
		}
	}
	for _, path := range []string{
		"/api/collections/assign", "/api/recovery/write-off", "/api/los/applications/1/advance",
		"/api/admin/users", "/api/cards/issuance", "/api/reports/saved",
	} {
		for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
			if !WriteBlocked(role, m, path) {
				t.Errorf("%s %s was allowed: internal control writes nothing", m, path)
			}
		}
	}

	// The few writes it still needs: its own session, and the POST-shaped reads the
	// Report Builder uses to fetch a table.
	for _, path := range []string{
		"/api/auth/logout", "/api/auth/change-password",
		"/api/reports/datasets/helpdesk_calls/table", "/api/reports/datasets/helpdesk_calls/uniques",
	} {
		if WriteBlocked(role, http.MethodPost, path) {
			t.Errorf("POST %s was blocked: internal control still needs it", path)
		}
	}

	// Nobody else is affected by the read-only rule.
	for _, other := range []string{"admin", "md", "coo", "compliance_head", "collections_agent"} {
		if WriteBlocked(other, http.MethodPost, "/api/collections/assign") {
			t.Errorf("role %q was caught by the read-only rule", other)
		}
	}
}
