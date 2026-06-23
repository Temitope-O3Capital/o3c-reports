package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// ── Zoho Desk config ──────────────────────────────────────────────────────────

var (
	zohoClientID     = os.Getenv("ZOHO_CLIENT_ID")
	zohoClientSecret = os.Getenv("ZOHO_CLIENT_SECRET")
	zohoRefreshTok   = os.Getenv("ZOHO_REFRESH_TOKEN")
	zohoOrgID        = os.Getenv("ZOHO_ORG_ID")
	// ZOHO_DC: com (US default) | eu | in | com.au | jp | ca
	zohoDC = coalesce(os.Getenv("ZOHO_DC"), "com")
)

func zohoConfigured() bool {
	return zohoClientID != "" && zohoClientSecret != "" && zohoRefreshTok != "" && zohoOrgID != ""
}

// ── OAuth2 token manager ──────────────────────────────────────────────────────

var zohoTok struct {
	sync.Mutex
	access  string
	expires time.Time
}

func zohoAccessToken(ctx context.Context) (string, error) {
	if !zohoConfigured() {
		return "", fmt.Errorf("zoho credentials are not fully configured")
	}
	zohoTok.Lock()
	defer zohoTok.Unlock()
	if zohoTok.access != "" && time.Now().Add(60*time.Second).Before(zohoTok.expires) {
		return zohoTok.access, nil
	}

	tokenURL := "https://accounts.zoho." + zohoDC + "/oauth/v2/token"
	body := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {zohoClientID},
		"client_secret": {zohoClientSecret},
		"refresh_token": {zohoRefreshTok},
	}.Encode()

	resp, err := httpPost(tokenURL, "application/x-www-form-urlencoded", "", []byte(body), 15*time.Second)
	if err != nil {
		return "", fmt.Errorf("zoho token request: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.Unmarshal(raw, &tok); err != nil {
		return "", fmt.Errorf("zoho token decode: %w", err)
	}
	if tok.Error != "" {
		return "", fmt.Errorf("zoho oauth error: %s — %s", tok.Error, tok.ErrorDesc)
	}

	zohoTok.access = tok.AccessToken
	secs := tok.ExpiresIn
	if secs == 0 {
		secs = 3600
	}
	zohoTok.expires = time.Now().Add(time.Duration(secs) * time.Second)
	return zohoTok.access, nil
}

// ── Zoho HTTP helpers ─────────────────────────────────────────────────────────

var zohoHTTP = &http.Client{Timeout: 20 * time.Second}

func zohoFetch(ctx context.Context, path string, params url.Values) (map[string]any, error) {
	token, err := zohoAccessToken(ctx)
	if err != nil {
		return nil, err
	}
	reqURL := "https://desk.zoho." + zohoDC + "/api/v1/" + path
	if len(params) > 0 {
		reqURL += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Zoho-oauthtoken "+token)
	req.Header.Set("orgId", zohoOrgID)

	resp, err := zohoHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("zoho api %s: %s", resp.Status, strings.TrimSpace(string(raw)))
	}
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result) //nolint:errcheck
	return result, nil
}

// zohoItems extracts the "data" array from a Zoho list response.
func zohoItems(result map[string]any) []map[string]any {
	raw, _ := result["data"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// zohoFetchTickets paginates through tickets (desc by createdTime) until
// maxTickets are collected or tickets pass the dateFrom boundary.
func zohoFetchTickets(ctx context.Context, dateFrom, dateTo time.Time, extra url.Values, maxTickets int) ([]map[string]any, error) {
	var all []map[string]any
	offset := 0
	for {
		params := url.Values{
			"from":      {strconv.Itoa(offset)},
			"limit":     {"100"},
			"sortBy":    {"createdTime"},
			"sortOrder": {"desc"},
		}
		for k, vs := range extra {
			params[k] = vs
		}
		result, err := zohoFetch(ctx, "tickets", params)
		if err != nil {
			return all, err
		}
		batch := zohoItems(result)
		if len(batch) == 0 {
			break
		}

		for _, t := range batch {
			created := zohoParseTime(t["createdTime"])
			if !dateFrom.IsZero() && created.Before(dateFrom) {
				return all, nil // passed the range boundary
			}
			if !dateTo.IsZero() && created.After(dateTo) {
				continue
			}
			all = append(all, t)
		}

		if len(all) >= maxTickets || len(batch) < 100 {
			break
		}
		offset += 100
	}
	return all, nil
}

func zohoParseTime(v any) time.Time {
	s, _ := v.(string)
	if s == "" {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

func zohoStr(v any) string { s, _ := v.(string); return s }

// ── Register ──────────────────────────────────────────────────────────────────

func RegisterCallCenter(r chi.Router, db *core.DB) {
	access := core.RequirePages("call_center")
	r.With(access).Get("/summary", ccSummary(db))
	r.With(access).Get("/tickets", ccTickets(db))
	r.With(access).Get("/agents", ccAgents(db))
	r.With(access).Get("/by-channel", ccByChannel(db))
}

// ── Summary ───────────────────────────────────────────────────────────────────

func ccSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !zohoEnsureConfigured(r.Context(), db) {
			json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
				"data_source": "zoho_desk", "configured": false,
				"message": "Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID",
			})
			return
		}

		dateTo := time.Now().UTC().Truncate(24 * time.Hour).Add(24*time.Hour - time.Second)
		dateFrom := dateTo.AddDate(0, 0, -29).Truncate(24 * time.Hour)
		if v := qstr(r, "date_from"); v != "" {
			if t, err := time.Parse("2006-01-02", v); err == nil {
				dateFrom = t
			}
		}
		if v := qstr(r, "date_to"); v != "" {
			if t, err := time.Parse("2006-01-02", v); err == nil {
				dateTo = t.Add(24*time.Hour - time.Second)
			}
		}

		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()

		type ticketRes struct {
			data []map[string]any
			err  error
		}
		type agentRes struct {
			data []map[string]any
			err  error
		}
		tCh := make(chan ticketRes, 1)
		aCh := make(chan agentRes, 1)

		go func() {
			data, err := zohoFetchTickets(ctx, dateFrom, dateTo, nil, 500)
			tCh <- ticketRes{data, err}
		}()
		go func() {
			res, err := zohoFetch(ctx, "agents", url.Values{"limit": {"100"}})
			var data []map[string]any
			if err == nil {
				data = zohoItems(res)
			}
			aCh <- agentRes{data, err}
		}()

		tr := <-tCh
		ar := <-aCh

		agentNames := map[string]string{}
		for _, a := range ar.data {
			if id := zohoStr(a["id"]); id != "" {
				agentNames[id] = zohoStr(a["name"])
			}
		}

		byStatus := map[string]int{}
		byChannel := map[string]int{}
		byAgent := map[string]int{}
		overdue := 0
		var sumFirstResp float64
		nFirstResp := 0
		var sumResolution float64
		nResolution := 0

		for _, t := range tr.data {
			status := coalesce(zohoStr(t["status"]), "Unknown")
			byStatus[status]++

			ch := coalesce(zohoStr(t["channel"]), "Unknown")
			byChannel[ch]++

			if id := zohoStr(t["assigneeId"]); id != "" {
				byAgent[id]++
			}
			if b, _ := t["isOverDue"].(bool); b {
				overdue++
			}

			// Zoho returns customerResponseTime in milliseconds (first response duration)
			if v := t["customerResponseTime"]; v != nil {
				if ms, err := strconv.ParseFloat(fmt.Sprintf("%v", v), 64); err == nil && ms > 0 {
					sumFirstResp += ms / 60000 // ms → minutes
					nFirstResp++
				}
			}

			// Resolution time from created → closed
			if status == "Closed" || status == "Resolved" {
				created := zohoParseTime(t["createdTime"])
				closed := zohoParseTime(t["closedTime"])
				if !created.IsZero() && !closed.IsZero() && closed.After(created) {
					sumResolution += closed.Sub(created).Hours()
					nResolution++
				}
			}
		}

		type agentRow struct {
			ID    string `json:"id"`
			Name  string `json:"name"`
			Count int    `json:"ticket_count"`
		}
		var agentList []agentRow
		for id, n := range byAgent {
			name := agentNames[id]
			if name == "" {
				name = id
			}
			agentList = append(agentList, agentRow{id, name, n})
		}
		for i := 0; i < len(agentList); i++ {
			for j := i + 1; j < len(agentList); j++ {
				if agentList[j].Count > agentList[i].Count {
					agentList[i], agentList[j] = agentList[j], agentList[i]
				}
			}
		}

		avgFirst, avgResolve, overduePct := 0.0, 0.0, 0.0
		if nFirstResp > 0 {
			avgFirst = math.Round(sumFirstResp/float64(nFirstResp)*10) / 10
		}
		if nResolution > 0 {
			avgResolve = math.Round(sumResolution/float64(nResolution)*10) / 10
		}
		if total := len(tr.data); total > 0 {
			overduePct = math.Round(float64(overdue)/float64(total)*1000) / 10
		}

		errStr := ""
		if tr.err != nil {
			errStr = tr.err.Error()
		}

		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data_source": "zoho_desk",
			"configured":  true,
			"period":      map[string]string{"from": dateFrom.Format("2006-01-02"), "to": dateTo.Format("2006-01-02")},
			"totals": map[string]any{
				"tickets": len(tr.data),
				"overdue": overdue,
				"note":    "Based on up to 500 most recent tickets in period",
			},
			"by_status":  byStatus,
			"by_channel": byChannel,
			"sla": map[string]any{
				"avg_first_response_mins": avgFirst,
				"avg_resolution_hrs":      avgResolve,
				"overdue_pct":             overduePct,
				"overdue_count":           overdue,
			},
			"agents": agentList,
			"error":  errStr,
		})
	}
}

// ── Tickets list ──────────────────────────────────────────────────────────────

func ccTickets(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !zohoEnsureConfigured(r.Context(), db) {
			respondErr(w, 503, "Zoho Desk not configured")
			return
		}

		params := url.Values{
			"from":      {coalesce(qstr(r, "page_from"), "0")},
			"limit":     {coalesce(qstr(r, "limit"), "50")},
			"sortBy":    {"createdTime"},
			"sortOrder": {"desc"},
		}
		for _, k := range []string{"status", "channel", "assigneeId", "priority"} {
			if v := qstr(r, k); v != "" {
				params.Set(k, v)
			}
		}

		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()

		result, err := zohoFetch(ctx, "tickets", params)
		if err != nil {
			respondErr(w, 502, "Zoho API error: "+err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data_source": "zoho_desk",
			"data":        zohoItems(result),
		})
	}
}

// ── Agents ────────────────────────────────────────────────────────────────────

func ccAgents(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !zohoEnsureConfigured(r.Context(), db) {
			respondErr(w, 503, "Zoho Desk not configured")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()

		type res struct {
			data map[string]any
			err  error
		}
		aCh := make(chan res, 1)
		oCh := make(chan res, 1)
		rCh := make(chan res, 1)

		go func() {
			d, e := zohoFetch(ctx, "agents", url.Values{"limit": {"100"}})
			aCh <- res{d, e}
		}()
		go func() {
			d, e := zohoFetch(ctx, "tickets", url.Values{"status": {"Open"}, "limit": {"100"}})
			oCh <- res{d, e}
		}()
		go func() {
			d, e := zohoFetch(ctx, "tickets", url.Values{"status": {"Resolved"}, "limit": {"100"}})
			rCh <- res{d, e}
		}()

		ar, or_, rr := <-aCh, <-oCh, <-rCh
		if ar.err != nil {
			respondErr(w, 502, "Zoho API error: "+ar.err.Error())
			return
		}

		openByAgent := map[string]int{}
		for _, t := range zohoItems(or_.data) {
			if id := zohoStr(t["assigneeId"]); id != "" {
				openByAgent[id]++
			}
		}

		today := time.Now().UTC().Truncate(24 * time.Hour)
		resolvedTodayByAgent := map[string]int{}
		for _, t := range zohoItems(rr.data) {
			if closed := zohoParseTime(t["closedTime"]); closed.After(today) {
				if id := zohoStr(t["assigneeId"]); id != "" {
					resolvedTodayByAgent[id]++
				}
			}
		}

		agents := zohoItems(ar.data)
		for i, a := range agents {
			id := zohoStr(a["id"])
			agents[i]["open_tickets"] = openByAgent[id]
			agents[i]["resolved_today"] = resolvedTodayByAgent[id]
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data_source": "zoho_desk",
			"data":        agents,
		})
	}
}

// ── Channel breakdown ─────────────────────────────────────────────────────────

func ccByChannel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !zohoEnsureConfigured(r.Context(), db) {
			respondErr(w, 503, "Zoho Desk not configured")
			return
		}

		dateTo := time.Now().UTC().Truncate(24 * time.Hour).Add(24*time.Hour - time.Second)
		dateFrom := dateTo.AddDate(0, 0, -29).Truncate(24 * time.Hour)
		if v := qstr(r, "date_from"); v != "" {
			if t, err := time.Parse("2006-01-02", v); err == nil {
				dateFrom = t
			}
		}
		if v := qstr(r, "date_to"); v != "" {
			if t, err := time.Parse("2006-01-02", v); err == nil {
				dateTo = t.Add(24*time.Hour - time.Second)
			}
		}

		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()

		tickets, err := zohoFetchTickets(ctx, dateFrom, dateTo, nil, 500)
		if err != nil {
			respondErr(w, 502, "Zoho API error: "+err.Error())
			return
		}

		type row struct {
			Channel  string `json:"channel"`
			Total    int    `json:"total"`
			Open     int    `json:"open"`
			Resolved int    `json:"resolved"`
		}
		m := map[string]*row{}
		for _, t := range tickets {
			ch := coalesce(zohoStr(t["channel"]), "Unknown")
			if _, ok := m[ch]; !ok {
				m[ch] = &row{Channel: ch}
			}
			m[ch].Total++
			switch zohoStr(t["status"]) {
			case "Open", "Pending", "On Hold", "Escalated":
				m[ch].Open++
			case "Resolved", "Closed":
				m[ch].Resolved++
			}
		}

		var out []row
		for _, r := range m {
			out = append(out, *r)
		}
		for i := 0; i < len(out); i++ {
			for j := i + 1; j < len(out); j++ {
				if out[j].Total > out[i].Total {
					out[i], out[j] = out[j], out[i]
				}
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data_source": "zoho_desk",
			"period":      map[string]string{"from": dateFrom.Format("2006-01-02"), "to": dateTo.Format("2006-01-02")},
			"data":        out,
		})
	}
}
