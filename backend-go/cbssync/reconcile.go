package cbssync

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/o3c/workspace/core"
)

// customerMasterTable is the Sage/MSSQL customer snapshot (populated by the nightly
// sync). It is NOT a reconciliation key for the Udara360 book: its "CIF Number" is a
// CARDS identifier (CCS/Sage), a different namespace from Udara's cbs_customer_id —
// Udara customer 00000424 is FINTRAK, while cif 00000424 is Adetunji Taiwo. It is kept
// only for CustomerMasterExists, which the CBS report handlers use to decide whether the
// Sage directory is present at all.
const customerMasterTable = `"Accounts"`

// Reconcile counts how many synced CBS accounts (loans + fixed deposits) belong to a
// customer the workspace actually knows, and how many are Udara-only accounts with no
// workspace identity yet. Returns (matched, unmatched).
//
// It resolves through app.cbs_links (entity_type='party') to party_id — the workspace
// Customer ID and the only correct bridge between Udara360 and the workspace. The three
// id namespaces look joinable and are not:
//
//	app.parties.party_id            the workspace Customer ID — the unifying key
//	app.customers.cif               a CARDS id (CCS/Sage). NOT a customer id.
//	cbs_customers.cbs_customer_id   Udara360 core banking only
//
// This previously matched cbs_customer_id against app."Accounts"."CIF Number". With
// 21,790 Sage rows almost every Udara id found *a* row, so it reported 432/432 matched
// while the row it matched was a different real person on essentially every account
// (45 of 52 testable loan names disagreed; the 7 that agreed are entities that genuinely
// exist in both systems under the same number). cbs_links resolves the same book exactly
// and honestly.
//
// A cbs_customer_id is resolved with a LIMIT 1 subquery rather than a join: cbs_links is
// unique on (entity_type, entity_id), not on cbs_customer_id, so a join could multiply
// rows and overstate the book.
func Reconcile(ctx context.Context, db *core.DB) (matched, unmatched int, err error) {
	const q = `
WITH book AS (
    SELECT NULLIF(btrim(cbs_customer_id), '') AS cbs_customer_id FROM cbs_loans
    UNION ALL
    SELECT NULLIF(btrim(cbs_customer_id), '') FROM cbs_fixed_deposits
),
resolved AS (
    SELECT (SELECT l.entity_id
              FROM app.cbs_links l
             WHERE l.entity_type = 'party'
               AND l.cbs_customer_id = b.cbs_customer_id
             LIMIT 1) AS party_id
      FROM book b
)
SELECT count(*) FILTER (WHERE party_id IS NOT NULL),
       count(*) FILTER (WHERE party_id IS NULL)
  FROM resolved`
	if err := db.PG.QueryRowContext(ctx, q).Scan(&matched, &unmatched); err != nil {
		return 0, 0, fmt.Errorf("cbs reconcile: %w", err)
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
