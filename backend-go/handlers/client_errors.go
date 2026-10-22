package handlers

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// Client-side error reporting.
//
// Until this existed, a page that broke in a staff member's browser left no trace
// anywhere at all. @sentry/react ships inside the bundle, but Sentry.init is guarded on
// VITE_SENTRY_DSN and no environment file sets one, so it has never armed. Both React
// error boundaries then throw away what matters: the outer one replaces the message
// with "Something went wrong", and the inner one prints React's own text, which in a
// production build is a bare error number. So the detail was shown to the person least
// able to act on it and kept for nobody, and the best a user could report was "a
// minified React error in a lot of places" — true, unactionable, and not their fault.
//
// The report goes to the backend log, which run_backend.ps1 already tees to
// backend-go/logs/backend-<date>.log. Deliberately no table and no migration: a crash
// report is diagnostic exhaust rather than a business record, a log line is greppable
// today, and a new store would need its own retention and purge rules to hold data
// nobody has asked to keep.
//
// It is mounted behind authentication like every other API route. That loses crashes on
// the login screen itself, which is a real gap, but it is the honest trade: the pages
// being reported are ones staff are signed in to, and a public endpoint that writes to
// the log is a free amplifier for anyone who finds it.

const (
	// Enough for a long component stack and no more. A report that overflows is
	// truncated rather than refused — a clipped stack still names the component.
	clientErrorMaxBody    = 16 << 10
	clientErrorFieldLimit = 500
	clientErrorStackLimit = 4000

	// One log line per distinct fault per window. A broken render can fire on every
	// re-render, and a log that scrolls past the thing it was meant to capture is no
	// better than no log.
	clientErrorWindow   = time.Minute
	clientErrorKeyLimit = 500
)

// clientErrorReport is the browser's account of its own failure. Every field is
// untrusted text written by a page: it is truncated, and logged as structured values
// rather than interpolated into a message.
type clientErrorReport struct {
	Name      string `json:"name"`
	Message   string `json:"message"`
	Route     string `json:"route"`
	Boundary  string `json:"boundary"`
	Component string `json:"component_stack"`
	Stack     string `json:"stack"`
	Build     string `json:"build"`
}

var clientErrSeen = struct {
	sync.Mutex
	windowStart time.Time
	count       map[string]int
	suppressed  map[string]int
}{count: map[string]int{}, suppressed: map[string]int{}}

// throttleClientError decides whether this report is logged, and carries forward how
// many identical ones were swallowed since the key was last logged — so a storm is
// visible as a number instead of thousands of lines or complete silence.
func throttleClientError(key string, now time.Time) (carried int, logIt bool) {
	clientErrSeen.Lock()
	defer clientErrSeen.Unlock()

	if now.Sub(clientErrSeen.windowStart) >= clientErrorWindow {
		clientErrSeen.windowStart = now
		clientErrSeen.count = map[string]int{}
	}
	// A page looping on a new key each render must not grow this map without bound.
	if len(clientErrSeen.count) > clientErrorKeyLimit {
		clientErrSeen.count = map[string]int{}
		clientErrSeen.suppressed = map[string]int{}
	}

	clientErrSeen.count[key]++
	if clientErrSeen.count[key] > 1 {
		clientErrSeen.suppressed[key]++
		return 0, false
	}
	carried = clientErrSeen.suppressed[key]
	delete(clientErrSeen.suppressed, key)
	return carried, true
}

// clip trims untrusted text to a limit and collapses the newlines a log line cannot
// carry, so one field cannot reflow the whole log.
func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		s = s[:n] + "…"
	}
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r", " "), "\n", " ⏎ ")
}

// clientErrorPost — POST /api/client-errors
func clientErrorPost() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var rep clientErrorReport
		if err := json.NewDecoder(io.LimitReader(r.Body, clientErrorMaxBody)).Decode(&rep); err != nil {
			// A report about a broken page must not itself produce a broken page.
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if strings.TrimSpace(rep.Message) == "" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		msg, route := clip(rep.Message, clientErrorFieldLimit), clip(rep.Route, clientErrorFieldLimit)
		carried, logIt := throttleClientError(route+"\x00"+msg, time.Now())
		if !logIt {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Who saw it matters: "every page" and "one person's browser" are different
		// faults and the fix differs. Name and id only — never the message body.
		var who string
		var whoID int64
		if u := core.UserFromCtx(r.Context()); u != nil {
			who, whoID = u.FullName, u.ID
		}

		slog.Error("client error",
			"route", route,
			"name", clip(rep.Name, 120),
			"message", msg,
			"boundary", clip(rep.Boundary, 40),
			"component", clip(rep.Component, clientErrorStackLimit),
			"stack", clip(rep.Stack, clientErrorStackLimit),
			"build", clip(rep.Build, 120),
			"user", who, "user_id", whoID,
			"user_agent", clip(r.UserAgent(), 300),
			"repeats_suppressed", carried,
		)
		w.WriteHeader(http.StatusNoContent)
	}
}

// RegisterClientErrors mounts the reporter. No page requirement: anyone signed in can
// report that a page they were allowed to open has broken, and refusing the report
// because the fault is on a page they lack would hide exactly the access bugs worth
// hearing about.
func RegisterClientErrors(r chi.Router) {
	r.Post("/", clientErrorPost())
}
