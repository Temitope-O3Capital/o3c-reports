// Package appsflyer is a read-only client for the AppsFlyer Aggregate Pull API.
//
// It pulls the partners_by_date_report (installs, sessions, spend, revenue and the
// in-app event funnel, broken down by media source × campaign × date) for the
// "Blink by O3" apps and parses the CSV into typed rows. The API is outbound-only
// — we poll AppsFlyer; nothing is ever exposed inbound, and nothing is ever written
// back to AppsFlyer.
//
// Auth is an account-level API V2 bearer token (from the AppsFlyer Security Center,
// NOT the SDK dev key). The report endpoint answers 200 with a CSV body, having
// first 302-redirected to a signed download URL; Go's http.Client follows that
// automatically.
package appsflyer

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// apiBase is the AppsFlyer HQ host. The report path embeds the app id.
const apiBase = "https://hq1.appsflyer.com"

// Default app ids for "Blink by O3" (seller: O3 CAPITAL NIGERIA LIMITED),
// confirmed live 2026-09-02. Overridable via env so a rebrand/relaunch needs no
// code change.
const (
	DefaultIOSAppID     = "id6768255303"      // App Store id 6768255303
	DefaultAndroidAppID = "com.o3cards.blink" // Play package
)

// App is one platform target to pull.
type App struct {
	AppID    string // "id6768255303" or "com.o3cards.blink"
	Platform string // "ios" | "android"
}

// Client talks to the Aggregate Pull API. A zero token yields IsConfigured()==false
// so the rest of the app boots and idles cleanly until a token is supplied.
type Client struct {
	token string
	hc    *http.Client
}

// New builds a client. Pass an empty token to get an inert (unconfigured) client.
func New(token string) *Client {
	return &Client{
		token: strings.TrimSpace(token),
		// 90s: the O3 network's SSL-inspection path adds latency, and a wide date
		// window can return a sizeable CSV after the signed-URL redirect.
		hc: &http.Client{Timeout: 90 * time.Second},
	}
}

// IsConfigured reports whether a token was provided.
func (c *Client) IsConfigured() bool { return c.token != "" }

// Event is one in-app event's figures for a report row.
type Event struct {
	Name        string
	UniqueUsers int64
	EventCount  int64
	SalesUSD    float64
}

// Row is one parsed line of a by-date report: a single
// date × [country] × media source × campaign × agency combination.
type Row struct {
	Date        string // YYYY-MM-DD, as reported (AppsFlyer app timezone)
	Country     string // ISO alpha-2, only present in geo reports (else "")
	Agency      string // af_prt
	MediaSource string // pid
	Campaign    string // c
	Impressions int64
	Clicks      int64
	Installs    int64
	Sessions    int64
	LoyalUsers  int64
	CostUSD     float64
	RevenueUSD  float64
	Events      []Event
	Raw         map[string]string // full row keyed by CSV header
}

// eventColRE matches an event sub-column header, e.g.
// "registration_start (Unique users)" → name "registration_start", metric "Unique users".
var eventColRE = regexp.MustCompile(`^(.+) \((Unique users|Event counter|Sales in USD)\)$`)

// FetchPartnersByDate pulls the partners_by_date_report (date × source × campaign).
func (c *Client) FetchPartnersByDate(ctx context.Context, appID, from, to string) ([]Row, error) {
	return c.fetchReport(ctx, appID, "partners_by_date_report", from, to)
}

// FetchGeoByDate pulls the geo_by_date_report (adds a Country column).
func (c *Client) FetchGeoByDate(ctx context.Context, appID, from, to string) ([]Row, error) {
	return c.fetchReport(ctx, appID, "geo_by_date_report", from, to)
}

// fetchReport pulls and parses one aggregate by-date report for an app over
// [from, to] (inclusive, YYYY-MM-DD, max 90 days per the API). A non-200 response is
// surfaced with a trimmed body for diagnosis.
func (c *Client) fetchReport(ctx context.Context, appID, report, from, to string) ([]Row, error) {
	if !c.IsConfigured() {
		return nil, fmt.Errorf("appsflyer: API token not configured")
	}
	url := fmt.Sprintf("%s/api/agg-data/export/app/%s/%s/v5?from=%s&to=%s",
		apiBase, appID, report, from, to)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("appsflyer: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("accept", "text/csv")

	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("appsflyer %s: %w", appID, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		snippet := strings.TrimSpace(string(body))
		switch resp.StatusCode {
		case http.StatusUnauthorized:
			return nil, fmt.Errorf("appsflyer %s: HTTP 401 — token invalid or expired (regenerate in Security Center)", appID)
		case http.StatusNotFound:
			return nil, fmt.Errorf("appsflyer %s: HTTP 404 — app id not found for this account", appID)
		case http.StatusTooManyRequests:
			return nil, fmt.Errorf("appsflyer %s: HTTP 429 — rate limited; widen APPSFLYER_SYNC_INTERVAL", appID)
		default:
			return nil, fmt.Errorf("appsflyer %s: HTTP %d: %s", appID, resp.StatusCode, snippet)
		}
	}
	return parseReport(resp.Body)
}

// parseReport turns the CSV stream into typed rows, discovering the event columns
// from the header so a per-app event set of any shape parses without code changes.
func parseReport(r io.Reader) ([]Row, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1 // tolerate trailing/short rows rather than erroring the whole pull
	cr.TrimLeadingSpace = true

	header, err := cr.Read()
	if err == io.EOF {
		return nil, nil // empty report (no data in window) is not an error
	}
	if err != nil {
		return nil, fmt.Errorf("appsflyer: read header: %w", err)
	}

	// Index fixed columns by exact header name; collect event sub-columns.
	idx := map[string]int{}
	for i, h := range header {
		idx[strings.TrimSpace(h)] = i
	}
	type evCols struct{ uu, ec, su int }
	events := map[string]*evCols{}
	var eventOrder []string
	for i, h := range header {
		m := eventColRE.FindStringSubmatch(strings.TrimSpace(h))
		if m == nil {
			continue
		}
		name, metric := m[1], m[2]
		ec, ok := events[name]
		if !ok {
			ec = &evCols{uu: -1, ec: -1, su: -1}
			events[name] = ec
			eventOrder = append(eventOrder, name)
		}
		switch metric {
		case "Unique users":
			ec.uu = i
		case "Event counter":
			ec.ec = i
		case "Sales in USD":
			ec.su = i
		}
	}

	at := func(rec []string, i int) string {
		if i < 0 || i >= len(rec) {
			return ""
		}
		return strings.TrimSpace(rec[i])
	}
	// colIdx returns the column index for a header, or -1 when it is absent — so an
	// optional column (e.g. Country, only in geo reports) is not confused with index 0.
	colIdx := func(name string) int {
		if i, ok := idx[name]; ok {
			return i
		}
		return -1
	}

	var rows []Row
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("appsflyer: read row: %w", err)
		}

		raw := make(map[string]string, len(header))
		for h, i := range idx {
			raw[h] = at(rec, i)
		}

		row := Row{
			Date:        at(rec, idx["Date"]),
			Country:     at(rec, colIdx("Country")),
			Agency:      at(rec, idx["Agency/PMD (af_prt)"]),
			MediaSource: at(rec, idx["Media Source (pid)"]),
			Campaign:    at(rec, idx["Campaign (c)"]),
			Impressions: pInt(at(rec, idx["Impressions"])),
			Clicks:      pInt(at(rec, idx["Clicks"])),
			Installs:    pInt(at(rec, idx["Installs"])),
			Sessions:    pInt(at(rec, idx["Sessions"])),
			LoyalUsers:  pInt(at(rec, idx["Loyal Users"])),
			CostUSD:     pFloat(at(rec, idx["Total Cost"])),
			RevenueUSD:  pFloat(at(rec, idx["Total Revenue"])),
			Raw:         raw,
		}
		if row.Date == "" {
			continue // skip any total/blank line without a date
		}
		for _, name := range eventOrder {
			ec := events[name]
			ev := Event{
				Name:        name,
				UniqueUsers: pInt(at(rec, ec.uu)),
				EventCount:  pInt(at(rec, ec.ec)),
				SalesUSD:    pFloat(at(rec, ec.su)),
			}
			// Keep only events that actually fired for this row, to avoid a flood
			// of all-zero rows across every event × day × source combination.
			if ev.UniqueUsers != 0 || ev.EventCount != 0 || ev.SalesUSD != 0 {
				row.Events = append(row.Events, ev)
			}
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// pInt parses an AppsFlyer integer cell. "N/A", "", "-" and unparseable → 0.
func pInt(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" || s == "N/A" || s == "-" {
		return 0
	}
	// Some counts arrive as floats ("3.0"); take the integer part.
	if f, err := strconv.ParseFloat(strings.ReplaceAll(s, ",", ""), 64); err == nil {
		return int64(f)
	}
	return 0
}

// pFloat parses an AppsFlyer numeric cell. "N/A", "", "-" and unparseable → 0.
func pFloat(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" || s == "N/A" || s == "-" {
		return 0
	}
	if f, err := strconv.ParseFloat(strings.ReplaceAll(s, ",", ""), 64); err == nil {
		return f
	}
	return 0
}
