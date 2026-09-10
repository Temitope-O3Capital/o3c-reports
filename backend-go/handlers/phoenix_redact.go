package handlers

// Masking national identity numbers in Phoenix payloads before they reach a browser.
//
// Phoenix stores BVN encrypted but decrypts it on read. Its Eye decision carries the
// plain BVN in customer.bvn and, inside the raw XDS bureau report, the BVN and NIN
// again under profile.identifications and profile.nin. The workspace passed that
// payload to the browser verbatim, so anyone who could open the Eye tab received a
// customer's full identity numbers, while every other workspace screen shows them
// masked to the last four. This restores that rule on the path that bypassed it.
//
// Only identity numbers are masked. Phone numbers, names and the rest of the credit
// report are left exactly as Phoenix sent them: it is still Phoenix's report, and the
// panel that renders it keeps working — it simply shows "BVN •••••••3128".

import (
	"bytes"
	"encoding/json"
	"strings"
)

// identifierKeys are field names whose string value is a national identity number.
var identifierKeys = map[string]bool{
	"bvn": true, "nin": true, "bvn_number": true, "nin_number": true,
	"national_id": true, "national_id_number": true, "id_number": true,
}

// The XDS profile lists BVN and NIN as {type, no} entries under "identifications",
// where the number sits in a generic field name that is only sensitive inside it.
var identificationArrays = map[string]bool{"identifications": true, "identification": true}
var identificationValueKeys = map[string]bool{"no": true, "number": true, "value": true, "id_number": true}

// maskIdentifierValue keeps the last four characters of anything that looks like an
// identity number. Short or non-numeric values ("Yes", a status code) pass through.
func maskIdentifierValue(s string) string {
	digits := 0
	for _, r := range s {
		if r >= '0' && r <= '9' {
			digits++
		}
	}
	rs := []rune(s)
	if digits < 8 || len(rs) <= 4 {
		return s
	}
	return strings.Repeat("•", len(rs)-4) + string(rs[len(rs)-4:])
}

func maskIdentifiersIn(v any, parentKey string) any {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			lk := strings.ToLower(k)
			if s, ok := val.(string); ok &&
				(identifierKeys[lk] || (identificationArrays[parentKey] && identificationValueKeys[lk])) {
				t[k] = maskIdentifierValue(s)
				continue
			}
			t[k] = maskIdentifiersIn(val, lk)
		}
		return t
	case []any:
		for i, el := range t {
			t[i] = maskIdentifiersIn(el, parentKey)
		}
		return t
	default:
		return v
	}
}

// maskPhoenixIdentifiers returns raw with every national identity number masked.
//
// Numbers are decoded as json.Number so amounts and probabilities are re-emitted
// digit-for-digit, and HTML escaping is off so text fields come out as Phoenix sent
// them. Key order is not preserved, which no reader of this payload depends on.
func maskPhoenixIdentifiers(raw []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	v = maskIdentifiersIn(v, "")
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
