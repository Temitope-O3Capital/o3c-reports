package handlers

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// RegisterFinance mounts the Finance module API. Finance is a read-only
// *reporting* surface: it summarises income, fixed-deposit and treasury
// positions derived from other modules' data. It performs no financial
// actions — GL postings live in the shared GL engine, manual journals in the
// Settlements module, and P&L / Budget / Cost Tracking / Chart of Accounts
// were retired. Every route below is a GET bar the FX refresh; no mutations
// belong here.
//
// Every handler answers through respond()/respondPaginated(), so the module
// speaks one wire envelope and the frontend unwraps uniformly.
//
// Retired here: /income, /income/chart, /income/summary, /income/loans,
// /income/fee-types and /fd-kpis. Nothing called them — the live surfaces are
// /income-statement and /api/fd-book/kpis — and two of them could not have
// returned anything current if something had: card_cycle_data is a statement
// snapshot frozen at 2026-07-14, and fee_income has never held a row.
func RegisterFinance(r chi.Router, db *core.DB) {
	access := core.RequirePages("finance", "income")

	// Income statement — transaction-derived revenue (app.income_daily) folded
	// with loan-schedule interest. See finance_income.go.
	r.With(access).Get("/income-statement", finIncomeStatement(db))

	// Per-FD daily interest accrual, from the live CBS register.
	r.With(access).Get("/fd-accrual", finFDAccrual(db))

	// Derived End-of-Day report (computed from app.transactions + snapshots;
	// no upload). See finance_eod.go.
	//
	// Gated on "eod" as well as the module keys. The page route gates on `eod`
	// alone, and settlement roles are granted `eod` WITHOUT `income`/`finance`
	// — so before this a settlement officer could open End of Day and then 403
	// on every call the page makes. /transactions below already had the
	// equivalent widening; this is the same fix for the same reason.
	eodAccess := core.RequirePages("finance", "income", "eod")
	r.With(eodAccess).Get("/eod", finEODReport(db))
	r.With(eodAccess).Get("/eod/dates", finEODDates(db))

	// Movement ledger (live transaction feed, replaces the old EOD-file list).
	// Also reachable by holders of the standalone "transactions" page-key so the
	// page and its data share one gate.
	txnAccess := core.RequirePages("finance", "income", "transactions")
	r.With(txnAccess).Get("/transactions", finTransactionsList(db))
	r.With(txnAccess).Get("/transaction-kpis", finTransactionKPIs(db))

	// Treasury reporting (derived from the live transaction feed and the daily
	// portfolio snapshots)
	r.With(access).Get("/treasury", finTreasury(db))

	// Financial position — assets and liabilities per currency, from the books of
	// record. See finPosition below for why this is not the general ledger.
	r.With(access).Get("/position", finPosition(db))

	// FX (parallel-market) rates. Gated on "fx_rates" for the same reason as
	// /eod — the page route gates on that key alone. The refresh POST triggers
	// an outbound scrape + inserts, so it is gated too (it previously sat
	// ungated on the /api/finance group).
	fxAccess := core.RequirePages("finance", "income", "fx_rates")
	r.With(fxAccess).Get("/fx-rates/latest", FXRatesLatest(db))
	r.With(fxAccess).Get("/fx-rates/history", FXRatesHistory(db))
	r.With(fxAccess).Post("/fx-rates/refresh", FXRatesRefresh(db))
}

/* ── Financial position ──────────────────────────────────────────────────────

   Assets and liabilities per currency, from app.financial_position (migration
   282) — the live books of record, NOT gl_journal_entries.

   That distinction is the whole point. The GL holds 1,802 rows, all of them
   collections payments the workspace itself posted, against a chart of accounts
   that until migration 282 had no Liability class at all. The ₦19.61bn deposit
   book has never touched it. Reading a balance sheet off that ledger would have
   reported a business with two asset accounts and no funding.

   Two things this deliberately does NOT do:

     It does not convert. Naira and dollar lines are separate; there is no FX
     rate policy in this database and inventing one inside a balance sheet is
     how a rate assumption becomes a reported fact.

     It does not report equity. Assets minus liabilities is returned as
     net_position, and the payload says so. There is no capital, reserves or
     retained-earnings source anywhere here — the GL's 3000/3100 accounts exist
     so postings CAN be made, not because anything has been. A figure labelled
     equity would be a guess wearing an accounting label.
*/

func finPosition(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		lines, err := db.PGQuery(ctx, `
			SELECT currency, side, line, gl_code, amount_kobo, items
			  FROM app.financial_position
			 ORDER BY currency, side, sort`)
		if err != nil {
			respondErrLog(w, 500, "Financial position query failed", err)
			return
		}

		// Totals per currency, assets and liabilities kept apart.
		type ccy struct {
			Currency    string `json:"currency"`
			AssetsKobo  int64  `json:"assets_kobo"`
			LiabsKobo   int64  `json:"liabilities_kobo"`
			NetPosition int64  `json:"net_position_kobo"`
		}
		order := []string{}
		byCcy := map[string]*ccy{}
		for _, l := range lines {
			c := str(l["currency"])
			if byCcy[c] == nil {
				byCcy[c] = &ccy{Currency: c}
				order = append(order, c)
			}
			if str(l["side"]) == "Asset" {
				byCcy[c].AssetsKobo += toInt64(l["amount_kobo"])
			} else {
				byCcy[c].LiabsKobo += toInt64(l["amount_kobo"])
			}
		}
		totals := make([]ccy, 0, len(order))
		for _, c := range order {
			byCcy[c].NetPosition = byCcy[c].AssetsKobo - byCcy[c].LiabsKobo
			totals = append(totals, *byCcy[c])
		}

		// How stale each source is, so a stalled feed shows as a date rather than
		// as a quietly wrong position.
		asOf := map[string]any{}
		if rows, _ := db.PGQuery(ctx, `
			SELECT (SELECT MAX(last_seen)::date::text FROM app.accounts)          AS cards,
			       (SELECT MAX(snapshot_date)::text FROM app.cbs_portfolio_snapshot) AS cbs`); len(rows) > 0 {
			asOf["cards"] = rows[0]["cards"]
			asOf["cbs"] = rows[0]["cbs"]
		}

		// GL coverage, stated plainly rather than implied by an empty page.
		var glEntries, glAccounts int64
		if rows, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM gl_journal_entries`); len(rows) > 0 {
			glEntries = toInt64(rows[0]["n"])
		}
		if rows, _ := db.PGQuery(ctx, `SELECT COUNT(*) AS n FROM gl_accounts`); len(rows) > 0 {
			glAccounts = toInt64(rows[0]["n"])
		}

		respond(w, map[string]any{
			"lines":       lines,
			"totals":      totals,
			"as_of":       asOf,
			"gl_entries":  glEntries,
			"gl_accounts": glAccounts,
			"basis": "Assets and liabilities from the live books of record (cbs_loans, " +
				"cbs_fixed_deposits, app.card_balances), not from the general ledger. " +
				"Amounts are in each line's own currency and are never summed across currencies — " +
				"no FX rate is applied. Assets minus liabilities is a NET POSITION, not equity: " +
				"this database holds no capital or reserves source.",
		}, "pg")
	}
}

/* ── Treasury ────────────────────────────────────────────────────────────────
   A position snapshot, not a general-ledger cash book (there is no populated
   GL / nostro table). "Net flow (30d)" is the transaction feed's credits minus
   debits over the trailing 30 days (NAIRA). FD liabilities and the loan book
   come from the live CBS register / snapshots (KOBO). Units are kept explicit
   in the key names so the frontend never mixes them. */

func finTreasury(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		// Cash-flow window. Defaults to the trailing 30 days, which is all this
		// used to support — the page had no control at all and the "(30d)" in its
		// KPI labels was the only clue. The window governs the FLOW half only:
		// the FD and loan books below have no history to filter, so they stay a
		// position as of now and the payload says which is which.
		from, _ := validDate(r, "date_from")
		to, _ := validDate(r, "date_to")
		flowWhere := "txn_date >= CURRENT_DATE - 30 AND txn_date <= CURRENT_DATE"
		var flowArgs []any
		if from != "" && to != "" {
			flowWhere = "txn_date >= $1::date AND txn_date <= $2::date"
			flowArgs = []any{from, to}
		}

		flowRows, _ := db.PGQuery(ctx, `
			SELECT
			    COALESCE(SUM(amount_credit), 0)                    AS inflow_ngn,
			    COALESCE(SUM(amount_debit), 0)                     AS outflow_ngn,
			    COALESCE(SUM(amount_credit),0) - COALESCE(SUM(amount_debit),0) AS net_flow_ngn
			FROM app.transactions
			WHERE `+flowWhere, flowArgs...)

		// FD book as a deposit liability (kobo). Scoped by status, not by
		// maturity_date >= CURRENT_DATE: that proxy counted 21 Closed deposits whose
		// maturity happens to be in the future as active, and dropped the 6 Active
		// deposits that are already past maturity — the ones the treasury most needs
		// to see, because they are payable now.
		fdRows, _ := db.PGQuery(ctx, `
			SELECT
			    COALESCE(SUM(principal_kobo), 0)        AS fd_liabilities_kobo,
			    COALESCE(SUM(accrued_interest_kobo), 0) AS fd_accrued_kobo,
			    COUNT(*)                                AS active_fds,
			    COUNT(*) FILTER (WHERE maturity_date::date < CURRENT_DATE) AS past_due_fds,
			    COALESCE(SUM(principal_kobo + COALESCE(accrued_interest_kobo,0))
			             FILTER (WHERE maturity_date::date < CURRENT_DATE), 0) AS past_due_kobo
			FROM app.cbs_fixed_deposits
			WHERE status='Active' AND `+sqlFDFunded)

		// Loan book outstanding (kobo) from the latest CBS portfolio snapshot.
		//
		// outstanding_interest_kobo belongs to the LOAN block of that snapshot
		// (alongside outstanding_principal_kobo / npl_kobo / performing_kobo): it is
		// interest receivable on the loan book, and the snapshot carries no FD
		// accrual column at all. It is named for the book it comes from so it cannot
		// be picked up as FD accrual — which is exactly what the End of Day report
		// was doing, showing ₦18.0m of loan interest under "Accrued Interest (FD)"
		// against a real FD accrual of ₦895.2m.
		var loanBookKobo, nplKobo, loanInterestKobo int64
		if rows, _ := db.PGQuery(ctx, `
			SELECT outstanding_principal_kobo, npl_kobo, outstanding_interest_kobo
			FROM app.cbs_portfolio_snapshot ORDER BY snapshot_date DESC LIMIT 1`); len(rows) > 0 {
			loanBookKobo = toInt64(rows[0]["outstanding_principal_kobo"])
			nplKobo = toInt64(rows[0]["npl_kobo"])
			loanInterestKobo = toInt64(rows[0]["outstanding_interest_kobo"])
		}

		out := map[string]any{
			"net_flow_ngn":        int64(0),
			"inflow_ngn":          int64(0),
			"outflow_ngn":         int64(0),
			"fd_liabilities_kobo": int64(0),
			"fd_accrued_kobo":     int64(0),
			"active_fds":          int64(0),
			"past_due_fds":        int64(0),
			"past_due_kobo":       int64(0),
			"loan_book_kobo":      loanBookKobo,
			"npl_kobo":            nplKobo,
			"loan_interest_kobo":  loanInterestKobo,
		}
		if len(flowRows) > 0 {
			out["net_flow_ngn"] = toInt64(flowRows[0]["net_flow_ngn"])
			out["inflow_ngn"] = toInt64(flowRows[0]["inflow_ngn"])
			out["outflow_ngn"] = toInt64(flowRows[0]["outflow_ngn"])
		}
		if len(fdRows) > 0 {
			out["fd_liabilities_kobo"] = toInt64(fdRows[0]["fd_liabilities_kobo"])
			out["fd_accrued_kobo"] = toInt64(fdRows[0]["fd_accrued_kobo"])
			out["active_fds"] = toInt64(fdRows[0]["active_fds"])
			out["past_due_fds"] = toInt64(fdRows[0]["past_due_fds"])
			out["past_due_kobo"] = toInt64(fdRows[0]["past_due_kobo"])
		}

		// Daily flow trend over the same window as the totals above.
		if rows, _ := db.PGQuery(ctx, `
			SELECT to_char(txn_date,'YYYY-MM-DD') AS date,
			       COALESCE(SUM(amount_credit),0) AS inflow_ngn,
			       COALESCE(SUM(amount_debit),0)  AS outflow_ngn,
			       COALESCE(SUM(amount_credit),0) - COALESCE(SUM(amount_debit),0) AS net_ngn
			FROM app.transactions
			WHERE `+flowWhere+`
			GROUP BY txn_date ORDER BY txn_date`, flowArgs...); rows != nil {
			out["flow_trend"] = rows
		}

		// Echo the resolved flow window so the page can label its own charts
		// instead of hard-coding "30d" next to a figure the caller may have
		// asked for over a different span.
		if rows, _ := db.PGQuery(ctx, `
			SELECT to_char(MIN(txn_date),'YYYY-MM-DD') AS f, to_char(MAX(txn_date),'YYYY-MM-DD') AS t
			FROM app.transactions WHERE `+flowWhere, flowArgs...); len(rows) > 0 {
			out["flow_from"] = rows[0]["f"]
			out["flow_to"] = rows[0]["t"]
		}
		respond(w, out, "pg")
	}
}

/* ── FD Accrual ──────────────────────────────────────────────────────────── */

func finFDAccrual(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		asOf, _ := validDate(r, "date")
		if asOf == "" {
			asOf = "CURRENT_DATE"
		} else {
			asOf = fmt.Sprintf("'%s'::date", asOf)
		}

		// Live CBS fixed-deposit register; accrued interest is carried by the record.
		//
		// Scoped on status, not on maturity_date >= CURRENT_DATE. That proxy pulled in
		// 21 Closed deposits (whose money fields Udara zeroes on closure, so they
		// accrue nothing and only padded the report) and dropped the 6 Active deposits
		// already past maturity — ₦497.2m principal on ₦58.6m accrued that is still
		// accruing and still owed. Those now appear, flagged with days_overdue.
		//
		// daily_interest_kobo falls back to the measured accrual where the contract
		// rate is missing (27 Active deposits, 25 of them visibly accruing), so the
		// report does not show them earning the depositor nothing.
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			    cf.cbs_id AS id,
			    cf.cbs_account_number,
			    cf.raw->>'name' AS customer_name, -- Udara's own name (cbs_customer_id != app.customers.cif)
			    cf.principal_kobo AS principal,
			    cf.interest_rate AS rate,
			    cf.commencement_date AS start_date,
			    cf.maturity_date,
			    cf.tenor_days,
			    GREATEST(0, %s - cf.commencement_date::date) AS days_elapsed,
			    GREATEST(0, CURRENT_DATE - cf.maturity_date::date) AS days_overdue,
			    (cf.maturity_date::date < CURRENT_DATE) AS is_past_due,
			    cf.accrued_interest_kobo,
			    ROUND(CASE
			        WHEN COALESCE(cf.interest_rate,0) > 0
			            THEN cf.principal_kobo::numeric * cf.interest_rate / 100 / 365
			        WHEN COALESCE(cf.accrued_interest_kobo,0) > 0 AND cf.commencement_date IS NOT NULL
			            THEN cf.accrued_interest_kobo::numeric
			                 / GREATEST(1, CURRENT_DATE - cf.commencement_date::date)
			        ELSE 0 END)::bigint AS daily_interest_kobo
			FROM cbs_fixed_deposits cf
			WHERE cf.status = 'Active'
			  AND cf.principal_kobo IS NOT NULL AND cf.principal_kobo > 0
			ORDER BY cf.accrued_interest_kobo DESC`, asOf))
		if err != nil {
			respondErr(w, 500, "FD accrual query failed: "+err.Error())
			return
		}
		respond(w, rows, "pg")
	}
}

// finTransactionKPIs — movement totals from the live transaction feed
// (app.transactions) over the SAME window and filters the ledger below is
// showing, defaulting to month-to-date when no window is given.
//
// It used to be hard-wired to month-to-date while the table it sits above was
// date-filtered, so setting the filter to January left a KPI strip still
// reporting September — two periods on one screen, neither of them labelled.
//
// Amounts are NAIRA (the feed is major-unit); keys are suffixed *_ngn so the
// frontend formats with fmt(), not fmtKobo().
func finTransactionKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := "txn_date <= CURRENT_DATE"
		var args []any
		n := 1
		if v, _ := validDate(r, "date_from"); v != "" {
			where += fmt.Sprintf(" AND txn_date >= $%d::date", n)
			args = append(args, v)
			n++
		} else {
			where += " AND txn_date >= date_trunc('month', CURRENT_DATE)::date"
		}
		if v, _ := validDate(r, "date_to"); v != "" {
			where += fmt.Sprintf(" AND txn_date <= $%d::date", n)
			args = append(args, v)
			n++
		}
		// Mirrors the ledger's channel handling, "unclassified" sentinel included,
		// so the strip and the table can never be filtered differently.
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
		_ = n

		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*)                                        AS total_count,
			  COALESCE(SUM(amount_credit), 0)                 AS total_credits_ngn,
			  COALESCE(SUM(amount_debit), 0)                  AS total_debits_ngn,
			  COALESCE(SUM(amount_credit),0) - COALESCE(SUM(amount_debit),0) AS net_position_ngn
			FROM app.transactions
			WHERE `+where, args...)
		if err != nil || len(rows) == 0 {
			respond(w, map[string]any{
				"total_count": 0, "total_credits_ngn": 0, "total_debits_ngn": 0, "net_position_ngn": 0,
			}, "pg")
			return
		}
		respond(w, rows[0], "pg")
	}
}
