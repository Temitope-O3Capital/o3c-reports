package acctfeed

import "testing"

// docSample is the acct_file row documented in docs/DATA_FEED_INGESTION.md §3.2,
// verbatim — including the leading-space fields (` 1`, ` `) the real files carry.
const docSample = `004009548566,PREP,0.00, 1,0.00,0.000,566,07/12/2021,0.00,0.00,31/12/2023,0.00, ,14/04/2026,CR,00000001,30/04/2026,506124*********0579,UA 457,07/12/2021`

// TestParseLineDecodesFormerlyDroppedFields pins fields 4, 6, 7 and 20, none of
// which had a column before migration 233.
//
// Field 7 is the one that matters: the doc calls it a branch code, but it is the
// ISO-4217 currency (566 NGN / 840 USD — every 840 row in the drops carries
// product 'Amex USD'). Without it, SUM(amount) adds dollars to naira.
func TestParseLineDecodesFormerlyDroppedFields(t *testing.T) {
	got, err := ParseLine(docSample)
	if err != nil {
		t.Fatalf("ParseLine: %v", err)
	}
	if got.CurrencyCode != "566" {
		t.Errorf("CurrencyCode (field 7) = %q, want %q", got.CurrencyCode, "566")
	}
	if got.StatusCode != "1" {
		t.Errorf("StatusCode (field 4) = %q, want %q — leading space must be trimmed", got.StatusCode, "1")
	}
	if !got.InterestRate.Valid || got.InterestRate.Float64 != 0 {
		t.Errorf("InterestRate (field 6) = %+v, want a valid 0", got.InterestRate)
	}
	if !got.CardIssueDate.Valid || got.CardIssueDate.Time.Format("2006-01-02") != "2021-12-07" {
		t.Errorf("CardIssueDate (field 20) = %+v, want 2021-12-07", got.CardIssueDate)
	}
	// Regression guard: the fields that already worked must not have shifted.
	if got.AccountNo != "004009548566" || got.CIF != "00000001" || got.NameOnCard != "UA 457" {
		t.Errorf("existing fields shifted: account=%q cif=%q name=%q", got.AccountNo, got.CIF, got.NameOnCard)
	}
}

// TestJunkCurrencyIsDropped covers the real junk the 2026 drops contain: a stray
// ' 1' and '0.000' turn up in field 7. Storing '0.000' would look like a genuine
// ISO code to everything downstream, which is worse than storing nothing.
func TestJunkCurrencyIsDropped(t *testing.T) {
	for _, junk := range []string{"0.000", "1", "56", "5666", "NGN", ""} {
		line := replaceField(docSample, 6, junk)
		got, err := ParseLine(line)
		if err != nil {
			t.Fatalf("ParseLine(%q): %v", junk, err)
		}
		if got.CurrencyCode != "" {
			t.Errorf("field 7 %q was accepted as currency %q; want it dropped", junk, got.CurrencyCode)
		}
	}
}

// TestUSDCurrencyIsKept — 840 is the value the whole naira/dollar split depends on.
func TestUSDCurrencyIsKept(t *testing.T) {
	got, err := ParseLine(replaceField(docSample, 6, "840"))
	if err != nil {
		t.Fatalf("ParseLine: %v", err)
	}
	if got.CurrencyCode != "840" {
		t.Errorf("CurrencyCode = %q, want 840 (USD)", got.CurrencyCode)
	}
}

// replaceField swaps one 0-indexed comma-separated field, keeping the field count
// intact so the row still parses.
func replaceField(line string, idx int, val string) string {
	f := splitComma(line)
	f[idx] = val
	out := ""
	for i, v := range f {
		if i > 0 {
			out += ","
		}
		out += v
	}
	return out
}

func splitComma(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == ',' {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(r)
	}
	return append(out, cur)
}
