package cbssync

// Repayment capture from the Udara360 GL call-over ledger.
//
// WHAT THIS IS
// ------------
// Until now every arrears figure in the product has been MODEL OUTPUT: a
// schedule (app.cbs_loan_schedules) says what should have been paid, and the
// loan snapshot says what is outstanding. Nothing recorded what was actually
// POSTED. app.loan_repayments held 0 rows. This file makes repayment an
// observed fact by mirroring the real general-ledger postings.
//
// THE SOURCE
// ----------
// /api/Report/v1/GetTransactionCallOverReport is the only endpoint that
// carries actual postings. Measured 2026-09-22 against the live CBS:
//
//   - Parameters honoured : PageNumber, PageSize, AccountNumber (case-insensitive).
//   - Parameters IGNORED  : every date filter tried — StartDate/EndDate,
//     startDate/endDate, FromDate/ToDate, Date, FinancialDate,
//     TransactionDate. Each returned a byte-identical unfiltered
//     page. THERE IS NO SERVER-SIDE DATE FILTER. A bounded window
//     has to be done client-side by paging newest-first and stopping.
//   - Default PageSize    : 10.
//   - recordCount         : always 0 on this endpoint. Useless — do not trust it,
//     and do not size a page from it the way fetchFullBook does
//     for the Search endpoints.
//   - Ordering            : financialDate DESC, then transactionDate DESC.
//   - Whole ledger        : 5,682 rows, financialDate 2026-07-01..2026-09-16,
//     i.e. 6 pages of 1000. It does not reach back past 2026-07-01.
//
// Row shape (every value is a string unless noted):
//
//	financialDate          "2026-09-11"                   value date
//	transactionDate        "2026-09-18T14:09:54.3666667"   when it actually landed
//	accountNumber          "1000006458"                    the account this LEG hits
//	accountName            "INTERIOR BAZAR NIGERIA"
//	branch                 "Head Office Branch"
//	initiatedBy/approvedBy maker/checker email, or null
//	postingReferenceNumber "2609110019" / "BA2609110017"
//	amount/debit/credit    "90000000.00"                   KOBO — see below
//	narration              "Loan Principal Repayment Recovered - BA2609110017 - INTERIOR BAZAR NIGERIA - 1200045402000006600"
//	entryCode              "D-LPOP"
//	instrumentNumber       "LOANPRN_2_<uuid>" or a bare uuid
//	accessLevel            number
//	senderName             null
//
// AMOUNTS ARE KOBO. All 5,682 ledger amounts match ^\d+\.00$ exactly; the two
// decimal places are always zero padding, never sub-kobo. Confirmed against the
// book: loan 1200045402000005971 has cbs_loans.loan_amount_kobo = 13,333,333,333
// and its C-LPDP entry reads "13333333333.00"; loan 1200045401000006371 has
// loan_amount_kobo = 1,000,000,000 and its D-LPDP reads "1000000000.00".
// Nothing here ever converts to naira.
//
// DOUBLE ENTRY — THE TRAP
// -----------------------
// One repayment produces two or four ledger rows, and naively summing them
// double- or quadruple-counts the money:
//
//	principal  C-LPOP    GL 10527001   (loan principal due/unpaid)
//	           D-LPOP    customer CASA  <-- the only row we capture
//	interest   C-LIOP1A  GL 10523005
//	           D-LIOP1B  GL 20414005
//	           C-LIOP1B  GL 40304005
//	           D-LIOP1A  customer CASA  <-- the only row we capture
//
// So capture is restricted to the DEBIT leg that lands on the customer's own
// account. Verified: across the entire ledger there are 39 such legs and all 39
// sit on one of the 44 distinct cbs_loans.linked_account values — zero land
// anywhere else. Totals: principal 56,311,755,432 kobo (N563,117,554.32),
// interest 8,109,000,000 kobo (N81,090,000).
//
// Codes deliberately NOT captured:
//
//	D-LPDP/C-LPDP, D-RLPDP/C-RLPDP  disbursement and its reversal
//	D-LIDT/C-LIDT                   interest moved out of suspense at delinquency (GL to GL)
//	RD-LIAP1/RC-LIAP1               reversal of an interest ACCRUAL, not a payment
//	FDPP/FDPL/FDPR/FDI*             fixed deposits, not loans
//	JRNL/IBRH/WHTP/CSHW/BCSH        journals, inter-branch, WHT, cash
//
// WINDOWING — WHY THE LOOKBACK IS 45 DAYS AND NOT 7
// -------------------------------------------------
// financialDate is the value date; transactionDate is when the entry actually
// appeared. They are far apart on this system. Measured over all 5,682 rows the
// lag is median 17 days, p99 47, max 75. Over the 39 repayment legs alone:
// median 22 days, max 38. Since the feed can only be paged by financialDate, an
// hourly job must reach back further than the worst posting lag or it silently
// never sees the entry. A 14-day window would have missed 20 of the 39 legs —
// 51% of every repayment ever made. 45 days clears the observed maximum with
// headroom; CBS_REPAYMENT_LOOKBACK_DAYS tunes it without a rebuild.
//
// GUARD
// -----
// sync.go's guardRefresh exists because a DELETE+INSERT refresh committed an
// empty book from a silently-empty fetch. This capture is INSERT-ONLY with
// ON CONFLICT DO NOTHING and issues no DELETE or UPDATE at all, so a bad API
// response structurally cannot empty or gut the table. On top of that, and in
// the same spirit, a run refuses to write when the window comes back holding
// materially fewer legs than we have already stored for it (see guardLegCount)
// — that is the loud early warning if Udara renames an entry code or changes
// the report's shape.

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/udara"
)

const (
	// callOverPath is the GL call-over report. GET only, like every Udara call
	// this package makes.
	callOverPath = "/api/Report/v1/GetTransactionCallOverReport"

	// repaymentPageSize is the page size used when walking the global feed.
	// 500 is proven stable on this endpoint (1000 works too); the whole ledger
	// is under 6k rows, so a 45-day window is a handful of requests.
	repaymentPageSize = 500

	// repaymentMaxPages bounds a single window walk so a feed that stops
	// honouring PageNumber can never spin forever. 60 pages x 500 = 30,000
	// rows, roughly five times the entire ledger as it stands today.
	repaymentMaxPages = 60

	// defaultLookbackDays is the financialDate window the hourly job pulls.
	// Calibrated on the measured posting lag — see the header.
	defaultLookbackDays = 45

	// repaymentChannel tags every row this file writes, so ledger-observed
	// repayments are separable from manual/collections/card ones.
	repaymentChannel = "cbs_gl"

	// repaymentWorkerKey is the worker_heartbeats key.
	repaymentWorkerKey = "cbs_repayment_capture"
)

// Entry-code classification. The map is the audit trail for "why is this row
// principal?" — the raw code is also stored on every row so a human can check.
var (
	principalCodes = map[string]bool{
		"D-LPOP": true, // Loan Principal Due and Unpaid Recovered  (scheduled recovery)
		"D-LPRP": true, // Loan Principal Repayment                 (full/early repayment)
	}
	interestCodes = map[string]bool{
		"D-LIOP1A": true, // Loan Interest Due and Unpaid Recovered
		"D-LIRP1":  true, // Loan Interest Repayment
	}
)

// errRepaymentGuard marks a refusal to write, mirroring errBookShrank in sync.go.
var errRepaymentGuard = errors.New("cbs repayment capture guard")

// loanAcctRe matches the loan account number Udara puts at the end of a
// repayment narration. Both shapes seen in the book are numeric and 11-19
// digits: "1200045402000006600", "21000004240", "2000450000100104".
var loanAcctRe = regexp.MustCompile(`^\d{10,25}$`)

// RepaymentResult summarises one capture run.
type RepaymentResult struct {
	Pages         int    // ledger pages fetched
	Scanned       int    // ledger rows examined
	Legs          int    // rows classified as a capturable repayment leg
	Inserted      int    // rows actually written (new ledger entries)
	Duplicate     int    // rows already held — the idempotency path
	Unmatched     int    // legs whose loan account could not be resolved
	PrincipalKobo int64  // principal captured this run (kobo, new rows only)
	InterestKobo  int64  // interest captured this run (kobo, new rows only)
	OldestDate    string // oldest financialDate seen
	NewestDate    string // newest financialDate seen
}

// ledgerLeg is one classified, validated call-over row ready to be written.
type ledgerLeg struct {
	Key         string // sha256 idempotency key
	LoanAccount string // cbs_loans.cbs_account_number
	CASAAccount string // the account this leg debits
	EntryCode   string // raw, e.g. "D-LIOP1A"
	Component   string // "principal" | "interest"
	AmountKobo  int64
	FinDate     string // "2026-09-11"
	PostedAt    sql.NullTime
	PostingRef  string
	Instrument  string
	Narration   string
	Raw         []byte
}

// ── the hourly job ───────────────────────────────────────────────────────────

// StartRepaymentWorker runs SyncRepayments shortly after boot and then every
// CBS_REPAYMENT_INTERVAL (default 1h). Registered from main.go with `go`.
//
// It deliberately does NOT run the backfill. BackfillRepayments walks the whole
// history and is a one-off; it only runs when CBS_REPAYMENT_BACKFILL=1 is set
// explicitly, which it is not in any committed configuration.
func StartRepaymentWorker(c *udara.Client, db *core.DB) {
	if c == nil || !c.IsConfigured() {
		slog.Info("CBS repayment capture disabled (Udara360 not configured)")
		return
	}
	interval := repaymentInterval()
	if interval <= 0 {
		slog.Info("CBS repayment capture disabled (CBS_REPAYMENT_INTERVAL <= 0)")
		return
	}

	runOnce := func(backfill bool) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		defer cancel()
		repaymentBeat(ctx, db, "running", "", "")

		var (
			res RepaymentResult
			err error
		)
		if backfill {
			res, err = BackfillRepayments(ctx, c, db)
		} else {
			res, err = SyncRepayments(ctx, c, db)
		}
		if err != nil {
			slog.Error("CBS repayment capture failed",
				"backfill", backfill, "pages", res.Pages, "scanned", res.Scanned,
				"legs", res.Legs, "err", err)
			repaymentBeat(ctx, db, "error", "", err.Error())
			return
		}
		detail := fmt.Sprintf("%d legs, %d new, %d already held, %d unmatched; principal %d kobo, interest %d kobo (%s..%s)",
			res.Legs, res.Inserted, res.Duplicate, res.Unmatched,
			res.PrincipalKobo, res.InterestKobo, res.OldestDate, res.NewestDate)
		slog.Info("CBS repayment capture ok",
			"backfill", backfill, "pages", res.Pages, "scanned", res.Scanned,
			"legs", res.Legs, "inserted", res.Inserted, "duplicate", res.Duplicate,
			"unmatched", res.Unmatched, "principal_kobo", res.PrincipalKobo,
			"interest_kobo", res.InterestKobo, "window", res.OldestDate+".."+res.NewestDate)
		repaymentBeat(ctx, db, "ok", detail, "")
	}

	// Let the server settle, and let the CBS book sync land first — capture
	// resolves loan accounts against cbs_loans, which StartCBSSyncWorker fills
	// 30s after boot.
	time.Sleep(90 * time.Second)

	if envBool("CBS_REPAYMENT_BACKFILL") {
		slog.Warn("CBS repayment BACKFILL requested by CBS_REPAYMENT_BACKFILL=1 — " +
			"walking the full per-account history once before the hourly window takes over")
		runOnce(true)
	}
	runOnce(false)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		runOnce(false)
	}
}

// SyncRepayments captures the bounded recent window: it walks the global
// call-over feed newest-first and stops as soon as it is past the lookback
// cutoff. This is the hourly path.
func SyncRepayments(ctx context.Context, c *udara.Client, db *core.DB) (RepaymentResult, error) {
	var res RepaymentResult
	if c == nil || !c.IsConfigured() {
		return res, fmt.Errorf("cbs repayment capture: udara client not configured")
	}
	if err := requireRepaymentSchema(ctx, db); err != nil {
		return res, err
	}
	loans, err := loadLoanAccounts(ctx, db)
	if err != nil {
		return res, err
	}

	cutoff := time.Now().AddDate(0, 0, -lookbackDays()).Format("2006-01-02")
	rows, err := walkWindow(ctx, c, cutoff, &res)
	if err != nil {
		return res, err
	}
	return writeLegs(ctx, db, resolveLegs(classifyLegs(rows, &res), loans, &res), &res, cutoff)
}

// BackfillRepayments is the ONE-OFF history path. DO NOT wire this to a timer.
//
// It sweeps every distinct cbs_loans.linked_account (44 accounts as at
// 2026-09-22) and pulls that account's complete ledger via AccountNumber=,
// which returns the account's full history in a single page regardless of date
// — the per-account query is not subject to the newest-first paging the global
// feed needs. 44 GETs returning 176 rows in total.
//
// Cross-checked against the global walk: both paths find exactly the same 39
// repayment legs and the same totals (56,311,755,432 kobo principal,
// 8,109,000,000 kobo interest), so the backfill and the hourly job agree.
//
// To run it: set CBS_REPAYMENT_BACKFILL=1 in backend-go/.env and restart the
// service (Stop-ScheduledTask O3C-Backend). It is idempotent, so leaving the
// flag on only costs 44 extra GETs per restart, but unset it afterwards.
func BackfillRepayments(ctx context.Context, c *udara.Client, db *core.DB) (RepaymentResult, error) {
	var res RepaymentResult
	if c == nil || !c.IsConfigured() {
		return res, fmt.Errorf("cbs repayment backfill: udara client not configured")
	}
	if err := requireRepaymentSchema(ctx, db); err != nil {
		return res, err
	}
	loans, err := loadLoanAccounts(ctx, db)
	if err != nil {
		return res, err
	}

	casa, err := loadCASAAccounts(ctx, db)
	if err != nil {
		return res, err
	}
	if len(casa) == 0 {
		return res, fmt.Errorf("%w: no linked CASA accounts in cbs_loans; refusing to backfill "+
			"against an empty loan book (run the CBS sync first)", errRepaymentGuard)
	}

	var raws []map[string]any
	for _, acct := range casa {
		q := url.Values{}
		q.Set("AccountNumber", acct)
		q.Set("PageSize", strconv.Itoa(repaymentPageSize))
		q.Set("PageNumber", "1")
		rows, err := fetchCallOver(ctx, c, q)
		if err != nil {
			// One unreachable account must not abandon the other 43; the run is
			// idempotent and the next one picks it up.
			slog.Warn("cbs repayment backfill: account fetch failed",
				"casa_account", acct, "err", err)
			continue
		}
		if len(rows) == repaymentPageSize {
			slog.Warn("cbs repayment backfill: account filled a whole page — history may be truncated",
				"casa_account", acct, "page_size", repaymentPageSize)
		}
		res.Pages++
		res.Scanned += len(rows)
		raws = append(raws, rows...)
	}
	trackDates(raws, &res)
	return writeLegs(ctx, db, resolveLegs(classifyLegs(raws, &res), loans, &res), &res, "")
}

// ── fetching ─────────────────────────────────────────────────────────────────

// walkWindow pages the global feed newest-first and stops at the first page
// whose rows have all fallen below cutoff (an inclusive financialDate floor,
// "YYYY-MM-DD"). The feed is ordered financialDate DESC, so once a page ends
// below the cutoff nothing older can matter.
func walkWindow(ctx context.Context, c *udara.Client, cutoff string, res *RepaymentResult) ([]map[string]any, error) {
	var all []map[string]any
	for page := 1; page <= repaymentMaxPages; page++ {
		q := url.Values{}
		q.Set("PageNumber", strconv.Itoa(page))
		q.Set("PageSize", strconv.Itoa(repaymentPageSize))
		rows, err := fetchCallOver(ctx, c, q)
		if err != nil {
			return nil, err
		}
		if page == 1 && len(rows) == 0 {
			// The live ledger is never empty. An empty first page is a failed
			// fetch wearing a 200, which is exactly how the loan book got wiped
			// (see guardRefresh). Fail the run rather than report a quiet zero.
			return nil, fmt.Errorf("%w: call-over page 1 returned 0 rows; "+
				"treating as a failed fetch rather than an empty ledger", errRepaymentGuard)
		}
		if len(rows) == 0 {
			break
		}
		res.Pages++
		res.Scanned += len(rows)

		inWindow := 0
		for _, m := range rows {
			if gstr(m, "financialDate") >= cutoff {
				all = append(all, m)
				inWindow++
			}
		}
		trackDates(rows, res)

		// Ordered financialDate DESC: a page with nothing at or after the cutoff
		// means we have walked past the window.
		if inWindow == 0 {
			break
		}
		if len(rows) < repaymentPageSize {
			break // short page = end of ledger
		}
		if page == repaymentMaxPages {
			slog.Warn("cbs repayment capture: hit the page ceiling before reaching the cutoff",
				"max_pages", repaymentMaxPages, "page_size", repaymentPageSize,
				"cutoff", cutoff, "oldest_seen", res.OldestDate)
		}
	}
	return all, nil
}

// fetchCallOver performs one authenticated GET against the call-over report.
// GET only — this package never issues a write verb to Udara.
func fetchCallOver(ctx context.Context, c *udara.Client, q url.Values) ([]map[string]any, error) {
	raw, code, err := c.Do(ctx, "GET", callOverPath, nil, q)
	if err != nil {
		return nil, fmt.Errorf("cbs call-over %s: %w", q.Encode(), err)
	}
	if code < 200 || code >= 300 {
		return nil, fmt.Errorf("cbs call-over %s: HTTP %d: %s", q.Encode(), code, truncate(raw, 300))
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("cbs call-over %s: parse envelope: %w", q.Encode(), err)
	}
	items, err := extractItems(env.Data)
	if err != nil {
		return nil, fmt.Errorf("cbs call-over %s: parse data: %w; head=%s",
			q.Encode(), err, truncate(env.Data, 240))
	}
	return items, nil
}

// trackDates keeps the oldest/newest financialDate seen, for the run summary.
func trackDates(rows []map[string]any, res *RepaymentResult) {
	for _, m := range rows {
		d := gstr(m, "financialDate")
		if d == "" {
			continue
		}
		if res.OldestDate == "" || d < res.OldestDate {
			res.OldestDate = d
		}
		if res.NewestDate == "" || d > res.NewestDate {
			res.NewestDate = d
		}
	}
}

// ── classification ───────────────────────────────────────────────────────────

// classifyLegs keeps only the customer-side debit legs of a loan repayment and
// turns them into ledgerLegs. Everything else — the GL contra legs, deposits,
// journals, disbursements, accrual reversals — is dropped silently, because the
// feed is the whole bank's ledger and 5,643 of its 5,682 rows are not ours.
func classifyLegs(rows []map[string]any, res *RepaymentResult) []ledgerLeg {
	var out []ledgerLeg
	for _, m := range rows {
		code := strings.ToUpper(strings.TrimSpace(gstr(m, "entryCode")))
		component, ok := componentOf(code)
		if !ok {
			continue
		}
		res.Legs++

		amt, err := koboOf(gstr(m, "amount"))
		if err != nil {
			slog.Warn("cbs repayment capture: unparseable amount, leg skipped",
				"entry_code", code, "posting_reference", gstr(m, "postingReferenceNumber"),
				"account", gstr(m, "accountNumber"), "amount", gstr(m, "amount"), "err", err)
			continue
		}
		if amt == 0 {
			slog.Warn("cbs repayment capture: zero-amount leg skipped",
				"entry_code", code, "posting_reference", gstr(m, "postingReferenceNumber"),
				"account", gstr(m, "accountNumber"))
			continue
		}
		// A reversal is a negative repayment. None has been observed in the
		// ledger to date (the only R-prefixed loan codes present are RD-LIAP1 /
		// RC-LIAP1, which reverse an interest ACCRUAL, and D-RLPDP / C-RLPDP,
		// which reverse a disbursement) — so this branch is unverified against
		// real data and says so loudly when it first fires.
		if isReversal(code) {
			amt = -amt
			slog.Warn("cbs repayment capture: REVERSAL leg captured as a negative repayment — "+
				"this classification has never been exercised against real data, please audit",
				"entry_code", code, "posting_reference", gstr(m, "postingReferenceNumber"),
				"account", gstr(m, "accountNumber"), "amount_kobo", amt)
		}

		raw, _ := json.Marshal(m)
		out = append(out, ledgerLeg{
			Key:         ledgerKey(m),
			CASAAccount: strings.TrimSpace(gstr(m, "accountNumber")),
			EntryCode:   code,
			Component:   component,
			AmountKobo:  amt,
			FinDate:     gstr(m, "financialDate"),
			PostedAt:    parsePostedAt(gstr(m, "transactionDate")),
			PostingRef:  strings.TrimSpace(gstr(m, "postingReferenceNumber")),
			Instrument:  strings.TrimSpace(gstr(m, "instrumentNumber")),
			Narration:   gstr(m, "narration"),
			Raw:         raw,
		})
	}
	return out
}

// componentOf maps a raw entry code to principal/interest, tolerating the
// reversal prefixes Udara uses ("RD-LPOP") and infixes ("D-RLPOP").
func componentOf(code string) (string, bool) {
	base := strings.TrimPrefix(code, "R")      // RD-LPOP  -> D-LPOP
	base = strings.Replace(base, "-R", "-", 1) // D-RLPOP  -> D-LPOP
	switch {
	case principalCodes[base]:
		return "principal", true
	case interestCodes[base]:
		return "interest", true
	}
	return "", false
}

func isReversal(code string) bool {
	return strings.HasPrefix(code, "R") || strings.Contains(code, "-R")
}

// koboOf parses a ledger amount. Every one of the 5,682 amounts in the ledger
// matches ^\d+\.00$: the integer part IS the kobo value and the two decimals
// are zero padding, never sub-kobo. A non-zero fraction would mean the ledger's
// unit assumption has changed, so it is refused rather than rounded away.
func koboOf(s string) (int64, error) {
	s = strings.TrimSpace(strings.ReplaceAll(s, ",", ""))
	if s == "" {
		return 0, fmt.Errorf("empty amount")
	}
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	whole, frac, hasFrac := strings.Cut(s, ".")
	if hasFrac && strings.Trim(frac, "0") != "" {
		return 0, fmt.Errorf("amount %q carries a non-zero fraction; ledger amounts are kobo "+
			"and have always been whole — refusing to round", s)
	}
	n, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("amount %q: %w", s, err)
	}
	if neg {
		n = -n
	}
	return n, nil
}

// parsePostedAt parses transactionDate. Udara emits a bare local timestamp with
// a variable-length fractional second ("2026-09-18T15:06:31.92" and
// "...T14:09:54.3666667" both occur), and no zone.
func parsePostedAt(s string) sql.NullTime {
	s = strings.TrimSpace(s)
	if s == "" {
		return sql.NullTime{}
	}
	for _, layout := range []string{
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02",
	} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return sql.NullTime{Time: t, Valid: true}
		}
	}
	slog.Warn("cbs repayment capture: unparseable transactionDate", "value", s)
	return sql.NullTime{}
}

// ledgerKey is the idempotency key: a sha256 over the six stable fields of a
// call-over entry. Re-reading an overlapping window produces byte-identical
// input and therefore the same key, so ON CONFLICT DO NOTHING absorbs it.
//
// Verified against the entire ledger: 39 capturable legs, 39 distinct keys, 0
// collisions — and still 0 with instrumentNumber removed, so the key has room.
func ledgerKey(m map[string]any) string {
	h := sha256.Sum256([]byte(strings.Join([]string{
		strings.TrimSpace(gstr(m, "postingReferenceNumber")),
		strings.ToUpper(strings.TrimSpace(gstr(m, "entryCode"))),
		strings.TrimSpace(gstr(m, "accountNumber")),
		strings.TrimSpace(gstr(m, "financialDate")),
		strings.TrimSpace(gstr(m, "amount")),
		strings.TrimSpace(gstr(m, "instrumentNumber")),
	}, "|")))
	return hex.EncodeToString(h[:])
}

// ── resolving the loan account ───────────────────────────────────────────────

// resolveLegs attaches a cbs_loans account number to each leg.
//
// The loan account is NOT the leg's accountNumber — the leg debits the
// customer's CASA. It is the trailing segment of the narration:
//
//	"Loan Interest Repayment Recovered - BA2609110017 - FINTRAK - 21000004240"
//	"Full Repayment - Loan Principal Repayment - NASSCOOP SOCIETY LTD - 21000005970"
//
// All 39 legs in the ledger yield a numeric tail and all 39 tails exist in
// cbs_loans.cbs_account_number, so this is the primary key path. The CASA
// fallback is only a safety net and is deliberately NOT used when the CASA maps
// to more than one loan: 1000005509 serves both 1200045402000005530 and
// ...5531, and guessing between them would silently attribute money to the
// wrong loan.
func resolveLegs(legs []ledgerLeg, loans loanIndex, res *RepaymentResult) []ledgerLeg {
	var out []ledgerLeg
	for _, leg := range legs {
		tail := narrationTail(leg.Narration)
		switch {
		case tail != "" && loans.byAccount[tail]:
			leg.LoanAccount = tail

		case tail != "":
			// A numeric tail that is not in the book: a loan the snapshot has
			// not synced, or a renumbered account. Keep the row (the money is
			// real) but flag it.
			leg.LoanAccount = tail
			res.Unmatched++
			slog.Warn("cbs repayment capture: narration loan account is not in cbs_loans",
				"loan_account", tail, "casa_account", leg.CASAAccount,
				"entry_code", leg.EntryCode, "posting_reference", leg.PostingRef,
				"financial_date", leg.FinDate, "amount_kobo", leg.AmountKobo)

		default:
			// No usable tail. Fall back to the CASA link only when it is
			// unambiguous.
			if cands := loans.byCASA[leg.CASAAccount]; len(cands) == 1 {
				leg.LoanAccount = cands[0]
				slog.Warn("cbs repayment capture: no loan account in narration, resolved via the "+
					"unique linked CASA account",
					"casa_account", leg.CASAAccount, "loan_account", leg.LoanAccount,
					"entry_code", leg.EntryCode, "posting_reference", leg.PostingRef,
					"narration", leg.Narration)
			} else {
				res.Unmatched++
				slog.Error("cbs repayment capture: cannot attribute a repayment to a loan — "+
					"row stored unattributed",
					"casa_account", leg.CASAAccount, "casa_loan_candidates", len(cands),
					"entry_code", leg.EntryCode, "posting_reference", leg.PostingRef,
					"financial_date", leg.FinDate, "amount_kobo", leg.AmountKobo,
					"narration", leg.Narration)
			}
		}
		out = append(out, leg)
	}
	return out
}

// narrationTail returns the segment after the last " - " when it looks like an
// account number.
func narrationTail(s string) string {
	i := strings.LastIndex(s, " - ")
	if i < 0 {
		return ""
	}
	tail := strings.TrimSpace(s[i+3:])
	if !loanAcctRe.MatchString(tail) {
		return ""
	}
	return tail
}

// ── database ─────────────────────────────────────────────────────────────────

type loanIndex struct {
	byAccount map[string]bool     // cbs_account_number -> exists
	byCASA    map[string][]string // linked_account -> loan accounts it serves
}

// loadLoanAccounts indexes the loan book. btrim on BOTH sides everywhere the
// CBS is joined — Udara seeds trailing spaces (see cbs_officer_map).
func loadLoanAccounts(ctx context.Context, db *core.DB) (loanIndex, error) {
	idx := loanIndex{byAccount: map[string]bool{}, byCASA: map[string][]string{}}
	rows, err := db.PG.QueryContext(ctx,
		`SELECT btrim(COALESCE(cbs_account_number,'')), btrim(COALESCE(linked_account,''))
		   FROM app.cbs_loans`)
	if err != nil {
		return idx, fmt.Errorf("cbs repayment capture: load loan accounts: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		var acct, casa string
		if err := rows.Scan(&acct, &casa); err != nil {
			return idx, fmt.Errorf("cbs repayment capture: scan loan accounts: %w", err)
		}
		if acct != "" {
			idx.byAccount[acct] = true
			if casa != "" {
				idx.byCASA[casa] = append(idx.byCASA[casa], acct)
			}
		}
	}
	if err := rows.Err(); err != nil {
		return idx, fmt.Errorf("cbs repayment capture: read loan accounts: %w", err)
	}
	if len(idx.byAccount) == 0 {
		return idx, fmt.Errorf("%w: cbs_loans is empty; refusing to capture repayments that "+
			"could not be attributed to any loan (run the CBS sync first)", errRepaymentGuard)
	}
	return idx, nil
}

// loadCASAAccounts lists the distinct linked CASA accounts the backfill sweeps.
func loadCASAAccounts(ctx context.Context, db *core.DB) ([]string, error) {
	rows, err := db.PG.QueryContext(ctx,
		`SELECT DISTINCT btrim(linked_account) FROM app.cbs_loans
		  WHERE btrim(COALESCE(linked_account,'')) <> '' ORDER BY 1`)
	if err != nil {
		return nil, fmt.Errorf("cbs repayment backfill: load CASA accounts: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	var out []string
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			return nil, fmt.Errorf("cbs repayment backfill: scan CASA accounts: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// requireRepaymentSchema refuses to run until the capture columns exist.
//
// The migration that adds them is owned by the lead session (see
// scratchpad/repayments_schema.sql). Deploying this code first is safe: the run
// stops here, loudly, without touching a row.
func requireRepaymentSchema(ctx context.Context, db *core.DB) error {
	need := []string{
		"ledger_key", "entry_code", "component", "cbs_loan_account", "cbs_casa_account",
		"principal_kobo", "interest_kobo", "posting_reference", "instrument_number",
		"financial_date", "posted_at", "raw",
	}
	rows, err := db.PG.QueryContext(ctx,
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema='app' AND table_name='loan_repayments'`)
	if err != nil {
		return fmt.Errorf("cbs repayment capture: inspect loan_repayments: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	have := map[string]bool{}
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return fmt.Errorf("cbs repayment capture: scan columns: %w", err)
		}
		have[c] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	var missing []string
	for _, c := range need {
		if !have[c] {
			missing = append(missing, c)
		}
	}
	if len(missing) > 0 {
		slog.Error("cbs repayment capture: app.loan_repayments is missing the capture columns — "+
			"apply the migration in scratchpad/repayments_schema.sql; nothing was written",
			"missing", strings.Join(missing, ","))
		return fmt.Errorf("%w: app.loan_repayments is missing column(s): %s",
			errRepaymentGuard, strings.Join(missing, ", "))
	}

	// application_id must be nullable — a CBS ledger repayment has no workspace
	// loan application to point at (app.loan_applications holds 8 rows, none
	// reconcilable to the CBS book).
	var nullable string
	if err := db.PG.QueryRowContext(ctx,
		`SELECT is_nullable FROM information_schema.columns
		  WHERE table_schema='app' AND table_name='loan_repayments' AND column_name='application_id'`,
	).Scan(&nullable); err != nil {
		return fmt.Errorf("cbs repayment capture: inspect application_id: %w", err)
	}
	if nullable != "YES" {
		slog.Error("cbs repayment capture: app.loan_repayments.application_id is still NOT NULL — " +
			"a CBS ledger repayment has no workspace loan application; apply the migration in " +
			"scratchpad/repayments_schema.sql; nothing was written")
		return fmt.Errorf("%w: app.loan_repayments.application_id is NOT NULL", errRepaymentGuard)
	}
	return nil
}

// guardLegCount is the guardRefresh analogue for this capture.
//
// Capture is insert-only, so unlike the snapshot refreshes it cannot empty or
// gut the table however bad the response is. What it CAN do is quietly stop
// seeing repayments — Udara renames an entry code, the report drops a column,
// the classification stops matching — and an insert-only job then reports a
// cheerful "0 new" forever. So a run refuses to proceed when the window comes
// back holding materially fewer legs than are already stored for that same
// window, using sync.go's own thresholds.
func guardLegCount(ctx context.Context, db *core.DB, incoming int, cutoff string) error {
	if cutoff == "" {
		return nil // the backfill spans everything; there is no window to compare
	}
	var before int
	if err := db.PG.QueryRowContext(ctx,
		`SELECT count(*) FROM app.loan_repayments
		  WHERE channel = $1 AND financial_date >= $2::date`,
		repaymentChannel, cutoff).Scan(&before); err != nil {
		return fmt.Errorf("cbs repayment capture: count held legs: %w", err)
	}
	if before == 0 || incoming >= before {
		return nil
	}
	if envBool("CBS_SYNC_ALLOW_SHRINK") {
		slog.Warn("cbs repayment capture: leg shrink allowed by CBS_SYNC_ALLOW_SHRINK",
			"window_from", cutoff, "held", before, "incoming", incoming)
		return nil
	}
	if drop := before - incoming; drop > shrinkAllowance(before) {
		slog.Error("cbs repayment capture: the ledger window returned far fewer repayment legs "+
			"than are already stored for it — refusing to write; check whether Udara changed "+
			"the call-over entry codes",
			"window_from", cutoff, "held", before, "incoming", incoming, "drop", drop,
			"allowed", shrinkAllowance(before))
		return fmt.Errorf("%w: window from %s returned %d legs against %d already held "+
			"(-%d, beyond the allowed %d); refusing to write (set CBS_SYNC_ALLOW_SHRINK=1 to force)",
			errRepaymentGuard, cutoff, incoming, before, drop, shrinkAllowance(before))
	}
	return nil
}

// writeLegs inserts the legs. INSERT-ONLY: no DELETE, no UPDATE, ON CONFLICT
// DO NOTHING on the ledger_key unique index. Re-running over an overlapping
// window is therefore a no-op, which is the whole point of the hourly job.
//
// One row per ledger leg, not one per payment. A payment of principal and
// interest lands as two rows sharing a postingReferenceNumber. That keeps the
// idempotency key 1:1 with a real GL entry and keeps entry_code auditable;
// callers that want the payment total group by posting_reference.
func writeLegs(ctx context.Context, db *core.DB, legs []ledgerLeg, res *RepaymentResult, cutoff string) (RepaymentResult, error) {
	if err := guardLegCount(ctx, db, len(legs), cutoff); err != nil {
		return *res, err
	}
	if len(legs) == 0 {
		return *res, nil
	}

	tx, err := db.PG.BeginTx(ctx, nil)
	if err != nil {
		return *res, fmt.Errorf("cbs repayment capture: begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	// These rows ARE the general ledger, mirrored from the core banking system;
	// they are not a workspace posting that needs its own gl_journal_entries
	// row. app._check_gl_journal already honours this opt-out (it only WARNs
	// either way, but a per-row warning on every hourly run is noise that would
	// bury the real ones).
	if _, err := tx.ExecContext(ctx, `SET LOCAL app.skip_gl_check = 'true'`); err != nil {
		return *res, fmt.Errorf("cbs repayment capture: set skip_gl_check: %w", err)
	}

	const q = `
		INSERT INTO app.loan_repayments
		    (application_id, loan_id, amount_kobo, principal_kobo, interest_kobo,
		     payment_date, financial_date, posted_at, channel, payment_method,
		     reference, posting_reference, instrument_number, entry_code, component,
		     cbs_loan_account, cbs_casa_account, ledger_key, notes, raw, created_at)
		VALUES
		    (NULL, NULL, $1, $2, $3,
		     $4::date, $4::date, $5, $6, 'gl_posting',
		     $7, $7, $8, $9, $10,
		     NULLIF($11,''), NULLIF($12,''), $13, $14, $15::jsonb, NOW())
		ON CONFLICT (ledger_key) WHERE ledger_key IS NOT NULL DO NOTHING`

	stmt, err := tx.PrepareContext(ctx, q)
	if err != nil {
		return *res, fmt.Errorf("cbs repayment capture: prepare insert: %w", err)
	}
	defer stmt.Close() //nolint:errcheck

	for _, leg := range legs {
		var principal, interest int64
		if leg.Component == "principal" {
			principal = leg.AmountKobo
		} else {
			interest = leg.AmountKobo
		}
		out, err := stmt.ExecContext(ctx,
			leg.AmountKobo, principal, interest,
			leg.FinDate, leg.PostedAt, repaymentChannel,
			leg.PostingRef, leg.Instrument, leg.EntryCode, leg.Component,
			leg.LoanAccount, leg.CASAAccount, leg.Key, leg.Narration, string(leg.Raw))
		if err != nil {
			return *res, fmt.Errorf("cbs repayment capture: insert leg %s/%s (%s %s): %w",
				leg.PostingRef, leg.EntryCode, leg.FinDate, leg.LoanAccount, err)
		}
		n, _ := out.RowsAffected()
		if n == 0 {
			res.Duplicate++
			continue
		}
		res.Inserted++
		if leg.Component == "principal" {
			res.PrincipalKobo += leg.AmountKobo
		} else {
			res.InterestKobo += leg.AmountKobo
		}
	}

	if err := tx.Commit(); err != nil {
		return *res, fmt.Errorf("cbs repayment capture: commit: %w", err)
	}
	return *res, nil
}

// repaymentBeat mirrors handlers.WorkerBeat. cbssync cannot import handlers
// (handlers imports cbssync), so the same upsert is issued directly; the
// statements are kept identical to handlers/workers.go so the Worker Hub reads
// this worker exactly like the others.
func repaymentBeat(ctx context.Context, db *core.DB, phase, detail, errStr string) {
	switch phase {
	case "running":
		db.PGExec(ctx, `INSERT INTO worker_heartbeats (worker_key, status, last_started_at, updated_at)
			VALUES ($1,'running',NOW(),NOW())
			ON CONFLICT (worker_key) DO UPDATE SET status='running', last_started_at=NOW(), updated_at=NOW()`,
			repaymentWorkerKey) //nolint:errcheck
	case "ok":
		db.PGExec(ctx, `INSERT INTO worker_heartbeats (worker_key, status, last_finished_at, last_ok_at, detail, last_error, runs_total, updated_at)
			VALUES ($1,'ok',NOW(),NOW(),NULLIF($2,''),NULL,1,NOW())
			ON CONFLICT (worker_key) DO UPDATE SET status='ok', last_finished_at=NOW(), last_ok_at=NOW(),
			    detail=NULLIF($2,''), last_error=NULL, runs_total=worker_heartbeats.runs_total+1, updated_at=NOW()`,
			repaymentWorkerKey, detail) //nolint:errcheck
	case "error":
		db.PGExec(ctx, `INSERT INTO worker_heartbeats (worker_key, status, last_finished_at, last_error, detail, runs_total, updated_at)
			VALUES ($1,'error',NOW(),NULLIF($2,''),NULLIF($3,''),1,NOW())
			ON CONFLICT (worker_key) DO UPDATE SET status='error', last_finished_at=NOW(),
			    last_error=NULLIF($2,''), detail=NULLIF($3,''), runs_total=worker_heartbeats.runs_total+1, updated_at=NOW()`,
			repaymentWorkerKey, errStr, detail) //nolint:errcheck
	}
}

// ── configuration ────────────────────────────────────────────────────────────

// repaymentInterval reads CBS_REPAYMENT_INTERVAL (a Go duration, e.g. "30m").
// Default 1h. Zero or negative disables the scheduled run.
func repaymentInterval() time.Duration {
	raw := strings.TrimSpace(os.Getenv("CBS_REPAYMENT_INTERVAL"))
	if raw == "" {
		return time.Hour
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		slog.Warn("cbs repayment capture: bad CBS_REPAYMENT_INTERVAL, using 1h", "value", raw, "err", err)
		return time.Hour
	}
	return d
}

// lookbackDays reads CBS_REPAYMENT_LOOKBACK_DAYS. Default 45 — see the header
// for why a short window silently loses most repayments on this system.
func lookbackDays() int {
	n := envInt("CBS_REPAYMENT_LOOKBACK_DAYS", defaultLookbackDays)
	if n <= 0 {
		return defaultLookbackDays
	}
	return n
}
