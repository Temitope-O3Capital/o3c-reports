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

var iswPassportURL = coalesce(os.Getenv("INTERSWITCH_PASSPORT_URL"),
	"https://passport.interswitch.com/passport/oauth/token")

// resolveISWCreds returns (clientID, clientSecret, baseURL): env var first, then DB-stored credential.
func resolveISWCreds(ctx context.Context, db *core.DB) (clientID, clientSecret, baseURL string) {
	resolve := func(key string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		rows, _ := db.PGQuery(ctx, `SELECT encrypted_value FROM api_credentials WHERE key_name=$1`, key)
		if len(rows) == 0 {
			return ""
		}
		enc, _ := rows[0]["encrypted_value"].(string)
		plain, _ := decryptValue(enc)
		return plain
	}
	return resolve("INTERSWITCH_CLIENT_ID"), resolve("INTERSWITCH_CLIENT_SECRET"), resolve("INTERSWITCH_BASE_URL")
}

func iswConfiguredWith(ctx context.Context, db *core.DB) bool {
	id, secret, base := resolveISWCreds(ctx, db)
	return id != "" && secret != "" && base != ""
}

var iswTok struct {
	sync.Mutex
	access  string
	expires time.Time
}

func iswAccessToken(ctx context.Context, db *core.DB) (string, error) {
	iswTok.Lock()
	defer iswTok.Unlock()
	if iswTok.access != "" && time.Now().Add(60*time.Second).Before(iswTok.expires) {
		return iswTok.access, nil
	}

	clientID, clientSecret, _ := resolveISWCreds(ctx, db)
	if clientID == "" || clientSecret == "" {
		return "", fmt.Errorf("INTERSWITCH_CLIENT_ID / INTERSWITCH_CLIENT_SECRET not configured")
	}

	// Interswitch Passport: Basic auth with client credentials, client_credentials grant
	body := url.Values{"grant_type": {"client_credentials"}, "scope": {"profile"}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, iswPassportURL,
		strings.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(clientID, clientSecret)

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

func iswFetch(ctx context.Context, db *core.DB, path string, params url.Values) (map[string]any, error) {
	token, err := iswAccessToken(ctx, db)
	if err != nil {
		return nil, err
	}
	_, _, baseURL := resolveISWCreds(ctx, db)
	reqURL := baseURL + path
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

// psTransfers fetches outbound transfers and enriches each one with actual fees
// pulled from the balance ledger (Transfer Fee + Stamp Duty per TRF code).
// It also applies T00:00:00 / T23:59:59 time bounds so the full `to` day is included.
func psTransfers(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if resolvePaystackKey(r.Context(), db) == "" {
			respondErr(w, 503, "Paystack not configured")
			return
		}
		dateFrom := qstr(r, "from")
		dateTo   := qstr(r, "to")
		status   := qstr(r, "status")
		page     := coalesce(qstr(r, "page"), "1")
		perPage  := coalesce(qstr(r, "per_page"), "50")

		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()

		// Build transfer params — append full-day time bounds so `to` day is included
		txfParams := url.Values{"page": {page}, "perPage": {perPage}}
		if dateFrom != "" { txfParams.Set("from", dateFrom+"T00:00:00.000Z") }
		if dateTo   != "" { txfParams.Set("to",   dateTo+"T23:59:59.000Z") }
		if status   != "" { txfParams.Set("status", status) }

		// Fetch transfers and ledger concurrently
		type result struct {
			data map[string]any
			err  error
		}
		txfCh  := make(chan result, 1)
		ledCh  := make(chan result, 1)

		go func() {
			d, e := paystackFetch(ctx, db, "/transfer", txfParams)
			txfCh <- result{d, e}
		}()
		go func() {
			// Fetch up to 100 ledger entries for the same day range
			lp := url.Values{"perPage": {"100"}, "page": {"1"}}
			if dateFrom != "" { lp.Set("from", dateFrom+"T00:00:00.000Z") }
			if dateTo   != "" { lp.Set("to",   dateTo+"T23:59:59.000Z") }
			d, e := paystackFetch(ctx, db, "/balance/ledger", lp)
			ledCh <- result{d, e}
		}()

		txfRes := <-txfCh
		ledRes := <-ledCh

		if txfRes.err != nil {
			respondErr(w, 502, "Paystack API error: "+txfRes.err.Error())
			return
		}

		// Build map: TRF_code → {transfer_fee, stamp_duty} from ledger entries
		type feeBreakdown struct {
			TransferFee float64 `json:"transfer_fee"`
			StampDuty   float64 `json:"stamp_duty"`
			Total       float64 `json:"total"`
		}
		fees := map[string]*feeBreakdown{}

		if ledRes.err == nil && ledRes.data != nil {
			if entries, ok := ledRes.data["data"].([]any); ok {
				for _, entry := range entries {
					e, ok := entry.(map[string]any)
					if !ok { continue }
					reason := zohoStr(e["reason"])
					// Extract TRF code from reason like "Charge for transfer: TRF_xxx"
					// or "Stamp Duty for transfer: TRF_xxx"
					code := ""
					for _, prefix := range []string{"Charge for transfer: ", "Stamp Duty for transfer: "} {
						if idx := strings.Index(reason, prefix); idx >= 0 {
							code = strings.TrimSpace(reason[idx+len(prefix):])
							break
						}
					}
					if code == "" { continue }
					if fees[code] == nil {
						fees[code] = &feeBreakdown{}
					}
					// Paystack ledger amounts are in NGN (not kobo) as negative debits
					amt := math.Abs(toFloat64(e["amount"]))
					typeStr := zohoStr(e["type"])
					switch {
					case strings.Contains(strings.ToLower(typeStr), "stamp"):
						fees[code].StampDuty += amt
					default:
						fees[code].TransferFee += amt
					}
					fees[code].Total = fees[code].TransferFee + fees[code].StampDuty
				}
			}
		}

		// Enrich each transfer with its fee breakdown
		transfers := txfRes.data["data"]
		if items, ok := transfers.([]any); ok {
			for _, item := range items {
				t, ok := item.(map[string]any)
				if !ok { continue }
				code := zohoStr(t["transfer_code"])
				if fb, found := fees[code]; found {
					t["actual_fees"] = fb
				}
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data_source": "paystack",
			"data":        transfers,
			"meta":        txfRes.data["meta"],
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
	r.With(access).Get("/transfers", psTransfers(db))
	r.With(access).Get("/refunds",   psProxy(db, "/refund", nil))
	r.With(access).Get("/disputes",  psProxy(db, "/dispute", nil))
}

func RegisterInterspwitchRecon(r chi.Router, db *core.DB) {
	access := core.RequirePages("reconciliation")
	r.With(access).Get("/summary", iswReconSummary(db))
	r.With(access).Get("/transactions", iswReconTransactions(db))
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

		// Fetch overall totals (meta.total = full count, meta.total_volume = full volume).
		psResult, psErr := paystackFetch(ctx, db, "/transaction", url.Values{
			"from": {psFrom}, "to": {psTo},
			"perPage": {"1"}, "page": {"1"},
		})
		// Fetch per-status counts via perPage=1 — only meta.total is needed.
		psSuccess, _ := paystackFetch(ctx, db, "/transaction", url.Values{
			"from": {psFrom}, "to": {psTo}, "status": {"success"}, "perPage": {"1"}, "page": {"1"},
		})
		psFailed, _ := paystackFetch(ctx, db, "/transaction", url.Values{
			"from": {psFrom}, "to": {psTo}, "status": {"failed"}, "perPage": {"1"}, "page": {"1"},
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

		metaInt64 := func(result map[string]any, key string) int64 {
			if result == nil {
				return 0
			}
			if meta, ok := result["meta"].(map[string]any); ok {
				return toInt64(meta[key])
			}
			return 0
		}

		ps := psSummary{Configured: true}
		if psErr != nil {
			ps.Error = psErr.Error()
		} else if psResult != nil {
			ps.TotalCount = metaInt64(psResult, "total")
			if tv := toFloat64(func() any {
				if meta, ok := psResult["meta"].(map[string]any); ok {
					return meta["total_volume"]
				}
				return nil
			}()); tv > 0 {
				ps.TotalVolumeKobo = tv
				ps.TotalVolumeNGN = math.Round(tv) / 100
			}
		}
		ps.Success = metaInt64(psSuccess, "total")
		ps.Failed = metaInt64(psFailed, "total")

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
		if !iswConfiguredWith(r.Context(), db) {
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
		iswResult, iswErr := iswFetch(ctx, db, txnPath, url.Values{
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

func iswReconTransactions(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !iswConfiguredWith(r.Context(), db) {
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

		result, err := iswFetch(ctx, db, txnPath, params)
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

