package custfeed

import (
	"testing"
	"time"
)

func TestParseLineDocumentedSample(t *testing.T) {
	// The worked example from docs/DATA_FEED_INGESTION.md §3.1.
	const line = `JAMELAH,SANDA,7TH FLOOR SUIT 2 PLOT 117 NUSIBA,TOWERS MABUSHI ABUJA,,NIGERIA,8060777721,amelahsanda@yahoo.com,FCT,ABUJA,8060777721,00039966`

	c, err := ParseLine(line)
	if err != nil {
		t.Fatalf("ParseLine: %v", err)
	}
	for _, tc := range []struct{ field, got, want string }{
		{"CIF", c.CIF, "00039966"},
		{"FirstName", c.FirstName, "JAMELAH"},
		{"LastName", c.LastName, "SANDA"},
		{"Address1", c.Address1, "7TH FLOOR SUIT 2 PLOT 117 NUSIBA"},
		{"Address2", c.Address2, "TOWERS MABUSHI ABUJA"},
		{"Address3", c.Address3, ""},
		{"Country", c.Country, "NIGERIA"},
		{"Phone", c.Phone, "8060777721"},
		{"Email", c.Email, "amelahsanda@yahoo.com"},
		{"State", c.State, "FCT"},
		{"City", c.City, "ABUJA"},
		{"Cell", c.Cell, "8060777721"},
	} {
		if tc.got != tc.want {
			t.Errorf("%s = %q, want %q", tc.field, tc.got, tc.want)
		}
	}
	if got, want := c.FullName(), "JAMELAH SANDA"; got != want {
		t.Errorf("FullName = %q, want %q", got, want)
	}
	if got, want := c.FullAddress(), "7TH FLOOR SUIT 2 PLOT 117 NUSIBA, TOWERS MABUSHI ABUJA"; got != want {
		t.Errorf("FullAddress = %q, want %q", got, want)
	}
}

// The files are unquoted CSV, so an address containing a comma widens the row. Reading
// by fixed index would shift the tail and write the city into the state column; the
// tail-anchored parser must keep every identity field correct.
func TestParseLineExtraCommaInAddress(t *testing.T) {
	const line = `ADA,OKONKWO,12 BROAD ST,APT 4,LAGOS ISLAND,EXTRA BIT,NIGERIA,8011112222,ada@example.com,LAGOS,IKEJA,8011112222,00012345`

	c, err := ParseLine(line)
	if err != nil {
		t.Fatalf("ParseLine: %v", err)
	}
	if c.CIF != "00012345" {
		t.Errorf("CIF = %q, want 00012345", c.CIF)
	}
	if c.State != "LAGOS" {
		t.Errorf("State = %q, want LAGOS — tail anchoring failed", c.State)
	}
	if c.City != "IKEJA" {
		t.Errorf("City = %q, want IKEJA", c.City)
	}
	if c.Email != "ada@example.com" {
		t.Errorf("Email = %q, want ada@example.com", c.Email)
	}
	// The overflow segment must land in the address, not be dropped.
	if got, want := c.Address3, "LAGOS ISLAND, EXTRA BIT"; got != want {
		t.Errorf("Address3 = %q, want %q", got, want)
	}
}

func TestParseLineRejects(t *testing.T) {
	for name, line := range map[string]string{
		"too few fields":  `ADA,OKONKWO,12 BROAD ST,LAGOS,00012345`,
		"non-numeric CIF": `ADA,OKONKWO,12 BROAD ST,APT 4,,NIGERIA,801,a@b.com,LAGOS,IKEJA,801,NOTACIF`,
		"empty CIF":       `ADA,OKONKWO,12 BROAD ST,APT 4,,NIGERIA,801,a@b.com,LAGOS,IKEJA,801,`,
	} {
		if _, err := ParseLine(line); err == nil {
			t.Errorf("%s: expected an error, got none", name)
		}
	}
}

func TestEmailLooksMalformed(t *testing.T) {
	for _, tc := range []struct {
		email string
		want  bool
	}{
		{"", false}, // absent is not malformed
		{"a@b.com", false},
		{"noatsign", true},
		{"@leading.com", true},
		{"trailing@", true},
		{"no@domaindot", true},
	} {
		if got := (Customer{Email: tc.email}).EmailLooksMalformed(); got != tc.want {
			t.Errorf("EmailLooksMalformed(%q) = %v, want %v", tc.email, got, tc.want)
		}
	}
}

// The filename date is DDMMYYYY. Reading it as YYYYMMDD would mis-order a year of
// drops, so ordering is asserted explicitly.
func TestParseFileNameAndOrdering(t *testing.T) {
	m, err := ParseFileName(`C:\feed\cust_file\cust_file.09042026.65.csv`)
	if err != nil {
		t.Fatalf("ParseFileName: %v", err)
	}
	if want := time.Date(2026, 4, 9, 0, 0, 0, 0, time.UTC); !m.Date.Equal(want) {
		t.Errorf("Date = %v, want %v", m.Date, want)
	}
	if m.Seq != 65 {
		t.Errorf("Seq = %d, want 65", m.Seq)
	}

	apr9, _ := ParseFileName("cust_file.09042026.65.csv")
	apr30, _ := ParseFileName("cust_file.30042026.2.csv")
	if !apr9.Less(apr30) {
		t.Error("09/04 should sort before 30/04 — DDMMYYYY parsed as YYYYMMDD?")
	}

	seq2, _ := ParseFileName("cust_file.09042026.2.csv")
	seq10, _ := ParseFileName("cust_file.09042026.10.csv")
	if !seq2.Less(seq10) {
		t.Error("seq 2 should sort before seq 10 — sequence compared as text?")
	}

	if _, err := ParseFileName("acct_file.09042026.65.csv"); err == nil {
		t.Error("expected a non-customer stream to be rejected")
	}
}
