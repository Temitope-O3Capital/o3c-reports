package handlers

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/udara"
)

// The /api/cbs routes proxy straight into the core banking system: they create
// customers, freeze accounts and place PND/PNC liens. For a long time they were
// mounted under AuthMiddleware and nothing else, so *any* signed-in user — a call
// centre agent, a collections officer — could call them. The fix gates every
// mutating method on "admin" while leaving reads open, because ContactProfile,
// FixedDeposits and the Reports Library all read through this prefix.
//
// This walks the real route tree rather than naming a few endpoints, so a mutation
// added later is covered the day it is added. The client is deliberately
// unconfigured: every handler then answers 503, which makes the status code say
// exactly which of the two things happened —
//
//	401  the gate refused the request (it never reached the handler)
//	503  the request reached the handler (it got past the gate)
var cbsRouteParam = regexp.MustCompile(`\{[^}]*\}`)

func cbsTestRouter(t *testing.T) chi.Router {
	t.Helper()
	r := chi.NewRouter()
	r.Route("/api/cbs", func(r chi.Router) {
		RegisterCoreBanking(r, udara.New("", "", ""))
	})
	return r
}

type cbsRoute struct {
	method  string
	pattern string
}

func cbsRoutes(t *testing.T, r chi.Router) []cbsRoute {
	t.Helper()
	var out []cbsRoute
	err := chi.Walk(r, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		// chi reports the trailing "/*" of a subtree mount; it is not a real endpoint.
		if strings.HasSuffix(route, "/*") {
			return nil
		}
		out = append(out, cbsRoute{method: method, pattern: route})
		return nil
	})
	if err != nil {
		t.Fatalf("walking the CBS routes: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("no CBS routes were registered, so this test proves nothing")
	}
	return out
}

func cbsCall(t *testing.T, r chi.Router, method, pattern string) int {
	t.Helper()
	// A concrete URL for the pattern. The value never reaches the CBS — the
	// unconfigured client short-circuits first — it only has to route.
	path := cbsRouteParam.ReplaceAllString(pattern, "1")
	req := httptest.NewRequest(method, path, strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w.Code
}

func TestCoreBankingMutationsRefuseAnyoneWithoutAdmin(t *testing.T) {
	r := cbsTestRouter(t)
	routes := cbsRoutes(t, r)

	mutating := 0
	for _, rt := range routes {
		switch rt.method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			continue
		}
		mutating++
		if code := cbsCall(t, r, rt.method, rt.pattern); code != http.StatusUnauthorized {
			t.Errorf("%s %s: got %d, want 401 — this writes to the core banking system and must be gated",
				rt.method, rt.pattern, code)
		}
	}
	if mutating == 0 {
		t.Fatal("found no mutating CBS routes; the walk is not seeing the route tree")
	}
	t.Logf("%d mutating CBS routes, all refused without admin", mutating)
}

// Reads are deliberately NOT gated here: three live pages consume them. If someone
// later wraps the whole prefix in a page gate, this fails and says why.
func TestCoreBankingReadsStayOpenToSignedInStaff(t *testing.T) {
	r := cbsTestRouter(t)
	routes := cbsRoutes(t, r)

	reads := 0
	for _, rt := range routes {
		if rt.method != http.MethodGet {
			continue
		}
		reads++
		if code := cbsCall(t, r, rt.method, rt.pattern); code == http.StatusUnauthorized {
			t.Errorf("GET %s: got 401 — ContactProfile, FixedDeposits and the Reports Library read through /api/cbs; gating reads breaks them",
				rt.pattern)
		}
	}
	if reads == 0 {
		t.Fatal("found no CBS read routes; the walk is not seeing the route tree")
	}
	t.Logf("%d CBS read routes, all still reachable", reads)
}
