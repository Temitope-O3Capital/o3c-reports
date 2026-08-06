package handlers

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterCards(r chi.Router, db *core.DB) {
	cards  := core.RequirePages("cards")
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
	r.With(income).Get("/products",      cardProducts(db))
	r.With(income).Get("/cycle-dates",   cardCycleDates(db))
	r.With(income).Get("/cycle-data",    cardCycleData(db))
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
			"issuance_queue":          issuance,
			"open_disputes":           disputes,
			"pending_credit_reviews":  creditReviews,
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
		from     := qstr(r, "from")
		to       := qstr(r, "to")
		ctx := r.Context()
		kpis := map[string]any{}
		var sources []string

		// card_type + date filter — same arg position for both dbs
		var ctFilter Filter
		ctFilter.Eq(" AND Product_Name=?", ` AND product_name=?`, cardType)
		ctFilter.Date("Account_Created_Date", `opened_date`, from, to)

		type spec struct{ key, ms, pg string }
		for _, s := range []spec{
			{"total_issued",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE 1=1%s", ctFilter.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM app.accounts WHERE 1=1%s`, ctFilter.PG())},
			{"active",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE Status IN ('Open','Active')%s", ctFilter.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM app.accounts WHERE status IN ('Open','Active')%s`, ctFilter.PG())},
			{"inactive",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE Status NOT IN ('Open','Active')%s", ctFilter.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM app.accounts WHERE status NOT IN ('Open','Active')%s`, ctFilter.PG())},
		} {
			val, src, err := db.DualScalar(ctx, "val", s.ms, s.pg, ctFilter.Args()...)
			if err != nil {
				respondErr(w, 500, "Query failed: "+s.key)
				return
			}
			kpis[s.key] = val
			sources = append(sources, src)
		}

		// per-product counts for the 4 known products
		for _, product := range []string{"PREP", "Amex Naira", "Amex USD", "Classic Accounts"} {
			// When card_type filter is set, skip products that don't match
			if cardType != "" && product != cardType {
				continue
			}
			var pf Filter
			pf.Eq(" AND Product_Name=?", ` AND product_name=?`, product)
			key := slugify(product)
			val, src, err := db.DualScalar(ctx, "val",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE 1=1%s", pf.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM app.accounts WHERE 1=1%s`, pf.PG()),
				pf.Args()...)
			if err == nil {
				kpis[key] = val
				sources = append(sources, src)
			}
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
			fmt.Sprintf(`SELECT COUNT(DISTINCT t.Merchant_Name) AS val
			  FROM dbo.Transaction_Listing t JOIN dbo.Account p ON t.CIF=p.CIF_Number
			  WHERE t.Merchant_Name IS NOT NULL AND t.Merchant_Name!=''%s`, mf.MS()),
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
		data, src, err := db.DualQuery(r.Context(),
			`SELECT Product_Name, COUNT(*) AS count FROM dbo.Account
			 WHERE Product_Name IS NOT NULL GROUP BY Product_Name ORDER BY count DESC`,
			`SELECT product_name AS product_name, COUNT(*) AS count FROM app.accounts
			 WHERE product_name IS NOT NULL GROUP BY product_name ORDER BY count DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func cardsByStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, src, err := db.DualQuery(r.Context(),
			`SELECT Status, COUNT(*) AS count FROM dbo.Account GROUP BY Status ORDER BY count DESC`,
			`SELECT status AS status, COUNT(*) AS count FROM app.accounts GROUP BY status ORDER BY count DESC`)
		if err != nil {
			respondErr(w, 500, "Query failed")
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
			fmt.Sprintf(`SELECT p.Product_Name, ISNULL(SUM(t.Amount),0) AS volume, COUNT(t.Amount) AS txn_count
			  FROM dbo.Account p JOIN dbo.Transaction_Listing t ON p.CIF_Number=t.CIF
			  WHERE 1=1%s GROUP BY p.Product_Name ORDER BY volume DESC`, f.MS()),
			fmt.Sprintf(`SELECT p.product_name AS product_name, COALESCE(SUM(t.amount),0) AS volume, COUNT(t.amount) AS txn_count
			  FROM app.accounts p JOIN app.transactions t ON p.cif=t.cif
			  WHERE 1=1%s GROUP BY p.product_name ORDER BY volume DESC`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
	}
}

func cardsCardholders(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status   := qstr(r, "status")
		cardType := qstr(r, "card_type")
		from     := qstr(r, "from")
		to       := qstr(r, "to")
		limit    := qint(r, "limit",  50, 1, 200)
		offset   := qint(r, "offset", 0,  0, 1<<30)

		var f Filter
		f.Eq(" AND Status=?", ` AND status=?`, status)
		f.Eq(" AND Product_Name=?", ` AND product_name=?`, cardType)
		f.Date("Account_Created_Date", `opened_date`, from, to)

		total, _, _ := db.DualScalar(r.Context(), "val",
			fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE 1=1%s", f.MS()),
			fmt.Sprintf(`SELECT COUNT(*) AS val FROM app.accounts WHERE 1=1%s`, f.PG()),
			f.Args()...)

		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT CIF_Number AS cif_number,
				ISNULL(Product_Name,'') AS product_name,
				ISNULL(Status,'') AS status,
				ISNULL(Card_Product,'') AS card_product,
				CONVERT(varchar(10), Account_Created_Date, 23) AS created_at
			FROM dbo.Account WHERE 1=1%s
			ORDER BY Account_Created_Date DESC
			OFFSET %d ROWS FETCH NEXT %d ROWS ONLY`, f.MS(), offset, limit),
			fmt.Sprintf(`SELECT cif AS cif_number,
				COALESCE(product_name,'') AS product_name,
				COALESCE(status,'') AS status,
				COALESCE(COALESCE(card_product,card_program),'') AS card_product,
				TO_CHAR(opened_date,'YYYY-MM-DD') AS created_at
			FROM app.accounts WHERE 1=1%s
			ORDER BY opened_date DESC
			LIMIT %d OFFSET %d`, f.PG(), limit, offset),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
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
