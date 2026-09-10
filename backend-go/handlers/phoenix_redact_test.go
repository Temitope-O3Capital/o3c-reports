package handlers

import (
	"encoding/json"
	"strings"
	"testing"
)

// The shape mirrors a real Phoenix Eye decision: the BVN in customer.bvn, and the
// BVN and NIN again inside the XDS report. The numbers here are made up.
func TestMaskPhoenixIdentifiers(t *testing.T) {
	in := `{
	  "customer": {"bvn": "22100000128", "full_name": "Test Applicant", "phone": "08012345678"},
	  "bureau_query": {"bureau_json": {"xds": {
	    "raw": {"data": {"profile": {
	      "identifications": [{"type": "BVN", "no": "22100000128"}, {"type": "NIN", "no": "12345674533"}],
	      "phone_number": ["08012343910"]}}},
	    "summary": {"profile": {"nin": "12345674533", "phone": "08012343910"}, "bureau_score": 594}}}},
	  "scoring_record": {"probability_of_default": 0.052, "max_loan_amount_minor": 216000000},
	  "bvn_confirmed": "Yes",
	  "reasons": ["DTI <= 40% & stable"]
	}`

	out, err := maskPhoenixIdentifiers([]byte(in))
	if err != nil {
		t.Fatalf("mask: %v", err)
	}
	s := string(out)

	for _, leaked := range []string{"22100000128", "12345674533"} {
		if strings.Contains(s, leaked) {
			t.Errorf("identity number %s survived masking", leaked)
		}
	}
	for _, kept := range []string{
		"•••••••0128", "•••••••4533", // last four kept, so the panel still identifies the record
		"08012345678", "08012343910", // phone numbers are not identity numbers
		`"bvn_confirmed":"Yes"`, // non-numeric values pass through
		`"bureau_score":594`, `"probability_of_default":0.052`, `"max_loan_amount_minor":216000000`,
		`"DTI <= 40% & stable"`, // no HTML escaping of Phoenix's text
	} {
		if !strings.Contains(s, kept) {
			t.Errorf("expected %q in output", kept)
		}
	}

	var v map[string]any
	if err := json.Unmarshal(out, &v); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
}

func TestMaskPhoenixIdentifiersRejectsBadJSON(t *testing.T) {
	if _, err := maskPhoenixIdentifiers([]byte(`{"bvn": `)); err == nil {
		t.Fatal("malformed input must fail so the caller can refuse rather than leak")
	}
}
