package handlers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// The webhook writes straight into the risk queue, so signature verification is the
// only thing standing between Phoenix's events and an unauthenticated write.
func TestPhoenixVerifySignature(t *testing.T) {
	secret := "test-secret"
	body := []byte(`{"event_id":"e1","event_type":"decision.completed"}`)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	good := hex.EncodeToString(mac.Sum(nil))

	cases := []struct {
		name   string
		header string
		body   []byte
		want   bool
	}{
		{"valid", good, body, true},
		{"valid with sha256= prefix", "sha256=" + good, body, true},
		{"valid uppercase", "SHA256=" + good, body, false}, // prefix is case-sensitive by design
		{"empty header", "", body, false},
		{"wrong signature", hex.EncodeToString(make([]byte, 32)), body, false},
		{"tampered body", good, []byte(`{"event_id":"e1","event_type":"application.created"}`), false},
		{"garbage", "not-hex", body, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := phoenixVerifySignature(secret, c.header, c.body); got != c.want {
				t.Errorf("phoenixVerifySignature(%q) = %v, want %v", c.header, got, c.want)
			}
		})
	}
}

// A tampered body must fail even when the signature is a valid HMAC of *something*.
func TestPhoenixSignatureIsOverBody(t *testing.T) {
	secret := "s"
	a := []byte(`{"amount":100}`)
	b := []byte(`{"amount":999999}`)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(a)
	sigForA := hex.EncodeToString(mac.Sum(nil))

	if !phoenixVerifySignature(secret, sigForA, a) {
		t.Fatal("signature should verify against its own body")
	}
	if phoenixVerifySignature(secret, sigForA, b) {
		t.Fatal("signature for body A must NOT verify body B")
	}
}

// Retry policy: a 4xx means our payload is wrong and will never succeed, so the
// worker abandons instead of burning six attempts. 408/429/5xx are transient.
func TestPhoenixHTTPErrorPermanent(t *testing.T) {
	cases := map[int]bool{
		400: true, 401: true, 403: true, 404: true, 422: true,
		408: false, 429: false,
		500: false, 502: false, 503: false, 504: false,
	}
	for status, wantPermanent := range cases {
		e := phoenixHTTPError{Status: status}
		if got := e.permanent(); got != wantPermanent {
			t.Errorf("status %d: permanent() = %v, want %v", status, got, wantPermanent)
		}
	}
}

func TestPhoenixConfiguredRequiresBoth(t *testing.T) {
	t.Setenv("PHOENIX_BASE_URL", "")
	t.Setenv("PHOENIX_API_KEY", "")
	if phoenixConfigured() {
		t.Error("must not be configured with neither set")
	}
	t.Setenv("PHOENIX_BASE_URL", "http://localhost:9200")
	if phoenixConfigured() {
		t.Error("must not be configured without an API key")
	}
	t.Setenv("PHOENIX_API_KEY", "k")
	if !phoenixConfigured() {
		t.Error("must be configured once both are set")
	}
}

// Trailing slashes on the configured base URL must not produce a double slash in the
// submit path — a class of bug that only shows up against the real server.
func TestPhoenixBaseURLTrimsSlash(t *testing.T) {
	t.Setenv("PHOENIX_BASE_URL", "http://localhost:9200/api/v1/")
	if got := phoenixBaseURL(); got != "http://localhost:9200/api/v1" {
		t.Errorf("phoenixBaseURL() = %q, want trailing slash trimmed", got)
	}
}
