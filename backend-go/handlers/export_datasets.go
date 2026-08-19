package handlers

/*
The export dataset registry.

Every dataset the workspace can emit as a file is declared here, once. Before
this, ~50 pages each hand-rolled their own CSV — some client-side in JavaScript
with `.join(',')` and no quoting at all, so a customer named "Doe, John" silently
shifted every column right; none of them logged anything; and each had its own
idea of who was allowed to press the button.

A dataset declares WHAT can be exported. It does not decide WHO: access to the
export engine is a single page guard (`reports`), because O3 has chosen to
concentrate data extraction in the Reports & BI module rather than spread it
across every operational screen.

Adding a dataset: add an entry below. That is the whole change — the API, the
column picker, the format support, the row cap and the audit trail all come for
free, and there is no new UI to build.

PII rules applied here, deliberately and non-optionally:
  - Card PAN is masked to the last four digits. A full PAN in a spreadsheet on
    someone's laptop is a PCI-DSS incident, and no report needs one.
  - BVN is masked the same way.
  - crm_contacts.id_number_enc / id_number_hmac are not exposed at all — they are
    the encrypted ID number and its lookup hash, and neither belongs in a file.
*/

// exportFilterKind tells the UI what control to render.
type exportFilterKind string

const (
	filterText   exportFilterKind = "text"
	filterSelect exportFilterKind = "select"
)

// exportFilter is a declared, parameterised predicate. Expr must contain exactly
// one "?" token, which is replaced with the positional placeholder. Request
// values are always bound, never interpolated.
type exportFilter struct {
	Key     string           `json:"key"`
	Label   string           `json:"label"`
	Kind    exportFilterKind `json:"kind"`
	Options []string         `json:"options,omitempty"`
	Expr    string           `json:"-"`
}

// exportDataset is one exportable view of the warehouse.
type exportDataset struct {
	Key     string         `json:"key"`
	Label   string         `json:"label"`
	Module  string         `json:"module"`
	Desc    string         `json:"description"`
	Cols    []exportCol    `json:"columns"`
	Filters []exportFilter `json:"filters,omitempty"`

	// DateCol is the SQL expression the date-range filter applies to. Empty
	// means the dataset has no natural date and the range is not offered.
	DateCol   string `json:"-"`
	DateLabel string `json:"date_label,omitempty"`

	// DateRequired forces a bounded range. Set on datasets large enough that an
	// unbounded export is a self-inflicted outage rather than a report.
	DateRequired bool `json:"date_required"`

	From    string `json:"-"` // FROM clause including any JOINs
	Where   string `json:"-"` // static predicate, without the WHERE keyword
	OrderBy string `json:"-"`

	// MaxRows caps the result. Every dataset gets one; see exportDefaultMaxRows.
	MaxRows int `json:"max_rows"`
}

const exportDefaultMaxRows = 100000

// maskedPAN / maskedBVN keep the shape of the value visible for reconciliation
// while making the file useless to anyone who steals it.
const maskedPAN = `CASE WHEN NULLIF(a.card_pan,'') IS NULL THEN NULL
                        ELSE '****' || RIGHT(a.card_pan, 4) END`
const maskedBVN = `CASE WHEN NULLIF(c.bvn,'') IS NULL THEN NULL
                        ELSE '*******' || RIGHT(c.bvn, 4) END`

// exportDatasets is the registry, ordered for display.
var exportDatasets = []exportDataset{
	// ── Credit ────────────────────────────────────────────────────────────────
	{
		Key:    "loan_book",
		Label:  "Loan Book (live)",
		Module: "Credit",
		Desc:   "The live Udara/CBS credit book with schedule-derived DPD, arrears and risk band.",
		From:   "app.cbs_loans cl",
		// Closed and Revoked loans are excluded from the default book the same
		// way every other portfolio view in the workspace excludes them, so an
		// export reconciles against the dashboards instead of contradicting them.
		Where:     "cl.status NOT IN ('Closed','Revoked')",
		OrderBy:   "cl.outstanding_principal_kobo DESC",
		DateCol:   "cl.date_booked::date",
		DateLabel: "Date booked",
		Cols: []exportCol{
			{Key: "account_number", Label: "Account Number", Type: colText, Expr: "cl.cbs_account_number"},
			{Key: "cif", Label: "CIF", Type: colText, Expr: "cl.cbs_customer_id"},
			{Key: "customer_name", Label: "Customer Name", Type: colText,
				Expr: `COALESCE((SELECT NULLIF(TRIM(cu.full_name),'') FROM app.customers cu
				                 WHERE cu.cif = cl.cbs_customer_id LIMIT 1), cl.raw->>'name')`},
			{Key: "product_name", Label: "Product", Type: colText, Expr: "cl.product_name"},
			{Key: "status", Label: "Status", Type: colText, Expr: "cl.status"},
			{Key: "loan_amount", Label: "Loan Amount (NGN)", Type: colKobo, Expr: "cl.loan_amount_kobo"},
			{Key: "outstanding_principal", Label: "Outstanding Principal (NGN)", Type: colKobo, Expr: "cl.outstanding_principal_kobo"},
			{Key: "outstanding_interest", Label: "Outstanding Interest (NGN)", Type: colKobo, Expr: "cl.outstanding_interest_kobo"},
			{Key: "outstanding_fee", Label: "Outstanding Fees (NGN)", Type: colKobo, Expr: "cl.outstanding_fee_kobo"},
			{Key: "dpd", Label: "DPD", Type: colInt, Expr: cbsLoanDPD},
			{Key: "arrears", Label: "Arrears (NGN)", Type: colKobo, Expr: cbsLoanArrears},
			{Key: "risk_band", Label: "Risk Band", Type: colText, Expr: cbsLoanBand},
			{Key: "risk_score", Label: "Risk Score", Type: colInt, Expr: cbsLoanScore},
			{Key: "interest_rate", Label: "Interest Rate (%)", Type: colPct, Expr: "cl.interest_rate"},
			{Key: "tenor_days", Label: "Tenor (days)", Type: colInt, Expr: "cl.tenor_days"},
			{Key: "sector", Label: "Sector", Type: colText, Expr: "app.cbn_sector_name(cl.economic_sector)"},
			{Key: "sector_code", Label: "Sector Code", Type: colText, Expr: "cl.economic_sector"},
			{Key: "branch_name", Label: "Branch", Type: colText, Expr: "cl.branch_name"},
			{Key: "officer_name", Label: "Officer", Type: colText, Expr: "cl.officer_name"},
			{Key: "date_booked", Label: "Date Booked", Type: colDate, Expr: "cl.date_booked"},
			{Key: "start_date", Label: "Start Date", Type: colDate, Expr: "cl.start_date"},
			{Key: "maturity_date", Label: "Maturity Date", Type: colDate, Expr: "cl.maturity_date"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterSelect, Expr: "cl.status = ?",
				Options: []string{"Active", "Defaulting", "Expired", "Approved"}},
			{Key: "product_name", Label: "Product", Kind: filterText, Expr: "cl.product_name ILIKE '%' || ? || '%'"},
			{Key: "branch_name", Label: "Branch", Kind: filterText, Expr: "cl.branch_name ILIKE '%' || ? || '%'"},
		},
	},
	{
		Key:       "loan_applications",
		Label:     "Loan Applications",
		Module:    "Credit",
		Desc:      "Origination pipeline: applications, stage, decision and Eye Score.",
		From:      "app.loan_applications la",
		OrderBy:   "la.created_at DESC",
		DateCol:   "la.created_at::date",
		DateLabel: "Created",
		Cols: []exportCol{
			{Key: "reference", Label: "Reference", Type: colText, Expr: "la.reference"},
			{Key: "applicant_name", Label: "Applicant", Type: colText, Expr: "la.applicant_name"},
			{Key: "applicant_cif", Label: "CIF", Type: colText, Expr: "la.applicant_cif"},
			{Key: "product_type", Label: "Product", Type: colText, Expr: "la.product_type"},
			{Key: "amount_requested", Label: "Amount Requested (NGN)", Type: colKobo, Expr: "la.amount_requested_kobo"},
			{Key: "amount_approved", Label: "Amount Approved (NGN)", Type: colKobo, Expr: "la.amount_approved_kobo"},
			{Key: "tenor_months", Label: "Tenor (months)", Type: colInt, Expr: "la.tenor_months"},
			{Key: "status", Label: "Status", Type: colText, Expr: "la.status"},
			{Key: "stage", Label: "Stage", Type: colText, Expr: "la.stage"},
			{Key: "decision", Label: "Decision", Type: colText, Expr: "la.decision"},
			{Key: "eye_score", Label: "Eye Score", Type: colInt, Expr: "la.eye_score"},
			{Key: "eye_rating", Label: "Eye Rating", Type: colText, Expr: "la.eye_rating"},
			{Key: "dti_pct", Label: "DTI (%)", Type: colPct, Expr: "la.dti_pct"},
			{Key: "source_system", Label: "Source System", Type: colText, Expr: "la.source_system"},
			{Key: "employer", Label: "Employer", Type: colText, Expr: "la.employer"},
			{Key: "monthly_income", Label: "Monthly Income (NGN)", Type: colKobo, Expr: "la.monthly_income_kobo"},
			{Key: "decline_reason", Label: "Decline Reason", Type: colText, Expr: "la.decline_reason"},
			{Key: "created_at", Label: "Created", Type: colDateTime, Expr: "la.created_at"},
			{Key: "submitted_at", Label: "Submitted", Type: colDateTime, Expr: "la.submitted_at"},
			{Key: "booked_at", Label: "Booked", Type: colDateTime, Expr: "la.booked_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "la.status = ?"},
			{Key: "stage", Label: "Stage", Kind: filterText, Expr: "la.stage = ?"},
			{Key: "product_type", Label: "Product", Kind: filterText, Expr: "la.product_type ILIKE '%' || ? || '%'"},
		},
	},

	// ── Cards ─────────────────────────────────────────────────────────────────
	{
		Key:       "card_accounts",
		Label:     "Card & Account Book",
		Module:    "Cards",
		Desc:      "Cardholder accounts, limits, balances and delinquency. Card PAN is masked to the last 4 digits.",
		From:      "app.accounts a",
		OrderBy:   "a.opened_date DESC NULLS LAST",
		DateCol:   "a.opened_date",
		DateLabel: "Opened",
		Cols: []exportCol{
			{Key: "account_no", Label: "Account No", Type: colText, Expr: "a.account_no"},
			{Key: "cif", Label: "CIF", Type: colText, Expr: "a.cif"},
			{Key: "name_on_card", Label: "Name on Card", Type: colText, Expr: "a.name_on_card"},
			{Key: "card_pan_masked", Label: "Card (masked)", Type: colText, Expr: maskedPAN},
			{Key: "product_name", Label: "Product", Type: colText, Expr: "a.product_name"},
			{Key: "card_program", Label: "Programme", Type: colText, Expr: "a.card_program"},
			{Key: "product_line", Label: "Product Line", Type: colText, Expr: "a.product_line"},
			{Key: "status", Label: "Status", Type: colText, Expr: "a.status"},
			// These are numeric (major units) on app.accounts, not kobo — the rest
			// of the workspace stores kobo, so this is a genuine trap.
			{Key: "card_limit", Label: "Card Limit (NGN)", Type: colMoney, Expr: "a.card_limit"},
			{Key: "current_dr_balance", Label: "Current Balance (NGN)", Type: colMoney, Expr: "a.current_dr_balance"},
			{Key: "cycle_balance", Label: "Cycle Balance (NGN)", Type: colMoney, Expr: "a.cycle_balance"},
			{Key: "min_payment_due", Label: "Min Payment Due (NGN)", Type: colMoney, Expr: "a.min_payment_due"},
			{Key: "card_utilisation", Label: "Utilisation (%)", Type: colPct, Expr: "a.card_utilisation"},
			{Key: "days_overdue", Label: "Days Overdue", Type: colInt, Expr: "a.days_overdue"},
			{Key: "collection_type", Label: "Collection Type", Type: colText, Expr: "a.collection_type"},
			{Key: "opened_date", Label: "Opened", Type: colDate, Expr: "a.opened_date"},
			{Key: "last_payment_date", Label: "Last Payment", Type: colDate, Expr: "a.last_payment_date"},
			{Key: "payment_due_date", Label: "Payment Due", Type: colDate, Expr: "a.payment_due_date"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterSelect, Expr: "a.status = ?",
				Options: []string{"Open", "Active", "Inactive", "Closed", "Terminated", "Legal Suspended"}},
			{Key: "product_name", Label: "Product", Kind: filterText, Expr: "a.product_name ILIKE '%' || ? || '%'"},
			{Key: "cif", Label: "CIF", Kind: filterText, Expr: "a.cif = ?"},
		},
	},
	{
		Key:    "card_transactions",
		Label:  "Card Transactions",
		Module: "Cards",
		Desc:   "Posted card transactions from the CCS book. A date range is required — this table holds over a million rows.",
		From:   "app.transactions t",
		// Over 1.1m rows: an unbounded export is an outage, not a report.
		DateRequired: true,
		OrderBy:      "t.txn_date DESC, t.txn_id",
		DateCol:      "t.txn_date",
		DateLabel:    "Transaction date",
		MaxRows:      250000,
		Cols: []exportCol{
			{Key: "txn_id", Label: "Txn ID", Type: colText, Expr: "t.txn_id"},
			{Key: "txn_date", Label: "Txn Date", Type: colDate, Expr: "t.txn_date"},
			{Key: "post_date", Label: "Post Date", Type: colDate, Expr: "t.post_date"},
			{Key: "cif", Label: "CIF", Type: colText, Expr: "t.cif"},
			{Key: "account_no", Label: "Account No", Type: colText, Expr: "t.account_no"},
			{Key: "description", Label: "Description", Type: colText, Expr: "t.description"},
			{Key: "txn_code", Label: "Txn Code", Type: colText, Expr: "t.txn_code"},
			// Credits are stored negative on this book — see the ledger data model.
			{Key: "amount", Label: "Amount (NGN)", Type: colMoney, Expr: "t.amount"},
			{Key: "amount_debit", Label: "Debit (NGN)", Type: colMoney, Expr: "t.amount_debit"},
			{Key: "amount_credit", Label: "Credit (NGN)", Type: colMoney, Expr: "t.amount_credit"},
			{Key: "account_balance", Label: "Balance (NGN)", Type: colMoney, Expr: "t.account_balance"},
			{Key: "channel", Label: "Channel", Type: colText, Expr: "t.channel"},
			{Key: "merchant_name", Label: "Merchant", Type: colText, Expr: "t.merchant_name"},
			{Key: "mcc", Label: "MCC", Type: colText, Expr: "t.mcc"},
			{Key: "city", Label: "City", Type: colText, Expr: "t.city"},
			{Key: "product_name", Label: "Product", Type: colText, Expr: "t.product_name"},
		},
		Filters: []exportFilter{
			{Key: "cif", Label: "CIF", Kind: filterText, Expr: "t.cif = ?"},
			{Key: "account_no", Label: "Account No", Kind: filterText, Expr: "t.account_no = ?"},
			{Key: "channel", Label: "Channel", Kind: filterText, Expr: "t.channel = ?"},
		},
	},

	// ── Customers ─────────────────────────────────────────────────────────────
	{
		Key:       "customers",
		Label:     "Customer Master",
		Module:    "Customers",
		Desc:      "The customer identity master. BVN is masked to the last 4 digits.",
		From:      "app.customers c",
		OrderBy:   "c.cif",
		DateCol:   "c.account_created::date",
		DateLabel: "Account created",
		Cols: []exportCol{
			{Key: "cif", Label: "CIF", Type: colText, Expr: "c.cif"},
			{Key: "full_name", Label: "Full Name", Type: colText, Expr: "c.full_name"},
			{Key: "phone", Label: "Phone", Type: colText, Expr: "c.phone"},
			{Key: "email", Label: "Email", Type: colText, Expr: "c.email"},
			{Key: "bvn_masked", Label: "BVN (masked)", Type: colText, Expr: maskedBVN},
			{Key: "gender", Label: "Gender", Type: colText, Expr: "c.gender"},
			{Key: "birthday", Label: "Date of Birth", Type: colDate, Expr: "c.birthday"},
			{Key: "city", Label: "City", Type: colText, Expr: "c.city"},
			{Key: "state", Label: "State", Type: colText, Expr: "c.state"},
			{Key: "country", Label: "Country", Type: colText, Expr: "c.country"},
			{Key: "full_address", Label: "Address", Type: colText, Expr: "c.full_address"},
			{Key: "job_title", Label: "Job Title", Type: colText, Expr: "c.job_title"},
			{Key: "account_status", Label: "Account Status", Type: colText, Expr: "c.account_status"},
			{Key: "account_created", Label: "Account Created", Type: colDate, Expr: "c.account_created"},
		},
		Filters: []exportFilter{
			{Key: "state", Label: "State", Kind: filterText, Expr: "c.state ILIKE ?"},
			{Key: "account_status", Label: "Account Status", Kind: filterText, Expr: "c.account_status = ?"},
			{Key: "cif", Label: "CIF", Kind: filterText, Expr: "c.cif = ?"},
		},
	},
	{
		Key:       "crm_contacts",
		Label:     "CRM Contacts & Leads",
		Module:    "Sales & CRM",
		Desc:      "CRM contacts and the lead pipeline. Encrypted ID numbers are never exported.",
		From:      "app.crm_contacts k",
		OrderBy:   "k.created_at DESC",
		DateCol:   "k.created_at::date",
		DateLabel: "Created",
		Cols: []exportCol{
			{Key: "contact_name", Label: "Name", Type: colText,
				Expr: `NULLIF(TRIM(COALESCE(k.first_name,'') || ' ' || COALESCE(k.last_name,'')), '')`},
			{Key: "phone", Label: "Phone", Type: colText, Expr: "k.phone"},
			{Key: "email", Label: "Email", Type: colText, Expr: "k.email"},
			{Key: "cif_number", Label: "CIF", Type: colText, Expr: "k.cif_number"},
			{Key: "status", Label: "Status", Type: colText, Expr: "k.status"},
			{Key: "lead_stage", Label: "Lead Stage", Type: colText, Expr: "k.lead_stage"},
			{Key: "lead_source", Label: "Lead Source", Type: colText, Expr: "k.lead_source"},
			{Key: "source_type", Label: "Source Type", Type: colText, Expr: "k.source_type"},
			{Key: "employer", Label: "Employer", Type: colText, Expr: "k.employer"},
			{Key: "occupation", Label: "Occupation", Type: colText, Expr: "k.occupation"},
			{Key: "income_range", Label: "Income Range", Type: colText, Expr: "k.income_range"},
			{Key: "estimated_value", Label: "Estimated Value (NGN)", Type: colKobo, Expr: "k.estimated_value_kobo"},
			{Key: "state", Label: "State", Type: colText, Expr: "k.state"},
			{Key: "city", Label: "City", Type: colText, Expr: "k.city"},
			{Key: "owner_name", Label: "Lead Owner", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = k.lead_owner_id)`},
			{Key: "created_at", Label: "Created", Type: colDateTime, Expr: "k.created_at"},
			{Key: "qualified_at", Label: "Qualified", Type: colDateTime, Expr: "k.qualified_at"},
			{Key: "converted_at", Label: "Converted", Type: colDateTime, Expr: "k.converted_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "k.status = ?"},
			{Key: "lead_stage", Label: "Lead Stage", Kind: filterText, Expr: "k.lead_stage = ?"},
			{Key: "lead_source", Label: "Lead Source", Kind: filterText, Expr: "k.lead_source ILIKE '%' || ? || '%'"},
		},
	},

	// ── Fixed Deposits ────────────────────────────────────────────────────────
	{
		Key:       "fixed_deposits",
		Label:     "Fixed Deposit Book",
		Module:    "Fixed Deposits",
		Desc:      "The live CBS fixed-deposit book with principal, accrued interest and maturity.",
		From:      "app.cbs_fixed_deposits fd",
		OrderBy:   "fd.principal_kobo DESC",
		DateCol:   "fd.date_booked::date",
		DateLabel: "Date booked",
		Cols: []exportCol{
			{Key: "account_number", Label: "Account Number", Type: colText, Expr: "fd.cbs_account_number"},
			{Key: "cif", Label: "CIF", Type: colText, Expr: "fd.cbs_customer_id"},
			{Key: "customer_name", Label: "Customer Name", Type: colText,
				Expr: `COALESCE((SELECT NULLIF(TRIM(cu.full_name),'') FROM app.customers cu
				                 WHERE cu.cif = fd.cbs_customer_id LIMIT 1), fd.raw->>'name')`},
			{Key: "product_name", Label: "Product", Type: colText, Expr: "fd.product_name"},
			{Key: "status", Label: "Status", Type: colText, Expr: "fd.status"},
			{Key: "principal", Label: "Principal (NGN)", Type: colKobo, Expr: "fd.principal_kobo"},
			{Key: "accrued_interest", Label: "Accrued Interest (NGN)", Type: colKobo, Expr: "fd.accrued_interest_kobo"},
			{Key: "ledger_balance", Label: "Ledger Balance (NGN)", Type: colKobo, Expr: "fd.ledger_balance_kobo"},
			{Key: "interest_rate", Label: "Interest Rate (%)", Type: colPct, Expr: "fd.interest_rate"},
			{Key: "tenor_days", Label: "Tenor (days)", Type: colInt, Expr: "fd.tenor_days"},
			{Key: "rollover_count", Label: "Rollovers", Type: colInt, Expr: "fd.rollover_count"},
			{Key: "branch_name", Label: "Branch", Type: colText, Expr: "fd.branch_name"},
			{Key: "commencement_date", Label: "Commencement", Type: colDate, Expr: "fd.commencement_date"},
			{Key: "maturity_date", Label: "Maturity", Type: colDate, Expr: "fd.maturity_date"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "fd.status = ?"},
			{Key: "product_name", Label: "Product", Kind: filterText, Expr: "fd.product_name ILIKE '%' || ? || '%'"},
		},
	},

	// ── Collections ───────────────────────────────────────────────────────────
	{
		Key:       "collections_assignments",
		Label:     "Collections Assignments",
		Module:    "Collections",
		Desc:      "Delinquent accounts assigned to collections agents, with DPD bucket and target.",
		From:      "app.collection_assignments ca",
		OrderBy:   "ca.outstanding_kobo DESC",
		DateCol:   "ca.created_at::date",
		DateLabel: "Assigned",
		Cols: []exportCol{
			{Key: "cif_number", Label: "CIF", Type: colText, Expr: "ca.cif_number"},
			{Key: "customer_name", Label: "Customer Name", Type: colText, Expr: "ca.customer_name"},
			{Key: "dpd_bucket", Label: "DPD Bucket", Type: colText, Expr: "ca.dpd_bucket"},
			{Key: "outstanding", Label: "Outstanding (NGN)", Type: colKobo, Expr: "ca.outstanding_kobo"},
			{Key: "target_amount", Label: "Target (NGN)", Type: colKobo, Expr: "ca.target_amount_kobo"},
			{Key: "status", Label: "Status", Type: colText, Expr: "ca.status"},
			{Key: "current_stage", Label: "Stage", Type: colText, Expr: "ca.current_stage"},
			{Key: "agent_name", Label: "Agent", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = ca.agent_user_id)`},
			{Key: "assignment_date", Label: "Assignment Date", Type: colDate, Expr: "ca.assignment_date"},
			{Key: "created_at", Label: "Created", Type: colDateTime, Expr: "ca.created_at"},
		},
		Filters: []exportFilter{
			{Key: "dpd_bucket", Label: "DPD Bucket", Kind: filterText, Expr: "ca.dpd_bucket = ?"},
			{Key: "status", Label: "Status", Kind: filterText, Expr: "ca.status = ?"},
		},
	},
	{
		Key:       "collections_payments",
		Label:     "Collections Payments",
		Module:    "Collections",
		Desc:      "Payments recorded against collections cases, with reconciliation state.",
		From:      "app.collection_payments cp",
		OrderBy:   "cp.payment_date DESC",
		DateCol:   "cp.payment_date",
		DateLabel: "Payment date",
		Cols: []exportCol{
			{Key: "account_cif", Label: "CIF", Type: colText, Expr: "cp.account_cif"},
			{Key: "amount", Label: "Amount (NGN)", Type: colKobo, Expr: "cp.amount_kobo"},
			{Key: "payment_date", Label: "Payment Date", Type: colDate, Expr: "cp.payment_date"},
			{Key: "channel", Label: "Channel", Type: colText, Expr: "cp.channel"},
			{Key: "reference", Label: "Reference", Type: colText, Expr: "cp.reference"},
			{Key: "paystack_reference", Label: "Paystack Reference", Type: colText, Expr: "cp.paystack_reference"},
			{Key: "reconciled", Label: "Reconciled", Type: colBool, Expr: "cp.reconciled"},
			{Key: "reconciled_at", Label: "Reconciled At", Type: colDateTime, Expr: "cp.reconciled_at"},
			{Key: "gl_reference", Label: "GL Reference", Type: colText, Expr: "cp.gl_reference"},
			{Key: "received_by_name", Label: "Received By", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = cp.received_by)`},
		},
		Filters: []exportFilter{
			{Key: "channel", Label: "Channel", Kind: filterText, Expr: "cp.channel = ?"},
		},
	},

	// ── Settlements ───────────────────────────────────────────────────────────
	{
		Key:       "paystack_transactions",
		Label:     "Paystack Transactions",
		Module:    "Settlements",
		Desc:      "The Paystack transaction mirror used for settlement reconciliation.",
		From:      "app.paystack_transactions pt",
		OrderBy:   "pt.paid_at DESC NULLS LAST",
		DateCol:   "COALESCE(pt.paid_at, pt.created_at_ps)::date",
		DateLabel: "Paid",
		Cols: []exportCol{
			{Key: "reference", Label: "Reference", Type: colText, Expr: "pt.reference"},
			{Key: "status", Label: "Status", Type: colText, Expr: "pt.status"},
			{Key: "channel", Label: "Channel", Type: colText, Expr: "pt.channel"},
			{Key: "currency", Label: "Currency", Type: colText, Expr: "pt.currency"},
			{Key: "amount", Label: "Amount", Type: colKobo, Expr: "pt.amount_kobo"},
			{Key: "fees", Label: "Fees", Type: colKobo, Expr: "pt.fees_kobo"},
			{Key: "customer_email", Label: "Customer Email", Type: colText, Expr: "pt.customer_email"},
			{Key: "customer_phone", Label: "Customer Phone", Type: colText, Expr: "pt.customer_phone"},
			{Key: "auth_bank", Label: "Bank", Type: colText, Expr: "pt.auth_bank"},
			{Key: "auth_card_type", Label: "Card Type", Type: colText, Expr: "pt.auth_card_type"},
			{Key: "auth_last4", Label: "Last 4", Type: colText, Expr: "pt.auth_last4"},
			{Key: "gateway_response", Label: "Gateway Response", Type: colText, Expr: "pt.gateway_response"},
			{Key: "paid_at", Label: "Paid At", Type: colDateTime, Expr: "pt.paid_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "pt.status = ?"},
			{Key: "channel", Label: "Channel", Kind: filterText, Expr: "pt.channel = ?"},
		},
	},
	{
		Key:       "recon_exceptions",
		Label:     "Reconciliation Exceptions",
		Module:    "Settlements",
		Desc:      "Unmatched and disputed items raised by the reconciliation engine.",
		From:      "app.recon_exceptions re",
		OrderBy:   "re.created_at DESC",
		DateCol:   "re.txn_date",
		DateLabel: "Transaction date",
		Cols: []exportCol{
			{Key: "source", Label: "Source", Type: colText, Expr: "re.source"},
			{Key: "source_ref", Label: "Source Reference", Type: colText, Expr: "re.source_ref"},
			{Key: "txn_date", Label: "Txn Date", Type: colDate, Expr: "re.txn_date"},
			{Key: "amount", Label: "Amount (NGN)", Type: colKobo, Expr: "re.amount_kobo"},
			{Key: "reason", Label: "Reason", Type: colText, Expr: "re.reason"},
			{Key: "status", Label: "Status", Type: colText, Expr: "re.status"},
			{Key: "resolution_code", Label: "Resolution Code", Type: colText, Expr: "re.resolution_code"},
			{Key: "resolution_note", Label: "Resolution Note", Type: colText, Expr: "re.resolution_note"},
			{Key: "resolved_at", Label: "Resolved At", Type: colDateTime, Expr: "re.resolved_at"},
			{Key: "created_at", Label: "Created", Type: colDateTime, Expr: "re.created_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "re.status = ?"},
			{Key: "source", Label: "Source", Kind: filterText, Expr: "re.source = ?"},
		},
	},

	// ── Contact Centre ────────────────────────────────────────────────────────
	{
		Key:       "helpdesk_tickets",
		Label:     "Helpdesk Tickets",
		Module:    "Helpdesk",
		Desc:      "Support tickets with SLA, resolution and CSAT.",
		From:      "app.helpdesk_tickets ht",
		OrderBy:   "ht.created_at DESC",
		DateCol:   "ht.created_at::date",
		DateLabel: "Created",
		Cols: []exportCol{
			{Key: "ticket_ref", Label: "Ticket Ref", Type: colText, Expr: "ht.ticket_ref"},
			{Key: "subject", Label: "Subject", Type: colText, Expr: "ht.subject"},
			{Key: "channel", Label: "Channel", Type: colText, Expr: "ht.channel"},
			{Key: "status", Label: "Status", Type: colText, Expr: "ht.status"},
			{Key: "priority", Label: "Priority", Type: colText, Expr: "ht.priority"},
			{Key: "ticket_type", Label: "Type", Type: colText, Expr: "ht.ticket_type"},
			{Key: "queue", Label: "Queue", Type: colText, Expr: "ht.queue"},
			{Key: "department", Label: "Department", Type: colText, Expr: "ht.department"},
			{Key: "customer_cif", Label: "CIF", Type: colText, Expr: "ht.customer_cif"},
			{Key: "customer_name", Label: "Customer", Type: colText, Expr: "COALESCE(ht.customer_name, ht.contact_name)"},
			{Key: "customer_email", Label: "Customer Email", Type: colText, Expr: "ht.customer_email"},
			{Key: "assignee_name", Label: "Assigned To", Type: colText,
				Expr: `COALESCE((SELECT u.full_name FROM app.o3c_users u WHERE u.id = ht.assigned_to), ht.zoho_assignee_name)`},
			{Key: "sla_breached", Label: "SLA Breached", Type: colBool, Expr: "ht.sla_breached"},
			{Key: "csat_score", Label: "CSAT", Type: colInt, Expr: "ht.csat_score"},
			{Key: "created_at", Label: "Created", Type: colDateTime, Expr: "ht.created_at"},
			{Key: "first_response_at", Label: "First Response", Type: colDateTime, Expr: "ht.first_response_at"},
			{Key: "resolved_at", Label: "Resolved", Type: colDateTime, Expr: "ht.resolved_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "ht.status = ?"},
			{Key: "channel", Label: "Channel", Kind: filterText, Expr: "ht.channel = ?"},
			{Key: "priority", Label: "Priority", Kind: filterText, Expr: "ht.priority = ?"},
		},
	},
	{
		Key:       "helpdesk_calls",
		Label:     "Call Log",
		Module:    "Call Centre",
		Desc:      "Inbound and outbound calls with direction, purpose, outcome and duration.",
		From:      "app.helpdesk_calls hc",
		OrderBy:   "COALESCE(hc.started_at, hc.created_at) DESC",
		DateCol:   "COALESCE(hc.started_at, hc.created_at)::date",
		DateLabel: "Call date",
		Cols: []exportCol{
			{Key: "started_at", Label: "Started", Type: colDateTime, Expr: "COALESCE(hc.started_at, hc.created_at)"},
			{Key: "direction", Label: "Direction", Type: colText, Expr: "hc.direction"},
			{Key: "purpose", Label: "Purpose", Type: colText, Expr: "hc.purpose"},
			{Key: "agent_name", Label: "Agent", Type: colText,
				Expr: `COALESCE((SELECT u.full_name FROM app.o3c_users u WHERE u.id = hc.agent_id), hc.agent_name)`},
			{Key: "customer_name", Label: "Customer", Type: colText, Expr: "hc.customer_name"},
			{Key: "customer_cif", Label: "CIF", Type: colText, Expr: "hc.customer_cif"},
			{Key: "customer_phone", Label: "Phone", Type: colText, Expr: "hc.customer_phone"},
			{Key: "duration_sec", Label: "Duration (sec)", Type: colInt, Expr: "hc.duration_sec"},
			{Key: "outcome", Label: "Outcome", Type: colText, Expr: "hc.outcome"},
			{Key: "disposition", Label: "Disposition", Type: colText, Expr: "hc.disposition"},
			{Key: "resolution", Label: "Resolution", Type: colText, Expr: "hc.resolution"},
			{Key: "ticket_ref", Label: "Linked Ticket", Type: colText, Expr: "hc.ticket_ref"},
			{Key: "source_system", Label: "Source", Type: colText, Expr: "hc.source_system"},
		},
		Filters: []exportFilter{
			{Key: "direction", Label: "Direction", Kind: filterSelect, Expr: "hc.direction = ?",
				Options: []string{"inbound", "outbound"}},
			{Key: "outcome", Label: "Outcome", Kind: filterText, Expr: "hc.outcome = ?"},
		},
	},

	// ── Cards (continued) ─────────────────────────────────────────────────────
	{
		Key:       "card_cycle_data",
		Label:     "Card Statement Cycles",
		Module:    "Cards",
		Desc:      "Per-cycle billed balances, minimum payments, fees, interest and penalties.",
		From:      "app.card_cycle_data cd",
		OrderBy:   "cd.cycle_date DESC, cd.outstanding_balance_kobo DESC",
		DateCol:   "cd.cycle_date",
		DateLabel: "Cycle date",
		Cols: []exportCol{
			{Key: "cycle_date", Label: "Cycle Date", Type: colDate, Expr: "cd.cycle_date"},
			{Key: "account_number", Label: "Account Number", Type: colText, Expr: "cd.account_number"},
			{Key: "cif", Label: "CIF", Type: colText, Expr: "cd.cif"},
			{Key: "product_code", Label: "Product Code", Type: colText, Expr: "cd.product_code"},
			{Key: "currency", Label: "Currency", Type: colText, Expr: "cd.currency"},
			{Key: "credit_limit", Label: "Credit Limit (NGN)", Type: colKobo, Expr: "cd.credit_limit_kobo"},
			{Key: "billed_balance", Label: "Billed Balance (NGN)", Type: colKobo, Expr: "cd.billed_balance_kobo"},
			{Key: "outstanding_balance", Label: "Outstanding (NGN)", Type: colKobo, Expr: "cd.outstanding_balance_kobo"},
			{Key: "overdue_amount", Label: "Overdue (NGN)", Type: colKobo, Expr: "cd.overdue_amount_kobo"},
			{Key: "minimum_payment", Label: "Minimum Payment (NGN)", Type: colKobo, Expr: "cd.minimum_payment_kobo"},
			{Key: "total_payment", Label: "Total Paid (NGN)", Type: colKobo, Expr: "cd.total_payment_kobo"},
			{Key: "purchase_amount", Label: "Purchases (NGN)", Type: colKobo, Expr: "cd.purchase_amount_kobo"},
			{Key: "cash_advance", Label: "Cash Advance (NGN)", Type: colKobo, Expr: "cd.cash_advance_kobo"},
			{Key: "fees", Label: "Fees (NGN)", Type: colKobo, Expr: "cd.fees_kobo"},
			{Key: "interest_charged", Label: "Interest Charged (NGN)", Type: colKobo, Expr: "cd.interest_charged_kobo"},
			{Key: "penalty", Label: "Penalty (NGN)", Type: colKobo, Expr: "cd.penalty_kobo"},
		},
		Filters: []exportFilter{
			{Key: "cif", Label: "CIF", Kind: filterText, Expr: "cd.cif = ?"},
			{Key: "product_code", Label: "Product Code", Kind: filterText, Expr: "cd.product_code = ?"},
			{Key: "currency", Label: "Currency", Kind: filterText, Expr: "cd.currency = ?"},
		},
	},

	// ── Customers (continued) ─────────────────────────────────────────────────
	{
		Key:    "parties",
		Label:  "People (deduplicated)",
		Module: "Customers",
		Desc: "The person layer: one row per human being, with how many cards they hold. " +
			"A CIF is a card, not a person — this is the honest customer count.",
		From:      "app.parties p",
		OrderBy:   "p.card_count DESC NULLS LAST",
		DateCol:   "p.created_at::date",
		DateLabel: "First seen",
		Cols: []exportCol{
			{Key: "party_key", Label: "Party Key", Type: colText, Expr: "p.party_key"},
			{Key: "full_name", Label: "Full Name", Type: colText, Expr: "p.full_name"},
			{Key: "party_type", Label: "Type", Type: colText, Expr: "p.party_type"},
			{Key: "primary_phone", Label: "Phone", Type: colText, Expr: "p.primary_phone"},
			{Key: "primary_email", Label: "Email", Type: colText, Expr: "p.primary_email"},
			// Masked for the same reason as the customer master.
			{Key: "bvn_masked", Label: "BVN (masked)", Type: colText,
				Expr: `CASE WHEN NULLIF(p.bvn,'') IS NULL THEN NULL
				            ELSE '*******' || RIGHT(p.bvn, 4) END`},
			{Key: "card_count", Label: "Cards Held", Type: colInt, Expr: "p.card_count"},
			{Key: "created_at", Label: "First Seen", Type: colDateTime, Expr: "p.created_at"},
		},
		Filters: []exportFilter{
			{Key: "party_type", Label: "Type", Kind: filterText, Expr: "p.party_type = ?"},
		},
	},

	// ── Settlements (continued) ───────────────────────────────────────────────
	{
		Key:       "paystack_transfers",
		Label:     "Paystack Transfers (payouts)",
		Module:    "Settlements",
		Desc:      "Outbound transfers: recipient, bank, status and failure reason.",
		From:      "app.paystack_transfers pt",
		OrderBy:   "COALESCE(pt.transferred_at, pt.created_at_ps) DESC NULLS LAST",
		DateCol:   "COALESCE(pt.transferred_at, pt.created_at_ps)::date",
		DateLabel: "Transferred",
		Cols: []exportCol{
			{Key: "reference", Label: "Reference", Type: colText, Expr: "pt.reference"},
			{Key: "transfer_code", Label: "Transfer Code", Type: colText, Expr: "pt.transfer_code"},
			{Key: "status", Label: "Status", Type: colText, Expr: "pt.status"},
			{Key: "currency", Label: "Currency", Type: colText, Expr: "pt.currency"},
			{Key: "amount", Label: "Amount", Type: colKobo, Expr: "pt.amount_kobo"},
			{Key: "fee", Label: "Fee", Type: colKobo, Expr: "pt.fee_kobo"},
			{Key: "recipient_name", Label: "Recipient", Type: colText, Expr: "pt.recipient_name"},
			{Key: "recipient_bank", Label: "Bank", Type: colText, Expr: "pt.recipient_bank"},
			{Key: "recipient_account", Label: "Account", Type: colText, Expr: "pt.recipient_account"},
			{Key: "reason", Label: "Reason", Type: colText, Expr: "pt.reason"},
			{Key: "failures", Label: "Failure Detail", Type: colText, Expr: "pt.failures"},
			{Key: "transferred_at", Label: "Transferred At", Type: colDateTime, Expr: "pt.transferred_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "pt.status = ?"},
			{Key: "recipient_bank", Label: "Bank", Kind: filterText, Expr: "pt.recipient_bank ILIKE '%' || ? || '%'"},
		},
	},
	{
		Key:       "recon_matches",
		Label:     "Reconciliation Matches",
		Module:    "Settlements",
		Desc:      "Matched pairs produced by the reconciliation engine, with tier and confidence.",
		From:      "app.recon_matches rm",
		OrderBy:   "rm.txn_date DESC",
		DateCol:   "rm.txn_date",
		DateLabel: "Transaction date",
		Cols: []exportCol{
			{Key: "txn_date", Label: "Txn Date", Type: colDate, Expr: "rm.txn_date"},
			{Key: "source_key", Label: "Source Key", Type: colText, Expr: "rm.source_key"},
			{Key: "counterparty_key", Label: "Counterparty Key", Type: colText, Expr: "rm.counterparty_key"},
			{Key: "amount", Label: "Amount (NGN)", Type: colKobo, Expr: "rm.amount_kobo"},
			{Key: "tier", Label: "Match Tier", Type: colText, Expr: "rm.tier::text"},
			{Key: "confidence", Label: "Confidence", Type: colPct, Expr: "rm.confidence"},
			{Key: "created_at", Label: "Matched At", Type: colDateTime, Expr: "rm.created_at"},
		},
		Filters: []exportFilter{
			{Key: "tier", Label: "Match Tier", Kind: filterText, Expr: "rm.tier::text = ?"},
		},
	},

	// ── Recovery ──────────────────────────────────────────────────────────────
	{
		Key:       "recovery_cases",
		Label:     "Recovery Cases",
		Module:    "Recovery",
		Desc:      "Cases handed to recovery, with legal stage, amounts recovered and write-off status.",
		From:      "app.recovery_cases rc",
		OrderBy:   "rc.outstanding_kobo DESC NULLS LAST",
		DateCol:   "COALESCE(rc.opened_at, rc.created_at)::date",
		DateLabel: "Opened",
		Cols: []exportCol{
			{Key: "case_ref", Label: "Case Ref", Type: colText, Expr: "rc.case_ref"},
			{Key: "cif_number", Label: "CIF", Type: colText, Expr: "COALESCE(rc.cif_number, rc.account_cif)"},
			{Key: "account_number", Label: "Account Number", Type: colText, Expr: "rc.account_number"},
			{Key: "status", Label: "Status", Type: colText, Expr: "rc.status"},
			{Key: "legal_stage", Label: "Legal Stage", Type: colText, Expr: "rc.legal_stage"},
			{Key: "outstanding", Label: "Outstanding (NGN)", Type: colKobo, Expr: "COALESCE(rc.outstanding_kobo, rc.total_outstanding_kobo)"},
			{Key: "recovered", Label: "Recovered (NGN)", Type: colKobo, Expr: "COALESCE(rc.recovered_kobo, rc.total_recovered_kobo)"},
			{Key: "write_off_status", Label: "Write-off Status", Type: colText, Expr: "rc.write_off_status"},
			{Key: "write_off_amount", Label: "Write-off Amount (NGN)", Type: colKobo, Expr: "rc.write_off_amount_kobo"},
			{Key: "dpd_at_handoff", Label: "DPD at Handoff", Type: colInt, Expr: "rc.dpd_at_handoff"},
			{Key: "solicitor", Label: "Solicitor", Type: colText, Expr: "rc.solicitor"},
			{Key: "agent_name", Label: "Agent", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u
				        WHERE u.id = COALESCE(rc.assigned_agent_id, rc.assigned_to_user_id))`},
			{Key: "opened_at", Label: "Opened", Type: colDateTime, Expr: "COALESCE(rc.opened_at, rc.created_at)"},
			{Key: "closed_at", Label: "Closed", Type: colDateTime, Expr: "rc.closed_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "rc.status = ?"},
			{Key: "write_off_status", Label: "Write-off Status", Kind: filterText, Expr: "rc.write_off_status = ?"},
		},
	},

	// ── Settlements (continued) ───────────────────────────────────────────────
	{
		Key:       "settlement_exceptions",
		Label:     "Settlement Exceptions",
		Module:    "Settlements",
		Desc:      "Exceptions raised against settlement batches.",
		From:      "app.settlement_exceptions se",
		OrderBy:   "se.created_at DESC",
		DateCol:   "se.txn_date",
		DateLabel: "Transaction date",
		Cols: []exportCol{
			{Key: "txn_ref", Label: "Txn Reference", Type: colText, Expr: "se.txn_ref"},
			{Key: "batch_id", Label: "Batch", Type: colText, Expr: "se.batch_id::text"},
			{Key: "txn_date", Label: "Txn Date", Type: colDate, Expr: "se.txn_date"},
			{Key: "amount", Label: "Amount (NGN)", Type: colKobo, Expr: "se.amount_kobo"},
			{Key: "exception_type", Label: "Exception Type", Type: colText, Expr: "se.exception_type"},
			{Key: "description", Label: "Description", Type: colText, Expr: "se.description"},
			{Key: "status", Label: "Status", Type: colText, Expr: "se.status"},
			{Key: "resolution_note", Label: "Resolution Note", Type: colText, Expr: "se.resolution_note"},
			{Key: "resolved_at", Label: "Resolved At", Type: colDateTime, Expr: "se.resolved_at"},
			{Key: "created_at", Label: "Created", Type: colDateTime, Expr: "se.created_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "se.status = ?"},
			{Key: "exception_type", Label: "Exception Type", Kind: filterText, Expr: "se.exception_type = ?"},
		},
	},

	// ── Call centre queue ─────────────────────────────────────────────────────
	{
		Key:       "call_center_queue",
		Label:     "Call Centre Queue",
		Module:    "Call Centre",
		Desc:      "The outbound contact queue with priority, attempts and last disposition.",
		From:      "app.call_center_contacts cc",
		OrderBy:   "cc.priority NULLS LAST, cc.outstanding_kobo DESC NULLS LAST",
		DateCol:   "cc.created_at::date",
		DateLabel: "Added",
		Cols: []exportCol{
			{Key: "customer_name", Label: "Customer", Type: colText, Expr: "cc.customer_name"},
			{Key: "phone", Label: "Phone", Type: colText, Expr: "cc.phone"},
			{Key: "cif", Label: "CIF", Type: colText, Expr: "cc.cif"},
			{Key: "purpose", Label: "Purpose", Type: colText, Expr: "cc.purpose"},
			{Key: "product_name", Label: "Product", Type: colText, Expr: "cc.product_name"},
			{Key: "priority", Label: "Priority", Type: colText, Expr: "cc.priority"},
			{Key: "outstanding", Label: "Outstanding (NGN)", Type: colKobo, Expr: "cc.outstanding_kobo"},
			{Key: "dpd", Label: "DPD", Type: colInt, Expr: "cc.dpd"},
			{Key: "status", Label: "Status", Type: colText, Expr: "cc.status"},
			{Key: "attempts", Label: "Attempts", Type: colInt, Expr: "cc.attempts"},
			{Key: "connects", Label: "Connects", Type: colInt, Expr: "cc.connects"},
			{Key: "last_disposition", Label: "Last Disposition", Type: colText, Expr: "cc.last_disposition"},
			{Key: "last_called_at", Label: "Last Called", Type: colDateTime, Expr: "cc.last_called_at"},
			{Key: "callback_at", Label: "Callback Due", Type: colDateTime, Expr: "cc.callback_at"},
			{Key: "agent_name", Label: "Assigned To", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = cc.assigned_to)`},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "cc.status = ?"},
			{Key: "purpose", Label: "Purpose", Kind: filterText, Expr: "cc.purpose = ?"},
			{Key: "priority", Label: "Priority", Kind: filterText, Expr: "cc.priority = ?"},
		},
	},

	// ── Finance ───────────────────────────────────────────────────────────────
	{
		Key:       "fee_income",
		Label:     "Fee Income",
		Module:    "Finance",
		Desc:      "Fee income postings by type, product and account.",
		From:      "app.fee_income fi",
		OrderBy:   "fi.fee_date DESC",
		DateCol:   "fi.fee_date",
		DateLabel: "Fee date",
		Cols: []exportCol{
			{Key: "fee_date", Label: "Fee Date", Type: colDate, Expr: "fi.fee_date"},
			{Key: "fee_type", Label: "Fee Type", Type: colText, Expr: "fi.fee_type"},
			{Key: "product_code", Label: "Product Code", Type: colText, Expr: "fi.product_code"},
			{Key: "account_number", Label: "Account Number", Type: colText, Expr: "fi.account_number"},
			{Key: "cif", Label: "CIF", Type: colText, Expr: "fi.cif"},
			{Key: "currency", Label: "Currency", Type: colText, Expr: "fi.currency"},
			{Key: "amount", Label: "Amount", Type: colKobo, Expr: "fi.amount_kobo"},
			{Key: "ref", Label: "Reference", Type: colText, Expr: "fi.ref"},
		},
		Filters: []exportFilter{
			{Key: "fee_type", Label: "Fee Type", Kind: filterText, Expr: "fi.fee_type = ?"},
			{Key: "currency", Label: "Currency", Kind: filterText, Expr: "fi.currency = ?"},
		},
	},

	// ── Compliance ────────────────────────────────────────────────────────────
	{
		Key:     "soc2_controls",
		Label:   "SOC 2 Controls",
		Module:  "Compliance",
		Desc:    "The SOC 2 control register with status, owner and evidence summary.",
		From:    "app.soc2_controls sc",
		OrderBy: "sc.sort_order NULLS LAST, sc.criteria_code",
		Cols: []exportCol{
			{Key: "criteria_code", Label: "Criteria Code", Type: colText, Expr: "sc.criteria_code"},
			{Key: "criteria_group", Label: "Criteria Group", Type: colText, Expr: "sc.criteria_group"},
			{Key: "trust_criteria", Label: "Trust Criteria", Type: colText, Expr: "sc.trust_criteria"},
			{Key: "title", Label: "Title", Type: colText, Expr: "sc.title"},
			{Key: "description", Label: "Description", Type: colText, Expr: "sc.description"},
			{Key: "control_type", Label: "Control Type", Type: colText, Expr: "sc.control_type"},
			{Key: "frequency", Label: "Frequency", Type: colText, Expr: "sc.frequency"},
			{Key: "status", Label: "Status", Type: colText, Expr: "sc.status"},
			{Key: "owner_name", Label: "Owner", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = sc.owner_id)`},
			{Key: "evidence_summary", Label: "Evidence", Type: colText, Expr: "sc.evidence_summary"},
			{Key: "waiver_reason", Label: "Waiver Reason", Type: colText, Expr: "sc.waiver_reason"},
			{Key: "target_date", Label: "Target Date", Type: colDate, Expr: "sc.target_date"},
			{Key: "completed_at", Label: "Completed", Type: colDateTime, Expr: "sc.completed_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "sc.status = ?"},
			{Key: "trust_criteria", Label: "Trust Criteria", Kind: filterText, Expr: "sc.trust_criteria = ?"},
		},
	},
	{
		Key:       "audit_findings",
		Label:     "Audit Findings",
		Module:    "Compliance",
		Desc:      "Audit findings with severity, owner, due date and closure state.",
		From:      "app.audit_findings af",
		OrderBy:   "af.created_at DESC",
		DateCol:   "af.created_at::date",
		DateLabel: "Raised",
		Cols: []exportCol{
			{Key: "finding_ref", Label: "Finding Ref", Type: colText, Expr: "af.finding_ref"},
			{Key: "source", Label: "Source", Type: colText, Expr: "af.source"},
			{Key: "severity", Label: "Severity", Type: colText, Expr: "af.severity"},
			{Key: "description", Label: "Description", Type: colText, Expr: "af.description"},
			{Key: "recommendation", Label: "Recommendation", Type: colText, Expr: "af.recommendation"},
			{Key: "status", Label: "Status", Type: colText, Expr: "af.status"},
			{Key: "owner_name", Label: "Assigned To", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = af.assigned_to)`},
			{Key: "due_date", Label: "Due Date", Type: colDate, Expr: "af.due_date"},
			{Key: "overdue", Label: "Overdue", Type: colBool,
				Expr: `(af.status <> 'closed' AND af.due_date IS NOT NULL AND af.due_date < CURRENT_DATE)`},
			{Key: "created_at", Label: "Raised", Type: colDateTime, Expr: "af.created_at"},
			{Key: "closed_at", Label: "Closed", Type: colDateTime, Expr: "af.closed_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "af.status = ?"},
			{Key: "severity", Label: "Severity", Kind: filterText, Expr: "af.severity = ?"},
		},
	},
	{
		Key:       "mail_suppressions",
		Label:     "Mail Suppressions",
		Module:    "Campaigns",
		Desc:      "Suppressed email addresses: bounces, complaints and unsubscribes.",
		From:      "app.mail_suppressions ms",
		OrderBy:   "ms.created_at DESC",
		DateCol:   "ms.created_at::date",
		DateLabel: "Suppressed",
		Cols: []exportCol{
			{Key: "email", Label: "Email", Type: colText, Expr: "ms.email"},
			{Key: "reason", Label: "Reason", Type: colText, Expr: "ms.reason"},
			{Key: "source", Label: "Source", Type: colText, Expr: "ms.source"},
			{Key: "is_active", Label: "Active", Type: colBool, Expr: "ms.is_active"},
			{Key: "created_at", Label: "Suppressed", Type: colDateTime, Expr: "ms.created_at"},
			{Key: "updated_at", Label: "Updated", Type: colDateTime, Expr: "ms.updated_at"},
		},
		Filters: []exportFilter{
			{Key: "reason", Label: "Reason", Kind: filterText, Expr: "ms.reason = ?"},
			{Key: "source", Label: "Source", Kind: filterText, Expr: "ms.source = ?"},
		},
	},
	{
		Key:       "audit_trail",
		Label:     "Audit Trail",
		Module:    "Compliance",
		Desc:      "Who did what, where and from which address. Sourced from the activity log.",
		From:      "app.o3c_activity_log al LEFT JOIN app.o3c_users u ON u.id = al.user_id",
		OrderBy:   "al.ts DESC",
		DateCol:   "al.ts::date",
		DateLabel: "Timestamp",
		Cols: []exportCol{
			{Key: "ts", Label: "Timestamp", Type: colDateTime, Expr: "al.ts"},
			{Key: "user_name", Label: "User", Type: colText, Expr: "u.full_name"},
			{Key: "user_role", Label: "Role", Type: colText, Expr: "u.role"},
			{Key: "action", Label: "Action", Type: colText, Expr: "al.action"},
			{Key: "page", Label: "Page", Type: colText, Expr: "al.page"},
			{Key: "resource", Label: "Resource", Type: colText, Expr: "al.resource"},
			{Key: "entity_type", Label: "Entity Type", Type: colText, Expr: "al.entity_type"},
			{Key: "entity_id", Label: "Entity ID", Type: colText, Expr: "al.entity_id"},
			{Key: "method", Label: "Method", Type: colText, Expr: "al.method"},
			{Key: "detail", Label: "Detail", Type: colText, Expr: "al.detail"},
			{Key: "ip_address", Label: "IP Address", Type: colText, Expr: "al.ip_address"},
		},
		Filters: []exportFilter{
			{Key: "action", Label: "Action", Kind: filterText, Expr: "al.action = ?"},
			{Key: "user_role", Label: "Role", Kind: filterText, Expr: "u.role = ?"},
		},
	},
}

// exportDatasetByKey resolves a dataset by its key.
func exportDatasetByKey(key string) (exportDataset, bool) {
	for _, d := range exportDatasets {
		if d.Key == key {
			return d, true
		}
	}
	return exportDataset{}, false
}

// maxRows returns the dataset's row cap, falling back to the global default.
func (d exportDataset) maxRows() int {
	if d.MaxRows > 0 {
		return d.MaxRows
	}
	return exportDefaultMaxRows
}

// colByKey resolves one of the dataset's declared columns.
func (d exportDataset) colByKey(key string) (exportCol, bool) {
	for _, c := range d.Cols {
		if c.Key == key {
			return c, true
		}
	}
	return exportCol{}, false
}

// filterByKey resolves one of the dataset's declared filters.
func (d exportDataset) filterByKey(key string) (exportFilter, bool) {
	for _, f := range d.Filters {
		if f.Key == key {
			return f, true
		}
	}
	return exportFilter{}, false
}
