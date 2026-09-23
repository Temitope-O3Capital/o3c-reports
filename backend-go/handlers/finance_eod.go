package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/o3c/workspace/core"
)

// Derived End-of-Day report.
//
// O3 has no uploaded EOD settlement file and no populated GL — so the EOD is
// COMPUTED from data we already hold: the live transaction feed
// (app.transactions, naira), the daily portfolio/kpi snapshots (kobo), the CBS
// fixed-deposit register, live FX, payment rails and the reconciliation
// exception queues. Everything here is read-only; no upload, no mutation.
//
// Unit convention on the wire: keys suffixed *_ngn are naira (from the
// transaction feed / FX), keys suffixed *_kobo are minor units (from the CBS /
// snapshot books). The frontend formats each accordingly. Sections that cannot
// be sourced (GL/trial-balance, daily card activity) are surfaced as flags
// rather than faked.

// finEODDates — recent dates that actually have transaction activity, newest
// first, for the report's date picker. Future-dated feed rows are excluded.
func finEODDates(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT to_char(txn_date,'YYYY-MM-DD') AS date, COUNT(*) AS txn_count
			FROM app.transactions
			WHERE txn_date <= CURRENT_DATE
			GROUP BY txn_date
			ORDER BY txn_date DESC
			LIMIT 45`)
		if err != nil {
			respondErr(w, 500, "eod dates query failed: "+err.Error())
			return
		}
		respond(w, rows, "pg")
	}
}

// finTransactionsList — paginated movement ledger from the live transaction
// feed (app.transactions). Amounts are NAIRA. Replaces the old EOD-file list.
func finTransactionsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		limit := qint(r, "limit", 50, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

		where := "txn_date <= CURRENT_DATE"
		var args []any
		n := 1
		if v, _ := validDate(r, "date_from"); v != "" {
			where += fmt.Sprintf(" AND txn_date >= $%d::date", n)
			args = append(args, v)
			n++
		}
		if v, _ := validDate(r, "date_to"); v != "" {
			where += fmt.Sprintf(" AND txn_date <= $%d::date", n)
			args = append(args, v)
			n++
		}
		// "unclassified" is the sentinel for rows the feed gave no channel at all
		// (4,979 of them, stored NULL). They were unreachable from the filter — the
		// only way to see them was to page through everything.
		if v := qstr(r, "channel"); v == "unclassified" {
			where += " AND channel IS NULL"
		} else if v != "" {
			where += fmt.Sprintf(" AND channel = $%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "direction"); v == "credit" {
			where += " AND money_in"
		} else if v == "debit" {
			where += " AND NOT money_in"
		}
		if v := strings.TrimSpace(qstr(r, "q")); v != "" {
			where += fmt.Sprintf(" AND (description ILIKE $%d OR account_no ILIKE $%d OR merchant_name ILIKE $%d)", n, n, n)
			args = append(args, "%"+v+"%")
			n++
		}

		var total int64
		if rows, _ := db.PGQuery(ctx, "SELECT COUNT(*) AS c FROM app.transactions WHERE "+where, args...); len(rows) > 0 {
			total = toInt64(rows[0]["c"])
		}

		listArgs := append(append([]any{}, args...), limit, offset)
		rows, err := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT to_char(txn_date,'YYYY-MM-DD') AS txn_date, description, channel,
			       COALESCE(NULLIF(product_name,''),'Unclassified') AS product_name,
			       account_no, txn_code, merchant_name, money_in,
			       amount_debit, amount_credit, account_balance
			FROM app.transactions WHERE %s
			ORDER BY txn_date DESC, txn_id DESC
			LIMIT $%d OFFSET $%d`, where, n, n+1), listArgs...)
		if err != nil {
			respondErr(w, 500, "transactions query failed: "+err.Error())
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows, "total": total}) //nolint:errcheck
	}
}

// finEODReport — the full derived EOD for a single business date.
func finEODReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Resolve the as-of date. Default to the latest CLOSED business day
		// (strictly before today): an End-of-Day report is for a settled day, not
		// the current partial one. Fall back to the latest day with any activity
		// if a closed day isn't available.
		asOf, _ := validDate(r, "date")
		if asOf == "" {
			if rows, _ := db.PGQuery(ctx,
				`SELECT to_char(MAX(txn_date),'YYYY-MM-DD') AS d
				 FROM app.transactions WHERE txn_date < CURRENT_DATE`); len(rows) > 0 {
				asOf = str(rows[0]["d"])
			}
		}
		if asOf == "" {
			if rows, _ := db.PGQuery(ctx,
				`SELECT to_char(MAX(txn_date),'YYYY-MM-DD') AS d
				 FROM app.transactions WHERE txn_date <= CURRENT_DATE`); len(rows) > 0 {
				asOf = str(rows[0]["d"])
			}
		}
		if asOf == "" {
			asOf = time.Now().Format("2006-01-02")
		}

		out := map[string]any{
			"as_of":        asOf,
			"generated_at": time.Now().Format(time.RFC3339),
			"flags": []string{
				"Card income is derived from transaction codes, not GL-posted (the GL ledger is not populated).",
				"Loan interest is scheduled accrual (interest due on the date per the Udara repayment schedule), not cash received — so Income Earned mixes a cash basis and an accrual basis.",
				"Daily card activity is unavailable — the card book is a monthly cycle snapshot.",
				"Position is the CBS snapshot on or before this date; the FD register carries no history, so FD accrual is only available live (see Treasury), not as-of.",
			},
		}

		// Previous business date, WITH its movement totals.
		//
		// prev_date was returned on its own for a long time and nothing could be
		// done with it — a date with no figures behind it renders no comparison,
		// so the report offered no day-over-day context at all. The previous day's
		// movements come back alongside it now, and the KPI strip shows the delta.
		var prevDate string
		if rows, _ := db.PGQuery(ctx,
			`SELECT to_char(MAX(txn_date),'YYYY-MM-DD') AS d
			 FROM app.transactions WHERE txn_date < $1::date`, asOf); len(rows) > 0 {
			prevDate = str(rows[0]["d"])
			out["prev_date"] = rows[0]["d"]
		}
		if prevDate != "" {
			if rows, _ := db.PGQuery(ctx, `
				SELECT
				  COUNT(*)                        AS txn_count,
				  COALESCE(SUM(amount_credit),0)  AS credit_ngn,
				  COALESCE(SUM(amount_debit),0)   AS debit_ngn
				FROM app.transactions
				WHERE txn_date = $1::date`, prevDate); len(rows) > 0 {
				cr := toFloat64(rows[0]["credit_ngn"])
				dr := toFloat64(rows[0]["debit_ngn"])
				out["prev_movements"] = map[string]any{
					"txn_count":  toInt64(rows[0]["txn_count"]),
					"credit_ngn": cr,
					"debit_ngn":  dr,
					"net_ngn":    cr - dr,
				}
			}
		}

		/* ── Movements (transaction feed, NAIRA) ─────────────────────────── */
		if rows, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(*)                                         AS txn_count,
			  COUNT(*) FILTER (WHERE money_in)                 AS credit_count,
			  COUNT(*) FILTER (WHERE NOT money_in)             AS debit_count,
			  COALESCE(SUM(amount_credit),0)                   AS credit_ngn,
			  COALESCE(SUM(amount_debit),0)                    AS debit_ngn
			FROM app.transactions
			WHERE txn_date = $1::date`, asOf); len(rows) > 0 {
			cr := toFloat64(rows[0]["credit_ngn"])
			dr := toFloat64(rows[0]["debit_ngn"])
			out["movements"] = map[string]any{
				"txn_count":    toInt64(rows[0]["txn_count"]),
				"credit_count": toInt64(rows[0]["credit_count"]),
				"debit_count":  toInt64(rows[0]["debit_count"]),
				"credit_ngn":   cr,
				"debit_ngn":    dr,
				"net_ngn":      cr - dr,
			}
		}

		// By channel
		if rows, _ := db.PGQuery(ctx, `
			SELECT
			  COALESCE(NULLIF(channel,''),'other')            AS channel,
			  COUNT(*)                                         AS txn_count,
			  COALESCE(SUM(amount_credit),0)                   AS credit_ngn,
			  COALESCE(SUM(amount_debit),0)                    AS debit_ngn,
			  COALESCE(SUM(amount_credit+amount_debit),0)      AS volume_ngn
			FROM app.transactions
			WHERE txn_date = $1::date
			GROUP BY 1 ORDER BY volume_ngn DESC`, asOf); rows != nil {
			out["by_channel"] = rows
		}

		// By product (top 12 by volume)
		if rows, _ := db.PGQuery(ctx, `
			SELECT
			  COALESCE(NULLIF(product_name,''),'Unclassified') AS product_name,
			  COUNT(*)                                          AS txn_count,
			  COALESCE(SUM(amount_credit+amount_debit),0)       AS volume_ngn
			FROM app.transactions
			WHERE txn_date = $1::date
			GROUP BY 1 ORDER BY volume_ngn DESC LIMIT 12`, asOf); rows != nil {
			out["by_product"] = rows
		}

		/* ── Income earned that day (NAIRA) ──────────────────────────────────
		   app.income_daily (card / txn-code income) PLUS loan-schedule interest
		   due on the date.

		   The loan half used to be missing here while /income-statement has folded
		   it in for some time, so the two screens reported different income for the
		   same day and neither said why. Both now stand on the same basis. Card
		   income is transaction-derived and the loan line is scheduled accrual —
		   that mix is called out in the report's flags rather than blended away. */
		{
			var cardInterest, fee, penalty, loanInterest float64
			if rows, _ := db.PGQuery(ctx, `
				SELECT category, COALESCE(SUM(amount_ngn),0) AS amount_ngn
				FROM app.income_daily
				WHERE income_date = $1::date
				GROUP BY category`, asOf); rows != nil {
				for _, row := range rows {
					amt := toFloat64(row["amount_ngn"])
					switch str(row["category"]) {
					case "interest":
						cardInterest = amt
					case "fee":
						fee = amt
					case "penalty":
						penalty = amt
					}
				}
			}
			if rows, _ := db.PGQuery(ctx, `
				SELECT COALESCE(SUM(interest_kobo),0)::numeric / 100 AS v
				FROM app.cbs_loan_schedules WHERE payment_date = $1::date`, asOf); len(rows) > 0 {
				loanInterest = toFloat64(rows[0]["v"])
			}
			out["income"] = map[string]any{
				"card_interest_ngn": cardInterest,
				"loan_interest_ngn": loanInterest,
				"interest_ngn":      cardInterest + loanInterest,
				"fee_ngn":           fee,
				"penalty_ngn":       penalty,
				"total_ngn":         cardInterest + loanInterest + fee + penalty,
			}
		}

		/* ── Portfolio position as-of (CBS snapshot, KOBO) ───────────────────
		   Only cbs_portfolio_snapshot carries real values; the generic
		   portfolio_daily_snapshot / kpi_daily_snapshot tables are unpopulated
		   (all-zero), so we source position from the CBS book alone and derive
		   the NPL ratio rather than reading the zeroed *_bps column. */
		if rows, _ := db.PGQuery(ctx, `
			SELECT loans_active, borrowers_active,
			       outstanding_principal_kobo, outstanding_interest_kobo,
			       npl_kobo, performing_kobo,
			       fd_active_count, fd_principal_kobo, fd_ledger_balance_kobo,
			       to_char(snapshot_date,'YYYY-MM-DD') AS snapshot_date,
			       CASE WHEN outstanding_principal_kobo > 0
			            THEN ROUND(100.0 * npl_kobo / outstanding_principal_kobo, 2)
			            ELSE 0 END AS npl_ratio_pct
			FROM app.cbs_portfolio_snapshot
			WHERE snapshot_date <= $1::date
			ORDER BY snapshot_date DESC LIMIT 1`, asOf); len(rows) > 0 {
			out["position"] = rows[0]
		}

		/* ── New business booked on the date ─────────────────────────────── */
		newBiz := map[string]any{}
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS c, COALESCE(SUM(loan_amount_kobo),0) AS kobo
			FROM app.cbs_loans WHERE date_booked::date = $1::date`, asOf); len(rows) > 0 {
			newBiz["loans_count"] = toInt64(rows[0]["c"])
			newBiz["loans_kobo"] = toInt64(rows[0]["kobo"])
		}
		// commencement_date is a timestamptz and gts parses Udara's dates as UTC while
		// the session runs in Africa/Lagos, so every one of them sits at 01:00:00+01.
		// Compared bare against $1::date (midnight) this matched NOTHING: fd_count and
		// fd_kobo were structurally 0 on every date the report has ever been run for.
		// The ::date cast is what makes the comparison real.
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS c, COALESCE(SUM(principal_kobo),0) AS kobo
			FROM app.cbs_fixed_deposits WHERE commencement_date::date = $1::date`, asOf); len(rows) > 0 {
			newBiz["fd_count"] = toInt64(rows[0]["c"])
			newBiz["fd_kobo"] = toInt64(rows[0]["kobo"])
		}
		out["new_business"] = newBiz

		/* ── FD maturities on/around the date (CBS register, KOBO) ─────────
		   Same timestamptz-vs-date problem as above: today_count / today_kobo were
		   structurally 0, and the uncast BETWEEN dropped day 0 of the 7-day window
		   (9 deposits instead of 10 for 2026-09-17).

		   The counts span every status, because a deposit that matured really did
		   mature. The kobo sums can only cover what the workspace still holds a value
		   for: Udara zeroes principal, ledger and accrued on closure, so for a Closed
		   deposit the payout is unknown, not zero. *_unknown_count says how many of
		   the counted maturities the value is missing for, so a ₦0 on an old date
		   cannot be misread as "nothing matured". */
		maturity := map[string]any{}
		if rows, _ := db.PGQuery(ctx, `
			SELECT
			  COUNT(*) FILTER (WHERE maturity_date::date = $1::date)                                 AS today_count,
			  COALESCE(SUM(principal_kobo) FILTER (WHERE maturity_date::date = $1::date),0)          AS today_kobo,
			  COUNT(*) FILTER (WHERE maturity_date::date = $1::date AND status <> 'Active')          AS today_unknown_count,
			  COUNT(*) FILTER (WHERE maturity_date::date BETWEEN $1::date AND $1::date + 7)          AS next7_count,
			  COALESCE(SUM(principal_kobo) FILTER (WHERE maturity_date::date BETWEEN $1::date AND $1::date + 7),0) AS next7_kobo,
			  COUNT(*) FILTER (WHERE maturity_date::date BETWEEN $1::date AND $1::date + 7 AND status <> 'Active') AS next7_unknown_count
			FROM app.cbs_fixed_deposits`, asOf); len(rows) > 0 {
			for k, v := range rows[0] {
				maturity[k] = v
			}
		}
		if rows, _ := db.PGQuery(ctx, `
			SELECT
			  cf.raw->>'name' AS customer_name, -- Udara's own name (cbs_customer_id != app.customers.cif)
			  cf.principal_kobo, cf.interest_rate, cf.status,
			  to_char(cf.maturity_date,'YYYY-MM-DD') AS maturity_date
			FROM app.cbs_fixed_deposits cf
			WHERE cf.maturity_date::date BETWEEN $1::date AND $1::date + 7
			  AND cf.principal_kobo > 0
			ORDER BY cf.maturity_date, cf.principal_kobo DESC LIMIT 10`, asOf); rows != nil {
			maturity["list"] = rows
		}
		out["maturities"] = maturity

		/* ── FX rates as-of (latest scrape on/before the date, NAIRA) ────── */
		if rows, _ := db.PGQuery(ctx, `
			SELECT DISTINCT ON (currency) currency, buy, sell,
			       to_char(scraped_at,'YYYY-MM-DD HH24:MI') AS as_of
			FROM app.fx_parallel_rates
			WHERE scraped_at < ($1::date + 1)
			ORDER BY currency, scraped_at DESC`, asOf); rows != nil {
			out["fx"] = rows
		}

		/* ── Payment rails — Paystack collections that settled (KOBO) ────── */
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS c, COALESCE(SUM(amount_kobo),0) AS kobo
			FROM app.paystack_transactions
			WHERE status='success' AND paid_at::date = $1::date`, asOf); len(rows) > 0 {
			out["rails"] = map[string]any{
				"paystack_in_count": toInt64(rows[0]["c"]),
				"paystack_in_kobo":  toInt64(rows[0]["kobo"]),
			}
		}

		/* ── Reconciliation exceptions open as-of (KOBO) ─────────────────── */
		exc := map[string]any{}
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS c, COALESCE(SUM(amount_kobo),0) AS kobo
			FROM app.recon_exceptions
			WHERE status='open' AND (txn_date IS NULL OR txn_date <= $1::date)`, asOf); len(rows) > 0 {
			exc["recon_open_count"] = toInt64(rows[0]["c"])
			exc["recon_open_kobo"] = toInt64(rows[0]["kobo"])
		}
		if rows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS c FROM app.settlement_exceptions
			WHERE status <> 'resolved' AND (txn_date IS NULL OR txn_date <= $1::date)`, asOf); len(rows) > 0 {
			exc["settlement_open_count"] = toInt64(rows[0]["c"])
		}
		out["exceptions"] = exc

		respond(w, out, "pg")
	}
}
