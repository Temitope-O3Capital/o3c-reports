package handlers

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// liveTopics maps a realtime topic name → a cheap signature query (row count +
// latest change timestamp). A single central poller diffs these every few
// seconds and pushes the topic name to all connected clients when it changes,
// so pages can refetch without any per-write-handler wiring. Per-topic query
// errors are ignored (that topic simply never signals — pages still have their
// own polling / focus-refresh as a fallback).
var liveTopics = []struct{ Name, SQL string }{
	{"tickets", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM helpdesk_tickets`},
	{"loans", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM loan_applications`},
	{"settlements", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM settlement_batches`},
	{"settlement_exceptions", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM settlement_exceptions`},
	{"manual_postings", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM manual_postings`},
	{"recovery", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM recovery_cases`},
	{"crm", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM crm_contacts`},
	{"repayments", `SELECT COUNT(*)||':'||COALESCE(MAX(created_at)::text,'') FROM loan_repayments`},
}

// RegisterEvents mounts the app-wide change-feed SSE (ticket-authenticated).
func RegisterEvents(r chi.Router, db *core.DB) {
	r.Get("/sse", eventsSSE(db))
}

func eventsSSE(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ticket := r.URL.Query().Get("ticket")
		if ticket == "" {
			respondErr(w, 401, "Missing SSE ticket")
			return
		}
		if _, err := core.VerifySSEToken(ticket); err != nil {
			respondErr(w, 401, "Invalid or expired SSE ticket")
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		rc := http.NewResponseController(w)
		ctx := r.Context()

		// Seed signatures so we only push changes that occur after connect.
		sig := make(map[string]string, len(liveTopics))
		for _, t := range liveTopics {
			if s, ok := topicSig(ctx, db, t.SQL); ok {
				sig[t.Name] = s
			}
		}
		fmt.Fprint(w, ":ok\n\n") //nolint:errcheck
		rc.Flush()               //nolint:errcheck

		poll := time.NewTicker(4 * time.Second)
		heartbeat := time.NewTicker(25 * time.Second)
		defer poll.Stop()
		defer heartbeat.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-heartbeat.C:
				fmt.Fprint(w, ":hb\n\n") //nolint:errcheck
				rc.Flush()               //nolint:errcheck
			case <-poll.C:
				changed := false
				for _, t := range liveTopics {
					s, ok := topicSig(ctx, db, t.SQL)
					if !ok {
						continue
					}
					if sig[t.Name] != s {
						sig[t.Name] = s
						fmt.Fprintf(w, "event: %s\ndata: %s\n\n", t.Name, s) //nolint:errcheck
						changed = true
					}
				}
				if changed {
					rc.Flush() //nolint:errcheck
				}
			}
		}
	}
}

func topicSig(ctx context.Context, db *core.DB, sql string) (string, bool) {
	rows, err := db.PGQuery(ctx, sql)
	if err != nil || len(rows) == 0 {
		return "", false
	}
	for _, v := range rows[0] { // single-column result
		return str(v), true
	}
	return "", false
}
