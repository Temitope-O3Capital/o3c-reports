package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/o3c/reports/core"
)

// StartBounceMonitor polls SendGrid's bounce list every 30 minutes and alerts
// admins about newly-bounced recipients — e.g. an @o3cards.com mailbox that
// doesn't exist yet. This catches ASYNCHRONOUS bounces (the receiving server
// rejects the mail after SendGrid accepted it), which the immediate send result
// cannot detect. No-op when SENDGRID_API_KEY is unset.
func StartBounceMonitor(db *core.DB) {
	if os.Getenv("SENDGRID_API_KEY") == "" {
		slog.Info("bounce monitor disabled (SENDGRID_API_KEY unset)")
		return
	}
	go func() {
		time.Sleep(2 * time.Minute) // avoid the startup burst
		pollBounces(db)
		t := time.NewTicker(30 * time.Minute)
		defer t.Stop()
		for range t.C {
			pollBounces(db)
		}
	}()
	slog.Info("bounce monitor started (SendGrid, every 30m)")
}

type sgBounce struct {
	Email   string `json:"email"`
	Reason  string `json:"reason"`
	Created int64  `json:"created"`
}

func pollBounces(db *core.DB) {
	ctx := context.Background()

	var lastTS int64
	if rows, _ := db.PGQuery(ctx, `SELECT value FROM settings WHERE key='last_bounce_poll_ts'`); len(rows) > 0 {
		lastTS, _ = strconv.ParseInt(str(rows[0]["value"]), 10, 64)
	}
	// First run: baseline to now so we don't alert on the historical backlog.
	if lastTS == 0 {
		db.PGExec(ctx, `INSERT INTO settings (key, value) VALUES ('last_bounce_poll_ts', $1)
			ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
			strconv.FormatInt(time.Now().Unix(), 10)) //nolint:errcheck
		return
	}

	url := "https://api.sendgrid.com/v3/suppression/bounces?start_time=" + strconv.FormatInt(lastTS, 10)
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("Authorization", "Bearer "+os.Getenv("SENDGRID_API_KEY"))
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		slog.Warn("bounce monitor: request failed", "err", err)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		slog.Warn("bounce monitor: non-200 from SendGrid", "status", resp.StatusCode)
		return
	}
	var bounces []sgBounce
	if json.Unmarshal(body, &bounces) != nil {
		return
	}

	maxTS := lastTS
	for _, b := range bounces {
		if b.Created <= lastTS {
			continue
		}
		if b.Created > maxTS {
			maxTS = b.Created
		}
		NotifyRoles(ctx, db, []string{"admin", "it_admin"}, NotifPayload{
			EventType: EvtSystemAlert,
			Title:     "Email bounced — recipient did not receive it",
			Body:      fmt.Sprintf("Mail to %s bounced: %s", b.Email, b.Reason),
			ActionURL: "/admin/mail-health",
			EntityRef: b.Email,
		})
		slog.Warn("bounce monitor: alerted admins of bounce", "email", b.Email)
	}
	if maxTS > lastTS {
		db.PGExec(ctx, `INSERT INTO settings (key, value) VALUES ('last_bounce_poll_ts', $1)
			ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
			strconv.FormatInt(maxTS, 10)) //nolint:errcheck
	}
}
