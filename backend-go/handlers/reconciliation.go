package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// ── Paystack config ───────────────────────────────────────────────────────────

var paystackBase = coalesce(os.Getenv("PAYSTACK_BASE_URL"), "https://api.paystack.co")

// resolvePaystackKey returns the live secret key: env var first, then DB-stored credential.
func resolvePaystackKey(ctx context.Context, db *core.DB) string {
	if k := os.Getenv("PAYSTACK_SECRET_KEY"); k != "" {
		return k
	}
	rows, err := db.PGQuery(ctx,
		`SELECT encrypted_value FROM api_credentials WHERE key_name='PAYSTACK_SECRET_KEY'`)
	if err != nil || len(rows) == 0 {
		return ""
	}
	enc, _ := rows[0]["encrypted_value"].(string)
	if enc == "" {
		return ""
	}
	plain, err := decryptValue(enc)
	if err != nil {
		return ""
	}
	return plain
}

var paystackHTTP = &http.Client{Timeout: 20 * time.Second}

func paystackFetch(ctx context.Context, db *core.DB, path string, params url.Values) (map[string]any, error) {
	key := resolvePaystackKey(ctx, db)
	if key == "" {
		return nil, fmt.Errorf("Paystack secret key not configured")
	}
	reqURL := paystackBase + path
	if len(params) > 0 {
		reqURL += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")

	resp, err := paystackHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result) //nolint:errcheck
	return result, nil
}

// ── Interswitch config ────────────────────────────────────────────────────────
// Auth: Interswitch Passport — OAuth2 client_credentials grant.
// Required env vars:
//   INTERSWITCH_CLIENT_ID
//   INTERSWITCH_CLIENT_SECRET
//   INTERSWITCH_PASSPORT_URL   (default: https://passport.interswitch.com/passport/oauth/token)
//   INTERSWITCH_BASE_URL       (base URL for transaction API calls)

var (
	iswClientID     = os.Getenv("INTERSWITCH_CLIENT_ID")
	iswClientSecret = os.Getenv("INTERSWITCH_CLIENT_SECRET")
	iswPassportURL  = coalesce(os.Getenv("INTERSWITCH_PASSPORT_URL"),
		"https://passport.interswitch.com/passport/oauth/token")
	iswBaseURL = os.Getenv("INTERSWITCH_BASE_URL")
)

func iswConfigured() bool { return iswClientID != "" && iswClientSecret != "" && iswBaseURL != "" }

var iswTok struct {
	sync.Mutex
	access  string
	expires time.Time
}

func iswAccessToken(ctx context.Context) (string, error) {
	iswTok.Lock()
	defer iswTok.Unlock()
	if iswTok.access != "" && time.Now().Add(60*time.Second).Before(iswTok.expires) {
		return iswTok.access, nil
	}

	// Interswitch Passport: Basic auth with client credentials, client_credentials grant
	body := url.Values{"grant_type": {"client_credentials"}, "scope": {"profile"}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, iswPassportURL,
		strings.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(iswClientID, iswClientSecret)

	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("interswitch passport: %w", err)
	}
	defer resp.Body.Close()

	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil {
		return "", fmt.Errorf("interswitch token decode: %w", err)
	}
	if tok.Error != "" || tok.AccessToken == "" {
		return "", fmt.Errorf("interswitch token error: %s", tok.Error)
	}

	iswTok.access = tok.AccessToken
	secs := tok.ExpiresIn
	if secs == 0 {
		secs = 3600
	}
	iswTok.expires = time.Now().Add(time.Duration(secs) * time.Second)
	return iswTok.access, nil
}

var iswHTTP = &http.Client{Timeout: 20 * time.Second}

func iswFetch(ctx context.Context, path string, params url.Values) (map[string]any, error) {
	token, err := iswAccessToken(ctx)
	if err != nil {
		return nil, err
	}
	reqURL := iswBaseURL + path
	if len(params) > 0 {
		reqURL += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := iswHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result map[string]any
	json.NewDecoder(resp.Body).Decode(&result) //nolint:errcheck
	return result, nil
}

// ── EOD comparison helper ─────────────────────────────────────────────────────

type eodTotals struct {
	TxnCount   int64   `json:"txn_count"`
	TotalDR    float64 `json:"total_dr"`
	TotalCR    float64 `json:"total_cr"`
	TotalVol   float64 `json:"total_volume"`
}

func eodTotalsForPeriod(ctx context.Context, db *core.DB, dateFrom, dateTo string) eodTotals {
	rows, err := db.PGQuery(ctx, `
		SELECT
			COUNT(*)                                              AS txn_count,
			COALESCE(SUM(CASE WHEN sign='DR' THEN amount END),0) AS total_dr,
			COALESCE(SUM(CASE WHEN sign='CR' THEN amount END),0) AS total_cr,
			COALESCE(SUM(amount),0)                              AS total_volume
		FROM eod_transactions
		WHERE txn_date >= $1::date AND txn_date <= $2::date`,
		dateFrom, dateTo)
	if err != nil || len(rows) == 0 {
		return eodTotals{}
	}
	r := rows[0]
	return eodTotals{
		TxnCount: toInt64(r["txn_count"]),
		TotalDR:  toFloat64(r["total_dr"]),
		TotalCR:  toFloat64(r["total_cr"]),
		TotalVol: toFloat64(r["total_volume"]),
	}
}

func toFloat64(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case float32:
		return float64(t)
	case int64:
		return float64(t)
	case int32:
		return float64(t)
	}
	return 0
}

// ── Paystack: Balance ─────────────────────────────────────────────────────────

func psReconBalance(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if resolvePaystackKey(r.Context(), db) == "" {
			respondErr(w, 503, "Paystack not configured")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		result, err := paystackFetch(ctx, db, "/balance", nil)
		if err != nil {
			respondErr(w, 502, "Paystack API error: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data_source": "paystack",
			"data":        result["data"],
		})
	}
}

// psProxy is a generic Paystack pass-through — fetches psPath with pagination
// params plus any extras returned by extraParams(r). extraParams may be nil.
func psProxy(db *core.DB, psPath string, extraParams func(*http.Request) url.Values) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if resolvePaystackKey(r.Context(), db) == "" {
			respondErr(w, 503, "Paystack not configured")
			return
		}
		params := url.Values{
			"perPage": {coalesce(qstr(r, "per_page"), "50")},
			"page":    {coalesce(qstr(r, "page"), "1")},
		}
		if extraParams != nil {
			for k, vs := range extraParams(r) {
				params[k] = vs
			}
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		result, err := paystackFetch(ctx, db, psPath, params)
		if err != nil {
			respondErr(w, 502, "Paystack API error: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data_source": "paystack",
			"data":        result["data"],
			"meta":        result["meta"],
		})
	}
}

// ── Register ──────────────────────────────────────────────────────────────────

func RegisterPaystackRecon(r chi.Router, db *core.DB) {
	access := core.RequirePages("reconciliation")
	r.With(access).Get("/summary",      psReconSummary(db))
	r.With(access).Get("/transactions", psReconTransactions(db))
	r.With(access).Get("/settlements",  psReconSettlements(db))
	r.With(access).Get("/balance",      psReconBalance(db))
	r.With(access).Get("/ledger",       psProxy(db, "/balance/ledger", nil))
	r.With(access).Get("/transfers",    psProxy(db, "/transfer", func(r *http.Request) url.Values {
		p := url.Values{}
		if v := qstr(r, "from"); v != "" { p.Set("from", v) }
		if v := qstr(r, "to");   v != "" { p.Set("to", v) }
		if v := qstr(r, "status"); v != "" { p.Set("status", v) }
		return p
	}))
	r.With(access).Get("/refunds",   psProxy(db, "/refund", nil))
	r.With(access).Get("/disputes",  psProxy(db, "/dispute", nil))
}

func RegisterInterspwitchRecon(r chi.Router, db *core.DB) {
	access := core.RequirePages("reconciliation")
	r.With(access).Get("/summary", iswReconSummary(db))
	r.With(access).Get("/transactions", iswReconTransactions())
}

// ── Paystack: Summary ─────────────────────────────────────────────────────────

func psReconSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if resolvePaystackKey(r.Context(), db) == "" {
			json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
				"data_source": "paystack", "configured": false,
				"message": "Set PAYSTACK_SECRET_KEY",
			})
			return
		}

		dateFrom := qstr(r, "date_from")
		dateTo   := qstr(r, "date_to")
		if dateFrom == "" || dateTo == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()

		// Fetch Paystack totals (first page + meta gives us total count)
		// Paystack date format: ISO 8601 with time
		psFrom := dateFrom + "T00:00:00.000Z"
		psTo   := dateTo + "T23:59:59.000Z"

		psResult, psErr := paystackFetch(ctx, db, "/transaction", url.Values{
			"from": {psFrom}, "to": {psTo},
			"perPage": {"100"}, "page": {"1"},
		})

		// EOD totals from our database
		eod := eodTotalsForPeriod(ctx, db, dateFrom, dateTo)

		type psSummary struct {
			Configured       bool    `json:"configured"`
			TotalCount       int64   `json:"total_count"`
			Success          int64   `json:"success"`
			Failed           int64   `json:"failed"`
			TotalVolumeKobo  float64 `json:"total_volume_kobo"`
			TotalVolumeNGN   float64 `json:"total_volume_ngn"`
			Error            string  `json:"error,omitempty"`
		}

		ps := psSummary{Configured: true}
		if psErr != nil {
			ps.Error = psErr.Error()
		} else if psResult != nil {
			if meta, ok := psResult["meta"].(map[string]any); ok {
				ps.TotalCount = toInt64(meta["total"])
				// meta.total_volume is the true sum across ALL pages for this filter period
				if tv := toFloat64(meta["total_volume"]); tv > 0 {
					ps.TotalVolumeKobo = tv
					ps.TotalVolumeNGN = math.Round(tv) / 100
				}
			}
			// Count status breakdown from first page (for success/failed KPIs)
			if data, ok := psResult["data"].([]any); ok {
				for _, item := range data {
					if t, ok := item.(map[string]any); ok {
						switch zohoStr(t["status"]) {
						case "success":
							ps.Success++
						case "failed":
							ps.Failed++
						}
					}
				}
			}
		}

		// Delta: EOD uses NGN amounts (not kobo), compare volumes
		volDelta := ps.TotalVolumeNGN - eod.TotalVol
		cntDelta := ps.TotalCount - eod.TxnCount

		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data_source": "paystack",
			"configured":  true,
			"fetched_at":  time.Now().UTC().Format(time.RFC3339),
			"period":      map[string]string{"from": dateFrom, "to": dateTo},
			"paystack":    ps,
			"eod": map[string]any{
				"txn_count":    eod.TxnCount,
				"total_dr_ngn": eod.TotalDR,
				"total_cr_ngn": eod.TotalCR,
				"total_vol_ngn": eod.TotalVol,
			},
			"delta": map[string]any{
				"txn_count_diff":  cntDelta,
				"volume_ngn_diff": math.Round(volDelta*100) / 100,
				"note":            "Paystack volume note: summary based on first page only — full volume requires all pages",
			},
		})
	}
}

// ── Paystack: Transactions ────────────────────────────────────────────────────

func psReconTransactions(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if resolvePaystackKey(r.Context(), db) == "" {
			respondErr(w, 503, "Paystack not configured — set PAYSTACK_SECRET_KEY")
			return
		}

		dateFrom := qstr(r, "date_from")
		dateTo   := qstr(r, "date_to")
		if dateFrom == "" || dateTo == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}

		params := url.Values{
			"from":    {dateFrom + "T00:00:00.000Z"},
			"to":      {dateTo + "T23:59:59.000Z"},
			"perPage": {coalesce(qstr(r, "per_page"), "100")},
			"page":    {coalesce(qstr(r, "page"), "1")},
		}
		if v := qstr(r, "status"); v != "" {
			params.Set("status", v) // success | failed | abandoned
		}

		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()

		result, err := paystackFetch(ctx, db, "/transaction", params)
		if err != nil {
			respondErr(w, 502, "Paystack API error: "+err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data_source": "paystack",
			"data":        result["data"],
			"meta":        result["meta"],
		})
	}
}

// ── Paystack: Settlements ─────────────────────────────────────────────────────

func psReconSettlements(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if resolvePaystackKey(r.Context(), db) == "" {
			respondErr(w, 503, "Paystack not configured — set PAYSTACK_SECRET_KEY")
			return
		}

		params := url.Values{
			"perPage": {coalesce(qstr(r, "per_page"), "50")},
			"page":    {coalesce(qstr(r, "page"), "1")},
		}
		if v := qstr(r, "from"); v != "" {
			params.Set("from", v)
		}
		if v := qstr(r, "to"); v != "" {
			params.Set("to", v)
		}

		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()

		result, err := paystackFetch(ctx, db, "/settlement", params)
		if err != nil {
			respondErr(w, 502, "Paystack API error: "+err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data_source": "paystack",
			"data":        result["data"],
			"meta":        result["meta"],
		})
	}
}

// ── Interswitch: Summary ──────────────────────────────────────────────────────

func iswReconSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !iswConfigured() {
			json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
				"data_source": "interswitch", "configured": false,
				"message": "Set INTERSWITCH_CLIENT_ID, INTERSWITCH_CLIENT_SECRET, INTERSWITCH_BASE_URL",
			})
			return
		}

		dateFrom := qstr(r, "date_from")
		dateTo   := qstr(r, "date_to")
		if dateFrom == "" || dateTo == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()

		// Interswitch transaction path is configurable; defaults use standard date params.
		// Operators configure INTERSWITCH_BASE_URL + the path to match their API product.
		txnPath := coalesce(os.Getenv("INTERSWITCH_TRANSACTION_PATH"), "/api/v3/transactions")
		iswResult, iswErr := iswFetch(ctx, txnPath, url.Values{
			"from":    {dateFrom},
			"to":      {dateTo},
			"perPage": {"100"},
			"page":    {"1"},
		})

		// EOD totals
		eod := eodTotalsForPeriod(ctx, db, dateFrom, dateTo)

		iswData := map[string]any{}
		errStr  := ""
		if iswErr != nil {
			errStr = iswErr.Error()
		} else if iswResult != nil {
			// Normalise response — Interswitch wraps differently per product
			iswData = iswResult
		}

		// Extract count from common Interswitch response patterns
		var iswCount int64
		var iswVolume float64
		for _, countKey := range []string{"count", "total", "totalCount", "total_count"} {
			if v, ok := iswData[countKey]; ok {
				iswCount = toInt64(v)
				break
			}
		}
		for _, volKey := range []string{"totalAmount", "total_amount", "volume", "totalVolume"} {
			if v, ok := iswData[volKey]; ok {
				iswVolume = toFloat64(v)
				break
			}
		}

		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data_source": "interswitch",
			"configured":  true,
			"fetched_at":  time.Now().UTC().Format(time.RFC3339),
			"period":      map[string]string{"from": dateFrom, "to": dateTo},
			"interswitch": map[string]any{
				"txn_count":    iswCount,
				"total_volume": iswVolume,
				"raw":          iswData,
				"error":        errStr,
			},
			"eod": map[string]any{
				"txn_count":     eod.TxnCount,
				"total_dr_ngn":  eod.TotalDR,
				"total_cr_ngn":  eod.TotalCR,
				"total_vol_ngn": eod.TotalVol,
			},
			"delta": map[string]any{
				"txn_count_diff":  iswCount - eod.TxnCount,
				"volume_diff":     math.Round((iswVolume-eod.TotalVol)*100) / 100,
			},
		})
	}
}

// ── Interswitch: Transactions ─────────────────────────────────────────────────

func iswReconTransactions() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !iswConfigured() {
			respondErr(w, 503, "Interswitch not configured")
			return
		}

		dateFrom := qstr(r, "date_from")
		dateTo   := qstr(r, "date_to")
		if dateFrom == "" || dateTo == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}

		txnPath := coalesce(os.Getenv("INTERSWITCH_TRANSACTION_PATH"), "/api/v3/transactions")
		params  := url.Values{
			"from":    {dateFrom},
			"to":      {dateTo},
			"perPage": {coalesce(qstr(r, "per_page"), "100")},
			"page":    {coalesce(qstr(r, "page"), "1")},
		}

		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()

		result, err := iswFetch(ctx, txnPath, params)
		if err != nil {
			respondErr(w, 502, "Interswitch API error: "+err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data_source": "interswitch",
			"data":        result,
		})
	}
}

