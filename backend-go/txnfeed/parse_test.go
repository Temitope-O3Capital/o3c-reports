package txnfeed

import "testing"

// docSample is the txn_file row documented in docs/DATA_FEED_INGESTION.md §3.3,
// verbatim. Positions are 1-indexed in the doc and 0-indexed here.
const docSample = `14/04/2026,14/04/2026,604,11827.61,Total Interest,0001073486566,,2,60477, 0,,,,000000,-1,1`

// TestParseLineDecodesFormerlyDroppedFields pins field 8 (code class) and field
// 14 (processing code) to the struct. Both were parsed past before migration
// 233, and both sit next to fields that are easy to confuse them with — field 9
// is the trace and field 16 the row sequence — so a shifted index would look
// plausible while silently writing the wrong value.
func TestParseLineDecodesFormerlyDroppedFields(t *testing.T) {
	got, err := ParseLine(docSample)
	if err != nil {
		t.Fatalf("ParseLine: %v", err)
	}
	for _, c := range []struct {
		name, got, want string
	}{
		{"CodeClass (field 8)", got.CodeClass, "2"},
		{"PCC (field 14)", got.PCC, "000000"},
		{"Trace (field 9)", got.Trace, "60477"},
		{"RowSeq (field 16)", got.RowSeq, "1"},
		{"AccountNo (field 6)", got.AccountNo, "0001073486566"},
		{"Code (field 3)", got.Code, "604"},
	} {
		if c.got != c.want {
			t.Errorf("%s = %q, want %q", c.name, c.got, c.want)
		}
	}
}

// TestPCCIsNotATime documents why there is no time-of-day column. Field 14 reads
// 000000 on ~99.4% of rows across the retained 2021-2026 drops; treating it as a
// clock would produce an analytic built on 0.6% coverage.
func TestPCCIsNotATime(t *testing.T) {
	got, err := ParseLine(docSample)
	if err != nil {
		t.Fatalf("ParseLine: %v", err)
	}
	if got.PCC != "000000" {
		t.Fatalf("PCC = %q, want the all-zero processing code from the documented sample", got.PCC)
	}
}

// TestRowHashIgnoresTheNewFields is the important one: row_hash is the
// idempotency key for every feed row already in the ledger. If adding pcc or
// code_class changed it, re-reading a file would no longer conflict and the
// whole 14.7k feed-sourced population could be inserted a second time.
func TestRowHashIgnoresTheNewFields(t *testing.T) {
	base, err := ParseLine(docSample)
	if err != nil {
		t.Fatalf("ParseLine: %v", err)
	}
	want := base.RowHash()

	altered := base
	altered.PCC = "123456"
	altered.CodeClass = "9"
	if got := altered.RowHash(); got != want {
		t.Errorf("RowHash changed when pcc/code_class changed (%q -> %q); "+
			"the dedup key must stay (account_no, post_date, txn_date, code, amount, trace, row_seq)", want, got)
	}
}

// TestParseLineRejectsShiftedRow keeps the existing guarantee: the files have no
// quoting, so a comma inside a value shifts every later field. A row that is not
// exactly 16 fields must be rejected rather than written to the wrong columns.
func TestParseLineRejectsShiftedRow(t *testing.T) {
	if _, err := ParseLine(docSample + ",extra"); err == nil {
		t.Fatal("a 17-field row was accepted; it must be rejected")
	}
}
