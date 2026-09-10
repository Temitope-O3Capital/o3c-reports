package handlers

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
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
	// Approval queues: signature over the (id,status) of the still-pending rows so ANY
	// change — a new request, a stage advance, or an item leaving on approve/reject —
	// flips the topic and the approval pages refetch live. (Approve/advance touches only
	// `status`, no timestamp, so a MAX(updated_at) signature would miss stage moves.)
	{"writeoffs", `SELECT COALESCE(md5(string_agg(id::text||status, ',' ORDER BY id)),'-')||':'||COUNT(*) FROM recovery_write_off_approvals WHERE status NOT IN ('approved','rejected')`},
	{"recovery_payments", `SELECT COALESCE(md5(string_agg(id::text||status, ',' ORDER BY id)),'-')||':'||COUNT(*) FROM recovery_payments WHERE status NOT IN ('approved','rejected')`},
	{"collection_payments", `SELECT COALESCE(md5(string_agg(id::text||status, ',' ORDER BY id)),'-')||':'||COUNT(*) FROM app.collection_payments WHERE status NOT IN ('approved','rejected')`},
	{"debt_sales", `SELECT COALESCE(md5(string_agg(id::text||status, ',' ORDER BY id)),'-')||':'||COUNT(*) FROM debt_sales WHERE deleted_at IS NULL AND status NOT IN ('approved','rejected')`},
	{"cards", `SELECT COUNT(*)||':'||COALESCE(MAX(id)::text,'0') FROM card_cycle_data`},
	{"fixed_deposits", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM fd_transactions`},
	{"mail", `SELECT (SELECT COUNT(*)||':'||COALESCE(MAX(received_at)::text,'') FROM inbound_mail)||'|'||(SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM mail_messages)`},
	{"cbs", `SELECT (SELECT COUNT(*)||':'||COALESCE(MAX(synced_at)::text,'') FROM cbs_loans)||'|'||(SELECT COUNT(*)||':'||COALESCE(MAX(synced_at)::text,'') FROM cbs_fixed_deposits)`},
	{"crm", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM crm_contacts`},
	{"deals", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM crm_deals`},
	{"tasks", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM crm_tasks`},
	{"campaigns", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM campaigns`},
	{"compliance", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM audit_findings`},
	{"finance", `SELECT COUNT(*)||':'||COALESCE(MAX(created_at)::text,'') FROM gl_journal_entries`},
	{"users", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM o3c_users`},
	// Calls were not a live topic at all, so the Call Log only ever refreshed when a
	// TICKET changed or the window regained focus — a call landing from Zoho Voice
	// left the page stale until the agent clicked away and back.
	{"calls", `SELECT COUNT(*)||':'||COALESCE(MAX(started_at)::text,'') FROM helpdesk_calls`},
	// The call-centre lead book and outbound queue are their own tables — a lead's
	// status/assignment moving (syncLeadFromCall runs async, just after the call
	// event) and a queue contact's disposition changing were invisible to the
	// change-feed, so the Leads list, the supervisor team panel and the queue only
	// went live on the 'calls' event (which fires BEFORE the status is written) or a
	// focus-refresh. Watch the tables themselves so those moves push too.
	{"cc_leads", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM call_center_leads`},
	{"cc_contacts", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM call_center_contacts`},
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
