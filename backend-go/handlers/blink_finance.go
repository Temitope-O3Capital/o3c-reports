package handlers

// Blink's finance report: funding inflow, the BlueSalt fee split, and the FX
// inventory pipeline (accumulated foreign currency awaiting sale, since O3 doesn't
// sell instantly — migration 343).
//
// Fee split: BlueSalt charges 6.8% total on a Blink conversion, keeps 3.8% plus VAT
// (7.5%, confirmed with Finance) on that 3.8%, and O3 keeps the rest:
//   O3 share = 6.8% - 3.8% - (7.5% of 3.8%) = 6.8% - 3.8% - 0.285% = 2.915%
// This is a rate applied to funding volume, not something read off a GL account —
// no account separates O3's cut from BlueSalt's.
//
// FX pipeline: weighted-average cost. A sale's realized gain/loss is computed against
// the weighted-average rate of ALL funding events for that currency up to the sale
// time — not FIFO lot-tracking. This is correct WAC behaviour, not an approximation:
// selling at the average cost does not change the remaining pool's average cost: only
// new funding does. "Unsold" inventory is cumulative funding minus cumulative sales,
// by currency.

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

const (
	blinkBlueSaltTotalFeePct = 0.068
	blinkBlueSaltCutPct      = 0.038
	blinkVATRate             = 0.075
)

// blinkO3SharePct = 6.8% - 3.8% - VAT(3.8%) = 2.915%.
var blinkO3SharePct = blinkBlueSaltTotalFeePct - blinkBlueSaltCutPct - (blinkVATRate * blinkBlueSaltCutPct)

// RegisterBlinkFinance mounts the Blink FX pipeline endpoints under /api/finance.
func RegisterBlinkFinance(r chi.Router, db *core.DB) {
	access := core.RequirePages("finance")
	r.With(access).Get("/blink-fx-events", blinkFXEventsList(db))
	r.With(access).Post("/blink-fx-events", blinkFXEventsCreate(db))
	r.With(access).Put("/blink-fx-events/{id}/approve", blinkFXEventsApprove(db))
	r.With(access).Put("/blink-fx-events/{id}/reject", blinkFXEventsReject(db))
	r.With(access).Post("/blink-fx-events/sale", blinkFXRecordSale(db))
	r.With(access).Get("/blink-report", blinkFinanceReport(db))
}

func blinkFXEventsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := "WHERE 1=1"
		var args []any
		n := 1
		if v := qstr(r, "status"); v != "" {
			where += " AND status = $" + itoa(n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "event_type"); v != "" {
			where += " AND event_type = $" + itoa(n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "currency"); v != "" {
			where += " AND currency = $" + itoa(n)
			args = append(args, v)
			n++
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, event_type, currency, fx_amount, ngn_amount_kobo, rate, rate_source,
			       branch_name, occurred_at, notes, status, initiated_by_name, approved_by_name
			  FROM app.blink_fx_events `+where+`
			 ORDER BY occurred_at DESC, id DESC LIMIT 500`, args...)
		if err != nil {
			respondErrLog(w, 500, "blink fx events list failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		jsonRows(w, rows)
	}
}

func blinkFXEventsCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		var b struct {
			EventType  string  `json:"event_type"`
			Currency   string  `json:"currency"`
			FxAmount   float64 `json:"fx_amount"`
			Rate       float64 `json:"rate"`
			BranchName string  `json:"branch_name"`
			OccurredAt string  `json:"occurred_at"`
			Notes      string  `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.EventType = strings.ToLower(strings.TrimSpace(b.EventType))
		if b.EventType != "funding" && b.EventType != "fee" && b.EventType != "sale" {
			respondErr(w, 422, "event_type must be 'funding', 'fee' or 'sale'")
			return
		}
		if b.Currency == "" || b.FxAmount <= 0 || b.Rate <= 0 || b.OccurredAt == "" {
			respondErr(w, 422, "currency, a positive fx_amount, a positive rate and occurred_at are required")
			return
		}
		ngnKobo := int64(b.FxAmount * b.Rate * 100)
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.blink_fx_events
			    (event_type, currency, fx_amount, ngn_amount_kobo, rate, rate_source,
			     branch_name, occurred_at, notes, status, initiated_by, initiated_by_name)
			VALUES ($1,$2,$3,$4,$5,'manual',NULLIF($6,''),$7::timestamptz,$8,'pending',$9,$10)
			RETURNING id, event_type, fx_amount, rate, status`,
			b.EventType, b.Currency, b.FxAmount, ngnKobo, b.Rate, b.BranchName, b.OccurredAt, b.Notes,
			user.ID, user.FullName)
		if err != nil {
			respondErrLog(w, 500, "blink fx event create failed", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func blinkFXEventsApprove(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			UPDATE app.blink_fx_events
			   SET status='approved', approved_by=$1, approved_by_name=$2
			 WHERE id=$3 AND status='pending'
			RETURNING id`, user.ID, user.FullName, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Event not found or not pending")
			return
		}
		jsonMsg(w, "approved")
	}
}

func blinkFXEventsReject(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		var b struct{ Reason string `json:"reason"` }
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		rows, err := db.PGQuery(r.Context(), `
			UPDATE app.blink_fx_events
			   SET status='rejected', approved_by=$1, rejection_reason=$2
			 WHERE id=$3 AND status='pending'
			RETURNING id`, user.ID, b.Reason, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Event not found or not pending")
			return
		}
		jsonMsg(w, "rejected")
	}
}

// blinkFXRecordSale posts a 'sale' event (accumulated FX actually sold/converted),
// computing realized gain/loss against the weighted-average booking rate of all
// approved funding for that currency to date. Rate is optional: if omitted, the
// handler pulls the latest app.fx_parallel_rates sell rate for the currency
// (rate_source='parallel_market'); if supplied, it's the realized rate Finance
// actually got (rate_source='manual').
func blinkFXRecordSale(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		user := core.UserFromCtx(ctx)
		var b struct {
			Currency   string   `json:"currency"`
			FxAmount   float64  `json:"fx_amount"`
			Rate       *float64 `json:"rate"`
			BranchName string   `json:"branch_name"`
			Notes      string   `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Currency == "" || b.FxAmount <= 0 {
			respondErr(w, 422, "currency and a positive fx_amount are required")
			return
		}

		rate := 0.0
		rateSource := "manual"
		if b.Rate != nil && *b.Rate > 0 {
			rate = *b.Rate
		} else {
			rateSource = "parallel_market"
			row, err := db.PGQuery(ctx, `
				SELECT sell FROM app.fx_parallel_rates
				 WHERE currency = $1 ORDER BY scraped_at DESC LIMIT 1`, b.Currency)
			if err != nil || len(row) == 0 {
				respondErr(w, 422, "No rate supplied and no parallel-market rate available for "+b.Currency)
				return
			}
			rate = toFloat64(row[0]["sell"])
			if rate <= 0 {
				respondErr(w, 422, "Parallel-market rate for "+b.Currency+" is not usable")
				return
			}
		}

		// Weighted-average booking rate of all approved funding for this currency —
		// correct WAC, not FIFO: the remaining pool's average cost only moves when new
		// funding lands, never when some of it is sold.
		wacRows, err := db.PGQuery(ctx, `
			SELECT SUM(fx_amount) AS total_fx, SUM(fx_amount * rate) AS total_cost
			  FROM app.blink_fx_events
			 WHERE event_type = 'funding' AND currency = $1 AND status = 'approved'`, b.Currency)
		if err != nil || len(wacRows) == 0 {
			respondErrLog(w, 500, "blink fx sale: WAC lookup failed", err)
			return
		}
		totalFx := toFloat64(wacRows[0]["total_fx"])
		totalCost := toFloat64(wacRows[0]["total_cost"])
		if totalFx <= 0 {
			respondErr(w, 422, "No funding events recorded for "+b.Currency+" — nothing to sell against")
			return
		}
		wac := totalCost / totalFx

		ngnKobo := int64(b.FxAmount * rate * 100)
		gainLossKobo := int64((rate - wac) * b.FxAmount * 100)

		rows, err := db.PGQuery(ctx, `
			INSERT INTO app.blink_fx_events
			    (event_type, currency, fx_amount, ngn_amount_kobo, rate, rate_source,
			     branch_name, occurred_at, notes, status, initiated_by, initiated_by_name)
			VALUES ('sale',$1,$2,$3,$4,$5,NULLIF($6,''),NOW(),$7,'approved',$8,$9)
			RETURNING id, fx_amount, rate`,
			b.Currency, b.FxAmount, ngnKobo, rate, rateSource, b.BranchName,
			b.Notes, user.ID, user.FullName)
		if err != nil {
			respondErrLog(w, 500, "blink fx sale insert failed", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{
			"id":                 rows[0]["id"],
			"currency":           b.Currency,
			"fx_amount":          b.FxAmount,
			"realized_rate":      rate,
			"rate_source":        rateSource,
			"booking_wac":        wac,
			"gain_loss_ngn_kobo": gainLossKobo,
		}) //nolint:errcheck
	}
}

func blinkFinanceReport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		fundingRows, _ := db.PGQuery(ctx, `
			SELECT currency, SUM(fx_amount) AS fx_total, SUM(ngn_amount_kobo) AS ngn_total, COUNT(*) AS events
			  FROM app.blink_fx_events
			 WHERE event_type = 'funding' AND status = 'approved'
			 GROUP BY currency ORDER BY currency`)
		if fundingRows == nil {
			fundingRows = []core.Row{}
		}

		// Inventory pipeline: cumulative funding minus cumulative sales, by currency,
		// plus the WAC booking rate still live for a sale happening right now.
		pipelineRows, _ := db.PGQuery(ctx, `
			SELECT currency,
			       COALESCE(SUM(fx_amount) FILTER (WHERE event_type='funding'), 0) AS funded_fx,
			       COALESCE(SUM(fx_amount) FILTER (WHERE event_type='sale'), 0)    AS sold_fx,
			       COALESCE(SUM(fx_amount) FILTER (WHERE event_type='funding'), 0)
			         - COALESCE(SUM(fx_amount) FILTER (WHERE event_type='sale'), 0) AS unsold_fx,
			       CASE WHEN SUM(fx_amount) FILTER (WHERE event_type='funding') > 0
			            THEN SUM(fx_amount * rate) FILTER (WHERE event_type='funding')
			                 / SUM(fx_amount) FILTER (WHERE event_type='funding')
			            ELSE NULL END AS booking_wac
			  FROM app.blink_fx_events
			 WHERE status = 'approved'
			 GROUP BY currency ORDER BY currency`)
		if pipelineRows == nil {
			pipelineRows = []core.Row{}
		}

		realizedRows, _ := db.PGQuery(ctx, `
			SELECT id, currency, fx_amount, rate, rate_source, occurred_at, notes
			  FROM app.blink_fx_events
			 WHERE event_type = 'sale' AND status = 'approved'
			 ORDER BY occurred_at DESC LIMIT 100`)
		if realizedRows == nil {
			realizedRows = []core.Row{}
		}
		// Gain/loss on each realized sale, computed against the WAC AT THAT TIME —
		// approximated here using funding up to (and including) the sale's own
		// occurred_at, so a later sale is judged against the pool as it stood then,
		// not against today's pool.
		for _, s := range realizedRows {
			cur := str2(s["currency"])
			occ := s["occurred_at"]
			wacAt, _ := db.PGQuery(ctx, `
				SELECT SUM(fx_amount*rate)/SUM(fx_amount) AS wac
				  FROM app.blink_fx_events
				 WHERE event_type='funding' AND currency=$1 AND status='approved' AND occurred_at <= $2`,
				cur, occ)
			if len(wacAt) > 0 && wacAt[0]["wac"] != nil {
				wac := toFloat64(wacAt[0]["wac"])
				rate := toFloat64(s["rate"])
				fx := toFloat64(s["fx_amount"])
				s["gain_loss_ngn_kobo"] = int64((rate - wac) * fx * 100)
				s["booking_wac"] = wac
			}
		}

		respond(w, map[string]any{
			"funding_by_currency":  fundingRows,
			"pipeline_by_currency": pipelineRows,
			"realized_sales":       realizedRows,
			"fee_split": map[string]any{
				"total_fee_pct":   blinkBlueSaltTotalFeePct * 100,
				"bluesalt_cut_pct": blinkBlueSaltCutPct * 100,
				"vat_rate_pct":    blinkVATRate * 100,
				"o3_share_pct":    blinkO3SharePct * 100,
			},
			"note": "Funding/fee events are parsed best-effort from GL narration where a rate is " +
				"embedded (~26% of BlueSalt wallet postings carry one); everything else is a " +
				"manual entry. Realized gain/loss uses weighted-average cost, not FIFO.",
		}, "pg")
	}
}

func str2(v any) string {
	if v == nil {
		return ""
	}
	s, _ := v.(string)
	if s != "" {
		return s
	}
	if t, ok := v.(time.Time); ok {
		return t.Format(time.RFC3339)
	}
	return ""
}
