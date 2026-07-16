package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// ── Route registration (called from RegisterCCStatements) ─────────────────────

func registerCCTemplateRoutes(r chi.Router, db *core.DB) {
	access := core.RequirePages("statements", "reports", "cards")
	r.With(access).Get("/{id}/render", ccRender(db))
	r.With(access).Post("/{id}/send", ccSendEmail(db))
}

// ── Render: returns full HTML CC statement for browser preview / print ────────

func ccRender(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		stmt, txns, err := ccLoad(r.Context(), db, id)
		if err != nil {
			http.Error(w, err.Error(), 404)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, ccBuildHTML(stmt, txns))
	}
}

// ── Send: emails the rendered statement to a recipient ────────────────────────

type ccSendRequest struct {
	RecipientEmail string `json:"recipient_email"`
	Subject        string `json:"subject"`
}

func ccSendEmail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body ccSendRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "invalid JSON")
			return
		}
		body.RecipientEmail = strings.TrimSpace(strings.ToLower(body.RecipientEmail))
		if body.RecipientEmail == "" {
			respondErr(w, 400, "recipient_email is required")
			return
		}
		if !strings.Contains(body.RecipientEmail, "@") {
			respondErr(w, 400, "invalid recipient_email")
			return
		}

		stmt, txns, err := ccLoad(r.Context(), db, id)
		if err != nil {
			respondErr(w, 404, err.Error())
			return
		}

		subject := strings.TrimSpace(body.Subject)
		if subject == "" {
			subject = fmt.Sprintf("Your O3 Capital Credit Card Statement — %s",
				ccFmtDate(getRowString(stmt, "statement_date")))
		}

		htmlBody := ccBuildHTML(stmt, txns)
		textBody := fmt.Sprintf(
			"Dear %s,\n\nPlease find your credit card statement for account %s.\n\nStatement Date: %s\nClosing Balance: %s\n\nRegards,\nO3 Capital Cards Team",
			getRowString(stmt, "customer_name"),
			getRowString(stmt, "account_number"),
			ccFmtDate(getRowString(stmt, "statement_date")),
			ccFmtKobo(toInt64(stmt["closing_balance_kobo"])),
		)

		user := core.UserFromCtx(r.Context())
		var createdBy int64
		if user != nil {
			createdBy = user.ID
		}

		res := SendMail(r.Context(), db, SendMailOptions{
			To:          []MailAddress{{Email: body.RecipientEmail, Name: getRowString(stmt, "customer_name")}},
			Subject:     subject,
			HTMLBody:    htmlBody,
			TextBody:    textBody,
			Category:    "cc_statement",
			Kind:        "cc_statement",
			RelatedType: "cc_statement",
			RelatedID:   toInt64(stmt["id"]),
			CreatedBy:   createdBy,
		})

		if !res.OK {
			respondErr(w, 502, "mail send failed: "+res.Error)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"ok":      true,
			"mail_id": res.MailID,
			"email":   body.RecipientEmail,
			"subject": subject,
		})
	}
}

// ── DB load helper ────────────────────────────────────────────────────────────

func ccLoad(ctx context.Context, db *core.DB, id string) (core.Row, []core.Row, error) {
	stmts, err := db.PGQuery(ctx, `
		SELECT s.*, u.name AS created_by_name
		FROM cc_statements s
		LEFT JOIN o3c_users u ON u.id = s.created_by
		WHERE s.id = $1`, id)
	if err != nil {
		return nil, nil, fmt.Errorf("db error: %w", err)
	}
	if len(stmts) == 0 {
		return nil, nil, errors.New("statement not found")
	}
	txns, err := db.PGQuery(ctx, `
		SELECT * FROM cc_transactions WHERE statement_id = $1 ORDER BY seq`, id)
	if err != nil {
		txns = []core.Row{}
	}
	return stmts[0], txns, nil
}

// ── HTML template ─────────────────────────────────────────────────────────────

func ccBuildHTML(stmt core.Row, txns []core.Row) string {
	esc := html.EscapeString

	customerName := getRowString(stmt, "customer_name")
	customerAddr := getRowString(stmt, "customer_address")
	accountNo := getRowString(stmt, "account_number")
	stmtDate := ccFmtDate(getRowString(stmt, "statement_date"))
	dueDate := ccFmtDate(getRowString(stmt, "payment_due_date"))
	openingBal := toInt64(stmt["opening_balance_kobo"])
	totalDebit := toInt64(stmt["total_debit_kobo"])
	totalCredit := toInt64(stmt["total_credit_kobo"])
	closingBal := toInt64(stmt["closing_balance_kobo"])
	minPayment := toInt64(stmt["min_payment_kobo"])
	financeCharge := toInt64(stmt["finance_charge_kobo"])
	lineOfCredit := toInt64(stmt["line_of_credit_kobo"])
	source := getRowString(stmt, "source")
	sourceFile := getRowString(stmt, "source_filename")

	overLimit := lineOfCredit > 0 && closingBal > lineOfCredit
	overLimitBy := int64(0)
	if overLimit {
		overLimitBy = closingBal - lineOfCredit
	}

	generatedAt := time.Now().Format("02 Jan 2006, 15:04")

	sourceLabel := "File Upload"
	if source == "db" {
		sourceLabel = "Database Query"
	} else if sourceFile != "" {
		sourceLabel = "File: " + sourceFile
	}

	// transaction rows
	var txnRows strings.Builder
	totalDr := int64(0)
	totalCr := int64(0)
	nonFinanceCount := 0
	prevCard := ""
	for _, t := range txns {
		dr := toInt64(t["debit_kobo"])
		cr := toInt64(t["credit_kobo"])
		totalDr += dr
		totalCr += cr
		isFC := toBool(t["is_finance_charge"])
		if !isFC {
			nonFinanceCount++
		}
		rowBg := "#ffffff"
		if isFC {
			rowBg = "#FFFBEB"
		}
		card := getRowString(t, "card_pan")
		if card != "" && card != prevCard {
			txnRows.WriteString(fmt.Sprintf(
				`<tr><td colspan="6" style="padding:10px 14px 4px;font-size:11px;font-weight:700;letter-spacing:.05em;color:#64748B;background:#F8FAFC;border-bottom:1px solid #E2E8F0;text-transform:uppercase">Card: %s</td></tr>`,
				esc(card)))
			prevCard = card
		}
		descStyle := "color:#0E2841"
		descSuffix := ""
		if isFC {
			descStyle = "color:#B45309;font-weight:600"
			descSuffix = ` <span style="font-size:10px;background:#FEF3C7;color:#B45309;border-radius:3px;padding:1px 5px;margin-left:4px">charge</span>`
		}
		drStr := "—"
		crStr := "—"
		if dr > 0 {
			drStr = ccFmtKobo(dr)
		}
		if cr > 0 {
			crStr = ccFmtKobo(cr)
		}
		txnRows.WriteString(fmt.Sprintf(
			`<tr style="background:%s;border-bottom:1px solid #F1F5F9">
				<td style="padding:10px 14px;font-size:12px;color:#64748B;white-space:nowrap">%s</td>
				<td style="padding:10px 14px;font-size:12px;color:#64748B;white-space:nowrap">%s</td>
				<td style="padding:10px 14px;font-size:11px;color:#94A3B8;font-family:monospace">%s</td>
				<td style="padding:10px 14px;font-size:13px;%s">%s%s</td>
				<td style="padding:10px 14px;font-size:13px;font-family:monospace;color:#C00000;text-align:right;white-space:nowrap">%s</td>
				<td style="padding:10px 14px;font-size:13px;font-family:monospace;color:#15803D;text-align:right;white-space:nowrap">%s</td>
			</tr>`,
			rowBg,
			esc(ccFmtDate(getRowString(t, "txn_date"))),
			esc(ccFmtDate(getRowString(t, "posting_date"))),
			esc(getRowString(t, "trace_no")),
			descStyle, esc(getRowString(t, "description")), descSuffix,
			esc(drStr), esc(crStr),
		))
	}

	// over-limit banner
	overLimitHTML := ""
	if overLimit {
		overLimitHTML = fmt.Sprintf(
			`<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#991B1B">
				<strong>&#9888; Over credit limit</strong> — Balance exceeds line of credit by <strong>%s</strong>
			</div>`, esc(ccFmtKobo(overLimitBy)))
	}

	// summary table rows
	mkRow := func(label, value, color string) string {
		if color == "" {
			color = "#0E2841"
		}
		return fmt.Sprintf(
			`<tr><td style="padding:7px 0;font-size:13px;color:#64748B">%s</td><td style="padding:7px 0;font-size:13px;font-family:monospace;font-weight:600;color:%s;text-align:right">%s</td></tr>`,
			esc(label), color, esc(value))
	}
	var summaryHTML strings.Builder
	summaryHTML.WriteString(mkRow("Opening Balance", ccFmtKobo(openingBal), ""))
	summaryHTML.WriteString(mkRow("Total Debits", ccFmtKobo(totalDebit), "#C00000"))
	summaryHTML.WriteString(mkRow("Total Credits", ccFmtKobo(totalCredit), "#15803D"))
	if financeCharge > 0 {
		summaryHTML.WriteString(mkRow("Finance Charges", ccFmtKobo(financeCharge), "#B45309"))
	}
	closingColor := "#0E2841"
	if overLimit {
		closingColor = "#C00000"
	}
	summaryHTML.WriteString(mkRow("Closing Balance", ccFmtKobo(closingBal), closingColor))
	if lineOfCredit > 0 {
		summaryHTML.WriteString(mkRow("Line of Credit", ccFmtKobo(lineOfCredit), ""))
	}
	if minPayment > 0 {
		summaryHTML.WriteString(mkRow("Minimum Payment", ccFmtKobo(minPayment), "#C00000"))
	}

	// customer address lines
	var addrLines strings.Builder
	if customerAddr != "" {
		for _, line := range strings.Split(customerAddr, "\n") {
			line = strings.TrimSpace(line)
			if line != "" {
				addrLines.WriteString(fmt.Sprintf(
					`<div style="font-size:12px;color:#64748B;margin-top:2px">%s</div>`, esc(line)))
			}
		}
	}

	// payment due row in summary
	dueDateRow := ""
	if dueDate != "" && dueDate != "—" {
		dueDateRow = fmt.Sprintf(
			`<tr><td style="padding:7px 0;font-size:13px;color:#64748B">Payment Due</td><td style="padding:7px 0;font-size:13px;font-family:monospace;font-weight:600;color:#C00000;text-align:right">%s</td></tr>`,
			esc(dueDate))
	}

	minPayStr := ccFmtKobo(minPayment)
	if minPayment == 0 {
		minPayStr = "the outstanding amount"
	}

	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Credit Card Statement &#8212; %s</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;background:#F4F6F8;color:#0E2841}
@media print{body{background:#fff}.no-print{display:none!important}.page{box-shadow:none;margin:0;max-width:none;border-radius:0}}
</style>
</head>
<body>

<div class="no-print" style="background:#0E2841;color:#fff;padding:10px 24px;display:flex;align-items:center;justify-content:space-between;font-size:13px;position:sticky;top:0;z-index:10">
  <span style="font-weight:600">Credit Card Statement Preview</span>
  <button onclick="window.print()" style="background:#C00000;color:#fff;border:none;border-radius:4px;padding:7px 18px;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:.03em">&#128438; Print / Save as PDF</button>
</div>

<div class="page" style="max-width:860px;margin:24px auto 48px;background:#fff;box-shadow:0 2px 16px rgba(0,0,0,.1);border-radius:8px;overflow:hidden">

  <!-- Statement header -->
  <div style="background:#0E2841;padding:24px 32px;color:#fff">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px">
      <div>
        <div style="font-size:24px;font-weight:700;letter-spacing:.02em">O3 CAPITAL</div>
        <div style="font-size:10px;letter-spacing:.15em;margin-top:4px;opacity:.6;text-transform:uppercase">Cards Division · Confidential Statement</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;opacity:.7;margin-bottom:6px">Credit Card Statement</div>
        <div style="font-size:13px;font-family:monospace;opacity:.9">Account: %s</div>
        <div style="font-size:12px;opacity:.7;margin-top:3px">Statement Date: %s</div>
      </div>
    </div>
  </div>
  <div style="height:4px;background:#C00000"></div>

  <!-- Customer + Summary -->
  <div style="display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #E2E8F0">
    <div style="padding:24px 32px;border-right:1px solid #E2E8F0">
      <div style="font-size:10px;font-weight:700;letter-spacing:.1em;color:#94A3B8;text-transform:uppercase;margin-bottom:10px">Cardholder</div>
      <div style="font-size:17px;font-weight:700;color:#0E2841;margin-bottom:4px">%s</div>
      %s
      <div style="margin-top:16px;padding-top:14px;border-top:1px dashed #E2E8F0">
        <div style="font-size:10px;font-weight:700;letter-spacing:.1em;color:#94A3B8;text-transform:uppercase;margin-bottom:5px">Data Source</div>
        <div style="font-size:12px;color:#64748B">%s</div>
        <div style="font-size:11px;color:#CBD5E1;margin-top:2px">Generated %s</div>
      </div>
    </div>
    <div style="padding:24px 32px">
      <div style="font-size:10px;font-weight:700;letter-spacing:.1em;color:#94A3B8;text-transform:uppercase;margin-bottom:10px">Cycle Summary</div>
      <table style="width:100%%;border-collapse:collapse">
        %s
        %s
      </table>
      <div style="margin-top:12px;padding-top:12px;border-top:1px dashed #E2E8F0;font-size:12px;color:#64748B">
        %d transaction%s this cycle
      </div>
    </div>
  </div>

  <!-- Body -->
  <div style="padding:24px 32px">
    %s
    <div style="font-size:10px;font-weight:700;letter-spacing:.1em;color:#94A3B8;text-transform:uppercase;margin-bottom:12px">Transaction Detail</div>
    <div style="overflow-x:auto;border-radius:6px;border:1px solid #E2E8F0">
      <table style="width:100%%;border-collapse:collapse;font-size:13px;min-width:580px">
        <thead>
          <tr style="background:#F8FAFC">
            <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:.07em;color:#475569;text-transform:uppercase;border-bottom:1px solid #E2E8F0;white-space:nowrap">Txn Date</th>
            <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:.07em;color:#475569;text-transform:uppercase;border-bottom:1px solid #E2E8F0;white-space:nowrap">Posting</th>
            <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:.07em;color:#475569;text-transform:uppercase;border-bottom:1px solid #E2E8F0">Trace No.</th>
            <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;letter-spacing:.07em;color:#475569;text-transform:uppercase;border-bottom:1px solid #E2E8F0">Description</th>
            <th style="padding:10px 14px;text-align:right;font-size:10px;font-weight:700;letter-spacing:.07em;color:#C00000;text-transform:uppercase;border-bottom:1px solid #E2E8F0">Debit (&#8358;)</th>
            <th style="padding:10px 14px;text-align:right;font-size:10px;font-weight:700;letter-spacing:.07em;color:#15803D;text-transform:uppercase;border-bottom:1px solid #E2E8F0">Credit (&#8358;)</th>
          </tr>
        </thead>
        <tbody>%s</tbody>
        <tfoot>
          <tr style="background:#F8FAFC;font-weight:700">
            <td colspan="4" style="padding:10px 14px;font-size:12px;color:#475569">Totals (%d transactions)</td>
            <td style="padding:10px 14px;font-size:13px;font-family:monospace;color:#C00000;text-align:right">%s</td>
            <td style="padding:10px 14px;font-size:13px;font-family:monospace;color:#15803D;text-align:right">%s</td>
          </tr>
        </tfoot>
      </table>
    </div>
  </div>

  <!-- Footer -->
  <div style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
      <div>
        <div style="font-size:10px;font-weight:700;letter-spacing:.1em;color:#94A3B8;text-transform:uppercase;margin-bottom:8px">Payment Instructions</div>
        <div style="font-size:12px;color:#475569;line-height:1.7">
          Please ensure a minimum payment of <strong>%s</strong> is received by <strong>%s</strong>.
          Failure to pay the minimum amount may result in additional charges and affect your credit standing.
        </div>
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;letter-spacing:.1em;color:#94A3B8;text-transform:uppercase;margin-bottom:8px">Disclaimer</div>
        <div style="font-size:11px;color:#94A3B8;line-height:1.6">
          This statement is confidential and intended solely for the named cardholder.
          If received in error, contact O3 Capital Cards support immediately.
          All amounts are in Nigerian Naira (&#8358;).
        </div>
      </div>
    </div>
    <div style="margin-top:16px;padding-top:14px;border-top:1px dashed #E2E8F0;text-align:center;font-size:11px;color:#CBD5E1">
      O3 Capital &middot; Cards Division &middot; Generated %s
    </div>
  </div>

</div>
</body>
</html>`,
		// title
		esc(customerName),
		// header: account no, stmt date
		esc(accountNo), esc(stmtDate),
		// customer section
		esc(customerName), addrLines.String(),
		esc(sourceLabel), esc(generatedAt),
		// summary
		summaryHTML.String(), dueDateRow,
		nonFinanceCount, pluralS(nonFinanceCount),
		// body
		overLimitHTML,
		txnRows.String(),
		nonFinanceCount,
		esc(ccFmtKobo(totalDr)), esc(ccFmtKobo(totalCr)),
		// footer
		esc(minPayStr), esc(dueDate),
		esc(generatedAt),
	)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func ccFmtKobo(kobo int64) string {
	if kobo == 0 {
		return "₦0.00"
	}
	neg := kobo < 0
	if neg {
		kobo = -kobo
	}
	naira := kobo / 100
	frac := kobo % 100
	s := ccCommas(naira)
	result := fmt.Sprintf("₦%s.%02d", s, frac)
	if neg {
		return "-" + result
	}
	return result
}

func ccCommas(n int64) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	rem := len(s) % 3
	if rem != 0 {
		b.WriteString(s[:rem])
		if len(s) > rem {
			b.WriteByte(',')
		}
	}
	for i := rem; i < len(s); i += 3 {
		b.WriteString(s[i : i+3])
		if i+3 < len(s) {
			b.WriteByte(',')
		}
	}
	return b.String()
}

func ccFmtDate(s string) string {
	if s == "" {
		return "—"
	}
	for _, layout := range []string{
		"2006-01-02T15:04:05Z07:00",
		"2006-01-02T15:04:05Z",
		"2006-01-02",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Format("02 Jan 2006")
		}
	}
	if len(s) >= 10 {
		return s[:10]
	}
	return s
}

func pluralS(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func toBool(v any) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return false
}
