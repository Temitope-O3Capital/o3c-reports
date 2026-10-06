package cbssync

// Full-ledger capture from the Udara360 GL call-over report, for the finance model
// (branch-split Balance Sheet / Income Statement / Cash Flow).
//
// RELATIONSHIP TO repayments.go
// ------------------------------
// repayments.go already reads this exact endpoint, but narrowly: only the customer-debit
// leg of a loan repayment, because its whole job is "what did a customer pay". That scope
// is wrong here. A branch-split P&L needs FD placements, FD interest, fees, withholding
// tax and the GL-to-GL journals too, and it needs BOTH legs of every entry (the debit and
// the credit), because a branch's receivable total has to reconcile against whatever
// produced it. So this file duplicates the fetch/windowing shape of repayments.go
// (deliberately -- see fetchCallOver/walkWindow there, which this mirrors) but classifies
// and writes every leg, not a filtered nine.
//
// Everything in repayments.go's header about the source endpoint applies unchanged here:
// no server-side date filter works, recordCount is always 0 and must not be trusted,
// amounts are kobo with no sub-kobo fractions, and financialDate lags transactionDate by
// a median of ~17 days (max observed 75) -- see defaultLookbackDays there for why the
// window has to be wide. This job reuses the same lookback knob rather than inventing a
// second one.
//
// BRANCH, VERIFIED LIVE 2026-10-06 (not from our DB mirror)
// -----------------------------------------------------------
// Every row on this feed carries `branch`. Full ledger at that date: 6,745 raw rows, 6,643
// after removing exact posting duplicates, 2026-07-01..2026-10-02 (Udara's own ceiling).
// Branch split: 6,158 Head Office Branch (92.7%) / 485 Abuja Branch (7.3%). Stored exactly
// as Udara returns it -- 'Head Office Branch' / 'Abuja Branch' -- translation to
// "Lagos"/"Abuja" is a display concern, handled where the finance views/handlers read this
// table, not here.
//
// WHY INSERT-ONLY, BOTH LEGS, NO FILTERING BY CODE
// --------------------------------------------------
// repayments.go captures nine specific codes because it needs an auditable principal/
// interest split for a repayment. This table has a different job -- "every kobo that moved
// through branch X's book" -- so filtering by entry code here would just recreate the same
// narrow-scope problem one layer down. Classification (product_category) is recorded for
// querying, not for exclusion: every row Udara returns is written.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/udara"
)

const (
	glPostingsPageSize = 500
	glPostingsMaxPages = 60
	glPostingsWorkerKey = "cbs_gl_postings_capture"
)

// GLPostingsResult summarises one capture run.
type GLPostingsResult struct {
	Pages      int
	Scanned    int
	Inserted   int
	Duplicate  int
	OldestDate string
	NewestDate string
}

// StartGLPostingsWorker runs SyncGLPostings shortly after boot and then on the same
// interval as the repayment capture (CBS_REPAYMENT_INTERVAL, default 1h) -- both jobs hit
// the same endpoint under the same windowing assumptions, so one knob governs both rather
// than inventing a second that would need to be kept in step by hand.
func StartGLPostingsWorker(c *udara.Client, db *core.DB) {
	if c == nil || !c.IsConfigured() {
		slog.Info("CBS GL postings capture disabled (Udara360 not configured)")
		return
	}
	interval := glPostingsInterval()
	if interval <= 0 {
		slog.Info("CBS GL postings capture disabled (CBS_GL_POSTINGS_INTERVAL <= 0)")
		return
	}

	runOnce := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		defer cancel()
		glPostingsBeat(ctx, db, "running", "", "")

		res, err := SyncGLPostings(ctx, c, db)
		if err != nil {
			slog.Error("CBS GL postings capture failed",
				"pages", res.Pages, "scanned", res.Scanned, "err", err)
			glPostingsBeat(ctx, db, "error", "", err.Error())
			return
		}
		detail := fmt.Sprintf("%d scanned, %d new, %d already held (%s..%s)",
			res.Scanned, res.Inserted, res.Duplicate, res.OldestDate, res.NewestDate)
		slog.Info("CBS GL postings capture ok",
			"pages", res.Pages, "scanned", res.Scanned, "inserted", res.Inserted,
			"duplicate", res.Duplicate, "window", res.OldestDate+".."+res.NewestDate)
		glPostingsBeat(ctx, db, "ok", detail, "")
	}

	// Let the repayment worker's 90s settle period pass first; both hit the same endpoint
	// and there is no reason to race it on every boot.
	time.Sleep(150 * time.Second)
	runOnce()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		runOnce()
	}
}

// SyncGLPostings walks the global call-over feed newest-first over the configured
// lookback window and writes every leg (both debit and credit) it finds.
func SyncGLPostings(ctx context.Context, c *udara.Client, db *core.DB) (GLPostingsResult, error) {
	var res GLPostingsResult
	if c == nil || !c.IsConfigured() {
		return res, fmt.Errorf("cbs gl postings capture: udara client not configured")
	}

	cutoff := time.Now().AddDate(0, 0, -lookbackDays()).Format("2006-01-02")
	rows, err := glWalkWindow(ctx, c, cutoff, &res)
	if err != nil {
		return res, err
	}
	return writeGLPostings(ctx, db, classifyGLRows(rows), &res)
}

// glWalkWindow mirrors repayments.go's walkWindow exactly (same endpoint, same ordering,
// same "empty page 1 is a failed fetch" guard) -- duplicated rather than shared because
// the two files are independent capture jobs with independent failure/backfill stories,
// and sharing a helper across them would couple their windowing behaviour by accident.
func glWalkWindow(ctx context.Context, c *udara.Client, cutoff string, res *GLPostingsResult) ([]map[string]any, error) {
	var all []map[string]any
	for page := 1; page <= glPostingsMaxPages; page++ {
		q := url.Values{}
		q.Set("PageNumber", strconv.Itoa(page))
		q.Set("PageSize", strconv.Itoa(glPostingsPageSize))
		rows, err := fetchCallOver(ctx, c, q)
		if err != nil {
			return nil, err
		}
		if page == 1 && len(rows) == 0 {
			return nil, fmt.Errorf("%w: call-over page 1 returned 0 rows; treating as a failed "+
				"fetch rather than an empty ledger", errRepaymentGuard)
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
		if inWindow == 0 {
			break
		}
		if len(rows) < glPostingsPageSize {
			break
		}
		if page == glPostingsMaxPages {
			slog.Warn("cbs gl postings capture: hit the page ceiling before reaching the cutoff",
				"max_pages", glPostingsMaxPages, "cutoff", cutoff, "oldest_seen", res.OldestDate)
		}
	}
	return all, nil
}

// glPosting is one classified, validated call-over row ready to be written -- one row per
// leg (debit or credit), not one per payment/entry.
type glPosting struct {
	FinDate     string
	PostedAt    *time.Time
	AccountNum  string
	AccountName string
	Branch      string
	EntryCode   string
	Side        string
	AmountKobo  int64
	PostingRef  string
	Instrument  string
	Narration   string
	InitiatedBy string
	ApprovedBy  string
	Category    string
	LoanAccount string
	Key         string
	Raw         []byte
}

// glCategoryOf classifies an entry code into the broad bucket a finance report groups by.
// Based on the full live entry-code catalogue pulled 2026-10-06 (49 distinct codes).
func glCategoryOf(code string) string {
	base := strings.TrimPrefix(strings.TrimPrefix(code, "RD-"), "RC-")
	base = strings.TrimPrefix(strings.TrimPrefix(base, "D-"), "C-")
	switch {
	case strings.HasPrefix(base, "LP"), strings.HasPrefix(base, "LI"):
		return "loan" // LPOP/LPRP/LPDP/RLPDP, LIOP1A/LIOP1B/LIRP1/LIDT/LIAP1
	case strings.HasPrefix(base, "FD"):
		return "fixed_deposit" // FDPP/FDPL/FDPR/FDIU/FDIF/FDIL/FDIP/FDIR
	case base == "WHTP":
		return "withholding_tax"
	case base == "JRNL":
		return "journal"
	case base == "IBRH":
		return "interbank"
	case base == "CSHW", base == "BCSH":
		return "cash"
	default:
		return "other"
	}
}

// glSideOf reports which leg of the double entry this row is. Udara prefixes every entry
// code with D- (debit) or C- (credit), with an R- infix/prefix for a reversal of either
// (RD-.../RC-...) -- the side the reversal undoes, not a third side.
func glSideOf(code string) string {
	c := strings.TrimPrefix(code, "R")
	if strings.HasPrefix(c, "D-") {
		return "debit"
	}
	return "credit"
}

func classifyGLRows(rows []map[string]any) []glPosting {
	out := make([]glPosting, 0, len(rows))
	for _, m := range rows {
		code := strings.ToUpper(strings.TrimSpace(gstr(m, "entryCode")))
		amt, err := koboOf(gstr(m, "amount"))
		if err != nil {
			slog.Warn("cbs gl postings capture: unparseable amount, row skipped",
				"entry_code", code, "posting_reference", gstr(m, "postingReferenceNumber"), "err", err)
			continue
		}
		if amt < 0 {
			amt = -amt // the table's CHECK is >= 0; side+entry_code already carry direction
		}
		if amt == 0 {
			continue
		}
		raw, _ := json.Marshal(m)
		posted := parsePostedAt(gstr(m, "transactionDate"))
		var postedPtr *time.Time
		if posted.Valid {
			t := posted.Time
			postedPtr = &t
		}
		out = append(out, glPosting{
			FinDate:     gstr(m, "financialDate"),
			PostedAt:    postedPtr,
			AccountNum:  strings.TrimSpace(gstr(m, "accountNumber")),
			AccountName: gstr(m, "accountName"),
			Branch:      strings.TrimSpace(gstr(m, "branch")),
			EntryCode:   code,
			Side:        glSideOf(code),
			AmountKobo:  amt,
			PostingRef:  strings.TrimSpace(gstr(m, "postingReferenceNumber")),
			Instrument:  strings.TrimSpace(gstr(m, "instrumentNumber")),
			Narration:   gstr(m, "narration"),
			InitiatedBy: gstr(m, "initiatedBy"),
			ApprovedBy:  gstr(m, "approvedBy"),
			Category:    glCategoryOf(code),
			LoanAccount: narrationTail(gstr(m, "narration")),
			Key:         glLedgerKey(m),
			Raw:         raw,
		})
	}
	return out
}

// glLedgerKey mirrors repayments.go's ledgerKey but also folds in `side` -- this table
// stores both legs of an entry, which repayments.go never needed to disambiguate.
func glLedgerKey(m map[string]any) string {
	code := strings.ToUpper(strings.TrimSpace(gstr(m, "entryCode")))
	h := sha256.Sum256([]byte(strings.Join([]string{
		strings.TrimSpace(gstr(m, "postingReferenceNumber")),
		code,
		strings.TrimSpace(gstr(m, "accountNumber")),
		strings.TrimSpace(gstr(m, "financialDate")),
		strings.TrimSpace(gstr(m, "amount")),
		strings.TrimSpace(gstr(m, "instrumentNumber")),
		glSideOf(code),
	}, "|")))
	return hex.EncodeToString(h[:])
}

func writeGLPostings(ctx context.Context, db *core.DB, postings []glPosting, res *GLPostingsResult) (GLPostingsResult, error) {
	if len(postings) == 0 {
		return *res, nil
	}
	tx, err := db.PG.BeginTx(ctx, nil)
	if err != nil {
		return *res, fmt.Errorf("cbs gl postings capture: begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	const q = `
		INSERT INTO app.cbs_gl_postings
		    (financial_date, posted_at, account_number, account_name, branch_name,
		     entry_code, side, amount_kobo, posting_reference, instrument_number,
		     narration, initiated_by, approved_by, product_category, cbs_loan_account,
		     ledger_key, raw)
		VALUES
		    ($1::date, $2, $3, $4, $5,
		     $6, $7, $8, $9, $10,
		     $11, $12, $13, $14, NULLIF($15,''),
		     $16, $17::jsonb)
		ON CONFLICT (ledger_key) DO NOTHING`

	stmt, err := tx.PrepareContext(ctx, q)
	if err != nil {
		return *res, fmt.Errorf("cbs gl postings capture: prepare insert: %w", err)
	}
	defer stmt.Close() //nolint:errcheck

	for _, p := range postings {
		out, err := stmt.ExecContext(ctx,
			p.FinDate, p.PostedAt, p.AccountNum, p.AccountName, p.Branch,
			p.EntryCode, p.Side, p.AmountKobo, p.PostingRef, p.Instrument,
			p.Narration, p.InitiatedBy, p.ApprovedBy, p.Category, p.LoanAccount,
			p.Key, string(p.Raw))
		if err != nil {
			return *res, fmt.Errorf("cbs gl postings capture: insert %s/%s (%s): %w",
				p.PostingRef, p.EntryCode, p.FinDate, err)
		}
		n, _ := out.RowsAffected()
		if n == 0 {
			res.Duplicate++
			continue
		}
		res.Inserted++
	}
	if err := tx.Commit(); err != nil {
		return *res, fmt.Errorf("cbs gl postings capture: commit: %w", err)
	}
	return *res, nil
}

func glPostingsBeat(ctx context.Context, db *core.DB, phase, detail, errStr string) {
	switch phase {
	case "running":
		db.PGExec(ctx, `INSERT INTO worker_heartbeats (worker_key, status, last_started_at, updated_at)
			VALUES ($1,'running',NOW(),NOW())
			ON CONFLICT (worker_key) DO UPDATE SET status='running', last_started_at=NOW(), updated_at=NOW()`,
			glPostingsWorkerKey) //nolint:errcheck
	case "ok":
		db.PGExec(ctx, `INSERT INTO worker_heartbeats (worker_key, status, last_finished_at, last_ok_at, detail, last_error, runs_total, updated_at)
			VALUES ($1,'ok',NOW(),NOW(),NULLIF($2,''),NULL,1,NOW())
			ON CONFLICT (worker_key) DO UPDATE SET status='ok', last_finished_at=NOW(), last_ok_at=NOW(),
			    detail=NULLIF($2,''), last_error=NULL, runs_total=worker_heartbeats.runs_total+1, updated_at=NOW()`,
			glPostingsWorkerKey, detail) //nolint:errcheck
	case "error":
		db.PGExec(ctx, `INSERT INTO worker_heartbeats (worker_key, status, last_finished_at, last_error, detail, runs_total, updated_at)
			VALUES ($1,'error',NOW(),NULLIF($2,''),NULLIF($3,''),1,NOW())
			ON CONFLICT (worker_key) DO UPDATE SET status='error', last_finished_at=NOW(),
			    last_error=NULLIF($2,''), detail=NULLIF($3,''), runs_total=worker_heartbeats.runs_total+1, updated_at=NOW()`,
			glPostingsWorkerKey, errStr, detail) //nolint:errcheck
	}
}

func glPostingsInterval() time.Duration {
	return repaymentInterval() // same knob family; CBS_REPAYMENT_INTERVAL governs both
}
