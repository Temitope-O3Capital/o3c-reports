package cbssync

// Blink FX event parser — best-effort extraction of a funding/fee event and its rate
// from GL narration text on the BlueSalt/DT&T wallet accounts. See migration 343's
// header for why this has to be narration-based (no structured rate exists anywhere)
// and why it is deliberately conservative: a row with no parseable rate is left
// uncaptured, never guessed. Re-running this over the same window is a no-op — every
// captured row is keyed 1:1 to the gl_posting it came from (UNIQUE(gl_posting_id)).

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"

	"github.com/o3c/workspace/core"
)

// blinkFXAccounts are the only accounts this parser ever reads. Found by inspecting
// the real GL account catalogue live 2026-10-06: BlueSalt is O3's FX/card-scheme
// settlement partner, and these are its wallets plus the one GBP-denominated account.
var blinkFXAccounts = []string{"10204032", "10204033", "10204045", "10103005"}

// usdRatePattern matches "$3,278.57 at N1,400" / "$600 @ N1,400" / "$5,000 at N1400" —
// every dollar-rate shape seen in the live ledger, comma-grouped or not, with or
// without a decimal, "at" or "@", "N" immediately before the rate.
var usdRatePattern = regexp.MustCompile(`(?i)\$\s*([\d,]+\.?\d*)\s*(?:@|at)\s*n\s*([\d,]+\.?\d*)`)

// gbpRatePattern matches the one GBP shape seen: "40,000GBP at N1,890".
var gbpRatePattern = regexp.MustCompile(`(?i)([\d,]+\.?\d*)\s*gbp\s*at\s*n\s*([\d,]+\.?\d*)`)

// BlinkFXParseResult summarises one parse run.
type BlinkFXParseResult struct {
	PostingsScanned int // rows on the 4 accounts with no blink_fx_events row yet
	RatesFound      int // of those, how many had a parseable $X-at-NY pattern
	Captured        int // actually inserted (RatesFound minus any that failed to insert)
	Skipped         int // RatesFound minus Captured would be 0 normally; tracks dup races
}

// ParseBlinkFXEvents scans every not-yet-parsed posting on the Blink/BlueSalt accounts
// and inserts a blink_fx_events row for each one whose narration carries a genuine
// rate. Safe to call repeatedly (idempotent) and cheap (the whole population is a few
// hundred rows) — called once as a backfill and then incrementally alongside the GL
// postings sync.
func ParseBlinkFXEvents(ctx context.Context, db *core.DB) (BlinkFXParseResult, error) {
	var res BlinkFXParseResult

	placeholders := make([]string, len(blinkFXAccounts))
	args := make([]any, len(blinkFXAccounts))
	for i, a := range blinkFXAccounts {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
		args[i] = a
	}
	rows, err := db.PG.QueryContext(ctx, `
		SELECT p.id, p.narration, p.financial_date, p.branch_name
		  FROM app.cbs_gl_postings p
		  LEFT JOIN app.blink_fx_events e ON e.gl_posting_id = p.id
		 WHERE p.account_number IN (`+strings.Join(placeholders, ",")+`)
		   AND e.id IS NULL`, args...)
	if err != nil {
		return res, fmt.Errorf("blink fx parse: query postings: %w", err)
	}
	type candidate struct {
		id         int64
		narration  string
		finDate    string
		branchName string
	}
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.id, &c.narration, &c.finDate, &c.branchName); err != nil {
			rows.Close() //nolint:errcheck
			return res, fmt.Errorf("blink fx parse: scan posting: %w", err)
		}
		candidates = append(candidates, c)
	}
	rows.Close() //nolint:errcheck
	if err := rows.Err(); err != nil {
		return res, err
	}
	res.PostingsScanned = len(candidates)

	for _, c := range candidates {
		eventType, currency, fxAmount, rate, ok := classifyAndParse(c.narration)
		if !ok {
			continue
		}
		res.RatesFound++

		ngnKobo := int64(fxAmount * rate * 100)
		_, err := db.PGExec(ctx, `
			INSERT INTO app.blink_fx_events
			    (event_type, currency, fx_amount, ngn_amount_kobo, rate, rate_source,
			     branch_name, gl_posting_id, occurred_at, notes)
			VALUES ($1,$2,$3,$4,$5,'narration',$6,$7,$8::date,$9)
			ON CONFLICT (gl_posting_id) DO NOTHING`,
			eventType, currency, fxAmount, ngnKobo, rate, c.branchName, c.id, c.finDate, c.narration)
		if err != nil {
			slog.Warn("blink fx parse: insert failed, posting skipped",
				"gl_posting_id", c.id, "err", err)
			res.Skipped++
			continue
		}
		res.Captured++
	}

	slog.Info("blink fx parse done",
		"scanned", res.PostingsScanned, "rates_found", res.RatesFound,
		"captured", res.Captured, "skipped", res.Skipped)
	return res, nil
}

// classifyAndParse applies the rate regexes and the funding/fee keyword rule.
//
// Direction (debit/credit) is deliberately NOT used to classify — spot-checking the
// live ledger found "Blink Wallet Funding" debits that are O3's own internal top-ups,
// not customer events, and inter-account transfers ("GT Current to Blink Wallet",
// "Fidelity Project to Blusalt") on both sides with no rate at all. The one reliable
// signal left is: does the narration carry a genuine parseable rate, and does it say
// "fund" (a customer funding their card) or "fee"/"charge" (BlueSalt's own cut)?
// Anything else — bare "BLUSALT FUNDING", "Wallet Transfer: Daily Total" — has no rate
// to parse and is skipped by construction, not by this function's keyword check.
func classifyAndParse(narration string) (eventType, currency string, fxAmount, rate float64, ok bool) {
	lower := strings.ToLower(narration)

	var fxStr, rateStr string
	if m := usdRatePattern.FindStringSubmatch(narration); m != nil {
		currency, fxStr, rateStr = "USD", m[1], m[2]
	} else if m := gbpRatePattern.FindStringSubmatch(narration); m != nil {
		currency, fxStr, rateStr = "GBP", m[1], m[2]
	} else {
		return "", "", 0, 0, false
	}

	fx, err := strconv.ParseFloat(strings.ReplaceAll(fxStr, ",", ""), 64)
	if err != nil || fx <= 0 {
		return "", "", 0, 0, false
	}
	r, err := strconv.ParseFloat(strings.ReplaceAll(rateStr, ",", ""), 64)
	if err != nil || r <= 0 {
		return "", "", 0, 0, false
	}

	switch {
	case strings.Contains(lower, "fee") || strings.Contains(lower, "charge"):
		eventType = "fee"
	case strings.Contains(lower, "fund"):
		eventType = "funding"
	default:
		// A rate was present but the narration doesn't say what kind of event this
		// is — e.g. a settlement/transaction line that happens to quote a rate
		// without "fee" in it. Left uncaptured rather than guessed.
		return "", "", 0, 0, false
	}
	return eventType, currency, fx, r, true
}
