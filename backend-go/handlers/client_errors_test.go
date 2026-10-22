package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func resetClientErrSeen() {
	clientErrSeen.Lock()
	defer clientErrSeen.Unlock()
	clientErrSeen.windowStart = time.Time{}
	clientErrSeen.count = map[string]int{}
	clientErrSeen.suppressed = map[string]int{}
}

// A broken render can fire on every re-render. The throttle has to hold the log down
// to one line per fault without hiding the fact that it happened a thousand times —
// silence and a flood are both useless.
func TestClientErrorThrottleKeepsOneLineAndCountsTheRest(t *testing.T) {
	resetClientErrSeen()
	t0 := time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC)

	if carried, logIt := throttleClientError("k", t0); !logIt || carried != 0 {
		t.Fatalf("the first report of a fault must be logged with nothing carried; got logIt=%v carried=%d", logIt, carried)
	}
	for i := 0; i < 4; i++ {
		if _, logIt := throttleClientError("k", t0.Add(time.Second)); logIt {
			t.Fatalf("repeat %d inside the window should have been suppressed", i+1)
		}
	}
	carried, logIt := throttleClientError("k", t0.Add(2*time.Minute))
	if !logIt {
		t.Fatal("a new window must log the fault again, or a fault that never stops stops being reported")
	}
	if carried != 4 {
		t.Fatalf("the suppressed repeats must be carried forward so a storm is visible as a number; want 4, got %d", carried)
	}
	// Having been reported, the backlog is spent rather than counted twice.
	if c2, _ := throttleClientError("k", t0.Add(4*time.Minute)); c2 != 0 {
		t.Fatalf("the carried count must clear once reported; got %d", c2)
	}
}

// The same message on two routes is two things worth knowing about: "everywhere" is
// the useful half of the report, so the key must not collapse them into one.
func TestClientErrorThrottleSeparatesRoutes(t *testing.T) {
	resetClientErrSeen()
	now := time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC)
	if _, logIt := throttleClientError("/a\x00boom", now); !logIt {
		t.Fatal("first route should log")
	}
	if _, logIt := throttleClientError("/b\x00boom", now); !logIt {
		t.Fatal("the same fault on a second route is a separate report and must also log")
	}
}

// A report about a broken page must never itself produce a broken page, so every input
// — valid, malformed, empty or oversized — gets the same quiet answer.
func TestClientErrorPostAlwaysAnswersQuietly(t *testing.T) {
	resetClientErrSeen()
	h := clientErrorPost()

	cases := []struct{ name, body string }{
		{"a real report", `{"message":"Minified React error #130","route":"/executive/sales","boundary":"page"}`},
		{"malformed json", `{oh dear`},
		{"an empty message", `{"message":"   "}`},
		{"no body at all", ``},
		{"a body past the cap", `{"message":"` + strings.Repeat("x", 40000) + `"}`},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/client-errors", strings.NewReader(c.body))
		h(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Errorf("%s: want 204, got %d", c.name, rec.Code)
		}
	}
}

// Untrusted text from a page must not be able to reflow the log: one field cannot
// smuggle in newlines, and a long one is cut.
func TestClipFlattensAndTruncates(t *testing.T) {
	if got := clip("a\nb\r\nc", 100); strings.ContainsAny(got, "\r\n") {
		t.Errorf("clip must collapse newlines, got %q", got)
	}
	long := clip(strings.Repeat("y", 50), 10)
	if len([]rune(long)) != 11 { // 10 kept plus the ellipsis
		t.Errorf("clip must truncate to the limit, got %q (%d runes)", long, len([]rune(long)))
	}
	if clip("   padded   ", 100) != "padded" {
		t.Error("clip must trim surrounding whitespace")
	}
}
