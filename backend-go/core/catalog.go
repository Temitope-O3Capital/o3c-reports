package core

// Canonical page catalog — the SINGLE source of truth for what "pages" exist and
// which module each belongs to. Everything role/permission related derives from
// this: the /api/admin/page-catalog endpoint (role editor), custom-role page
// validation, the activity-log allow-list, and the module grouping the sidebar
// uses. Add a page here once; do not re-list page-keys in scattered maps.

// CatalogPage is one grantable page permission.
type CatalogPage struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// CatalogModule groups related pages under a business module (also the sidebar
// section header).
type CatalogModule struct {
	Key   string        `json:"key"`
	Label string        `json:"label"`
	Icon  string        `json:"icon"`
	Pages []CatalogPage `json:"pages"`
}

// PageCatalog is ordered for display (executive → operations → admin).
var PageCatalog = []CatalogModule{
	{Key: "executive", Label: "Executive", Icon: "space_dashboard", Pages: []CatalogPage{
		{"overview", "Overview"},
		{"executive", "Executive Dashboard"},
		{"kpi_dashboard", "KPI Dashboard"},
		{"reports", "Reports"},
		{"statements", "Statements"},
		{"approvals", "Approvals"},
	}},
	{Key: "sales", Label: "Sales & BD", Icon: "trending_up", Pages: []CatalogPage{
		{"sales", "Sales & CRM"},
		{"bd", "Business Development"},
		{"bd_employers", "Employer Register"},
		{"bd_pipeline", "BD Pipeline"},
		{"crm_pipeline", "CRM Pipeline"},
		{"crm_contacts", "CRM Contacts"},
		{"crm_tasks", "CRM Tasks"},
		{"crm_reports", "CRM Reports"},
		{"cohort", "Cohort Analysis"},
		{"mail", "Mail"},
	}},
	{Key: "marketing", Label: "Campaigns & Marketing", Icon: "campaign", Pages: []CatalogPage{
		{"campaigns", "Campaigns"},
		{"contact_lists", "Contact Lists"},
		{"message_templates", "Message Templates"},
	}},
	{Key: "lending", Label: "Lending (LOS)", Icon: "account_balance", Pages: []CatalogPage{
		{"los", "Loan Origination"},
		{"los_all", "All Applications"},
		{"los_assign", "Assign Applications"},
		{"los_booking", "Loan Booking"},
		{"los_finance", "LOS Finance"},
		{"los_finance_approve", "LOS Finance Approve"},
		{"los_risk_review", "LOS Risk Review"},
		{"los_risk_head", "LOS Risk Head"},
		{"loans", "Loan Book"},
		{"credit_portfolio", "Credit Portfolio"},
		{"active_loan_book", "Active Loan Book"},
	}},
	{Key: "collections", Label: "Collections & Recovery", Icon: "gavel", Pages: []CatalogPage{
		{"collections", "Collections"},
		{"collections_assign", "Collections — Assign"},
		{"collections_payment", "Collections — Payment"},
		{"collections_payment_approve", "Collections — Payment Approve"},
		{"recovery", "Recovery"},
		{"recovery_assign", "Recovery — Assign"},
		{"recovery_write_off", "Recovery — Write-off"},
	}},
	{Key: "cards", Label: "Cards", Icon: "credit_card", Pages: []CatalogPage{
		{"cards", "Cards"},
		{"card_trends", "Card Trends"},
		{"blink_card", "Blink Card"},
		{"mobile_app", "Mobile App"},
	}},
	{Key: "finance", Label: "Finance", Icon: "payments", Pages: []CatalogPage{
		{"income", "Income"},
		{"finance", "Finance"},
		{"transactions", "Transactions"},
		{"fixed_deposit", "Fixed Deposits"},
		{"fx_rates", "FX Rates"},
		{"core-banking", "Core Banking"},
		{"eod", "End of Day"},
	}},
	{Key: "settlement", Label: "Settlement & Reconciliation", Icon: "compare_arrows", Pages: []CatalogPage{
		{"settlement", "Settlement"},
		{"reconciliation", "Reconciliation"},
	}},
	{Key: "people", Label: "People", Icon: "groups", Pages: []CatalogPage{
		{"payroll", "Payroll"},
	}},
	{Key: "contact", Label: "Contact Centre", Icon: "headset_mic", Pages: []CatalogPage{
		{"call_center", "Call Center"},
		{"call_center_stats", "Call Center — Performance"},
		{"helpdesk", "Helpdesk"},
		{"helpdesk_stats", "Helpdesk — Stats"},
		{"helpdesk_canned", "Helpdesk — Call Scripts"},
		{"helpdesk_kb", "Knowledge Base"},
		{"customer_service", "Customer Service"},
		{"customer360", "Customer 360"},
	}},
	{Key: "care", Label: "Care", Icon: "mark_email_unread", Pages: []CatalogPage{
		{"care", "Care Inbox"},
	}},
	{Key: "risk", Label: "Risk", Icon: "shield", Pages: []CatalogPage{
		{"risk_all", "Risk (All)"},
		{"risk_officer", "Risk Officer View"},
		{"risk_head", "Risk Head View"},
	}},
	{Key: "compliance", Label: "Compliance", Icon: "verified_user", Pages: []CatalogPage{
		{"compliance_all", "Compliance (All)"},
		{"compliance_checklists", "Compliance Checklists"},
		{"cbn_reports", "CBN Reports"},
		{"sars", "SARs"},
		{"audit_findings", "Audit Findings"},
		{"audit_trail", "Audit Trail"},
		{"audit_export", "Audit Export"},
		{"watch_list", "Watch List"},
	}},
	{Key: "admin", Label: "Administration", Icon: "settings", Pages: []CatalogPage{
		{"admin_users", "User Management"},
		{"admin_api_keys", "API Keys"},
		{"settings", "Settings"},
		{"sync_status", "Sync Status"},
		{"uploads", "Uploads"},
	}},
}

// catalogPageSet is the flattened set of every valid page-key, built once.
var catalogPageSet = func() map[string]bool {
	m := make(map[string]bool)
	for _, mod := range PageCatalog {
		for _, p := range mod.Pages {
			m[p.Key] = true
		}
	}
	return m
}()

// IsValidPage reports whether a page-key exists in the canonical catalog.
func IsValidPage(key string) bool { return catalogPageSet[key] }

// AllCatalogPages returns every valid page-key (unordered).
func AllCatalogPages() []string {
	out := make([]string, 0, len(catalogPageSet))
	for k := range catalogPageSet {
		out = append(out, k)
	}
	return out
}

// FilterValidPages returns only the page-keys that exist in the catalog, so an
// invalid/typo grant on a custom role is dropped rather than silently stored.
func FilterValidPages(pages []string) []string {
	out := make([]string, 0, len(pages))
	for _, p := range pages {
		if catalogPageSet[p] {
			out = append(out, p)
		}
	}
	return out
}
