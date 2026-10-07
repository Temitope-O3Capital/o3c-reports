package handlers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// RegisterInterswitch adds /api/cards/interswitch routes. The parent router
// already requires the settlement/cards page; ingest is restricted further —
// importing an EOD file rewrites the card transaction feed.
func RegisterInterswitch(r chi.Router, db *core.DB) {
	r.Get("/summary", interswitchSummary(db))
	r.Get("/half-year", interswitchReport(db))
	r.With(core.RequirePages("uploads", "settlement")).Post("/import", interswitchImport(db))
}

// ── Summary ────────────────────────────────────────────────────────────────────

// iswPeriodWhere maps the frontend period id to a SQL date predicate on txn_date.
// Whitelisted — never interpolates user input into SQL.
//
// Periods anchor to the latest DENSE month of data (not today's date, and not a raw
// MAX(txn_date) — which a handful of mis-dated outlier rows could skew). This makes the
// dashboard always land on the real bulk of data (e.g. a historical 2025 load) instead
// of an empty current period. Falls back to CURRENT_DATE when the table is empty.
func iswPeriodWhere(period string) string {
	ref := `COALESCE((
		SELECT MAX(txn_date) FROM interswitch_txns
		WHERE DATE_TRUNC('month', txn_date) IN (
			SELECT DATE_TRUNC('month', txn_date) FROM interswitch_txns
			GROUP BY 1 HAVING COUNT(*) >= 100
		)
	), CURRENT_DATE)`
	// Each window is bounded ABOVE at the anchor too, so stray future-dated outlier rows
	// are excluded and report_date reflects the anchor.
	switch strings.ToLower(period) {
	case "l30d":
		return "txn_date BETWEEN " + ref + " - INTERVAL '30 days' AND " + ref
	case "l90d":
		return "txn_date BETWEEN " + ref + " - INTERVAL '90 days' AND " + ref
	case "ytd":
		return "txn_date >= DATE_TRUNC('year', " + ref + ") AND txn_date <= " + ref
	case "mtd":
		fallthrough
	default:
		return "txn_date >= DATE_TRUNC('month', " + ref + ") AND txn_date <= " + ref
	}
}

// iswChannelCase classifies a CCS transaction by what the customer actually did.
//
// It used to test txn_code IN ('01'..'05') for ATM, ('06'..'09') for POS and
// ('10'..'15') for WEB. Those codes do not exist in this feed. The real CCS codes
// are three digits — 303 utility, 423 web transfer out, 402 cash payment, 200
// purchase, 300 cash advance and so on — so every single one of the 50,115 rows
// in app.ccs_transactions fell through to ELSE. Channel Breakdown, Transaction
// Type and the stacked Daily Trend were all rendering one 100%-Transfer bar while
// looking perfectly populated.
//
// Measured over the 2026-09-12 dump, the honest distribution is:
//
//	transfer 14,058 · utility 12,431 · purchase 10,329 · payment 9,008 ·
//	fee 2,159 · cash_advance 2,043 · interest 85
//
// Classification now comes from app.card_txn_codes.category, which already maps
// every code the ledger contains, so a new code is picked up automatically
// instead of silently joining "Transfer". Requires iswChannelJoin and the `t`/`c`
// aliases. Code 420 (1 row) is absent from card_txn_codes and surfaces as Other
// rather than being quietly absorbed.
const iswChannelCase = `CASE c.category
		WHEN 'cash_advance' THEN 'ATM / cash'
		WHEN 'purchase'     THEN 'POS / purchase'
		WHEN 'transfer'     THEN 'Web transfer'
		WHEN 'utility'      THEN 'Bill payment'
		WHEN 'payment'      THEN 'Repayment'
		WHEN 'fee'          THEN 'Fees & interest'
		WHEN 'interest'     THEN 'Fees & interest'
		WHEN 'penalty'      THEN 'Fees & interest'
		ELSE 'Other'
	END`

// iswChannelJoin pairs with iswChannelCase: the classification lives in
// app.card_txn_codes, so any query using the CASE must join it.
const iswChannelJoin = `FROM interswitch_txns t
			LEFT JOIN app.card_txn_codes c ON c.code = t.txn_code`

// iswIsUSD marks a CCS row posted on a dollar card. CCS posts those amounts in US
// dollars — amount_kobo holds cents — confirmed 2026-09-14. Every total on the
// Interswitch pages used to sum them straight into naira, counting $1 as ₦1. The
// report's own currency column is the primary signal; the product name ("Amex
// USD") catches rows where that column is blank. Requires the `t` alias.
const iswIsUSD = `(upper(COALESCE(t.currency, '')) IN ('USD', '840') OR COALESCE(t.product_name, '') ILIKE '%USD%')`

// iswNairaDR selects what every naira volume figure sums: debits on naira cards.
const iswNairaDR = `t.sign = 'DR' AND NOT ` + iswIsUSD

// txnIsUSD is the in-memory twin of iswIsUSD, for aggregating parsed rows during import
// before they are persisted (there is no `t` alias to lean on there).
func txnIsUSD(t parsedTxn) bool {
	c := strings.ToUpper(strings.TrimSpace(t.Currency))
	return c == "USD" || c == "840" || strings.Contains(strings.ToUpper(t.ProductName), "USD")
}

func interswitchSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		where := iswPeriodWhere(r.URL.Query().Get("period"))

		// Headline totals. "Volume" follows the existing convention: debit (DR)
		// amounts. Every naira figure excludes dollar cards; those are totalled
		// separately, in cents, as usd_*.
		rows, err := db.PGQuery(ctx, `
			SELECT
				COUNT(*) FILTER (WHERE NOT `+iswIsUSD+`)                                   AS total_count,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE `+iswNairaDR+`), 0)              AS total_volume_kobo,
				COUNT(*) FILTER (WHERE `+iswNairaDR+`)                                     AS debit_count,
				COUNT(*) FILTER (WHERE t.sign = 'CR' AND NOT `+iswIsUSD+`)                 AS credit_count,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE t.sign = 'CR' AND NOT `+iswIsUSD+`), 0) AS credit_volume_kobo,
				COUNT(DISTINCT t.branch_code)                                              AS branch_count,
				COUNT(DISTINCT t.product_code)                                             AS product_count,
				MIN(t.txn_date)                                                            AS earliest_date,
				MAX(t.txn_date)                                                            AS latest_date,
				COUNT(*) FILTER (WHERE `+iswIsUSD+`)                                       AS usd_count,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE t.sign = 'DR' AND `+iswIsUSD+`), 0) AS usd_volume_cents,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE t.sign = 'CR' AND `+iswIsUSD+`), 0) AS usd_credit_cents
			FROM interswitch_txns t
			WHERE `+where)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total_count": 0, "total_volume_kobo": 0,
				"debit_count": 0, "credit_count": 0, "credit_volume_kobo": 0,
				"branch_count": 0, "product_count": 0,
				"usd_count": 0, "usd_volume_cents": 0, "usd_credit_cents": 0,
				"channel_breakdown": []any{}, "product_breakdown": []any{},
				"txn_type_breakdown": []any{}, "daily_trend": []any{}, "top_merchants": []any{},
				"usd_channel_breakdown": []any{},
				"data_available":        false,
			}, "pg")
			return
		}
		row := rows[0]
		totalVol := toInt64(row["total_volume_kobo"])

		// Channel breakdown ({channel, volume_kobo, count, pct}) — naira cards.
		chanRows, _ := db.PGQuery(ctx, `
			SELECT `+iswChannelCase+` AS channel,
				COUNT(*)                                                      AS count,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE t.sign = 'DR'), 0)  AS volume_kobo
			`+iswChannelJoin+`
			WHERE (`+where+`) AND NOT `+iswIsUSD+`
			GROUP BY 1
			ORDER BY volume_kobo DESC`)
		channel := make([]map[string]any, 0, len(chanRows))
		for _, cr := range chanRows {
			vol := toInt64(cr["volume_kobo"])
			channel = append(channel, map[string]any{
				"channel": str(cr["channel"]), "count": toInt64(cr["count"]),
				"volume_kobo": vol, "pct": pctOf(vol, totalVol),
			})
		}

		// Dollar-card activity by the same channels ({channel, volume_cents, count}).
		usdRows, _ := db.PGQuery(ctx, `
			SELECT `+iswChannelCase+` AS channel,
				COUNT(*)                                                      AS count,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE t.sign = 'DR'), 0)  AS volume_cents
			`+iswChannelJoin+`
			WHERE (`+where+`) AND `+iswIsUSD+`
			GROUP BY 1
			ORDER BY volume_cents DESC`)
		usdChannel := make([]map[string]any, 0, len(usdRows))
		for _, ur := range usdRows {
			usdChannel = append(usdChannel, map[string]any{
				"channel": str(ur["channel"]), "count": toInt64(ur["count"]),
				"volume_cents": toInt64(ur["volume_cents"]),
			})
		}

		// Product breakdown ({product, volume_kobo, count}) — naira cards.
		prodRows, _ := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(t.product_name, ''), t.product_code, 'Unknown') AS product,
				COUNT(*)                                                      AS count,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE t.sign = 'DR'), 0)  AS volume_kobo
			FROM interswitch_txns t
			WHERE (`+where+`) AND NOT `+iswIsUSD+`
			GROUP BY 1
			ORDER BY volume_kobo DESC`)
		products := make([]map[string]any, 0, len(prodRows))
		for _, pr := range prodRows {
			products = append(products, map[string]any{
				"product": str(pr["product"]), "count": toInt64(pr["count"]),
				"volume_kobo": toInt64(pr["volume_kobo"]),
			})
		}

		// Transaction type breakdown ({type, count, volume_kobo}) — keyed on channel classification.
		typeRows, _ := db.PGQuery(ctx, `
			SELECT `+iswChannelCase+` AS type,
				COUNT(*)                                                      AS count,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE t.sign = 'DR'), 0)  AS volume_kobo
			`+iswChannelJoin+`
			WHERE (`+where+`) AND NOT `+iswIsUSD+`
			GROUP BY 1
			ORDER BY count DESC`)
		types := make([]map[string]any, 0, len(typeRows))
		for _, tr := range typeRows {
			types = append(types, map[string]any{
				"type": str(tr["type"]), "count": toInt64(tr["count"]),
				"volume_kobo": toInt64(tr["volume_kobo"]),
			})
		}

		// Daily trend ({date, atm, pos, web, bills, repayment, fees}) — naira DR volume
		// per category per day. Same fix as iswChannelCase: the old version filtered on
		// txn_code IN ('01'..'15'), which matched nothing, so `transfer` carried 100%
		// of every day's volume and the other three series were flat zero.
		trendRows, _ := db.PGQuery(ctx, `
			SELECT TO_CHAR(t.txn_date, 'YYYY-MM-DD') AS date,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE c.category = 'cash_advance' AND t.sign = 'DR'), 0) AS atm,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE c.category = 'purchase'     AND t.sign = 'DR'), 0) AS pos,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE c.category = 'transfer'     AND t.sign = 'DR'), 0) AS web,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE c.category = 'utility'      AND t.sign = 'DR'), 0) AS bills,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE c.category = 'payment'      AND t.sign = 'DR'), 0) AS repayment,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE c.category IN ('fee','interest','penalty') AND t.sign = 'DR'), 0) AS fees
			`+iswChannelJoin+`
			WHERE (`+where+`) AND NOT `+iswIsUSD+`
			GROUP BY t.txn_date
			ORDER BY t.txn_date`)
		trend := make([]map[string]any, 0, len(trendRows))
		for _, dr := range trendRows {
			trend = append(trend, map[string]any{
				"date": str(dr["date"]), "atm": toInt64(dr["atm"]), "pos": toInt64(dr["pos"]),
				"web": toInt64(dr["web"]), "bills": toInt64(dr["bills"]),
				"repayment": toInt64(dr["repayment"]), "fees": toInt64(dr["fees"]),
			})
		}

		// Top merchants ({name, volume_kobo, count}) — top 10 naira purchases by DR
		// volume. Purchases only: on other codes merchant_name holds a transfer
		// narrative, the staff member who posted a payment, or an ATM location, and
		// those used to rank as merchants. app.clean_merchant (migration 244) folds
		// the feed's truncated spellings of one merchant into a single row.
		merchRows, _ := db.PGQuery(ctx, `
			SELECT COALESCE(app.clean_merchant(t.merchant_name), NULLIF(t.merchant_id, ''), 'Unknown') AS name,
				COUNT(*)                                                      AS count,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE t.sign = 'DR'), 0)  AS volume_kobo
			FROM interswitch_txns t
			JOIN app.card_txn_codes c ON c.code = t.txn_code AND c.category = 'purchase'
			WHERE (`+where+`) AND NOT `+iswIsUSD+`
			GROUP BY 1
			ORDER BY volume_kobo DESC
			LIMIT 10`)
		merchants := make([]map[string]any, 0, len(merchRows))
		for _, mr := range merchRows {
			merchants = append(merchants, map[string]any{
				"name": str(mr["name"]), "count": toInt64(mr["count"]),
				"volume_kobo": toInt64(mr["volume_kobo"]),
			})
		}

		reportDate := ""
		if d, ok := row["latest_date"].(time.Time); ok {
			reportDate = d.Format("2006-01-02")
		}

		respond(w, map[string]any{
			"report_date":           reportDate,
			"total_count":           toInt64(row["total_count"]),
			"total_volume_kobo":     totalVol,
			"debit_count":           toInt64(row["debit_count"]),
			"credit_count":          toInt64(row["credit_count"]),
			"credit_volume_kobo":    toInt64(row["credit_volume_kobo"]),
			"branch_count":          toInt64(row["branch_count"]),
			"product_count":         toInt64(row["product_count"]),
			"earliest_date":         row["earliest_date"],
			"latest_date":           row["latest_date"],
			"usd_count":             toInt64(row["usd_count"]),
			"usd_volume_cents":      toInt64(row["usd_volume_cents"]),
			"usd_credit_cents":      toInt64(row["usd_credit_cents"]),
			"channel_breakdown":     channel,
			"usd_channel_breakdown": usdChannel,
			"product_breakdown":     products,
			"txn_type_breakdown":    types,
			"daily_trend":           trend,
			"top_merchants":         merchants,
			"data_available":        true,
		}, "pg")
	}
}

// ── Transaction Report ─────────────────────────────────────────────────────────

// THE HALF-YEAR TRANSACTION REPORT, as Card Operations actually publishes it.
//
// Their report is four channels — ATM, POS, WEB, TRANSFER — a month per row, and
// a second table giving each channel's share and monthly average. H1 2026 came to
// ₦1,152,328,603.86 with TRANSFER at 71.37% of it. That shape is reproduced here
// exactly, because it is the document that gets sent out.
//
// WHERE EACH CHANNEL COMES FROM. The four columns are not one feed, which is why
// earlier attempts to serve this from a single table could never match it:
//
//	ATM       ccs_transactions, category cash_advance (code 300)
//	POS       ccs_transactions, category purchase     (codes 200, 202)
//	WEB       ccs_transactions, category utility      (code 303)
//	TRANSFER  paystack_transfers, status success — the MOBILE APP rail, not a card
//	          transaction at all
//
// TRANSFER was the column nobody could source. It is Paystack, and the match is
// exact: January ₦55,154,030.00, February ₦63,714,686.92 and April ₦95,336,116.55
// agree with the published report to the kobo, and May's ₦425m spike is the LIRS
// collection their narrative calls out. The previous implementation carried that
// column as "Other" because it could not be attributed.
//
// WHAT THIS CANNOT DO, and says so instead of guessing. The CCS feed stops at
// 2025-12-31, so for H1 2026 the three card columns have no source and come back
// zero with coverage marked incomplete. The report cannot be regenerated from the
// platform for that period — it was produced against the live CMS, which we no
// longer receive. Reporting zeros silently would restate a ₦1.15bn report as
// ₦822m, so every channel carries its own source and coverage and the page refuses
// to present a partial period as a total.
var iswReportChannels = []struct {
	Key, Label, Source, Note string
}{
	{"atm", "ATM", "ccs", "Cash advance at an ATM (CCS code 300)"},
	{"pos", "POS", "ccs", "Card purchases, local and foreign (CCS codes 200, 202)"},
	{"web", "WEB", "ccs", "Web channel payments (CCS code 303)"},
	{"transfer", "TRANSFER", "paystack", "Mobile app transfers out, successful only"},
}

// iswPeriodMonths maps a period id to its 1-based inclusive month range.
var iswPeriodMonths = map[string][2]int{
	"H1": {1, 6}, "H2": {7, 12}, "FY": {1, 12},
	"Q1": {1, 3}, "Q2": {4, 6}, "Q3": {7, 9}, "Q4": {10, 12},
}

// iswReportMonth is one row of the monthly table. Every figure is KOBO.
type iswReportMonth struct {
	Month    string `json:"month"`     // "January"
	Short    string `json:"short"`     // "Jan"
	ATM      int64  `json:"atm"`
	POS      int64  `json:"pos"`
	WEB      int64  `json:"web"`
	Transfer int64  `json:"transfer"`
	Total    int64  `json:"total"`
	// CCSRows is how many master-ledger rows backed the three card columns. Zero
	// means those columns are unsourced for the month, not that nothing happened.
	CCSRows int64 `json:"ccs_rows"`
	PSRows  int64 `json:"ps_rows"`
}

func interswitchReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		year := r.URL.Query().Get("year")
		period := strings.ToUpper(r.URL.Query().Get("period"))
		if year == "" {
			year = strconv.Itoa(time.Now().Year())
		}
		yr, err := strconv.Atoi(year)
		if err != nil || yr < 2000 || yr > 2200 {
			respondErr(w, 422, "year must be a four-digit year")
			return
		}
		rng, ok := iswPeriodMonths[period]
		if !ok {
			period, rng = "H1", iswPeriodMonths["H1"]
		}

		from := time.Date(yr, time.Month(rng[0]), 1, 0, 0, 0, 0, time.UTC)
		// Exclusive upper bound: the first day of the month after the last one.
		toExcl := time.Date(yr, time.Month(rng[1]), 1, 0, 0, 0, 0, time.UTC).AddDate(0, 1, 0)
		fromS, toS := from.Format("2006-01-02"), toExcl.Format("2006-01-02")

		ctx := r.Context()

		// One row per month in the period whether or not either side has data —
		// generate_series drives the rows, so a month with nothing still appears
		// with a zero rather than vanishing from the table. The old version let the
		// GROUP BY decide, so a period with no rows produced a nil slice, serialised
		// as "months": null, and the page died on null.reduce().
		rows, qErr := db.PGQuery(ctx, `
			WITH mo AS (
			  SELECT generate_series($1::date, ($2::date - INTERVAL '1 day')::date, '1 month')::date AS m
			),
			ccs AS (
			  SELECT date_trunc('month', t.txn_date)::date AS m,
			         COALESCE(SUM(t.amount_kobo) FILTER (WHERE c.category = 'cash_advance'), 0) AS atm,
			         COALESCE(SUM(t.amount_kobo) FILTER (WHERE c.category = 'purchase'),     0) AS pos,
			         COALESCE(SUM(t.amount_kobo) FILTER (WHERE c.category = 'utility'),      0) AS web,
			         COUNT(*) AS n
			  FROM ccs_transactions t
			  LEFT JOIN app.card_txn_codes c ON c.code = t.txn_code
			  -- Debits on naira cards only. CCS posts dollar cards in dollars, so
			  -- including them would count $1 as ₦1.
			  WHERE ` + iswNairaDR + `
			    AND t.txn_date >= $1::date AND t.txn_date < $2::date
			  GROUP BY 1
			),
			ps AS (
			  SELECT date_trunc('month', created_at_ps)::date AS m,
			         COALESCE(SUM(amount_kobo), 0) AS transfer,
			         COUNT(*) AS n
			  FROM paystack_transfers
			  WHERE status = 'success'
			    AND created_at_ps >= $1::date AND created_at_ps < $2::date
			  GROUP BY 1
			)
			SELECT TO_CHAR(mo.m, 'FMMonth')      AS month_name,
			       TO_CHAR(mo.m, 'Mon')          AS month_short,
			       COALESCE(ccs.atm, 0)          AS atm,
			       COALESCE(ccs.pos, 0)          AS pos,
			       COALESCE(ccs.web, 0)          AS web,
			       COALESCE(ps.transfer, 0)      AS transfer,
			       COALESCE(ccs.n, 0)            AS ccs_rows,
			       COALESCE(ps.n, 0)             AS ps_rows
			FROM mo
			LEFT JOIN ccs ON ccs.m = mo.m
			LEFT JOIN ps  ON ps.m  = mo.m
			ORDER BY mo.m`, fromS, toS)
		if qErr != nil {
			respondErrLog(w, 500, "Transaction report query failed", qErr)
			return
		}

		// Always a slice, never nil — see the note on the query above.
		months := make([]iswReportMonth, 0, 12)
		var totATM, totPOS, totWEB, totTRF, ccsRows, psRows int64
		for _, row := range rows {
			m := iswReportMonth{
				Month:    str(row["month_name"]),
				Short:    str(row["month_short"]),
				ATM:      toInt64(row["atm"]),
				POS:      toInt64(row["pos"]),
				WEB:      toInt64(row["web"]),
				Transfer: toInt64(row["transfer"]),
				CCSRows:  toInt64(row["ccs_rows"]),
				PSRows:   toInt64(row["ps_rows"]),
			}
			m.Total = m.ATM + m.POS + m.WEB + m.Transfer
			months = append(months, m)
			totATM += m.ATM
			totPOS += m.POS
			totWEB += m.WEB
			totTRF += m.Transfer
			ccsRows += m.CCSRows
			psRows += m.PSRows
		}

		grand := totATM + totPOS + totWEB + totTRF
		n := int64(len(months))
		if n == 0 {
			n = 1 // only reachable on a malformed range; keeps the averages finite
		}

		// Channel table: total, share and monthly average — their second table,
		// column for column.
		perChannel := make([]map[string]any, 0, len(iswReportChannels))
		sums := map[string]int64{"atm": totATM, "pos": totPOS, "web": totWEB, "transfer": totTRF}
		for _, ch := range iswReportChannels {
			v := sums[ch.Key]
			pct := 0.0
			if grand > 0 {
				pct = math.Round(float64(v)/float64(grand)*10000) / 100
			}
			sourced := ch.Source == "paystack" || ccsRows > 0
			perChannel = append(perChannel, map[string]any{
				"key":        ch.Key,
				"label":      ch.Label,
				"total_kobo": v,
				"pct":        pct,
				"avg_kobo":   v / n,
				"source":     ch.Source,
				"note":       ch.Note,
				"sourced":    sourced,
			})
		}

		// Per-feed coverage for the period, so the page can say WHY a column is
		// empty. days_in_period against the month count is what exposes a feed that
		// stopped partway.
		cov, _ := db.PGQuery(ctx, `
			SELECT 'ccs' AS src,
			       COUNT(*)                                      AS rows_in_period,
			       COUNT(DISTINCT txn_date)                       AS days_in_period,
			       (SELECT MAX(txn_date) FROM ccs_transactions)   AS last_day
			FROM ccs_transactions
			WHERE txn_date >= $1::date AND txn_date < $2::date
			UNION ALL
			SELECT 'paystack',
			       COUNT(*),
			       COUNT(DISTINCT created_at_ps::date),
			       (SELECT MAX(created_at_ps)::date FROM paystack_transfers)
			FROM paystack_transfers
			WHERE status = 'success'
			  AND created_at_ps >= $1::date AND created_at_ps < $2::date`, fromS, toS)
		if cov == nil {
			cov = []core.Row{}
		}

		// The honesty flag the page leads on. A total that silently omits three of
		// four channels is not a smaller total, it is a wrong one.
		complete := ccsRows > 0 && psRows > 0
		note := ""
		switch {
		case ccsRows == 0 && psRows == 0:
			note = "Neither the CCS master nor Paystack holds anything for this period."
		case ccsRows == 0:
			note = "The CCS master holds no transactions for this period, so ATM, POS and WEB cannot be " +
				"sourced — only TRANSFER is real. The CCS feed stops at 2025-12-31. This report was " +
				"originally produced against the live card system, which the platform no longer receives."
		case psRows == 0:
			note = "Paystack holds no successful transfers for this period, so the TRANSFER column is empty."
		}

		respond(w, map[string]any{
			"data": map[string]any{
				"period_label": fmt.Sprintf("%s %s", period, year),
				"period":       period,
				"year":         year,
				"from":         fromS,
				"to":           toExcl.AddDate(0, 0, -1).Format("2006-01-02"),
				"generated_at": time.Now().Format("2006-01-02"),
				"months":       months,
				"channels":     perChannel,
				"totals": map[string]any{
					"total_kobo":       grand,
					"avg_monthly_kobo": grand / n,
					"months_n":         len(months),
					"atm":              totATM,
					"pos":              totPOS,
					"web":              totWEB,
					"transfer":         totTRF,
				},
				"coverage": cov,
				"complete": complete,
				"note":     note,
			},
		}, "ok")
	}
}
// ── EODTXN Import ──────────────────────────────────────────────────────────────

type parsedTxn struct {
	TraceNum     string    `json:"trace_num"`
	AuthNum      string    `json:"auth_num"`
	CardNum      string    `json:"card_num"`
	TxnCode      string    `json:"txn_code"`
	TxnDate      time.Time `json:"txn_date"`
	MerchantID   string    `json:"merchant_id"`
	AmountKobo   int64     `json:"amount_kobo"`
	Sign         string    `json:"sign"`
	Currency     string    `json:"currency"`
	MerchantName string    `json:"merchant_name"`
	Description  string    `json:"description"`
	AccountNo    string    `json:"account_no"`
	CIF          string    `json:"cif"`
	ProductCode  string    `json:"product_code"`
	ProductName  string    `json:"product_name"`
	BranchCode   string    `json:"branch_code"`
	BranchName   string    `json:"branch_name"`
}

type importSummary struct {
	FilesProcessed       int          `json:"files_processed"`
	TransactionsImported int          `json:"transactions_imported"`
	TotalVolumeKobo      int64        `json:"total_volume_kobo"`
	Branches             []branchSum  `json:"branches"`
	Products             []productSum `json:"products"`
	Errors               []string     `json:"errors"`
}

type branchSum struct {
	Branch     string `json:"branch"`
	TxnCount   int    `json:"txn_count"`
	VolumeKobo int64  `json:"volume_kobo"`
}
type productSum struct {
	Product  string `json:"product"`
	TxnCount int    `json:"txn_count"`
}

// CCS Report 620 line patterns
var (
	reBranch  = regexp.MustCompile(`(?i)BRANCH\s+Number\s*:\s*(\d+)\s+-\s+(.+)`)
	reProduct = regexp.MustCompile(`(?i)Account\s+Product\s+Number\s*:\s*(\d+)\s+\(([^)]+)\)`)
	reAccount = regexp.MustCompile(`(?i)Account\s+No\.\s*:\s*(\S+)\s+CIF\s*:\s+(\S+)`)
	reTxn     = regexp.MustCompile(`^\s*(\d+)\s+(\d{6})?\s*([\w*]+)?\s+(\d{3})\s+(\d{2}/\d{2}/\d{4})\s*(\S+)?\s+([\d,]+\.\d{2})\s+(DR|CR)\s+(\w+)\s*(.*?)\s*$`)
	reSpaces  = regexp.MustCompile(`\s{2,}`)
)

func interswitchImport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			http.Error(w, "failed to parse multipart form", http.StatusBadRequest)
			return
		}

		var (
			allTxns   []parsedTxn
			parseErrs []string
			fileCount int
		)

		for _, fh := range r.MultipartForm.File["files"] {
			fileCount++
			f, err := fh.Open()
			if err != nil {
				parseErrs = append(parseErrs, fmt.Sprintf("%s: open error: %v", fh.Filename, err))
				continue
			}
			txns, errs := parseEODTXN(f, fh.Filename)
			f.Close()
			allTxns = append(allTxns, txns...)
			parseErrs = append(parseErrs, errs...)
		}

		// Aggregate
		branchMap := map[string]*branchSum{}
		productMap := map[string]*productSum{}
		var totalKobo int64
		// Insert outcomes. The INSERT below used to carry //nolint:errcheck, so a row
		// that failed to persist vanished without trace while the response reported
		// it as imported. Now every failure is counted, surfaced and recorded.
		var insertedN, duplicateN, insertFailed int
		var insertErrs []string

		for _, t := range allTxns {
			// TotalVolumeKobo and branch volume are NAIRA figures. CCS posts dollar-card
			// amounts in US cents, so a USD row must not be added into a kobo total (the
			// same $1 = ₦1 conflation the report endpoints already avoid via iswIsUSD).
			nairaDR := t.Sign == "DR" && !txnIsUSD(t)
			if nairaDR {
				totalKobo += t.AmountKobo
			}

			bk := fmt.Sprintf("%s - %s", t.BranchCode, t.BranchName)
			if branchMap[bk] == nil {
				branchMap[bk] = &branchSum{Branch: bk}
			}
			branchMap[bk].TxnCount++
			if nairaDR {
				branchMap[bk].VolumeKobo += t.AmountKobo
			}

			pk := fmt.Sprintf("%s (%s)", t.ProductName, t.ProductCode)
			if productMap[pk] == nil {
				productMap[pk] = &productSum{Product: pk}
			}
			productMap[pk].TxnCount++
		}

		var branches []branchSum
		for _, v := range branchMap {
			branches = append(branches, *v)
		}
		var products []productSum
		for _, v := range productMap {
			products = append(products, *v)
		}

		// Persist parsed transactions in one transaction so a batch lands whole or not at
		// all (a mid-file failure previously left a partial import, which the operator would
		// then re-upload — doubling the half already saved). ON CONFLICT targets the natural
		// key (migration 255) so a re-upload of the same CCS Report 620 is a genuine no-op.
		// The insert goes straight to the base table app.ccs_transactions, not the
		// interswitch_txns view, so it does not depend on the view staying auto-updatable.
		if len(allTxns) > 0 && db != nil {
			ctx := r.Context()
			tx, txErr := db.PG.BeginTx(ctx, nil)
			if txErr != nil {
				insertFailed = len(allTxns)
				insertErrs = append(insertErrs, fmt.Sprintf("could not begin import transaction: %v", txErr))
			} else {
				const insSQL = `INSERT INTO app.ccs_transactions
						(trace_num, auth_num, card_num, txn_code, txn_date, merchant_id,
						 amount_kobo, sign, currency, merchant_name, description,
						 account_no, cif, product_code, product_name, branch_code, branch_name)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
					 ON CONFLICT (trace_num, txn_date, branch_code, account_no, amount_kobo, sign, txn_code) DO NOTHING`
				for _, t := range allTxns {
					res, err := tx.ExecContext(ctx, insSQL,
						t.TraceNum, t.AuthNum, t.CardNum, t.TxnCode, t.TxnDate.Format("2006-01-02"),
						t.MerchantID, t.AmountKobo, t.Sign, t.Currency, t.MerchantName,
						t.Description, t.AccountNo, t.CIF, t.ProductCode, t.ProductName,
						t.BranchCode, t.BranchName)
					if err != nil {
						// One failed row aborts the transaction, so the whole batch rolls
						// back — record the culprit and stop rather than logging thousands
						// of "transaction is aborted" follow-on errors.
						insertFailed = len(allTxns)
						insertErrs = append(insertErrs, fmt.Sprintf("trace %s on %s: %v — no rows imported (batch rolled back)",
							t.TraceNum, t.TxnDate.Format("2006-01-02"), err))
						break
					}
					// ON CONFLICT DO NOTHING: zero rows affected is a re-upload of a
					// transaction already held, not a failure.
					if n, _ := res.RowsAffected(); n > 0 {
						insertedN += int(n)
					} else {
						duplicateN++
					}
				}
				if insertFailed > 0 {
					_ = tx.Rollback()
					insertedN, duplicateN = 0, 0
				} else if cErr := tx.Commit(); cErr != nil {
					_ = tx.Rollback()
					insertFailed = len(allTxns)
					insertedN, duplicateN = 0, 0
					insertErrs = append(insertErrs, fmt.Sprintf("commit failed — no rows imported: %v", cErr))
				}
			}
		}

		recordUpload(r.Context(), db, r, "ccs_eodtxn", uploadFileNames(r.MultipartForm.File["files"]), "",
			map[string]any{
				"files": fileCount, "parsed": len(allTxns), "inserted": insertedN,
				"duplicates": duplicateN, "insert_failed": insertFailed, "parse_errors": len(parseErrs),
			},
			len(allTxns)-insertFailed, insertFailed+len(parseErrs),
			append(append([]string{}, parseErrs...), insertErrs...))

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"data": importSummary{
				FilesProcessed:       fileCount,
				TransactionsImported: len(allTxns),
				TotalVolumeKobo:      totalKobo,
				Branches:             branches,
				Products:             products,
				Errors:               append(parseErrs, insertErrs...),
			},
		})
	}
}

// parseEODTXN reads a CCS Report 620 file and extracts all transactions.
func parseEODTXN(r io.Reader, filename string) ([]parsedTxn, []string) {
	var (
		txns                                                       []parsedTxn
		errs                                                       []string
		branchCode, branchName, prodCode, prodName, accountNo, cif string
	)

	scanner := bufio.NewScanner(r)
	lineNum := 0

	for scanner.Scan() {
		line := scanner.Text()
		lineNum++
		trimmed := strings.TrimSpace(line)

		if trimmed == "" || strings.HasPrefix(trimmed, "*") || strings.HasPrefix(trimmed, "=") {
			continue
		}

		if m := reBranch.FindStringSubmatch(line); m != nil {
			branchCode = strings.TrimSpace(m[1])
			branchName = strings.TrimSpace(m[2])
			accountNo, cif = "", ""
			continue
		}

		if m := reProduct.FindStringSubmatch(line); m != nil {
			prodCode = strings.TrimSpace(m[1])
			prodName = strings.TrimSpace(m[2])
			accountNo, cif = "", ""
			continue
		}

		if m := reAccount.FindStringSubmatch(line); m != nil {
			accountNo = strings.TrimSpace(m[1])
			cif = strings.TrimSpace(m[2])
			continue
		}

		// Transaction lines start with a digit (trace number)
		if len(trimmed) == 0 || !unicode.IsDigit(rune(trimmed[0])) {
			continue
		}

		m := reTxn.FindStringSubmatch(line)
		if m == nil {
			continue
		}

		date, err := time.Parse("02/01/2006", m[5])
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s:%d: bad date %q", filename, lineNum, m[5]))
			continue
		}

		amtStr := strings.ReplaceAll(m[7], ",", "")
		amtF, err := strconv.ParseFloat(amtStr, 64)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s:%d: bad amount %q", filename, lineNum, m[7]))
			continue
		}
		amtKobo := int64(math.Round(amtF * 100))

		merchant, desc := splitTrail(strings.TrimSpace(m[10]))

		txns = append(txns, parsedTxn{
			TraceNum: m[1], AuthNum: strings.TrimSpace(m[2]),
			CardNum: strings.TrimSpace(m[3]), TxnCode: m[4],
			TxnDate: date, MerchantID: strings.TrimSpace(m[6]),
			AmountKobo: amtKobo, Sign: m[8], Currency: m[9],
			MerchantName: merchant, Description: desc,
			AccountNo: accountNo, CIF: cif,
			ProductCode: prodCode, ProductName: prodName,
			BranchCode: branchCode, BranchName: branchName,
		})
	}

	if err := scanner.Err(); err != nil {
		errs = append(errs, fmt.Sprintf("%s: scanner error: %v", filename, err))
	}
	return txns, errs
}

// splitTrail separates "MerchantName   Description" from the trailing text.
// CCS Report 620 puts merchant name (~26 chars) then description (~22 chars).
func splitTrail(s string) (merchantName, description string) {
	parts := reSpaces.Split(s, 2)
	if len(parts) == 2 {
		return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
	}
	return strings.TrimSpace(s), ""
}
