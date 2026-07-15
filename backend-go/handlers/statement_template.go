package handlers

import (
	"bytes"
	"fmt"
	"html/template"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/o3c/reports/core"
)

// ── Template data types ───────────────────────────────────────────────────────

type stmtTmplTx struct {
	Date     string
	Desc     string
	Merchant string
	IsDebit  bool
	Amount   float64
}

type stmtTmplData struct {
	GeneratedAt  string
	PeriodFrom   string
	PeriodTo     string
	Name         string
	CIF          string
	Email        string
	Phone        string
	Location     string
	Product      string
	CardName     string
	Status       string
	TotalDebits  float64
	TotalCredits float64
	NetChange    float64
	Txns         []stmtTmplTx
	HasTxns      bool
	TxnCount     int
}

func buildStatementTemplateData(data customerStatementData) stmtTmplData {
	d := stmtTmplData{
		GeneratedAt: time.Now().Format("02 Jan 2006 at 15:04"),
		PeriodFrom:  data.DateFrom,
		PeriodTo:    data.DateTo,
		CIF:         data.CIF,
		Name:        statementCustomerName(data.Account),
		Email:       getRowString(data.Account, "Email"),
		Phone:       coalesce(getRowString(data.Account, "Phone", "Phone Number"), "—"),
		Location: strings.Trim(strings.Join([]string{
			getRowString(data.Account, "City"),
			getRowString(data.Account, "State"),
		}, ", "), ", "),
	}
	if len(data.Products) > 0 {
		p := data.Products[0]
		d.Product  = coalesce(getRowString(p, "Product_Name", "Product Name"), "Classic Card")
		d.CardName = coalesce(getRowString(p, "Name_On_Card", "Name On Card"), d.Name)
		d.Status   = coalesce(getRowString(p, "Account_Status", "Account Status"), "Active")
	} else {
		d.Product  = "Classic Card"
		d.CardName = d.Name
		d.Status   = "—"
	}

	for _, t := range data.Transactions {
		amt := toFloat(t["Amount"])
		absAmt := math.Abs(amt)
		isDebit := amt >= 0
		if isDebit {
			d.TotalDebits += absAmt
		} else {
			d.TotalCredits += absAmt
		}
		d.Txns = append(d.Txns, stmtTmplTx{
			Date:     shortDate(getRowString(t, "Transaction_Date", "Transaction Date")),
			Desc:     coalesce(getRowString(t, "Description"), "Transaction"),
			Merchant: getRowString(t, "Merchant_Name"),
			IsDebit:  isDebit,
			Amount:   absAmt,
		})
	}
	d.NetChange = d.TotalDebits - d.TotalCredits
	d.HasTxns   = len(d.Txns) > 0
	d.TxnCount  = len(d.Txns)
	return d
}

// ── Currency formatter ────────────────────────────────────────────────────────

func fmtNGN(f float64) string {
	neg := f < 0
	f = math.Abs(f)
	whole := int64(f)
	frac := int(math.Round((f - float64(whole)) * 100))
	// insert commas
	s := fmt.Sprintf("%d", whole)
	result := ""
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			result += ","
		}
		result += string(c)
	}
	sign := ""
	if neg {
		sign = "-"
	}
	return fmt.Sprintf("%s₦%s.%02d", sign, result, frac)
}

// ── Preview handler ───────────────────────────────────────────────────────────

func StatementPreview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif      := strings.TrimSpace(r.URL.Query().Get("cif"))
		fromStr  := r.URL.Query().Get("from")
		toStr    := r.URL.Query().Get("to")
		if cif == "" {
			http.Error(w, "cif is required", http.StatusBadRequest)
			return
		}
		dateFrom, dateTo, err := normalizeStatementDates(fromStr, toStr)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		data, err := loadCustomerStatement(r.Context(), db, cif, dateFrom, dateTo)
		if err != nil {
			http.Error(w, "Failed to load statement data", http.StatusInternalServerError)
			return
		}
		tmplData := buildStatementTemplateData(data)
		var buf bytes.Buffer
		if err := stmtHTMLTmpl.Execute(&buf, tmplData); err != nil {
			http.Error(w, "Template render error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(buf.Bytes())
	}
}

// ── HTML template ─────────────────────────────────────────────────────────────

var stmtHTMLTmpl = template.Must(
	template.New("statement").Funcs(template.FuncMap{
		"ngn": fmtNGN,
		"neg": func(f float64) bool { return f < 0 },
	}).Parse(stmtHTMLRaw),
)

const stmtHTMLRaw = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>O3 Cards — Account Statement</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#1a1a1a;background:#fff;max-width:900px;margin:0 auto}
.print-bar{display:flex;justify-content:flex-end;gap:10px;padding:14px 40px;background:#f5f7fa;border-bottom:1px solid #e5e7eb}
.btn{padding:8px 18px;border-radius:6px;border:none;font-size:12px;font-weight:600;cursor:pointer;font-family:Arial,sans-serif}
.btn-primary{background:#0E2841;color:#fff}
.btn-outline{background:transparent;color:#0E2841;border:1.5px solid #0E2841}

/* Header */
.header{background:#0E2841;color:#fff;padding:28px 40px;display:flex;justify-content:space-between;align-items:flex-start}
.logo-mark{font-size:24px;font-weight:700;letter-spacing:-.5px}
.logo-mark .dot{color:#C00000}
.logo-sub{font-size:8.5px;letter-spacing:2px;text-transform:uppercase;opacity:.6;margin-top:3px}
.header-addr{text-align:right;font-size:9.5px;line-height:1.8;opacity:.85}

/* Title bar */
.title-bar{background:#f5f7fa;border-bottom:3px solid #0E2841;padding:14px 40px;display:flex;justify-content:space-between;align-items:center}
.title-bar h1{font-size:16px;font-weight:700;color:#0E2841;letter-spacing:-.3px}
.title-bar .meta{font-size:10px;color:#666;text-align:right;line-height:1.7}

/* Customer + account block */
.info-row{display:flex;justify-content:space-between;padding:20px 40px;border-bottom:1px solid #e5e7eb;gap:40px}
.cust-name{font-size:15px;font-weight:700;color:#0E2841;margin-bottom:6px}
.info-line{font-size:10.5px;color:#555;line-height:1.85}
.info-label{font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#999;display:block;margin-top:8px}
.acct-block{text-align:right;min-width:200px}
.badge{display:inline-block;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:3px 10px;border-radius:20px;background:#dcfce7;color:#15803d;margin-top:4px}

/* Summary tiles */
.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin:24px 40px;border:1.5px solid #0E2841;border-radius:8px;overflow:hidden}
.sum-tile{padding:16px 18px;border-right:1px solid #0E2841}
.sum-tile:last-child{border-right:none}
.sum-tile.navy{background:#0E2841;color:#fff}
.sum-tile .lbl{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#999;margin-bottom:5px}
.sum-tile.navy .lbl{color:rgba(255,255,255,.6)}
.sum-tile .val{font-size:19px;font-weight:700;color:#0E2841;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.sum-tile.navy .val{color:#fff}
.sum-tile.red .val{color:#C00000}
.sum-tile.green .val{color:#15803d}

/* Transactions */
.txn-header{display:flex;justify-content:space-between;align-items:center;padding:0 40px;margin:8px 0 0}
.txn-title{font-size:11px;font-weight:700;color:#0E2841;text-transform:uppercase;letter-spacing:.5px}
.txn-count{font-size:10px;color:#888}
table{width:calc(100% - 80px);margin:10px 40px 0;border-collapse:collapse;font-size:10.5px}
thead tr{background:#0E2841}
thead th{padding:10px 12px;text-align:left;color:#fff;font-size:9px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;white-space:nowrap}
th.r{text-align:right}
tbody tr{border-bottom:1px solid #f0f0f0}
tbody tr:nth-child(even){background:#fafbfc}
td{padding:9px 12px;color:#333;vertical-align:middle;line-height:1.4}
td.date{color:#888;white-space:nowrap;font-size:10px}
td.desc{max-width:220px}
td.merchant{color:#777;font-size:10px;max-width:140px}
td.debit{text-align:right;color:#C00000;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
td.credit{text-align:right;color:#15803d;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
td.empty{text-align:right;color:#ccc}
.totals{background:#0E2841 !important;border-top:none !important}
.totals td{color:#fff;font-weight:700;padding:11px 12px;font-size:11px}
.totals td.debit{color:#ffb3b3;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.totals td.credit{color:#86efac;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}

/* No transactions */
.no-txns{margin:20px 40px;padding:32px;text-align:center;background:#fafbfc;border:1px dashed #e5e7eb;border-radius:8px;color:#aaa;font-size:12px}

/* Footer */
.footer{margin:28px 40px 32px;padding-top:16px;border-top:1px solid #e5e7eb}
.footer-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.footer-section .f-title{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#0E2841;margin-bottom:6px}
.footer-section p{font-size:9px;color:#888;line-height:1.7}
.footer-section ul{font-size:9px;color:#888;line-height:1.9;padding-left:14px}
.footer-bottom{margin-top:20px;padding-top:12px;border-top:1px solid #f0f0f0;display:flex;justify-content:space-between;align-items:center}
.footer-bottom .gen{font-size:8.5px;color:#bbb}
.footer-logo{font-size:13px;font-weight:700;color:#0E2841;letter-spacing:-.3px}
.footer-logo span{color:#C00000}

@media print{
  .print-bar{display:none}
  body{max-width:none}
  @page{size:A4;margin:0}
  html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
</style>
</head>
<body>

<!-- Print bar -->
<div class="print-bar">
  <button class="btn btn-outline" onclick="window.close()">Close</button>
  <button class="btn btn-primary" onclick="window.print()">&#128438; Print / Save as PDF</button>
</div>

<!-- Header -->
<div class="header">
  <div>
    <div class="logo-mark">O3 Capital<span class="dot">.</span></div>
    <div class="logo-sub">credible &nbsp;·&nbsp; accessible &nbsp;·&nbsp; reliable</div>
  </div>
  <div class="header-addr">
    7th Floor Churchgate Tower 1<br>
    Plot 30, Churchgate Street<br>
    Victoria Island, Lagos<br>
    www.o3cards.com &nbsp;|&nbsp; Care@o3cards.com<br>
    (+234) 2013301070
  </div>
</div>

<!-- Title bar -->
<div class="title-bar">
  <h1>Account Statement</h1>
  <div class="meta">
    Period: {{.PeriodFrom}} to {{.PeriodTo}}<br>
    Generated: {{.GeneratedAt}}
  </div>
</div>

<!-- Customer + account info -->
<div class="info-row">
  <div>
    <div class="cust-name">{{.Name}}</div>
    <div class="info-line">
      {{if .Location}}{{.Location}}, Nigeria{{end}}
    </div>
    <span class="info-label">CIF Number</span>
    <div class="info-line">{{.CIF}}</div>
    {{if .Email}}<span class="info-label">Email</span>
    <div class="info-line">{{.Email}}</div>{{end}}
    {{if .Phone}}<span class="info-label">Phone</span>
    <div class="info-line">{{.Phone}}</div>{{end}}
  </div>
  <div class="acct-block">
    <span class="info-label">Product</span>
    <div class="info-line" style="font-weight:600;color:#1a1a1a">{{.Product}}</div>
    <span class="info-label">Card Name</span>
    <div class="info-line">{{.CardName}}</div>
    <span class="info-label">Status</span>
    <div><span class="badge">{{.Status}}</span></div>
  </div>
</div>

<!-- Summary tiles -->
<div class="summary">
  <div class="sum-tile">
    <div class="lbl">Total Debits</div>
    <div class="val red">{{ngn .TotalDebits}}</div>
  </div>
  <div class="sum-tile">
    <div class="lbl">Total Credits</div>
    <div class="val green">{{ngn .TotalCredits}}</div>
  </div>
  <div class="sum-tile navy">
    <div class="lbl">Net Movement</div>
    <div class="val">{{ngn .NetChange}}</div>
  </div>
</div>

<!-- Transactions -->
<div class="txn-header">
  <span class="txn-title">Transactions</span>
  <span class="txn-count">{{.TxnCount}} transaction{{if ne .TxnCount 1}}s{{end}} in period</span>
</div>

{{if .HasTxns}}
<table>
  <thead>
    <tr>
      <th>Date</th>
      <th>Description</th>
      <th>Merchant</th>
      <th class="r">Debit</th>
      <th class="r">Credit</th>
    </tr>
  </thead>
  <tbody>
    {{range .Txns}}
    <tr>
      <td class="date">{{.Date}}</td>
      <td class="desc">{{.Desc}}</td>
      <td class="merchant">{{.Merchant}}</td>
      {{if .IsDebit}}
        <td class="debit">{{ngn .Amount}}</td>
        <td class="empty">—</td>
      {{else}}
        <td class="empty">—</td>
        <td class="credit">{{ngn .Amount}}</td>
      {{end}}
    </tr>
    {{end}}
    <tr class="totals">
      <td colspan="3" style="color:#fff;font-weight:700">Period Totals</td>
      <td class="debit">{{ngn .TotalDebits}}</td>
      <td class="credit">{{ngn .TotalCredits}}</td>
    </tr>
  </tbody>
</table>
{{else}}
<div class="no-txns">No transactions found for this period.</div>
{{end}}

<!-- Footer -->
<div class="footer">
  <div class="footer-grid">
    <div class="footer-section">
      <div class="f-title">Important Notice</div>
      <p>This statement is confidential and intended solely for the named account holder.
      Finance charges refer to interest accrued over the statement period.
      Making only minimum payments will extend the repayment period and increase total borrowing cost.
      If you experience difficulty meeting payments, please contact us immediately.</p>
    </div>
    <div class="footer-section">
      <div class="f-title">How to Make a Payment</div>
      <ul>
        <li>Bank Transfer to our collections account</li>
        <li>Fund My Card via the O3 Cards mobile app</li>
        <li>QuickTeller</li>
      </ul>
      <p style="margin-top:6px">To cancel a direct debit, make payment at least <strong>48 hours</strong> before the due date.</p>
    </div>
  </div>
  <div class="footer-bottom">
    <span class="gen">Generated {{.GeneratedAt}} &nbsp;|&nbsp; Statement period {{.PeriodFrom}} to {{.PeriodTo}}</span>
    <span class="footer-logo">O3<span> Capital</span></span>
  </div>
</div>

</body>
</html>`
