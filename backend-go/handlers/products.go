package handlers

import (
	"regexp"
	"strings"
)

// Canonical Sales product taxonomy — the backend mirror of frontend/src/lib/products.ts.
// Three lines: Cards, Loans, Fixed Deposit. Sub-codes reuse the vocabulary already
// in the data (app.accounts.product_line, loan_applications.product_type) rather than
// inventing a third one. Keep this in step with the frontend file.

// ProductLine keys.
const (
	LineCards        = "cards"
	LineLoans        = "loans"
	LineFixedDeposit = "fixed_deposit"
)

// canonicalSubs maps each canonical sub-code to its line.
var canonicalSubs = map[string]string{
	"prepaid":       LineCards,
	"credit_card":   LineCards,
	"salary_loan":   LineLoans,
	"business_loan": LineLoans,
	"fixed_deposit": LineFixedDeposit,
}

// legacyAliases maps alternate/legacy codes to a canonical sub-code.
var legacyAliases = map[string]string{
	"personal_loan":       "business_loan",
	"individual_loan":     "business_loan",
	"card_limit_increase": "credit_card",
	"cc":                  "credit_card",
	"creditcard":          "credit_card",
	"prepaid_card":        "prepaid",
	"fd":                  "fixed_deposit",
}

var (
	reProdPrepaid = regexp.MustCompile(`prepaid`)
	reProdCredit  = regexp.MustCompile(`credit.?card|\bcc\b`)
	reProdSalary  = regexp.MustCompile(`salary`)
	reProdBiz     = regexp.MustCompile(`business`)
	reProdFD      = regexp.MustCompile(`fixed.?deposit|\bfd\b|term.?dep`)
	reProdLoan    = regexp.MustCompile(`loan`)
	reProdCard    = regexp.MustCompile(`card`)
)

// NormalizeProductCode maps any raw product string to a canonical sub-code, or ""
// if it can't be classified.
func NormalizeProductCode(raw string) string {
	if raw == "" {
		return ""
	}
	k := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(raw)), " ", "_")
	if _, ok := canonicalSubs[k]; ok {
		return k
	}
	if a, ok := legacyAliases[k]; ok {
		return a
	}
	switch {
	case reProdPrepaid.MatchString(k):
		return "prepaid"
	case reProdCredit.MatchString(k):
		return "credit_card"
	case reProdSalary.MatchString(k):
		return "salary_loan"
	case reProdBiz.MatchString(k):
		return "business_loan"
	case reProdFD.MatchString(k):
		return "fixed_deposit"
	case reProdLoan.MatchString(k):
		return "business_loan"
	case reProdCard.MatchString(k):
		return "credit_card"
	}
	return ""
}

// ProductLineOf returns the canonical line ("cards"/"loans"/"fixed_deposit") for a
// raw/canonical product code, or "" if unclassifiable.
func ProductLineOf(raw string) string {
	code := NormalizeProductCode(raw)
	if code == "" {
		return ""
	}
	return canonicalSubs[code]
}

// IsSalesProductCode reports whether a raw code classifies into one of the three lines.
func IsSalesProductCode(raw string) bool {
	return NormalizeProductCode(raw) != ""
}

// SubsForLine returns the canonical sub-codes under a product line, for building
// IN-clauses that filter by line. Returns nil for an unknown line.
func SubsForLine(line string) []string {
	line = strings.ToLower(strings.TrimSpace(line))
	var out []string
	for code, l := range canonicalSubs {
		if l == line {
			out = append(out, code)
		}
	}
	return out
}
