package alert

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	APIKey   string
	FromEmail string
	ToEmails  []string
}

type FailureAlert struct {
	Source      string
	FailureType string // "network" | "parse" | "validation"
	Detail      string
	OccurredAt  time.Time
	// Optional: last known good rate for this currency (for context)
	LastGoodRate *LastRate
}

type LastRate struct {
	Currency  string
	Buy       float64
	Sell      float64
	ScrapedAt time.Time
	Source    string
}

// Send fires a plain-text alert email via SendGrid REST API.
// Returns nil if API key or recipients are not configured (skips silently).
func (c *Client) Send(a FailureAlert) error {
	if c.APIKey == "" || len(c.ToEmails) == 0 || c.FromEmail == "" {
		return nil
	}

	subject := fmt.Sprintf("[FX Scraper Alert] %s — %s", a.Source, a.FailureType)
	body := buildBody(a)

	type emailAddr struct {
		Email string `json:"email"`
	}
	type content struct {
		Type  string `json:"type"`
		Value string `json:"value"`
	}
	type personalization struct {
		To []emailAddr `json:"to"`
	}

	tos := make([]emailAddr, len(c.ToEmails))
	for i, e := range c.ToEmails {
		tos[i] = emailAddr{Email: e}
	}

	payload := map[string]any{
		"personalizations": []personalization{{To: tos}},
		"from":             emailAddr{Email: c.FromEmail},
		"subject":          subject,
		"content":          []content{{Type: "text/plain", Value: body}},
	}

	b, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, "https://api.sendgrid.com/v3/mail/send", bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("send: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("sendgrid status %d", resp.StatusCode)
	}
	return nil
}

func buildBody(a FailureAlert) string {
	var sb strings.Builder
	sb.WriteString("FX Scraper failure detected.\n\n")
	fmt.Fprintf(&sb, "Source:       %s\n", a.Source)
	fmt.Fprintf(&sb, "Failure type: %s\n", a.FailureType)
	fmt.Fprintf(&sb, "Detail:       %s\n", a.Detail)
	fmt.Fprintf(&sb, "Occurred at:  %s\n", a.OccurredAt.UTC().Format(time.RFC3339))

	if a.LastGoodRate != nil {
		r := a.LastGoodRate
		sb.WriteString("\nLast known-good rate:\n")
		fmt.Fprintf(&sb, "  Currency:   %s\n", r.Currency)
		fmt.Fprintf(&sb, "  Buy:        %.2f\n", r.Buy)
		fmt.Fprintf(&sb, "  Sell:       %.2f\n", r.Sell)
		fmt.Fprintf(&sb, "  Source:     %s\n", r.Source)
		fmt.Fprintf(&sb, "  Scraped at: %s\n", r.ScrapedAt.UTC().Format(time.RFC3339))
	}

	sb.WriteString("\nThis is an automated alert from the O3 Capital FX Scraper.\n")
	return sb.String()
}
