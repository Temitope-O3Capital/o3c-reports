package handlers

// How a failed Phoenix call reaches the person who made it.
//
// respondErr replaces the body of every 5xx with "Internal server error" (S11) —
// right for a database fault, wrong here. Every Phoenix action used to answer 502, so
// Phoenix's own reason for refusing ("offer has expired", "requested_limit_minor is
// required for a REVOLVING product") was stripped on the way to the browser, and
// staff read "Internal server error" for a mistake they could have fixed in a second.
// Failures are sorted instead by whose move it is next, and worded for that person: a
// refusal carries Phoenix's reason, a Phoenix fault says it is Phoenix's, a timeout on
// an action says it may have gone through, and a refused key says an administrator
// is needed.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strings"
)

// phoenixCallError is a non-2xx answer from Phoenix's /v1 surface.
type phoenixCallError struct {
	Method string
	Path   string
	Status int
	// Detail is Phoenix's own message for the refusal, when it gave one.
	Detail string
}

func (e phoenixCallError) Error() string {
	return fmt.Sprintf("phoenix %s %s: %d — %s", e.Method, e.Path, e.Status, e.Detail)
}

// phoenixProblemDetail pulls the human part out of a Phoenix error body. Huma answers
// RFC 7807 with the specifics in errors[] — "validation failed" on its own names no
// field — and Phoenix's hand-written handlers answer {"detail": …}.
func phoenixProblemDetail(raw []byte) string {
	var p struct {
		Title  string `json:"title"`
		Detail string `json:"detail"`
		Errors []struct {
			Message  string `json:"message"`
			Location string `json:"location"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return truncate(strings.TrimSpace(string(raw)), 300)
	}
	msg := strings.TrimSpace(p.Detail)
	if msg == "" {
		msg = strings.TrimSpace(p.Title)
	}
	var specifics []string
	for _, e := range p.Errors {
		m := strings.TrimSpace(e.Message)
		// Phoenix often repeats the detail as the only entry ("offer not found" twice).
		if m == "" || strings.EqualFold(m, msg) {
			continue
		}
		if loc := strings.TrimSpace(e.Location); loc != "" {
			m += " (" + loc + ")"
		}
		specifics = append(specifics, m)
	}
	if len(specifics) > 0 {
		if msg != "" {
			msg += ": "
		}
		msg += strings.Join(specifics, "; ")
	}
	if msg == "" {
		msg = truncate(strings.TrimSpace(string(raw)), 300)
	}
	return msg
}

// phoenixFailure is what the workspace tells staff about a failed Phoenix call.
type phoenixFailure struct {
	Status  int    // the workspace's own HTTP answer
	Code    string // stable error_code, for a client that wants to branch on it
	Message string // shown to staff as written
}

// classifyPhoenixErr sorts a failed call by whose move it is next. action finishes
// the sentence "the workspace could not …", e.g. "resend the offer". write says
// whether the call could have changed something in Phoenix, which decides what a
// timeout means.
func classifyPhoenixErr(err error, action string, write bool) phoenixFailure {
	var ce phoenixCallError
	var he phoenixHTTPError
	switch {
	case errors.As(err, &ce):
	case errors.As(err, &he):
		// The submit path predates phoenixCallError; read it the same way.
		ce = phoenixCallError{Status: he.Status, Detail: phoenixProblemDetail([]byte(he.Body))}
	default:
		return classifyPhoenixTransportErr(err, action, write)
	}
	switch s := ce.Status; {
	case s == http.StatusUnauthorized || s == http.StatusForbidden:
		return phoenixFailure{http.StatusBadGateway, "PHOENIX_AUTH", fmt.Sprintf(
			"Phoenix refused the workspace's credentials (HTTP %d), so the workspace could not %s. An administrator needs to check the Phoenix API key and tenant set on the workspace server.", s, action)}
	case s == http.StatusRequestTimeout || s == http.StatusTooManyRequests:
		return phoenixFailure{http.StatusServiceUnavailable, "PHOENIX_BUSY", fmt.Sprintf(
			"Phoenix is busy (HTTP %d), so the workspace could not %s. Try again in a minute.", s, action)}
	case s >= 400 && s < 500:
		// Phoenix's reason is the useful part: it names the field, or the rule.
		msg := "Phoenix would not " + action
		if ce.Detail != "" {
			msg += ": " + ce.Detail
		} else {
			msg += fmt.Sprintf(" (HTTP %d).", s)
		}
		return phoenixFailure{http.StatusUnprocessableEntity, "PHOENIX_REFUSED", msg}
	default:
		// Phoenix's own fault. Its body is Phoenix's internals, so it stays in the log.
		return phoenixFailure{http.StatusBadGateway, "PHOENIX_FAILED", fmt.Sprintf(
			"Phoenix hit an internal error (HTTP %d) and could not %s. Try again; if it keeps failing, it is one for the Phoenix team.", s, action)}
	}
}

// classifyPhoenixTransportErr covers the calls that got no answer from Phoenix at all.
func classifyPhoenixTransportErr(err error, action string, write bool) phoenixFailure {
	var ne net.Error
	isNet := errors.As(err, &ne)
	if errors.Is(err, context.DeadlineExceeded) || (isNet && ne.Timeout()) {
		msg := fmt.Sprintf("Phoenix did not answer within 30 seconds, so the workspace could not %s.", action)
		if write {
			msg = fmt.Sprintf("Phoenix did not answer within 30 seconds while the workspace tried to %s. It may still have gone through — refresh before trying again.", action)
		}
		return phoenixFailure{http.StatusGatewayTimeout, "PHOENIX_TIMEOUT", msg}
	}
	if !phoenixConfigured() || phoenixTenantID() == "" {
		return phoenixFailure{http.StatusServiceUnavailable, "PHOENIX_NOT_CONFIGURED", fmt.Sprintf(
			"Phoenix is not configured on this workspace server (PHOENIX_BASE_URL, PHOENIX_API_KEY, PHOENIX_TENANT_ID), so the workspace could not %s.", action)}
	}
	// http.Client reports every transport failure as a *url.Error, which is a net.Error.
	if isNet {
		return phoenixFailure{http.StatusBadGateway, "PHOENIX_UNREACHABLE", fmt.Sprintf(
			"Phoenix could not be reached, so the workspace could not %s. It may be down or restarting.", action)}
	}
	return phoenixFailure{http.StatusBadGateway, "PHOENIX_ERROR", fmt.Sprintf(
		"Something went wrong talking to Phoenix, so the workspace could not %s.", action)}
}

// respondPhoenixErr answers a failed Phoenix call: the whole error — method, path,
// Phoenix's body — to the log, and the sentence from classifyPhoenixErr to staff.
func respondPhoenixErr(w http.ResponseWriter, r *http.Request, err error, action string) {
	writePhoenixFailure(w, classifyPhoenixErr(err, action, r.Method != http.MethodGet && r.Method != http.MethodHead), err)
}

// writePhoenixFailure bypasses respondErr on purpose: its 5xx scrubbing would put
// "Internal server error" back in place of a message written to be read. Nothing in
// it comes from the workspace's own internals — Phoenix's reason on a refusal, fixed
// wording otherwise.
func writePhoenixFailure(w http.ResponseWriter, f phoenixFailure, err error) {
	if f.Code == "PHOENIX_REFUSED" {
		slog.Warn("phoenix refused", "status", f.Status, "err", err)
	} else {
		slog.Error("phoenix call failed", "status", f.Status, "code", f.Code, "err", err)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(f.Status)
	json.NewEncoder(w).Encode(map[string]string{"detail": f.Message, "error_code": f.Code}) //nolint:errcheck
}

// phoenixErrorText is the same wording for a failure that is stored rather than
// answered — the reason an abandoned submission shows on the application.
func phoenixErrorText(err error, action string) string {
	return classifyPhoenixErr(err, action, true).Message
}

var phoenixIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// phoenixUUID reports whether s is shaped like a Phoenix id. Ids taken from the URL
// are spliced into the path of a call made with the tenant's API key, so anything
// else — a "..", a "?", an encoded slash — is refused before it can steer that call
// somewhere else in Phoenix.
func phoenixUUID(s string) bool { return phoenixIDPattern.MatchString(s) }
