package handlers

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

// Every role named in a handler gate must be a role that actually exists.
//
// This is the test that would have caught "head_sales". It was named in crm.go,
// sales.go and sales_book.go but absent from core.RolePages — a retired slug that
// migration 141 remapped to sales_head. Two consequences, both silent: a gate keyed
// on it can never match (so the branch is dead), and if anyone HAD been given it as
// a primary role they would have signed in with no pages at all, because RolePages
// has no entry to resolve.
//
// Scoped to callerHasRole arguments deliberately. Role strings also appear in SQL
// `role IN (...)` roster filters, where naming a retired role is harmless and
// sometimes deliberately defensive — "account_officer" is still listed in
// salesOfficerPredicate and is held by one inactive account. A gate is different: it
// decides access, so a name that cannot exist is a bug rather than belt-and-braces.
func TestEveryRoleNamedInAHandlerGateExists(t *testing.T) {
	// callerHasRole(user, "a", "b") — capture the whole argument list, then the
	// quoted strings inside it.
	call := regexp.MustCompile(`callerHasRole\(([^)]*)\)`)
	quoted := regexp.MustCompile(`"([^"]*)"`)

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the handlers package: %v", err)
	}

	checked, found := 0, 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		checked++
		for _, site := range call.FindAllStringSubmatch(string(src), -1) {
			for _, m := range quoted.FindAllStringSubmatch(site[1], -1) {
				role := m[1]
				if role == "" {
					continue // the blank-never-matches guard, covered by its own test
				}
				found++
				if _, ok := core.RolePages[role]; !ok {
					t.Errorf("%s gates on role %q, which is not in core.RolePages — "+
						"a holder would get no pages, and this gate can never match",
						name, role)
				}
			}
		}
	}

	if checked == 0 {
		t.Fatal("scanned no handler files, so this test proves nothing")
	}
	if found == 0 {
		t.Fatal("found no callerHasRole role arguments, so this test proves nothing")
	}
	t.Logf("%d handler files scanned, %d gate role name(s) all present in RolePages", checked, found)
}
