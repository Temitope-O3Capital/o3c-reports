// Package acctfeed ingests the 15-minute acct_file drops into app.accounts.
//
// acct_file is the accounts/cards stream (docs/DATA_FEED_INGESTION.md §3.2): one
// headerless positional row per account, comma-delimited, no quoting. The middle
// money columns the design left as "⁇" were decoded empirically against the existing
// app.accounts baseline (2026-08): field 3 + field 9 = field 12, i.e. outstanding +
// available = limit, which pins field 3 = current_dr_balance, field 9 =
// card_wd_available, field 12 = card_limit. Money is stored as numeric naira (NOT
// kobo) to match the baseline; negative current_dr_balance is a credit (CR).
package acctfeed

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/feedcore"
)

// Stream is the acct_file → app.accounts feed.
var Stream = feedcore.Stream{Name: "accounts", SubDir: "acct_file", Prefix: "acct_file"}

// Configured reports whether the acct_file folder is mounted.
func Configured() bool { return Stream.Configured() }

// Run ingests every acct_file not yet processed.
func Run(ctx context.Context, db *core.DB, kind string, triggeredBy sql.NullInt64) (feedcore.Result, error) {
	return feedcore.Run(ctx, db, Stream, kind, triggeredBy, apply(db))
}

// fieldCount is the documented width of an acct_file row (§3.2).
const fieldCount = 20

// Account is one decoded acct_file row. Money fields are naira; dates are day-first.
type Account struct {
	AccountNo        string
	ProductName      string
	CIF              string
	Indicator        string
	CardPAN          string
	NameOnCard       string
	CurrentDrBalance sql.NullFloat64
	CycleBalance     sql.NullFloat64
	CardWdAvailable  sql.NullFloat64
	MinPaymentDue    sql.NullFloat64
	CardLimit        sql.NullFloat64
	OpenedDate       sql.NullTime
	LastPaymentDate  sql.NullTime
	CardExpiryDate   sql.NullTime
	PaymentDueDate   sql.NullTime
}

func num(s string) sql.NullFloat64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return sql.NullFloat64{}
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return sql.NullFloat64{}
	}
	return sql.NullFloat64{Float64: v, Valid: true}
}

// dt parses a DD/MM/YYYY feed date. Blank, whitespace or an unparseable value yields
// NULL rather than an error — a missing date is not a reason to reject an account.
func dt(s string) sql.NullTime {
	s = strings.TrimSpace(s)
	if s == "" {
		return sql.NullTime{}
	}
	t, err := time.Parse("02/01/2006", s)
	if err != nil {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: t, Valid: true}
}

// ParseLine decodes one acct_file row by fixed position (§3.2). The field count is
// validated: a row that is not exactly 20 fields has been shifted by a stray comma and
// is rejected to the reject count rather than written to the wrong columns.
func ParseLine(line string) (Account, error) {
	f := strings.Split(line, ",")
	if len(f) != fieldCount {
		return Account{}, fmt.Errorf("want %d fields, got %d", fieldCount, len(f))
	}
	for i := range f {
		f[i] = strings.TrimSpace(f[i])
	}
	acctNo := f[0]
	if len(acctNo) < 6 {
		return Account{}, fmt.Errorf("field 1 is not an account number: %q", acctNo)
	}
	return Account{
		AccountNo:        acctNo,
		ProductName:      f[1],
		CurrentDrBalance: num(f[2]),
		CycleBalance:     num(f[4]),
		OpenedDate:       dt(f[7]),
		CardWdAvailable:  num(f[8]),
		MinPaymentDue:    num(f[9]),
		CardExpiryDate:   dt(f[10]),
		CardLimit:        num(f[11]),
		LastPaymentDate:  dt(f[12]),
		Indicator:        f[14],
		CIF:              f[15],
		PaymentDueDate:   dt(f[16]),
		CardPAN:          f[17],
		NameOnCard:       f[18],
	}, nil
}

// ProductLine buckets the product name the way the baseline does: PREP is prepaid
// (Blink), the cooperative deposit products are deposits, everything else is a card.
func ProductLine(product string) string {
	p := strings.ToUpper(product)
	switch {
	case strings.Contains(p, "PREP"):
		return "prepaid"
	case strings.Contains(p, "COOP"), strings.Contains(p, "MEMCOS"):
		return "deposit"
	default:
		return "card"
	}
}

// Utilisation is outstanding / limit as a percentage, matching the baseline column.
func (a Account) Utilisation() sql.NullFloat64 {
	if a.CardLimit.Valid && a.CardLimit.Float64 != 0 && a.CurrentDrBalance.Valid {
		return sql.NullFloat64{Float64: a.CurrentDrBalance.Float64 / a.CardLimit.Float64 * 100, Valid: true}
	}
	return sql.NullFloat64{}
}

// upsertSQL writes one account snapshot. Keyed on account_no (the feed's account key).
// A feed-only account gets a synthetic account_id 'ZA'||account_no that cannot collide
// with the 16-hex baseline ids. Text columns COALESCE so a blank never erases a value;
// the money/date columns are the feed's current truth and overwrite when present.
const upsertSQL = `
INSERT INTO app.accounts (
    account_id, account_no, cif, product_name, product_line, account_indicator,
    card_pan, name_on_card, current_dr_balance, cycle_balance, card_wd_available,
    min_payment_due, card_limit, card_utilisation,
    opened_date, last_payment_date, card_expiry_date, payment_due_date,
    source, source_file, last_seen
) VALUES (
    'ZA' || $1, $1, NULLIF($2,''), NULLIF($3,''), NULLIF($4,''), NULLIF($5,''),
    NULLIF($6,''), NULLIF($7,''), $8, $9, $10,
    $11, $12, $13,
    $14, $15, $16, $17,
    'feed', $18, NOW()
)
ON CONFLICT (account_no) WHERE account_no IS NOT NULL AND account_no <> ''
DO UPDATE SET
    cif                = COALESCE(NULLIF(EXCLUDED.cif, ''),          app.accounts.cif),
    product_name       = COALESCE(NULLIF(EXCLUDED.product_name, ''), app.accounts.product_name),
    product_line       = COALESCE(NULLIF(EXCLUDED.product_line, ''), app.accounts.product_line),
    account_indicator  = COALESCE(NULLIF(EXCLUDED.account_indicator, ''), app.accounts.account_indicator),
    card_pan           = COALESCE(NULLIF(EXCLUDED.card_pan, ''),     app.accounts.card_pan),
    name_on_card       = COALESCE(NULLIF(EXCLUDED.name_on_card, ''), app.accounts.name_on_card),
    current_dr_balance = COALESCE(EXCLUDED.current_dr_balance, app.accounts.current_dr_balance),
    cycle_balance      = COALESCE(EXCLUDED.cycle_balance,      app.accounts.cycle_balance),
    card_wd_available  = COALESCE(EXCLUDED.card_wd_available,  app.accounts.card_wd_available),
    min_payment_due    = COALESCE(EXCLUDED.min_payment_due,    app.accounts.min_payment_due),
    card_limit         = COALESCE(EXCLUDED.card_limit,         app.accounts.card_limit),
    card_utilisation   = COALESCE(EXCLUDED.card_utilisation,   app.accounts.card_utilisation),
    opened_date        = COALESCE(EXCLUDED.opened_date,        app.accounts.opened_date),
    last_payment_date  = COALESCE(EXCLUDED.last_payment_date,  app.accounts.last_payment_date),
    card_expiry_date   = COALESCE(EXCLUDED.card_expiry_date,   app.accounts.card_expiry_date),
    payment_due_date   = COALESCE(EXCLUDED.payment_due_date,   app.accounts.payment_due_date),
    source_file        = EXCLUDED.source_file,
    last_seen          = EXCLUDED.last_seen
RETURNING (xmax = 0) AS inserted`

// apply returns the feedcore.Applier that upserts one acct_file's rows.
// testNameRE flags test/dummy/vendor cards by their cardholder name (e.g. "O3CAPITAL
// TEST CARD", "Bevertec"). Skipped at ingest so they never enter the card book. RE2 uses
// \b for word boundaries (not Postgres's \m/\M).
var testNameRE = regexp.MustCompile(`(?i)\b(test|bevertec|dummy|fastest)\b|testcard|questtest`)

func apply(_ *core.DB) feedcore.Applier {
	return func(ctx context.Context, tx *sql.Tx, lines []string, meta feedcore.FileMeta) (inserted, updated, rejected int, err error) {
		for _, line := range lines {
			a, perr := ParseLine(line)
			if perr != nil {
				rejected++
				continue
			}
			// Skip test/dummy/vendor cards at the source so they never enter the card book.
			if testNameRE.MatchString(a.NameOnCard) {
				rejected++
				continue
			}
			var isNew bool
			if err = tx.QueryRowContext(ctx, upsertSQL,
				a.AccountNo, a.CIF, a.ProductName, ProductLine(a.ProductName), a.Indicator,
				a.CardPAN, a.NameOnCard, a.CurrentDrBalance, a.CycleBalance, a.CardWdAvailable,
				a.MinPaymentDue, a.CardLimit, a.Utilisation(),
				a.OpenedDate, a.LastPaymentDate, a.CardExpiryDate, a.PaymentDueDate,
				meta.Name,
			).Scan(&isNew); err != nil {
				return inserted, updated, rejected, fmt.Errorf("upsert account %s: %w", a.AccountNo, err)
			}
			if isNew {
				inserted++
			} else {
				updated++
			}
		}
		return inserted, updated, rejected, nil
	}
}
