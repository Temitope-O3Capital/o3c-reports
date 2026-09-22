package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"time"

	"github.com/o3c/workspace/core"
)

// ScheduleAccountAlerts runs daily at 08:00 and notifies Sales Account Managers
// about upcoming and overdue loan repayments and FD maturities in their portfolio.
func ScheduleAccountAlerts(db *core.DB) {
	now := time.Now()
	next08 := time.Date(now.Year(), now.Month(), now.Day(), 8, 0, 0, 0, now.Location())
	if now.After(next08) {
		next08 = next08.Add(24 * time.Hour)
	}
	time.Sleep(next08.Sub(now))

	for {
		runAccountAlerts(db)
		time.Sleep(24 * time.Hour)
	}
}

func runAccountAlerts(db *core.DB) {
	ctx := context.Background()
	WorkerBeat(ctx, db, "account_alerts", "running", "", "")
	runLoanAlerts(ctx, db)
	runFDAlerts(ctx, db)
	WorkerBeat(ctx, db, "account_alerts", "ok", "loan + FD alerts swept", "")
}

// ── Loan alerts ───────────────────────────────────────────────────────────────

func runLoanAlerts(ctx context.Context, db *core.DB) {
	type loanHit struct {
		accountManagerID int64
		customerName     string
		cif              string
		loanID           int64
		nextDueDate      string
		dpd              int
	}

	// Loans almost due (7 days, 3 days) and due today.
	rows, err := db.PGQuery(ctx, `
		SELECT
		    c.account_manager_id,
		    c.first_name || ' ' || c.last_name AS customer_name,
		    c.cif_number,
		    la.id                              AS loan_id,
		    la.next_due_date::text             AS next_due_date,
		    la.dpd
		FROM loan_applications la
		JOIN crm_contacts c ON c.cif_number = la.applicant_cif
		WHERE c.account_manager_id IS NOT NULL
		  AND c.status = 'customer'
		  AND la.status IN ('active','booked')
		  AND la.next_due_date IN (CURRENT_DATE + 7, CURRENT_DATE + 3, CURRENT_DATE)`)
	if err != nil {
		slog.Error("account_alerts: loan due-soon query failed", "err", err)
	}
	for _, row := range rows {
		hit := loanHit{
			accountManagerID: toInt64(row["account_manager_id"]),
			customerName:     str(row["customer_name"]),
			cif:              str(row["cif_number"]),
			loanID:           toInt64(row["loan_id"]),
			nextDueDate:      str(row["next_due_date"]),
		}
		dueIn := 0
		if d, _ := time.Parse("2006-01-02", hit.nextDueDate); !d.IsZero() {
			dueIn = int(time.Until(d).Hours()/24) + 1
		}
		switch {
		case dueIn >= 7:
			Notify(ctx, db, NotifPayload{
				EventType: EvtLoanRepaymentDueSoon,
				UserID:    hit.accountManagerID,
				Title:     fmt.Sprintf("Loan Due in 7 Days — %s", hit.customerName),
				Body:      fmt.Sprintf("The loan for %s (CIF: %s) is due on %s. Follow up to ensure repayment.", hit.customerName, hit.cif, hit.nextDueDate),
				ActionURL: fmt.Sprintf("/sales/accounts?cif=%s", hit.cif),
				EntityRef: fmt.Sprintf("loan:%d", hit.loanID),
			})
		case dueIn >= 3:
			Notify(ctx, db, NotifPayload{
				EventType: EvtLoanRepaymentDue3Days,
				UserID:    hit.accountManagerID,
				Title:     fmt.Sprintf("Loan Due in 3 Days — %s", hit.customerName),
				Body:      fmt.Sprintf("The loan for %s (CIF: %s) is due on %s. Contact the customer to confirm repayment.", hit.customerName, hit.cif, hit.nextDueDate),
				ActionURL: fmt.Sprintf("/sales/accounts?cif=%s", hit.cif),
				EntityRef: fmt.Sprintf("loan:%d", hit.loanID),
			})
		default:
			Notify(ctx, db, NotifPayload{
				EventType: EvtLoanRepaymentDueToday,
				UserID:    hit.accountManagerID,
				Title:     fmt.Sprintf("Loan Due Today — %s", hit.customerName),
				Body:      fmt.Sprintf("The loan for %s (CIF: %s) is due for repayment today. Confirm payment to avoid delinquency.", hit.customerName, hit.cif),
				ActionURL: fmt.Sprintf("/sales/accounts?cif=%s", hit.cif),
				EntityRef: fmt.Sprintf("loan:%d", hit.loanID),
			})
		}
	}

	// Loans past due (DPD > 0) — daily alert so the AM stays on top of their book.
	pastDueRows, err := db.PGQuery(ctx, `
		SELECT
		    c.account_manager_id,
		    c.first_name || ' ' || c.last_name AS customer_name,
		    c.cif_number,
		    la.id   AS loan_id,
		    la.dpd
		FROM loan_applications la
		JOIN crm_contacts c ON c.cif_number = la.applicant_cif
		WHERE c.account_manager_id IS NOT NULL
		  AND c.status = 'customer'
		  AND la.status IN ('active','booked')
		  AND la.dpd > 0`)
	if err != nil {
		slog.Error("account_alerts: loan past-due query failed", "err", err)
	}
	for _, row := range pastDueRows {
		dpd := int(toInt64(row["dpd"]))
		amID := toInt64(row["account_manager_id"])
		name := str(row["customer_name"])
		cif := str(row["cif_number"])
		loanID := toInt64(row["loan_id"])
		Notify(ctx, db, NotifPayload{
			EventType: EvtLoanPastDue,
			UserID:    amID,
			Title:     fmt.Sprintf("Overdue Loan — %s (DPD %d)", name, dpd),
			Body:      fmt.Sprintf("The loan for %s (CIF: %s) is %d day(s) past due. Immediate follow-up required.", name, cif, dpd),
			ActionURL: fmt.Sprintf("/sales/accounts?cif=%s", cif),
			EntityRef: fmt.Sprintf("loan:%d", loanID),
		})
	}
}

// ── FD alerts ─────────────────────────────────────────────────────────────────

// fdDeepLink is the deep link for a single deposit. /operations/fixed-deposit
// was never a route in App.tsx, so every FD alert ever raised carried a dead
// link; the FD surfaces now live at /deposits (the old /finance/fd-* paths
// redirect there). The register tab keyed by CBS account number is the closest
// thing to a per-deposit view the workspace has.
func fdDeepLink(accountNumber string) string {
	if accountNumber == "" {
		return "/deposits"
	}
	return "/deposits?tab=register&q=" + url.QueryEscape(accountNumber)
}

// runFDAlerts notifies the Udara account officer about deposits coming up to
// maturity, and about deposits that have gone past maturity while still Active.
//
// It used to read app.fd_transactions, which has 0 rows — so the 7-day, 3-day,
// today and matured-unactioned alerts all looped over an empty set and the
// worker still reported "ok". The live book is app.cbs_fixed_deposits.
//
// Recipient: the old query tried fd_transactions.sales_officer_id, falling back
// to the crm_contacts account manager joined on cif_number. Neither exists on
// the CBS register — cbs_customer_id is Udara's own id, not a workspace CIF
// (only 27 of 380 collide by accident, and NONE of those contacts carries an
// account_manager_id). The crosswalk that does work, and that sales.go and
// executive.go already use, is app.cbs_officer_map: raw->>'accountOfficerName'
// → officer_user_id, with 100% coverage of all 230 Active deposits.
//
// The join is btrim'd on BOTH sides. Udara pads 7 of the 21 officer names with a
// trailing space and the map was hand-seeded from those exact strings, so plain
// equality matches only by luck: trim either side alone and 173 of 380 deposits
// (98 on the active book, 6 officers, ₦11.03bn of principal) would silently stop
// matching. Trimming both sides is correct against the data as it stands today
// and stays correct once the stored names are normalised.
func runFDAlerts(ctx context.Context, db *core.DB) {
	// One query covers maturing in 7 / 3 / 0 days and already past maturity.
	//
	// Every date comparison goes through ::date. gts parses Udara's timestamps as
	// UTC while the session runs in Africa/Lagos, so each maturity sits at
	// 01:00:00+01 and a bare `= CURRENT_DATE + 7` matches nothing at all.
	//
	// Unfunded shells (hasDisbursed = false, principal 0) are excluded: there is no
	// money to roll over or liquidate, so an alert on one is pure noise.
	rows, err := db.PGQuery(ctx, `
		SELECT
		    m.officer_user_id                       AS notify_user_id,
		    f.raw->>'name'                          AS customer_name,
		    f.cbs_customer_id,
		    f.cbs_account_number,
		    f.principal_kobo,
		    COALESCE(f.accrued_interest_kobo, 0)    AS accrued_interest_kobo,
		    to_char(f.maturity_date, 'YYYY-MM-DD')  AS maturity_date,
		    (f.maturity_date::date - CURRENT_DATE)  AS days_to_maturity
		FROM cbs_fixed_deposits f
		JOIN app.cbs_officer_map m
		  ON btrim(m.udara_name) = btrim(f.raw->>'accountOfficerName')
		 AND m.officer_user_id IS NOT NULL
		WHERE f.status = 'Active'
		  AND f.raw->>'hasDisbursed' IS DISTINCT FROM 'false'
		  AND (f.maturity_date::date IN (CURRENT_DATE + 7, CURRENT_DATE + 3, CURRENT_DATE)
		       OR f.maturity_date::date < CURRENT_DATE)
		ORDER BY f.maturity_date, f.principal_kobo DESC`)
	if err != nil {
		slog.Error("account_alerts: FD maturity query failed", "err", err)
		return
	}

	// Past-due deposits are a standing backlog, not a fresh event: the same six
	// deposits would otherwise raise six alarms every morning until someone acts.
	// They are collapsed into one digest per officer, carried on a GroupKey so the
	// bell updates a single row in place and only the first send leaves the app.
	type pastDue struct {
		count        int
		amountKobo   int64
		oldestDays   int64
		firstCust    string
		firstAccount string
	}
	overdue := map[int64]*pastDue{}

	var soon, due int

	for _, row := range rows {
		userID := toInt64(row["notify_user_id"])
		if userID == 0 {
			continue
		}
		name := str(row["customer_name"])
		acct := str(row["cbs_account_number"])
		cif := str(row["cbs_customer_id"])
		matDate := str(row["maturity_date"])
		days := toInt64(row["days_to_maturity"])
		amount := toInt64(row["principal_kobo"]) + toInt64(row["accrued_interest_kobo"])
		link := fdDeepLink(acct)
		ref := "fd:" + acct

		switch {
		case days == 7:
			soon++
			Notify(ctx, db, NotifPayload{
				EventType: EvtFDMaturing7Days,
				UserID:    userID,
				Title:     fmt.Sprintf("FD Maturing in 7 Days — %s", name),
				Body: fmt.Sprintf("The fixed deposit for %s (CIF: %s, a/c %s) matures on %s — %s principal and interest. Contact the customer to discuss rollover or liquidation.",
					name, cif, acct, matDate, fmtKoboServer(amount)),
				ActionURL: link,
				EntityRef: ref,
			})
		case days == 3:
			soon++
			Notify(ctx, db, NotifPayload{
				EventType: EvtFDMaturing3Days,
				UserID:    userID,
				Title:     fmt.Sprintf("FD Maturing in 3 Days — %s", name),
				Body: fmt.Sprintf("The fixed deposit for %s (CIF: %s, a/c %s) matures on %s — %s principal and interest. Confirm rollover or liquidation instructions now.",
					name, cif, acct, matDate, fmtKoboServer(amount)),
				ActionURL: link,
				EntityRef: ref,
				Priority:  "high",
			})
		case days == 0:
			due++
			Notify(ctx, db, NotifPayload{
				EventType: EvtFDMaturingToday,
				UserID:    userID,
				Title:     fmt.Sprintf("FD Maturing Today — %s", name),
				Body: fmt.Sprintf("The fixed deposit for %s (CIF: %s, a/c %s) matures today — %s principal and interest. Confirm rollover or liquidation instructions with the customer.",
					name, cif, acct, fmtKoboServer(amount)),
				ActionURL: link,
				EntityRef: ref,
				Priority:  "high",
			})
		case days < 0:
			p := overdue[userID]
			if p == nil {
				p = &pastDue{}
				overdue[userID] = p
			}
			p.count++
			p.amountKobo += amount
			if od := -days; od > p.oldestDays {
				p.oldestDays = od
			}
			if p.firstCust == "" {
				p.firstCust = name
				p.firstAccount = acct
			}
		}
	}

	// Matured but still Active — the money is payable now and nothing in the
	// workspace has ever said so.
	for userID, p := range overdue {
		title := fmt.Sprintf("Matured FD — Action Required — %s", p.firstCust)
		body := fmt.Sprintf("The fixed deposit for %s (a/c %s) passed maturity %d day(s) ago and is still open — %s principal and interest. Confirm rollover or liquidation instructions with the customer.",
			p.firstCust, p.firstAccount, p.oldestDays, fmtKoboServer(p.amountKobo))
		link := fdDeepLink(p.firstAccount)
		if p.count > 1 {
			title = fmt.Sprintf("%d Matured FDs — Action Required", p.count)
			body = fmt.Sprintf("%d of your fixed deposits have passed maturity and are still open — %s principal and interest in total, the oldest %d day(s) overdue. Confirm rollover or liquidation instructions with each customer.",
				p.count, fmtKoboServer(p.amountKobo), p.oldestDays)
			link = "/deposits"
		}
		Notify(ctx, db, NotifPayload{
			EventType: EvtFDMaturedUnactioned,
			UserID:    userID,
			Title:     title,
			Body:      body,
			ActionURL: link,
			EntityRef: fmt.Sprintf("fd_past_due:%d", userID),
			GroupKey:  "fd_past_due",
			Priority:  "urgent",
		})
	}

	slog.Info("account_alerts: FD maturity alerts",
		"maturing_soon", soon, "maturing_today", due, "past_due_officers", len(overdue))
}
