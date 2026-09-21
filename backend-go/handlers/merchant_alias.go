package handlers

// Merchant alias refresh.
//
// app.transactions.merchant_name is truncated at ~21 characters, so one merchant
// appears under several spellings (MEGA CHICKEN RESTAURA / MEGA CHICKEN RESTAUR).
// app.refresh_merchant_aliases() (migration 244) maps a truncated spelling to the
// more frequent spelling it is a strict prefix of.
//
// It runs here, daily, rather than inside the migration because it scans the whole
// ledger and migrations run at backend boot. It is idempotent and never overwrites
// an existing alias, so manual corrections survive every refresh.
//
// This lives in its own file rather than as a step in the nightly batch to keep
// the change out of batch.go, which has concurrent uncommitted work in it.

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/o3c/workspace/core"
)

const (
	merchantAliasInterval  = 24 * time.Hour
	merchantAliasBootDelay = 10 * time.Minute // well clear of boot and the feeds' first runs
)

// StartMerchantAliasRefresh runs the alias refresh once shortly after boot, then daily.
func StartMerchantAliasRefresh(db *core.DB) {
	time.Sleep(merchantAliasBootDelay)
	runMerchantAliasRefresh(db)

	ticker := time.NewTicker(merchantAliasInterval)
	defer ticker.Stop()
	for range ticker.C {
		runMerchantAliasRefresh(db)
	}
}

func runMerchantAliasRefresh(db *core.DB) {
	// Generous: a full-ledger scan with a self-join over ~26k distinct names.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	WorkerBeat(ctx, db, "merchant_alias", "running", "", "")
	rows, err := db.PGQuery(ctx, `SELECT app.refresh_merchant_aliases() AS added`)
	if err != nil {
		slog.Error("merchant alias refresh failed", "err", err)
		WorkerBeat(ctx, db, "merchant_alias", "error", "", err.Error())
		return
	}
	added := int64(0)
	if len(rows) > 0 {
		added = toInt64(rows[0]["added"])
	}
	detail := fmt.Sprintf("%d new alias(es)", added)
	if total, err := db.PGQuery(ctx, `
		SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE NOT reviewed) AS unreviewed
		  FROM app.merchant_alias`); err == nil && len(total) > 0 {
		detail = fmt.Sprintf("%d new · %d total · %d awaiting review",
			added, toInt64(total[0]["total"]), toInt64(total[0]["unreviewed"]))
	}
	WorkerBeat(ctx, db, "merchant_alias", "ok", detail, "")
	slog.Info("merchant alias refresh ok", "added", added)
}
