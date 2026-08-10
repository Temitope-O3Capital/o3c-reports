// Package custfeed ingests the 15-minute `cust_file` drops into app.customers.
//
// Customers are not created in Udara — Udara holds only the loan and FD books. New
// customers appear in the feed folder (docs/DATA_FEED_INGESTION.md §3.1), and until
// this package existed nothing read it, which is why app.customers was frozen at the
// 2025-07-09 mssql_baseline snapshot and acquisition appeared to have collapsed.
package custfeed

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Customer is one decoded feed row.
type Customer struct {
	CIF       string
	FirstName string
	LastName  string
	Address1  string
	Address2  string
	Address3  string
	Country   string
	Phone     string
	Email     string
	State     string
	City      string
	Cell      string
}

// FullName is the display name, collapsing the blank-half case rather than emitting a
// stray space.
func (c Customer) FullName() string {
	return strings.TrimSpace(c.FirstName + " " + c.LastName)
}

// FullAddress joins the populated address lines. Feed rows routinely leave line 3
// empty, so blanks are dropped rather than producing "A, , B".
func (c Customer) FullAddress() string {
	parts := make([]string, 0, 3)
	for _, p := range []string{c.Address1, c.Address2, c.Address3} {
		if p = strings.TrimSpace(p); p != "" {
			parts = append(parts, p)
		}
	}
	return strings.Join(parts, ", ")
}

// EmailLooksMalformed reports whether a non-empty email is obviously unusable. Feeds
// this old carry a lot of junk; the flag is recorded rather than the row rejected,
// because a customer with a bad email is still a customer.
func (c Customer) EmailLooksMalformed() bool {
	e := strings.TrimSpace(c.Email)
	if e == "" {
		return false
	}
	at := strings.Index(e, "@")
	return at <= 0 || at == len(e)-1 || !strings.Contains(e[at:], ".")
}

// fieldCount is the documented width of a cust_file row.
const fieldCount = 12

var cifRe = regexp.MustCompile(`^\d{4,12}$`)

// ParseLine decodes one headerless cust_file row.
//
// The documented layout is:
//
//	first, last, addr1, addr2, addr3, country, phone, email, state, city, cell, CIF
//
// Fields are read from BOTH ENDS rather than by fixed index. The files are comma
// delimited with no quoting, so a comma inside a value — which in practice only ever
// happens in an address — would shift every later field and silently write a city into
// the state column. Name is anchored at the head, contact details and CIF at the tail,
// and whatever remains in the middle is address. A row with exactly 12 fields decodes
// identically either way; a row with 13 keeps its phone, state, city and CIF correct
// and merely gains an extra address line.
func ParseLine(line string) (Customer, error) {
	f := strings.Split(line, ",")
	if len(f) < fieldCount {
		return Customer{}, fmt.Errorf("want at least %d fields, got %d", fieldCount, len(f))
	}
	for i := range f {
		f[i] = strings.TrimSpace(f[i])
	}
	n := len(f)

	c := Customer{
		FirstName: f[0],
		LastName:  f[1],
		CIF:       f[n-1],
		Cell:      f[n-2],
		City:      f[n-3],
		State:     f[n-4],
		Email:     f[n-5],
		Phone:     f[n-6],
		Country:   f[n-7],
	}

	// Everything between the name and the country block is address.
	addr := f[2 : n-7]
	if len(addr) > 0 {
		c.Address1 = addr[0]
	}
	if len(addr) > 1 {
		c.Address2 = addr[1]
	}
	if len(addr) > 2 {
		// Fold any overflow from stray commas back into the last line so nothing is
		// dropped on the floor.
		c.Address3 = strings.Join(addr[2:], ", ")
	}

	if !cifRe.MatchString(c.CIF) {
		return Customer{}, fmt.Errorf("field %d is not a CIF: %q", n, c.CIF)
	}
	return c, nil
}

// FileMeta is the date and sequence encoded in a feed filename.
type FileMeta struct {
	Name string
	Date time.Time
	Seq  int
}

// nameRe matches `cust_file.DDMMYYYY.SEQ.csv`.
var nameRe = regexp.MustCompile(`^cust_file\.(\d{8})\.(\d+)\.csv$`)

// ParseFileName pulls the date and sequence out of a feed filename so files can be
// applied in the order they were produced. The date is DDMMYYYY, not the ISO order —
// reading it as YYYYMMDD would silently sort a year's worth of files wrongly.
func ParseFileName(path string) (FileMeta, error) {
	base := filepath.Base(path)
	m := nameRe.FindStringSubmatch(base)
	if m == nil {
		return FileMeta{}, fmt.Errorf("unrecognised feed filename: %s", base)
	}
	d, err := time.Parse("02012006", m[1])
	if err != nil {
		return FileMeta{}, fmt.Errorf("bad date in %s: %w", base, err)
	}
	seq, err := strconv.Atoi(m[2])
	if err != nil {
		return FileMeta{}, fmt.Errorf("bad sequence in %s: %w", base, err)
	}
	return FileMeta{Name: base, Date: d, Seq: seq}, nil
}

// Less orders two feed files chronologically: by drop date, then by sequence within
// the day. Later files must be applied last so their values win the upsert.
func (a FileMeta) Less(b FileMeta) bool {
	if !a.Date.Equal(b.Date) {
		return a.Date.Before(b.Date)
	}
	return a.Seq < b.Seq
}
