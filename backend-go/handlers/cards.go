package handlers

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

func RegisterCards(r chi.Router, db *core.DB) {
	cards := core.RequirePages("cards")
	income := core.RequirePages("cards", "income", "finance")

	r.With(cards).Get("/kpis", cardsKPIs(db))
	r.With(cards).Get("/by-product", cardsByProduct(db))
	r.With(cards).Get("/by-status", cardsByStatus(db))
	r.With(cards).Get("/volume-by-type", cardsVolumeByType(db))
	r.With(cards).Get("/cardholders", cardsCardholders(db))
	r.With(cards).Post("/cardholders/{cif}/block", cardBlockCardholder(db))
	r.With(cards).Post("/cardholders/{cif}/unblock", cardUnblockCardholder(db))
	r.With(cards).Get("/cardholders/{cif}/block-log", cardBlockLog(db))
	r.With(cards).Get("/issuance", cardListIssuance(db))
	r.With(cards).Post("/issuance", cardCreateIssuance(db))
	r.With(cards).Patch("/issuance/{id}/status", cardAdvanceIssuance(db))
	r.With(cards).Get("/disputes", cardListDisputes(db))
	r.With(cards).Post("/disputes", cardCreateDispute(db))
	r.With(cards).Patch("/disputes/{id}/status", cardAdvanceDispute(db))
	r.With(cards).Get("/credit-limits", cardListCreditLimits(db))
	r.With(cards).Post("/credit-limits", cardCreateCreditLimit(db))
	r.With(cards).Patch("/credit-limits/{id}/decide", cardDecideCreditLimit(db))
	r.With(cards).Get("/billing", cardListBilling(db))
	r.With(cards).Post("/billing/generate", cardGenerateBilling(db))

	// Cycle data — also accessible to finance/income roles for the Income page
	r.With(income).Get("/products", cardProducts(db))
	r.With(income).Get("/cycle-dates", cardCycleDates(db))
	r.With(income).Get("/cycle-data", cardCycleData(db))
	r.With(income).Get("/cycle-summary", cardCycleSummary(db))

	// Agent queue dashboard
	r.With(cards).Get("/my-queue", cardMyQueue(db))
}

func cardMyQueue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		ctx := r.Context()

		issuance, _ := db.PGQuery(ctx, `
			SELECT id, cif_number, customer_name, card_type, status, submitted_by, created_at
			FROM card_issuance_requests
			WHERE submitted_by = $1
			  AND status IN ('pending','doc_review','credit_check','risk_review')
			ORDER BY created_at DESC`, user.ID)

		disputes, _ := db.PGQuery(ctx, `
			SELECT id, cif_number, customer_name, card_type, amount_kobo, dispute_type, notes, status, filed_at, resolved_at
			FROM card_disputes
			WHERE status NOT IN ('resolved','closed')
			ORDER BY filed_at DESC`)

		creditReviews, _ := db.PGQuery(ctx, `
			SELECT id, cif_number, customer_name, card_type, current_limit_kobo, proposed_limit_kobo, utilization_pct, eye_score, status, created_at
			FROM card_credit_limit_reviews
			WHERE status = 'pending'
			ORDER BY created_at DESC`)

		if issuance == nil {
			issuance = []core.Row{}
		}
		if disputes == nil {
			disputes = []core.Row{}
		}
		if creditReviews == nil {
			creditReviews = []core.Row{}
		}

		respond(w, map[string]any{
			"issuance_queue":         issuance,
			"open_disputes":          disputes,
			"pending_credit_reviews": creditReviews,
			"summary": map[string]any{
				"issuance_count":       len(issuance),
				"disputes_count":       len(disputes),
				"credit_reviews_count": len(creditReviews),
			},
		}, "pg")
	}
}

func cardsKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cardType := qstr(r, "card_type")
		from := qstr(r, "from")
		to := qstr(r, "to")
		ctx := r.Context()
		kpis := map[string]any{}
		var sources []string

		// card_type + date filter — same arg position for both dbs
		var ctFilter Filter
		ctFilter.Eq(" AND Product_Name=?", ` AND product_name=?`, cardType)
		ctFilter.Date("Account_Created_Date", `opened_date`, from, to)

		type spec struct{ key, pg string }
		for _, s := range []spec{
			{"total_issued",
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM app.accounts WHERE 1=1%s`, ctFilter.PG())},
			// Read app.card_book, not app.accounts.status.
			//
			// status does not track expiry. 16,215 cards were past their expiry date
			// and still marked Open or Active, so "active cards" counted a book that
			// was 87% dead — and because `status NOT IN (...)` drops NULLs, the 192
			// rows the live feed writes with no status at all fell out of BOTH
			// numbers, so active + inactive did not even sum to the total.
			{"active",
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM app.card_book WHERE card_state = 'Live'%s`, ctFilter.PG())},
			{"inactive",
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM app.card_book WHERE card_state <> 'Live'%s`, ctFilter.PG())},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.pg, ctFilter.Args()...)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		// Per-product counts, driven by the catalogue rather than a literal.
		//
		// The old list was {"PREP","Amex Naira","Amex USD","Classic Accounts"}:
		// two of them are is_active=false legacy names (Amex Naira 001, Amex USD
		// 002) and six live products were missing entirely, so the KPI strip
		// reported on a set that matched neither the catalogue nor the book.
		// app.accounts.product_name holds the legacy system_name, so the count
		// matches on that while the KPI key uses the canonical name.
		prodRows, _ := db.PGQuery(ctx, `
			SELECT product_name,
			       COALESCE(NULLIF(system_name, ''), product_name) AS match_name
			  FROM app.card_products
			 WHERE is_active
			 ORDER BY product_name`)
		for _, p := range prodRows {
			name, match := str(p["product_name"]), str(p["match_name"])
			// The card_type filter arrives as whichever name the caller has.
			if cardType != "" && cardType != name && cardType != match {
				continue
			}
			val, src, err := db.DualScalar(ctx, "val",
				`SELECT COUNT(*) AS val FROM app.accounts WHERE product_name = $1`, match)
			if err == nil {
				kpis[slugify(name)] = val
				sources = append(sources, src)
			}
		}

		// The two axes, on the same filter as the KPIs above so the strip and the
		// breakdowns always reconcile. family is the funding family from the
		// catalogue (credit | prepaid | blink); activity is usage recency, which
		// is orthogonal to card_state — 579 Expired cards transacted in the last
		// 90 days and 1,796 Live ones did not.
		if fam, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT COALESCE(product_category, 'unmatched') AS family, COUNT(*) AS count
			  FROM app.card_book_full WHERE 1=1%s GROUP BY 1`, ctFilter.PG()),
			ctFilter.Args()...); len(fam) > 0 {
			byFamily := map[string]any{}
			for _, f := range fam {
				byFamily[str(f["family"])] = toInt64(f["count"])
			}
			kpis["by_family"] = byFamily
		}
		if act, _ := db.PGQuery(ctx, fmt.Sprintf(`
			SELECT activity_class, COUNT(*) AS count
			  FROM app.card_book_full WHERE 1=1%s GROUP BY 1`, ctFilter.PG()),
			ctFilter.Args()...); len(act) > 0 {
			byActivity := map[string]any{}
			for _, a := range act {
				byActivity[str(a["activity_class"])] = toInt64(a["count"])
			}
			kpis["by_activity"] = byActivity
		}

		total := toFloat(kpis["total_issued"])
		if total > 0 {
			kpis["activation_rate"] = round1(toFloat(kpis["active"]) / total * 100)
		} else {
			kpis["activation_rate"] = 0.0
		}

		// unique merchants (joined with transactions)
		var mf Filter
		mf.Eq(" AND p.Product_Name=?", ` AND p.product_name=?`, cardType)
		merchants, src, err := db.DualScalar(ctx, "val",
			fmt.Sprintf(`SELECT COUNT(DISTINCT t.merchant_name) AS val
			  FROM app.transactions t JOIN app.accounts p ON t.cif=p.cif
			  WHERE t.merchant_name IS NOT NULL AND t.merchant_name!=''%s`, mf.PG()),
			mf.Args()...)
		if err == nil {
			kpis["unique_merchants"] = merchants
			sources = append(sources, src)
		}

		respond(w, kpis, pickSource(sources))
	}
}

func cardsByProduct(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Reports the catalogue's canonical name and funding family alongside the
		// raw book name, so the caller can group by family without re-deriving it
		// from the product string. Rows the catalogue does not know are labelled
		// 'unmatched' rather than silently folded into a family.
		data, src, err := db.DualQuery(r.Context(),
			`SELECT COALESCE(catalogue_product_name, product_name) AS product_name,
			        COALESCE(product_category, 'unmatched')        AS category,
			        COUNT(*)                                       AS count
			 FROM app.card_book_full
			 WHERE product_name IS NOT NULL
			 GROUP BY 1, 2 ORDER BY count DESC`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

func cardsByStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// card_state, not the raw status column: status does not track expiry, so
		// this chart used to show a book that was 87% dead as Open/Active. Same
		// reasoning as the active/inactive KPIs above.
		data, src, err := db.DualQuery(r.Context(),
			`SELECT card_state AS status, COUNT(*) AS count
			 FROM app.card_book_full GROUP BY card_state ORDER BY count DESC`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

func cardsVolumeByType(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, err := validDate(r, "date_from")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		dateTo, err := validDate(r, "date_to")
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		cardType := qstr(r, "card_type")

		var f Filter
		f.Date("t.Transaction_Date", `t.txn_date`, dateFrom, dateTo)
		f.Eq(" AND p.Product_Name=?", ` AND p.product_name=?`, cardType)

		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT p.product_name AS product_name, COALESCE(SUM(t.amount),0) AS volume, COUNT(t.amount) AS txn_count
			  FROM app.accounts p JOIN app.transactions t ON p.cif=t.cif
			  WHERE 1=1%s GROUP BY p.product_name ORDER BY volume DESC`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		respond(w, data, src)
	}
}

func cardsCardholders(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		cardType := qstr(r, "card_type")
		from := qstr(r, "from")
		to := qstr(r, "to")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		// Filters read the two axes, not the raw status column.
		//
		// status now means card_state (Live / Expired / Terminated / …), which
		// accounts for expiry; the raw column marked 16,215 expired cards as Open
		// or Active. activity is the orthogonal usage axis (Active / Light /
		// Dormant / Inactive / Never used), and family is the funding family from
		// the catalogue. card_type still matches the product string, and accepts
		// either the book's legacy name or the catalogue's canonical one.
		activity := qstr(r, "activity")
		family := qstr(r, "family")

		var f Filter
		f.Eq(" AND Status=?", ` AND a.card_state=?`, status)
		f.Eq(" AND Activity=?", ` AND a.activity_class=?`, activity)
		f.Eq(" AND Family=?", ` AND a.product_category=?`, family)
		f.Eq(" AND Product_Name=?", ` AND (a.product_name=? OR a.catalogue_product_name=?)`, cardType)
		f.Date("Account_Created_Date", `a.opened_date`, from, to)

		// Search joins the identity table so a query can match (and the row can show)
		// the cardholder's NAME, not just the CIF — the box used to filter CIF only.
		// Tokenised, phone-normalized, wildcard-safe via the shared matcher; its params
		// are numbered after the filter's so the two clause sets don't collide.
		search, searchArgs := "", []any{}
		if q := qstr(r, "q"); q != "" {
			if clause, sargs, _ := buildCustomerSearch(q,
				[]string{"a.cif", "c.full_name", "c.phone"}, "c.phone", len(f.Args())+1); clause != "" {
				search = " AND " + clause
				searchArgs = sargs
			}
		}
		total, _, _ := db.DualScalar(r.Context(), "val",
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM app.card_book_full a
				LEFT JOIN app.customers c ON c.cif = a.cif
				WHERE 1=1%s%s`, f.PG(), search),
			append(append([]any{}, f.Args()...), searchArgs...)...)

		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT a.cif AS cif_number,
				COALESCE(c.full_name,'') AS customer_name,
				COALESCE(a.catalogue_product_name, a.product_name, '') AS product_name,
				COALESCE(a.card_state,'') AS status,
				COALESCE(a.activity_class,'') AS activity_class,
				COALESCE(a.product_category,'unmatched') AS family,
				a.last_txn_date,
				COALESCE(COALESCE(a.card_product,a.card_program),'') AS card_product,
				TO_CHAR(a.opened_date,'YYYY-MM-DD') AS created_at
			FROM app.card_book_full a
			LEFT JOIN app.customers c ON c.cif = a.cif
			WHERE 1=1%s%s
			ORDER BY a.opened_date DESC
			LIMIT %d OFFSET %d`, f.PG(), search, limit, offset),
			append(append([]any{}, f.Args()...), searchArgs...)...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}

		respondPaginated(w, data, total, src)
	}
}

// slugify converts "Amex Naira" → "amex_naira" for JSON key names.
func slugify(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			out = append(out, c+32)
		} else if c == ' ' {
			out = append(out, '_')
		} else {
			out = append(out, c)
		}
	}
	return string(out)
}
