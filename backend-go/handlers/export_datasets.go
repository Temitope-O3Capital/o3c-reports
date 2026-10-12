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

	// KeyCol is the data source's unique key. It ends every Table sort, so a page break
	// never repeats or skips a record when many records share the same sort value.
	KeyCol string `json:"-"`

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

// maskedWatchID and maskedIssuancePAN extend the same rule to the two tables added in
// the 2026-10-09 coverage pass. Both keep enough of the value to recognise a match and
// not enough to use it: a watch-list hit has to be verifiable by a screener, and a card
// issuance request must never carry a full PAN into a spreadsheet.
//
// These exist as named constants rather than inline CASE expressions because
// TestEveryDatasetMasksWhatItMustMask scans for them by name — a sensitive column is
// only considered masked if it goes through one of these.
const maskedWatchID = `CASE WHEN NULLIF(wl.id_value,'') IS NULL THEN NULL
                            ELSE repeat('*', GREATEST(length(wl.id_value) - 4, 0)) ||
                                 RIGHT(wl.id_value, 4) END`
const maskedIssuancePAN = `CASE WHEN NULLIF(ci.card_pan,'') IS NULL THEN NULL
                                ELSE '****' || RIGHT(ci.card_pan, 4) END`

// cardCurrency renders app.accounts.currency_code as a letter code. The card book
// carries four money columns and the Table view offers column sums over them, so
// without this a total adds 219 USD accounts (-$224,743.97 of balance) to 21,075
// naira ones. 71 rows carry no code at all and must not silently read as naira.
const cardCurrency = `CASE btrim(COALESCE(a.currency_code,''))
                        WHEN '566' THEN 'NGN' WHEN '840' THEN 'USD'
                        WHEN '978' THEN 'EUR' WHEN '826' THEN 'GBP'
                        ELSE 'unknown' END`

// exportDatasets is the registry, ordered for display.
var exportDatasets = []exportDataset{
	// ── Credit ────────────────────────────────────────────────────────────────
	{
		Key:    "loan_book",
		Label:  "Loan Book (Live)",
		Module: "Credit",
		Desc:   "The live Udara/CBS credit book with schedule-derived DPD, arrears and risk band.",
		From:   "app.cbs_loans cl",
		// Closed and Revoked loans are excluded from the default book the same
		// way every other portfolio view in the workspace excludes them, so an
		// export reconciles against the dashboards instead of contradicting them.
		Where:     "cl.status NOT IN ('Closed','Revoked')",
		OrderBy:   "cl.outstanding_principal_kobo DESC",
		KeyCol:    "cl.cbs_id",
		DateCol:   "cl.date_booked::date",
		DateLabel: "Date Booked",
		Cols: []exportCol{
			{Key: "account_number", Label: "Account Number", Type: colText, Expr: "cl.cbs_account_number"},
			{Key: "cif", Label: "Udara ID", Type: colText, Expr: "cl.cbs_customer_id"}, // NOT a cards CIF: cbs_customer_id is Udara's own namespace and collides with CCS CIFs on a different person
			{Key: "customer_name", Label: "Customer Name", Type: colText,
				Expr: `cl.raw->>'name'`}, // Udara's own name (cbs_customer_id != app.customers.cif)
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
			{Key: "tenor_days", Label: "Tenor (Days)", Type: colInt, Expr: "cl.tenor_days"},
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
		KeyCol:    "la.id",
		DateCol:   "la.created_at::date",
		DateLabel: "Created",
		Cols: []exportCol{
			{Key: "reference", Label: "Reference", Type: colText, Expr: "la.reference"},
			{Key: "applicant_name", Label: "Applicant", Type: colText, Expr: "la.applicant_name"},
			{Key: "applicant_cif", Label: "CIF", Type: colText, Expr: "la.applicant_cif"},
			{Key: "product_type", Label: "Product", Type: colText, Expr: "la.product_type"},
			{Key: "amount_requested", Label: "Amount Requested (NGN)", Type: colKobo, Expr: "la.amount_requested_kobo"},
			{Key: "amount_approved", Label: "Amount Approved (NGN)", Type: colKobo, Expr: "la.amount_approved_kobo"},
			{Key: "tenor_months", Label: "Tenor (Months)", Type: colInt, Expr: "la.tenor_months"},
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
		KeyCol:    "a.account_no",
		DateCol:   "a.opened_date",
		DateLabel: "Opened",
		Cols: []exportCol{
			{Key: "account_no", Label: "Account No", Type: colText, Expr: "a.account_no"},
			{Key: "cif", Label: "CIF", Type: colText, Expr: "a.cif"},
			{Key: "name_on_card", Label: "Name on Card", Type: colText, Expr: "a.name_on_card"},
			{Key: "card_pan_masked", Label: "Card (Masked)", Type: colText, Expr: maskedPAN},
			{Key: "product_name", Label: "Product", Type: colText, Expr: "a.product_name"},
			{Key: "card_program", Label: "Programme", Type: colText, Expr: "a.card_program"},
			{Key: "product_line", Label: "Product Line", Type: colText, Expr: "a.product_line"},
			{Key: "status", Label: "Status", Type: colText, Expr: "a.status"},
			{Key: "currency", Label: "Currency", Type: colText, Expr: cardCurrency},
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
			{Key: "currency", Label: "Currency", Kind: filterSelect, Expr: cardCurrency + " = ?",
				Options: []string{"NGN", "USD", "unknown"}},
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
		KeyCol:       "t.txn_id",
		DateCol:      "t.txn_date",
		DateLabel:    "Transaction Date",
		MaxRows:      250000,
		Cols: []exportCol{
			{Key: "txn_id", Label: "Txn ID", Type: colText, Expr: "t.txn_id"},
			{Key: "txn_date", Label: "Txn Date", Type: colDate, Expr: "t.txn_date"},
			{Key: "post_date", Label: "Post Date", Type: colDate, Expr: "t.post_date"},
			// A NAME ON THE LARGEST EXPORT IN THE SYSTEM, which until now showed a bare
			// CIF across 1,037,956 rows while the name was reachable on 99.93% of them.
			//
			// A correlated subquery, NOT a join, and the reason is worth keeping. Adding
			// `LEFT JOIN app.customers` here looked right and I checked it first:
			// app.customers holds 22,232 rows for 21,877 distinct CIFs, so a join can
			// multiply rows on the one export where nobody would notice an inflated
			// count. The 355 extra rows turn out to be blank-CIF rows and there are ZERO
			// duplicate non-empty CIFs (uq_customers_cif is unique over them), so a join
			// would in fact have been safe — but it is safe only by accident of today's
			// data, whereas LIMIT 1 is safe by construction.
			//
			// Cost measured, because this runs over a 250,000-row cap: 300ms per 50,000
			// rows, which is a single index probe each against customer_cif_idx.
			{Key: "customer_name", Label: "Customer", Type: colText,
				Expr: `(SELECT cu.full_name FROM app.customers cu WHERE cu.cif = t.cif LIMIT 1)`},
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
		KeyCol:    "c.cif",
		DateCol:   "c.account_created::date",
		DateLabel: "Account Created",
		Cols: []exportCol{
			{Key: "cif", Label: "CIF", Type: colText, Expr: "c.cif"},
			{Key: "full_name", Label: "Full Name", Type: colText, Expr: "c.full_name"},
			{Key: "phone", Label: "Phone", Type: colText, Expr: "c.phone"},
			{Key: "email", Label: "Email", Type: colText, Expr: "c.email"},
			{Key: "bvn_masked", Label: "BVN (Masked)", Type: colText, Expr: maskedBVN},
			{Key: "gender", Label: "Gender", Type: colText, Expr: "c.gender"},
			{Key: "birthday", Label: "Date of Birth", Type: colDate, Expr: "c.birthday"},
			{Key: "city", Label: "City", Type: colText, Expr: "c.city"},
			{Key: "state", Label: "State", Type: colText, Expr: "c.state"},
			{Key: "country", Label: "Country", Type: colText, Expr: "c.country"},
			{Key: "full_address", Label: "Address", Type: colText, Expr: "c.full_address"},
			{Key: "job_title", Label: "Job Title", Type: colText, Expr: "c.job_title"},
			{Key: "account_status", Label: "Account Status", Type: colText, Expr: "c.account_status"},
			{Key: "account_created", Label: "Account Created", Type: colDate, Expr: "c.account_created"},

			// The audit found this dataset exposing 14 of 57 available columns. These
			// five are the ones the table actually populates. The demographic columns
			// are deliberately NOT added — occupation 74 of 22,227, employer 60, NIN
			// 103, LGA 162, marital status 120, next of kin 95, PEP zero true — because
			// adding them ships blank columns and makes an honestly thin report look
			// neglected instead.
			//
			// NAIRA, NOT KOBO, and measured rather than assumed: getting this wrong is
			// precisely the M1 defect that printed a NGN 5.9bn book as NGN 587.8bn. Both
			// columns were compared against app.accounts.card_limit, which the card book
			// already types colMoney — 10,862 of 17,416 rows identical, ZERO a factor of
			// 100 apart. Same unit, therefore colMoney.
			{Key: "current_dr_limit", Label: "Card Limit (NGN)", Type: colMoney, Expr: "c.current_dr_limit"},
			{Key: "available_balance", Label: "Available Balance (NGN)", Type: colMoney, Expr: "c.available_balance"},
			{Key: "last_seen", Label: "Last Seen", Type: colDateTime, Expr: "c.last_seen"},
			{Key: "phone_2", Label: "Phone 2", Type: colText, Expr: "c.phone_2"},
			// True on 5,041 customers (22.7%) — a contact-quality fact both Campaigns
			// and Collections act on, and which no report could previously show.
			{Key: "phone_was_fake", Label: "Phone Flagged As Fake", Type: colBool, Expr: "c.phone_was_fake"},
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
		KeyCol:    "k.id",
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
			// Two owners, as two columns rather than one ambiguous "Lead Owner". This
			// dataset covers the whole contact store, where one row can be worked by a
			// call-centre agent and a sales officer at the same time: lead_owner_id is the
			// call centre's book, sales_owner_id is Sales's (migration 302). Collapsing
			// them into a single column reports one team's work as the other's.
			{Key: "owner_name", Label: "Call Centre Owner", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = k.lead_owner_id)`},
			{Key: "sales_owner_name", Label: "Sales Owner", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = k.sales_owner_id)`},
			{Key: "sales_source", Label: "Reached Sales Via", Type: colText, Expr: "k.sales_source"},
			{Key: "sales_entered_at", Label: "Reached Sales On", Type: colDateTime, Expr: "k.sales_entered_at"},
			{Key: "created_at", Label: "Created", Type: colDateTime, Expr: "k.created_at"},
			// Stored as qualified_at; shown as Interested, the only way a lead gets there.
			{Key: "qualified_at", Label: "Interested On", Type: colDateTime, Expr: "k.qualified_at"},
			{Key: "converted_at", Label: "Converted", Type: colDateTime, Expr: "k.converted_at"},

			// The campaign a contact came from, by NAME rather than by id — a campaign
			// id in a spreadsheet cell is unreadable to the person running the campaign.
			// 12,286 of 35,814 contacts carry one and the report could not show any of
			// them, so no campaign's contribution to the pipeline was reportable at all.
			{Key: "source_campaign", Label: "Source Campaign", Type: colText,
				Expr: `(SELECT ca.name FROM app.campaigns ca WHERE ca.id = k.source_campaign_id)`},
			// This is the report's own exclusion rule, and until now it could not be
			// reproduced from the export: a reader had no way to tell which rows the
			// pipeline figures had dropped as existing customers.
			{Key: "already_customer", Label: "Already A Customer", Type: colBool, Expr: "k.already_customer"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "k.status = ?"},
			{Key: "lead_stage", Label: "Lead Stage", Kind: filterText, Expr: "k.lead_stage = ?"},
			{Key: "lead_source", Label: "Lead Source", Kind: filterText, Expr: "k.lead_source ILIKE '%' || ? || '%'"},
			// `= (? = 'true')`, not `= ?::boolean`. The cast is what a boolean filter
			// looks like it should be, and it throws 22P02 on any value that is not a
			// boolean — which TestExportDatasetsRunLive proved immediately by probing
			// every filter with "x". Comparing the parameter as TEXT cannot fail: a
			// nonsense value simply matches nothing. This is the pattern every other
			// boolean filter in this registry already uses, including two I added myself
			// earlier in the same session and then failed to follow here.
			{Key: "already_customer", Label: "Already A Customer", Kind: filterSelect,
				Expr: "k.already_customer = (? = 'true')", Options: []string{"true", "false"}},
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
		KeyCol:    "fd.cbs_id",
		DateCol:   "fd.date_booked::date",
		DateLabel: "Date Booked",
		// A "Rollovers" column (fd.rollover_count) was removed from this export
		// rather than carried forward. Udara populates rolloverCount on NONE of the
		// 380 deposits (the key is present in every payload and null in every one),
		// and applyRollover is false on 379 of 380 -- while deposits demonstrably do
		// roll over. So the column was not "empty data", it was a blank cell that
		// read as the assertion "this deposit has never rolled over", on every row.
		// Relabelling it ("Rollovers (Not Reported)") would still spend a column in
		// every spreadsheet to say nothing, so it is gone. Rollover DETECTION is a
		// separate piece of work (deliberately out of scope here); when it exists,
		// re-add the column under the same "rollover_count" key.
		Cols: []exportCol{
			{Key: "account_number", Label: "Account Number", Type: colText, Expr: "fd.cbs_account_number"},
			{Key: "cif", Label: "Udara ID", Type: colText, Expr: "fd.cbs_customer_id"},
			{Key: "customer_name", Label: "Customer Name", Type: colText,
				Expr: `fd.raw->>'name'`}, // Udara's own name (cbs_customer_id != app.customers.cif)
			{Key: "product_name", Label: "Product", Type: colText, Expr: "fd.product_name"},
			{Key: "status", Label: "Status", Type: colText, Expr: "fd.status"},
			{Key: "principal", Label: "Principal (NGN)", Type: colKobo, Expr: "fd.principal_kobo"},
			{Key: "accrued_interest", Label: "Accrued Interest (NGN)", Type: colKobo, Expr: "fd.accrued_interest_kobo"},
			{Key: "ledger_balance", Label: "Ledger Balance (NGN)", Type: colKobo, Expr: "fd.ledger_balance_kobo"},
			{Key: "interest_rate", Label: "Interest Rate (%)", Type: colPct, Expr: "fd.interest_rate"},
			{Key: "tenor_days", Label: "Tenor (Days)", Type: colInt, Expr: "fd.tenor_days"},
			{Key: "branch_name", Label: "Branch", Type: colText, Expr: "fd.branch_name"},
			// Officer. Udara sends accountOfficerName on all 380 deposits; before
			// migration 261 it was dropped by the FD sync, so this export could not
			// answer "whose deposit is this" while the loan export could.
			{Key: "officer_name", Label: "Officer", Type: colText, Expr: "fd.officer_name"},
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
		KeyCol:    "ca.id",
		DateCol:   "ca.created_at::date",
		DateLabel: "Assigned",
		Cols: []exportCol{
			{Key: "cif_number", Label: "Customer ID", Type: colText, Expr: "ca.cif_number"}, // three namespaces share this column: bare 8-digit cards CIFs, UD- Udara ids and W- uploaded-sheet keys, so "CIF" is wrong for 77 of the rows
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
		Key:    "collections_payments",
		Label:  "Collections Payments",
		Module: "Collections",
		Desc: "Payments recorded against collections cases, with approval and reconciliation " +
			"state. APPROVAL IS THE ONE THAT DECIDES WHETHER THE MONEY COUNTED: measured " +
			"2026-10-07, 1,801 rows are approved (NGN 1,094,578,699.07) and 11 are still " +
			"pending_hop (NGN 106,393,555.56). Filter on Status before totalling Amount, " +
			"or the total overstates collections by the unapproved balance.",
		From:      "app.collection_payments cp",
		OrderBy:   "cp.payment_date DESC",
		KeyCol:    "cp.id",
		DateCol:   "cp.payment_date",
		DateLabel: "Payment Date",
		Cols: []exportCol{
			{Key: "customer_name", Label: "Customer", Type: colText,
				Expr: `(SELECT cu.full_name FROM app.customers cu WHERE cu.cif = cp.account_cif LIMIT 1)`},
			{Key: "account_cif", Label: "Customer ID", Type: colText, Expr: "cp.account_cif"},
			{Key: "amount", Label: "Amount (NGN)", Type: colKobo, Expr: "cp.amount_kobo"},
			{Key: "payment_date", Label: "Payment Date", Type: colDate, Expr: "cp.payment_date"},
			{Key: "channel", Label: "Channel", Type: colText, Expr: "cp.channel"},
			{Key: "reference", Label: "Reference", Type: colText, Expr: "cp.reference"},
			{Key: "paystack_reference", Label: "Paystack Reference", Type: colText, Expr: "cp.paystack_reference"},
			{Key: "reconciled", Label: "Reconciled", Type: colBool, Expr: "cp.reconciled"},
			{Key: "reconciled_at", Label: "Reconciled At", Type: colDateTime, Expr: "cp.reconciled_at"},
			{Key: "gl_reference", Label: "GL Reference", Type: colText, Expr: "cp.gl_reference"},
			{Key: "status", Label: "Status", Type: colText, Expr: "cp.status"},
			{Key: "approved_at", Label: "Approved At", Type: colDateTime, Expr: "cp.approved_at"},
			{Key: "approved_by_name", Label: "Approved By", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = cp.approved_by)`},
			{Key: "rejection_reason", Label: "Rejection Reason", Type: colText, Expr: "cp.rejection_reason"},
			{Key: "received_by_name", Label: "Received By", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = cp.received_by)`},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterSelect, Expr: "cp.status = ?",
				Options: []string{"approved", "pending_hop", "rejected"}},
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
		KeyCol:    "pt.id",
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
		KeyCol:    "re.id",
		DateCol:   "re.txn_date",
		DateLabel: "Transaction Date",
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

			// 24,100 exceptions carry a detail string and nothing could show it.
			{Key: "detail", Label: "Detail", Type: colText, Expr: "re.detail"},
			// resolved_by is a user id, so it resolves to the person's name — an id in a
			// report tells the reader nothing. 266 rows are set, which is every
			// exception anyone has actually resolved.
			{Key: "resolved_by_name", Label: "Resolved By", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = re.resolved_by)`},
			// assigned_to IS DELIBERATELY NOT EXPOSED. The audit asked for an owner
			// column on these 12,629 live exceptions, and the column exists — but it is
			// populated on ZERO rows of 24,566. Nothing assigns an exception to anyone
			// today, so the column would be blank on every row and would read as "nobody
			// is responsible" rather than "ownership is not captured". Exposing it is a
			// one-line change the day something starts writing it.
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
		KeyCol:    "ht.id",
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
		Where:     "hc.merged_into_call_id IS NULL AND hc.voided_at IS NULL",
		OrderBy:   "COALESCE(hc.started_at, hc.created_at) DESC",
		KeyCol:    "hc.id",
		DateCol:   "COALESCE(hc.started_at, hc.created_at)::date",
		DateLabel: "Call Date",
		Cols: []exportCol{
			{Key: "started_at", Label: "Started", Type: colDateTime, Expr: "COALESCE(hc.started_at, hc.created_at)"},
			{Key: "direction", Label: "Direction", Type: colText, Expr: "hc.direction"},
			{Key: "purpose", Label: "Purpose", Type: colText, Expr: "hc.purpose"},
			{Key: "agent_name", Label: "Agent", Type: colText,
				Expr: `COALESCE((SELECT u.full_name FROM app.o3c_users u WHERE u.id = hc.agent_id), hc.agent_name)`},
			{Key: "customer_name", Label: "Customer", Type: colText, Expr: "hc.customer_name"},
			{Key: "customer_cif", Label: "CIF", Type: colText, Expr: "hc.customer_cif"},
			{Key: "customer_phone", Label: "Phone", Type: colText,
				Expr: `CASE WHEN NULLIF(hc.customer_phone,'') IS NULL THEN NULL ELSE '******' || RIGHT(hc.customer_phone, 4) END`},
			{Key: "duration_sec", Label: "Duration (sec)", Type: colInt, Expr: "hc.duration_sec"},
			{Key: "outcome", Label: "Outcome", Type: colText, Expr: "hc.outcome"},
			{Key: "disposition", Label: "Disposition", Type: colText, Expr: "hc.disposition"},
			{Key: "resolution", Label: "Resolution", Type: colText, Expr: "hc.resolution"},
			{Key: "ticket_ref", Label: "Linked Ticket", Type: colText, Expr: "hc.ticket_ref"},
			{Key: "source_system", Label: "Source", Type: colText, Expr: "hc.source_system"},

			// This is the most-exported report in the building — 17,431 rows a week —
			// and it was showing 13 of 44 available columns, with no wait time, no
			// abandonment, no recording, no agent notes and no campaign link.
			//
			// THESE ARE SPARSE, AND THAT IS STATED ON PURPOSE. Of 212,063 calls, wait
			// and queue are set on 24,566 (11.6%), a recording filename on 19,299, notes
			// on 9,577. I assumed that was a concept boundary — a queue wait only
			// existing for inbound calls — and MEASURED IT TO BE FALSE: outbound calls
			// carry a wait on 11.4% of rows and inbound on 16.8%. So it is not "NULL
			// where it cannot apply", it is simply what the telephony provider sent.
			// Read a blank as "not captured", never as zero.
			{Key: "wait_sec", Label: "Wait (sec)", Type: colInt, Expr: "hc.wait_sec"},
			{Key: "queue_name", Label: "Queue", Type: colText, Expr: "hc.queue_name"},
			{Key: "hangup_cause", Label: "Hangup Cause", Type: colText, Expr: "hc.hangup_cause"},
			// The filename only; there is no retrievable URL. recording_url and
			// transcript are 0 of 212,063 and are deliberately not exposed — they look
			// like the obvious additions and nothing writes them.
			{Key: "recording_filename", Label: "Recording File", Type: colText, Expr: "hc.recording_filename"},
			{Key: "notes", Label: "Agent Notes", Type: colText, Expr: "hc.notes"},
			// 32 of 212,063 flagged. An abandonment rate of 0.015% is not credible for a
			// call centre, so treat this as barely captured rather than as a measured
			// near-zero — which is why it ships as a flag and not as a rate.
			{Key: "abandoned", Label: "Abandoned", Type: colBool, Expr: "hc.abandoned"},
			// The lead this call belongs to, where one is linked (42,399 rows). Kept as
			// the id because it is a cross-reference the Sales floor acts on, in the
			// same spirit as an account number.
			{Key: "lead_id", Label: "Lead Ref", Type: colInt, Expr: "hc.lead_id"},
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
		KeyCol:    "cd.id",
		DateCol:   "cd.cycle_date",
		DateLabel: "Cycle Date",
		Cols: []exportCol{
			{Key: "cycle_date", Label: "Cycle Date", Type: colDate, Expr: "cd.cycle_date"},
			// Name first, then the account and the CIF. The account number stays because
			// a statement cycle is acted on by account, and you cannot post against a
			// name — but the reader should not have to look a human being up by id.
			// Reachable on 99.7% of these 37,147 rows.
			{Key: "customer_name", Label: "Customer", Type: colText,
				Expr: `(SELECT cu.full_name FROM app.customers cu WHERE cu.cif = cd.cif LIMIT 1)`},
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
		Key:    "customer_lifecycle",
		Label:  "Retention & Win-Back",
		Module: "Customers",
		Desc: "One row per customer: where they sit on the dormancy clock, what they " +
			"were worth in their last active year, and whether they can be worked. " +
			"bucket='unknown' means we hold NO transaction history for that customer " +
			"(the ledger is card-only and covers ~37% of the base) — they are unmeasured, " +
			"not dormant, and should be filtered out of any retention analysis.",
		From: `app.customer_lifecycle cl
		         JOIN app.parties p ON p.party_id = cl.party_id
		         LEFT JOIN LATERAL (SELECT c.cif FROM app.customers c
		                             WHERE c.party_id = cl.party_id
		                             ORDER BY c.cif LIMIT 1) c ON TRUE`,
		OrderBy:   "cl.value_kobo DESC NULLS LAST",
		KeyCol:    "cl.party_id",
		DateCol:   "cl.last_txn_at::date",
		DateLabel: "Last Transaction",
		Cols: []exportCol{
			{Key: "cif", Label: "CIF", Type: colText, Expr: "c.cif"},
			{Key: "full_name", Label: "Customer", Type: colText, Expr: "p.full_name"},
			{Key: "bucket", Label: "Stage", Type: colText, Expr: "cl.bucket"},
			{Key: "value_tier", Label: "Value Tier", Type: colText, Expr: "cl.value_tier"},
			{Key: "value_kobo", Label: "Value, Last Active Year (NGN)", Type: colKobo, Expr: "cl.value_kobo"},
			{Key: "lifetime_value_kobo", Label: "Lifetime Spend (NGN)", Type: colKobo, Expr: "cl.lifetime_value_kobo"},
			{Key: "days_since_txn", Label: "Days Since Last Txn", Type: colInt, Expr: "cl.days_since_txn"},
			{Key: "open_products", Label: "Open Products", Type: colInt, Expr: "cl.open_products"},
			{Key: "measured", Label: "Has History", Type: colBool, Expr: "cl.measured"},
			{Key: "contactable", Label: "Contactable", Type: colBool, Expr: "cl.contactable"},
			{Key: "has_open_recovery", Label: "In Recovery", Type: colBool, Expr: "cl.has_open_recovery"},
			{Key: "primary_phone", Label: "Phone", Type: colText, Expr: "p.primary_phone"},
			{Key: "primary_email", Label: "Email", Type: colText, Expr: "p.primary_email"},
			{Key: "last_txn_at", Label: "Last Transaction", Type: colDateTime, Expr: "cl.last_txn_at"},
			{Key: "computed_at", Label: "Scored At", Type: colDate, Expr: "cl.computed_at"},
		},
		Filters: []exportFilter{
			{Key: "bucket", Label: "Stage", Kind: filterText, Expr: "cl.bucket = ?"},
			{Key: "value_tier", Label: "Value Tier", Kind: filterText, Expr: "cl.value_tier = ?"},
			{Key: "measured", Label: "Has History", Kind: filterSelect, Expr: "cl.measured = (? = 'true')",
				Options: []string{"true", "false"}},
			{Key: "contactable", Label: "Contactable", Kind: filterSelect, Expr: "cl.contactable = (? = 'true')",
				Options: []string{"true", "false"}},
		},
	},
	{
		Key:    "parties",
		Label:  "People (Deduplicated)",
		Module: "Customers",
		Desc: "The person layer: one row per human being, with how many cards they hold. " +
			"A CIF is a card, not a person — this is the honest customer count.",
		From:      "app.parties p",
		OrderBy:   "p.card_count DESC NULLS LAST",
		KeyCol:    "p.party_id",
		DateCol:   "p.created_at::date",
		DateLabel: "First Seen",
		Cols: []exportCol{
			{Key: "party_key", Label: "Party Key", Type: colText, Expr: "p.party_key"},
			{Key: "full_name", Label: "Full Name", Type: colText, Expr: "p.full_name"},
			{Key: "party_type", Label: "Type", Type: colText, Expr: "p.party_type"},
			{Key: "primary_phone", Label: "Phone", Type: colText, Expr: "p.primary_phone"},
			{Key: "primary_email", Label: "Email", Type: colText, Expr: "p.primary_email"},
			// Masked for the same reason as the customer master.
			{Key: "bvn_masked", Label: "BVN (Masked)", Type: colText,
				Expr: `CASE WHEN NULLIF(p.bvn,'') IS NULL THEN NULL
				            ELSE '*******' || RIGHT(p.bvn, 4) END`},
			// "CARDS HELD" WAS NOT A COUNT OF CARDS. app.parties.card_count is set by
			// assign_parties() to the number of app.customers ROWS in the party, so a
			// borrower with one customer record and no card at all read "Cards Held 1".
			// Measured today: 1,585 of 21,744 parties disagree with their real card
			// count, 22,700 stated against 21,315 actual.
			//
			// Counted here from app.accounts, the actual card book, using the SAME
			// expression Customer 360 already uses (cbs_reports.go, which documents this
			// defect) so there is one definition of the fact rather than two that drift.
			// The old number is kept under its honest name, because it is still useful —
			// it is how many customer records were merged into the party.
			{Key: "card_count", Label: "Cards Held", Type: colInt,
				Expr: `(SELECT COUNT(*) FROM app.accounts a
				          JOIN app.customers c ON c.cif = a.cif
				         WHERE c.party_id = p.party_id)`},
			{Key: "customer_records", Label: "Customer Records", Type: colInt, Expr: "COALESCE(p.card_count, 0)"},
			{Key: "created_at", Label: "First Seen", Type: colDateTime, Expr: "p.created_at"},
		},
		Filters: []exportFilter{
			{Key: "party_type", Label: "Type", Kind: filterText, Expr: "p.party_type = ?"},
		},
	},

	// ── Settlements (continued) ───────────────────────────────────────────────
	{
		Key:       "paystack_transfers",
		Label:     "Paystack Transfers (Payouts)",
		Module:    "Settlements",
		Desc:      "Outbound transfers: recipient, bank, status and failure reason.",
		From:      "app.paystack_transfers pt",
		OrderBy:   "COALESCE(pt.transferred_at, pt.created_at_ps) DESC NULLS LAST",
		KeyCol:    "pt.id",
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
		KeyCol:    "rm.id",
		DateCol:   "rm.txn_date",
		DateLabel: "Transaction Date",
		Cols: []exportCol{
			{Key: "txn_date", Label: "Txn Date", Type: colDate, Expr: "rm.txn_date"},
			{Key: "source_key", Label: "Source Key", Type: colText, Expr: "rm.source_key"},
			{Key: "counterparty_key", Label: "Counterparty Key", Type: colText, Expr: "rm.counterparty_key"},
			{Key: "amount", Label: "Amount (NGN)", Type: colKobo, Expr: "rm.amount_kobo"},
			{Key: "tier", Label: "Match Tier", Type: colText, Expr: "rm.tier::text"},
			{Key: "confidence", Label: "Confidence (%)", Type: colPct, Expr: "(rm.confidence * 100)"},
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
		KeyCol:    "rc.id",
		DateCol:   "COALESCE(rc.opened_at, rc.created_at)::date",
		DateLabel: "Opened",
		Cols: []exportCol{
			{Key: "case_ref", Label: "Case Ref", Type: colText, Expr: "rc.case_ref"},
			{Key: "cif_number", Label: "Customer ID", Type: colText, Expr: "COALESCE(rc.cif_number, rc.account_cif)"},
			{Key: "account_number", Label: "Account Number", Type: colText, Expr: "rc.account_number"},
			{Key: "status", Label: "Status", Type: colText, Expr: "rc.status"},
			{Key: "legal_stage", Label: "Legal Stage", Type: colText, Expr: "rc.legal_stage"},
			{Key: "outstanding", Label: "Outstanding (NGN)", Type: colKobo, Expr: "COALESCE(rc.outstanding_kobo, rc.total_outstanding_kobo)"},
			{Key: "recovered", Label: "Recovered (NGN)", Type: colKobo, Expr: "COALESCE(rc.recovered_kobo, rc.total_recovered_kobo)"},
			{Key: "write_off_status", Label: "Write-Off Status", Type: colText, Expr: "rc.write_off_status"},
			{Key: "write_off_amount", Label: "Write-Off Amount (NGN)", Type: colKobo, Expr: "rc.write_off_amount_kobo"},
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
			{Key: "write_off_status", Label: "Write-Off Status", Kind: filterText, Expr: "rc.write_off_status = ?"},
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
		KeyCol:    "se.id",
		DateCol:   "se.txn_date",
		DateLabel: "Transaction Date",
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
		KeyCol:    "cc.id",
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

			// ref is the contact's own reference, set on 10,115 of 15,213 rows, and was
			// the one column a reader could use to tie a queue row back to the list it
			// was loaded from. source says where the contact came from (1,645 rows).
			{Key: "ref", Label: "Reference", Type: colText, Expr: "cc.ref"},
			{Key: "source", Label: "Source", Type: colText, Expr: "cc.source"},
			{Key: "next_payment_date", Label: "Next Payment Due", Type: colDate, Expr: "cc.next_payment_date"},
			// disposition_code AND lead_id ARE DELIBERATELY LEFT OUT. The audit named
			// both; measuring them is what settled it. disposition_code is set on 10
			// rows of 15,213 (0.07%) and the dataset already carries last_disposition,
			// which is populated and says the same thing in words. lead_id is set on 244
			// rows (1.6%) and is an id, so it would add a mostly-blank column of numbers
			// to a report that already names the customer. Both are one line each if
			// something starts writing them.
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "cc.status = ?"},
			{Key: "purpose", Label: "Purpose", Kind: filterText, Expr: "cc.purpose = ?"},
			{Key: "priority", Label: "Priority", Kind: filterText, Expr: "cc.priority = ?"},
			{Key: "source", Label: "Source", Kind: filterText, Expr: "cc.source = ?"},
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
		KeyCol:    "fi.id",
		DateCol:   "fi.fee_date",
		DateLabel: "Fee Date",
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
	{
		// The real income book (app.fee_income above has never held a row). amount_ngn is
		// NAIRA, so ×100 → kobo for the colKobo formatter to render it as naira correctly.
		Key:       "income_daily",
		Label:     "Income & Revenue",
		Module:    "Finance",
		Desc:      "Card fee, interest and penalty income by day, product and category — the live income book.",
		From:      "app.income_daily id",
		OrderBy:   "id.income_date DESC",
		KeyCol:    "id.income_date, id.category, id.product_name",
		DateCol:   "id.income_date",
		DateLabel: "Income Date",
		Cols: []exportCol{
			{Key: "income_date", Label: "Date", Type: colDate, Expr: "id.income_date"},
			{Key: "category", Label: "Category", Type: colText, Expr: "id.category"},
			{Key: "product_name", Label: "Product", Type: colText, Expr: "COALESCE(NULLIF(id.product_name,''),'Unclassified')"},
			{Key: "txn_count", Label: "Transactions", Type: colInt, Expr: "id.txn_count"},
			{Key: "amount", Label: "Amount (NGN)", Type: colKobo, Expr: "ROUND(id.amount_ngn * 100)::bigint"},
		},
		Filters: []exportFilter{
			{Key: "category", Label: "Category", Kind: filterText, Expr: "id.category = ?"},
		},
	},
	{
		// Loan interest income and the collection pipeline at installment level, from the
		// Udara repayment schedule. payment_status is the reliable state (DueAndUnpaid /
		// FullyPaid / PartiallyPaid / NotYetDue).
		Key:       "loan_schedule",
		Label:     "Loan Repayment Schedule",
		Module:    "Finance",
		Desc:      "Per-installment principal, interest, fee and status from the Udara loan repayment schedule.",
		From:      "app.cbs_loan_schedules s",
		OrderBy:   "s.payment_date",
		KeyCol:    "s.loan_account_number, s.payment_date",
		DateCol:   "s.payment_date",
		DateLabel: "Due Date",
		Cols: []exportCol{
			{Key: "loan_account", Label: "Loan Account", Type: colText, Expr: "s.loan_account_number"},
			// THE BORROWER'S NAME, FROM THE ONLY PLACE IT CAN SAFELY COME FROM.
			//
			// This dataset is exactly where someone would reach for
			// `JOIN app.customers ON customers.cif = s.cbs_customer_id`, and that join
			// must never be written: of 300 Udara customer ids, 275 also exist as a card
			// CIF and all 275 of 275 belong to a DIFFERENT PERSON. It would silently
			// relabel 275 borrowers as strangers on a report about their own debt.
			//
			// app.cbs_customers is keyed on the same Udara id and resolves 212 of 212
			// scheduled installments. The id stays, because a loan account is the thing
			// Finance acts on and Udara ids appear on Udara's own screens.
			{Key: "borrower_name", Label: "Borrower", Type: colText,
				Expr: `(SELECT cu.name FROM app.cbs_customers cu WHERE cu.cbs_customer_id = s.cbs_customer_id)`},
			{Key: "cif", Label: "Udara ID", Type: colText, Expr: "s.cbs_customer_id"},
			// Product and officer come off the loan book, joined on the account number —
			// loan_repayments keys on cbs_loan_account only, never application_id, which
			// is the M6 defect. Both resolve 212 of 212.
			//
			// officer_name is NOT btrim-ed. app.cbs_officer_map was seeded with Udara's
			// trailing spaces, and trimming one side of that comparison makes NGN 11bn
			// of officer attribution vanish; this is a display column, so it is left
			// exactly as the book holds it.
			{Key: "product_name", Label: "Product", Type: colText,
				Expr: `(SELECT l.product_name FROM app.cbs_loans l WHERE l.cbs_account_number = s.loan_account_number)`},
			{Key: "officer_name", Label: "Account Officer", Type: colText,
				Expr: `(SELECT l.officer_name FROM app.cbs_loans l WHERE l.cbs_account_number = s.loan_account_number)`},
			{Key: "payment_date", Label: "Due Date", Type: colDate, Expr: "s.payment_date"},
			{Key: "principal", Label: "Principal (NGN)", Type: colKobo, Expr: "s.principal_kobo"},
			{Key: "interest", Label: "Interest (NGN)", Type: colKobo, Expr: "s.interest_kobo"},
			{Key: "fee", Label: "Fee (NGN)", Type: colKobo, Expr: "s.fee_kobo"},
			{Key: "status", Label: "Status", Type: colText, Expr: "s.payment_status"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "s.payment_status = ?"},
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
		KeyCol:  "sc.id",
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
		KeyCol:    "af.id",
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
		KeyCol:    "ms.email",
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
		KeyCol:    "al.id",
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

	// ── Marketing / Acquisition (AppsFlyer) ───────────────────────────────────
	// The "Blink by O3" mobile acquisition feed, mirrored from AppsFlyer. Money
	// columns are USD (as AppsFlyer reports Blink) — labelled explicitly, no FX.
	{
		Key:       "appsflyer_daily",
		Label:     "App Acquisition (Daily)",
		Module:    "Mobile",
		Desc:      "Blink installs, sessions, loyal users and ad spend by day, platform, media source and campaign — from AppsFlyer.",
		From:      "app.appsflyer_daily af",
		OrderBy:   "af.activity_date DESC, af.installs DESC",
		KeyCol:    "af.id",
		DateCol:   "af.activity_date",
		DateLabel: "Activity Date",
		Cols: []exportCol{
			{Key: "activity_date", Label: "Date", Type: colDate, Expr: "af.activity_date"},
			{Key: "platform", Label: "Platform", Type: colText, Expr: "af.platform"},
			{Key: "media_source", Label: "Media Source", Type: colText, Expr: "af.media_source"},
			{Key: "campaign", Label: "Campaign", Type: colText, Expr: "af.campaign"},
			{Key: "agency", Label: "Agency/PMD", Type: colText, Expr: "af.agency"},
			{Key: "installs", Label: "Installs", Type: colInt, Expr: "af.installs"},
			{Key: "sessions", Label: "Sessions", Type: colInt, Expr: "af.sessions"},
			{Key: "loyal_users", Label: "Loyal Users", Type: colInt, Expr: "af.loyal_users"},
			{Key: "impressions", Label: "Impressions", Type: colInt, Expr: "af.impressions"},
			{Key: "clicks", Label: "Clicks", Type: colInt, Expr: "af.clicks"},
			{Key: "cost_usd", Label: "Ad Spend (USD)", Type: colMoney, Expr: "af.total_cost_usd"},
			{Key: "revenue_usd", Label: "Revenue (USD)", Type: colMoney, Expr: "af.total_revenue_usd"},
		},
		Filters: []exportFilter{
			{Key: "platform", Label: "Platform", Kind: filterSelect, Options: []string{"ios", "android"}, Expr: "af.platform = ?"},
			{Key: "media_source", Label: "Media Source", Kind: filterText, Expr: "af.media_source = ?"},
		},
	},
	{
		Key:       "appsflyer_events",
		Label:     "App Funnel Events",
		Module:    "Mobile",
		Desc:      "Blink in-app funnel events (first_open → registration → KYC → onboarding) by day, platform and media source — from AppsFlyer.",
		From:      "app.appsflyer_events ae",
		OrderBy:   "ae.activity_date DESC, ae.unique_users DESC",
		KeyCol:    "ae.id",
		DateCol:   "ae.activity_date",
		DateLabel: "Activity Date",
		Cols: []exportCol{
			{Key: "activity_date", Label: "Date", Type: colDate, Expr: "ae.activity_date"},
			{Key: "platform", Label: "Platform", Type: colText, Expr: "ae.platform"},
			{Key: "media_source", Label: "Media Source", Type: colText, Expr: "ae.media_source"},
			{Key: "campaign", Label: "Campaign", Type: colText, Expr: "ae.campaign"},
			{Key: "event_name", Label: "Event", Type: colText, Expr: "ae.event_name"},
			{Key: "unique_users", Label: "Unique Users", Type: colInt, Expr: "ae.unique_users"},
			{Key: "event_count", Label: "Event Count", Type: colInt, Expr: "ae.event_count"},
		},
		Filters: []exportFilter{
			{Key: "platform", Label: "Platform", Kind: filterSelect, Options: []string{"ios", "android"}, Expr: "ae.platform = ?"},
			{Key: "event_name", Label: "Event", Kind: filterText, Expr: "ae.event_name = ?"},
		},
	},

	// ── Campaigns ─────────────────────────────────────────────────────────────
	//
	// The campaigns module had exactly one data source — mail_suppressions, 1 row —
	// so nothing could report what a campaign sent, who it reached, or which lead
	// came out of it, despite 11,599 contacts carrying a source_campaign_id.
	{
		Key:    "campaign_performance",
		Label:  "Campaign Performance",
		Module: "Campaigns",
		Desc: "One row per campaign: what went out on each channel and what came back. " +
			"READ THE OPEN AND CLICK COLUMNS WITH CARE — measured 2026-10-09, 9,124 sends " +
			"are recorded and NOT ONE open or click is, on any campaign. Open tracking is " +
			"wired (the /t/o pixel writes campaign_events) but has never fired, so a 0% " +
			"open rate here means 'not captured', not 'nobody opened'. The legacy " +
			"sent_count/open_count family is deliberately excluded: no writer has ever " +
			"incremented it, and it would read 0 beside a real figure.",
		From:      "app.campaigns cm",
		OrderBy:   "cm.created_at DESC",
		KeyCol:    "cm.id",
		DateCol:   "cm.created_at",
		DateLabel: "Created",
		Cols: []exportCol{
			{Key: "name", Label: "Campaign", Type: colText, Expr: "cm.name"},
			{Key: "purpose", Label: "Purpose", Type: colText, Expr: "cm.purpose"},
			{Key: "type", Label: "Type", Type: colText, Expr: "cm.type"},
			{Key: "status", Label: "Status", Type: colText, Expr: "cm.status"},
			{Key: "total_contacts", Label: "Contacts", Type: colInt, Expr: "cm.total_contacts"},
			{Key: "emails_sent", Label: "Emails Sent", Type: colInt, Expr: "cm.emails_sent"},
			{Key: "emails_delivered", Label: "Emails Delivered", Type: colInt, Expr: "cm.emails_delivered"},
			{Key: "emails_bounced", Label: "Emails Bounced", Type: colInt, Expr: "cm.emails_bounced"},
			{Key: "emails_opened", Label: "Emails Opened", Type: colInt, Expr: "cm.emails_opened"},
			{Key: "emails_clicked", Label: "Emails Clicked", Type: colInt, Expr: "cm.emails_clicked"},
			{Key: "sms_sent", Label: "SMS Sent", Type: colInt, Expr: "cm.sms_sent"},
			{Key: "sms_delivered", Label: "SMS Delivered", Type: colInt, Expr: "cm.sms_delivered"},
			{Key: "sms_failed", Label: "SMS Failed", Type: colInt, Expr: "cm.sms_failed"},
			{Key: "whatsapp_sent", Label: "WhatsApp Sent", Type: colInt, Expr: "cm.whatsapp_sent"},
			{Key: "whatsapp_delivered", Label: "WhatsApp Delivered", Type: colInt, Expr: "cm.whatsapp_delivered"},
			{Key: "scheduled_at", Label: "Scheduled", Type: colDateTime, Expr: "cm.scheduled_at"},
			{Key: "started_at", Label: "Started", Type: colDateTime, Expr: "cm.started_at"},
			{Key: "completed_at", Label: "Completed", Type: colDateTime, Expr: "cm.completed_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "cm.status = ?"},
			{Key: "type", Label: "Type", Kind: filterText, Expr: "cm.type = ?"},
			{Key: "purpose", Label: "Purpose", Kind: filterText, Expr: "cm.purpose = ?"},
		},
	},
	{
		Key:    "campaign_contacts",
		Label:  "Campaign Recipients",
		Module: "Campaigns",
		Desc: "Who each campaign was sent to, and what happened to their copy. The " +
			"campaign is named rather than numbered. Soft-deleted recipients are excluded.",
		From: `app.campaign_contacts cc
		         LEFT JOIN app.campaigns cm ON cm.id = cc.campaign_id`,
		Where:     "cc.deleted_at IS NULL",
		OrderBy:   "cc.created_at DESC",
		KeyCol:    "cc.id",
		DateCol:   "cc.created_at",
		DateLabel: "Added",
		Cols: []exportCol{
			{Key: "campaign_name", Label: "Campaign", Type: colText, Expr: "cm.name"},
			{Key: "customer_name", Label: "Recipient", Type: colText,
				Expr: `NULLIF(btrim(COALESCE(cc.first_name,'') || ' ' || COALESCE(cc.last_name,'')), '')`},
			{Key: "phone", Label: "Phone", Type: colText, Expr: "cc.phone"},
			{Key: "email", Label: "Email", Type: colText, Expr: "cc.email"},
			{Key: "cif_number", Label: "CIF", Type: colText, Expr: "cc.cif_number"},
			{Key: "email_status", Label: "Email Status", Type: colText, Expr: "cc.email_status"},
			{Key: "email_sent_at", Label: "Email Sent", Type: colDateTime, Expr: "cc.email_sent_at"},
			{Key: "email_opened_at", Label: "Email Opened", Type: colDateTime, Expr: "cc.email_opened_at"},
			{Key: "sms_status", Label: "SMS Status", Type: colText, Expr: "cc.sms_status"},
			{Key: "sms_sent_at", Label: "SMS Sent", Type: colDateTime, Expr: "cc.sms_sent_at"},
			{Key: "whatsapp_status", Label: "WhatsApp Status", Type: colText, Expr: "cc.whatsapp_status"},
			{Key: "whatsapp_sent_at", Label: "WhatsApp Sent", Type: colDateTime, Expr: "cc.whatsapp_sent_at"},
		},
		Filters: []exportFilter{
			{Key: "campaign_name", Label: "Campaign", Kind: filterText, Expr: "cm.name ILIKE '%' || ? || '%'"},
			{Key: "email_status", Label: "Email Status", Kind: filterText, Expr: "cc.email_status = ?"},
			{Key: "sms_status", Label: "SMS Status", Kind: filterText, Expr: "cc.sms_status = ?"},
		},
	},
	{
		Key:    "campaign_events",
		Label:  "Campaign Engagement Events",
		Module: "Campaigns",
		Desc: "The per-event ledger behind the campaign counters: one row each time a " +
			"message was sent, opened or clicked. This is the evidence trail — if a " +
			"counter and this dataset disagree, believe this one.",
		From: `app.campaign_events ce
		         LEFT JOIN app.campaigns cm ON cm.id = ce.campaign_id`,
		OrderBy:   "ce.occurred_at DESC",
		KeyCol:    "ce.id",
		DateCol:   "ce.occurred_at",
		DateLabel: "Occurred",
		Cols: []exportCol{
			{Key: "occurred_at", Label: "Occurred", Type: colDateTime, Expr: "ce.occurred_at"},
			{Key: "campaign_name", Label: "Campaign", Type: colText, Expr: "cm.name"},
			{Key: "event_type", Label: "Event", Type: colText, Expr: "ce.event_type"},
			{Key: "channel", Label: "Channel", Type: colText, Expr: "ce.channel"},
			{Key: "url", Label: "Link Clicked", Type: colText, Expr: "ce.url"},
			{Key: "provider_msg_id", Label: "Provider Message ID", Type: colText, Expr: "ce.provider_msg_id"},
		},
		Filters: []exportFilter{
			{Key: "event_type", Label: "Event", Kind: filterText, Expr: "ce.event_type = ?"},
			{Key: "channel", Label: "Channel", Kind: filterText, Expr: "ce.channel = ?"},
			{Key: "campaign_name", Label: "Campaign", Kind: filterText, Expr: "cm.name ILIKE '%' || ? || '%'"},
		},
	},
	{
		Key:    "whatsapp_messages",
		Label:  "WhatsApp Messages",
		Module: "Campaigns",
		Desc: "Every WhatsApp message in both directions, with its delivery state and what " +
			"sent it. This is the per-message cost and reach record: Meta bills per message " +
			"delivered by category, so 'how many did we send, to whom, and did they arrive' " +
			"is answered here and nowhere else.",
		From: `app.whatsapp_messages wm
		         LEFT JOIN app.parties pty ON pty.party_id = wm.party_id
		         LEFT JOIN app.campaigns cmp ON cmp.id = wm.campaign_id
		         LEFT JOIN app.helpdesk_tickets tkt ON tkt.id = wm.ticket_id`,
		OrderBy:   "wm.created_at DESC",
		KeyCol:    "wm.id",
		DateCol:   "wm.created_at",
		DateLabel: "Sent / Received",
		Cols: []exportCol{
			{Key: "created_at", Label: "Sent / Received", Type: colDateTime, Expr: "wm.created_at"},
			{Key: "direction", Label: "Direction", Type: colText, Expr: "wm.direction"},
			// The person first, the number second, and the number masked — the same rule
			// the call log follows. A report about messaging is read by people who need to
			// know WHO was contacted, and a full phone number in a spreadsheet is a
			// liability the reader did not ask for.
			{Key: "customer_name", Label: "Customer", Type: colText, Expr: "pty.full_name"},
			{Key: "phone_masked", Label: "Phone", Type: colText,
				Expr: `CASE WHEN NULLIF(wm.phone,'') IS NULL THEN NULL
				            ELSE '******' || RIGHT(wm.phone, 4) END`},
			{Key: "kind", Label: "Sent By", Type: colText, Expr: "wm.kind"},
			{Key: "purpose", Label: "Lawful Basis", Type: colText, Expr: "wm.purpose"},
			{Key: "msg_type", Label: "Type", Type: colText, Expr: "wm.msg_type"},
			{Key: "template_name", Label: "Template", Type: colText, Expr: "wm.template_name"},
			{Key: "status", Label: "Status", Type: colText, Expr: "wm.status"},
			{Key: "status_at", Label: "Status At", Type: colDateTime, Expr: "wm.status_at"},
			{Key: "error_code", Label: "Error Code", Type: colText, Expr: "wm.error_code"},
			{Key: "error_text", Label: "Error", Type: colText, Expr: "wm.error_text"},
			{Key: "campaign_name", Label: "Campaign", Type: colText, Expr: "cmp.name"},
			{Key: "ticket_ref", Label: "Ticket", Type: colText, Expr: "tkt.ticket_ref"},
			// AD ATTRIBUTION. ctwa_clid is how a Status or Feed ad is tied to the
			// conversation it produced; Meta sends it once, on the first inbound message
			// after the click. Exposed as a column because "which ads actually started
			// conversations" is otherwise unanswerable.
			{Key: "ctwa_clid", Label: "Ad Click ID", Type: colText, Expr: "wm.ctwa_clid"},
			{Key: "referral_headline", Label: "Ad Headline", Type: colText, Expr: "wm.referral_headline"},
			// The message body is NOT exposed. It is a customer conversation, the Care
			// screens are where it belongs, and a dataset that ships it would put private
			// support threads into every spreadsheet built on this.
		},
		Filters: []exportFilter{
			{Key: "direction", Label: "Direction", Kind: filterSelect, Expr: "wm.direction = ?",
				Options: []string{"in", "out"}},
			{Key: "kind", Label: "Sent By", Kind: filterSelect, Expr: "wm.kind = ?",
				Options: []string{"care", "campaign", "notification", "ad_reply", "other"}},
			{Key: "purpose", Label: "Lawful Basis", Kind: filterSelect, Expr: "wm.purpose = ?",
				Options: []string{"servicing", "marketing"}},
			{Key: "status", Label: "Status", Kind: filterSelect, Expr: "wm.status = ?",
				Options: []string{"accepted", "sent", "delivered", "read", "failed", "received"}},
			{Key: "from_ads", Label: "From An Ad", Kind: filterSelect,
				Expr: "(wm.ctwa_clid IS NOT NULL) = (? = 'true')",
				Options: []string{"true", "false"}},
			{Key: "campaign_name", Label: "Campaign", Kind: filterText,
				Expr: "cmp.name ILIKE '%' || ? || '%'"},
		},
	},
	{
		Key:    "contact_list_members",
		Label:  "Contact List Members",
		Module: "Campaigns",
		Desc: "The marketing lists and who is on them, with the list named rather than " +
			"numbered. The consent basis recorded against each list is on the list, not " +
			"the member — see the Consent Register for per-person consent.",
		From: `app.contact_list_members lm
		         LEFT JOIN app.contact_lists cl ON cl.id = lm.list_id`,
		OrderBy:   "lm.created_at DESC",
		KeyCol:    "lm.id",
		DateCol:   "lm.created_at",
		DateLabel: "Added",
		Cols: []exportCol{
			{Key: "list_name", Label: "List", Type: colText, Expr: "cl.name"},
			{Key: "list_source", Label: "List Source", Type: colText, Expr: "cl.source"},
			{Key: "consent_basis", Label: "List Consent Basis", Type: colText, Expr: "cl.consent_basis"},
			{Key: "customer_name", Label: "Member", Type: colText,
				Expr: `NULLIF(btrim(COALESCE(lm.first_name,'') || ' ' || COALESCE(lm.last_name,'')), '')`},
			{Key: "phone", Label: "Phone", Type: colText, Expr: "lm.phone"},
			{Key: "email", Label: "Email", Type: colText, Expr: "lm.email"},
			{Key: "cif_number", Label: "CIF", Type: colText, Expr: "lm.cif_number"},
			{Key: "state", Label: "State", Type: colText, Expr: "lm.state"},
			{Key: "status", Label: "Status", Type: colText, Expr: "lm.status"},
		},
		Filters: []exportFilter{
			{Key: "list_name", Label: "List", Kind: filterText, Expr: "cl.name ILIKE '%' || ? || '%'"},
			{Key: "status", Label: "Status", Kind: filterText, Expr: "lm.status = ?"},
			{Key: "state", Label: "State", Kind: filterText, Expr: "lm.state ILIKE ?"},
		},
	},

	// ── Compliance ────────────────────────────────────────────────────────────
	{
		Key:    "consent_register",
		Label:  "Consent Register",
		Module: "Compliance",
		Desc: "Per-person marketing and contact consent by channel: who may be contacted, " +
			"on what basis, and when it expires. This is the record the retention and " +
			"campaign audiences are built from, so it is the one to produce when someone " +
			"asks why a customer was contacted.",
		From: `app.party_contact_consent pc
		         LEFT JOIN app.parties pt ON pt.party_id = pc.party_id`,
		OrderBy:   "pc.recorded_at DESC",
		KeyCol:    "pc.id",
		DateCol:   "pc.recorded_at",
		DateLabel: "Recorded",
		Cols: []exportCol{
			{Key: "customer_name", Label: "Customer", Type: colText, Expr: "pt.full_name"},
			{Key: "channel", Label: "Channel", Type: colText, Expr: "pc.channel"},
			{Key: "purpose", Label: "Purpose", Type: colText, Expr: "pc.purpose"},
			{Key: "state", Label: "Consent", Type: colText, Expr: "pc.state"},
			{Key: "basis", Label: "Legal Basis", Type: colText, Expr: "pc.basis"},
			{Key: "evidence", Label: "Evidence", Type: colText, Expr: "pc.evidence"},
			{Key: "recorded_by_name", Label: "Recorded By", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = pc.recorded_by)`},
			{Key: "recorded_at", Label: "Recorded", Type: colDateTime, Expr: "pc.recorded_at"},
			{Key: "expires_at", Label: "Expires", Type: colDateTime, Expr: "pc.expires_at"},
		},
		Filters: []exportFilter{
			{Key: "channel", Label: "Channel", Kind: filterText, Expr: "pc.channel = ?"},
			{Key: "state", Label: "Consent", Kind: filterText, Expr: "pc.state = ?"},
			{Key: "purpose", Label: "Purpose", Kind: filterText, Expr: "pc.purpose = ?"},
		},
	},
	{
		Key:    "aml_flags",
		Label:  "AML Flags",
		Module: "Compliance",
		Desc: "Transactions an AML rule flagged, with the rule that caught them and the " +
			"review outcome. The rule is named rather than numbered.",
		From: `app.aml_flags af
		         LEFT JOIN app.aml_rules ar ON ar.id = af.rule_id`,
		OrderBy:   "af.triggered_at DESC",
		KeyCol:    "af.id",
		DateCol:   "af.triggered_at",
		DateLabel: "Triggered",
		Cols: []exportCol{
			{Key: "triggered_at", Label: "Triggered", Type: colDateTime, Expr: "af.triggered_at"},
			{Key: "customer_name", Label: "Customer", Type: colText, Expr: "af.customer_name"},
			{Key: "cif", Label: "CIF", Type: colText, Expr: "af.cif"},
			{Key: "rule_name", Label: "Rule", Type: colText, Expr: "ar.name"},
			{Key: "severity", Label: "Severity", Type: colText, Expr: "ar.severity"},
			{Key: "amount_kobo", Label: "Amount (NGN)", Type: colKobo, Expr: "af.amount_kobo"},
			{Key: "transaction_ref", Label: "Transaction Ref", Type: colText, Expr: "af.transaction_ref"},
			{Key: "status", Label: "Status", Type: colText, Expr: "af.status"},
			{Key: "reviewed_by_name", Label: "Reviewed By", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = af.reviewed_by)`},
			{Key: "reviewed_at", Label: "Reviewed", Type: colDateTime, Expr: "af.reviewed_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "af.status = ?"},
			{Key: "severity", Label: "Severity", Kind: filterText, Expr: "ar.severity = ?"},
		},
	},
	{
		Key:       "aml_rules",
		Label:     "AML Rules",
		Module:    "Compliance",
		Desc:      "The AML rule set in force: thresholds, windows and severity, and which rules are switched on.",
		From:      "app.aml_rules ar",
		OrderBy:   "ar.enabled DESC, ar.name",
		KeyCol:    "ar.id",
		DateCol:   "ar.created_at",
		DateLabel: "Created",
		Cols: []exportCol{
			{Key: "name", Label: "Rule", Type: colText, Expr: "ar.name"},
			{Key: "rule_type", Label: "Type", Type: colText, Expr: "ar.rule_type"},
			// app.aml_rules.threshold CARRIES TWO DIFFERENT UNITS, decided by rule_type.
			// Measured 2026-10-09: the velocity_daily rule holds 5, meaning five
			// transactions, while the two amount_threshold rules hold 500000000 and
			// 5000000000, meaning NGN 5m and NGN 50m in kobo. A single kobo-typed column
			// would therefore have printed the velocity rule as NGN 0.05 — the same
			// kobo-as-naira class of error this registry carried for months on the
			// retention export. Split, so each column means one thing and is empty where
			// it does not apply.
			{Key: "threshold_kobo", Label: "Amount Threshold (NGN)", Type: colKobo,
				Expr: `CASE WHEN ar.rule_type = 'amount_threshold' THEN ar.threshold END`},
			{Key: "threshold_count", Label: "Count Threshold", Type: colInt,
				Expr: `CASE WHEN ar.rule_type <> 'amount_threshold' THEN ar.threshold END`},
			{Key: "period_days", Label: "Window (Days)", Type: colInt, Expr: "ar.period_days"},
			{Key: "severity", Label: "Severity", Type: colText, Expr: "ar.severity"},
			{Key: "enabled", Label: "Enabled", Type: colBool, Expr: "ar.enabled"},
		},
		Filters: []exportFilter{
			{Key: "severity", Label: "Severity", Kind: filterText, Expr: "ar.severity = ?"},
			{Key: "rule_type", Label: "Type", Kind: filterText, Expr: "ar.rule_type = ?"},
		},
	},
	{
		Key:    "sars",
		Label:  "Suspicious Activity Reports",
		Module: "Compliance",
		Desc: "The SAR register: references, amounts, status and the NFIU filing trail. " +
			"THE SUBJECT IS DELIBERATELY NOT HERE. app.sars stores subject_name_encrypted, " +
			"subject_id_encrypted and summary_encrypted, and this dataset exposes none of " +
			"the three — a SAR subject must not leave the building in a spreadsheet, and a " +
			"tipping-off risk is not worth a convenience column. Use the Compliance module " +
			"itself, which decrypts per record against a named reader.",
		From:      "app.sars sr",
		OrderBy:   "sr.created_at DESC",
		KeyCol:    "sr.id",
		DateCol:   "sr.transaction_date",
		DateLabel: "Transaction Date",
		Cols: []exportCol{
			{Key: "sar_ref", Label: "SAR Ref", Type: colText, Expr: "sr.sar_ref"},
			{Key: "status", Label: "Status", Type: colText, Expr: "sr.status"},
			{Key: "subject_id_type", Label: "Subject ID Type", Type: colText, Expr: "sr.subject_id_type"},
			{Key: "amount_kobo", Label: "Amount (NGN)", Type: colKobo, Expr: "sr.amount_kobo"},
			{Key: "transaction_date", Label: "Transaction Date", Type: colDate, Expr: "sr.transaction_date"},
			{Key: "reporter_name", Label: "Raised By", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = sr.reporter_id)`},
			{Key: "nfiu_ref", Label: "NFIU Ref", Type: colText, Expr: "sr.nfiu_ref"},
			{Key: "nfiu_submitted_at", Label: "NFIU Submitted", Type: colDateTime, Expr: "sr.nfiu_submitted_at"},
			{Key: "created_at", Label: "Raised", Type: colDateTime, Expr: "sr.created_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "sr.status = ?"},
		},
	},
	{
		Key:    "watch_list",
		Label:  "Watch List",
		Module: "Compliance",
		Desc: "Names and entities on the internal watch list, with why and from where. " +
			"The identifier is masked to its last 4 characters: screening needs to " +
			"recognise a match, not to carry everyone's ID number around in a file.",
		From:      "app.watch_list_entries wl",
		OrderBy:   "wl.created_at DESC",
		KeyCol:    "wl.id",
		DateCol:   "wl.created_at",
		DateLabel: "Added",
		Cols: []exportCol{
			{Key: "entity_name", Label: "Name", Type: colText, Expr: "wl.entity_name"},
			{Key: "entity_type", Label: "Type", Type: colText, Expr: "wl.entity_type"},
			{Key: "id_type", Label: "ID Type", Type: colText, Expr: "wl.id_type"},
			{Key: "id_value_masked", Label: "ID (Masked)", Type: colText, Expr: maskedWatchID},
			{Key: "reason", Label: "Reason", Type: colText, Expr: "wl.reason"},
			{Key: "source", Label: "Source", Type: colText, Expr: "wl.source"},
			{Key: "is_active", Label: "Active", Type: colBool, Expr: "wl.is_active"},
			{Key: "added_by_name", Label: "Added By", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = wl.added_by)`},
		},
		Filters: []exportFilter{
			{Key: "entity_type", Label: "Type", Kind: filterText, Expr: "wl.entity_type = ?"},
			{Key: "is_active", Label: "Active", Kind: filterSelect, Expr: "wl.is_active = (? = 'true')",
				Options: []string{"true", "false"}},
		},
	},
	{
		Key:    "data_breach_incidents",
		Label:  "Data Breach Incidents",
		Module: "Compliance",
		Desc: "The NDPR breach register: what happened, how many records, and whether the " +
			"NDPC was notified inside the deadline. notify_deadline_at against " +
			"ndpc_notified_at is the column pair an audit will ask about.",
		From:      "app.data_breach_incidents db",
		OrderBy:   "db.discovered_at DESC",
		KeyCol:    "db.id",
		DateCol:   "db.discovered_at",
		DateLabel: "Discovered",
		Cols: []exportCol{
			{Key: "ref_no", Label: "Ref", Type: colText, Expr: "db.ref_no"},
			{Key: "title", Label: "Incident", Type: colText, Expr: "db.title"},
			{Key: "breach_type", Label: "Type", Type: colText, Expr: "db.breach_type"},
			{Key: "severity", Label: "Severity", Type: colText, Expr: "db.severity"},
			{Key: "status", Label: "Status", Type: colText, Expr: "db.status"},
			{Key: "affected_records", Label: "Records Affected", Type: colInt, Expr: "db.affected_records"},
			{Key: "discovered_at", Label: "Discovered", Type: colDateTime, Expr: "db.discovered_at"},
			{Key: "notify_deadline_at", Label: "Notify Deadline", Type: colDateTime, Expr: "db.notify_deadline_at"},
			{Key: "ndpc_notified", Label: "NDPC Notified", Type: colBool, Expr: "db.ndpc_notified"},
			{Key: "ndpc_notified_at", Label: "NDPC Notified At", Type: colDateTime, Expr: "db.ndpc_notified_at"},
			{Key: "ndpc_ref_number", Label: "NDPC Ref", Type: colText, Expr: "db.ndpc_ref_number"},
			{Key: "closed_at", Label: "Closed", Type: colDateTime, Expr: "db.closed_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "db.status = ?"},
			{Key: "severity", Label: "Severity", Kind: filterText, Expr: "db.severity = ?"},
		},
	},
	{
		Key:       "dpa_register",
		Label:     "Data Processing Register",
		Module:    "Compliance",
		Desc:      "The NDPR Article 30-style register: each processing activity, its legal basis, who the data is shared with, and how long it is kept.",
		From:      "app.dpa_processing_register dr",
		OrderBy:   "dr.processing_name",
		KeyCol:    "dr.id",
		DateCol:   "dr.created_at",
		DateLabel: "Created",
		Cols: []exportCol{
			{Key: "processing_name", Label: "Processing Activity", Type: colText, Expr: "dr.processing_name"},
			{Key: "purpose", Label: "Purpose", Type: colText, Expr: "dr.purpose"},
			{Key: "legal_basis", Label: "Legal Basis", Type: colText, Expr: "dr.legal_basis"},
			{Key: "data_subjects", Label: "Data Subjects", Type: colText, Expr: "dr.data_subjects"},
			{Key: "recipients", Label: "Recipients", Type: colText, Expr: "dr.recipients"},
			{Key: "third_country_transfers", Label: "Transfers Abroad", Type: colBool, Expr: "dr.third_country_transfers"},
			{Key: "retention_period", Label: "Retention", Type: colText, Expr: "dr.retention_period"},
			{Key: "dpo_reviewed", Label: "DPO Reviewed", Type: colBool, Expr: "dr.dpo_reviewed"},
			{Key: "status", Label: "Status", Type: colText, Expr: "dr.status"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "dr.status = ?"},
			{Key: "legal_basis", Label: "Legal Basis", Kind: filterText, Expr: "dr.legal_basis = ?"},
		},
	},
	{
		Key:       "policy_documents",
		Label:     "Policy Documents",
		Module:    "Compliance",
		Desc:      "The policy library with its review clock: owner, approval, version and when each document is next due for review.",
		From:      "app.soc2_policy_documents pd",
		OrderBy:   "pd.sort_order, pd.name",
		KeyCol:    "pd.id",
		DateCol:   "pd.next_review_date",
		DateLabel: "Next Review",
		Cols: []exportCol{
			{Key: "name", Label: "Policy", Type: colText, Expr: "pd.name"},
			{Key: "category", Label: "Category", Type: colText, Expr: "pd.category"},
			{Key: "status", Label: "Status", Type: colText, Expr: "pd.status"},
			{Key: "version", Label: "Version", Type: colText, Expr: "pd.version"},
			{Key: "owner_name", Label: "Owner", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = pd.owner_id)`},
			{Key: "approved_by_name", Label: "Approved By", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = pd.approved_by)`},
			{Key: "approved_at", Label: "Approved", Type: colDateTime, Expr: "pd.approved_at"},
			{Key: "next_review_date", Label: "Next Review", Type: colDate, Expr: "pd.next_review_date"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "pd.status = ?"},
			{Key: "category", Label: "Category", Kind: filterText, Expr: "pd.category = ?"},
		},
	},

	// ── Care ──────────────────────────────────────────────────────────────────
	{
		Key:    "care_mail",
		Label:  "Care Mail",
		Module: "Care",
		Desc: "Every message the workspace sent or queued on the email channel, with its " +
			"delivery outcome. Care works email-channel tickets and had no data source at " +
			"all; this is the delivery record behind them. Bodies are not included — a " +
			"delivery report does not need the correspondence.",
		From:      "app.mail_messages mm",
		OrderBy:   "mm.created_at DESC",
		KeyCol:    "mm.id",
		DateCol:   "mm.created_at",
		DateLabel: "Created",
		Cols: []exportCol{
			{Key: "created_at", Label: "Created", Type: colDateTime, Expr: "mm.created_at"},
			{Key: "kind", Label: "Kind", Type: colText, Expr: "mm.kind"},
			{Key: "subject", Label: "Subject", Type: colText, Expr: "mm.subject"},
			{Key: "from_name", Label: "From Name", Type: colText, Expr: "mm.from_name"},
			{Key: "from_email", Label: "From", Type: colText, Expr: "mm.from_email"},
			{Key: "status", Label: "Status", Type: colText, Expr: "mm.status"},
			{Key: "queued_at", Label: "Queued", Type: colDateTime, Expr: "mm.queued_at"},
			{Key: "delivered_at", Label: "Delivered", Type: colDateTime, Expr: "mm.delivered_at"},
			{Key: "opened_at", Label: "Opened", Type: colDateTime, Expr: "mm.opened_at"},
			{Key: "clicked_at", Label: "Clicked", Type: colDateTime, Expr: "mm.clicked_at"},
			{Key: "bounced_at", Label: "Bounced", Type: colDateTime, Expr: "mm.bounced_at"},
			{Key: "last_error", Label: "Last Error", Type: colText, Expr: "mm.last_error"},
			{Key: "sent_by_name", Label: "Sent By", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = mm.created_by)`},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "mm.status = ?"},
			{Key: "kind", Label: "Kind", Kind: filterText, Expr: "mm.kind = ?"},
		},
	},

	// ── Finance ───────────────────────────────────────────────────────────────
	{
		Key:    "fx_rates",
		Label:  "FX Rates",
		Module: "Finance",
		Desc: "Scraped parallel-market buy and sell rates by source and currency. Rates " +
			"are major units, not kobo — a rate is a price, not an amount.",
		From:      "app.fx_parallel_rates fr",
		OrderBy:   "fr.scraped_at DESC",
		KeyCol:    "fr.id",
		DateCol:   "fr.scraped_at",
		DateLabel: "Scraped",
		Cols: []exportCol{
			{Key: "scraped_at", Label: "Scraped", Type: colDateTime, Expr: "fr.scraped_at"},
			{Key: "source", Label: "Source", Type: colText, Expr: "fr.source"},
			{Key: "currency", Label: "Currency", Type: colText, Expr: "fr.currency"},
			{Key: "buy_ngn", Label: "Buy (NGN)", Type: colMoney, Expr: "fr.buy"},
			{Key: "sell_ngn", Label: "Sell (NGN)", Type: colMoney, Expr: "fr.sell"},
			{Key: "spread_ngn", Label: "Spread (NGN)", Type: colMoney, Expr: "(fr.sell - fr.buy)"},
		},
		Filters: []exportFilter{
			{Key: "currency", Label: "Currency", Kind: filterText, Expr: "fr.currency = ?"},
			{Key: "source", Label: "Source", Kind: filterText, Expr: "fr.source = ?"},
		},
	},
	{
		Key:       "commission_rates",
		Label:     "Commission Rates",
		Module:    "Finance",
		Desc:      "The commission rate card by product line: the basis points or flat amount each line earns, and who last changed it.",
		From:      "app.sales_commission_rates cr",
		OrderBy:   "cr.line",
		KeyCol:    "cr.line",
		DateCol:   "cr.updated_at",
		DateLabel: "Updated",
		Cols: []exportCol{
			{Key: "line", Label: "Product Line", Type: colText, Expr: "cr.line"},
			{Key: "basis", Label: "Basis", Type: colText, Expr: "cr.basis"},
			{Key: "rate_bps", Label: "Rate (bps)", Type: colInt, Expr: "cr.rate_bps"},
			{Key: "amount_kobo", Label: "Flat Amount (NGN)", Type: colKobo, Expr: "cr.amount_kobo"},
			{Key: "updated_by_name", Label: "Updated By", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = cr.updated_by)`},
			{Key: "updated_at", Label: "Updated", Type: colDateTime, Expr: "cr.updated_at"},
		},
		Filters: []exportFilter{
			{Key: "basis", Label: "Basis", Kind: filterText, Expr: "cr.basis = ?"},
		},
	},

	// ── Sales ─────────────────────────────────────────────────────────────────
	{
		Key:    "sales_targets",
		Label:  "Sales Targets",
		Module: "Sales & CRM",
		Desc: "One row per officer per month, in the three product lines targets are set " +
			"in. Note that loan_count and card_count are 0 across every period measured " +
			"2026-10-09 — only the money targets are being set — so a 0 here means 'no " +
			"target set', not 'a target of nothing'.",
		From: `app.sales_targets st
		         LEFT JOIN app.o3c_users u ON u.id = st.user_id`,
		OrderBy:   "st.period DESC, u.full_name",
		KeyCol:    "st.id",
		DateCol:   "st.created_at",
		DateLabel: "Set",
		Cols: []exportCol{
			{Key: "officer_name", Label: "Officer", Type: colText, Expr: "u.full_name"},
			{Key: "period", Label: "Period", Type: colText, Expr: "st.period"},
			{Key: "disbursement_kobo", Label: "Loan Target (NGN)", Type: colKobo, Expr: "st.disbursement_kobo"},
			{Key: "loan_count", Label: "Loan Count Target", Type: colInt, Expr: "st.loan_count"},
			{Key: "fd_amount_kobo", Label: "Deposit Target (NGN)", Type: colKobo, Expr: "st.fd_amount_kobo"},
			{Key: "fd_count", Label: "Deposit Count Target", Type: colInt, Expr: "st.fd_count"},
			{Key: "card_count", Label: "Card Target", Type: colInt, Expr: "st.card_count"},
			{Key: "notes", Label: "Notes", Type: colText, Expr: "st.notes"},
		},
		Filters: []exportFilter{
			{Key: "period", Label: "Period", Kind: filterText, Expr: "st.period = ?"},
			{Key: "officer_name", Label: "Officer", Kind: filterText, Expr: "u.full_name ILIKE '%' || ? || '%'"},
		},
	},
	{
		Key:    "lead_handoffs",
		Label:  "Lead Hand-offs to Sales",
		Module: "Sales & CRM",
		Desc: "The audited hand-off ledger: every lead the call centre passed to Sales, " +
			"who passed it, who received it and what became of it. This is the trail " +
			"migrations 250-253 created and migration 298 backfilled, and it is the only " +
			"place the call-centre-to-Sales boundary is recorded.",
		From:      "app.call_center_lead_forwards lf",
		OrderBy:   "lf.forwarded_at DESC",
		KeyCol:    "lf.id",
		DateCol:   "lf.forwarded_at",
		DateLabel: "Forwarded",
		Cols: []exportCol{
			{Key: "forwarded_at", Label: "Forwarded", Type: colDateTime, Expr: "lf.forwarded_at"},
			{Key: "customer_name", Label: "Customer", Type: colText, Expr: "lf.customer_name"},
			{Key: "customer_phone", Label: "Phone", Type: colText, Expr: "lf.customer_phone"},
			{Key: "customer_cif", Label: "CIF", Type: colText, Expr: "lf.customer_cif"},
			{Key: "product_interest", Label: "Product Interest", Type: colText, Expr: "lf.product_interest"},
			{Key: "forwarded_by_name", Label: "Forwarded By", Type: colText, Expr: "lf.forwarded_by_name"},
			{Key: "sales_owner_name", Label: "Sales Owner", Type: colText, Expr: "lf.sales_owner_name"},
			{Key: "status", Label: "Status", Type: colText, Expr: "lf.status"},
			{Key: "outcome", Label: "Outcome", Type: colText, Expr: "lf.outcome"},
			{Key: "notes", Label: "Notes", Type: colText, Expr: "lf.notes"},
			{Key: "resolved_at", Label: "Resolved", Type: colDateTime, Expr: "lf.resolved_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "lf.status = ?"},
			{Key: "outcome", Label: "Outcome", Kind: filterText, Expr: "lf.outcome = ?"},
			{Key: "sales_owner_name", Label: "Sales Owner", Kind: filterText, Expr: "lf.sales_owner_name ILIKE '%' || ? || '%'"},
		},
	},
	{
		Key:    "crm_tasks",
		Label:  "CRM Tasks",
		Module: "Sales & CRM",
		Desc: "Follow-up tasks against contacts and deals, with who owns each one and " +
			"whether it is overdue. The contact is named rather than numbered.",
		From: `app.crm_tasks ct
		         LEFT JOIN app.crm_contacts k ON k.id = ct.contact_id
		         LEFT JOIN app.o3c_users u ON u.id = ct.assigned_to`,
		OrderBy:   "ct.due_date NULLS LAST",
		KeyCol:    "ct.id",
		DateCol:   "ct.due_date",
		DateLabel: "Due",
		Cols: []exportCol{
			{Key: "title", Label: "Task", Type: colText, Expr: "ct.title"},
			{Key: "customer_name", Label: "Contact", Type: colText,
				Expr: `NULLIF(btrim(COALESCE(k.first_name,'') || ' ' || COALESCE(k.last_name,'')), '')`},
			{Key: "assigned_to_name", Label: "Assigned To", Type: colText, Expr: "u.full_name"},
			{Key: "priority", Label: "Priority", Type: colText, Expr: "ct.priority"},
			{Key: "status", Label: "Status", Type: colText, Expr: "ct.status"},
			{Key: "due_date", Label: "Due", Type: colDateTime, Expr: "ct.due_date"},
			{Key: "linked_type", Label: "Linked To", Type: colText, Expr: "ct.linked_type"},
			{Key: "description", Label: "Description", Type: colText, Expr: "ct.description"},
			{Key: "created_at", Label: "Created", Type: colDateTime, Expr: "ct.created_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "ct.status = ?"},
			{Key: "priority", Label: "Priority", Kind: filterText, Expr: "ct.priority = ?"},
			{Key: "assigned_to_name", Label: "Assigned To", Kind: filterText, Expr: "u.full_name ILIKE '%' || ? || '%'"},
		},
	},

	// ── Cards ─────────────────────────────────────────────────────────────────
	{
		Key:       "card_disputes",
		Label:     "Card Disputes",
		Module:    "Cards",
		Desc:      "Disputed card transactions: what was contested, for how much, and how long it took to resolve.",
		From:      "app.card_disputes cd2",
		OrderBy:   "cd2.filed_at DESC",
		KeyCol:    "cd2.id",
		DateCol:   "cd2.filed_at",
		DateLabel: "Filed",
		Cols: []exportCol{
			{Key: "filed_at", Label: "Filed", Type: colDateTime, Expr: "cd2.filed_at"},
			{Key: "customer_name", Label: "Customer", Type: colText, Expr: "cd2.customer_name"},
			{Key: "cif_number", Label: "CIF", Type: colText, Expr: "cd2.cif_number"},
			{Key: "card_type", Label: "Card Type", Type: colText, Expr: "cd2.card_type"},
			{Key: "dispute_type", Label: "Dispute Type", Type: colText, Expr: "cd2.dispute_type"},
			{Key: "amount_kobo", Label: "Amount (NGN)", Type: colKobo, Expr: "cd2.amount_kobo"},
			{Key: "status", Label: "Status", Type: colText, Expr: "cd2.status"},
			{Key: "notes", Label: "Notes", Type: colText, Expr: "cd2.notes"},
			{Key: "resolved_at", Label: "Resolved", Type: colDateTime, Expr: "cd2.resolved_at"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "cd2.status = ?"},
			{Key: "dispute_type", Label: "Dispute Type", Kind: filterText, Expr: "cd2.dispute_type = ?"},
		},
	},
	{
		Key:    "card_issuance_requests",
		Label:  "Card Issuance Requests",
		Module: "Cards",
		Desc: "Requests to issue a card, and who introduced the customer. This is the one " +
			"flow that can attribute a card sale to a seller — card attribution was proved " +
			"impossible from existing data twice, so sales_officer_id here is the only " +
			"forward-looking source of it. The PAN is masked to its last 4.",
		From: `app.card_issuance_requests ci
		         LEFT JOIN app.o3c_users u ON u.id = ci.sales_officer_id`,
		OrderBy:   "ci.created_at DESC",
		KeyCol:    "ci.id",
		DateCol:   "ci.created_at",
		DateLabel: "Requested",
		Cols: []exportCol{
			{Key: "created_at", Label: "Requested", Type: colDateTime, Expr: "ci.created_at"},
			{Key: "customer_name", Label: "Customer", Type: colText, Expr: "ci.customer_name"},
			{Key: "cif_number", Label: "CIF", Type: colText, Expr: "ci.cif_number"},
			{Key: "card_type", Label: "Card Type", Type: colText, Expr: "ci.card_type"},
			{Key: "account_no", Label: "Account No", Type: colText, Expr: "ci.account_no"},
			{Key: "card_pan_masked", Label: "Card (Masked)", Type: colText, Expr: maskedIssuancePAN},
			{Key: "status", Label: "Status", Type: colText, Expr: "ci.status"},
			{Key: "officer_name", Label: "Sales Officer", Type: colText, Expr: "u.full_name"},
			{Key: "introducer", Label: "Introducer", Type: colText, Expr: "ci.introducer"},
			{Key: "notes", Label: "Notes", Type: colText, Expr: "ci.notes"},
		},
		Filters: []exportFilter{
			{Key: "status", Label: "Status", Kind: filterText, Expr: "ci.status = ?"},
			{Key: "card_type", Label: "Card Type", Kind: filterText, Expr: "ci.card_type = ?"},
			{Key: "officer_name", Label: "Sales Officer", Kind: filterText, Expr: "u.full_name ILIKE '%' || ? || '%'"},
		},
	},

	// ── Call Centre ───────────────────────────────────────────────────────────
	{
		Key:    "qa_evaluations",
		Label:  "Call QA Evaluations",
		Module: "Call Centre",
		Desc: "Scored call reviews: who was evaluated, by whom, the score and band, and " +
			"whether a critical error was recorded. The per-parameter scores live in a " +
			"JSON column and are not flattened here — the band and the total are what a " +
			"report compares.",
		From:      "app.qa_evaluations qe",
		OrderBy:   "qe.created_at DESC",
		KeyCol:    "qe.id",
		DateCol:   "qe.call_started_at",
		DateLabel: "Call Date",
		Cols: []exportCol{
			{Key: "call_started_at", Label: "Call Date", Type: colDateTime, Expr: "qe.call_started_at"},
			{Key: "agent_name", Label: "Agent", Type: colText, Expr: "qe.agent_name"},
			{Key: "evaluator_name", Label: "Evaluator", Type: colText, Expr: "qe.evaluator_name"},
			{Key: "customer_name", Label: "Customer", Type: colText, Expr: "qe.customer_name"},
			{Key: "call_direction", Label: "Direction", Type: colText, Expr: "qe.call_direction"},
			{Key: "call_type", Label: "Call Type", Type: colText, Expr: "qe.call_type"},
			{Key: "total_score", Label: "Score", Type: colPct, Expr: "qe.total_score"},
			{Key: "rating_band", Label: "Band", Type: colText, Expr: "qe.rating_band"},
			{Key: "passed", Label: "Passed", Type: colBool, Expr: "qe.passed"},
			{Key: "critical_error", Label: "Critical Error", Type: colBool, Expr: "qe.critical_error"},
			{Key: "coaching_status", Label: "Coaching", Type: colText, Expr: "qe.coaching_status"},
			{Key: "strengths", Label: "Strengths", Type: colText, Expr: "qe.strengths"},
			{Key: "improvements", Label: "Improvements", Type: colText, Expr: "qe.improvements"},
		},
		Filters: []exportFilter{
			{Key: "rating_band", Label: "Band", Kind: filterText, Expr: "qe.rating_band = ?"},
			{Key: "agent_name", Label: "Agent", Kind: filterText, Expr: "qe.agent_name ILIKE '%' || ? || '%'"},
			{Key: "coaching_status", Label: "Coaching", Kind: filterText, Expr: "qe.coaching_status = ?"},
		},
	},

	// ── Feedback ──────────────────────────────────────────────────────────────
	{
		Key:    "survey_responses",
		Label:  "Survey Responses",
		Module: "Feedback",
		Desc: "Completed survey responses with NPS and overall score, and the survey " +
			"named rather than numbered. An anonymous survey still records a response; " +
			"the customer columns are simply empty for it.",
		From: `app.survey_responses sv
		         LEFT JOIN app.surveys s2 ON s2.id = sv.survey_id`,
		OrderBy:   "sv.submitted_at DESC NULLS LAST",
		KeyCol:    "sv.id",
		DateCol:   "sv.submitted_at",
		DateLabel: "Submitted",
		Cols: []exportCol{
			{Key: "submitted_at", Label: "Submitted", Type: colDateTime, Expr: "sv.submitted_at"},
			{Key: "survey_name", Label: "Survey", Type: colText, Expr: "s2.title"},
			{Key: "survey_category", Label: "Category", Type: colText, Expr: "s2.category"},
			{Key: "department", Label: "Department", Type: colText, Expr: "s2.department"},
			{Key: "customer_name", Label: "Customer", Type: colText, Expr: "sv.customer_name"},
			{Key: "customer_cif", Label: "CIF", Type: colText, Expr: "sv.customer_cif"},
			{Key: "nps_score", Label: "NPS (0-10)", Type: colInt, Expr: "sv.nps_score"},
			{Key: "overall_score", Label: "Overall Score (of 10)", Type: colInt, Expr: "sv.overall_score"},
			{Key: "source", Label: "Source", Type: colText, Expr: "sv.source"},
			{Key: "completed_at", Label: "Completed", Type: colDateTime, Expr: "sv.completed_at"},
		},
		Filters: []exportFilter{
			{Key: "survey_name", Label: "Survey", Kind: filterText, Expr: "s2.title ILIKE '%' || ? || '%'"},
			{Key: "department", Label: "Department", Kind: filterText, Expr: "s2.department = ?"},
			{Key: "source", Label: "Source", Kind: filterText, Expr: "sv.source = ?"},
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
