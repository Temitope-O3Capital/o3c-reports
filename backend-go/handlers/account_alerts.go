package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/o3c/reports/core"
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
	runLoanAlerts(ctx, db)
	runFDAlerts(ctx, db)
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

func runFDAlerts(ctx context.Context, db *core.DB) {
	// Single query covers: maturing in 7 days, maturing today, matured yesterday (unactioned).
	// Uses sales_officer_id on the FD record if available, falls back to crm_contacts AM.
	rows, err := db.PGQuery(ctx, `
		SELECT
		    COALESCE(fd.sales_officer_id, c.account_manager_id) AS notify_user_id,
		    COALESCE(c.first_name || ' ' || c.last_name, fd.customer_name) AS customer_name,
		    fd.cif_number,
		    fd.id            AS fd_id,
		    fd.maturity_date::text AS maturity_date
		FROM fd_transactions fd
		LEFT JOIN crm_contacts c
		       ON c.cif_number = fd.cif_number AND c.status = 'customer'
		WHERE fd.transaction_type = 'inflow'
		  AND fd.maturity_date IN (CURRENT_DATE + 7, CURRENT_DATE + 3, CURRENT_DATE, CURRENT_DATE - 1)
		  AND COALESCE(fd.sales_officer_id, c.account_manager_id) IS NOT NULL`)
	if err != nil {
		slog.Error("account_alerts: FD maturity query failed", "err", err)
		return
	}

	today := time.Now().Format("2006-01-02")
	in3 := time.Now().AddDate(0, 0, 3).Format("2006-01-02")
	in7 := time.Now().AddDate(0, 0, 7).Format("2006-01-02")

	for _, row := range rows {
		userID := toInt64(row["notify_user_id"])
		name := str(row["customer_name"])
		cif := str(row["cif_number"])
		fdID := toInt64(row["fd_id"])
		matDate := str(row["maturity_date"])
		url := fmt.Sprintf("/operations/fixed-deposit?id=%d", fdID)
		ref := fmt.Sprintf("fd:%d", fdID)

		switch matDate {
		case in7:
			Notify(ctx, db, NotifPayload{
				EventType: EvtFDMaturing7Days,
				UserID:    userID,
				Title:     fmt.Sprintf("FD Maturing in 7 Days — %s", name),
				Body:      fmt.Sprintf("The fixed deposit for %s (CIF: %s) matures on %s. Contact the customer to discuss rollover or liquidation.", name, cif, matDate),
				ActionURL: url,
				EntityRef: ref,
			})
		case in3:
			Notify(ctx, db, NotifPayload{
				EventType: EvtFDMaturing3Days,
				UserID:    userID,
				Title:     fmt.Sprintf("FD Maturing in 3 Days — %s", name),
				Body:      fmt.Sprintf("The fixed deposit for %s (CIF: %s) matures on %s. Confirm rollover or liquidation instructions now.", name, cif, matDate),
				ActionURL: url,
				EntityRef: ref,
			})
		case today:
			Notify(ctx, db, NotifPayload{
				EventType: EvtFDMaturingToday,
				UserID:    userID,
				Title:     fmt.Sprintf("FD Maturing Today — %s", name),
				Body:      fmt.Sprintf("The fixed deposit for %s (CIF: %s) matures today. Confirm rollover or liquidation instructions with the customer.", name, cif),
				ActionURL: url,
				EntityRef: ref,
			})
		default:
			// maturity_date = yesterday — matured and not yet actioned
			Notify(ctx, db, NotifPayload{
				EventType: EvtFDMaturedUnactioned,
				UserID:    userID,
				Title:     fmt.Sprintf("Matured FD — Action Required — %s", name),
				Body:      fmt.Sprintf("The fixed deposit for %s (CIF: %s) matured on %s and has not been actioned. Please contact the customer immediately.", name, cif, matDate),
				ActionURL: url,
				EntityRef: ref,
			})
		}
	}
}
