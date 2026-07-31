package cbssync

import (
	"context"
	"database/sql"

	"github.com/o3c/reports/core"
)

// customerMasterTable is the Sage/MSSQL customer snapshot (populated by the nightly
// sync). Udara's cbs_customer_id equals its "CIF Number", so that is the reconciliation
// key. The workspace-native loan/FD tables are not used here — they hold no records in
// this deployment; the customer master is the authoritative directory.
const customerMasterTable = `"Accounts"`

// Reconcile counts how many synced CBS accounts belong to a customer known to the
// workspace (i.e. cbs_customer_id exists in the Sage customer master "CIF Number"),
// versus how many are Udara-only customers not yet in the master. Returns
// (matched, unmatched). If the customer master table is absent (e.g. a fresh env
// without the Sage sync), everything is reported unmatched rather than erroring.
func Reconcile(ctx context.Context, db *core.DB) (matched, unmatched int, err error) {
	total := scalarInt(ctx, db,
		`SELECT (SELECT count(*) FROM cbs_loans) + (SELECT count(*) FROM cbs_fixed_deposits)`)

	if !CustomerMasterExists(ctx, db) {
		return 0, total, nil
	}

	matched = scalarInt(ctx, db, `
		SELECT
		  (SELECT count(*) FROM cbs_loans cl
		     WHERE cl.cbs_customer_id <> '' AND EXISTS (
		         SELECT 1 FROM `+customerMasterTable+` a WHERE a."CIF Number" = cl.cbs_customer_id))
		+ (SELECT count(*) FROM cbs_fixed_deposits cf
		     WHERE cf.cbs_customer_id <> '' AND EXISTS (
		         SELECT 1 FROM `+customerMasterTable+` a WHERE a."CIF Number" = cf.cbs_customer_id))`)

	unmatched = total - matched
	if unmatched < 0 {
		unmatched = 0
	}
	return matched, unmatched, nil
}

// CustomerMasterExists reports whether the Sage customer-master snapshot table is present.
func CustomerMasterExists(ctx context.Context, db *core.DB) bool {
	var reg sql.NullString
	if err := db.PG.QueryRowContext(ctx, `SELECT to_regclass('`+customerMasterTable+`')`).Scan(&reg); err != nil {
		return false
	}
	return reg.Valid
}

func scalarInt(ctx context.Context, db *core.DB, q string) int {
	var n sql.NullInt64
	if err := db.PG.QueryRowContext(ctx, q).Scan(&n); err != nil {
		return 0
	}
	if !n.Valid {
		return 0
	}
	return int(n.Int64)
}
