package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterSettlementOverview serves the module landing page: the CCS master and
// both payment providers side by side for one period.
//
// The shape follows the actual business model rather than the old screen layout:
// CCS (O3 CMS) is the master ledger; Interswitch and Paystack are payment
// providers whose activity must roll up to it. Each block reports its own volume
// AND its coverage, because a provider with no data loaded is a very different
// situation from a provider with nothing to settle — and the old page could not
// tell those apart.
func RegisterSettlementOverview(r chi.Router, db *core.DB) {
	r.With(core.RequirePages("settlement", "reconciliation")).
		Get("/overview3", settlementOverview3(db))
}

func settlementOverview3(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, _ := validDate(r, "date_from")
		to, _ := validDate(r, "date_to")
		if from == "" || to == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}
		ctx := r.Context()
		out := map[string]any{"period": map[string]string{"from": from, "to": to}}

		// ── CCS master: the four routes, by transaction code ────────────────────
		ccsRoutes, _ := db.PGQuery(ctx, `
			SELECT
			  CASE txn_code
			    WHEN '300' THEN 'ATM'  WHEN '200' THEN 'POS'  WHEN '202' THEN 'POS'
			    WHEN '303' THEN 'WEB'  WHEN '423' THEN 'TRANSFER_OUT'
			    WHEN '422' THEN 'TRANSFER_IN' WHEN '402' THEN 'CASH_PAYMENT'
			    ELSE 'OTHER' END                       AS route,
			  COUNT(*)                                 AS txns,
			  COALESCE(SUM(amount_kobo),0)             AS value_kobo,
			  COUNT(*) FILTER (WHERE sign='DR')        AS debits,
			  COUNT(*) FILTER (WHERE sign='CR')        AS credits
			FROM ccs_transactions
			WHERE txn_date BETWEEN $1::date AND $2::date
			GROUP BY 1 ORDER BY txns DESC`, from, to)
		if ccsRoutes == nil {
			ccsRoutes = []map[string]any{}
		}

		ccsTotals, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) txns,
			       COALESCE(SUM(amount_kobo) FILTER (WHERE sign='DR'),0) AS debit_kobo,
			       COALESCE(SUM(amount_kobo) FILTER (WHERE sign='CR'),0) AS credit_kobo,
			       COUNT(DISTINCT txn_date)     AS days_with_data,
			       MIN(txn_date)                AS first_day,
			       MAX(txn_date)                AS last_day
			FROM ccs_transactions
			WHERE txn_date BETWEEN $1::date AND $2::date`, from, to)
		out["ccs"] = map[string]any{
			"routes": ccsRoutes,
			"totals": firstRowOr(ccsTotals),
		}

		// ── Interswitch provider: by channel, legs collapsed ────────────────────
		iswChannels, _ := db.PGQuery(ctx, `
			SELECT report_family AS channel,
			       COUNT(*)                          AS txns,
			       COALESCE(SUM(ABS(gross_kobo)),0)  AS value_kobo,
			       COALESCE(SUM(fees_kobo),0)        AS fees_kobo,
			       COALESCE(SUM(legs_n),0)           AS legs
			FROM interswitch_transactions
			WHERE settlement_date BETWEEN $1::date AND $2::date
			GROUP BY 1 ORDER BY txns DESC`, from, to)
		if iswChannels == nil {
			iswChannels = []map[string]any{}
		}
		iswTotals, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) txns,
			       COALESCE(SUM(ABS(gross_kobo)),0) AS value_kobo,
			       COALESCE(SUM(fees_kobo),0)       AS fees_kobo,
			       COALESCE(SUM(legs_n),0)          AS legs,
			       COUNT(DISTINCT settlement_date)  AS days_with_data
			FROM interswitch_transactions
			WHERE settlement_date BETWEEN $1::date AND $2::date`, from, to)
		out["interswitch"] = map[string]any{
			"channels": iswChannels,
			"totals":   firstRowOr(iswTotals),
		}

		// ── Paystack provider: in, out, settled, failures ───────────────────────
		psTotals, _ := db.PGQuery(ctx, `
			SELECT
			  (SELECT COUNT(*) FROM paystack_transactions
			     WHERE status='success' AND created_at_ps::date BETWEEN $1::date AND $2::date) AS funding_n,
			  (SELECT COALESCE(SUM(amount_kobo),0) FROM paystack_transactions
			     WHERE status='success' AND created_at_ps::date BETWEEN $1::date AND $2::date) AS funding_kobo,
			  (SELECT COUNT(*) FROM paystack_transactions
			     WHERE status IN ('failed','abandoned') AND created_at_ps::date BETWEEN $1::date AND $2::date) AS funding_lost_n,
			  (SELECT COUNT(*) FROM paystack_transfers
			     WHERE status='success' AND created_at_ps::date BETWEEN $1::date AND $2::date) AS transfer_n,
			  (SELECT COALESCE(SUM(amount_kobo),0) FROM paystack_transfers
			     WHERE status='success' AND created_at_ps::date BETWEEN $1::date AND $2::date) AS transfer_kobo,
			  (SELECT COUNT(*) FROM paystack_transfers
			     WHERE status IN ('failed','reversed') AND created_at_ps::date BETWEEN $1::date AND $2::date) AS transfer_failed_n,
			  (SELECT COALESCE(SUM(total_amount_kobo),0) FROM paystack_settlements
			     WHERE status='success' AND settlement_date::date BETWEEN $1::date AND $2::date) AS settled_kobo,
			  (SELECT COUNT(*) FROM paystack_disputes WHERE status IS DISTINCT FROM 'resolved') AS open_disputes`,
			from, to)

		psChannels, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(channel,''),'unknown') AS channel,
			       COUNT(*) attempts,
			       COUNT(*) FILTER (WHERE status='success') success,
			       COALESCE(SUM(amount_kobo) FILTER (WHERE status='success'),0) AS value_kobo,
			       ROUND(100.0*COUNT(*) FILTER (WHERE status='success')/NULLIF(COUNT(*),0),1) AS completion_pct
			FROM paystack_transactions
			WHERE created_at_ps::date BETWEEN $1::date AND $2::date
			GROUP BY 1 ORDER BY attempts DESC`, from, to)
		if psChannels == nil {
			psChannels = []map[string]any{}
		}
		out["paystack"] = map[string]any{
			"totals":   firstRowOr(psTotals),
			"channels": psChannels,
		}

		// ── The link: how much of each provider ties back to the CCS master ─────
		// CCS<->Interswitch joins on STAN (CCS stores it unpadded, Interswitch
		// zero-padded to 6). CCS<->Paystack has NO shared key in the CCS EODTXN
		// report, so it is reported as unlinkable rather than guessed at.
		link, _ := db.PGQuery(ctx, `
			WITH isw AS (
			  SELECT DISTINCT ON (rrn) rrn, stan, settlement_date
			  FROM interswitch_transactions
			  WHERE settlement_date BETWEEN $1::date AND $2::date AND stan <> ''
			  ORDER BY rrn
			)
			SELECT COUNT(*) AS isw_txns,
			       COUNT(*) FILTER (WHERE EXISTS (
			         SELECT 1 FROM ccs_transactions c
			         WHERE LPAD(c.trace_num,6,'0') = LPAD(isw.stan,6,'0')
			           AND c.txn_date BETWEEN isw.settlement_date - 3 AND isw.settlement_date
			       )) AS matched_to_ccs
			FROM isw`, from, to)
		linkRow := firstRowOr(link)
		linkRow["paystack_linkable"] = false
		linkRow["paystack_note"] = "CCS Report 620 carries no transfer reference, so Paystack cannot be matched to the master until the CCS repo exposes one."
		out["link"] = linkRow

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out) //nolint:errcheck
	}
}

func firstRowOr(rows []map[string]any) map[string]any {
	if len(rows) > 0 {
		return rows[0]
	}
	return map[string]any{}
}
