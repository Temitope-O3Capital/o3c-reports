package handlers

import (
	"context"
	"log/slog"

	"github.com/o3c/workspace/core"
)

// ccResolveCustomerCIF finds the ONE card customer a lead's phone belongs to, or reports
// that it cannot.
//
// WHY THIS EXISTS. A conversion was recorded as a status and nothing else.
// call_center_leads.customer_cif has existed all along and was blank on all 20,587 leads —
// never filled once, by any code path. So a converted lead carried no identity: six real
// conversions with real cards behind them were invisible as revenue, and three claimed
// conversions with nothing behind them looked exactly the same. Measured 2026-10-06, every
// one of the nine call-centre conversions on the book had a NULL CIF.
//
// EXACTLY ONE MATCH, OR NONE. This is the load-bearing rule and it is not caution, it is
// the only thing that makes phone matching usable here. app.customers holds 8,739 customers
// on a SHARED number against 7,159 on a unique one, because the book is full of
// placeholders: 8012345678 carries 4,113 customers, 8000000000 another 2,235, and
// 0000000000 and 0812000000 dozens more. A "first match wins" lookup would attach a
// conversion — and a customer's identity — to whichever of four thousand people sorted
// first. Requiring a single match makes every placeholder resolve to nothing, which is the
// correct answer, without needing a list of placeholders to maintain.
//
// The length check is the second half. app.norm_phone returns an empty string rather than
// NULL for anything it cannot parse, so without it a blank lead phone matches every blank
// customer phone — the trap recorded against this codebase more than once.
//
// VALIDATED against the nine real conversions before being written: it resolves all six
// that hold a card (Umerah, Ozakpo, Ojo, Oshin, Okunade, Amos) and returns nothing for all
// three that do not (Orodu, Owolabi, Omolaja). It would have filled every CIF worth having
// and flagged every conversion worth questioning.
func ccResolveCustomerCIF(ctx context.Context, db *core.DB, phone string) (string, bool) {
	rows, err := db.PGQuery(ctx, `
		SELECT cu.cif
		  FROM app.customers cu
		 WHERE length(app.norm_phone(cu.phone)) = 10
		   AND app.norm_phone(cu.phone) = app.norm_phone($1)
		 LIMIT 2`, phone)
	if err != nil {
		slog.Error("ccResolveCustomerCIF: lookup failed", "err", err)
		return "", false
	}
	// LIMIT 2 so "more than one" costs one extra row rather than a count over the book.
	if len(rows) != 1 {
		return "", false
	}
	cif := str(rows[0]["cif"])
	if cif == "" {
		return "", false
	}
	return cif, true
}

// ccStampConversionCIF records which customer a converted lead became, when that can be
// established, and leaves it blank when it cannot.
//
// Blank is deliberately NOT treated as a failure to retry or an error to surface here. An
// unverified conversion is a real state — an agent may convert someone whose card has not
// been issued yet, so there is no CIF to find on the day — and the point is that it is now
// DISTINGUISHABLE from a verified one instead of indistinguishable. `status = 'converted'
// AND customer_cif IS blank` is the whole definition of an unverified conversion; it needs
// no column of its own and it corrects itself the moment the CIF lands.
//
// Only ever fills a blank. A CIF already on the lead was put there by someone who knew
// more than a phone match does.
func ccStampConversionCIF(ctx context.Context, db *core.DB, leadID int64, phone, origin string) {
	if leadID <= 0 {
		return
	}
	cif, ok := ccResolveCustomerCIF(ctx, db, phone)
	if !ok {
		slog.Info("conversion recorded without a CIF — unverified until one can be matched",
			"lead", leadID, "origin", origin)
		return
	}
	if _, err := db.PGExec(ctx, `
		UPDATE app.call_center_leads
		   SET customer_cif = $2, updated_at = NOW()
		 WHERE id = $1 AND COALESCE(btrim(customer_cif), '') = ''`, leadID, cif); err != nil {
		slog.Error("ccStampConversionCIF: write cif", "lead", leadID, "err", err)
		return
	}
	// The contact carries the same fact for the Sales pipeline, which reads converted_cif.
	// Same blank-only rule.
	db.PGExec(ctx, `
		UPDATE app.crm_contacts c
		   SET converted_cif = $2, updated_at = NOW()
		  FROM app.call_center_leads l
		 WHERE l.id = $1 AND c.id = l.contact_id
		   AND COALESCE(btrim(c.converted_cif), '') = ''`, leadID, cif) //nolint:errcheck
	slog.Info("conversion matched to a customer", "lead", leadID, "cif", cif, "origin", origin)
}
