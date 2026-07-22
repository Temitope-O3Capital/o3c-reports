package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

const termiiSendURL = "https://api.ng.termii.com/api/sms/send"

type termiiPayload struct {
	To      string `json:"to"`
	From    string `json:"from"`
	SMS     string `json:"sms"`
	Type    string `json:"type"`
	APIKey  string `json:"api_key"`
	Channel string `json:"channel"`
}

type termiiResponse struct {
	MessageID string `json:"message_id"`
	Message   string `json:"message"`
	Balance   any    `json:"balance"`
	User      string `json:"user"`
}

// SendSMS sends a plain-text SMS via Termii. phone must be in international
// format without the leading +  (e.g. "2348012345678"). Returns nil on success.
// No-ops silently when TERMII_API_KEY is not set (staging without a key).
func SendSMS(ctx context.Context, phone, message string) error {
	apiKey := strings.TrimSpace(os.Getenv("TERMII_API_KEY"))
	if apiKey == "" {
		slog.Debug("Termii: TERMII_API_KEY not set — skipping SMS", "phone", phone)
		return nil
	}

	senderID := strings.TrimSpace(os.Getenv("TERMII_SENDER_ID"))
	if senderID == "" {
		senderID = "O3 CARDS"
	}

	phone = normalizeTermiiPhone(phone)
	if phone == "" {
		return fmt.Errorf("termii: invalid phone number")
	}

	payload := termiiPayload{
		To:      phone,
		From:    senderID,
		SMS:     message,
		Type:    "plain",
		APIKey:  apiKey,
		Channel: "dnd",
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("termii: marshal: %w", err)
	}

	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, termiiSendURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("termii: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("termii: http: %w", err)
	}
	defer resp.Body.Close()

	var tr termiiResponse
	_ = json.NewDecoder(resp.Body).Decode(&tr)

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("termii: status %d — %s", resp.StatusCode, tr.Message)
	}

	slog.Info("Termii: SMS sent", "phone", phone, "message_id", tr.MessageID)
	return nil
}

// normalizeTermiiPhone strips spaces, dashes, and a leading + so the number
// is in the plain international format Termii expects (e.g. 2348012345678).
func normalizeTermiiPhone(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.ReplaceAll(raw, " ", "")
	raw = strings.ReplaceAll(raw, "-", "")
	raw = strings.TrimPrefix(raw, "+")
	// Treat a local Nigerian 080/090/070/081 number as +234
	if strings.HasPrefix(raw, "0") && len(raw) == 11 {
		raw = "234" + raw[1:]
	}
	if len(raw) < 7 {
		return ""
	}
	return raw
}
