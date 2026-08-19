package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// RegisterPaystackOps mounts the reporting + failure-queue endpoints that read the
// local Paystack mirror. These are deliberately DB-backed, not live-API proxies:
// the mirror is what gives history, aging and trends, and it means a slow Paystack
// can never block a settlement page.
func RegisterPaystackOps(r chi.Router, db *core.DB) {
	access := core.RequirePages("settlement", "reconciliation")
	r.With(access).Get("/position", psPosition(db))
	r.With(access).Get("/funnel", psFunnel(db))
	r.With(access).Get("/failures", psFailures(db))

	// Cross-module: a customer's payment history. Read by Customer 360 and the
	// helpdesk, so it also accepts the pages those screens are gated on — a
	// support agent taking "I funded and it didn't reflect" needs this, and
	// making them hold the settlement page would defeat the point.
	r.With(core.RequirePages("settlement", "reconciliation", "customer360", "helpdesk", "customer_service")).
		Get("/customer", psCustomerActivity(db))
}

/* ── Cross-module: one customer's payment history ────────────────────────── */

// psCustomerActivity answers "did this customer's money actually move?" for a
// single person. Accepts ?cif= (resolved to email/phone via the Accounts master,
// which is the identity source of truth) or a direct ?email= / ?phone=.
//
// Paystack identifies customers by email; the workspace identifies them by CIF.
// Matching is therefore email-first, with phone as a fallback — and the response
// says which key matched so a caller never mistakes a phone-collision for a
// confirmed identity.
func psCustomerActivity(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		email := strings.ToLower(strings.TrimSpace(qstr(r, "email")))
		phone := strings.TrimSpace(qstr(r, "phone"))
		cif := strings.TrimSpace(qstr(r, "cif"))

		if cif != "" && email == "" && phone == "" {
			rows, _ := db.PGQuery(ctx, `
				SELECT COALESCE(email,'') AS email, COALESCE(phone,'') AS phone
				FROM app.customers WHERE cif = $1 LIMIT 1`, cif)
			if len(rows) > 0 {
				email = strings.ToLower(strings.TrimSpace(fmt.Sprint(rows[0]["email"])))
				phone = strings.TrimSpace(fmt.Sprint(rows[0]["phone"]))
			}
		}
		if email == "" && phone == "" {
			respondErr(w, 422, "cif, email or phone is required")
			return
		}

		// Email is NOT unique in the Accounts master: 855 addresses map to more than
		// one CIF, and the worst offenders are staff addresses used as placeholders
		// at onboarding (one is on 37 CIFs). Returning payments matched on a shared
		// address would attribute one customer's money to another — worse than
		// returning nothing — so ambiguous identities are refused, not guessed.
		if email != "" {
			if rows, _ := db.PGQuery(ctx, `
				SELECT COUNT(*) AS n FROM app.customers WHERE LOWER(email) = $1`, email); len(rows) > 0 {
				if shared := toInt64(rows[0]["n"]); shared > 1 {
					w.Header().Set("Content-Type", "application/json")
					json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
						"summary": map[string]any{
							"matched_on":      "none",
							"identity":        "ambiguous",
							"shared_cifs":     shared,
							"funding_n":       0,
							"funding_success": 0,
							"funding_failed":  0,
							"funded_kobo":     0,
							"note": fmt.Sprintf(
								"This email is registered to %d customers, so payment history cannot be attributed to one of them.", shared),
						},
						"fundings":  []map[string]any{},
						"transfers": []map[string]any{},
					})
					return
				}
			}
		}

		// Normalise the phone to its last 10 digits — the workspace stores
		// 0803…, Paystack may hold +234803… for the same person.
		phoneTail := digitsTail(phone, 10)

		txns, err := db.PGQuery(ctx, `
			SELECT id, reference, status, channel, amount_kobo, fees_kobo,
			       gateway_response, paid_at, created_at_ps, customer_email,
			       auth_bank, auth_card_type, auth_last4
			FROM paystack_transactions
			WHERE ($1 <> '' AND LOWER(customer_email) = $1)
			   OR ($2 <> '' AND RIGHT(REGEXP_REPLACE(COALESCE(customer_phone,''), '\D', '', 'g'), 10) = $2)
			ORDER BY created_at_ps DESC
			LIMIT 100`, email, phoneTail)
		if err != nil {
			respondErr(w, 500, "Query failed: "+err.Error())
			return
		}
		if txns == nil {
			txns = []map[string]any{}
		}

		// Transfers are keyed by recipient bank account, not email, so they are
		// matched separately on the NUBAN when the caller supplies one.
		account := strings.TrimSpace(qstr(r, "account"))
		transfers := []map[string]any{}
		if account != "" {
			if rows, _ := db.PGQuery(ctx, `
				SELECT id, reference, transfer_code, status, amount_kobo, reason, failures,
				       created_at_ps, transferred_at, recipient_name, recipient_account,
				       recipient_bank, session_id
				FROM paystack_transfers
				WHERE recipient_account = $1
				ORDER BY created_at_ps DESC LIMIT 100`, account); rows != nil {
				transfers = rows
			}
		}

		summary := map[string]any{
			"matched_on":      matchKeyLabel(email, phoneTail),
			"identity":        "unique",
			"email":           email,
			"funding_n":       len(txns),
			"transfers_n":     len(transfers),
			"funding_success": 0,
			"funding_failed":  0,
			"funded_kobo":     int64(0),
		}
		var funded int64
		succ, fail := 0, 0
		for _, t := range txns {
			switch fmt.Sprint(t["status"]) {
			case "success":
				succ++
				funded += toInt64(t["amount_kobo"])
			case "failed", "abandoned", "reversed":
				fail++
			}
		}
		summary["funding_success"] = succ
		summary["funding_failed"] = fail
		summary["funded_kobo"] = funded

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"summary":   summary,
			"fundings":  txns,
			"transfers": transfers,
		})
	}
}

// digitsTail returns the last n digits of s, ignoring formatting.
func digitsTail(s string, n int) string {
	var d []rune
	for _, c := range s {
		if c >= '0' && c <= '9' {
			d = append(d, c)
		}
	}
	if len(d) <= n {
		if len(d) == 0 {
			return ""
		}
		return string(d)
	}
	return string(d[len(d)-n:])
}

func matchKeyLabel(email, phoneTail string) string {
	switch {
	case email != "" && phoneTail != "":
		return "email+phone"
	case email != "":
		return "email"
	case phoneTail != "":
		return "phone"
	}
	return "none"
}

/* ── Settlement position ─────────────────────────────────────────────────── */

// psPosition is the reporting half of the module: what came in, what went out,
// what Paystack settled to the bank, and what it cost — for a period.
func psPosition(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, _ := validDate(r, "date_from")
		to, _ := validDate(r, "date_to")
		if from == "" || to == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}
		ctx := r.Context()

		rows, err := db.PGQuery(ctx, `
			SELECT
			  (SELECT COALESCE(SUM(amount_kobo),0) FROM paystack_transactions
			     WHERE status='success' AND created_at_ps::date BETWEEN $1::date AND $2::date) AS funding_in_kobo,
			  (SELECT COUNT(*) FROM paystack_transactions
			     WHERE status='success' AND created_at_ps::date BETWEEN $1::date AND $2::date) AS funding_in_n,
			  (SELECT COALESCE(SUM(fees_kobo),0) FROM paystack_transactions
			     WHERE status='success' AND created_at_ps::date BETWEEN $1::date AND $2::date) AS fees_kobo,
			  (SELECT COALESCE(SUM(amount_kobo),0) FROM paystack_transfers
			     WHERE status='success' AND created_at_ps::date BETWEEN $1::date AND $2::date) AS transfers_out_kobo,
			  (SELECT COUNT(*) FROM paystack_transfers
			     WHERE status='success' AND created_at_ps::date BETWEEN $1::date AND $2::date) AS transfers_out_n,
			  (SELECT COALESCE(SUM(total_amount_kobo),0) FROM paystack_settlements
			     WHERE status='success' AND settlement_date::date BETWEEN $1::date AND $2::date) AS settled_kobo,
			  (SELECT COUNT(*) FROM paystack_settlements
			     WHERE status='success' AND settlement_date::date BETWEEN $1::date AND $2::date) AS settled_n`,
			from, to)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		out := rows[0]
		out["net_kobo"] = toInt64(out["funding_in_kobo"]) - toInt64(out["transfers_out_kobo"])

		// Daily series for the trend chart.
		series, _ := db.PGQuery(ctx, `
			WITH d AS (SELECT generate_series($1::date, $2::date, '1 day')::date AS day)
			SELECT d.day,
			  COALESCE((SELECT SUM(amount_kobo) FROM paystack_transactions
			     WHERE status='success' AND created_at_ps::date = d.day),0) AS funding_in_kobo,
			  COALESCE((SELECT SUM(amount_kobo) FROM paystack_transfers
			     WHERE status='success' AND created_at_ps::date = d.day),0) AS transfers_out_kobo,
			  COALESCE((SELECT SUM(total_amount_kobo) FROM paystack_settlements
			     WHERE status='success' AND settlement_date::date = d.day),0) AS settled_kobo
			FROM d ORDER BY d.day`, from, to)
		if series == nil {
			series = []map[string]any{}
		}

		// Unreconciled exposure from the recon engine — the other half of "position".
		exc, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS open_n,
			       COALESCE(SUM(ABS(amount_kobo)),0) AS open_value_kobo,
			       COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '30 days') AS aged_30d_n
			FROM recon_exceptions WHERE status IN ('open','investigating')`)
		unrec := map[string]any{"open_n": 0, "open_value_kobo": 0, "aged_30d_n": 0}
		if len(exc) > 0 {
			unrec = exc[0]
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"period":       map[string]string{"from": from, "to": to},
			"totals":       out,
			"series":       series,
			"unreconciled": unrec,
		})
	}
}

/* ── Funding funnel ──────────────────────────────────────────────────────── */

// psFunnel exposes completion rate by channel. This exists because the mirror
// revealed that card funding completes ~11% of the time against ~66% for bank
// transfer — a revenue leak that was invisible while the data lived only in the API.
func psFunnel(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, _ := validDate(r, "date_from")
		to, _ := validDate(r, "date_to")
		if from == "" || to == "" {
			respondErr(w, 422, "date_from and date_to are required")
			return
		}
		ctx := r.Context()

		byChannel, err := db.PGQuery(ctx, `
			SELECT COALESCE(NULLIF(channel,''),'unknown') AS channel,
			       COUNT(*)                                     AS attempts,
			       COUNT(*) FILTER (WHERE status='success')     AS success,
			       COUNT(*) FILTER (WHERE status='abandoned')   AS abandoned,
			       COUNT(*) FILTER (WHERE status='failed')      AS failed,
			       COALESCE(SUM(amount_kobo) FILTER (WHERE status='success'),0)   AS success_kobo,
			       COALESCE(SUM(amount_kobo) FILTER (WHERE status<>'success'),0)  AS lost_kobo,
			       ROUND(100.0 * COUNT(*) FILTER (WHERE status='success')
			             / NULLIF(COUNT(*),0), 1)               AS completion_pct
			FROM paystack_transactions
			WHERE created_at_ps::date BETWEEN $1::date AND $2::date
			GROUP BY 1 ORDER BY attempts DESC`, from, to)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if byChannel == nil {
			byChannel = []map[string]any{}
		}

		byMonth, _ := db.PGQuery(ctx, `
			SELECT TO_CHAR(DATE_TRUNC('month', created_at_ps), 'YYYY-MM') AS month,
			       COUNT(*)                                   AS attempts,
			       COUNT(*) FILTER (WHERE status='success')   AS success,
			       ROUND(100.0 * COUNT(*) FILTER (WHERE status='success')
			             / NULLIF(COUNT(*),0), 1)             AS completion_pct
			FROM paystack_transactions
			WHERE created_at_ps::date BETWEEN $1::date AND $2::date
			GROUP BY 1 ORDER BY 1`, from, to)
		if byMonth == nil {
			byMonth = []map[string]any{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"by_channel": byChannel,
			"by_month":   byMonth,
		})
	}
}

/* ── Failure queue ───────────────────────────────────────────────────────── */

// psFailures is the money-moved-wrong queue: failed and reversed transfers, failed
// and reversed fundings, and unresolved disputes — unified so a settlement officer
// works one list instead of four screens.
func psFailures(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 200, 1, 1000)
		kind := qstr(r, "kind") // transfer | funding | dispute (blank = all)
		from, _ := validDate(r, "date_from")
		to, _ := validDate(r, "date_to")

		dateClause := func(col string) string {
			if from == "" || to == "" {
				return ""
			}
			return fmt.Sprintf(" AND %s::date BETWEEN $1::date AND $2::date", col)
		}
		var args []any
		if from != "" && to != "" {
			args = append(args, from, to)
		}

		var parts []string
		if kind == "" || kind == "transfer" {
			parts = append(parts, `
				SELECT 'transfer' AS kind, id::text AS ref_id,
				       COALESCE(NULLIF(reference,''), transfer_code) AS reference,
				       status, amount_kobo, created_at_ps AS occurred_at,
				       COALESCE(recipient_name,'') AS counterparty,
				       COALESCE(recipient_account,'') AS account,
				       COALESCE(recipient_bank,'') AS bank,
				       COALESCE(NULLIF(failures,''), reason, '') AS detail,
				       COALESCE(session_id,'') AS session_id
				FROM paystack_transfers
				WHERE status IN ('failed','reversed')`+dateClause("created_at_ps"))
		}
		if kind == "" || kind == "funding" {
			parts = append(parts, `
				SELECT 'funding' AS kind, id::text,
				       reference, status, amount_kobo, created_at_ps,
				       COALESCE(customer_email,''), COALESCE(auth_last4,''),
				       COALESCE(auth_bank,''), COALESCE(gateway_response,''),
				       ''
				FROM paystack_transactions
				WHERE status IN ('failed','reversed')`+dateClause("created_at_ps"))
		}
		if kind == "" || kind == "dispute" {
			parts = append(parts, `
				SELECT 'dispute' AS kind, id::text,
				       COALESCE(transaction_id::text,''), status, refund_amount_kobo, created_at_ps,
				       COALESCE(customer_email,''), '', '',
				       COALESCE(category,''), ''
				FROM paystack_disputes
				WHERE status IS DISTINCT FROM 'resolved'`+dateClause("created_at_ps"))
		}
		if len(parts) == 0 {
			respondErr(w, 422, "kind must be one of: transfer, funding, dispute")
			return
		}

		args = append(args, limit)
		q := strings.Join(parts, " UNION ALL ") +
			fmt.Sprintf(" ORDER BY occurred_at DESC LIMIT $%d", len(args))

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed: "+err.Error())
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}

		summary, _ := db.PGQuery(r.Context(), `
			SELECT
			  (SELECT COUNT(*) FROM paystack_transfers WHERE status='failed')        AS failed_transfers,
			  (SELECT COALESCE(SUM(amount_kobo),0) FROM paystack_transfers WHERE status='failed') AS failed_transfers_kobo,
			  (SELECT COUNT(*) FROM paystack_transfers WHERE status='reversed')      AS reversed_transfers,
			  (SELECT COUNT(*) FROM paystack_transactions WHERE status='failed')     AS failed_fundings,
			  (SELECT COALESCE(SUM(amount_kobo),0) FROM paystack_transactions WHERE status='failed') AS failed_fundings_kobo,
			  (SELECT COUNT(*) FROM paystack_transactions WHERE status='reversed')   AS reversed_fundings,
			  (SELECT COUNT(*) FROM paystack_disputes WHERE status IS DISTINCT FROM 'resolved') AS open_disputes`)
		sum := map[string]any{}
		if len(summary) > 0 {
			sum = summary[0]
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows, "summary": sum}) //nolint:errcheck
	}
}
