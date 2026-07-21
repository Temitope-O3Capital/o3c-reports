package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// logoSVG is the flat 2D brand mark — white rim separates spheres on the navy header.
const logoSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 120" width="72" height="40" style="display:block"><circle cx="78" cy="60" r="52" fill="#C00000"/><circle cx="142" cy="60" r="52" fill="#282828"/><circle cx="110" cy="60" r="56" fill="#FFFFFF"/><circle cx="110" cy="60" r="52" fill="#8DAAB7"/></svg>`

// ── Route registration ────────────────────────────────────────────────────────

func registerCCTemplateRoutes(r chi.Router, db *core.DB) {
	access := core.RequirePages("statements", "reports", "cards")
	r.With(access).Get("/{id}/render", ccRender(db))
	r.With(access).Post("/{id}/send", ccSendEmail(db))
}

// ── Render ────────────────────────────────────────────────────────────────────

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

// ── Send by email ─────────────────────────────────────────────────────────────

type ccSendRequest struct {
	RecipientEmail string `json:"recipient_email"`
	RecipientPhone string `json:"recipient_phone"` // optional — triggers Termii SMS if set
	CC             string `json:"cc"`
	Subject        string `json:"subject"`
	EmailBody      string `json:"email_body"` // plain-text body (editable by sender)
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
		if body.RecipientEmail == "" || !strings.Contains(body.RecipientEmail, "@") {
			respondErr(w, 400, "valid recipient_email is required")
			return
		}
		body.CC        = strings.TrimSpace(strings.ToLower(body.CC))
		body.EmailBody = strings.TrimSpace(body.EmailBody)

		stmt, txns, err := ccLoad(r.Context(), db, id)
		if err != nil {
			respondErr(w, 404, err.Error())
			return
		}

		d := ccExtract(stmt)

		// Dynamic subject
		subject := strings.TrimSpace(body.Subject)
		if subject == "" {
			subject = ccDefaultSubject(d)
		}

		// Short notification email body (plain text → HTML wrapper)
		bodyText := body.EmailBody
		if bodyText == "" {
			bodyText = ccDefaultBodyText(d)
		}
		htmlBody  := ccBuildNotificationHTML(d, bodyText)
		textBody  := bodyText

		// PDF attachment — render HTML via headless Chrome for exact preview match.
		// Falls back to the raw PDF generator when Chrome is not installed (e.g. Railway without Chromium).
		htmlForPDF := ccBuildHTML(stmt, txns)
		pdfBytes := ccPDFForEmail(htmlForPDF, func() []byte { return ccBuildPDF(stmt, txns) })
		pdfB64     := base64.StdEncoding.EncodeToString(pdfBytes)
		pdfName    := ccPDFFilename(d)

		user := core.UserFromCtx(r.Context())
		var createdBy int64
		if user != nil {
			createdBy = user.ID
		}

		ccList := []MailAddress{}
		if body.CC != "" && strings.Contains(body.CC, "@") {
			ccList = append(ccList, MailAddress{Email: body.CC})
		}

		res := SendMail(r.Context(), db, SendMailOptions{
			To:       []MailAddress{{Email: body.RecipientEmail, Name: d.customerName}},
			CC:       ccList,
			Subject:  subject,
			HTMLBody: htmlBody,
			TextBody: textBody,
			Attachments: []MailAttachment{{
				Filename:    pdfName,
				ContentType: "application/pdf",
				Content:     pdfB64,
				Disposition: "attachment",
			}},
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

		// Optional SMS notification via Termii.
		smsSent := false
		if body.RecipientPhone != "" {
			smsText := fmt.Sprintf(
				"O3 Capital: Your credit card statement for account ****%s is ready. "+
					"Closing balance: NGN %s. Min payment: NGN %s due %s. "+
					"Check your email for the full statement.",
				func() string {
					n := d.accountNo
					if len(n) > 4 { return n[len(n)-4:] }
					return n
				}(),
				ccFmtKobo(d.closingBal),
				ccFmtKobo(d.minPayment),
				d.dueDate,
			)
			if err := SendSMS(r.Context(), body.RecipientPhone, smsText); err != nil {
				slog.Warn("ccSendEmail: SMS notification failed", "err", err)
			} else {
				smsSent = true
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"ok": true, "mail_id": res.MailID, "email": body.RecipientEmail,
			"subject": subject, "pdf_filename": pdfName, "sms_sent": smsSent,
		})
	}
}

// ── Subject / body helpers ────────────────────────────────────────────────────

func ccDefaultSubject(d ccData) string {
	last4 := d.accountNo
	if len(last4) > 4 {
		last4 = last4[len(last4)-4:]
	}
	var monthYear string
	if t, err := time.Parse("02 Jan 2006", d.stmtDate); err == nil {
		monthYear = t.Format("January 2006")
	} else {
		monthYear = d.stmtDate
	}
	return fmt.Sprintf("O3 Capital Credit Card E-Statement (****%s) - %s", last4, monthYear)
}

func ccDefaultBodyText(d ccData) string {
	last4 := d.accountNo
	if len(last4) > 4 {
		last4 = last4[len(last4)-4:]
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "Dear %s,\n\n", d.customerName)
	fmt.Fprintf(&sb, "Your O3 Capital credit card statement for account ****%s for the period ending %s is now available.\n\n", last4, d.stmtDate)
	fmt.Fprintf(&sb, "Please find attached your credit card e-statement. Open the attachment to view, save and print.\n\n")
	fmt.Fprintf(&sb, "ACCOUNT SUMMARY\n")
	fmt.Fprintf(&sb, "Account Number:      ****%s\n", last4)
	fmt.Fprintf(&sb, "New Balance:         NGN %s\n", ccFmtKobo(d.closingBal))
	if d.minPayment > 0 {
		fmt.Fprintf(&sb, "Minimum Payment Due: NGN %s\n", ccFmtKobo(d.minPayment))
	}
	if d.dueDate != "—" {
		fmt.Fprintf(&sb, "Payment Due Date:    %s\n", d.dueDate)
	}
	fmt.Fprintf(&sb, "\nPlease ensure payment is made on or before the due date to avoid charges.\n\n")
	fmt.Fprintf(&sb, "For enquiries, contact O3 Capital Cards:\n")
	fmt.Fprintf(&sb, "Email: care@o3cards.com\n\n")
	fmt.Fprintf(&sb, "Thank you for choosing O3 Capital.\n\n")
	fmt.Fprintf(&sb, "Regards,\nO3 Capital Cards Team")
	return sb.String()
}

func ccPDFFilename(d ccData) string {
	var monthYear string
	if t, err := time.Parse("02 Jan 2006", d.stmtDate); err == nil {
		monthYear = t.Format("Jan2006")
	} else {
		monthYear = time.Now().Format("Jan2006")
	}
	// Sanitize customer name: spaces → underscores, keep alphanumeric only
	name := strings.ReplaceAll(strings.TrimSpace(d.customerName), " ", "_")
	var safe strings.Builder
	for _, r := range name {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			safe.WriteRune(r)
		}
	}
	if n := safe.String(); n != "" {
		name = n
	} else {
		name = "Customer"
	}
	return fmt.Sprintf("O3Capital_CC_%s_%s.pdf", name, monthYear)
}

// ccBuildNotificationHTML wraps the plain-text body in a short branded HTML email.
func ccBuildNotificationHTML(d ccData, bodyText string) string {
	e := html.EscapeString
	// Convert plain text to HTML: escape then replace newlines with <br>
	htmlContent := strings.ReplaceAll(e(bodyText), "\n", "<br>\n")

	const logoB64 = `PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyMjAgMTIwIiB3aWR0aD0iNzIiIGhlaWdodD0iNDAiPjxjaXJjbGUgY3g9Ijc4IiBjeT0iNjAiIHI9IjUyIiBmaWxsPSIjQzAwMDAwIi8+PGNpcmNsZSBjeD0iMTQyIiBjeT0iNjAiIHI9IjUyIiBmaWxsPSIjMjgyODI4Ii8+PGNpcmNsZSBjeD0iMTEwIiBjeT0iNjAiIHI9IjU2IiBmaWxsPSIjRkZGRkZGIi8+PGNpcmNsZSBjeD0iMTEwIiBjeT0iNjAiIHI9IjUyIiBmaWxsPSIjOERBQUI3Ii8+PC9zdmc+`

	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F4F4;font-family:Arial,Helvetica,sans-serif">
<table width="100%%" cellpadding="0" cellspacing="0" style="background:#F4F4F4;padding:24px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%%">

  <tr><td style="background:#0E2841;padding:20px 32px;border-radius:4px 4px 0 0">
    <table width="100%%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <img src="data:image/svg+xml;base64,`+logoB64+`" alt="O3 Capital" width="72" height="40" style="display:block">
        <div style="color:#fff;font-size:15px;font-weight:700;margin-top:8px;font-family:Arial Black,Arial,sans-serif"><span style="color:#E02828">O3</span> Capital</div>
        <div style="color:rgba(255,255,255,.4);font-size:9px;letter-spacing:2px;margin-top:3px;text-transform:uppercase">Cards Division &middot; Licensed by CBN</div>
      </td>
      <td align="right" style="color:rgba(255,255,255,.5);font-size:9px;vertical-align:top">
        Ref: %s<br>Statement Date: %s
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="height:3px;background:#C00000"></td></tr>

  <tr><td style="background:#fff;padding:28px 32px">
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#333;line-height:1.8">
      %s
    </div>
  </td></tr>

  <tr><td style="background:#0E2841;padding:12px 32px;border-radius:0 0 4px 4px;text-align:center;font-size:9px;color:rgba(255,255,255,.4);letter-spacing:1px;text-transform:uppercase">
    O3 Capital Limited &ensp;&middot;&ensp; Cards Division &ensp;&middot;&ensp; CBN Licensed &ensp;&middot;&ensp; care@o3cards.com
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`, e(d.refNo), e(d.stmtDate), htmlContent)
}

// ── DB load ───────────────────────────────────────────────────────────────────

func ccLoad(ctx context.Context, db *core.DB, id string) (core.Row, []core.Row, error) {
	stmts, err := db.PGQuery(ctx, `
		SELECT s.*, u.full_name AS created_by_name
		FROM cc_statements s
		LEFT JOIN o3c_users u ON u.id = s.created_by
		WHERE s.id = $1`, id)
	if err != nil {
		return nil, nil, fmt.Errorf("db error: %w", err)
	}
	if len(stmts) == 0 {
		return nil, nil, errors.New("statement not found")
	}
	txns, err := db.PGQuery(ctx, `SELECT * FROM cc_transactions WHERE statement_id = $1 ORDER BY seq`, id)
	if err != nil {
		txns = []core.Row{}
	}
	return stmts[0], txns, nil
}

// ── Shared data extraction ────────────────────────────────────────────────────

type ccData struct {
	customerName  string
	customerAddr  string
	accountNo     string
	stmtDate      string
	dueDate       string
	openingBal    int64
	totalDebit    int64
	totalCredit   int64
	closingBal    int64
	minPayment    int64
	financeCharge int64
	lineOfCredit  int64
	stmtID        int64
	source        string
	sourceFile    string
	generatedAt   string
	refNo         string
	overLimit     bool
	availCredit   int64
	daysUntilDue  int
}

func ccExtract(stmt core.Row) ccData {
	d := ccData{
		customerName:  getRowString(stmt, "customer_name"),
		customerAddr:  getRowString(stmt, "customer_address"),
		accountNo:     getRowString(stmt, "account_number"),
		stmtDate:      ccDateField(stmt, "statement_date"),
		dueDate:       ccDateField(stmt, "payment_due_date"),
		openingBal:    toInt64(stmt["opening_balance_kobo"]),
		totalDebit:    toInt64(stmt["total_debit_kobo"]),
		totalCredit:   toInt64(stmt["total_credit_kobo"]),
		closingBal:    toInt64(stmt["closing_balance_kobo"]),
		minPayment:    toInt64(stmt["min_payment_kobo"]),
		financeCharge: toInt64(stmt["finance_charge_kobo"]),
		lineOfCredit:  toInt64(stmt["line_of_credit_kobo"]),
		stmtID:        toInt64(stmt["id"]),
		source:        getRowString(stmt, "source"),
		sourceFile:    getRowString(stmt, "source_filename"),
		generatedAt:   time.Now().Format("02 Jan 2006, 15:04"),
	}
	d.refNo = fmt.Sprintf("CC-%04d/%s", d.stmtID, time.Now().Format("200601"))
	d.overLimit = d.lineOfCredit > 0 && d.closingBal > d.lineOfCredit
	if d.lineOfCredit > d.closingBal {
		d.availCredit = d.lineOfCredit - d.closingBal
	}

	// Days until due — check time.Time directly first, then parse string
	if v, ok := stmt["payment_due_date"]; ok && v != nil {
		if t, ok := v.(time.Time); ok {
			d.daysUntilDue = int(time.Until(t).Hours() / 24)
		} else {
			rawDue := getRowString(stmt, "payment_due_date")
			for _, layout := range []string{
				"2006-01-02T15:04:05Z07:00", "2006-01-02T15:04:05Z",
				"2006-01-02 15:04:05 +0000 UTC", "2006-01-02",
			} {
				if t, err := time.Parse(layout, rawDue); err == nil {
					d.daysUntilDue = int(time.Until(t).Hours() / 24)
					break
				}
			}
		}
	}
	return d
}

// ── HTML statement document ───────────────────────────────────────────────────

// isCashAdvance returns true when the transaction description/trace indicate an ATM or cash advance.
func isCashAdvance(desc, traceNo string) bool {
	d := strings.ToLower(desc)
	t := strings.ToLower(traceNo)
	return strings.Contains(d, "atm") || strings.Contains(d, "cash advance") ||
		strings.Contains(d, "withdrawal") || strings.HasPrefix(t, "atm")
}

// ccInferCategory guesses a display category from description + trace number.
func ccInferCategory(desc, traceNo string, isFC bool) string {
	if isFC {
		return "Finance"
	}
	d := strings.ToLower(desc)
	t := strings.ToLower(traceNo)
	switch {
	case strings.Contains(d, "payment") || strings.HasPrefix(t, "pmt"):
		return "Payment"
	case isCashAdvance(d, t):
		return "Cash Advance"
	case strings.Contains(d, "fuel") || strings.Contains(d, "petrol") ||
		strings.Contains(d, "energi") || strings.Contains(d, "nnpc") || strings.Contains(d, "filling"):
		return "Fuel"
	case strings.Contains(d, "uber") || strings.Contains(d, "bolt") ||
		strings.Contains(d, "transport") || strings.Contains(d, "taxi"):
		return "Transport"
	case strings.Contains(d, "netflix") || strings.Contains(d, "spotify") ||
		strings.Contains(d, "dstv") || strings.Contains(d, "amazon web") ||
		strings.Contains(d, "subscription"):
		return "Subscriptions"
	case strings.Contains(d, "pizza") || strings.Contains(d, "chicken") ||
		strings.Contains(d, "smoothie") || strings.Contains(d, "domino") ||
		strings.Contains(d, "burger") || strings.Contains(d, "cafe") ||
		strings.Contains(d, "restaurant") || strings.Contains(d, "food"):
		return "Food & Dining"
	case strings.Contains(d, "jumia") || strings.Contains(d, "konga") ||
		strings.Contains(d, "amazon") || strings.Contains(d, "aliexpress") ||
		strings.Contains(d, "shopping"):
		return "E-Commerce"
	case strings.Contains(d, "transfer"):
		return "Transfer"
	case strings.Contains(d, "airtime") || strings.Contains(d, "data"):
		return "Airtime/Data"
	default:
		return "Retail"
	}
}

func ccBuildHTML(stmt core.Row, txns []core.Row) string {
	e := html.EscapeString
	d := ccExtract(stmt)

	// Statement period: "01 Jan 2006 – DD Mon YYYY"
	stmtPeriod := d.stmtDate
	if t, err := time.Parse("02 Jan 2006", d.stmtDate); err == nil {
		first := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, t.Location())
		stmtPeriod = first.Format("02 Jan 2006") + " – " + d.stmtDate
	}

	// Masked account for display (•••• •••• •••• XXXX)
	acctDisplay := d.accountNo
	if len(acctDisplay) > 4 {
		acctDisplay = "•••• •••• •••• " +
			d.accountNo[len(d.accountNo)-4:]
	}

	// Period totals: separate purchase debits from finance charges
	var totalPurchDr, totalCr, totalFCDr int64
	var drCount, crCount int
	for _, t := range txns {
		dr   := toInt64(t["debit_kobo"])
		cr   := toInt64(t["credit_kobo"])
		isFC := toBool(t["is_finance_charge"])
		totalCr += cr
		if isFC {
			totalFCDr += dr
		} else {
			totalPurchDr += dr
			if dr > 0 {
				drCount++
			}
		}
		if cr > 0 {
			crCount++
		}
	}
	totalDr  := totalPurchDr + totalFCDr
	txnCount := len(txns)

	// Transaction rows — 8 columns
	var txnRows strings.Builder
	runBal := d.openingBal
	for i, t := range txns {
		dr      := toInt64(t["debit_kobo"])
		cr      := toInt64(t["credit_kobo"])
		isFC    := toBool(t["is_finance_charge"])
		desc    := getRowString(t, "description")
		txnDate  := ccFmtDate(getRowString(t, "txn_date"))
		postDate := ccFmtDate(getRowString(t, "post_date"))
		if postDate == "—" {
			postDate = txnDate
		}
		runBal += dr - cr

		rowCls := ""
		if isFC {
			rowCls = ` class="fc"`
		} else if i%2 == 1 {
			rowCls = ` class="alt"`
		}

		descCls   := "dsc"
		descInner := e(desc)
		if isFC {
			descCls   = "dsc fc-desc"
			descInner = fmt.Sprintf(`%s<span class="badge-fc">Interest</span>`, e(desc))
		}

		drCell := `<td class="num dash">—</td>`
		if dr > 0 {
			cls := "num dr"
			if isFC {
				cls = "num dr fc-amt"
			}
			drCell = fmt.Sprintf(`<td class="%s">%s</td>`, cls, e(ccFmtKobo(dr)))
		}
		crCell := `<td class="num dash">—</td>`
		if cr > 0 {
			crCell = fmt.Sprintf(`<td class="num cr">%s</td>`, e(ccFmtKobo(cr)))
		}

		fmt.Fprintf(&txnRows,
			`<tr%s><td class="dt">%s</td><td class="dt">%s</td>`+
				`<td class="%s">%s</td>%s%s<td class="bal">%s</td></tr>`,
			rowCls, e(txnDate), e(postDate),
			descCls, descInner, drCell, crCell, e(ccFmtKobo(runBal)))
	}

	// Minimum payment amount (fall back to closing balance when unset)
	minPayAmt  := d.closingBal
	minPayNote := "Full balance due"
	if d.minPayment > 0 {
		minPayAmt  = d.minPayment
		minPayNote = "20%% of outstanding balance"
	}


	entryWord := "entries"
	if txnCount == 1 {
		entryWord = "entry"
	}

	var b strings.Builder

	b.WriteString(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>O3 Capital &#8212; Credit Card Statement</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#fff;color:#334155;font-size:12px;line-height:1.45}
.doc{max-width:900px;margin:0 auto}
.bank-bar{background:#0E2841;padding:18px 32px;display:flex;align-items:center;justify-content:space-between;gap:24px}
.bank-brand{display:flex;align-items:center;gap:8px;flex-shrink:0}
.bank-name{font-size:18px;font-weight:800;color:#fff;letter-spacing:-.03em;line-height:1}
.bank-name em{color:#fff;font-style:normal}
.bank-tag{font-size:8px;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.35);margin-top:6px}
.doc-decl{text-align:right}
.doc-decl-title{font-size:11px;font-weight:700;color:rgba(255,255,255,.55);letter-spacing:.22em;text-transform:uppercase}
.doc-decl-period{font-size:13px;font-weight:700;color:#fff;margin-top:5px;letter-spacing:-.01em}
.doc-decl-ref{font-family:'Courier New',Courier,monospace;font-size:9px;color:rgba(255,255,255,.28);margin-top:5px;letter-spacing:.04em}
.accent{height:4px;background:#C00000}
.cust-strip{display:flex;justify-content:space-between;align-items:flex-start;padding:24px 32px 22px;border-bottom:1px solid #E2E8F0;gap:40px}
.cust-name{font-size:22px;font-weight:800;color:#0E2841;letter-spacing:-.025em;line-height:1.1;margin-bottom:8px}
.cust-addr{font-size:11.5px;color:#64748B;line-height:1.75}
.cust-acct{display:inline-flex;align-items:center;gap:7px;margin-top:12px;background:#F8FAFC;border:1px solid #CBD5E1;border-radius:3px;padding:5px 10px}
.cust-acct-lbl{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:#94A3B8}
.cust-acct-num{font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:700;color:#0E2841;letter-spacing:.1em}
.cust-meta{flex-shrink:0;min-width:200px}
.meta-field{padding:9px 0 9px 20px;border-left:2px solid #E2E8F0;margin-bottom:2px}
.meta-field:first-child{padding-top:0}
.meta-field:last-child{padding-bottom:0;margin-bottom:0}
.meta-lbl{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:#94A3B8;margin-bottom:3px}
.meta-val{font-size:12.5px;font-weight:700;color:#0E2841;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.meta-val.mono{font-family:'Courier New',Courier,monospace}
.meta-val.due{color:#C00000}
.summary{display:grid;grid-template-columns:repeat(5,1fr);border-bottom:1px solid #E2E8F0}
.tile{padding:16px 16px 14px;border-right:1px solid #E2E8F0;border-top:3px solid transparent;text-align:center}
.tile:last-child{border-right:none}
.t-debit{border-top-color:#C00000}
.t-credit{border-top-color:#166534}
.t-charge{border-top-color:#D97706}
.t-prev{border-top-color:#64748B}
.t-close{border-top-color:#0E2841}
.tile-lbl{font-size:8.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#94A3B8;margin-bottom:8px;line-height:1.3}
.tile-val{font-size:15px;font-weight:800;font-variant-numeric:tabular-nums;font-family:'Courier New',Courier,monospace;color:#0E2841;line-height:1.1;letter-spacing:-.02em}
.tile-val.red{color:#C00000}
.tile-val.grn{color:#166534}
.tile-val.amb{color:#D97706}
.tile-sub{font-size:9px;color:#94A3B8;margin-top:5px}
.pay-cta{display:grid;grid-template-columns:auto 1fr;background:#0E2841;border-top:3px solid #C00000}
.pay-cta-main{padding:22px 32px;border-right:1px solid rgba(255,255,255,.08)}
.pay-eyebrow{font-size:8px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.38);margin-bottom:9px}
.pay-amount{font-family:'Courier New',Courier,monospace;font-variant-numeric:tabular-nums;font-size:40px;font-weight:700;color:#fff;line-height:1;letter-spacing:-.03em}
.pay-due{margin-top:9px;font-size:11.5px;color:rgba(255,255,255,.45);line-height:1.5}
.pay-due strong{color:#fca5a5;font-weight:700}
.pay-meta{padding:20px 28px;display:flex;flex-direction:column;justify-content:center;gap:12px}
.pay-meta-row{display:flex;align-items:center}
.pay-mi{padding:0 24px;border-right:1px solid rgba(255,255,255,.08)}
.pay-mi:first-child{padding-left:0}
.pay-mi:last-child{border-right:none}
.pay-mi-lbl{font-size:8px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.3);margin-bottom:6px}
.pay-mi-val{font-size:13px;color:rgba(255,255,255,.7);font-weight:600;letter-spacing:-.01em}
.pay-mi-val.mono{font-family:'Courier New',Courier,monospace;font-variant-numeric:tabular-nums}
.pay-limit-row{font-size:11px;color:rgba(255,255,255,.45);padding-top:10px;border-top:1px solid rgba(255,255,255,.08)}
.pay-limit-row.over{color:#fca5a5;font-size:11px;letter-spacing:.04em}
.sec-head{display:flex;align-items:center;justify-content:space-between;padding:11px 20px 10px;border-bottom:1px solid #E2E8F0;background:#F8FAFC}
.sec-lbl{font-size:8.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#334155}
.sec-ct{font-size:10px;color:#94A3B8}
.tbl-wrap{overflow-x:auto}
table{width:100%;min-width:660px;border-collapse:collapse;table-layout:fixed}
thead tr{background:#0E2841}
thead th{padding:10px 12px;font-size:8.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.55);text-align:left;white-space:nowrap}
thead th:nth-child(1){width:92px}
thead th:nth-child(2){width:92px}
thead th:nth-child(4){width:118px}
thead th:nth-child(5){width:118px}
thead th:nth-child(6){width:130px}
th.r{text-align:right}
th.bal-col{background:#162F4A;color:rgba(255,255,255,.72);border-left:1px solid rgba(255,255,255,.1)}
tbody tr{border-bottom:1px solid #E2E8F0}
tbody tr.alt{background:#F8FAFC}
tbody tr.fc{background:#FFFBEB;border-left:3px solid #D97706}
tbody tr.fc td:first-child{padding-left:9px}
td{padding:9px 12px;vertical-align:middle;color:#334155;font-size:12px}
td.dt{font-family:'Courier New',Courier,monospace;font-size:11px;white-space:nowrap;overflow:hidden;color:#64748B}
td.dsc{font-weight:500;color:#0E2841;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
td.fc-desc{color:#92400E;font-weight:600}
.badge-fc{display:inline-block;font-size:8.5px;font-weight:700;background:#D97706;color:#fff;border-radius:2px;padding:1px 5px;margin-left:5px;letter-spacing:.04em;vertical-align:middle;text-transform:uppercase}
td.num{text-align:right;font-family:'Courier New',Courier,monospace;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;font-size:12px}
td.dr{color:#C00000;font-weight:600}
td.fc-amt{color:#D97706}
td.cr{color:#166534;font-weight:600}
td.dash{color:#CBD5E1;text-align:right;font-family:'Courier New',monospace}
td.bal{font-family:'Courier New',Courier,monospace;font-variant-numeric:tabular-nums;font-weight:700;font-size:12px;text-align:right;color:#0E2841;border-left:1px solid #CBD5E1;background:#F0F4F8;white-space:nowrap;overflow:hidden;padding-right:18px}
.tfoot-once tr{background:#0E2841}
.tfoot-once td{padding:12px;border-bottom:none;font-size:11px;color:rgba(255,255,255,.45)}
.tfoot-once td.lbl{font-size:8.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.3)}
.tfoot-once td.dr-tot{font-family:'Courier New',Courier,monospace;font-variant-numeric:tabular-nums;font-size:13px;font-weight:700;text-align:right;color:#fca5a5}
.tfoot-once td.cr-tot{font-family:'Courier New',Courier,monospace;font-variant-numeric:tabular-nums;font-size:13px;font-weight:700;text-align:right;color:#86efac}
.tfoot-once td.bal-tot{font-family:'Courier New',Courier,monospace;font-variant-numeric:tabular-nums;font-size:14px;font-weight:700;text-align:right;color:#fff;border-left:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);padding-right:18px}
.pay-panel{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid #E2E8F0}
.pay-block{padding:16px 20px;border-right:1px solid #E2E8F0}
.pay-block:last-child{border-right:none}
.pay-blk-lbl{font-size:8.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#64748B;margin-bottom:7px}
.pay-blk-body{font-size:11px;color:#64748B;line-height:1.65}
.repay-sec{padding:16px 32px 20px;border-top:1px solid #E2E8F0}
.repay-hdg{font-size:8.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#334155;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #E2E8F0}
.repay-methods{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.repay-methods>div{min-width:0}
.repay-name{font-size:11px;font-weight:700;color:#0E2841;margin-bottom:5px}
.repay-body{font-size:10.5px;color:#64748B;line-height:1.75}
.repay-tbl{border-collapse:collapse;min-width:0!important}
.repay-tbl tr{border-bottom:none}
.repay-tbl td{padding:2px 16px 2px 0;font-size:10px;color:#334155;vertical-align:top}
.repay-tbl td:first-child{font-weight:700;color:#0E2841;white-space:nowrap}
.ft{background:#0E2841;padding:20px 32px}
.ft-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:28px;margin-bottom:16px}
.ft-col-h{font-size:8px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.3);margin-bottom:7px}
.ft-col-b{font-size:11px;color:rgba(255,255,255,.55);line-height:1.7}
.ft-div{border:none;border-top:1px solid rgba(255,255,255,.08);margin-bottom:12px}
.ft-btm{display:flex;justify-content:space-between;align-items:center;font-size:9.5px;color:rgba(255,255,255,.25);letter-spacing:.02em}
.ft-stamp{font-family:'Courier New',Courier,monospace;font-size:9px;letter-spacing:.04em}
@media print{@page{size:A4;margin:0}body{-webkit-print-color-adjust:exact;print-color-adjust:exact;padding:8mm 10mm}.pay-cta,.ft{page-break-inside:avoid}}
</style>
</head>
<body>
<div class="doc">
`)

	// ── Bank identity bar ─────────────────────────────────────────────────────
	b.WriteString(`<div class="bank-bar"><div class="bank-brand">`)
	b.WriteString(logoSVG)
	b.WriteString(`<div><div class="bank-name">O3 <em>Capital</em></div>`)
	b.WriteString(`<div class="bank-tag">Cards Division &middot; Licensed by CBN</div></div>`)
	b.WriteString(`</div><div class="doc-decl">`)
	b.WriteString(`<div class="doc-decl-title">Credit Card Statement</div>`)
	fmt.Fprintf(&b, `<div class="doc-decl-period">%s</div>`, e(stmtPeriod))
	fmt.Fprintf(&b, `<div class="doc-decl-ref">Ref: %s &ensp;&middot;&ensp; Generated: %s</div>`, e(d.refNo), e(d.generatedAt))
	b.WriteString(`</div></div>`)
	b.WriteString(`<div class="accent"></div>`)

	// ── Customer strip ────────────────────────────────────────────────────────
	b.WriteString(`<div class="cust-strip"><div>`)
	fmt.Fprintf(&b, `<div class="cust-name">%s</div>`, e(d.customerName))
	if d.customerAddr != "" {
		b.WriteString(`<div class="cust-addr">`)
		first := true
		for _, line := range strings.Split(d.customerAddr, "\n") {
			if l := strings.TrimSpace(line); l != "" {
				if !first {
					b.WriteString(`<br>`)
				}
				b.WriteString(e(l))
				first = false
			}
		}
		b.WriteString(`</div>`)
	}
	b.WriteString(`<div class="cust-acct">`)
	b.WriteString(`<span class="cust-acct-lbl">Card Account</span>`)
	fmt.Fprintf(&b, `<span class="cust-acct-num">%s</span>`, e(acctDisplay))
	b.WriteString(`</div></div>`)

	// Meta fields (right side)
	b.WriteString(`<div class="cust-meta">`)
	fmt.Fprintf(&b,
		`<div class="meta-field"><div class="meta-lbl">Statement Date</div><div class="meta-val">%s</div></div>`,
		e(d.stmtDate))
	if d.dueDate != "—" {
		fmt.Fprintf(&b,
			`<div class="meta-field"><div class="meta-lbl">Payment Due Date</div><div class="meta-val due">%s</div></div>`,
			e(d.dueDate))
	}
	fmt.Fprintf(&b,
		`<div class="meta-field"><div class="meta-lbl">Credit Limit</div><div class="meta-val mono">&#8358;%s</div></div>`,
		e(ccFmtKobo(d.lineOfCredit)))
	b.WriteString(`<div class="meta-field"><div class="meta-lbl">Card Type</div><div class="meta-val">O3 Credit Card</div></div>`)
	b.WriteString(`</div></div>`) // end .cust-meta, .cust-strip

	// ── Summary tiles ─────────────────────────────────────────────────────────
	b.WriteString(`<div class="summary">`)
	fmt.Fprintf(&b,
		`<div class="tile t-prev"><div class="tile-lbl">Previous Balance</div><div class="tile-val">&#8358;%s</div><div class="tile-sub">As at period start</div></div>`,
		e(ccFmtKobo(d.openingBal)))
	fmt.Fprintf(&b,
		`<div class="tile t-debit"><div class="tile-lbl">Total Debits</div><div class="tile-val red">&#8358;%s</div><div class="tile-sub">%d transaction%s</div></div>`,
		e(ccFmtKobo(totalPurchDr)), drCount, pluralS(drCount))
	fmt.Fprintf(&b,
		`<div class="tile t-credit"><div class="tile-lbl">Total Credits</div><div class="tile-val grn">&#8358;%s</div><div class="tile-sub">%d payment%s</div></div>`,
		e(ccFmtKobo(totalCr)), crCount, pluralS(crCount))
	fmt.Fprintf(&b,
		`<div class="tile t-charge"><div class="tile-lbl">Finance Charge</div><div class="tile-val amb">&#8358;%s</div><div class="tile-sub">5%% cycle interest</div></div>`,
		e(ccFmtKobo(d.financeCharge)))
	fmt.Fprintf(&b,
		`<div class="tile t-close"><div class="tile-lbl">Closing Balance</div><div class="tile-val">&#8358;%s</div><div class="tile-sub">As at %s</div></div>`,
		e(ccFmtKobo(d.closingBal)), e(d.stmtDate))
	b.WriteString(`</div>`) // end .summary

	// ── Payment CTA ───────────────────────────────────────────────────────────
	b.WriteString(`<div class="pay-cta"><div class="pay-cta-main">`)
	b.WriteString(`<div class="pay-eyebrow">Minimum Payment Due</div>`)
	fmt.Fprintf(&b, `<div class="pay-amount">&#8358;%s</div>`, e(ccFmtKobo(minPayAmt)))
	fmt.Fprintf(&b, `<div class="pay-due">Due by <strong>%s</strong> &mdash; %s</div>`, e(d.dueDate), minPayNote)
	b.WriteString(`</div><div class="pay-meta">`)
	b.WriteString(`<div class="pay-meta-row">`)
	fmt.Fprintf(&b,
		`<div class="pay-mi"><div class="pay-mi-lbl">Outstanding Balance</div><div class="pay-mi-val mono">&#8358;%s</div></div>`,
		e(ccFmtKobo(d.closingBal)))
	fmt.Fprintf(&b,
		`<div class="pay-mi"><div class="pay-mi-lbl">Finance Charge</div><div class="pay-mi-val mono">&#8358;%s</div></div>`,
		e(ccFmtKobo(d.financeCharge)))
	b.WriteString(`</div>`) // end .pay-meta-row
	if d.overLimit {
		over := d.closingBal - d.lineOfCredit
		fmt.Fprintf(&b,
			`<div class="pay-limit-row over">OVER CREDIT LIMIT &ndash; Balance exceeds limit by &#8358;%s</div>`,
			e(ccFmtKobo(over)))
	} else {
		fmt.Fprintf(&b,
			`<div class="pay-limit-row">Credit Limit: &#8358;%s &mdash; &#8358;%s available</div>`,
			e(ccFmtKobo(d.lineOfCredit)), e(ccFmtKobo(d.availCredit)))
	}
	b.WriteString(`</div></div>`) // end .pay-meta, .pay-cta

	// ── Transaction table ─────────────────────────────────────────────────────
	b.WriteString(`<div class="sec-head">`)
	b.WriteString(`<span class="sec-lbl">Transaction Detail</span>`)
	fmt.Fprintf(&b, `<span class="sec-ct">%d %s &middot; %s</span>`, txnCount, entryWord, e(stmtPeriod))
	b.WriteString(`</div>`)
	b.WriteString(`<div class="tbl-wrap"><table><thead><tr>`)
	b.WriteString(`<th>Txn Date</th><th>Post Date</th><th>Description</th>`)
	b.WriteString(`<th class="r">Debit (&#8358;)</th><th class="r">Credit (&#8358;)</th><th class="r bal-col">Balance (&#8358;)</th>`)
	b.WriteString(`</tr></thead><tbody>`)
	b.WriteString(txnRows.String())
	b.WriteString(`</tbody><tbody class="tfoot-once"><tr>`)
	b.WriteString(`<td colspan="3" class="lbl">Period Totals</td>`)
	fmt.Fprintf(&b, `<td class="dr-tot">%s</td>`, e(ccFmtKobo(totalDr)))
	fmt.Fprintf(&b, `<td class="cr-tot">%s</td>`, e(ccFmtKobo(totalCr)))
	fmt.Fprintf(&b, `<td class="bal-tot">%s</td>`, e(ccFmtKobo(d.closingBal)))
	b.WriteString(`</tr></tbody></table></div>`) // end .tbl-wrap

	// ── Payment notice ────────────────────────────────────────────────────────
	b.WriteString(`<div class="pay-panel">`)
	b.WriteString(`<div class="pay-block"><div class="pay-blk-lbl">How to Pay</div>`)
	b.WriteString(`<div class="pay-blk-body">Transfer to your O3 Capital card account or pay via the O3 Capital mobile app. Allow up to 2 business days for payment to reflect on your account.</div>`)
	b.WriteString(`</div>`)
	b.WriteString(`<div class="pay-block"><div class="pay-blk-lbl">Late Payment Notice</div>`)
	b.WriteString(`<div class="pay-blk-body">Failure to pay the minimum amount by the due date will result in additional interest charges and may affect your credit standing with O3 Capital.</div>`)
	b.WriteString(`</div></div>`) // end .pay-panel

	// ── Repayment methods ─────────────────────────────────────────────────────
	b.WriteString(`<div class="repay-sec"><div class="repay-hdg">Off-Cycle Repayment Methods</div>`)
	b.WriteString(`<div class="repay-methods">`)
	b.WriteString(`<div><div class="repay-name">1. Bank Transfer</div><div class="repay-body">`)
	b.WriteString(`Transfer directly to your O3 Capital card account:<br>`)
	b.WriteString(`<table class="repay-tbl">`)
	b.WriteString(`<tr><td>Bank:</td><td>O3 Capital MFB</td></tr>`)
	fmt.Fprintf(&b, `<tr><td>Account:</td><td>%s</td></tr>`, e(d.accountNo))
	fmt.Fprintf(&b, `<tr><td>Name:</td><td>%s</td></tr>`, e(d.customerName))
	b.WriteString(`</table></div></div>`)
	b.WriteString(`<div><div class="repay-name">2. Mobile App</div><div class="repay-body">`)
	b.WriteString(`Log in to the O3 Capital mobile app &rarr; <strong>Cards</strong> &rarr; <strong>Fund My Card</strong> &rarr; enter amount and confirm. Funds reflect immediately.</div></div>`)
	b.WriteString(`<div><div class="repay-name">3. QuickTeller</div><div class="repay-body">`)
	b.WriteString(`Visit any Interswitch QuickTeller-enabled ATM or go to <em>quickteller.com</em> &rarr; Pay Bills &rarr; O3 Capital Cards &rarr; enter your account number and amount.</div></div>`)
	b.WriteString(`</div></div>`)

	// ── Footer ────────────────────────────────────────────────────────────────
	b.WriteString(`<div class="ft"><div class="ft-grid">`)
	b.WriteString(`<div><div class="ft-col-h">Contact &amp; Support</div>`)
	b.WriteString(`<div class="ft-col-b">care@o3cards.com<br>+234 201 330 1070<br>O3 Capital mobile app</div></div>`)
	b.WriteString(`<div><div class="ft-col-h">Dispute a Transaction</div>`)
	b.WriteString(`<div class="ft-col-b">Disputes must be raised within 60 days of the statement date. Contact our cards team via the app or email with your trace reference number.</div></div>`)
	b.WriteString(`<div><div class="ft-col-h">O3 Capital Cards</div>`)
	b.WriteString(`<div class="ft-col-b">7th Floor, Churchgate Tower 1<br>Plot 30, Churchgate Street<br>Victoria Island, Lagos 101001<br>Nigeria</div></div>`)
	b.WriteString(`</div><hr class="ft-div">`)
	b.WriteString(`<div class="ft-btm">`)
	b.WriteString(`<span>Computer generated statement &mdash; no signature or stamp required</span>`)
	fmt.Fprintf(&b,
		`<span class="ft-stamp">Generated %s &nbsp;|&nbsp; Ref: %s &nbsp;|&nbsp; Stmt: %s</span>`,
		e(d.generatedAt), e(d.refNo), e(d.stmtDate))
	b.WriteString(`</div></div>`) // end .ft-btm, .ft

	b.WriteString(`</div></body></html>`) // end .doc
	return b.String()
}

// ccPaymentPanel renders a standalone payment panel (available for reuse).
func ccPaymentPanel(d ccData, e func(string) string) string {
	if d.closingBal == 0 && d.minPayment == 0 {
		return ""
	}

	minPayStr := "Full balance"
	if d.minPayment > 0 {
		minPayStr = "&#8358;" + ccFmtKobo(d.minPayment)
	}

	dueBg    := "#FFF8F8"
	dueColor := "#C00000"
	urgency  := ""
	if d.daysUntilDue > 0 && d.daysUntilDue <= 7 {
		urgency = fmt.Sprintf(`<div style="margin-top:6px;font-size:10px;color:#C00000;font-weight:600">&#9888;&ensp;Due in %d day%s</div>`, d.daysUntilDue, pluralS(d.daysUntilDue))
	} else if d.daysUntilDue < 0 {
		urgency  = `<div style="margin-top:6px;font-size:10px;color:#C00000;font-weight:600">&#9888;&ensp;OVERDUE — please pay immediately</div>`
		dueBg    = "#FEF2F2"
	} else if d.dueDate != "—" {
		urgency   = fmt.Sprintf(`<div style="margin-top:6px;font-size:10px;color:#888">%d days remaining</div>`, d.daysUntilDue)
		dueBg     = "#F0FFF4"
		dueColor  = "#15803D"
	}

	return fmt.Sprintf(`
  <div style="border:1.5px solid #CBD5E1;border-radius:4px;overflow:hidden;margin-bottom:14px">
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr">
      <div style="padding:16px 20px;border-right:1px solid #CBD5E1">
        <div style="font-size:8.5px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#64748B;margin-bottom:6px">New Balance</div>
        <div style="font-size:20px;font-weight:700;color:#0E2841;font-family:&quot;Courier New&quot;,monospace">&#8358;%s</div>
        <div style="margin-top:4px;font-size:9px;color:#888">As of %s</div>
      </div>
      <div style="padding:16px 20px;border-right:1px solid #CBD5E1;background:#FFFAF8">
        <div style="font-size:8.5px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#64748B;margin-bottom:6px">Minimum Payment Due</div>
        <div style="font-size:20px;font-weight:700;color:#C00000;font-family:&quot;Courier New&quot;,monospace">%s</div>
      </div>
      <div style="padding:16px 20px;background:%s">
        <div style="font-size:8.5px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#64748B;margin-bottom:6px">Payment Due Date</div>
        <div style="font-size:20px;font-weight:700;color:%s;font-family:&quot;Courier New&quot;,monospace">%s</div>
        %s
      </div>
    </div>
  </div>`,
		e(ccFmtKobo(d.closingBal)), e(d.stmtDate),
		e(minPayStr),
		dueBg, dueColor, e(d.dueDate), urgency,
	)
}

func ccPaymentFooterText(d ccData, e func(string) string) string {
	minStr := "the full outstanding balance"
	if d.minPayment > 0 {
		minStr = "a minimum of &#8358;" + ccFmtKobo(d.minPayment)
	}
	dueStr := d.dueDate
	if dueStr == "—" {
		dueStr = "as soon as possible"
	}
	return fmt.Sprintf(
		`Please pay %s by <strong>%s</strong> to keep your account in good standing.
        To avoid finance charges entirely, pay the full balance of <strong>&#8358;%s</strong> by the due date.
        Kindly use your account number <strong>%s</strong> as your payment reference when making transfers.`,
		e(minStr), e(dueStr), e(ccFmtKobo(d.closingBal)), e(d.accountNo))
}

// ── Formatting helpers ────────────────────────────────────────────────────────

// ccFmtKobo converts exact integer kobo to "X,XXX.XX" naira — no rounding, integer arithmetic only.
func ccFmtKobo(kobo int64) string {
	if kobo == 0 {
		return "0.00"
	}
	neg := kobo < 0
	if neg {
		kobo = -kobo
	}
	naira := kobo / 100
	frac  := kobo % 100
	result := fmt.Sprintf("%s.%02d", ccCommas(naira), frac)
	if neg {
		return "(" + result + ")"
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
		"2006-01-02 15:04:05 +0000 UTC",
		"2006-01-02 15:04:05 -0700 MST",
		"2006-01-02 15:04:05 +0000 +0000",
		"2006-01-02",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Format("02 Jan 2006")
		}
	}
	// Raw "YYYY-MM-DD" prefix fallback
	if len(s) >= 10 && s[4] == '-' && s[7] == '-' {
		if t, err := time.Parse("2006-01-02", s[:10]); err == nil {
			return t.Format("02 Jan 2006")
		}
	}
	return s
}

// ccDateField handles both time.Time values (from pgx) and string-formatted dates.
func ccDateField(stmt core.Row, key string) string {
	if v, ok := stmt[key]; ok && v != nil {
		if t, ok := v.(time.Time); ok {
			return t.Format("02 Jan 2006")
		}
	}
	return ccFmtDate(getRowString(stmt, key))
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
