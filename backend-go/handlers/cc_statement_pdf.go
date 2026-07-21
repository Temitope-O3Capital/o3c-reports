package handlers

import (
	"bytes"
	"fmt"
	"strings"
	"time"

	"github.com/o3c/reports/core"
)

// CC Statement PDF generator — raw PDF 1.4, no external dependencies.
// Coordinate system: origin bottom-left, Y increases upward.
// Page: 612 × 792 (US Letter). Content: x=32..580 (width=548).
// Fonts: F1=Helvetica, F2=Helvetica-Bold, F3=Helvetica-Oblique.

type ccPDF struct {
	pages []string
	cur   strings.Builder
	curY  float64
}

func (p *ccPDF) startPage(topY float64) { p.cur.Reset(); p.curY = topY }
func (p *ccPDF) commit()                { p.pages = append(p.pages, p.cur.String()); p.cur.Reset() }

// ── Primitives ────────────────────────────────────────────────────────────────

func (p *ccPDF) fillRect(x, y, w, h, r, g, b float64) {
	fmt.Fprintf(&p.cur, "%.3f %.3f %.3f rg\n%.2f %.2f %.2f %.2f re\nf\n0 0 0 rg\n",
		r, g, b, x, y, w, h)
}

func (p *ccPDF) hline(x1, x2, y, r, g, b, lw float64) {
	fmt.Fprintf(&p.cur, "%.3f %.3f %.3f RG\n%.1f w\n%.2f %.2f m\n%.2f %.2f l\nS\n0 0 0 RG\n0.5 w\n",
		r, g, b, lw, x1, y, x2, y)
}

func (p *ccPDF) vline(x, y1, y2, r, g, b, lw float64) {
	fmt.Fprintf(&p.cur, "%.3f %.3f %.3f RG\n%.1f w\n%.2f %.2f m\n%.2f %.2f l\nS\n0 0 0 RG\n0.5 w\n",
		r, g, b, lw, x, y1, x, y2)
}

func (p *ccPDF) text(x, y float64, font string, size, r, g, b float64, s string) {
	if s == "" {
		return
	}
	fmt.Fprintf(&p.cur, "BT\n/%s %.1f Tf\n%.3f %.3f %.3f rg\n%.2f %.2f Td\n(%s) Tj\nET\n0 0 0 rg\n",
		font, size, r, g, b, x, y, pdfEscape(pdfSafe(s)))
}

// pdfTextRight right-aligns text so its right edge lands at x.
// charScale: ~0.47 Helvetica regular, ~0.52 Helvetica-Bold.
func (p *ccPDF) pdfTextRight(x, y float64, font string, size, r, g, b float64, s string, charScale float64) {
	p.text(x-float64(len(s))*size*charScale, y, font, size, r, g, b, s)
}

// ── Section builders ──────────────────────────────────────────────────────────

// drawBankBar draws the navy band (y=750..792) and red accent (y=746..750).
// Does NOT advance curY.
func (p *ccPDF) drawBankBar(d ccData, stmtPeriod string) {
	p.fillRect(0, 750, 612, 42, 0.055, 0.122, 0.255) // navy
	p.fillRect(0, 746, 612, 4, 0.753, 0.0, 0.0)      // red accent

	// Brand: "O3" red, "Capital" white
	p.text(32, 772, "F2", 16, 0.753, 0.0, 0.0, "O3")
	p.text(57, 772, "F2", 16, 1, 1, 1, "Capital")
	p.text(32, 759, "F1", 7, 0.5, 0.52, 0.56, "CARDS DIVISION  -  LICENSED BY CBN")

	// Right: document declaration
	p.pdfTextRight(580, 779, "F1", 7, 0.6, 0.62, 0.65, "CREDIT CARD STATEMENT", 0.47)
	p.pdfTextRight(580, 768, "F2", 11, 1, 1, 1, stmtPeriod, 0.47)
	p.pdfTextRight(580, 757, "F3", 7, 0.4, 0.42, 0.45, "Ref: "+d.refNo+"  |  Generated: "+d.generatedAt, 0.42)
}

// drawContinuationBar draws a compact header for pages 2+. Does NOT advance curY.
func (p *ccPDF) drawContinuationBar(d ccData) {
	p.fillRect(0, 750, 612, 42, 0.055, 0.122, 0.255)
	p.fillRect(0, 746, 612, 4, 0.753, 0.0, 0.0)
	p.text(32, 772, "F2", 13, 0.753, 0.0, 0.0, "O3")
	p.text(54, 772, "F2", 13, 1, 1, 1, "Capital  -  Credit Card Statement (continued)")
	p.pdfTextRight(580, 759, "F3", 7.5, 0.65, 0.65, 0.65,
		"Ref: "+d.refNo+"   Acct: "+d.accountNo+"   "+d.stmtDate, 0.42)
}

// drawCustomerStrip draws cardholder info (left) and meta fields (right).
// Starts at curY=746, consumes 90pt → curY=656.
func (p *ccPDF) drawCustomerStrip(d ccData) {
	top := p.curY // 746
	bot := top - 90

	// ── Left: cardholder ──────────────────────────────────
	p.text(32, top-11, "F1", 6.5, 0.58, 0.58, 0.58, "CARDHOLDER")
	p.text(32, top-24, "F2", 13, 0.055, 0.122, 0.255, d.customerName)

	// Address — try newline split first, fall back to comma
	addrLines := strings.Split(d.customerAddr, "\n")
	if len(addrLines) == 1 && strings.Contains(d.customerAddr, ",") {
		addrLines = strings.Split(d.customerAddr, ",")
	}
	addrY := top - 38.0
	for _, line := range addrLines {
		if l := strings.TrimSpace(line); l != "" {
			p.text(32, addrY, "F1", 9, 0.39, 0.39, 0.39, l)
			addrY -= 11
		}
	}

	// Account pill
	pillY := bot + 8
	p.fillRect(32, pillY, 185, 14, 0.965, 0.969, 0.980)
	p.hline(32, 217, pillY+14, 0.80, 0.82, 0.85, 0.4)
	p.hline(32, 217, pillY, 0.80, 0.82, 0.85, 0.4)
	p.vline(32, pillY, pillY+14, 0.80, 0.82, 0.85, 0.4)
	p.vline(217, pillY, pillY+14, 0.80, 0.82, 0.85, 0.4)
	p.text(40, pillY+4, "F1", 6, 0.58, 0.58, 0.58, "CARD ACCOUNT")
	acct := d.accountNo
	if len(acct) > 4 {
		acct = "xxxx xxxx xxxx " + acct[len(acct)-4:]
	}
	p.text(108, pillY+4, "F2", 8, 0.055, 0.122, 0.255, acct)

	// ── Right: meta fields ────────────────────────────────
	// Left accent border
	p.fillRect(368, bot, 2, 90, 0.886, 0.910, 0.941)

	type metaField struct {
		label     string
		val       string
		vr, vg, vb float64
	}
	fields := []metaField{
		{"STATEMENT DATE", d.stmtDate, 0.055, 0.122, 0.255},
		{"PAYMENT DUE DATE", d.dueDate, 0.753, 0.0, 0.0},
		{"CREDIT LIMIT", "NGN " + ccFmtKobo(d.lineOfCredit), 0.055, 0.122, 0.255},
		{"CARD TYPE", "O3 Credit Card", 0.055, 0.122, 0.255},
	}
	fieldH := 22.0
	fy := top - 2.0
	for i, f := range fields {
		if i > 0 {
			p.hline(374, 580, fy, 0.886, 0.910, 0.941, 0.4)
		}
		p.text(376, fy-8, "F1", 6.5, 0.58, 0.58, 0.58, f.label)
		p.text(376, fy-18, "F2", 9, f.vr, f.vg, f.vb, f.val)
		fy -= fieldH
	}

	// Bottom rule
	p.hline(32, 580, bot, 0.886, 0.910, 0.941, 0.5)
	p.curY = bot
}

// drawSummaryTiles draws 5 account summary tiles. Consumes 50pt.
func (p *ccPDF) drawSummaryTiles(d ccData, totalPurchDr, totalCr int64, drCount, crCount int) {
	tileW := 548.0 / 5
	top := p.curY
	h := 50.0
	bot := top - h

	type tileSpec struct {
		label       string
		val         string
		sub         string
		tr, tg, tb  float64 // top-border color
		vr, vg, vb  float64 // value color
	}
	tiles := []tileSpec{
		{
			"PREVIOUS BALANCE", "NGN " + ccFmtKobo(d.openingBal), "Period start",
			0.886, 0.910, 0.941, 0.055, 0.122, 0.255,
		},
		{
			"TOTAL DEBITS", "NGN " + ccFmtKobo(totalPurchDr),
			fmt.Sprintf("%d transaction%s", drCount, pluralS(drCount)),
			0.753, 0.0, 0.0, 0.753, 0.0, 0.0,
		},
		{
			"TOTAL CREDITS", "NGN " + ccFmtKobo(totalCr),
			fmt.Sprintf("%d payment%s", crCount, pluralS(crCount)),
			0.088, 0.396, 0.204, 0.088, 0.396, 0.204,
		},
		{
			"FINANCE CHARGE", "NGN " + ccFmtKobo(d.financeCharge), "5% cycle interest",
			0.851, 0.467, 0.024, 0.851, 0.467, 0.024,
		},
		{
			"CLOSING BALANCE", "NGN " + ccFmtKobo(d.closingBal), "As at " + d.stmtDate,
			0.055, 0.122, 0.255, 0.055, 0.122, 0.255,
		},
	}

	for i, t := range tiles {
		x := 32 + float64(i)*tileW
		if i > 0 {
			p.vline(x, bot, top, 0.886, 0.910, 0.941, 0.5)
		}
		// Colored top border (3pt)
		p.fillRect(x, top-3, tileW, 3, t.tr, t.tg, t.tb)
		// Label
		p.text(x+6, top-12, "F1", 6.5, 0.58, 0.58, 0.58, t.label)
		// Value
		p.text(x+6, top-26, "F2", 11, t.vr, t.vg, t.vb, t.val)
		// Sub
		p.text(x+6, top-38, "F1", 7, 0.58, 0.58, 0.58, t.sub)
	}

	p.hline(32, 580, bot, 0.886, 0.910, 0.941, 0.5)
	p.curY = bot
}

// drawPaymentCTA draws the navy payment bar. Consumes 62pt.
func (p *ccPDF) drawPaymentCTA(d ccData) {
	h := 62.0
	top := p.curY
	bot := top - h

	p.fillRect(32, bot, 548, h, 0.055, 0.122, 0.255)
	p.fillRect(32, top-3, 548, 3, 0.753, 0.0, 0.0) // red top border

	// ── Left: minimum payment ─────────────────────────────
	minAmt := d.closingBal
	minNote := "Full balance due"
	if d.minPayment > 0 {
		minAmt = d.minPayment
		minNote = "20% of outstanding balance"
	}
	p.text(40, top-13, "F1", 6.5, 0.6, 0.62, 0.65, "MINIMUM PAYMENT DUE")
	p.text(40, top-32, "F2", 22, 1, 1, 1, "NGN "+ccFmtKobo(minAmt))
	p.text(40, top-48, "F1", 8, 0.6, 0.62, 0.65, "Due by "+d.dueDate+"  -  "+minNote)

	// Separator
	p.vline(300, bot+6, top-4, 0.2, 0.3, 0.45, 0.5)

	// ── Right: 3 meta items ───────────────────────────────
	availLabel := "NGN " + ccFmtKobo(d.availCredit) + " avail"
	availWarn := false
	if d.overLimit {
		over := d.closingBal - d.lineOfCredit
		availLabel = "Over by NGN " + ccFmtKobo(over)
		availWarn = true
	}

	type mi struct{ label, val string; warn bool }
	items := []mi{
		{"OUTSTANDING BALANCE", "NGN " + ccFmtKobo(d.closingBal), false},
		{"FINANCE CHARGE", "NGN " + ccFmtKobo(d.financeCharge), false},
		{"CREDIT LIMIT USED", availLabel, availWarn},
	}
	miW := 280.0 / 3
	for i, item := range items {
		ix := 308 + float64(i)*miW
		if i > 0 {
			p.vline(ix-2, bot+6, top-4, 0.2, 0.3, 0.45, 0.5)
		}
		vr, vg, vb := 0.70, 0.73, 0.77
		if item.warn {
			vr, vg, vb = 0.988, 0.643, 0.643
		}
		p.text(ix, top-15, "F1", 6, 0.4, 0.42, 0.46, item.label)
		p.text(ix, top-27, "F2", 9, vr, vg, vb, item.val)
	}

	p.curY = bot
}

// drawTxnSectionHead draws the section label bar. Consumes 16pt.
func (p *ccPDF) drawTxnSectionHead(txnCount int, stmtPeriod string) {
	h := 16.0
	bot := p.curY - h
	p.fillRect(32, bot, 548, h, 0.937, 0.945, 0.957)
	suffix := "ENTRIES"
	if txnCount == 1 {
		suffix = "ENTRY"
	}
	p.text(40, bot+5, "F2", 8, 0.055, 0.122, 0.255,
		fmt.Sprintf("TRANSACTION DETAIL  -  %d %s", txnCount, suffix))
	p.pdfTextRight(578, bot+5, "F1", 7, 0.50, 0.50, 0.50, stmtPeriod, 0.42)
	p.curY = bot
}

// drawTxnTableHeader draws the 6-column navy header. Consumes 16pt.
// Columns: Txn Date | Post Date | Description | Debit | Credit | Balance
func (p *ccPDF) drawTxnTableHeader() {
	h := 16.0
	bot := p.curY - h
	p.fillRect(0, bot, 612, h, 0.055, 0.122, 0.255)
	p.fillRect(507, bot, 105, h, 0.086, 0.184, 0.353) // balance col highlight

	type col struct {
		x     float64
		label string
		right bool
		rEdge float64
	}
	cols := []col{
		{32, "TXN DATE", false, 0},
		{86, "POST DATE", false, 0},
		{140, "DESCRIPTION", false, 0},
		{0, "DEBIT", true, 443},
		{0, "CREDIT", true, 507},
		{509, "BALANCE", false, 0},
	}
	for _, c := range cols {
		if c.right {
			p.pdfTextRight(c.rEdge, bot+4.5, "F2", 7, 1, 1, 1, c.label, 0.52)
		} else {
			p.text(c.x, bot+4.5, "F2", 7, 0.70, 0.72, 0.75, c.label)
		}
	}
	p.curY = bot
}

// drawTxnRow draws one 6-column transaction row. Consumes 14pt.
func (p *ccPDF) drawTxnRow(txnDate, postDate, desc, dr, cr, bal string, isFC, alt bool) {
	// WinAnsi encoding can't represent the em dash (U+2014) — replace with a plain hyphen.
	if txnDate == "—" {
		txnDate = "-"
	}
	if postDate == "—" {
		postDate = "-"
	}
	h := 14.0
	bot := p.curY - h

	// Row background
	switch {
	case isFC:
		p.fillRect(32, bot, 548, h, 1.0, 0.996, 0.941)
		p.fillRect(32, bot, 3, h, 0.851, 0.467, 0.024) // amber left indicator
	case alt:
		p.fillRect(32, bot, 548, h, 0.973, 0.976, 0.984)
	}
	// Balance col always highlighted
	p.fillRect(507, bot, 73, h, 0.941, 0.953, 0.965)
	p.hline(32, 580, bot, 0.886, 0.910, 0.941, 0.3)

	muted := 0.40
	descR, descG, descB := 0.055, 0.122, 0.255
	drR, drG, drB := 0.753, 0.0, 0.0
	if isFC {
		descR, descG, descB = 0.573, 0.251, 0.031
		drR, drG, drB = 0.851, 0.467, 0.024
	}

	// Truncate long description
	if len(desc) > 38 {
		desc = desc[:37] + "."
	}

	p.text(32, bot+4, "F1", 7, muted, muted, muted, txnDate)
	p.text(86, bot+4, "F1", 7, muted, muted, muted, postDate)
	p.text(140, bot+4, "F2", 7.5, descR, descG, descB, desc)

	if dr != "" {
		p.pdfTextRight(443, bot+4, "F2", 7.5, drR, drG, drB, dr, 0.52)
	}
	if cr != "" {
		p.pdfTextRight(507, bot+4, "F2", 7.5, 0.088, 0.396, 0.204, cr, 0.52)
	}
	p.pdfTextRight(578, bot+4, "F2", 7.5, 0.055, 0.122, 0.255, bal, 0.52)

	p.curY = bot
}

// drawPeriodTotalsRow draws the tfoot totals bar. Consumes 18pt.
func (p *ccPDF) drawPeriodTotalsRow(dr, cr, bal string) {
	h := 18.0
	bot := p.curY - h
	p.fillRect(0, bot, 612, h, 0.055, 0.122, 0.255)
	p.fillRect(507, bot, 105, h, 0.086, 0.184, 0.353)

	p.text(40, bot+5, "F2", 8, 0.60, 0.62, 0.65, "PERIOD TOTALS")
	p.pdfTextRight(443, bot+5, "F2", 8, 0.988, 0.643, 0.643, dr, 0.52)
	p.pdfTextRight(507, bot+5, "F2", 8, 0.529, 0.937, 0.671, cr, 0.52)
	p.pdfTextRight(578, bot+5, "F2", 8.5, 1, 1, 1, bal, 0.52)
	p.curY = bot
}

// drawPaymentNotice draws the 2-column notice panel. Consumes 42pt.
func (p *ccPDF) drawPaymentNotice() {
	h := 42.0
	bot := p.curY - h
	p.hline(32, 580, p.curY, 0.886, 0.910, 0.941, 0.5)
	p.vline(306, bot, p.curY, 0.886, 0.910, 0.941, 0.5)

	p.text(40, p.curY-9, "F2", 7, 0.40, 0.40, 0.40, "HOW TO PAY")
	p.text(40, p.curY-19, "F1", 7.5, 0.30, 0.30, 0.30, "Transfer to your O3 Capital card account or pay via")
	p.text(40, p.curY-29, "F1", 7.5, 0.30, 0.30, 0.30, "the O3 Capital mobile app (allow 2 business days).")

	p.text(314, p.curY-9, "F2", 7, 0.40, 0.40, 0.40, "LATE PAYMENT NOTICE")
	p.text(314, p.curY-19, "F1", 7.5, 0.30, 0.30, 0.30, "Failure to pay the minimum amount by the due date")
	p.text(314, p.curY-29, "F1", 7.5, 0.30, 0.30, 0.30, "will result in additional charges affecting your standing.")

	p.hline(32, 580, bot, 0.886, 0.910, 0.941, 0.5)
	p.curY = bot
}

// drawRepaymentMethods draws the 3-column repayment section. Consumes 50pt.
func (p *ccPDF) drawRepaymentMethods(d ccData) {
	h := 50.0
	top := p.curY
	bot := top - h
	colW := 548.0 / 3

	p.text(32, top-8, "F2", 7, 0.30, 0.30, 0.30, "OFF-CYCLE REPAYMENT METHODS")
	p.hline(32, 580, top-11, 0.886, 0.910, 0.941, 0.5)

	type method struct{ title, line1, line2 string }
	methods := []method{
		{
			"1. Bank Transfer",
			"Bank: O3 Capital MFB  |  Acc: " + d.accountNo,
			"Name: " + d.customerName + " (Credit Card)",
		},
		{
			"2. Mobile App",
			"O3 Capital App > Cards > Fund My Card",
			"Funds reflect immediately on your balance.",
		},
		{
			"3. QuickTeller",
			"quickteller.com > Pay Bills > O3 Capital Cards",
			"Enter card account number and amount.",
		},
	}
	for i, m := range methods {
		x := 32 + float64(i)*colW
		if i > 0 {
			p.vline(x, bot, top-12, 0.886, 0.910, 0.941, 0.5)
		}
		p.text(x+5, top-21, "F2", 8, 0.055, 0.122, 0.255, m.title)
		p.text(x+5, top-31, "F1", 7, 0.35, 0.35, 0.35, m.line1)
		p.text(x+5, top-41, "F1", 7, 0.35, 0.35, 0.35, m.line2)
	}

	p.hline(32, 580, bot, 0.886, 0.910, 0.941, 0.5)
	p.curY = bot
}

// drawFooter draws the navy 3-column footer (fixed y=30..105).
func (p *ccPDF) drawFooter(d ccData) {
	p.fillRect(0, 30, 612, 75, 0.055, 0.122, 0.255)
	p.hline(32, 580, 50, 0.20, 0.30, 0.45, 0.5) // divider above stamp

	colW := 548.0 / 3
	type ftCol struct{ head string; lines []string }
	cols := []ftCol{
		{
			"CONTACT & SUPPORT",
			[]string{"care@o3cards.com", "+234 201 330 1070", "O3 Capital mobile app"},
		},
		{
			"DISPUTE A TRANSACTION",
			[]string{"Disputes within 60 days of statement date.", "Contact cards team via app or email", "with your trace reference number."},
		},
		{
			"O3 CAPITAL CARDS",
			[]string{"7th Floor, Churchgate Tower 1", "Victoria Island, Lagos 101001", "Nigeria"},
		},
	}
	for i, col := range cols {
		x := 32 + float64(i)*colW
		if i > 0 {
			p.vline(x, 52, 102, 0.20, 0.30, 0.45, 0.5)
		}
		p.text(x+4, 100, "F2", 6.5, 0.40, 0.42, 0.46, col.head)
		for j, line := range col.lines {
			p.text(x+4, 92-float64(j)*9, "F1", 7, 0.55, 0.57, 0.60, line)
		}
	}

	p.text(32, 38, "F1", 7, 0.40, 0.42, 0.46,
		"Computer generated statement - no signature or stamp required")
	p.pdfTextRight(580, 38, "F3", 7, 0.40, 0.42, 0.46,
		"Generated "+d.generatedAt+"  |  Ref: "+d.refNo+"  |  Stmt: "+d.stmtDate, 0.42)
}

// ── Main entry point ──────────────────────────────────────────────────────────

func ccBuildPDF(stmt core.Row, txns []core.Row) []byte {
	d := ccExtract(stmt)

	// Statement period string "01 Jan 2006 - DD Mon YYYY"
	stmtPeriod := d.stmtDate
	if t, err := time.Parse("02 Jan 2006", d.stmtDate); err == nil {
		first := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, t.Location())
		stmtPeriod = first.Format("02 Jan 2006") + " - " + d.stmtDate
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
	totalDr := totalPurchDr + totalFCDr

	const footerReserve = 110.0 // footer occupies y=30..105; keep 110pt clear

	p := &ccPDF{}

	// ── Page 1 ────────────────────────────────────────────────────────────────
	p.startPage(746)
	p.drawBankBar(d, stmtPeriod)
	p.drawCustomerStrip(d)                                           // curY → 656
	p.drawSummaryTiles(d, totalPurchDr, totalCr, drCount, crCount)  // curY → 606
	p.drawPaymentCTA(d)                                              // curY → ~544
	p.drawTxnSectionHead(len(txns), stmtPeriod)
	p.drawTxnTableHeader()

	// ── Transaction rows ──────────────────────────────────────────────────────
	runBal := d.openingBal
	rowIdx := 0
	for _, t := range txns {
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

		if p.curY < footerReserve+14 {
			p.drawFooter(d)
			p.commit()
			p.startPage(746)
			p.drawContinuationBar(d)
			p.drawTxnTableHeader()
		}

		drStr, crStr := "", ""
		if dr > 0 {
			drStr = ccFmtKobo(dr)
		}
		if cr > 0 {
			crStr = ccFmtKobo(cr)
		}

		p.drawTxnRow(txnDate, postDate, desc, drStr, crStr,
			ccFmtKobo(runBal), isFC, rowIdx%2 == 1)
		rowIdx++
	}

	// ── Post-table sections — page break if insufficient space ────────────────
	// totals(18) + notice(42) + repayment(50) = 110pt needed above footer
	if p.curY < footerReserve+110 {
		p.drawFooter(d)
		p.commit()
		p.startPage(746)
		p.drawContinuationBar(d)
		p.curY = 740
	}

	p.drawPeriodTotalsRow(ccFmtKobo(totalDr), ccFmtKobo(totalCr), ccFmtKobo(d.closingBal))
	p.drawPaymentNotice()
	p.drawRepaymentMethods(d)
	p.drawFooter(d)
	p.commit()

	return p.assemble()
}

// ── PDF document assembly ─────────────────────────────────────────────────────

func (p *ccPDF) assemble() []byte {
	// Object layout:
	// 1: Catalog, 2: Pages
	// 3, 5, ..., 3+(N-1)*2: Page objects
	// 4, 6, ..., 4+(N-1)*2: Content streams
	// 3+N*2: F1 (Helvetica), 4+N*2: F2 (Helvetica-Bold), 5+N*2: F3 (Helvetica-Oblique)

	N := len(p.pages)
	f1 := 3 + N*2
	f2 := f1 + 1
	f3 := f1 + 2
	totalObjs := f3

	var objs []string
	objs = append(objs, "<< /Type /Catalog /Pages 2 0 R >>")

	kids := make([]string, N)
	for i := range p.pages {
		kids[i] = fmt.Sprintf("%d 0 R", 3+i*2)
	}
	objs = append(objs, fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>",
		strings.Join(kids, " "), N))

	for i, content := range p.pages {
		contentObj := 3 + i*2 + 1
		objs = append(objs, fmt.Sprintf(
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "+
				"/Resources << /Font << /F1 %d 0 R /F2 %d 0 R /F3 %d 0 R >> >> "+
				"/Contents %d 0 R >>",
			f1, f2, f3, contentObj))
		objs = append(objs,
			fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content))
	}

	objs = append(objs, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
	objs = append(objs, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
	objs = append(objs, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>")

	if len(objs) != totalObjs {
		panic(fmt.Sprintf("cc pdf: object count %d != %d", len(objs), totalObjs))
	}

	var buf bytes.Buffer
	buf.WriteString("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")

	offsets := make([]int, totalObjs+1)
	for i, obj := range objs {
		offsets[i+1] = buf.Len()
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", i+1, obj)
	}

	xref := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n0000000000 65535 f \n", totalObjs+1)
	for i := 1; i <= totalObjs; i++ {
		fmt.Fprintf(&buf, "%010d 00000 n \n", offsets[i])
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n",
		totalObjs+1, xref)

	return buf.Bytes()
}

func pdfMin(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
