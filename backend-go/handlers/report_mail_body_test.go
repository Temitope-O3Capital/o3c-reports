package handlers

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/o3c/workspace/core"
)

// A fixed clock and a fixed count, so the assertions below describe the layout rather
// than whatever day the suite happens to run on.
func renderReportMailForTest(t *testing.T, name, note string, sender *core.Claims) string {
	t.Helper()
	at := time.Date(2026, 10, 19, 9, 30, 0, 0, reportTZ)
	htmlBody, _ := reportMailBody(name, note,
		"The attached XLSX file holds the complete report.", 1812, "records", sender, at)
	return htmlBody
}

// What a report email may and may not contain. These are the four things that were wrong
// with it, written down so they cannot come back one at a time.
//
// Set REPORT_MAIL_DUMP=<dir> to also write the rendered HTML there and look at it:
//
//	REPORT_MAIL_DUMP=/tmp go test ./handlers -run TestReportEmailBody
func TestReportEmailBodyUsesTheHouseSheetAndNothingElse(t *testing.T) {
	body := renderReportMailForTest(t, "Collections Payments", "Please check the Lagos figures.",
		&core.Claims{FullName: "Temitope Babatunde", Sub: "tbabatunde@o3cards.com", Department: "Technology"})

	// The house sheet, not the old navy-and-grey layout.
	for _, want := range []string{
		"O 3 &nbsp; C A P I T A L", // the type masthead
		shBrass,                    // the brass rule
		shPaper,                    // paper on its ground
		"Georgia",                  // the headline face
	} {
		if !strings.Contains(body, want) {
			t.Errorf("the email is not on the house sheet: %q is missing", want)
		}
	}

	// NO INLINE TABLE. The figures are in the attachment; a hundred nowrap cells in a
	// 680px sheet is a horizontal scrollbar on a desktop and a grey wall on a phone.
	if strings.Contains(body, "<table") && strings.Contains(body, "<thead") {
		t.Error("the body still renders a data table; the attachment is where the figures live")
	}
	if strings.Contains(body, "border-collapse") {
		t.Error("a data table's styling is still present in the body")
	}

	// NO "generated" LINE. The reader can see that software made it; saying so is what
	// made the mail read as machine-written.
	for _, banned := range []string{
		"O3 Capital Workspace · generated",
		"generated from the Report Builder",
		"was generated",
	} {
		if strings.Contains(body, banned) {
			t.Errorf("the body still says %q", banned)
		}
	}

	// No unsubscribe line on a report. Ours only adds one for Kind == "campaign", so if
	// this ever appears it came from a template change rather than the mail layer.
	if strings.Contains(strings.ToLower(body), "unsubscribe") {
		t.Error("a report email must not carry an unsubscribe line: it is not bulk marketing")
	}

	// The note and the sender both survive into the body.
	if !strings.Contains(body, "Please check the Lagos figures.") {
		t.Error("the sender's note is missing from the body")
	}
	if !strings.Contains(body, "Temitope Babatunde") {
		t.Error("the body does not say who sent it")
	}
	if !strings.Contains(body, "tbabatunde@o3cards.com") {
		t.Error("the footer does not say where a reply goes")
	}

	// Thousands separators: "1,812 records" reads like a sentence, "1812" like a log line.
	if !strings.Contains(body, "1,812") {
		t.Errorf("the record count is not grouped; dateline reads: %s", datelineOf(body))
	}

	if dir := os.Getenv("REPORT_MAIL_DUMP"); dir != "" {
		p := filepath.Join(dir, "report-email.html")
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatalf("dump: %v", err)
		}
		t.Logf("wrote %s", p)
	}
}

// A report with no identified sender still has to produce a sane email — the scheduled
// path can hand over a nil owner when the account has been deactivated.
func TestReportEmailSurvivesAnUnknownSender(t *testing.T) {
	body := renderReportMailForTest(t, "Loan Repayments", "", nil)
	if strings.Contains(body, "Sent by ") {
		t.Error("with no sender known, the body should not claim one")
	}
	if !strings.Contains(body, "O3 Capital Workspace") {
		t.Error("the footer should fall back to naming the workspace")
	}
	if strings.Contains(body, "Reply to this email to reach") {
		t.Error("promising a reply address when there is none is worse than saying nothing")
	}
}

func TestFormatThousands(t *testing.T) {
	for in, want := range map[int]string{
		0: "0", 7: "7", 42: "42", 999: "999", 1000: "1,000",
		1812: "1,812", 29240: "29,240", 1000000: "1,000,000", 22237: "22,237",
	} {
		if got := formatThousands(in); got != want {
			t.Errorf("formatThousands(%d) = %q, want %q", in, got, want)
		}
	}
}

func datelineOf(body string) string {
	i := strings.Index(body, "&middot;")
	if i < 0 || i < 60 {
		return "(not found)"
	}
	return body[i-60 : i+40]
}
