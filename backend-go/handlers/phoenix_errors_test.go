package handlers

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"testing"
)

func TestPhoenixProblemDetail(t *testing.T) {
	cases := []struct{ name, body, want string }{
		{"huma names the field",
			`{"title":"Unprocessable Entity","status":422,"detail":"validation failed","errors":[{"message":"expected required property requested_limit_minor to be present","location":"body"}]}`,
			"validation failed: expected required property requested_limit_minor to be present (body)"},
		{"hand-written handler", `{"detail":"offer has expired"}`, "offer has expired"},
		// Captured from live Phoenix: accept on an unknown offer.
		{"detail repeated in errors",
			`{"$schema":"http://127.0.0.1:9200/schemas/ErrorModel.json","title":"Bad Request","status":400,"detail":"offer not found","errors":[{"message":"offer not found"}]}`,
			"offer not found"},
		{"title only", `{"title":"Conflict"}`, "Conflict"},
		{"not JSON", `<html>bad gateway</html>`, "<html>bad gateway</html>"},
	}
	for _, c := range cases {
		if got := phoenixProblemDetail([]byte(c.body)); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestClassifyPhoenixErr(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		write    bool
		status   int
		code     string
		contains string
		excludes string
	}{
		{"refusal carries Phoenix's reason", phoenixCallError{Method: "POST", Path: "/offers/x/accept", Status: 422, Detail: "offer has expired"}, true, 422, "PHOENIX_REFUSED", "Phoenix would not do it: offer has expired", ""},
		{"conflict is a refusal", phoenixCallError{Status: 409, Detail: "offer has already been accepted"}, true, 422, "PHOENIX_REFUSED", "already been accepted", ""},
		{"refusal with no reason", phoenixCallError{Status: 404}, false, 422, "PHOENIX_REFUSED", "(HTTP 404)", ""},
		{"refused key needs an administrator", phoenixCallError{Status: 401, Detail: "missing or invalid API key"}, false, 502, "PHOENIX_AUTH", "administrator", ""},
		{"rate limit is busy", phoenixCallError{Status: 429}, true, 503, "PHOENIX_BUSY", "Try again in a minute", ""},
		{"5xx keeps Phoenix internals out", phoenixCallError{Status: 500, Detail: "pq: relation offers does not exist"}, true, 502, "PHOENIX_FAILED", "Phoenix team", "pq:"},
		{"submit path error reads the same", phoenixHTTPError{Status: 400, Body: `{"detail":"tenor_months must be positive"}`}, true, 422, "PHOENIX_REFUSED", "tenor_months must be positive", ""},
		{"wrapped call error", fmt.Errorf("offers: %w", phoenixCallError{Status: 422, Detail: "bad"}), false, 422, "PHOENIX_REFUSED", ": bad", ""},
		{"timeout on an action may have landed", &url.Error{Op: "Post", URL: "http://phoenix/v1/x", Err: context.DeadlineExceeded}, true, 504, "PHOENIX_TIMEOUT", "may still have gone through", ""},
		{"timeout on a read", fmt.Errorf("wrapped: %w", context.DeadlineExceeded), false, 504, "PHOENIX_TIMEOUT", "could not do it.", "gone through"},
	}
	for _, c := range cases {
		f := classifyPhoenixErr(c.err, "do it", c.write)
		if f.Status != c.status || f.Code != c.code {
			t.Errorf("%s: got %d %s, want %d %s", c.name, f.Status, f.Code, c.status, c.code)
		}
		if !strings.Contains(f.Message, c.contains) {
			t.Errorf("%s: message %q does not contain %q", c.name, f.Message, c.contains)
		}
		if c.excludes != "" && strings.Contains(f.Message, c.excludes) {
			t.Errorf("%s: message %q leaks %q", c.name, f.Message, c.excludes)
		}
	}
}

func TestClassifyPhoenixTransportErr(t *testing.T) {
	refused := &url.Error{Op: "Get", URL: "http://phoenix/v1/x", Err: &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}}

	t.Setenv("PHOENIX_BASE_URL", "")
	t.Setenv("PHOENIX_API_KEY", "")
	t.Setenv("PHOENIX_TENANT_ID", "")
	if f := classifyPhoenixErr(refused, "do it", false); f.Code != "PHOENIX_NOT_CONFIGURED" {
		t.Errorf("unconfigured: got %s", f.Code)
	}

	t.Setenv("PHOENIX_BASE_URL", "http://phoenix/v1")
	t.Setenv("PHOENIX_API_KEY", "k")
	t.Setenv("PHOENIX_TENANT_ID", "t")
	if f := classifyPhoenixErr(refused, "do it", false); f.Code != "PHOENIX_UNREACHABLE" || f.Status != 502 {
		t.Errorf("connection refused: got %d %s", f.Status, f.Code)
	}
	if f := classifyPhoenixErr(errors.New("bad response from phoenix"), "do it", false); f.Code != "PHOENIX_ERROR" {
		t.Errorf("other: got %s", f.Code)
	}
}

func TestPhoenixUUID(t *testing.T) {
	for s, want := range map[string]bool{
		"0b6f0a3e-7c2d-4e8a-9f11-2a3b4c5d6e7f": true,
		"0B6F0A3E-7C2D-4E8A-9F11-2A3B4C5D6E7F": true,
		"":                                     false,
		"../credit-requests":                   false,
		"0b6f0a3e-7c2d-4e8a-9f11-2a3b4c5d6e7f?tenant_id=x": false,
		"0b6f0a3e-7c2d-4e8a-9f11-2a3b4c5d6e7f/..":          false,
	} {
		if got := phoenixUUID(s); got != want {
			t.Errorf("phoenixUUID(%q) = %v, want %v", s, got, want)
		}
	}
}
