package handlers

// Zoho Event Webhook — true real-time updates. Zoho Desk/Voice notification rules
// POST here whenever a ticket or call changes; we persist the raw event and
// immediately trigger a bounded incremental sync (webhook-as-trigger, poll-as-fetch).
// This avoids brittle coupling to Zoho's webhook payload schema: the existing
// importer remains the single source of the mapping, and the webhook just makes it
// run within seconds instead of waiting for the next poll tick.
//
// Public route (no JWT — Zoho can't send bearer tokens); authenticated by a shared
// secret in the URL (?key=…, ZOHO_WEBHOOK_SECRET). Fails closed when unset, so it is
// never an open trigger endpoint. Until the public ingress (crm.o3cards.com) is live
// this simply never receives traffic — the fast poll carries near-real-time in the
// meantime, and the webhook takes over the moment the ingress lands.

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/o3c/reports/core"
)

// zohoFailedSpike reports whether an import's insert-failure rate is high enough to
// alert on. A sync that "succeeds" (the fetch worked) while silently failing most
// inserts — the customer_cif NOT NULL incident that hid for days — must surface as
// an error, not stay green. Triggers at ≥10 failed AND ≥5% of attempted rows.
func zohoFailedSpike(imported, failed int) (bool, string) {
	total := imported + failed
	if failed >= 10 && failed*20 >= total {
		pct := 0
		if total > 0 {
			pct = failed * 100 / total
		}
		return true, fmt.Sprintf("%d of %d inserts FAILED (%d%%) — check logs/backend-*.log for the DB error", failed, total, pct)
	}
	return false, ""
}

// runZohoTicketSync imports the newest `cap` Zoho Desk tickets (idempotent upserts,
// newest-first). Shared by the desk auto-sync poller and the webhook trigger.
func runZohoTicketSync(db *core.DB, cap int) {
	ctx := context.Background()
	if !zohoEnsureConfigured(ctx, db) {
		return
	}
	j := zohoJobs["tickets"]
	j.Lock()
	if j.running { // a manual or prior sync is already in flight — skip
		j.Unlock()
		return
	}
	j.running, j.done = true, false
	j.imported, j.skipped, j.failed, j.pages = 0, 0, 0, 0
	j.startedAt, j.endedAt, j.lastErr = time.Now(), time.Time{}, ""
	j.Unlock()
	WorkerBeat(ctx, db, "zoho_desk", "running", "", "")

	runZohoTicketImportJob(ctx, db, j, cap, true)

	j.Lock()
	j.running, j.done, j.endedAt = false, true, time.Now()
	imported, failed, lastErr := j.imported, j.failed, j.lastErr
	j.Unlock()
	slog.Info("zoho desk sync: tickets done", "imported", imported, "failed", failed)
	if lastErr != "" {
		WorkerBeat(ctx, db, "zoho_desk", "error", lastErr, lastErr)
	} else if spike, msg := zohoFailedSpike(imported, failed); spike {
		slog.Error("zoho desk sync: HIGH INSERT-FAILURE RATE", "imported", imported, "failed", failed)
		WorkerBeat(ctx, db, "zoho_desk", "error", "tickets: "+msg, "tickets: "+msg)
	} else {
		WorkerBeat(ctx, db, "zoho_desk", "ok", fmt.Sprintf("%d tickets imported", imported), "")
	}
}

// ── Webhook trigger debounce ──────────────────────────────────────────────────
//
// A single ticket change can fan out into several webhook POSTs; and Zoho can
// deliver bursts. Collapse them: at most one triggered sync per debounce window.

var (
	zohoTrigMu   sync.Mutex
	zohoTrigLast time.Time
)

const zohoWebhookDebounce = 8 * time.Second

// triggerZohoSync runs a small incremental calls+tickets sync in the background,
// debounced so a burst of webhooks results in one sync, not dozens.
func triggerZohoSync(db *core.DB) {
	zohoTrigMu.Lock()
	now := time.Now()
	if now.Sub(zohoTrigLast) < zohoWebhookDebounce {
		zohoTrigMu.Unlock()
		return
	}
	zohoTrigLast = now
	zohoTrigMu.Unlock()

	go func() {
		runZohoVoiceSyncCycle(db, 200) // recent calls
		runZohoTicketSync(db, 100)     // recent tickets
	}()
}

// ZohoWebhook receives Zoho Desk/Voice notification-rule POSTs, records the raw
// event, and triggers an incremental sync. Always returns 200 quickly (after auth)
// so Zoho doesn't retry — the sync happens asynchronously.
func ZohoWebhook(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		secret := resolveCredKey(ctx, db, "ZOHO_WEBHOOK_SECRET")
		if secret == "" {
			respondErr(w, 503, "zoho webhook not configured")
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("key")), []byte(secret)) != 1 {
			respondErr(w, 403, "forbidden")
			return
		}

		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // cap 1MB

		// Best-effort classify for the audit row (Zoho Desk sends eventType; Voice
		// varies). We don't map the payload into our schema — the importer does that.
		eventType := ""
		var parsed map[string]any
		if json.Unmarshal(body, &parsed) == nil {
			eventType = strings.TrimSpace(str(parsed["eventType"]))
			if eventType == "" {
				eventType = strings.TrimSpace(str(parsed["event_type"]))
			}
		}

		db.PGExec(ctx, `
			INSERT INTO zoho_webhook_events (event_type, raw, received_at)
			VALUES (NULLIF($1,''), $2::jsonb, NOW())`,
			eventType, string(body)) //nolint:errcheck

		triggerZohoSync(db)
		w.WriteHeader(http.StatusOK)
	}
}
