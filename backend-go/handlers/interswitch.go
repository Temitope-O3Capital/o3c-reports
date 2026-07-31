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
	"github.com/o3c/reports/core"
)

// RegisterInterswitch adds /api/cards/interswitch routes.
func RegisterInterswitch(r chi.Router, db *core.DB) {
	r.Get("/summary",   interswitchSummary(db))
	r.Get("/half-year", interswitchReport(db))
	r.Post("/import",   interswitchImport(db))
}

// ── Summary ────────────────────────────────────────────────────────────────────

func interswitchSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		// MTD summary
		rows, err := db.PGQuery(ctx, `
			SELECT
				COUNT(*)                                                     AS total_txns,
				COUNT(*) FILTER (WHERE sign='DR')                           AS debit_count,
				COALESCE(SUM(amount_kobo) FILTER (WHERE sign='DR'), 0)      AS debit_volume_kobo,
				COUNT(*) FILTER (WHERE sign='CR')                           AS credit_count,
				COALESCE(SUM(amount_kobo) FILTER (WHERE sign='CR'), 0)      AS credit_volume_kobo,
				COUNT(DISTINCT branch_code)                                 AS branch_count,
				COUNT(DISTINCT product_code)                                AS product_count,
				MIN(txn_date)                                               AS earliest_date,
				MAX(txn_date)                                               AS latest_date
			FROM interswitch_txns
			WHERE txn_date >= DATE_TRUNC('month', CURRENT_DATE)`)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total_txns": 0, "debit_count": 0, "debit_volume_kobo": 0,
				"credit_count": 0, "credit_volume_kobo": 0,
				"branch_count": 0, "product_count": 0,
				"data_available": false,
			}, "pg")
			return
		}
		row := rows[0]
		// Channel breakdown for current month
		chanRows, _ := db.PGQuery(ctx, `
			SELECT
				CASE
					WHEN txn_code IN ('01','02','03','04','05') THEN 'ATM'
					WHEN txn_code IN ('06','07','08','09') THEN 'POS'
					WHEN txn_code IN ('10','11','12','13','14','15') THEN 'WEB'
					ELSE 'Transfer'
				END AS channel,
				COUNT(*) AS txn_count,
				COALESCE(SUM(amount_kobo) FILTER (WHERE sign='DR'), 0) AS volume_kobo
			FROM interswitch_txns
			WHERE txn_date >= DATE_TRUNC('month', CURRENT_DATE)
			GROUP BY 1
			ORDER BY volume_kobo DESC`)

		respond(w, map[string]any{
			"total_txns":         toInt64(row["total_txns"]),
			"debit_count":        toInt64(row["debit_count"]),
			"debit_volume_kobo":  toInt64(row["debit_volume_kobo"]),
			"credit_count":       toInt64(row["credit_count"]),
			"credit_volume_kobo": toInt64(row["credit_volume_kobo"]),
			"branch_count":       toInt64(row["branch_count"]),
			"product_count":      toInt64(row["product_count"]),
			"earliest_date":      row["earliest_date"],
			"latest_date":        row["latest_date"],
			"channel_breakdown":  chanRows,
			"data_available":     true,
		}, "pg")
	}
}

// ── Transaction Report ─────────────────────────────────────────────────────────

// Real H1 2026 monthly figures from the half-year transaction report (kobo).
var baseMonths = []monthlyRow{
	{Month: "January",  ATM: 168_500_000,   POS: 2_094_254_691,  WEB: 5_507_397_656,  Transfer: 5_515_403_000},
	{Month: "February", ATM: 172_200_000,   POS: 1_142_586_698,  WEB: 4_336_613_728,  Transfer: 6_371_468_692},
	{Month: "March",    ATM: 115_400_000,   POS: 1_435_062_160,  WEB: 2_825_917_248,  Transfer: 8_441_525_120},
	{Month: "April",    ATM: 125_200_000,   POS: 1_164_520_084,  WEB: 3_775_154_082,  Transfer: 9_533_611_655},
	{Month: "May",      ATM: 123_300_000,   POS: 1_141_592_869,  WEB: 3_923_585_065,  Transfer: 42_530_445_160},
	{Month: "June",     ATM: 115_800_000,   POS: 1_497_544_357,  WEB: 3_324_723_845,  Transfer: 9_851_054_276},
}

type monthlyRow struct {
	Month    string `json:"month"`
	ATM      int64  `json:"atm"`
	POS      int64  `json:"pos"`
	WEB      int64  `json:"web"`
	Transfer int64  `json:"transfer"`
	Total    int64  `json:"total"`
}

type channelTotals struct {
	ATM         int64   `json:"atm"`
	POS         int64   `json:"pos"`
	WEB         int64   `json:"web"`
	Transfer    int64   `json:"transfer"`
	Total       int64   `json:"total"`
	ATMPct      float64 `json:"atm_pct"`
	POSPct      float64 `json:"pos_pct"`
	WEBPct      float64 `json:"web_pct"`
	TransferPct float64 `json:"transfer_pct"`
	ATMAvg      int64   `json:"atm_avg"`
	POSAvg      int64   `json:"pos_avg"`
	WEBAvg      int64   `json:"web_avg"`
	TransferAvg int64   `json:"transfer_avg"`
}

func interswitchReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		year   := r.URL.Query().Get("year")
		period := r.URL.Query().Get("period")
		if year == ""   { year = "2026" }
		if period == "" { period = "H1" }

		ctx := r.Context()
		// Try to serve live data from interswitch_txns
		yr := year
		dbRows, err := db.PGQuery(ctx, `
			SELECT
				TO_CHAR(txn_date, 'FMMonth') AS month,
				COALESCE(SUM(amount_kobo) FILTER (WHERE txn_code IN ('01','02','03','04','05') AND sign='DR'), 0) AS atm,
				COALESCE(SUM(amount_kobo) FILTER (WHERE txn_code IN ('06','07','08','09')      AND sign='DR'), 0) AS pos,
				COALESCE(SUM(amount_kobo) FILTER (WHERE txn_code IN ('10','11','12','13','14','15') AND sign='DR'), 0) AS web,
				COALESCE(SUM(amount_kobo) FILTER (WHERE sign='DR'
					AND txn_code NOT IN ('01','02','03','04','05','06','07','08','09','10','11','12','13','14','15')), 0) AS transfer
			FROM interswitch_txns
			WHERE EXTRACT(YEAR FROM txn_date) = $1::int
			GROUP BY DATE_TRUNC('month', txn_date), TO_CHAR(txn_date, 'FMMonth')
			ORDER BY DATE_TRUNC('month', txn_date)`, yr)

		var months []monthlyRow
		if err == nil && len(dbRows) > 0 {
			for _, row := range dbRows {
				m := monthlyRow{
					Month:    str(row["month"]),
					ATM:      toInt64(row["atm"]),
					POS:      toInt64(row["pos"]),
					WEB:      toInt64(row["web"]),
					Transfer: toInt64(row["transfer"]),
				}
				m.Total = m.ATM + m.POS + m.WEB + m.Transfer
				months = append(months, m)
			}
			months = selectPeriod(months, period)
		} else {
			// Fall back to hardcoded H1 2026 data until real imports accumulate
			months = selectPeriod(baseMonths, period)
			for i := range months {
				months[i].Total = months[i].ATM + months[i].POS + months[i].WEB + months[i].Transfer
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
	if !ok { r = [2]int{0, 5} }
	var out []monthlyRow
	for _, m := range all {
		if idx, exists := monthIndex[m.Month]; exists && idx >= r[0] && idx <= r[1] {
			out = append(out, m)
		}
	}
	return out
}

func computeTotals(months []monthlyRow) channelTotals {
	n := int64(len(months))
	if n == 0 { return channelTotals{} }
	var t channelTotals
	for _, m := range months {
		t.ATM += m.ATM; t.POS += m.POS; t.WEB += m.WEB; t.Transfer += m.Transfer
	}
	t.Total = t.ATM + t.POS + t.WEB + t.Transfer
	if t.Total > 0 {
		t.ATMPct      = math.Round(float64(t.ATM) / float64(t.Total) * 10000) / 100
		t.POSPct      = math.Round(float64(t.POS) / float64(t.Total) * 10000) / 100
		t.WEBPct      = math.Round(float64(t.WEB) / float64(t.Total) * 10000) / 100
		t.TransferPct = math.Round(float64(t.Transfer) / float64(t.Total) * 10000) / 100
	}
	t.ATMAvg = t.ATM / n; t.POSAvg = t.POS / n; t.WEBAvg = t.WEB / n; t.TransferAvg = t.Transfer / n
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
	FilesProcessed       int              `json:"files_processed"`
	TransactionsImported int              `json:"transactions_imported"`
	TotalVolumeKobo      int64            `json:"total_volume_kobo"`
	Branches             []branchSum      `json:"branches"`
	Products             []productSum     `json:"products"`
	Errors               []string         `json:"errors"`
}

type branchSum  struct{ Branch string `json:"branch"`; TxnCount int `json:"txn_count"`; VolumeKobo int64 `json:"volume_kobo"` }
type productSum struct{ Product string `json:"product"`; TxnCount int `json:"txn_count"` }

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
			allTxns    = append(allTxns, txns...)
			parseErrs  = append(parseErrs, errs...)
		}

		// Aggregate
		branchMap  := map[string]*branchSum{}
		productMap := map[string]*productSum{}
		var totalKobo int64

		for _, t := range allTxns {
			if t.Sign == "DR" { totalKobo += t.AmountKobo }

			bk := fmt.Sprintf("%s - %s", t.BranchCode, t.BranchName)
			if branchMap[bk] == nil { branchMap[bk] = &branchSum{Branch: bk} }
			branchMap[bk].TxnCount++
			if t.Sign == "DR" { branchMap[bk].VolumeKobo += t.AmountKobo }

			pk := fmt.Sprintf("%s (%s)", t.ProductName, t.ProductCode)
			if productMap[pk] == nil { productMap[pk] = &productSum{Product: pk} }
			productMap[pk].TxnCount++
		}

		var branches []branchSum
		for _, v := range branchMap { branches = append(branches, *v) }
		var products []productSum
		for _, v := range productMap { products = append(products, *v) }

		// Persist parsed transactions — use INSERT ON CONFLICT DO NOTHING to make re-uploads idempotent.
		// De-duplicate on (trace_num, txn_date, branch_code) — same trace on same date from same branch is the same txn.
		if len(allTxns) > 0 && db != nil {
			ctx := r.Context()
			for _, t := range allTxns {
				db.PGExec(ctx, //nolint:errcheck
					`INSERT INTO interswitch_txns
						(trace_num, auth_num, card_num, txn_code, txn_date, merchant_id,
						 amount_kobo, sign, currency, merchant_name, description,
						 account_no, cif, product_code, product_name, branch_code, branch_name)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
					 ON CONFLICT DO NOTHING`,
					t.TraceNum, t.AuthNum, t.CardNum, t.TxnCode, t.TxnDate.Format("2006-01-02"),
					t.MerchantID, t.AmountKobo, t.Sign, t.Currency, t.MerchantName,
					t.Description, t.AccountNo, t.CIF, t.ProductCode, t.ProductName,
					t.BranchCode, t.BranchName)
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"data": importSummary{
				FilesProcessed:       fileCount,
				TransactionsImported: len(allTxns),
				TotalVolumeKobo:      totalKobo,
				Branches:             branches,
				Products:             products,
				Errors:               parseErrs,
			},
		})
	}
}

// parseEODTXN reads a CCS Report 620 file and extracts all transactions.
func parseEODTXN(r io.Reader, filename string) ([]parsedTxn, []string) {
	var (
		txns       []parsedTxn
		errs       []string
		branchCode, branchName, prodCode, prodName, accountNo, cif string
	)

	scanner := bufio.NewScanner(r)
	lineNum  := 0

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
			cif       = strings.TrimSpace(m[2])
			continue
		}

		// Transaction lines start with a digit (trace number)
		if len(trimmed) == 0 || !unicode.IsDigit(rune(trimmed[0])) {
			continue
		}

		m := reTxn.FindStringSubmatch(line)
		if m == nil { continue }

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
