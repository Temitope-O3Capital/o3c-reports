package handlers

import (
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// The People Directory reads app.o3c_users — the sign-in table. That table holds the
// company's staff list AND its credentials, so this module has exactly two ways to
// go wrong: it could be reachable by someone who should not see the staff register,
// or it could select a column it has no business selecting. Both are asserted here.
//
// The gate is tested by its observable split rather than by injecting claims:
// core.ctxKey is unexported with no setter, so a handlers test cannot put a
// *core.Claims into a request context. With no user in context RequirePages answers
// 401, so a 401 proves the gate refused before the handler ran.

func peopleTestRouter() chi.Router {
	r := chi.NewRouter()
	// A nil *core.DB is safe: the gate runs before any handler body, and every route
	// in this module is behind the gate. If one ever is not, the nil DB panics and
	// this test fails loudly — which is the outcome we want.
	r.Route("/api/people", func(r chi.Router) {
		RegisterPeople(r, nil)
	})
	return r
}

var peopleRouteParam = regexp.MustCompile(`\{[^}]*\}`)

func TestPeopleDirectoryRefusesAnyoneWithoutThePage(t *testing.T) {
	r := peopleTestRouter()

	var routes []struct{ method, pattern string }
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if strings.HasSuffix(route, "/*") {
			return nil
		}
		routes = append(routes, struct{ method, pattern string }{method, route})
		return nil
	})
	if err != nil {
		t.Fatalf("walking the people routes: %v", err)
	}
	if len(routes) == 0 {
		t.Fatal("no people routes were registered, so this test proves nothing")
	}

	for _, rt := range routes {
		path := peopleRouteParam.ReplaceAllString(rt.pattern, "1")
		req := httptest.NewRequest(rt.method, path, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: got %d, want 401 — the staff register must not be readable without the people_directory page",
				rt.method, rt.pattern, w.Code)
		}
	}
	t.Logf("%d people routes, all refused without the page", len(routes))
}

// Every route in this module is a read. HR monitors people; administering an account
// — granting a role, resetting a password, suspending someone — stays behind
// admin_users. A write appearing here would be a quiet, large privilege change, so
// it fails the build instead.
func TestPeopleDirectoryHasNoWriteRoutes(t *testing.T) {
	r := peopleTestRouter()
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		switch method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			return nil
		}
		t.Errorf("%s %s exists — the People Directory is read-only; account administration belongs to admin_users",
			method, route)
		return nil
	})
	if err != nil {
		t.Fatalf("walking the people routes: %v", err)
	}
}

// o3c_users carries credentials and tokens alongside the staff facts. people.go
// names its columns explicitly for exactly this reason, and this test holds it to
// that: no credential column may appear in any query the module runs.
//
// The scan is over the file's STRING LITERALS, parsed, not over its text. Every
// query in people.go is a string literal, while the file's own header comment has to
// be free to name the columns it is explaining — a plain substring scan over the
// source failed on that comment, which is the test being too literal rather than the
// code being wrong.
//
// A source scan rather than a response check, because the bug this prevents is a
// careless `SELECT *` or one added column, and neither would show up in a fixture
// until it had already shipped.
func TestPeopleDirectoryNeverSelectsASecretColumn(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "people.go", nil, 0) // 0: comments dropped
	if err != nil {
		t.Fatalf("parsing people.go: %v", err)
	}

	var literals []string
	ast.Inspect(file, func(n ast.Node) bool {
		if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == token.STRING {
			literals = append(literals, lit.Value)
		}
		return true
	})
	if len(literals) == 0 {
		t.Fatal("people.go has no string literals, so the queries are not where this test looks")
	}

	secrets := []string{
		"password_hash",
		"totp_secret_encrypted",
		"telnyx_sip_password_enc",
		"zoho_voice_refresh_token",
		"zoho_voice_access_token",
		"reinstate_code_hash",
		"tokens_valid_from",
	}
	selectStar := regexp.MustCompile(`(?i)select\s+\*`)

	for _, lit := range literals {
		for _, col := range secrets {
			if strings.Contains(lit, col) {
				t.Errorf("a query in people.go names %q — the staff register must never read a credential column", col)
			}
		}
		// A SELECT * over this table would pick up every one of the above the moment
		// it was written, which is why the module has none.
		if selectStar.MatchString(lit) {
			t.Error("a query in people.go uses SELECT * over the staff table; name the columns instead")
		}
	}

	// The guard above is only meaningful while the queries really do read o3c_users —
	// if the table were renamed, every assertion here would pass vacuously.
	queriesTheStaffTable := false
	for _, lit := range literals {
		if strings.Contains(lit, "app.o3c_users") {
			queriesTheStaffTable = true
			break
		}
	}
	if !queriesTheStaffTable {
		t.Fatal("no query in people.go reads app.o3c_users, so this test proves nothing")
	}
}
