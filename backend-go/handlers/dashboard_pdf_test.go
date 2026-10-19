package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

// The nonce is the only thing that appears in the render URL, so single-use is the
// property that keeps that URL from being a credential. Everything here is about the
// exchange; the PDF itself needs a browser and is not unit-testable.

func TestAPrintNonceWorksExactlyOnce(t *testing.T) {
	n := newPrintNonce()
	if n == "" {
		t.Fatal("no nonce generated")
	}
	printNonces.Store(n, &printNonce{token: "tok", userID: 3, jti: "j", expires: time.Now().Add(time.Minute)})

	if _, ok := takePrintNonce(n); !ok {
		t.Fatal("the first redemption must succeed")
	}
	if _, ok := takePrintNonce(n); ok {
		t.Error("the nonce was redeemed twice: the render URL is reusable, which is the " +
			"whole thing it is not supposed to be")
	}
}

func TestAnExpiredPrintNonceIsRefused(t *testing.T) {
	n := newPrintNonce()
	printNonces.Store(n, &printNonce{token: "tok", userID: 3, expires: time.Now().Add(-time.Second)})
	if _, ok := takePrintNonce(n); ok {
		t.Error("an expired nonce was accepted")
	}
	// And it is gone rather than left to be tried again.
	if _, still := printNonces.Load(n); still {
		t.Error("an expired nonce was left in the map")
	}
}

func TestAnUnknownPrintNonceIsRefused(t *testing.T) {
	if _, ok := takePrintNonce("not-a-nonce"); ok {
		t.Error("an unknown nonce was accepted")
	}
	if _, ok := takePrintNonce(""); ok {
		t.Error("an empty nonce was accepted, so a request with no n= at all would be let in")
	}
}

func TestPrintNoncesAreNotGuessable(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		n := newPrintNonce()
		if len(n) < 32 {
			t.Fatalf("nonce %q is only %d chars; it is the sole secret in the render URL", n, len(n))
		}
		if seen[n] {
			t.Fatalf("nonce %q repeated within 200 draws", n)
		}
		seen[n] = true
	}
}

// Without a nonce the exchange must hand over nothing — no cookie, no redirect. This is
// the one route in the app that is reachable with no credential at all.
func TestThePrintExchangeRefusesWithoutAValidNonce(t *testing.T) {
	r := chi.NewRouter()
	RegisterDashboardPrint(r)

	for _, url := range []string{
		"/print/dashboard/12",
		"/print/dashboard/12?n=",
		"/print/dashboard/12?n=wrong",
	} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s gave %d, want 403", url, rec.Code)
		}
		for _, c := range rec.Result().Cookies() {
			if c.Name == "o3c_token" {
				t.Errorf("%s set an auth cookie despite being refused", url)
			}
		}
	}
}

func TestThePrintExchangeHandsOverAnHttpOnlyCookieAndRedirects(t *testing.T) {
	r := chi.NewRouter()
	RegisterDashboardPrint(r)

	n := newPrintNonce()
	printNonces.Store(n, &printNonce{token: "the-render-token", userID: 5, jti: "j",
		expires: time.Now().Add(time.Minute)})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/print/dashboard/77?n="+n, nil))

	if rec.Code != http.StatusFound {
		t.Fatalf("got %d, want a 302 to the dashboard", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if !strings.Contains(loc, "/reports/dashboards/77") {
		t.Errorf("redirected to %q, which is not the dashboard that was asked for", loc)
	}
	if !strings.Contains(loc, "print=1") {
		t.Error("the page is not told it is being printed, so it cannot drop on-screen-only furniture")
	}

	var tok *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == "o3c_token" {
			tok = c
		}
	}
	if tok == nil {
		t.Fatal("no auth cookie was set, so the browser would load the page unauthenticated")
	}
	if tok.Value != "the-render-token" {
		t.Errorf("cookie carries %q, not the minted token", tok.Value)
	}
	if !tok.HttpOnly {
		t.Error("the render cookie is readable by script; it must be HttpOnly like the login one")
	}
	if tok.MaxAge <= 0 || tok.MaxAge > 300 {
		t.Errorf("cookie MaxAge is %ds; it should die with the token, in minutes", tok.MaxAge)
	}

	// And the nonce is spent, so the redirect URL cannot be replayed.
	if _, ok := takePrintNonce(n); ok {
		t.Error("the nonce survived the exchange")
	}
}

func TestChromePathIsHonouredAndItsAbsenceIsExplained(t *testing.T) {
	old, had := os.LookupEnv("CHROME_PATH")
	defer func() {
		if had {
			os.Setenv("CHROME_PATH", old)
		} else {
			os.Unsetenv("CHROME_PATH")
		}
	}()

	os.Setenv("CHROME_PATH", filepathJoinNonexistent())
	if _, err := chromeExecutable(); err == nil {
		t.Error("a CHROME_PATH pointing nowhere should be an error, not a silent fallback: " +
			"an operator who set it deserves to be told it is wrong")
	} else if !strings.Contains(err.Error(), "CHROME_PATH") {
		t.Errorf("the error should name CHROME_PATH so it is actionable, got: %v", err)
	}

	// With a real file, that file is used — here, the test binary itself.
	self, err := os.Executable()
	if err != nil {
		t.Skip("cannot find the test executable")
	}
	os.Setenv("CHROME_PATH", self)
	if got, err := chromeExecutable(); err != nil || got != self {
		t.Errorf("CHROME_PATH was not honoured: got %q err %v", got, err)
	}
}

func filepathJoinNonexistent() string {
	return `C:\definitely-not-here\chrome.exe`
}

// The base URL must point at this process, not at the public APP_URL — a host that
// cannot resolve its own public domain would otherwise fail to render anything.
func TestTheRenderBaseURLIsLocalByDefault(t *testing.T) {
	old, had := os.LookupEnv("RENDER_BASE_URL")
	defer func() {
		if had {
			os.Setenv("RENDER_BASE_URL", old)
		} else {
			os.Unsetenv("RENDER_BASE_URL")
		}
	}()
	os.Unsetenv("RENDER_BASE_URL")

	got := dashAppBaseURL()
	if !strings.Contains(got, "127.0.0.1") && !strings.Contains(got, "localhost") {
		t.Errorf("default render base is %q; it should address this process directly", got)
	}
	os.Setenv("RENDER_BASE_URL", "http://example.test:9000/")
	if got := dashAppBaseURL(); got != "http://example.test:9000" {
		t.Errorf("RENDER_BASE_URL not honoured or trailing slash kept: %q", got)
	}
}
