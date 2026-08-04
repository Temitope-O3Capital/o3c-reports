package handlers

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/reports/core"
)

// Card cycle-data importer. O3's core banking (Udara) exports four fixed-cycle
// reports per statement date:
//   cyc_bal_rpt — billed / current / outstanding / overdue / min-payment / total-payment
//   cyc_chg_rpt — fees / interest / penalty / purchase / cash-advance
//   cyc_int_rpt — total interest
//   cyc_loc_rpt — current line-of-credit / loc-change / temp-loc
// Each is a paginated space-delimited report, grouped by "Account Product [code] : Name",
// with rows: Apnum  CIF  Account  Currency  <amounts...>. This importer auto-detects each
// file by its "Report ID" header, merges the four by account number, and upserts one
// row per (cycle_date, account_number) into card_cycle_data.

type cycleRow struct {
	ProductCode string
	CIF         string
	AccountNo   string
	Currency    string
	// bal
	Billed, Current, Outstanding, Overdue, MinPymt, TotalPymt int64
	// chg
	Fees, Interest, Penalty, Purchase, CashAdv int64
	// int
	TotalInterest int64
	// loc
	CreditLimit, LocChange, TempLoc int64
	// which reports contributed to this row
	seenBal, seenChg, seenInt, seenLoc bool
}

var (
	reCycProduct = regexp.MustCompile(`Account\s+Product\s*\[(\w+)\]\s*:\s*(.+?)\s*$`)
	reCycStmtDt  = regexp.MustCompile(`Statement\s+Date\s*:\s*(\d{2})/(\d{2})/(\d{4})`)
	reCycReportID = regexp.MustCompile(`Report\s+ID\s*:\s*(cyc\w+)`)
	reCurrency   = regexp.MustCompile(`^[A-Z]{3}$`)
	reProdCode   = regexp.MustCompile(`^\d{1,3}$`)
	reDigits     = regexp.MustCompile(`^\d+$`)
)

// naira "1234.56" / "-1234.56" → kobo int64.
func nairaToKobo(s string) (int64, bool) {
	s = strings.ReplaceAll(strings.TrimSpace(s), ",", "")
	if s == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return int64(math.Round(f * 100)), true
}

// detectCycleKind reads the report-id header (cycbal/cycchg/cycint/cycloc).
// Returns "" if not recognizable.
func detectCycleKind(head string) string {
	if m := reCycReportID.FindStringSubmatch(head); m != nil {
		switch strings.ToLower(m[1]) {
		case "cycbal":
			return "bal"
		case "cycchg":
			return "chg"
		case "cycint":
			return "int"
		case "cycloc":
			return "loc"
		}
	}
	return ""
}

// parseCycleReport parses one report into rows keyed by account number, and returns
// the statement (cycle) date found in the header. kind ∈ {bal,chg,int,loc}.
func parseCycleReport(r io.Reader, kind string, into map[string]*cycleRow, prodNames map[string]string) (time.Time, int, error) {
	var cycleDate time.Time
	parsed := 0
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	curProduct := ""
	for sc.Scan() {
		line := sc.Text()
		if cycleDate.IsZero() {
			if m := reCycStmtDt.FindStringSubmatch(line); m != nil {
				if d, err := time.Parse("02/01/2006", m[1]+"/"+m[2]+"/"+m[3]); err == nil {
					cycleDate = d
				}
			}
		}
		if m := reCycProduct.FindStringSubmatch(line); m != nil {
			curProduct = strings.TrimSpace(m[1])
			if _, ok := prodNames[curProduct]; !ok {
				prodNames[curProduct] = strings.TrimSpace(m[2])
			}
			continue
		}
		f := strings.Fields(line)
		// data row: Apnum CIF Account Currency <amounts...>. CIF and account are always
		// numeric — this also rejects malformed/footer lines (e.g. a stray "0000000`").
		if len(f) < 5 || !reProdCode.MatchString(f[0]) || !reCurrency.MatchString(f[3]) ||
			!reDigits.MatchString(f[1]) || !reDigits.MatchString(f[2]) {
			continue
		}
		prod := f[0]
		if curProduct != "" {
			prod = curProduct
		}
		acct := f[2]
		row := into[acct]
		if row == nil {
			row = &cycleRow{ProductCode: prod, CIF: f[1], AccountNo: acct, Currency: f[3]}
			into[acct] = row
		}
		nums := f[4:]
		amt := func(i int) int64 {
			if i < len(nums) {
				if v, ok := nairaToKobo(nums[i]); ok {
					return v
				}
			}
			return 0
		}
		switch kind {
		case "bal":
			row.Billed, row.Current, row.Outstanding = amt(0), amt(1), amt(2)
			row.Overdue, row.MinPymt, row.TotalPymt = amt(3), amt(4), amt(5)
			row.seenBal = true
		case "chg":
			row.Fees, row.Interest, row.Penalty = amt(0), amt(1), amt(2)
			row.Purchase, row.CashAdv = amt(3), amt(4)
			row.seenChg = true
		case "int":
			row.TotalInterest = amt(0)
			row.seenInt = true
		case "loc":
			row.CreditLimit, row.LocChange, row.TempLoc = amt(0), amt(1), amt(2)
			row.seenLoc = true
		}
		parsed++
	}
	return cycleDate, parsed, sc.Err()
}

// cardCycleImport ingests the four cycle reports (multipart, any field names — each file
// is auto-detected by its header) and upserts merged rows into card_cycle_data.
func cardCycleImport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(128 << 20); err != nil {
			respondErr(w, 400, "failed to parse upload")
			return
		}
		user := core.UserFromCtx(r.Context())

		merged := map[string]*cycleRow{}
		prodNames := map[string]string{}
		var cycleDate time.Time
		kindsSeen := map[string]int{}
		var errs []string

		// gather every uploaded file across all form fields
		var files []*multipart.FileHeader
		if r.MultipartForm != nil {
			for _, fhs := range r.MultipartForm.File {
				files = append(files, fhs...)
			}
		}
		if len(files) == 0 {
			respondErr(w, 400, "no files uploaded")
			return
		}

		for _, fh := range files {
			f, err := fh.Open()
			if err != nil {
				errs = append(errs, fmt.Sprintf("%s: open failed", fh.Filename))
				continue
			}
			// peek header (first 2KB) to detect kind
			head := make([]byte, 2048)
			n, _ := f.Read(head)
			kind := detectCycleKind(string(head[:n]))
			if kind == "" {
				// fall back to filename hint
				ln := strings.ToLower(fh.Filename)
				switch {
				case strings.Contains(ln, "bal"):
					kind = "bal"
				case strings.Contains(ln, "chg"):
					kind = "chg"
				case strings.Contains(ln, "int"):
					kind = "int"
				case strings.Contains(ln, "loc"):
					kind = "loc"
				}
			}
			if kind == "" {
				f.Close()
				errs = append(errs, fmt.Sprintf("%s: unrecognized report type", fh.Filename))
				continue
			}
			if _, err := f.Seek(0, io.SeekStart); err != nil {
				f.Close()
				errs = append(errs, fmt.Sprintf("%s: seek failed", fh.Filename))
				continue
			}
			cd, parsed, perr := parseCycleReport(f, kind, merged, prodNames)
			f.Close()
			if perr != nil {
				errs = append(errs, fmt.Sprintf("%s: %v", fh.Filename, perr))
			}
			if cycleDate.IsZero() && !cd.IsZero() {
				cycleDate = cd
			}
			kindsSeen[kind] += parsed
		}

		if cycleDate.IsZero() {
			respondErr(w, 400, "could not determine statement/cycle date from any report")
			return
		}

		// upsert merged rows
		ctx := r.Context()
		inserted := 0
		for _, row := range merged {
			pc := row.ProductCode
			if len(pc) > 3 {
				pc = pc[:3]
			}
			_, err := db.PGExec(ctx, `
				INSERT INTO card_cycle_data
					(cycle_date, product_code, cif, account_number, currency,
					 billed_balance_kobo, current_balance_kobo, outstanding_balance_kobo,
					 overdue_amount_kobo, minimum_payment_kobo, total_payment_kobo,
					 fees_kobo, interest_charged_kobo, penalty_kobo, purchase_amount_kobo, cash_advance_kobo,
					 total_interest_kobo, credit_limit_kobo, loc_change_kobo, temp_loc_kobo)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
				ON CONFLICT (cycle_date, account_number) DO UPDATE SET
					product_code=EXCLUDED.product_code, cif=EXCLUDED.cif, currency=EXCLUDED.currency,
					billed_balance_kobo=EXCLUDED.billed_balance_kobo,
					current_balance_kobo=EXCLUDED.current_balance_kobo,
					outstanding_balance_kobo=EXCLUDED.outstanding_balance_kobo,
					overdue_amount_kobo=EXCLUDED.overdue_amount_kobo,
					minimum_payment_kobo=EXCLUDED.minimum_payment_kobo,
					total_payment_kobo=EXCLUDED.total_payment_kobo,
					fees_kobo=EXCLUDED.fees_kobo, interest_charged_kobo=EXCLUDED.interest_charged_kobo,
					penalty_kobo=EXCLUDED.penalty_kobo, purchase_amount_kobo=EXCLUDED.purchase_amount_kobo,
					cash_advance_kobo=EXCLUDED.cash_advance_kobo, total_interest_kobo=EXCLUDED.total_interest_kobo,
					credit_limit_kobo=EXCLUDED.credit_limit_kobo, loc_change_kobo=EXCLUDED.loc_change_kobo,
					temp_loc_kobo=EXCLUDED.temp_loc_kobo, imported_at=NOW()`,
				cycleDate.Format("2006-01-02"), pc, row.CIF, row.AccountNo, row.Currency,
				row.Billed, row.Current, row.Outstanding, row.Overdue, row.MinPymt, row.TotalPymt,
				row.Fees, row.Interest, row.Penalty, row.Purchase, row.CashAdv,
				row.TotalInterest, row.CreditLimit, row.LocChange, row.TempLoc)
			if err != nil {
				errs = append(errs, fmt.Sprintf("acct %s: %v", row.AccountNo, err))
				continue
			}
			inserted++
		}

		// Risk alert: after a cycle lands, notify the relevant heads if the book shows
		// meaningful over-limit / delinquency, so the signal is acted on — not just charted.
		if inserted > 0 {
			if ar, err := db.PGQuery(ctx, `
				SELECT
					COUNT(*) FILTER (WHERE d.overdue_amount_kobo > 0)                                               AS overdue,
					COUNT(*) FILTER (WHERE d.credit_limit_kobo > 0 AND d.outstanding_balance_kobo > d.credit_limit_kobo) AS over_limit,
					COALESCE(SUM(d.overdue_amount_kobo),0)::bigint                                                  AS overdue_kobo
				FROM card_cycle_data d
				JOIN card_products p ON p.product_code = d.product_code AND p.category='credit'
				WHERE d.cycle_date = $1`, cycleDate.Format("2006-01-02")); err == nil && len(ar) > 0 {
				overdue := toInt64(ar[0]["overdue"])
				overLimit := toInt64(ar[0]["over_limit"])
				if overdue > 0 || overLimit > 0 {
					NotifyRoles(ctx, db, []string{"cards_ops_head", "risk_head", "head_collections", "finance_head"}, NotifPayload{
						EventType: "card_cycle_risk",
						Title:     fmt.Sprintf("Card cycle %s: %d overdue, %d over-limit", cycleDate.Format("2006-01-02"), overdue, overLimit),
						Body:      fmt.Sprintf("Latest credit-card cycle imported: %d accounts overdue (₦%s), %d over their limit. Review the at-risk list.", overdue, fmtKoboStr(toInt64(ar[0]["overdue_kobo"])), overLimit),
						ActionURL: "/cards/at-risk",
						EntityRef: "card_cycle:" + cycleDate.Format("2006-01-02"),
					})
				}
			}
		}

		_ = user
		respond(w, map[string]any{
			"cycle_date":      cycleDate.Format("2006-01-02"),
			"accounts_merged": len(merged),
			"rows_upserted":   inserted,
			"reports":         kindsSeen, // parsed rows per report kind
			"products":        prodNames,
			"errors":          errs,
		}, "pg")
	}
}
