package udara

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Client is a thread-safe HTTP client for the Udara360 Core Banking API.
// Credentials are optional at construction time — if ClientID or ClientSecret
// are empty, every call returns ErrNotConfigured so callers can surface a
// clean "CBS not configured" error rather than a misleading auth failure.
type Client struct {
	baseURL      string
	clientID     string
	clientSecret string

	mu          sync.RWMutex
	accessToken string
	tokenExpiry time.Time

	hc *http.Client
}

// ErrNotConfigured is returned when UDARA360_CLIENT_ID or UDARA360_CLIENT_SECRET
// are missing from the environment.
var ErrNotConfigured = fmt.Errorf("udara360: CBS credentials not configured (set UDARA360_CLIENT_ID + UDARA360_CLIENT_SECRET + UDARA360_BASE_URL)")

// New creates a Client. Pass empty strings to get a no-op client that always
// returns ErrNotConfigured — that lets the rest of the app boot normally.
func New(baseURL, clientID, clientSecret string) *Client {
	return &Client{
		baseURL:      strings.TrimRight(baseURL, "/"),
		clientID:     clientID,
		clientSecret: clientSecret,
		hc:           &http.Client{Timeout: 30 * time.Second},
	}
}

// IsConfigured reports whether credentials were provided.
func (c *Client) IsConfigured() bool {
	return c.clientID != "" && c.clientSecret != "" && c.baseURL != ""
}

// authenticate exchanges credentials for an access token.
func (c *Client) authenticate(ctx context.Context) error {
	payload, _ := json.Marshal(map[string]string{
		"clientId":     c.clientID,
		"clientSecret": c.clientSecret,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/api/auth/v1/authenticate", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("udara360 auth: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.hc.Do(req)
	if err != nil {
		return fmt.Errorf("udara360 auth: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("udara360 auth: HTTP %d: %s", resp.StatusCode, body)
	}

	var result struct {
		AccessToken string `json:"accessToken"`
		ExpiresIn   int    `json:"expiresIn"` // seconds, if provided
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("udara360 auth: parse response: %w", err)
	}
	if result.AccessToken == "" {
		return fmt.Errorf("udara360 auth: empty access token in response")
	}

	ttl := time.Duration(result.ExpiresIn) * time.Second
	if ttl <= 0 {
		ttl = 55 * time.Minute // safe default
	} else {
		ttl -= 2 * time.Minute // refresh a bit early
	}

	c.mu.Lock()
	c.accessToken = result.AccessToken
	c.tokenExpiry = time.Now().Add(ttl)
	c.mu.Unlock()
	return nil
}

// getToken returns a valid access token, re-authenticating if expired.
func (c *Client) getToken(ctx context.Context) (string, error) {
	c.mu.RLock()
	if time.Now().Before(c.tokenExpiry) {
		tok := c.accessToken
		c.mu.RUnlock()
		return tok, nil
	}
	c.mu.RUnlock()

	if err := c.authenticate(ctx); err != nil {
		return "", err
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.accessToken, nil
}

// requestRef generates an idempotency reference (max 100 chars per Udara360 spec).
func requestRef() string {
	return fmt.Sprintf("O3C-%d", time.Now().UnixNano())
}

// Do executes a request against the Udara360 API and returns the raw JSON
// response body, the HTTP status code, and any transport error.
// query is appended to the URL as query parameters (pass nil for POST/PUT).
// body is JSON-encoded and sent as the request body (pass nil for GET).
func (c *Client) Do(ctx context.Context, method, path string, body any, query url.Values) (json.RawMessage, int, error) {
	if !c.IsConfigured() {
		return nil, 0, ErrNotConfigured
	}

	tok, err := c.getToken(ctx)
	if err != nil {
		return nil, 0, err
	}

	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("udara360: marshal body: %w", err)
		}
		bodyReader = bytes.NewReader(b)
	}

	fullURL := c.baseURL + path
	if len(query) > 0 {
		fullURL += "?" + query.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, method, fullURL, bodyReader)
	if err != nil {
		return nil, 0, fmt.Errorf("udara360: build request: %w", err)
	}
	req.Header.Set("Authorization", "bearer "+tok)
	req.Header.Set("Request-reference", requestRef())
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("udara360: request: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("udara360: read response: %w", err)
	}
	return json.RawMessage(data), resp.StatusCode, nil
}
