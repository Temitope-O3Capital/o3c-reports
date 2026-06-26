package handlers

import (
	"net/http/httptest"
	"testing"
)

func TestAbsoluteRequestURLUsesForwardedHeaders(t *testing.T) {
	req := httptest.NewRequest("POST", "http://internal/api/campaigns/upload-image", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Host", "o3c-reports-production.up.railway.app")

	got := absoluteRequestURL(req, "/uploads/campaigns/logo.png")
	want := "https://o3c-reports-production.up.railway.app/uploads/campaigns/logo.png"
	if got != want {
		t.Fatalf("absoluteRequestURL = %q, want %q", got, want)
	}
}

func TestAbsoluteRequestURLKeepsExistingAbsoluteURL(t *testing.T) {
	req := httptest.NewRequest("POST", "http://internal/api/campaigns/upload-image", nil)
	got := absoluteRequestURL(req, "https://cdn.example.com/logo.png")
	if got != "https://cdn.example.com/logo.png" {
		t.Fatalf("absoluteRequestURL changed absolute URL: %q", got)
	}
}
