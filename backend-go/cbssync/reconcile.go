package cbssync

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/o3c/reports/core"
)

// Reconcile links freshly-synced CBS accounts to workspace records via the
// cbs_links table, keyed on CIF, and returns how many CBS accounts matched a
// workspace record vs. how many are still unmatched (surfaced for manual linking).
//
// Matching is best-effort by CIF:
//   - loans: cbs_loans.cbs_customer_id == loan_applications.applicant_cif
//   - FDs:   cbs_fixed_deposits.cbs_customer_id == fd_transactions.cif_number
//
// A fresh CBS rollout may legitimately produce zero matches; that is fine -- the
// unmatched count then drives the reconciliation UI.
func Reconcile(ctx context.Context, db *core.DB) (matched, unmatched int, err error) {
	tx, err := db.PG.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("cbs reconcile: begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// Loans -> loan_applications by CIF. DISTINCT ON (la.id) so one workspace loan
	// maps to at most one CBS account per statement (avoids ON CONFLICT double-hit).
	if _, err = tx.ExecContext(ctx, `
		INSERT INTO cbs_links (entity_type, entity_id, cbs_account_number, cbs_customer_id)
		SELECT DISTINCT ON (la.id) 'loan', la.id, cl.cbs_account_number, cl.cbs_customer_id
		FROM cbs_loans cl
		JOIN loan_applications la ON la.applicant_cif = cl.cbs_customer_id
		WHERE cl.cbs_customer_id IS NOT NULL AND cl.cbs_customer_id <> ''
		ORDER BY la.id, cl.cbs_account_number
		ON CONFLICT (entity_type, entity_id)
		DO UPDATE SET cbs_account_number = EXCLUDED.cbs_account_number,
		              cbs_customer_id    = EXCLUDED.cbs_customer_id`); err != nil {
		return 0, 0, fmt.Errorf("cbs reconcile: link loans: %w", err)
	}

	// FDs -> fd_transactions by CIF.
	if _, err = tx.ExecContext(ctx, `
		INSERT INTO cbs_links (entity_type, entity_id, cbs_account_number, cbs_customer_id)
		SELECT DISTINCT ON (fd.id) 'fd', fd.id, cf.cbs_account_number, cf.cbs_customer_id
		FROM cbs_fixed_deposits cf
		JOIN fd_transactions fd ON fd.cif_number = cf.cbs_customer_id
		WHERE cf.cbs_customer_id IS NOT NULL AND cf.cbs_customer_id <> ''
		ORDER BY fd.id, cf.cbs_account_number
		ON CONFLICT (entity_type, entity_id)
		DO UPDATE SET cbs_account_number = EXCLUDED.cbs_account_number,
		              cbs_customer_id    = EXCLUDED.cbs_customer_id`); err != nil {
		return 0, 0, fmt.Errorf("cbs reconcile: link fds: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return 0, 0, fmt.Errorf("cbs reconcile: commit: %w", err)
	}

	// matched = CBS accounts (loans + FDs) that have a workspace counterpart.
	matched = scalarInt(ctx, db, `
		SELECT
		  (SELECT count(*) FROM cbs_loans cl WHERE cl.cbs_customer_id <> ''
		     AND EXISTS (SELECT 1 FROM loan_applications la WHERE la.applicant_cif = cl.cbs_customer_id))
		+ (SELECT count(*) FROM cbs_fixed_deposits cf WHERE cf.cbs_customer_id <> ''
		     AND EXISTS (SELECT 1 FROM fd_transactions fd WHERE fd.cif_number = cf.cbs_customer_id))`)

	total := scalarInt(ctx, db,
		`SELECT (SELECT count(*) FROM cbs_loans) + (SELECT count(*) FROM cbs_fixed_deposits)`)

	unmatched = total - matched
	if unmatched < 0 {
		unmatched = 0
	}
	return matched, unmatched, nil
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
