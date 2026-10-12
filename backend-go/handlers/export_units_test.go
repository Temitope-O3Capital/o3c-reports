package handlers

import (
	"regexp"
	"strings"
	"testing"
)

/*
THE UNIT OF A MONEY COLUMN IS NOT A MATTER OF OPINION.

This registry shipped a column declared colMoney over a kobo value. colKobo divides by
100 and colMoney does not, so the retention export printed NGN 593,711,192,789 where the
truth was NGN 5,937,111,927.89 — a hundredfold overstatement, on the only report about
customer value, for as long as the dataset existed. The label on the same line said "Last
Active Year" over a naira figure.

Fixing that one line fixed one line. It did nothing about the next one, and the next one
arrived within hours: the 2026-10-09 coverage pass added 22 datasets, and two of them were
wrong the same way.

  - app.aml_rules.threshold was typed colKobo. It is POLYMORPHIC — 5 for the
    velocity_daily rule, meaning five transactions, and 500000000 for an amount rule,
    meaning NGN 5m in kobo. A single kobo column printed "five transactions" as NGN 0.05.
  - app.survey_responses.overall_score was typed colPct. It is an average rating out of
    TEN, and the Report Builder appends a % to colPct, so a 7.5 would have read "7.5%".

Both were written by someone who had fixed the first instance the same morning. That is
the argument for this test rather than for care.

THE RULE IT ENFORCES. A declared type must be justified by the expression it reads:

  - an expression over a *_kobo column must be colKobo, never colMoney or colInt;
  - a colKobo column must read a *_kobo source, or carry a reason here;
  - a colPct column must read something that is a rate by name, or carry a reason here.

Every exemption below names a value someone measured. "It looked like money" is not a
reason; "income_daily.amount_ngn is naira, multiplied by 100 so the kobo formatter
renders it correctly" is.
*/

var (
	// koboSourceRE was removed: "mentions a kobo column" produced false positives on
	// DPD and risk score, which pass kobo columns as function ARGUMENTS. See
	// isEssentiallyKobo for the predicate that replaced it.
	rateSourceRE = regexp.MustCompile(`_pct\b|_rate\b|_ratio\b|_score\b|_utilisation\b|_bps\b|[/*]\s*100`)
)

// unitExemptions are columns whose declared type is right despite not matching the rule,
// keyed "dataset.column". The value is why — and it must state what was measured.
var unitExemptions = map[string]string{
	// income_daily stores NAIRA in amount_ngn. The expression multiplies by 100 so the
	// colKobo formatter's divide-by-100 lands back on naira. Verified against the report:
	// income_daily holds 7,966 rows and the figures reconcile to the card book.
	"income_daily.amount": "amount_ngn is naira; the expression x100 feeds colKobo deliberately",

	// aml_rules.threshold holds kobo for an amount_threshold rule, and the column is not
	// named _kobo because for a velocity rule the same column holds a transaction COUNT.
	// The expression here isolates the amount case; threshold_count takes the other.
	// Measured 2026-10-09: 500000000 and 5000000000 on the two amount rules (NGN 5m and
	// NGN 50m), against a bare 5 on the velocity rule.
	"aml_rules.threshold_kobo": "ar.threshold is kobo for amount_threshold rules; see threshold_count",

	// cbsLoanArrears IS kobo — it sums s.principal_kobo + s.interest_kobo + fee_kobo from
	// the schedule, and falls back to app.cbs_loan_arrears_kobo(...). It cannot satisfy
	// isEssentiallyKobo because the same expression joins on account numbers and dates,
	// which are not kobo columns. Correct, and unprovable from the expression alone.
	"loan_book.arrears": "cbsLoanArrears sums *_kobo schedule columns; the non-kobo refs are join keys",
}

func TestMoneyColumnsAreTypedByTheirActualUnit(t *testing.T) {
	for _, d := range exportDatasets {
		for _, c := range d.Cols {
			id := d.Key + "." + c.Key
			reason, exempt := unitExemptions[id]
			readsKobo := isEssentiallyKobo(c.Expr)

			switch c.Type {
			case colMoney, colInt:
				// The exact shape of the original defect: a minor-unit value declared as
				// major units, which renders it a hundred times too large.
				if readsKobo && !exempt {
					t.Errorf("%s reads a *_kobo column but is typed %q.\n"+
						"colKobo divides by 100; %q does not, so this renders the value a "+
						"HUNDRED TIMES too large. Use colKobo, or add %q to unitExemptions "+
						"with what you measured.", id, c.Type, c.Type, id)
				}
			case colKobo:
				if !readsKobo && !exempt {
					t.Errorf("%s is typed colKobo but reads no *_kobo source: %s\n"+
						"colKobo divides by 100, so if that value is already naira — or is "+
						"not money at all — this renders it a hundred times too SMALL. "+
						"Check the column, then either retype it or add %q to "+
						"unitExemptions with what you measured.",
						id, firstLine(c.Expr), id)
				}
			case colPct:
				if !rateSourceRE.MatchString(c.Expr) && !exempt {
					t.Errorf("%s is typed colPct but reads nothing that is a rate by name: "+
						"%s\nThe Report Builder appends a %% to colPct, so a score out of 10 "+
						"or out of 5 renders as a percentage and reads as nonsense. Retype "+
						"it, or add %q to unitExemptions with the scale you measured.",
						id, firstLine(c.Expr), id)
				}
			}

			if exempt {
				t.Logf("%s exempt: %s", id, reason)
			}
		}
	}
}

// TestUnitExemptionsAreAllStillNeeded keeps the list from outliving its reasons. An
// exemption for a column that no longer exists, or that now matches the rule on its own,
// is clutter that makes the next reader trust the list less.
func TestUnitExemptionsAreAllStillNeeded(t *testing.T) {
	for id, reason := range unitExemptions {
		parts := strings.SplitN(id, ".", 2)
		if len(parts) != 2 {
			t.Errorf("unitExemptions key %q is not dataset.column", id)
			continue
		}
		d, ok := exportDatasetByKey(parts[0])
		if !ok {
			t.Errorf("unitExemptions names dataset %q, which is not in the registry — "+
				"remove the exemption", parts[0])
			continue
		}
		found := false
		for _, c := range d.Cols {
			if c.Key != parts[1] {
				continue
			}
			found = true
			// Would it pass without the exemption?
			needs := false
			// Deliberately the SAME predicate the main test uses. When these two drifted
			// apart — this one on a crude "mentions a kobo column" regex, the other on
			// isEssentiallyKobo — two live exemptions were reported as stale while still
			// being load-bearing. An exemption list that contradicts its own checker is
			// worse than no list.
			switch c.Type {
			case colMoney, colInt:
				needs = isEssentiallyKobo(c.Expr)
			case colKobo:
				needs = !isEssentiallyKobo(c.Expr)
			case colPct:
				needs = !rateSourceRE.MatchString(c.Expr)
			}
			if !needs {
				t.Errorf("%s no longer needs its exemption (%q) — the column now satisfies "+
					"the rule on its own. Delete the entry.", id, reason)
			}
		}
		if !found {
			t.Errorf("unitExemptions names column %q, which dataset %q does not have — "+
				"remove the exemption", parts[1], parts[0])
		}
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i]) + " …"
	}
	return strings.TrimSpace(s)
}

// isEssentiallyKobo reports whether an expression's VALUE is a minor-unit amount, which
// is not the same question as whether a kobo column appears anywhere in it.
//
// The distinction is load-bearing. cbsLoanDPD passes loan_amount_kobo and
// outstanding_principal_kobo as ARGUMENTS to app.cbs_loan_dpd(...), which returns a
// number of days. A rule that fired on any mention of a kobo column flagged DPD and the
// risk score as mistyped money — two false positives that would have taught the next
// reader to ignore this test.
//
// So: an expression is treated as a kobo value only when every column it references is
// itself a kobo column. A bare cl.value_kobo qualifies, COALESCE(x_kobo, 0) qualifies,
// and a six-argument function call over mixed columns does not.
func isEssentiallyKobo(expr string) bool {
	refs := columnRefRE.FindAllString(expr, -1)
	if len(refs) == 0 {
		return false
	}
	for _, r := range refs {
		if !strings.HasSuffix(r, "_kobo") {
			return false
		}
	}
	return true
}

// columnRefRE matches an alias-qualified column reference (cl.value_kobo), which is how
// every expression in this registry names its columns. Unqualified SQL keywords and
// function names are not matched, because they carry no dot.
var columnRefRE = regexp.MustCompile(`\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b`)
