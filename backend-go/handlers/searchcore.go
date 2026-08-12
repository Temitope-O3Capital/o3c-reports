package handlers

import (
	"fmt"
	"regexp"
	"strings"
)

// searchcore holds the shared, reusable primitives every search endpoint builds on,
// so the whole app matches customers/tickets/accounts the same accurate way instead
// of each handler hand-rolling its own (subtly different, usually weaker) WHERE clause.
//
// Three problems it solves centrally:
//   1. Phone formats — a Nigerian number is stored as 08012345678 but a user may type
//      +2348012345678, 234 801 234 5678 or the last few digits. normalizePhone reduces
//      both sides to the last 10 significant digits so any format matches.
//   2. Wildcard abuse — a stray % or _ in the query would otherwise act as a LIKE
//      wildcard (a lone % returns the whole table). escapeLike neutralises them.
//   3. Multi-word names — "john smith", "smith john" and partials all have to work, so
//      the query is tokenised and every token must match at least one column.

var nonDigitRe = regexp.MustCompile(`\D`)

// normalizePhone reduces a phone string to its last 10 significant digits — the
// canonical form for Nigerian numbers. 08033153664, +2348033153664, "234 803 315 3664"
// and 8033153664 all collapse to 8033153664. Returns "" when fewer than 4 digits
// remain (too short to be a useful phone fragment; short numeric strings like a CIF
// are matched by the text columns instead).
func normalizePhone(s string) string {
	d := nonDigitRe.ReplaceAllString(s, "")
	if len(d) > 10 {
		d = d[len(d)-10:]
	}
	if len(d) < 4 {
		return ""
	}
	return d
}

// escapeLike escapes the LIKE/ILIKE metacharacters (\ % _) so user input is matched
// literally. Postgres ILIKE uses backslash as the default escape, so no ESCAPE clause
// is needed alongside this.
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// normalizedPhoneExpr returns the SQL that canonicalises a stored phone column to its
// last 10 digits — the column-side twin of normalizePhone. Any functional index used
// to accelerate phone search must be built on this exact expression.
func normalizedPhoneExpr(col string) string {
	return fmt.Sprintf(`right(regexp_replace(coalesce(%s,''),'\D','','g'),10)`, col)
}

// buildCustomerSearch builds a tokenised, wildcard-safe, phone-normalised match
// fragment for a WHERE clause. The query is split on whitespace (max 6 tokens) and
// EACH token must match at least one of textCols (case-insensitive substring) or, when
// phoneCol is set and the token looks like a phone, the normalised phone. So "john
// smith", "smith john", a partial fragment, a CIF, or a phone tail all work.
//
// startArg is the first positional-parameter number to use ($startArg, $startArg+1…).
// Returns the SQL boolean expression, the args to append in order, and the next free
// parameter number. When the query is blank it returns ("", nil, startArg) so callers
// can skip adding a clause.
func buildCustomerSearch(query string, textCols []string, phoneCol string, startArg int) (string, []any, int) {
	toks := strings.Fields(query)
	if len(toks) > 6 {
		toks = toks[:6]
	}
	if len(toks) == 0 || len(textCols) == 0 {
		return "", nil, startArg
	}
	n := startArg
	var args []any
	var ands []string
	for _, tok := range toks {
		var ors []string
		args = append(args, "%"+escapeLike(tok)+"%")
		idx := n
		n++
		for _, col := range textCols {
			ors = append(ors, fmt.Sprintf(`%s ILIKE $%d`, col, idx))
		}
		if phoneCol != "" {
			if np := normalizePhone(tok); np != "" {
				args = append(args, "%"+np)
				ors = append(ors, fmt.Sprintf(`%s LIKE $%d`, normalizedPhoneExpr(phoneCol), n))
				n++
			}
		}
		ands = append(ands, "("+strings.Join(ors, " OR ")+")")
	}
	return "(" + strings.Join(ands, " AND ") + ")", args, n
}
