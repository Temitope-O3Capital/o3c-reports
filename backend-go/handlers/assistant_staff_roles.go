package handlers

// Turning the words people use for a job into the role values the directory
// stores.
//
// o3c_users.role is not only an access level. It carries md, cfo, coo, cmo,
// head_ops, risk_head, cards_head, settlement_head, care_head,
// call_center_head, internal_control_head, compliance_officer, hr and
// account_officer, so it doubles as the job title. "Who is the CEO?" was being
// refused not because the answer was missing but because find_staff had no
// parameter to search it with.
//
// The gap between how a question is phrased and how a role is stored is the
// whole problem. Nobody types "internal_control_head". They ask who heads
// internal control, or who runs audit. And in a Nigerian bank the person others
// would call the CEO is the MD -- staff ask it both ways, and getting that one
// wrong means the most senior person in the company is unfindable.

import (
	"regexp"
	"strings"
)

var assistantRoleNonWord = regexp.MustCompile(`[^a-z0-9]+`)

// Filler that carries no meaning in a job-title question.
var assistantRoleFiller = map[string]bool{
	"the": true, "of": true, "our": true, "a": true, "an": true, "for": true,
	"department": true, "dept": true, "team": true, "unit": true, "is": true,
	"who": true, "in": true, "at": true, "and": true,
}

// A leading verb or honorific is how the question is phrased, not part of the
// stored value: the column spells it risk_head, not head_risk or heads_risk.
// Only ever stripped from the FRONT, so "sales head" keeps its suffix.
var assistantRoleLeadIn = map[string]bool{
	"head": true, "heads": true, "heading": true, "chief": true,
	"runs": true, "running": true, "leads": true, "leading": true,
	"manages": true, "managing": true, "oversees": true, "incharge": true,
}

// assistantRoleToken reduces a phrase to a single underscored token that can be
// matched against the role column: "head of risk" and "risk head" both become
// something that finds risk_head.
func assistantRoleToken(q string) string {
	s := assistantRoleNonWord.ReplaceAllString(strings.ToLower(strings.TrimSpace(q)), " ")
	words := make([]string, 0, 4)
	for _, w := range strings.Fields(s) {
		if assistantRoleFiller[w] {
			continue
		}
		words = append(words, w)
	}
	for len(words) > 1 && assistantRoleLeadIn[words[0]] {
		words = words[1:]
	}
	return strings.Join(words, "_")
}

// assistantRoleRawToken keeps the lead-in words. It is tried against the alias
// table FIRST, because stripping a verb can destroy a real title: "managing
// director" lost its "managing" and resolved to "director", which matches
// nothing. Checking the phrase as asked before reducing it means a future
// collision of the same shape resolves correctly without another special case.
func assistantRoleRawToken(q string) string {
	s := assistantRoleNonWord.ReplaceAllString(strings.ToLower(strings.TrimSpace(q)), " ")
	words := make([]string, 0, 4)
	for _, w := range strings.Fields(s) {
		if assistantRoleFiller[w] {
			continue
		}
		words = append(words, w)
	}
	return strings.Join(words, "_")
}

// assistantRoleAliases maps a normalised token to the role values that answer
// it. Several map to more than one because the question is genuinely ambiguous:
// "who handles settlements" could mean the head or the officers, so return both
// and let the answer name them.
var assistantRoleAliases = map[string][]string{
	"md": {"md"}, "ceo": {"md"}, "managing_director": {"md"},
	"chief_executive": {"md"}, "executive": {"md"},

	"cfo": {"cfo"}, "financial_officer": {"cfo"}, "financial": {"cfo"},
	"finance": {"cfo", "finance_officer"}, "finance_head": {"cfo"},

	"coo": {"coo"}, "operating_officer": {"coo"},
	"operations": {"coo", "head_ops"}, "operations_head": {"head_ops", "coo"},
	"ops": {"head_ops", "coo"}, "ops_head": {"head_ops"},

	"cmo": {"cmo"}, "marketing": {"cmo"}, "marketing_head": {"cmo"},
	"marketing_officer": {"cmo"},

	"sales": {"sales_head", "sales_officer"}, "sales_head": {"sales_head"},
	"risk": {"risk_head", "risk_officer"}, "risk_head": {"risk_head"},
	"compliance":       {"compliance_officer"},
	"internal_control": {"internal_control_head"},
	"audit":            {"internal_control_head"}, "control": {"internal_control_head"},
	"cards":       {"cards_head"},
	"settlement":  {"settlement_head", "settlement_officer"},
	"settlements": {"settlement_head", "settlement_officer"},
	"care":        {"care_head", "care_agent"}, "customer_care": {"care_head"},
	"support":        {"care_head"},
	"call_center":    {"call_center_head", "call_center_agent"},
	"call_centre":    {"call_center_head", "call_center_agent"},
	"contact_center": {"call_center_head"}, "contact_centre": {"call_center_head"},
	"hr": {"hr"}, "human_resources": {"hr"}, "people": {"hr"},
	"collections": {"collections_agent"}, "recovery": {"recovery_agent"},
	"account_officer":      {"account_officer"},
	"relationship_officer": {"account_officer"},
}

// assistantRoleCandidates returns the exact role values to try for a phrase.
// An unrecognised phrase still returns its own token, because the caller also
// matches the role column loosely and a token we have never seen may well be a
// role we have never been asked about.
func assistantRoleCandidates(q string) []string {
	if roles, ok := assistantRoleAliases[assistantRoleRawToken(q)]; ok {
		return roles
	}
	t := assistantRoleToken(q)
	if t == "" {
		return []string{""}
	}
	if roles, ok := assistantRoleAliases[t]; ok {
		return roles
	}
	return []string{t}
}
