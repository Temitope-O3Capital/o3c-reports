package iswsettle

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"

	"github.com/o3c/reports/core"
)

// Result summarises one import run.
type Result struct {
	ImportID  int64
	Files     int
	Legs      int
	Inserted  int
	Skipped   int // already present (idempotent re-upload)
	Errors    []string
}

// Insert writes legs, skipping any already present by row hash so re-uploading a
// file — or uploading a folder that overlaps a previous one — is safe.
func Insert(ctx context.Context, db *core.DB, legs []Leg) (inserted, skipped int, err error) {
	tx, err := db.PG.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO interswitch_legs (
		  report_family, session, source_file, settlement_date, local_datetime,
		  stan, rrn, tran_id, auth_id, pan, card_brand,
		  terminal_id, merchant_id, merchant_name, from_account, to_account, beneficiary_account,
		  amount_req_kobo, amount_rsp_kobo, surcharge_kobo,
		  settlement_impact_kobo, settlement_impact_desc,
		  merchant_discount_kobo, merchant_receivable_kobo,
		  currency, tran_type_desc, response_desc, txn_status, trxn_category, region, message_type,
		  row_hash)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
		        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
		ON CONFLICT (row_hash) DO NOTHING`)
	if err != nil {
		return 0, 0, err
	}
	defer stmt.Close()

	for _, l := range legs {
		res, err := stmt.ExecContext(ctx,
			l.ReportFamily, l.Session, l.SourceFile, l.SettlementDate, l.LocalDatetime,
			l.STAN, l.RRN, l.TranID, l.AuthID, l.PAN, l.CardBrand,
			l.TerminalID, l.MerchantID, l.MerchantName, l.FromAccount, l.ToAccount, l.BeneficiaryAccount,
			l.AmountReqKobo, l.AmountRspKobo, l.SurchargeKobo,
			l.SettlementImpactKobo, l.SettlementImpactDesc,
			l.MerchantDiscountKobo, l.MerchantReceivKobo,
			l.Currency, l.TranTypeDesc, l.ResponseDesc, l.TxnStatus, l.TrxnCategory, l.Region, l.MessageType,
			l.RowHash)
		if err != nil {
			return inserted, skipped, fmt.Errorf("insert leg: %w", err)
		}
		if n, _ := res.RowsAffected(); n > 0 {
			inserted++
		} else {
			skipped++
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return inserted, skipped, nil
}

// OpenRun records the start of an import and returns its id.
func OpenRun(ctx context.Context, db *core.DB, triggeredBy sql.NullInt64) (int64, error) {
	var id int64
	err := db.PG.QueryRowContext(ctx,
		`INSERT INTO interswitch_imports (triggered_by) VALUES ($1) RETURNING id`,
		triggeredBy).Scan(&id)
	return id, err
}

// CloseRun finalises the audit row.
func CloseRun(ctx context.Context, db *core.DB, id int64, r Result, runErr error) {
	status, errs := "ok", ""
	if runErr != nil {
		status = "error"
		errs = runErr.Error()
	} else if len(r.Errors) > 0 {
		// Partial success: some files failed, the rest landed.
		status = "partial"
		errs = fmt.Sprintf("%d file error(s): %v", len(r.Errors), r.Errors)
	}
	_, _ = db.PG.ExecContext(ctx, `
		UPDATE interswitch_imports
		SET finished_at=NOW(), status=$2, files_n=$3, legs_n=$4, inserted_n=$5, skipped_n=$6, errors=NULLIF($7,'')
		WHERE id=$1`, id, status, r.Files, r.Legs, r.Inserted, r.Skipped, errs)
	slog.Info("interswitch import done", "import_id", id, "status", status,
		"files", r.Files, "legs", r.Legs, "inserted", r.Inserted, "skipped", r.Skipped)
}
