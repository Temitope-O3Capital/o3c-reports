package handlers

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// liveTopics maps a realtime topic → a cheap signature query (row count + latest
// change marker). One global poller diffs these every few seconds and broadcasts
// the changed topic to every connected client, so pages refetch without any
// per-write-handler wiring. Per-topic query errors are ignored (that topic just
// never signals; pages still have focus-refresh as a fallback).
var liveTopics = []struct{ Name, SQL string }{
	{"tickets", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM helpdesk_tickets`},
	{"loans", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM loan_applications`},
	{"repayments", `SELECT COUNT(*)||':'||COALESCE(MAX(created_at)::text,'') FROM loan_repayments`},
	{"settlements", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM settlement_batches`},
	{"settlement_exceptions", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM settlement_exceptions`},
	{"manual_postings", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM manual_postings`},
	{"collections", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM collection_assignments`},
	{"recovery", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM recovery_cases`},
	{"cards", `SELECT COUNT(*)||':'||COALESCE(MAX(id)::text,'0') FROM card_cycle_data`},
	{"fixed_deposits", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM fd_transactions`},
	{"crm", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM crm_contacts`},
	{"deals", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM crm_deals`},
	{"tasks", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM crm_tasks`},
	{"campaigns", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM campaigns`},
	{"compliance", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM audit_findings`},
	{"finance", `SELECT COUNT(*)||':'||COALESCE(MAX(created_at)::text,'') FROM gl_journal_entries`},
	{"hr", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM leave_applications`},
	{"payroll", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM payroll_runs`},
	{"users", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM o3c_users`},
}

// ── Event hub — one poller, many subscribers ────────────────────────────────

type eventHub struct {
	mu   sync.Mutex
	subs map[chan string]struct{}
}

var hub = &eventHub{subs: map[chan string]struct{}{}}
var hubOnce sync.Once

func (h *eventHub) add() chan string {
	ch := make(chan string, 32)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *eventHub) remove(ch chan string) {
	h.mu.Lock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
	h.mu.Unlock()
}

func (h *eventHub) broadcast(topic string) {
	h.mu.Lock()
	for ch := range h.subs {
		select {
		case ch <- topic:
		default: // slow client — drop; its next focus-refresh reconciles
		}
	}
	h.mu.Unlock()
}

// startEventPoller runs a single background goroutine that diffs every topic
// every 4s and broadcasts changes. Query load is independent of client count.
func startEventPoller(db *core.DB) {
	hubOnce.Do(func() {
		go func() {
			ctx := context.Background()
			sig := make(map[string]string, len(liveTopics))
			for _, t := range liveTopics {
				if s, ok := topicSig(ctx, db, t.SQL); ok {
					sig[t.Name] = s
				}
			}
			tick := time.NewTicker(4 * time.Second)
			defer tick.Stop()
			for range tick.C {
				for _, t := range liveTopics {
					s, ok := topicSig(ctx, db, t.SQL)
					if !ok {
						continue
					}
					if sig[t.Name] != s {
						sig[t.Name] = s
						hub.broadcast(t.Name)
					}
				}
			}
		}()
	})
}

// RegisterEvents mounts the app-wide change-feed SSE (ticket-authenticated).
func RegisterEvents(r chi.Router, db *core.DB) {
	startEventPoller(db)
	r.Get("/sse", eventsSSE())
}

func eventsSSE() http.HandlerFunc {
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

		ch := hub.add()
		defer hub.remove(ch)

		fmt.Fprint(w, ":ok\n\n") //nolint:errcheck
		rc.Flush()               //nolint:errcheck

		heartbeat := time.NewTicker(25 * time.Second)
		defer heartbeat.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-heartbeat.C:
				fmt.Fprint(w, ":hb\n\n") //nolint:errcheck
				rc.Flush()               //nolint:errcheck
			case topic, ok := <-ch:
				if !ok {
					return
				}
				fmt.Fprintf(w, "event: %s\ndata: 1\n\n", topic) //nolint:errcheck
				rc.Flush()                                      //nolint:errcheck
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
