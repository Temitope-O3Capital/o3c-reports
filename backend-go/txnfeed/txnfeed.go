// Package txnfeed ingests the 15-minute txn_file (txnlist_file.*) drops into
// app.transactions.
//
// The design that matters (docs/DATA_FEED_INGESTION.md §3.3, and the 2026-08-10
// catch-up that validated it):
//
//   - The 1.02M-row baseline overlaps the feed and every baseline row has row_hash
//     NULL, so a transaction is deduped against the baseline by NATURAL KEY, never by
//     row_hash: (account_no, post_date, txn_date, txn_code, ABS(amount), trace). ABS is
//     essential — the feed carries positive magnitudes, the DB stores a SIGNED amount
//     (negative = money-in/credit). A feed row is inserted only when that key is not
//     already present, so the baseline is neither duplicated nor mutated (no backfill,
//     no deletes). Gaps the feed happens to cover (e.g. a missing month) fill naturally.
//   - money_in is derived from txn_code (402/422), NOT the unreliable feed field 15.
//     money_in ⇒ amount negative, amount_credit = magnitude; otherwise amount positive,
//     amount_debit = magnitude — matching the baseline convention.
//   - row_hash (feed rows only) makes re-reading a file idempotent: it folds the file
//     row-sequence in so two genuinely-distinct identical-looking rows in one window are
//     both kept, while a re-read of the same file conflicts and is skipped.
package txnfeed

import (
	"context"
	"crypto/md5"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/feedcore"
)

// Stream is the txn_file → app.transactions feed. Files are named txnlist_file.*.
var Stream = feedcore.Stream{Name: "transactions", SubDir: "txn_file", Prefix: "txnlist_file"}

// Configured reports whether the txn_file folder is mounted.
func Configured() bool { return Stream.Configured() }

// Run ingests every txn_file not yet processed.
func Run(ctx context.Context, db *core.DB, kind string, triggeredBy sql.NullInt64) (feedcore.Result, error) {
	return feedcore.Run(ctx, db, Stream, kind, triggeredBy, Apply)
}

const fieldCount = 16

// moneyInCodes are the transaction codes the baseline flags as money-in (credit). Kept
// deliberately narrow to the two high-volume, confirmed codes so a debit is never
// wrongly negated; other collection codes are rare and stay debit-signed.
var moneyInCodes = map[string]bool{"402": true, "422": true}

// Txn is one decoded txn_file row (§3.3). Amount is the positive magnitude from the feed.
type Txn struct {
	PostDate    time.Time
	TxnDate     time.Time
	Code        string
	AmountMag   float64
	Description string
	AccountNo   string
	PAN         string
	Trace       string
	Merchant    string
	MCC         string
	City        string
	RowSeq      string
}

// MoneyIn reports whether the code is a money-in (credit).
func (t Txn) MoneyIn() bool { return moneyInCodes[t.Code] }

// SignedAmount is negative for money-in (credit), positive for a debit.
func (t Txn) SignedAmount() float64 {
	if t.MoneyIn() {
		return -t.AmountMag
	}
	return t.AmountMag
}

// Channel classifies the code the way the baseline does.
func Channel(code string) string {
	switch code {
	case "200", "300", "303", "423", "202", "302", "903", "250", "252", "350", "352", "353", "472", "473":
		return "interswitch"
	case "402", "400", "401", "403", "405", "411", "412", "413", "414", "415", "416", "452":
		return "collection"
	default:
		return "internal"
	}
}

// RowHash is the per-row idempotency key: the natural key plus the file row-sequence so
// a re-read of the same file conflicts (skip) while distinct in-window rows are kept.
func (t Txn) RowHash() string {
	key := strings.Join([]string{
		t.AccountNo, t.PostDate.Format("2006-01-02"), t.TxnDate.Format("2006-01-02"),
		t.Code, strconv.FormatFloat(t.AmountMag, 'f', 2, 64), strings.TrimSpace(t.Trace), t.RowSeq,
	}, "|")
	sum := md5.Sum([]byte(key))
	return hex.EncodeToString(sum[:])
}

func pdate(s string) (time.Time, error) { return time.Parse("02/01/2006", strings.TrimSpace(s)) }

// ParseLine decodes one txn_file row by fixed position (§3.3), validating field count so
// a comma-shifted row is rejected rather than written to the wrong columns.
func ParseLine(line string) (Txn, error) {
	f := strings.Split(line, ",")
	if len(f) != fieldCount {
		return Txn{}, fmt.Errorf("want %d fields, got %d", fieldCount, len(f))
	}
	for i := range f {
		f[i] = strings.TrimSpace(f[i])
	}
	post, err := pdate(f[0])
	if err != nil {
		return Txn{}, fmt.Errorf("bad post_date %q", f[0])
	}
	txn, err := pdate(f[1])
	if err != nil {
		return Txn{}, fmt.Errorf("bad txn_date %q", f[1])
	}
	amt, err := strconv.ParseFloat(f[3], 64)
	if err != nil {
		return Txn{}, fmt.Errorf("bad amount %q", f[3])
	}
	if f[2] == "" || f[5] == "" {
		return Txn{}, fmt.Errorf("missing code or account_no")
	}
	return Txn{
		PostDate: post, TxnDate: txn, Code: f[2], AmountMag: amt, Description: f[4],
		AccountNo: f[5], PAN: f[6], Trace: f[8], Merchant: f[10], MCC: f[11], City: f[12], RowSeq: f[15],
	}, nil
}

// insertHead / cols kept together so the SELECT projection lines up with the INSERT.
const insertHead = `
INSERT INTO app.transactions (
    txn_id, account_id, contact_id, cif, account_no, post_date, txn_date, txn_code, description,
    amount, amount_debit, amount_credit, money_in, pan_number, merchant_name, mcc, city, trace,
    product_name, source, source_file, row_hash, channel)
`

// apply parses one txn_file and inserts its new rows in a single statement: a VALUES
// batch, cast from text, left-joined to app.accounts to resolve the owning
// account_id/contact_id/cif, filtered by the natural-key NOT EXISTS dedup against the
// whole ledger, and ON CONFLICT (row_hash) DO NOTHING for re-read idempotency.
// Apply is exported so a dry-run can exercise it inside a rolled-back transaction.
func Apply(ctx context.Context, tx *sql.Tx, lines []string, meta feedcore.FileMeta) (inserted, updated, rejected int, err error) {
	type row struct {
		t       Txn
		rowHash string
	}
	var rows []row
	seen := map[string]bool{} // dedup identical row_hash within the same file
	for _, line := range lines {
		t, perr := ParseLine(line)
		if perr != nil {
			rejected++
			continue
		}
		h := t.RowHash()
		if seen[h] {
			continue
		}
		seen[h] = true
		rows = append(rows, row{t, h})
	}
	if len(rows) == 0 {
		return 0, 0, rejected, nil
	}

	const perRow = 18
	ph := make([]string, 0, len(rows))
	args := make([]any, 0, len(rows)*perRow)
	for i, r := range rows {
		n := i * perRow
		p := make([]string, perRow)
		for j := 0; j < perRow; j++ {
			p[j] = fmt.Sprintf("$%d", n+j+1)
		}
		ph = append(ph, "("+strings.Join(p, ",")+")")
		debit, credit := r.t.AmountMag, 0.0
		if r.t.MoneyIn() {
			debit, credit = 0.0, r.t.AmountMag
		}
		args = append(args,
			"ZT"+r.rowHash,                                     // txn_id
			r.t.AccountNo,                                      // account_no
			r.t.PostDate.Format("2006-01-02"),                 // post_date
			r.t.TxnDate.Format("2006-01-02"),                  // txn_date
			r.t.Code,                                          // txn_code
			r.t.Description,                                   // description
			strconv.FormatFloat(r.t.SignedAmount(), 'f', 2, 64), // amount (signed)
			strconv.FormatFloat(debit, 'f', 2, 64),            // amount_debit
			strconv.FormatFloat(credit, 'f', 2, 64),           // amount_credit
			boolStr(r.t.MoneyIn()),                            // money_in
			r.t.PAN, r.t.Merchant, r.t.MCC, r.t.City, r.t.Trace, // pan, merchant, mcc, city, trace
			meta.Name,      // source_file
			r.rowHash,      // row_hash
			Channel(r.t.Code), // channel
		)
	}

	q := insertHead + `
WITH v(txn_id, account_no, post_date, txn_date, txn_code, description, amount, amount_debit,
       amount_credit, money_in, pan, merchant, mcc, city, trace, source_file, row_hash, channel) AS (
    VALUES ` + strings.Join(ph, ",") + `
)
SELECT v.txn_id, a.account_id, a.contact_id, a.cif, v.account_no,
       v.post_date::date, v.txn_date::date, v.txn_code, NULLIF(v.description,''),
       v.amount::numeric, v.amount_debit::numeric, v.amount_credit::numeric, v.money_in::boolean,
       NULLIF(v.pan,''), NULLIF(v.merchant,''), NULLIF(v.mcc,''), NULLIF(v.city,''), NULLIF(v.trace,''),
       a.product_name, 'feed', v.source_file, v.row_hash, v.channel
FROM v
LEFT JOIN app.accounts a ON a.account_no = v.account_no
WHERE NOT EXISTS (
    SELECT 1 FROM app.transactions t
    WHERE t.account_no = v.account_no
      AND t.post_date  = v.post_date::date
      AND t.txn_date   = v.txn_date::date
      AND t.txn_code   = v.txn_code
      AND ABS(t.amount) = ABS(v.amount::numeric)
      AND COALESCE(NULLIF(TRIM(t.trace),''),'') = COALESCE(NULLIF(TRIM(v.trace),''),'')
)
  AND NOT EXISTS (
    -- Drop transactions that belong to a test/dummy/vendor card, so they stay out of the
    -- ledger just like the card is kept out of the book (acctfeed skips it at ingest).
    SELECT 1 FROM app.accounts ta
    WHERE ta.account_no = v.account_no
      AND ta.name_on_card ~* '\m(test|bevertec|dummy|fastest)\M|testcard|questtest'
)
ON CONFLICT (row_hash) WHERE row_hash IS NOT NULL DO NOTHING`

	res, err := tx.ExecContext(ctx, q, args...)
	if err != nil {
		return 0, 0, rejected, fmt.Errorf("insert %d txns: %w", len(rows), err)
	}
	n, _ := res.RowsAffected()
	return int(n), 0, rejected, nil
}

func boolStr(b bool) string {
	if b {
		return "t"
	}
	return "f"
}
