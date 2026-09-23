package handlers

import (
	"context"

	"github.com/o3c/workspace/core"
)

/*
Report Builder access: who may build a report, and on which data.

Two audiences use the builder:

  - BI, through the "reports" page: every data source in the registry, plus the raw
    file export.
  - Department supervisors and management, through the "report_builder" page: only
    the data sources their own departments cover.

"Their departments" is not a second list to keep in step with the roles. A supervisor
may report on a data source when they already hold one of the module pages that show
that data in the workspace. So a head who also runs another team (extra roles) gets that
team's data, a custom role an admin builds in User Management works without a code
change, and taking a module away from someone takes its reports with it.

Every builder route checks this — the data-source list, the live preview, saved reports,
email and schedules — and the schedule worker re-checks the owner's access at send
time, so a schedule never keeps mailing out data its owner can no longer see.
*/

// reportDatasetPages maps each data source to the module pages that open it. Holding
// any one of them is enough.
var reportDatasetPages = map[string][]string{
	// Credit
	"loan_book":         {"credit_portfolio", "loans", "risk_all", "active_loan_book"},
	"loan_applications": {"los_all", "los_assign", "los_risk_head", "los_finance"},
	"loan_schedule":     {"credit_portfolio", "loans", "collections"},
	// Cards
	"card_accounts":     {"cards", "card_trends"},
	"card_transactions": {"cards", "card_trends"},
	"card_cycle_data":   {"cards", "card_trends"},
	// Sales & BD
	"crm_contacts": {"crm_pipeline", "crm_reports", "bd_pipeline", "call_center_stats"},
	// Retention is cross-team by construction — the Call Center works the at-risk and
	// dormant buckets, Sales works the high-value win-backs, and Collections owns the
	// customers excluded from both — so it rides the 'retention' page that every one
	// of those heads holds, rather than any single module's key.
	"customer_lifecycle": {"retention"},
	// Deposits & Finance
	"fixed_deposits": {"fixed_deposit"},
	"fee_income":     {"income", "finance"},
	"income_daily":   {"income", "finance"},
	// Collections & Recovery
	"collections_assignments": {"collections"},
	"collections_payments":    {"collections"},
	"recovery_cases":          {"recovery_assign", "recovery_write_off"},
	// Settlement & Reconciliation
	"paystack_transactions": {"settlement", "reconciliation", "finance"},
	"paystack_transfers":    {"settlement", "reconciliation", "finance"},
	"recon_exceptions":      {"settlement", "reconciliation"},
	"recon_matches":         {"settlement", "reconciliation"},
	"settlement_exceptions": {"settlement", "reconciliation"},
	// Contact Centre & Care
	"helpdesk_tickets":  {"helpdesk_stats"},
	"helpdesk_calls":    {"call_center_stats", "helpdesk_stats"},
	"call_center_queue": {"call_center_stats"},
	// Compliance
	"soc2_controls":  {"compliance_all", "audit_findings"},
	"audit_findings": {"compliance_all", "audit_findings"},
	"audit_trail":    {"audit_trail", "audit_export"},
	// Marketing & Mobile
	"mail_suppressions": {"campaigns", "message_templates"},
	"appsflyer_daily":   {"mobile_app", "campaigns"},
	"appsflyer_events":  {"mobile_app", "campaigns"},
}

// reportBIOnlyDatasets belong to no department. They are the customer master — every
// customer's contact details in one pull — so they stay with BI.
var reportBIOnlyDatasets = map[string]bool{
	"customers": true,
	"parties":   true,
}

const reportDatasetDenied = "This data source is outside your departments"

// reportDatasetAllowed reports whether someone may build, run, email or schedule a
// report on a data source.
func reportDatasetAllowed(u *core.Claims, key string) bool {
	if u == nil {
		return false
	}
	if u.HasPage("reports") {
		return true // BI and admin: the whole registry
	}
	if !u.HasPage("report_builder") {
		return false
	}
	for _, p := range reportDatasetPages[key] {
		if u.HasPage(p) {
			return true
		}
	}
	return false
}

// canManageReportItem reports whether someone may change or delete a saved report or
// schedule: the people who made it, and admin. Everyone else who can see a shared
// report may run and copy it, nothing more.
func canManageReportItem(u *core.Claims, ownerIDs ...int64) bool {
	if u == nil {
		return false
	}
	if u.Role == "admin" {
		return true
	}
	for _, id := range ownerIDs {
		if id != 0 && id == u.ID {
			return true
		}
	}
	return false
}

// reportOwnerClaims rebuilds a user's access as it stands now, from the database, so
// a scheduled delivery runs with the access its owner has today rather than what they
// had when they set it up. A removed or deactivated user has none.
func reportOwnerClaims(ctx context.Context, db *core.DB, userID int64) *core.Claims {
	if userID == 0 {
		return nil
	}
	rows, err := db.PGQuery(ctx, `
		SELECT role, COALESCE(extra_roles, '[]'::jsonb) AS extra_roles
		FROM o3c_users
		WHERE id = $1 AND deleted_at IS NULL AND COALESCE(is_active, true)`, userID)
	if err != nil || len(rows) == 0 {
		return nil
	}
	role := str(rows[0]["role"])
	extras := core.ParsePages(rows[0]["extra_roles"])
	return &core.Claims{
		ID:         userID,
		Role:       role,
		ExtraRoles: extras,
		Pages:      resolveRolePages(ctx, db, append([]string{role}, extras...)),
	}
}
