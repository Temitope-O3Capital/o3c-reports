package handlers

/*
Rendering a dashboard to PDF, server-side, so it can be emailed.

WHY A REAL BROWSER. A dashboard is charts. The figures could be rendered to HTML here in
Go, but the chart configuration lives in the frontend (components/echarts.tsx and
DashboardView.tsx) and reimplementing it server-side would be a second copy of the thing
most likely to change — the same duplication that already makes the pivot matrix id
contract a two-places problem. So the PDF is produced by printing the actual page: one
definition of what a dashboard looks like, and the @media print stylesheet that already
backs the browser's own Print button is what formats it.

HOW THE BROWSER IS AUTHENTICATED, AND WHAT IS DELIBERATELY NOT IN THE URL.

A headless browser needs a credential, and the obvious shape — put a token in the URL —
leaks it into this process's command line, which other local processes can read. So the
URL carries a NONCE instead: an opaque single-use string that is meaningless anywhere
else and is redeemed exactly once, in this process, for the real token. The token itself
never leaves the server's memory until it is set as an HttpOnly cookie on the redirect.

The token is an ordinary short-lived access token carrying THE REQUESTER'S OWN CLAIMS
(see core.CreateRenderToken), so:

  - a rendered PDF can never show more than the person who asked could open themselves,
    and every per-tile access check in dashTileData still runs against them;
  - it is revoked by JTI in a defer the moment the render ends, successful or not.

The nonce map is in-memory on purpose. One process both mints and redeems, within
seconds, so a table would add a migration, a cleanup job and a second place for a
credential to sit at rest, to solve a problem that does not exist.
*/

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// How long a render may take before it is abandoned. Chrome is given slightly less, so
// the context deadline is the backstop rather than the thing that normally fires.
const (
	dashRenderTimeout = 75 * time.Second
	dashChromeBudget  = 20000 // ms of virtual time: enough for the charts to draw
	dashNonceTTL      = 2 * time.Minute
)

// Only a couple of browsers at once. Chrome is not cheap, and a dashboard email is not
// urgent enough to let a handful of simultaneous requests push the host into swap —
// this server also runs the database.
var dashRenderSlots = make(chan struct{}, 2)

type printNonce struct {
	token   string
	userID  int64
	jti     string
	expires time.Time
}

var printNonces sync.Map // nonce -> *printNonce

func newPrintNonce() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		// A nonce that is not random is not a nonce. Fail the render rather than
		// continue with something guessable.
		return ""
	}
	return hex.EncodeToString(b)
}

// takePrintNonce redeems a nonce, removing it so a second attempt finds nothing.
// LoadAndDelete is what makes it single-use without a lock of our own.
func takePrintNonce(nonce string) (*printNonce, bool) {
	v, ok := printNonces.LoadAndDelete(nonce)
	if !ok {
		return nil, false
	}
	p, ok := v.(*printNonce)
	if !ok || time.Now().After(p.expires) {
		return nil, false
	}
	return p, true
}

// chromeExecutable finds a browser that can print. CHROME_PATH wins, so this is
// configurable on a host that keeps it somewhere else without a code change.
func chromeExecutable() (string, error) {
	if p := strings.TrimSpace(os.Getenv("CHROME_PATH")); p != "" {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
		return "", fmt.Errorf("CHROME_PATH is set to %q, which does not exist", p)
	}
	for _, p := range []string{
		`C:\Program Files\Google\Chrome\Application\chrome.exe`,
		`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
		`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
	} {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("no Chrome or Edge found to render the PDF; set CHROME_PATH to its executable")
}

// dashAppBaseURL is where the browser should fetch the page from. It is the SERVER'S OWN
// address, not APP_URL: APP_URL is the public link used in emails and may well be a
// domain this host cannot resolve or reach, whereas the renderer only ever needs to talk
// to the process it is running beside.
func dashAppBaseURL() string {
	if p := strings.TrimSpace(os.Getenv("RENDER_BASE_URL")); p != "" {
		return strings.TrimRight(p, "/")
	}
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = "8000"
	}
	return "http://127.0.0.1:" + port
}

// renderDashboardPDF prints one dashboard as the given user and returns the PDF bytes.
func renderDashboardPDF(ctx context.Context, dashID string, u *core.Claims) ([]byte, error) {
	if u == nil {
		return nil, fmt.Errorf("no user to render as")
	}
	chrome, err := chromeExecutable()
	if err != nil {
		return nil, err
	}

	select {
	case dashRenderSlots <- struct{}{}:
		defer func() { <-dashRenderSlots }()
	case <-ctx.Done():
		return nil, fmt.Errorf("the server is already rendering other dashboards; try again shortly")
	}

	token, jti, exp, err := core.CreateRenderToken(u)
	if err != nil {
		return nil, fmt.Errorf("could not mint a render token: %w", err)
	}
	// In a defer, not after the happy path: a render that fails halfway is exactly when
	// a live token must not be left behind.
	defer func() {
		if rErr := core.RevokeToken(context.Background(), jti, u.ID, exp); rErr != nil {
			slog.Error("dashboard pdf: could not revoke the render token", "jti", jti, "err", rErr)
		}
	}()

	nonce := newPrintNonce()
	if nonce == "" {
		return nil, fmt.Errorf("could not generate a render nonce")
	}
	printNonces.Store(nonce, &printNonce{token: token, userID: u.ID, jti: jti, expires: time.Now().Add(dashNonceTTL)})
	defer printNonces.Delete(nonce)

	dir, err := os.MkdirTemp("", "o3c-dash-pdf-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	out := filepath.Join(dir, "dashboard.pdf")

	runCtx, cancel := context.WithTimeout(ctx, dashRenderTimeout)
	defer cancel()

	url := fmt.Sprintf("%s/print/dashboard/%s?n=%s", dashAppBaseURL(), dashID, nonce)
	cmd := exec.CommandContext(runCtx, chrome,
		"--headless=new",
		"--disable-gpu",
		// A throwaway profile per render: no shared cookie jar, nothing persisted, and
		// no interference between two renders running at once.
		"--user-data-dir="+filepath.Join(dir, "profile"),
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--hide-scrollbars",
		// Virtual time lets the page's timers and chart animations complete immediately
		// rather than printing a half-drawn dashboard after a fixed sleep.
		fmt.Sprintf("--virtual-time-budget=%d", dashChromeBudget),
		"--print-to-pdf-no-header",
		"--print-to-pdf="+out,
		url,
	)
	// Chrome's own stderr is logged in full on failure, and that is deliberate rather
	// than tidy-minded. The flags above were verified against Chrome 155 on this host
	// under an interactive account, but THE BACKEND RUNS AS SYSTEM, and a service
	// account is where a browser is most likely to object — to its sandbox, to a
	// profile directory it cannot write, to there being no window station. None of that
	// can be tested from a normal shell, so the next best thing is that the first
	// failure says exactly what Chrome said instead of "could not render".
	if combined, runErr := cmd.CombinedOutput(); runErr != nil {
		if runCtx.Err() != nil {
			return nil, fmt.Errorf("the dashboard took too long to render")
		}
		slog.Error("dashboard pdf: chrome failed", "err", runErr, "chrome", chrome,
			"output", strings.TrimSpace(string(combined)))
		return nil, fmt.Errorf("the dashboard could not be rendered; the server log has the renderer's own message")
	}

	data, err := os.ReadFile(out)
	if err != nil {
		return nil, fmt.Errorf("the renderer produced no file")
	}
	// A PDF always starts %PDF-. Checking is how a silently-empty render becomes an
	// error here instead of an unopenable attachment in somebody's inbox.
	if len(data) < 1000 || !strings.HasPrefix(string(data[:5]), "%PDF-") {
		return nil, fmt.Errorf("the renderer produced something that is not a PDF (%d bytes)", len(data))
	}
	return data, nil
}

// RegisterDashboardPrint mounts the nonce-exchange route. It sits OUTSIDE /api and
// outside AuthMiddleware deliberately: it is the one request that arrives without a
// credential, because handing one over is its entire job.
func RegisterDashboardPrint(r chi.Router) {
	r.Get("/print/dashboard/{id}", dashPrintExchange())
}

func dashPrintExchange() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		p, ok := takePrintNonce(r.URL.Query().Get("n"))
		if !ok {
			// No detail: this is reachable without a credential, so it says only that
			// the link is no good.
			http.Error(w, "This render link is not valid.", http.StatusForbidden)
			return
		}
		// The cookie is HttpOnly and expires with the token, so the page the browser is
		// about to load can use it but no script can read it back out.
		secure, sameSite := cookieAttrs(r)
		http.SetCookie(w, &http.Cookie{
			Name:     "o3c_token",
			Value:    p.token,
			Path:     "/",
			MaxAge:   int(dashNonceTTL / time.Second),
			HttpOnly: true,
			Secure:   secure,
			SameSite: sameSite,
		})
		// print=1 lets the page know it is being printed rather than viewed, so it can
		// skip anything that only makes sense on screen.
		http.Redirect(w, r, "/reports/dashboards/"+id+"?print=1", http.StatusFound)
	}
}
