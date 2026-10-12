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
	// Cards watched only the cycle feed, so the Issuance page — which subscribes to
	// this topic — never went live: raising a request or crediting a seller left every
	// other viewer stale until they clicked away and back. Widened rather than split
	// into a new topic so the existing subscribers pick it up with no frontend change.
	{"cards", `SELECT (SELECT COUNT(*)||':'||COALESCE(MAX(id)::text,'0') FROM card_cycle_data)||'|'||(SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM card_issuance_requests)||'|'||(SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM card_sale_attributions)`},
	// Exactly the cards problem one line above, and the same remedy. This watched
	// fd_transactions — the retired ops book, zero rows since the deposit desk
	// moved to Udara — so the signature was a constant "0:" and the topic could
	// never fire. The deposits Dashboard subscribes to it and therefore never went
	// live: the book could move by billions and every open viewer stayed stale
	// until they navigated away and back. Widened to the live register rather than
	// split into a new topic, so existing subscribers pick it up with no frontend
	// change; the legacy table stays in the signature so anything still writing to
	// it is not silently ignored.
	{"fixed_deposits", `SELECT (SELECT COUNT(*)||':'||COALESCE(MAX(synced_at)::text,'') FROM cbs_fixed_deposits)||'|'||(SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM fd_transactions)`},
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
	//
	// Every part of this signature is index-served. COUNT(*) over the whole ledger was
	// not: no index can answer it, so 171k+ rows were sequentially scanned every 4s for
	// as long as any Call Log tab was open. MAX(id) replaces it — the id is monotonic,
	// so it moves on every insert exactly as the count did, and it comes off the primary
	// key. The two partial indexes (voided_at, needs_review) then make voids, restores
	// and review-flag changes signal too, which the old count-and-max never did.
	{"calls", `SELECT COALESCE(MAX(id),0)::text
	             ||':'||COALESCE(MAX(started_at)::text,'')
	             ||':'||(SELECT COUNT(*)||'/'||COALESCE(MAX(voided_at)::text,'')
	                       FROM helpdesk_calls WHERE voided_at IS NOT NULL)
	             ||':'||(SELECT COUNT(*) FROM helpdesk_calls WHERE needs_review)
	           FROM helpdesk_calls`},
	// The call-centre lead book and outbound queue are their own tables — a lead's
	// status/assignment moving (syncLeadFromCall runs async, just after the call
	// event) and a queue contact's disposition changing were invisible to the
	// change-feed, so the Leads list, the supervisor team panel and the queue only
	// went live on the 'calls' event (which fires BEFORE the status is written) or a
	// focus-refresh. Watch the tables themselves so those moves push too.
	{"cc_leads", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM call_center_leads`},
	{"cc_contacts", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM call_center_contacts`},
	// Sales activity and the visit diary had no topic at all, so the thing a sales officer
	// does most — log a call or visit, plan one, complete one — was the one thing no other
	// screen ever saw: a supervisor watching the team diary, the officer’s own day sheet and
	// the lead’s timeline all sat on yesterday until something unrelated happened to fire.
	//
	// app.activities is append-mostly and carries no updated_at, so the signature is MAX(id)
	// plus the latest occurrence — an insert moves the id, a backdated log moves the date.
	{"activities", `SELECT COALESCE(MAX(id),0)::text||':'||COALESCE(MAX(COALESCE(occurred_at, created_at))::text,'') FROM app.activities`},
	{"sales_visits", `SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM app.sales_visit_plans`},
	// Management reports: a send starting or finishing, or recipients changing, pushes to
	// the Reports page so a "Sending" badge turns to "Sent" without a refresh.
	{"management_reports", `SELECT (SELECT COUNT(*)||':'||COALESCE(MAX(updated_at)::text,'') FROM management_reports)||'|'||(SELECT COUNT(*)||':'||COUNT(*) FILTER (WHERE status = 'running')||':'||COALESCE(MAX(COALESCE(finished_at, started_at))::text,'') FROM management_report_runs)`},
}

// ── Event hub — one poller, many subscribers ────────────────────────────────

type eventHub struct {
	mu   sync.Mutex
	subs map[chan string]struct{}
}

var hub = &eventHub{subs: map[chan string]struct{}{}}
var hubOnce sync.Once

// kick asks the poller to diff RIGHT NOW instead of waiting out its 4s tick.
//
// Capacity 1 with a non-blocking send is the whole debounce: a hundred writes in the
// same instant leave exactly one pending diff, so a bulk import or a 40-lead
// distribution costs the same as a single edit.
var kick = make(chan struct{}, 1)

// LiveAfterWrite makes the change-feed fire as soon as a write lands, from one place,
// for every route in the app.
//
// The poller was the only thing that ever broadcast, so the floor on "when does the
// screen catch up" was its 4s tick and the ceiling was a page's own 15s fallback poll.
// That is what "I edited the name and had to refresh" actually was: the refetch after
// the save was wired correctly and did run, but every OTHER open view — the supervisor
// watching the same lead book, the agent's second tab, the dashboard behind it — sat on
// stale rows until the next diff came round. Signalling here collapses that to the
// ~150ms settle below.
//
// It hangs off the request method rather than off each handler deliberately: wiring a
// broadcast into several hundred mutating handlers is several hundred chances to forget
// one, and a forgotten one is invisible — the page just feels slow. A method check
// cannot be forgotten.
//
// Only 2xx/3xx kicks. A rejected write changed nothing, and re-diffing every topic on a
// storm of 401s or 422s would turn a bad client into a load generator.
func LiveAfterWrite(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		sw := &statusSniffer{ResponseWriter: w, code: 200}
		next.ServeHTTP(sw, r)
		if sw.code >= 200 && sw.code < 400 {
			select {
			case kick <- struct{}{}:
			default: // a diff is already pending — it will see this write too
			}
		}
	})
}

// statusSniffer records the status code so LiveAfterWrite can ignore failed writes.
// It forwards Flush and Unwrap so streaming responses and http.ResponseController
// still work through it — the SSE handler itself is a GET and never wrapped, but a
// future streaming POST would break silently without these.
type statusSniffer struct {
	http.ResponseWriter
	code    int
	written bool
}

func (s *statusSniffer) WriteHeader(code int) {
	if !s.written {
		s.code, s.written = code, true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusSniffer) Write(b []byte) (int, error) {
	s.written = true // an implicit 200
	return s.ResponseWriter.Write(b)
}

func (s *statusSniffer) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func (s *statusSniffer) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

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

// startEventPoller runs a single background goroutine that diffs every topic and
// broadcasts what changed. Query load is independent of client count.
//
// It wakes on either of two things: its own 4s tick, which catches changes this process
// did not serve (a migration, a worker, a psql session, the other node), and a kick from
// LiveAfterWrite the moment a write returns, which is what makes an edit by one person
// appear on everyone else's screen immediately rather than up to 4s later.
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
			diff := func() {
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
			tick := time.NewTicker(4 * time.Second)
			defer tick.Stop()
			for {
				select {
				case <-tick.C:
					diff()
				case <-kick:
					// Settle first. The handler has already replied, so its own
					// transaction is committed, but plenty of writes finish work in a
					// goroutine after that — syncLeadFromCall is the standing example,
					// which is exactly why 'calls' firing before the lead status lands
					// needed its own topic. Diffing instantly would read the table
					// before the follow-up write and then not look again for 4s.
					time.Sleep(150 * time.Millisecond)
					diff()
					// And again, once, for the slower async tail. Cheap: every topic
					// signature is index-served, and an unchanged one broadcasts nothing.
					time.Sleep(1200 * time.Millisecond)
					diff()
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
