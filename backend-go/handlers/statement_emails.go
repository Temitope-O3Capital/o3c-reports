package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/reports/core"
)

type customerStatementData struct {
	CIF          string
	DateFrom     string
	DateTo       string
	Account      core.Row
	Products     []core.Row
	Transactions []core.Row
	Source       string
}

func ensureStatementEmailSchema(ctx context.Context, db *core.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS customer_statement_emails (
		  id BIGSERIAL PRIMARY KEY,
		  cif_number TEXT NOT NULL,
		  customer_name TEXT,
		  recipient_email TEXT NOT NULL,
		  date_from DATE NOT NULL,
		  date_to DATE NOT NULL,
		  subject TEXT NOT NULL,
		  pdf_filename TEXT NOT NULL,
		  mail_message_id BIGINT REFERENCES mail_messages(id) ON DELETE SET NULL,
		  provider_message_id TEXT,
		  status TEXT NOT NULL DEFAULT 'pending',
		  last_error TEXT,
		  sent_by BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
		  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_customer_statement_emails_cif ON customer_statement_emails(cif_number, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_customer_statement_emails_mail ON customer_statement_emails(mail_message_id) WHERE mail_message_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_customer_statement_emails_status ON customer_statement_emails(status, created_at DESC)`,
	}
	for _, stmt := range stmts {
		if _, err := db.PGExec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func listStatementEmails(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureStatementEmailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Statement email storage setup failed")
			return
		}
		limit := qint(r, "limit", 100, 1, 500)
		cif := qstr(r, "cif")
		where := "WHERE 1=1"
		args := []any{}
		if cif != "" {
			args = append(args, cif)
			where += fmt.Sprintf(" AND s.cif_number=$%d", len(args))
		}
		args = append(args, limit)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT s.id, s.cif_number, s.customer_name, s.recipient_email,
			       s.date_from, s.date_to, s.subject, s.pdf_filename,
			       COALESCE(m.status, s.status) AS status,
			       COALESCE(m.provider_message_id, s.provider_message_id) AS provider_message_id,
			       m.delivered_at, m.opened_at, m.clicked_at, m.bounced_at,
			       COALESCE(m.last_error, s.last_error) AS last_error,
			       s.mail_message_id, s.created_at, s.updated_at,
			       u.full_name AS sent_by_name
			FROM customer_statement_emails s
			LEFT JOIN mail_messages m ON m.id=s.mail_message_id
			LEFT JOIN o3c_users u ON u.id=s.sent_by
			%s
			ORDER BY s.created_at DESC
			LIMIT $%d`, where, len(args)), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func sendCustomerStatementEmail(db *core.DB) http.HandlerFunc {
	type body struct {
		CIF            string `json:"cif"`
		DateFrom       string `json:"date_from"`
		DateTo         string `json:"date_to"`
		RecipientEmail string `json:"recipient_email"`
		Subject        string `json:"subject"`
		Message        string `json:"message"`
		PasswordHint   string `json:"password_hint"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if err := ensureStatementEmailSchema(r.Context(), db); err != nil {
			respondErr(w, 500, "Statement email storage setup failed")
			return
		}
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.CIF = strings.TrimSpace(b.CIF)
		b.RecipientEmail = strings.TrimSpace(strings.ToLower(b.RecipientEmail))
		if b.CIF == "" || b.RecipientEmail == "" {
			respondErr(w, 422, "cif and recipient_email are required")
			return
		}
		if !strings.Contains(b.RecipientEmail, "@") {
			respondErr(w, 422, "recipient_email must be a valid email address")
			return
		}
		dateFrom, dateTo, err := normalizeStatementDates(b.DateFrom, b.DateTo)
		if err != nil {
			respondErr(w, 422, err.Error())
			return
		}
		data, err := loadCustomerStatement(r.Context(), db, b.CIF, dateFrom, dateTo)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		if data.Account == nil || len(data.Account) == 0 {
			respondErr(w, 404, "Customer not found")
			return
		}
		name := statementCustomerName(data.Account)
		if b.Subject == "" {
			b.Subject = fmt.Sprintf("Your O3 Cards statement: %s to %s", dateFrom, dateTo)
		}
		filename := sanitizeAttachmentName(fmt.Sprintf("statement_%s_%s_%s.pdf", b.CIF, dateFrom, dateTo))
		pdf := buildStatementPDF(data)
		message := strings.TrimSpace(b.Message)
		if message == "" {
			message = "Please find your account statement attached to this email."
		}
		if hint := strings.TrimSpace(b.PasswordHint); hint != "" {
			message += "\n\nPassword hint: " + hint
		}
		html := statementEmailHTML(name, message, dateFrom, dateTo)

		user := core.UserFromCtx(r.Context())
		createdBy := int64(0)
		if user != nil {
			createdBy = user.ID
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO customer_statement_emails
			  (cif_number, customer_name, recipient_email, date_from, date_to, subject, pdf_filename, sent_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			RETURNING id`, b.CIF, name, b.RecipientEmail, dateFrom, dateTo, b.Subject, filename, nullableID(createdBy))
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Could not create statement send record")
			return
		}
		statementID := toInt64(rows[0]["id"])
		res := SendMail(r.Context(), db, SendMailOptions{
			To:          []MailAddress{{Email: b.RecipientEmail, Name: name}},
			Subject:     b.Subject,
			HTMLBody:    html,
			TextBody:    message,
			Category:    "statement",
			Kind:        "statement",
			RelatedType: "customer_statement",
			RelatedID:   statementID,
			CreatedBy:   createdBy,
			Attachments: []MailAttachment{{
				Filename:    filename,
				ContentType: "application/pdf",
				Content:     base64.StdEncoding.EncodeToString(pdf),
			}},
			CustomArgs:         map[string]string{"o3c_statement_id": fmt.Sprintf("%d", statementID), "o3c_cif": b.CIF},
			TrackOpensAndLinks: true,
		})
		status := "queued"
		if !res.OK {
			status = "failed"
		}
		_, _ = db.PGExec(r.Context(), `
			UPDATE customer_statement_emails
			SET status=$1, mail_message_id=$2, provider_message_id=NULLIF($3,''), last_error=NULLIF($4,''), updated_at=NOW()
			WHERE id=$5`, status, nullableID(res.MailID), res.ProviderID, res.Error, statementID)
		if !res.OK {
			respondErr(w, 502, res.Error)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"id": statementID, "mail_id": res.MailID, "provider_message_id": res.ProviderID,
			"status": status, "filename": filename,
		}) //nolint:errcheck
	}
}

func normalizeStatementDates(from, to string) (string, string, error) {
	from = strings.TrimSpace(from)
	to = strings.TrimSpace(to)
	if to == "" {
		to = time.Now().UTC().Format("2006-01-02")
	}
	if from == "" {
		t, _ := time.Parse("2006-01-02", to)
		from = t.AddDate(0, 0, -90).Format("2006-01-02")
	}
	if !dateRE.MatchString(from) || !dateRE.MatchString(to) {
		return "", "", fmt.Errorf("date_from and date_to must be YYYY-MM-DD")
	}
	f, _ := time.Parse("2006-01-02", from)
	t, _ := time.Parse("2006-01-02", to)
	if f.After(t) {
		return "", "", fmt.Errorf("date_from cannot be after date_to")
	}
	return from, to, nil
}

func loadCustomerStatement(ctx context.Context, db *core.DB, cif, dateFrom, dateTo string) (customerStatementData, error) {
	acctRows, acctSrc, err := db.DualQuery(ctx,
		`SELECT TOP 1 CIF_Number, First_Name, Last_Name, Email, Phone, Job_Title, State, City
		 FROM dbo.Contact WHERE CIF_Number=@p1`,
		`SELECT "CIF Number", "First Name", "Last Name", "Email", "Phone",
		        "Job Title", "State", "City"
		 FROM "Accounts" WHERE "CIF Number"=$1`,
		cif)
	if err != nil {
		return customerStatementData{}, fmt.Errorf("account lookup failed")
	}
	acct := core.Row{}
	if len(acctRows) > 0 {
		acct = acctRows[0]
	}
	prodRows, _, _ := db.DualQuery(ctx,
		`SELECT Product_Name, Account_Status, Name_On_Card, Account_Manager
		 FROM dbo.Account WHERE CIF_Number=@p1`,
		`SELECT "Product Name", "Account Status", "Name On Card", "Account Manager"
		 FROM "Products" WHERE "CIF Number"=$1`,
		cif)
	txnRows, txnSrc, _ := db.DualQuery(ctx,
		`SELECT TOP 500 Transaction_Date, Amount, Description, Merchant_Name
		 FROM dbo.Transaction_Listing
		 WHERE CIF_Number=@p1 AND CAST(Transaction_Date AS DATE) BETWEEN @p2 AND @p3
		 ORDER BY Transaction_Date DESC`,
		`SELECT "Transaction Date", "Amount", "Description", "Merchant_Name"
		 FROM "Transactions"
		 WHERE "CIF Number"=$1 AND "Transaction Date"::date BETWEEN $2 AND $3
		 ORDER BY "Transaction Date" DESC LIMIT 500`,
		cif, dateFrom, dateTo)
	if prodRows == nil {
		prodRows = []core.Row{}
	}
	if txnRows == nil {
		txnRows = []core.Row{}
	}
	return customerStatementData{CIF: cif, DateFrom: dateFrom, DateTo: dateTo, Account: acct, Products: prodRows, Transactions: txnRows, Source: pickSource([]string{acctSrc, txnSrc})}, nil
}

func statementCustomerName(acct core.Row) string {
	name := strings.TrimSpace(getRowString(acct, "First_Name", "First Name") + " " + getRowString(acct, "Last_Name", "Last Name"))
	if name == "" {
		name = strings.TrimSpace(getRowString(acct, "Name_On_Card", "Name On Card"))
	}
	if name == "" {
		name = "Customer"
	}
	return name
}

func getRowString(row core.Row, keys ...string) string {
	for _, key := range keys {
		if v, ok := row[key]; ok && v != nil {
			return strings.TrimSpace(fmt.Sprint(v))
		}
	}
	return ""
}

func statementEmailHTML(name, message, dateFrom, dateTo string) string {
	body := strings.ReplaceAll(escapeHTML(message), "\n", "<br>")
	return fmt.Sprintf(`<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5">
<p>Dear %s,</p>
<p>%s</p>
<p><strong>Statement period:</strong> %s to %s</p>
<p>Regards,<br>O3 Cards</p>
</div>`, escapeHTML(name), body, escapeHTML(dateFrom), escapeHTML(dateTo))
}

func escapeHTML(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	return s
}

func buildStatementPDF(data customerStatementData) []byte {
	lines := []string{
		"O3 Cards Account Statement",
		"Statement Period: " + data.DateFrom + " to " + data.DateTo,
		"Generated: " + time.Now().Format("2006-01-02 15:04"),
		"",
		"Customer",
		"Name: " + statementCustomerName(data.Account),
		"CIF: " + data.CIF,
		"Email: " + getRowString(data.Account, "Email"),
		"Phone: " + coalesce(getRowString(data.Account, "Phone", "Phone Number"), "-"),
		"Location: " + strings.Trim(strings.Join([]string{getRowString(data.Account, "City"), getRowString(data.Account, "State")}, ", "), ", "),
		"",
		"Products",
	}
	if len(data.Products) == 0 {
		lines = append(lines, "No products found.")
	} else {
		for _, p := range data.Products {
			lines = append(lines, fmt.Sprintf("- %s | %s | %s",
				coalesce(getRowString(p, "Product_Name", "Product Name"), "Product"),
				coalesce(getRowString(p, "Account_Status", "Account Status"), "-"),
				coalesce(getRowString(p, "Name_On_Card", "Name On Card"), "-")))
		}
	}
	lines = append(lines, "", "Transactions")
	if len(data.Transactions) == 0 {
		lines = append(lines, "No transactions found for this period.")
	} else {
		lines = append(lines, "Date | Description | Merchant | Amount")
		for _, t := range data.Transactions {
			lines = append(lines, fmt.Sprintf("%s | %s | %s | %s",
				shortDate(getRowString(t, "Transaction_Date", "Transaction Date")),
				coalesce(getRowString(t, "Description"), "-"),
				coalesce(getRowString(t, "Merchant_Name"), "-"),
				formatStatementAmount(t["Amount"])))
		}
	}
	lines = append(lines, "", "This statement is confidential and intended only for the named customer.")
	return simplePDF(lines)
}

func shortDate(s string) string {
	if len(s) >= 10 {
		return s[:10]
	}
	return s
}

func formatStatementAmount(v any) string {
	return "NGN " + strconv.FormatFloat(toFloat(v), 'f', 2, 64)
}

func simplePDF(lines []string) []byte {
	const maxLines = 42
	pages := [][]string{}
	for len(lines) > 0 {
		n := maxLines
		if len(lines) < n {
			n = len(lines)
		}
		pages = append(pages, lines[:n])
		lines = lines[n:]
	}
	if len(pages) == 0 {
		pages = [][]string{{"O3 Cards Account Statement"}}
	}
	objects := []string{}
	objects = append(objects, "<< /Type /Catalog /Pages 2 0 R >>")
	kids := []string{}
	for i := range pages {
		kids = append(kids, fmt.Sprintf("%d 0 R", 3+i*2))
	}
	objects = append(objects, fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), len(pages)))
	for i, pageLines := range pages {
		pageObj := 3 + i*2
		contentObj := pageObj + 1
		objects = append(objects, fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>", 3+len(pages)*2, contentObj))
		content := pdfContent(pageLines, i+1, len(pages))
		objects = append(objects, fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content))
	}
	objects = append(objects, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

	var buf bytes.Buffer
	buf.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects)+1)
	for i, obj := range objects {
		offsets[i+1] = buf.Len()
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", i+1, obj)
	}
	xref := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for i := 1; i <= len(objects); i++ {
		fmt.Fprintf(&buf, "%010d 00000 n \n", offsets[i])
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xref)
	return buf.Bytes()
}

func pdfContent(lines []string, page, total int) string {
	var b strings.Builder
	b.WriteString("BT\n/F1 11 Tf\n50 750 Td\n14 TL\n")
	for _, line := range lines {
		line = pdfSafe(line)
		if len(line) > 96 {
			line = line[:96]
		}
		fmt.Fprintf(&b, "(%s) Tj\nT*\n", pdfEscape(line))
	}
	fmt.Fprintf(&b, "ET\nBT\n/F1 9 Tf\n50 35 Td\n(Page %d of %d) Tj\nET", page, total)
	return b.String()
}

func pdfEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, "(", `\(`)
	s = strings.ReplaceAll(s, ")", `\)`)
	return s
}

func pdfSafe(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 32 && r <= 126 {
			b.WriteRune(r)
		} else if r == '\t' {
			b.WriteByte(' ')
		}
	}
	return b.String()
}
