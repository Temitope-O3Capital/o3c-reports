package handlers

/*
Curated relationships between datasets — the "related data" a report can reach.

WHY THESE ARE DECLARED AND NOT INFERRED. The obvious way to let someone combine two
datasets is to detect the relationship: match column names, match types, offer the join.
Every general-purpose BI tool does it, and on this database it would produce confidently
wrong reports about real customers' money. Measured, not supposed:

  - app.customers.cif holds 22,237 rows across 21,877 DISTINCT cifs. A plain join on it
    fans out and double-counts, so the figures come back inflated by a few hundred rows'
    worth of duplicate customer records.
  - Of 300 Udara customer ids, 275 also exist as a card CIF and all 275 of 275 are a
    DIFFERENT PERSON. An inferred "cif ≈ cbs_customer_id" edge would attribute one
    borrower's debt to a stranger, and the report would look entirely reasonable.
  - app.norm_phone returns '' rather than NULL, so a phone edge marries every record with
    no phone to every other record with no phone.
  - app.cbs_officer_map carries Udara's trailing spaces; trimming one side of that
    comparison moves about NGN 11bn of officer attribution.

So a relationship exists here only once somebody has worked out what its key means. The
registry is the record of that work, and adding an edge is a deliberate act.

EVERY EDGE IS TO-ONE, AND THAT IS THE SAFETY PROPERTY. A to-one join cannot change the
number of rows, so it cannot double-count a sum — which means the dangerous case is
excluded by construction rather than by a warning somebody dismisses. Where the join key
is NOT unique the edge must say which single row it means, with a LEFT JOIN LATERAL and
an explicit ORDER BY ... LIMIT 1; "the latest one" is a semantic choice and it belongs in
Note, where the person running the report can read it.

TestEveryJoinEdgeIsToOne proves it against the live database by running each edge and
comparing the row count with and without it. A to-many edge added by accident fails there
rather than in somebody's board pack.

ACCESS. An edge requires its own dataset AND the one it reaches, so a relationship can
never be a way to read data the person could not open directly. Without that rule, adding
an edge to the customer master would hand every department head the customer master.
*/

import (
	"fmt"

	"github.com/o3c/workspace/core"
)

// joinEdge is one curated relationship. Join is the complete clause, so there is no
// assembly step that could put the predicate in the wrong place, and Cols reference the
// alias that clause introduces.
// The SQL is json:"-" for the same reason a dataset's From is: the shape of the
// warehouse is not something the browser needs, and a clause that reaches the client is
// a clause somebody will eventually try to send back.
type joinEdge struct {
	Key      string      `json:"key"`      // stable id; also the prefix on every column key it contributes
	From     string      `json:"-"`        // dataset this hangs off
	Requires string      `json:"requires"` // dataset key whose access is ALSO needed
	Label    string      `json:"label"`    // what the field list shows
	Note     string      `json:"note"`     // what the edge means, including which row a lateral picks
	Join     string      `json:"-"`        // complete LEFT JOIN clause, including its alias
	Cols     []exportCol `json:"columns"`
}

// joinKeySep separates the edge key from the column key. UNDERSCORES, not a dot: the
// prefixed key is emitted as a SQL identifier by exportCol.sql() ("expr AS <key>"), so a
// dot would be parsed as a qualified name and the query would not compile.
const joinKeySep = "__"

var exportJoinEdges = []joinEdge{
	{
		Key:      "loan",
		From:     "loan_repayments",
		Requires: "loan_book",
		Label:    "Loan",
		Note: "The loan the money was received against, from the live Udara book. Joined on " +
			"the loan ACCOUNT NUMBER, which is unique (59 of 59) and carries none of the " +
			"CIF namespace collision — so this is a plain join and cannot duplicate a " +
			"repayment. Lets a repayment be reported against the product, the officer and " +
			"the arrears on the same facility.",
		Join: "LEFT JOIN app.cbs_loans cl ON cl.cbs_account_number = lr.cbs_loan_account",
		Cols: []exportCol{
			{Key: "product_name", Label: "Product", Type: colText, Expr: "cl.product_name"},
			{Key: "status", Label: "Status", Type: colText, Expr: "cl.status"},
			{Key: "officer_name", Label: "Account Officer", Type: colText, Expr: "cl.officer_name"},
			{Key: "branch_name", Label: "Branch", Type: colText, Expr: "cl.branch_name"},
			{Key: "loan_amount", Label: "Loan Amount (NGN)", Type: colKobo, Expr: "cl.loan_amount_kobo"},
			{Key: "outstanding_principal", Label: "Outstanding Principal (NGN)", Type: colKobo,
				Expr: "cl.outstanding_principal_kobo"},
			{Key: "dpd", Label: "DPD", Type: colInt, Expr: cbsLoanDPD},
			{Key: "arrears", Label: "Arrears (NGN)", Type: colKobo, Expr: cbsLoanArrears},
			{Key: "risk_band", Label: "Risk Band", Type: colText, Expr: cbsLoanBand},
			{Key: "sector", Label: "Sector", Type: colText, Expr: "app.cbn_sector_name(cl.economic_sector)"},
			{Key: "date_booked", Label: "Date Booked", Type: colDate, Expr: "cl.date_booked"},
			{Key: "maturity_date", Label: "Maturity Date", Type: colDate, Expr: "cl.maturity_date"},
		},
	},
	{
		Key:      "assignment",
		From:     "collections_payments",
		Requires: "collections_assignments",
		Label:    "Collections Assignment",
		Note: "WHO WAS CHASING THE DEBT WHEN IT PAID. A customer can hold several " +
			"assignments — four, at the worst measured — so this is NOT a plain join: it " +
			"is a lateral that takes the MOST RECENT assignment by id. Read it as 'the " +
			"latest assignment for this customer', not 'the assignment this payment " +
			"settled', which the data does not record.",
		Join: `LEFT JOIN LATERAL (
		           SELECT ca.* FROM app.collection_assignments ca
		            WHERE ca.account_cif = cp.account_cif
		            ORDER BY ca.id DESC LIMIT 1
		       ) pa ON TRUE`,
		Cols: []exportCol{
			{Key: "agent_name", Label: "Assigned Agent", Type: colText,
				Expr: `(SELECT u.full_name FROM app.o3c_users u WHERE u.id = pa.agent_user_id)`},
			{Key: "status", Label: "Assignment Status", Type: colText, Expr: "pa.status"},
			{Key: "dpd_bucket", Label: "DPD Bucket", Type: colText, Expr: "pa.dpd_bucket"},
			{Key: "current_stage", Label: "Stage", Type: colText, Expr: "pa.current_stage"},
			{Key: "book_section", Label: "Book Section", Type: colText, Expr: "pa.book_section"},
			{Key: "product_type", Label: "Product Type", Type: colText, Expr: "pa.product_type"},
			{Key: "officer_name", Label: "Account Officer", Type: colText, Expr: "pa.officer_name"},
			{Key: "outstanding", Label: "Outstanding At Assignment (NGN)", Type: colKobo,
				Expr: "pa.outstanding_kobo"},
			{Key: "target_amount", Label: "Target Amount (NGN)", Type: colKobo, Expr: "pa.target_amount_kobo"},
			{Key: "assignment_date", Label: "Assigned", Type: colDate, Expr: "pa.assignment_date"},
			{Key: "maturity_date", Label: "Maturity Date", Type: colDate, Expr: "pa.maturity_date"},
		},
	},
}

// joinEdgesFor lists the relationships available on a dataset, filtered to the ones the
// caller may actually use. The field list renders exactly this.
//
// The columns come back with their keys and labels ALREADY PREFIXED, exactly as
// datasetWithRelations will name them. The browser therefore never computes a key: it
// selects what it was given, and the two sides cannot drift into disagreeing about what
// "assignment__status" is called.
func joinEdgesFor(dataset string, u *core.Claims) []joinEdge {
	out := []joinEdge{}
	for _, e := range exportJoinEdges {
		if e.From != dataset {
			continue
		}
		if !reportDatasetAllowed(u, e.Requires) {
			continue
		}
		pub := e
		pub.Cols = make([]exportCol, len(e.Cols))
		for i, c := range e.Cols {
			c.Key = e.Key + joinKeySep + c.Key
			c.Label = e.Label + " · " + c.Label
			pub.Cols[i] = c
		}
		out = append(out, pub)
	}
	return out
}

func joinEdgeFor(dataset, key string) (joinEdge, bool) {
	for _, e := range exportJoinEdges {
		if e.From == dataset && e.Key == key {
			return e, true
		}
	}
	return joinEdge{}, false
}

// datasetWithRelations returns the dataset with the requested relationships joined in and
// their columns appended, prefixed. Every downstream path — the preview, the pivot, the
// table, the file, the email, the schedule — reads From, Cols and colByKey off an
// exportDataset value, so expanding it here is the whole integration: nothing else needs
// to know relationships exist.
//
// Refuses an unknown or unpermitted relationship rather than dropping it. A silently
// ignored relationship would hand back a report missing the columns someone asked for,
// which is the failure that gets noticed only after a decision is made on it.
func datasetWithRelations(d exportDataset, rels []string, u *core.Claims) (exportDataset, error) {
	if len(rels) == 0 {
		return d, nil
	}
	// The registry's own slice must never be appended to: d is a copy of the struct, but
	// d.Cols still shares the registry's backing array, and an append with spare capacity
	// would write the joined columns into the registry itself — permanently, for every
	// later request on that dataset.
	cols := make([]exportCol, len(d.Cols), len(d.Cols)+8*len(rels))
	copy(cols, d.Cols)

	seen := map[string]bool{}
	for _, k := range rels {
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		e, ok := joinEdgeFor(d.Key, k)
		if !ok {
			return d, fmt.Errorf("unknown related data %q for %q", k, d.Key)
		}
		if !reportDatasetAllowed(u, e.Requires) {
			return d, fmt.Errorf("%s needs access to %s as well", e.Label, e.Requires)
		}
		d.From += "\n" + e.Join
		for _, c := range e.Cols {
			c.Key = e.Key + joinKeySep + c.Key
			// Prefixed so two relationships reaching the same kind of field stay apart in
			// the picker, and so a joined Status is never mistaken for the record's own.
			c.Label = e.Label + " · " + c.Label
			cols = append(cols, c)
		}
	}
	d.Cols = cols
	return d, nil
}
