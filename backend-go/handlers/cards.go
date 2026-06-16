package handlers

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterCards(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("cards"))
	r.Get("/kpis", cardsKPIs(db))
	r.Get("/by-product", cardsByProduct(db))
	r.Get("/by-status", cardsByStatus(db))
	r.Get("/volume-by-type", cardsVolumeByType(db))
}

func cardsKPIs(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cardType := qstr(r, "card_type")
		ctx := r.Context()
		kpis := map[string]any{}
		var sources []string

		// card_type filter — same arg position for both dbs
		var ctFilter Filter
		ctFilter.Eq(" AND Product_Name=?", ` AND "Product Name"=?`, cardType)

		type spec struct{ key, ms, pg string }
		for _, s := range []spec{
			{"total_issued",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE 1=1%s", ctFilter.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Products" WHERE 1=1%s`, ctFilter.PG())},
			{"active",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE Status IN ('Open','Active')%s", ctFilter.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status" IN ('Open','Active')%s`, ctFilter.PG())},
			{"inactive",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE Status NOT IN ('Open','Active')%s", ctFilter.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Products" WHERE "Account Status" NOT IN ('Open','Active')%s`, ctFilter.PG())},
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
			var pf Filter
			pf.Eq(" AND Product_Name=?", ` AND "Product Name"=?`, product)
			if cardType != "" {
				// compound: also filter by card_type (dedup if same)
				if product != cardType {
					pf.Eq(" AND Product_Name=?", ` AND "Product Name"=?`, cardType)
				}
			}
			key := slugify(product)
			val, src, err := db.DualScalar(ctx, "val",
				fmt.Sprintf("SELECT COUNT(*) AS val FROM dbo.Account WHERE 1=1%s", pf.MS()),
				fmt.Sprintf(`SELECT COUNT(*) AS val FROM "Products" WHERE 1=1%s`, pf.PG()),
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
		mf.Eq(" AND p.Product_Name=?", ` AND p."Product Name"=?`, cardType)
		merchants, src, err := db.DualScalar(ctx, "val",
			fmt.Sprintf(`SELECT COUNT(DISTINCT t.Merchant_Name) AS val
			  FROM dbo.Transaction_Listing t JOIN dbo.Account p ON t.CIF=p.CIF_Number
			  WHERE t.Merchant_Name IS NOT NULL AND t.Merchant_Name!=''%s`, mf.MS()),
			fmt.Sprintf(`SELECT COUNT(DISTINCT t."Merchant_Name") AS val
			  FROM "Transactions" t JOIN "Products" p ON t."CIF Number"=p."CIF Number"
			  WHERE t."Merchant_Name" IS NOT NULL AND t."Merchant_Name"!=''%s`, mf.PG()),
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
			`SELECT "Product Name", COUNT(*) AS count FROM "Products"
			 WHERE "Product Name" IS NOT NULL GROUP BY "Product Name" ORDER BY count DESC`)
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
			`SELECT "Account Status", COUNT(*) AS count FROM "Products" GROUP BY "Account Status" ORDER BY count DESC`)
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
		f.Date("t.Transaction_Date", `t."Transaction Date"`, dateFrom, dateTo)
		f.Eq(" AND p.Product_Name=?", ` AND p."Product Name"=?`, cardType)

		data, src, err := db.DualQuery(r.Context(),
			fmt.Sprintf(`SELECT p.Product_Name, ISNULL(SUM(t.Amount),0) AS volume, COUNT(t.Amount) AS txn_count
			  FROM dbo.Account p JOIN dbo.Transaction_Listing t ON p.CIF_Number=t.CIF
			  WHERE 1=1%s GROUP BY p.Product_Name ORDER BY volume DESC`, f.MS()),
			fmt.Sprintf(`SELECT p."Product Name", COALESCE(SUM(t."Amount"),0) AS volume, COUNT(t."Amount") AS txn_count
			  FROM "Products" p JOIN "Transactions" t ON p."CIF Number"=t."CIF Number"
			  WHERE 1=1%s GROUP BY p."Product Name" ORDER BY volume DESC`, f.PG()),
			f.Args()...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		respond(w, data, src)
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
