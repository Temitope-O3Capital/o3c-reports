package handlers

// Audience resolution — the one place that answers "who may receive this".
//
// WHY THIS EXISTS. The workspace can already see who its customers are: migration 289
// scores 21,267 parties nightly into app.customer_lifecycle with a bucket, a value tier
// and whether we hold any money history for them at all. What it could not do was turn
// that into a list anyone is allowed to contact, so every sending surface answered the
// question for itself — and answered it differently:
//
//   * Campaign audiences came from CSV uploads and consulted nothing.
//   * The collections dialler feed checked neither consent nor suppression.
//   * The arrears reminder checked app.is_suppressed and did NOT look at consent once
//     (grep party_contact_consent in collections_dunning.go: zero hits).
//
// One resolver, consulted by all of them, is the only way those three stay in step.
//
// THE FINDING THAT SHAPED THIS. Measured 2026-09-29, app.party_contact_consent holds
// 35,780 rows. Every one of them is purpose='servicing', state='granted', on channel
// 'email' or 'sms'. There is NO marketing consent for anybody, and no WhatsApp consent
// on any purpose.
//
// So the most valuable thing this function does is REFUSE. Ask it for a marketing
// audience today and it returns nobody, and says why. That is not a limitation to work
// around; it is the answer. A win-back campaign to 4,615 "workable" customers is one
// SQL query away in any surface that skips this, and it would be 4,615 marketing
// messages sent without a lawful basis.
//
// HONESTY RULES, same discipline as lib/measure.ts on the client:
//   * Exclusions are COUNTED BY REASON and the counts sum to the population examined.
//     A caller is told "812 excluded: 403 no consent, 221 no money history…", never a
//     bare smaller number.
//   * The FIRST failing reason is the one reported, in a fixed order, so a party is
//     counted once and the arithmetic holds.
//   * bucket='unknown' means we hold no transaction history, NOT that the customer is
//     inactive — app.transactions is card-only and there is no savings ledger. 13,329
//     of 21,267 parties sit there. Targeting them on behaviour is asserting something
//     never measured, so RequireMeasured defaults to true.

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// audiencePurpose is the lawful basis the send is made under, and it decides which
// consent row is required. These are the values app.party_contact_consent.purpose
// actually carries — not a vocabulary invented here.
const (
	purposeServicing = "servicing" // about something the customer already holds
	purposeMarketing = "marketing" // an offer; needs consent nobody has yet
)

// audienceChannels are the channels a message can go out on. 'call' is included
// because the dialler queue is an audience too — a contact centre list is a send.
var audienceChannels = map[string]bool{
	"email": true, "sms": true, "whatsapp": true, "call": true,
}

// Exclusion reasons, in the order they are tested. Order is part of the contract:
// each party is counted against the FIRST reason it fails, so the counts add up.
const (
	exNoMoneyHistory = "no_money_history"
	exNoContact      = "no_contact_details"
	exInCollections  = "in_collections"
	exNoAddress      = "no_address_for_channel"
	exNoConsent      = "no_consent"
	exSuppressed     = "suppressed"
)

// AudienceSpec is a request for people to contact.
type AudienceSpec struct {
	Purpose string   // servicing | marketing
	Channel string   // email | sms | whatsapp | call
	Buckets []string // lifecycle buckets; empty = any
	Tiers   []string // value tiers; empty = any
	// MinValueKobo drops customers below a materiality floor, the same idea as the
	// arrears reminder's: contacting someone costs something, so it should be worth it.
	MinValueKobo int64
	// RequireMeasured excludes bucket='unknown'. Defaults on — see the header.
	RequireMeasured bool
	// ExcludeInCollections keeps someone who owes money out of a marketing list. It is
	// the right guard for an offer and the WRONG one for an arrears reminder, where
	// those people are the entire point, so the caller states it rather than inheriting.
	ExcludeInCollections bool
	Limit                int
}

// AudienceMember is one contactable person, already checked.
type AudienceMember struct {
	PartyID   int64  `json:"party_id"`
	Name      string `json:"name"`
	Address   string `json:"address"` // the email or phone this channel would use
	Bucket    string `json:"bucket"`
	Tier      string `json:"value_tier"`
	ValueKobo int64  `json:"value_kobo"`
}

// AudienceResult is the answer, including everyone who did not make it and why.
type AudienceResult struct {
	Members []AudienceMember `json:"members"`
	// Examined is the population the filters selected, before eligibility.
	Examined int64 `json:"examined"`
	Eligible int64 `json:"eligible"`
	// ExcludedBy sums to Examined - Eligible.
	ExcludedBy map[string]int64 `json:"excluded_by"`
	// Refusal is set when the whole request is unlawful or impossible, in which case
	// Members is empty and the text says what would have to change.
	Refusal string `json:"refusal,omitempty"`
}

// ResolveAudience answers who may receive a message of this purpose on this channel.
//
// It returns a Refusal, not an error, when the request is well-formed but nobody can
// lawfully receive it — an empty list with a reason is a usable answer; an error is
// something a caller logs and forgets.
func ResolveAudience(ctx context.Context, db *core.DB, spec AudienceSpec) (AudienceResult, error) {
	out := AudienceResult{Members: []AudienceMember{}, ExcludedBy: map[string]int64{}}

	purpose := strings.ToLower(strings.TrimSpace(spec.Purpose))
	channel := strings.ToLower(strings.TrimSpace(spec.Channel))
	if purpose != purposeServicing && purpose != purposeMarketing {
		return out, fmt.Errorf("purpose must be %q or %q", purposeServicing, purposeMarketing)
	}
	if !audienceChannels[channel] {
		return out, fmt.Errorf("unknown channel %q", channel)
	}

	// Refuse before querying when no consent of this shape exists anywhere. Running the
	// query would return an empty list that reads like "nobody matched your filters",
	// which is a different and much more misleading statement than "nobody on this book
	// has ever consented to this".
	if why := audienceConsentRefusal(ctx, db, purpose, channel); why != "" {
		out.Refusal = why
		return out, nil
	}

	limit := spec.Limit
	if limit <= 0 || limit > 5000 {
		limit = 500
	}

	rows, err := db.PGQuery(ctx, `
		WITH base AS (
		  SELECT cl.party_id, cl.bucket, cl.value_tier, cl.value_kobo,
		         cl.measured, cl.contactable, cl.has_open_recovery,
		         COALESCE(NULLIF(TRIM(v.full_name),''),'') AS full_name,
		         COALESCE(NULLIF(TRIM(v.email),''),'')     AS email,
		         COALESCE(NULLIF(TRIM(v.phone),''),'')     AS phone
		    FROM app.customer_lifecycle cl
		    LEFT JOIN app.v_contact_identity v ON v.party_id = cl.party_id
		   WHERE ($1 = '' OR cl.bucket     = ANY(string_to_array($1, ',')))
		     AND ($2 = '' OR cl.value_tier = ANY(string_to_array($2, ',')))
		     AND cl.value_kobo >= $3
		), judged AS (
		  SELECT b.*,
		         CASE WHEN $6 = 'email' THEN b.email ELSE b.phone END AS address,
		         CASE
		           -- Order is the contract: first failure wins, so counts sum.
		           WHEN $4 AND NOT b.measured        THEN '` + exNoMoneyHistory + `'
		           WHEN NOT b.contactable            THEN '` + exNoContact + `'
		           WHEN $5 AND b.has_open_recovery   THEN '` + exInCollections + `'
		           WHEN ($6 = 'email' AND b.email = '')
		             OR ($6 <> 'email' AND length(app.norm_phone(b.phone)) <> 10)
		                                             THEN '` + exNoAddress + `'
		           WHEN NOT EXISTS (
		                  SELECT 1 FROM app.party_contact_consent c
		                   WHERE c.party_id = b.party_id
		                     AND c.channel  = $6
		                     AND c.purpose  = $7
		                     AND c.state    = 'granted'
		                     AND (c.expires_at IS NULL OR c.expires_at > NOW())
		                )                            THEN '` + exNoConsent + `'
		           WHEN app.is_suppressed(b.party_id, b.phone, b.email, $6)
		                                             THEN '` + exSuppressed + `'
		           ELSE NULL
		         END AS excluded_because
		    FROM base b
		)
		SELECT party_id, full_name, address, bucket, value_tier, value_kobo, excluded_because,
		       COUNT(*) OVER ()                                      AS examined,
		       COUNT(*) FILTER (WHERE excluded_because IS NULL) OVER () AS eligible
		  FROM judged
		 ORDER BY (excluded_because IS NULL) DESC, value_kobo DESC
		 LIMIT $8`,
		strings.Join(spec.Buckets, ","), strings.Join(spec.Tiers, ","), spec.MinValueKobo,
		spec.RequireMeasured, spec.ExcludeInCollections, channel, purpose, limit)
	if err != nil {
		return out, fmt.Errorf("resolve audience: %w", err)
	}

	// The window counts ride on every row, so an empty result means an empty population
	// rather than a missing count.
	if len(rows) > 0 {
		out.Examined = toInt64(rows[0]["examined"])
		out.Eligible = toInt64(rows[0]["eligible"])
	}
	for _, r := range rows {
		if reason := str(r["excluded_because"]); reason != "" {
			continue // counted separately below; the sample only carries eligible people
		}
		out.Members = append(out.Members, AudienceMember{
			PartyID:   toInt64(r["party_id"]),
			Name:      str(r["full_name"]),
			Address:   str(r["address"]),
			Bucket:    str(r["bucket"]),
			Tier:      str(r["value_tier"]),
			ValueKobo: toInt64(r["value_kobo"]),
		})
	}

	// Exclusion counts come from a second pass over the whole population, not from the
	// LIMITed page: a caller sizing a segment needs the real totals, and the page is a
	// sample. Cheap — the same indexed scan.
	if err := audienceExclusionCounts(ctx, db, spec, purpose, channel, &out); err != nil {
		return out, err
	}
	return out, nil
}

// audienceConsentRefusal returns a sentence when nothing of this shape could ever
// qualify, or "" when the request is worth running.
func audienceConsentRefusal(ctx context.Context, db *core.DB, purpose, channel string) string {
	rows, err := db.PGQuery(ctx, `
		SELECT COUNT(*) FILTER (WHERE purpose = $1)                    AS for_purpose,
		       COUNT(*) FILTER (WHERE purpose = $1 AND channel = $2)   AS for_both
		  FROM app.party_contact_consent
		 WHERE state = 'granted'`, purpose, channel)
	if err != nil || len(rows) == 0 {
		return "" // a failed check must not silently authorise; the per-row test still runs
	}
	if toInt64(rows[0]["for_both"]) > 0 {
		return ""
	}
	if toInt64(rows[0]["for_purpose"]) == 0 {
		return fmt.Sprintf(
			"No customer has granted %s consent on any channel, so this audience is empty "+
				"as a matter of law rather than of filtering. Consent must be captured before "+
				"a %s message can be sent to anyone.", purpose, purpose)
	}
	return fmt.Sprintf(
		"No customer has granted %s consent on %s. Consent exists for this purpose on other "+
			"channels, so either capture it for %s or send on a channel that has it.",
		purpose, channel, channel)
}

// audienceExclusionCounts fills ExcludedBy over the whole population.
func audienceExclusionCounts(ctx context.Context, db *core.DB, spec AudienceSpec,
	purpose, channel string, out *AudienceResult) error {
	rows, err := db.PGQuery(ctx, `
		WITH base AS (
		  SELECT cl.party_id, cl.measured, cl.contactable, cl.has_open_recovery,
		         COALESCE(NULLIF(TRIM(v.email),''),'') AS email,
		         COALESCE(NULLIF(TRIM(v.phone),''),'') AS phone
		    FROM app.customer_lifecycle cl
		    LEFT JOIN app.v_contact_identity v ON v.party_id = cl.party_id
		   WHERE ($1 = '' OR cl.bucket     = ANY(string_to_array($1, ',')))
		     AND ($2 = '' OR cl.value_tier = ANY(string_to_array($2, ',')))
		     AND cl.value_kobo >= $3
		)
		SELECT CASE
		         WHEN $4 AND NOT measured      THEN '` + exNoMoneyHistory + `'
		         WHEN NOT contactable          THEN '` + exNoContact + `'
		         WHEN $5 AND has_open_recovery THEN '` + exInCollections + `'
		         WHEN ($6 = 'email' AND email = '')
		           OR ($6 <> 'email' AND length(app.norm_phone(phone)) <> 10)
		                                       THEN '` + exNoAddress + `'
		         WHEN NOT EXISTS (
		                SELECT 1 FROM app.party_contact_consent c
		                 WHERE c.party_id = base.party_id AND c.channel = $6
		                   AND c.purpose = $7 AND c.state = 'granted'
		                   AND (c.expires_at IS NULL OR c.expires_at > NOW())
		              )                        THEN '` + exNoConsent + `'
		         WHEN app.is_suppressed(party_id, phone, email, $6)
		                                       THEN '` + exSuppressed + `'
		         ELSE 'eligible'
		       END AS reason,
		       COUNT(*) AS n
		  FROM base
		 GROUP BY 1`,
		strings.Join(spec.Buckets, ","), strings.Join(spec.Tiers, ","), spec.MinValueKobo,
		spec.RequireMeasured, spec.ExcludeInCollections, channel, purpose)
	if err != nil {
		return fmt.Errorf("audience exclusion counts: %w", err)
	}
	var examined, eligible int64
	for _, r := range rows {
		n := toInt64(r["n"])
		examined += n
		if str(r["reason"]) == "eligible" {
			eligible = n
			continue
		}
		out.ExcludedBy[str(r["reason"])] = n
	}
	out.Examined, out.Eligible = examined, eligible
	return nil
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

// RegisterAudience mounts the sizing endpoint. Read-only: it never sends anything, it
// answers how many could be sent to and who would be left out.
func RegisterAudience(r chi.Router, db *core.DB) {
	access := core.RequirePages("campaigns", "reports", "executive")
	r.With(access).Get("/preview", audiencePreview(db))
}

func audiencePreview(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		spec := AudienceSpec{
			Purpose: qstr(r, "purpose"),
			Channel: qstr(r, "channel"),
			// Defaults are the cautious reading: do not target people we have never
			// measured, and keep customers in collections out of an offer. A caller
			// that means otherwise says so explicitly.
			RequireMeasured:      qstr(r, "require_measured") != "false",
			ExcludeInCollections: qstr(r, "exclude_in_collections") != "false",
		}
		if v := strings.TrimSpace(qstr(r, "buckets")); v != "" {
			spec.Buckets = strings.Split(v, ",")
		}
		if v := strings.TrimSpace(qstr(r, "tiers")); v != "" {
			spec.Tiers = strings.Split(v, ",")
		}
		if v := strings.TrimSpace(qstr(r, "min_value_kobo")); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil && n >= 0 {
				spec.MinValueKobo = n
			}
		}
		if v := strings.TrimSpace(qstr(r, "limit")); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				spec.Limit = n
			}
		}
		res, err := ResolveAudience(r.Context(), db, spec)
		if err != nil {
			respondErr(w, 400, err.Error())
			return
		}
		respond(w, res, "pg")
	}
}
