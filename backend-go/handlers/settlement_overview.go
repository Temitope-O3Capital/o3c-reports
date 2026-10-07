package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
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

		// ── The four channels, as Card Operations reports them ──────────────────
		//
		// This is the shape of the published Half-Year Transaction Report: ATM, POS,
		// WEB and TRANSFER, each with its share and monthly average. The module's
		// own blocks are organised by SOURCE (master, then each provider), which is
		// right for reconciling but is not the language the business reads its own
		// numbers in — so the front door carries both.
		//
		// TRANSFER is the column that cannot come from the card ledger: it is mobile
		// app transfers, from Paystack, and it was 71.37% of the H1 2026 report. The
		// other three are CCS categories (300 cash advance, 200/202 purchase,
		// 303 web). Mixing feeds in one table is deliberate and is why the figures
		// agree with the report; ccs_rows and ps_rows say which sides were present,
		// so a zero can be told from a gap.
		chRows, _ := db.PGQuery(ctx, `
			WITH p AS (SELECT $1::date AS f, $2::date AS t),
			ccs AS (
			  SELECT COALESCE(SUM(x.amount_kobo) FILTER (WHERE c.category = 'cash_advance'), 0) AS atm,
			         COALESCE(SUM(x.amount_kobo) FILTER (WHERE c.category = 'purchase'),     0) AS pos,
			         COALESCE(SUM(x.amount_kobo) FILTER (WHERE c.category = 'utility'),      0) AS web,
			         COUNT(*) AS n
			  FROM ccs_transactions x CROSS JOIN p
			  LEFT JOIN app.card_txn_codes c ON c.code = x.txn_code
			  WHERE x.sign = 'DR'
			    AND NOT (upper(COALESCE(x.currency,'')) IN ('USD','840')
			             OR COALESCE(x.product_name,'') ILIKE '%USD%')
			    AND x.txn_date BETWEEN p.f AND p.t
			),
			ps AS (
			  SELECT COALESCE(SUM(t.amount_kobo), 0) AS transfer, COUNT(*) AS n
			  FROM paystack_transfers t CROSS JOIN p
			  WHERE t.status = 'success' AND t.created_at_ps::date BETWEEN p.f AND p.t
			),
			mo AS (
			  SELECT GREATEST(1, (DATE_PART('year', p.t) * 12 + DATE_PART('month', p.t))
			                   - (DATE_PART('year', p.f) * 12 + DATE_PART('month', p.f)) + 1)::int AS months
			  FROM p
			)
			SELECT ccs.atm, ccs.pos, ccs.web, ps.transfer,
			       (ccs.atm + ccs.pos + ccs.web + ps.transfer) AS total,
			       mo.months, ccs.n AS ccs_rows, ps.n AS ps_rows
			FROM ccs, ps, mo`, from, to)
		out["channels"] = firstRowOr(chRows)

		// ── Feed coverage: can this period be reconciled at all? ────────────────
		//
		// The first question a settlement officer needs answered is not "does it tie
		// out" but "is everything here yet". Reconciling a day one side has not sent
		// produces breaks that look like missing money, and the module had no surface
		// that said so: CCS's real book ends 2025-12-31, the Interswitch uploads stop
		// 2026-07-01, and only Paystack is live to today. Three feeds, three
		// different horizons, and the page reported a single tie-out percentage over
		// all of it.
		//
		// days_in_period against the period's own length is what exposes a partial
		// feed; last_day is reported across the whole table, so a feed that stopped
		// before the period even began says when it stopped rather than just "0".
		feeds, _ := db.PGQuery(ctx, `
			WITH p AS (SELECT $1::date AS f, $2::date AS t)
			SELECT 'ccs' AS src, 'CCS Master' AS label, 'master' AS role,
			       COUNT(*) FILTER (WHERE c.txn_date BETWEEN p.f AND p.t)                     AS rows_in_period,
			       COUNT(DISTINCT c.txn_date) FILTER (WHERE c.txn_date BETWEEN p.f AND p.t)    AS days_in_period,
			       MAX(c.txn_date)                                                            AS last_day
			FROM ccs_transactions c CROSS JOIN p GROUP BY p.f, p.t
			UNION ALL
			SELECT 'interswitch', 'Interswitch', 'provider',
			       COUNT(*) FILTER (WHERE i.settlement_date BETWEEN p.f AND p.t),
			       COUNT(DISTINCT i.settlement_date) FILTER (WHERE i.settlement_date BETWEEN p.f AND p.t),
			       MAX(i.settlement_date)
			FROM interswitch_legs i CROSS JOIN p GROUP BY p.f, p.t
			UNION ALL
			SELECT 'paystack', 'Paystack', 'provider',
			       COUNT(*) FILTER (WHERE x.d BETWEEN p.f AND p.t),
			       COUNT(DISTINCT x.d) FILTER (WHERE x.d BETWEEN p.f AND p.t),
			       MAX(x.d)
			FROM (SELECT created_at_ps::date AS d FROM paystack_transactions
			      UNION ALL SELECT created_at_ps::date FROM paystack_transfers) x
			CROSS JOIN p GROUP BY p.f, p.t`, from, to)
		if feeds == nil {
			feeds = []map[string]any{}
		}
		out["feeds"] = feeds

		// ── The link: how much of each provider ties back to the CCS master ─────
		// CCS<->Interswitch joins on STAN (CCS stores it unpadded, Interswitch
		// zero-padded to 6). CCS<->Paystack has NO shared key in the CCS EODTXN
		// report, so it is reported as unlinkable rather than guessed at.
		//
		// Anchored on local_datetime, NOT settlement_date, so this figure means the
		// same thing the reconciliation engine means. Interswitch settles T+1:
		// matching on settlement_date resolves 1 transaction in 4,275, and on the
		// transaction's own date 2,746 — see recon/engine.go, interswitchCCSSpec.
		// Reading one anchor here and another in the engine is how a landing page
		// comes to contradict the run it links to.
		//
		// no_master_data is reported alongside, because "did not tie out" and "the
		// master ledger has nothing for those days" are different sentences and only
		// one of them is a settlement problem. Over the book as loaded that is 1,294
		// of 4,252 — the CCS feed stops at 2025-12-31 while the uploads run to
		// 2026-07, so a coverage figure that hid it would read as a 35% break rate.
		link, _ := db.PGQuery(ctx, `
			WITH isw AS (
			  SELECT LPAD(stan, 6, '0')     AS stan,
			         local_datetime::date   AS txn_date
			  FROM interswitch_transactions
			  WHERE local_datetime::date BETWEEN $1::date AND $2::date AND stan <> ''
			)
			SELECT COUNT(*) AS isw_txns,
			       COUNT(*) FILTER (WHERE EXISTS (
			         SELECT 1 FROM ccs_transactions c
			         WHERE LPAD(c.trace_num,6,'0') = isw.stan
			           AND c.txn_date BETWEEN isw.txn_date - 3 AND isw.txn_date + 3
			       )) AS matched_to_ccs,
			       COUNT(*) FILTER (WHERE NOT EXISTS (
			         SELECT 1 FROM ccs_transactions c
			         WHERE c.txn_date BETWEEN isw.txn_date - 3 AND isw.txn_date + 3
			       )) AS no_master_data
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
