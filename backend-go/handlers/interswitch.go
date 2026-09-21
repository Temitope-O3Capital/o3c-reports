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

// iswBuckets is the report's column order, matching monthlyRow.bucketValues. The
// buckets mirror iswChannelCase so the report and the summary page classify a
// transaction the same way. The report used to have four columns — ATM, POS, WEB
// and a residual "Transfer" that carried bills, repayments and charges together.
var iswBuckets = []string{"atm", "pos", "web", "bills", "repayment", "fees", "other"}

// Real H1 2026 monthly figures from the half-year transaction report (kobo),
// served only when the ledger holds nothing for the requested year, and flagged
// source=static. That report had four columns; its residual Transfer column cannot
// be split into bills, repayments and charges after the fact, so it is carried as
// Other rather than spread across buckets on a guess.
var baseMonths = []monthlyRow{
	{Month: "January", ATM: 168_500_000, POS: 2_094_254_691, WEB: 5_507_397_656, Other: 5_515_403_000},
	{Month: "February", ATM: 172_200_000, POS: 1_142_586_698, WEB: 4_336_613_728, Other: 6_371_468_692},
	{Month: "March", ATM: 115_400_000, POS: 1_435_062_160, WEB: 2_825_917_248, Other: 8_441_525_120},
	{Month: "April", ATM: 125_200_000, POS: 1_164_520_084, WEB: 3_775_154_082, Other: 9_533_611_655},
	{Month: "May", ATM: 123_300_000, POS: 1_141_592_869, WEB: 3_923_585_065, Other: 42_530_445_160},
	{Month: "June", ATM: 115_800_000, POS: 1_497_544_357, WEB: 3_324_723_845, Other: 9_851_054_276},
}

// monthlyRow is one month of DR volume. The buckets and Total are naira. USD is
// the month's dollar-card volume in cents: CCS posts those cards in dollars, so
// adding it to Total would count $1 as ₦1. It sits beside the total, never in it.
type monthlyRow struct {
	Month     string `json:"month"`
	ATM       int64  `json:"atm"`
	POS       int64  `json:"pos"`
	WEB       int64  `json:"web"`
	Bills     int64  `json:"bills"`
	Repayment int64  `json:"repayment"`
	Fees      int64  `json:"fees"`
	Other     int64  `json:"other"`
	Total     int64  `json:"total"`
	USD       int64  `json:"usd"`
}

// bucketValues returns the naira buckets in iswBuckets order.
func (m monthlyRow) bucketValues() []int64 {
	return []int64{m.ATM, m.POS, m.WEB, m.Bills, m.Repayment, m.Fees, m.Other}
}

func (m *monthlyRow) sumTotal() {
	m.Total = 0
	for _, v := range m.bucketValues() {
		m.Total += v
	}
}

func interswitchReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		year := r.URL.Query().Get("year")
		period := r.URL.Query().Get("period")
		if year == "" {
			year = "2026"
		}
		if period == "" {
			period = "H1"
		}

		ctx := r.Context()
		// Try to serve live data from interswitch_txns
		yr := year
		dbRows, err := db.PGQuery(ctx, `
			SELECT
				TO_CHAR(t.txn_date, 'FMMonth') AS month,
				-- Buckets classify on app.card_txn_codes.category, as iswChannelCase does.
				-- They once tested txn_code IN ('01'..'15'), codes this feed never uses,
				-- which left every month 100% in the residual column. Other is codes the
				-- category table does not know yet, so a new code shows up rather than
				-- quietly joining a named bucket.
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE `+iswNairaDR+` AND c.category = 'cash_advance'), 0) AS atm,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE `+iswNairaDR+` AND c.category = 'purchase'), 0)     AS pos,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE `+iswNairaDR+` AND c.category = 'transfer'), 0)     AS web,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE `+iswNairaDR+` AND c.category = 'utility'), 0)      AS bills,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE `+iswNairaDR+` AND c.category = 'payment'), 0)      AS repayment,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE `+iswNairaDR+`
					AND c.category IN ('fee', 'interest', 'penalty')), 0)                                       AS fees,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE `+iswNairaDR+`
					AND (c.category IS NULL OR c.category NOT IN
						('cash_advance', 'purchase', 'transfer', 'utility', 'payment', 'fee', 'interest', 'penalty'))), 0) AS other,
				COALESCE(SUM(t.amount_kobo) FILTER (WHERE t.sign = 'DR' AND `+iswIsUSD+`), 0)               AS usd
			`+iswChannelJoin+`
			WHERE EXTRACT(YEAR FROM t.txn_date) = $1::int
			GROUP BY DATE_TRUNC('month', t.txn_date), TO_CHAR(t.txn_date, 'FMMonth')
			ORDER BY DATE_TRUNC('month', t.txn_date)`, yr)

		var months []monthlyRow
		if err == nil && len(dbRows) > 0 {
			for _, row := range dbRows {
				m := monthlyRow{
					Month:     str(row["month"]),
					ATM:       toInt64(row["atm"]),
					POS:       toInt64(row["pos"]),
					WEB:       toInt64(row["web"]),
					Bills:     toInt64(row["bills"]),
					Repayment: toInt64(row["repayment"]),
					Fees:      toInt64(row["fees"]),
					Other:     toInt64(row["other"]),
					USD:       toInt64(row["usd"]),
				}
				m.sumTotal()
				months = append(months, m)
			}
			months = selectPeriod(months, period)
		} else {
			// Fall back to hardcoded H1 2026 data until real imports accumulate
			months = selectPeriod(baseMonths, period)
			for i := range months {
				months[i].sumTotal()
			}
		}

		totals := computeTotals(months)
		respond(w, map[string]any{
			"data": map[string]any{
				"period_label": fmt.Sprintf("%s %s", strings.ToUpper(period), year),
				"generated_at": time.Now().Format("2006-01-02"),
				"months":       months,
				"totals":       totals,
				"source":       map[bool]string{true: "live", false: "static"}[err == nil && len(dbRows) > 0],
			},
		}, "ok")
	}
}

var monthIndex = map[string]int{
	"January": 0, "February": 1, "March": 2, "April": 3, "May": 4, "June": 5,
	"July": 6, "August": 7, "September": 8, "October": 9, "November": 10, "December": 11,
}

var periodRanges = map[string][2]int{
	"H1": {0, 5}, "H2": {6, 11}, "FY": {0, 11},
	"Q1": {0, 2}, "Q2": {3, 5}, "Q3": {6, 8}, "Q4": {9, 11},
}

func selectPeriod(all []monthlyRow, period string) []monthlyRow {
	r, ok := periodRanges[strings.ToUpper(period)]
	if !ok {
		r = [2]int{0, 5}
	}
	var out []monthlyRow
	for _, m := range all {
		if idx, exists := monthIndex[m.Month]; exists && idx >= r[0] && idx <= r[1] {
			out = append(out, m)
		}
	}
	return out
}

// computeTotals sums the period. For each bucket in iswBuckets it returns <key>,
// <key>_pct (share of the naira total) and <key>_avg (per month), plus total, usd
// and usd_avg. Every key is always present, as a zero for an empty period, so
// the page never reads undefined.
func computeTotals(months []monthlyRow) map[string]any {
	t := map[string]any{"total": int64(0), "usd": int64(0), "usd_avg": int64(0)}
	for _, k := range iswBuckets {
		t[k], t[k+"_pct"], t[k+"_avg"] = int64(0), 0.0, int64(0)
	}
	n := int64(len(months))
	if n == 0 {
		return t
	}
	sums := make([]int64, len(iswBuckets))
	var total, usd int64
	for _, m := range months {
		for i, v := range m.bucketValues() {
			sums[i] += v
			total += v
		}
		usd += m.USD
	}
	for i, k := range iswBuckets {
		t[k] = sums[i]
		t[k+"_avg"] = sums[i] / n
		if total > 0 {
			t[k+"_pct"] = math.Round(float64(sums[i])/float64(total)*10000) / 100
		}
	}
	t["total"], t["usd"], t["usd_avg"] = total, usd, usd/n
	return t
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
