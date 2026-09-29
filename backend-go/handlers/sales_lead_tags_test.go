package handlers

import (
	"reflect"
	"testing"
)

// TestPgTextArray pins the conversion that took the Leads page down.
//
// Postgres text[] reaches the handler as a string, because core.normalizeVal turns every
// []byte into one. The empty case is the one that actually broke: "{}" is two characters
// long, so a `tags?.length` guard in the browser passed and then .map threw on a string.
// Every case below is a literal Postgres can emit for a tag that the CHECK in migration 314
// would accept.
func TestPgTextArray(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want []string
	}{
		{"empty array is empty, not one blank element", "{}", []string{}},
		{"single", "{corporate}", []string{"corporate"}},
		{"several", "{corporate,vip}", []string{"corporate", "vip"}},
		// A two-word tag is ALWAYS quoted by Postgres, so this is the common real case.
		{"quoted with a space", `{"price objection"}`, []string{"price objection"}},
		{"mixed quoted and bare", `{corporate,"price objection",vip}`,
			[]string{"corporate", "price objection", "vip"}},
		{"hyphen and underscore survive", "{call-back,not_now}", []string{"call-back", "not_now"}},
		// Defensive: none of these should ever arrive, but each one used to be a panic or a
		// page-breaking value rather than an empty list.
		{"nil", nil, []string{}},
		{"not an array literal", "corporate", []string{}},
		{"truncated", "{corporate", []string{}},
		{"already a slice passes through", []string{"corporate"}, []string{"corporate"}},
		{"NULL element dropped", "{corporate,NULL}", []string{"corporate"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := pgTextArray(c.in)
			if got == nil {
				t.Fatalf("returned nil, which encodes as JSON null and breaks .map the same "+
					"way the bug did; want %#v", c.want)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("pgTextArray(%#v) = %#v, want %#v", c.in, got, c.want)
			}
		})
	}
}

// TestCanonicalTagMatchesTheDatabaseCheck keeps the Go normaliser and the CHECK in
// migration 314 in step. If they drift, a tag the form accepts is refused by the database
// as a 500 rather than explained as a 422.
func TestCanonicalTagMatchesTheDatabaseCheck(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Corporate", "corporate"},
		{"  corporate  ", "corporate"},
		{"PRICE   OBJECTION", "price objection"}, // internal runs collapse
		{"Call-Back", "call-back"},
	}
	for _, c := range cases {
		if got := canonicalTag(c.in); got != c.want {
			t.Errorf("canonicalTag(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// tagIsValid is applied to the ALREADY-canonical form, so these are the shapes that
	// survive canonicalTag and must still be refused — the same set the CHECK refuses.
	// A leading space is deliberately NOT in this list: canonicalTag trims it, so
	// " corporate" legitimately becomes a valid tag rather than an error.
	for _, bad := range []string{"a", "-leading", "_leading", "has!bang", "", "ünïcode",
		"thisisfarfartoolongtobeareasonablelabelforanyone"} {
		if tagIsValid(bad) {
			t.Errorf("tagIsValid accepted %q, which the database CHECK rejects", bad)
		}
	}
	for _, good := range []string{"corporate", "price objection", "call-back", "not_now", "q4"} {
		if !tagIsValid(canonicalTag(good)) {
			t.Errorf("tagIsValid rejected %q, which the database CHECK accepts", good)
		}
	}
	// And the pairing that matters: anything a user can type, once canonicalised, is either
	// valid or explained — never silently different from what the database will store.
	for _, typed := range []string{"Corporate", "  Price   Objection  ", "CALL-BACK"} {
		c := canonicalTag(typed)
		if !tagIsValid(c) {
			t.Errorf("canonicalTag(%q) = %q, which tagIsValid then rejects", typed, c)
		}
	}
}
