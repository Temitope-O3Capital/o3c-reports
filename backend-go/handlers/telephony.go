package handlers

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/workspace/core"
)

// Provider-neutral telephony model.
//
// This is the seam that keeps inbound queue / ring / abandonment data independent of any
// one carrier. A "producer" (Zoho Voice today; a self-hosted FreeSWITCH or another
// provider tomorrow — see docs/IN_APP_CALLING_PLAN) maps its own call data into these
// structs and calls these two writers. Everything downstream — the DB, the inbound API,
// the UI, reporting — reads only helpdesk_calls + call_ring_legs and never learns which
// provider produced the data. Swapping providers is a new producer, not a schema change.

// CallTelephony carries the neutral telephony facts of one call. Zero/empty fields are
// left untouched on the row (COALESCE), so a producer supplies only what it knows.
type CallTelephony struct {
	Provider       string     // zoho_voice | freeswitch | africastalking | manual | ...
	AnsweredAt     *time.Time // when an agent picked up; nil = never answered
	WaitSec        *int       // ring/wait seconds before answer, or before hang-up if abandoned
	DisconnectedBy string     // 'agent' | 'caller' | 'system' | '' — who hung up
	HangupCause    string     // raw provider cause, kept verbatim
	QueueName      string     // the ring group / queue / department the call came through
	Abandoned      *bool      // caller hung up before any agent answered
}

// RingLeg is one agent's turn in the ring sequence of a queued call.
type RingLeg struct {
	Position  int        // 1-based ring order
	AgentName string     // as the provider names the agent (resolved to a workspace user best-effort)
	RangAt    *time.Time // when this agent started ringing
	RingSec   *int       // how long it rang this agent
	Outcome   string     // answered | missed | no_answer | rejected | moved_on | cancelled
}

// normDisconnectedBy folds a provider's hang-up-party value into the neutral vocabulary.
func normDisconnectedBy(s string) string {
	switch l := strings.ToLower(strings.TrimSpace(s)); {
	case l == "":
		return ""
	case strings.Contains(l, "agent"), strings.Contains(l, "user"), strings.Contains(l, "callee"):
		return "agent"
	case strings.Contains(l, "caller"), strings.Contains(l, "customer"), strings.Contains(l, "client"), strings.Contains(l, "remote"):
		return "caller"
	default:
		return "system"
	}
}

// normLegOutcome folds a provider's per-agent ring result into the neutral vocabulary.
func normLegOutcome(s string) string {
	switch l := strings.ToLower(strings.TrimSpace(s)); {
	case l == "":
		return ""
	case strings.Contains(l, "answer") && !strings.Contains(l, "no"), strings.Contains(l, "connect"), strings.Contains(l, "pick"), strings.Contains(l, "bridge"):
		return "answered"
	case strings.Contains(l, "reject"), strings.Contains(l, "declin"), strings.Contains(l, "busy"):
		return "rejected"
	case strings.Contains(l, "no answer"), strings.Contains(l, "noanswer"), strings.Contains(l, "no_answer"), strings.Contains(l, "timeout"), strings.Contains(l, "unanswer"):
		return "no_answer"
	case strings.Contains(l, "miss"):
		return "missed"
	case strings.Contains(l, "cancel"), strings.Contains(l, "abandon"):
		return "cancelled"
	case strings.Contains(l, "next"), strings.Contains(l, "moved"), strings.Contains(l, "skip"), strings.Contains(l, "pass"),
		strings.Contains(l, "unalloc"), strings.Contains(l, "unavail"), strings.Contains(l, "unregist"),
		strings.Contains(l, "offline"), strings.Contains(l, "reachable"):
		// Agent's line couldn't be rung (unallocated/unavailable/offline) → the queue
		// passed this agent and moved to the next one.
		return "moved_on"
	default:
		return l
	}
}

// enrichCallTelephony writes the neutral telephony facts onto an existing call row. It
// only fills a field the producer supplied (COALESCE / NULLIF), so re-running is a no-op
// and one producer never wipes another's data. Errors are logged by the caller.
func enrichCallTelephony(ctx context.Context, db *core.DB, callID int64, t CallTelephony) error {
	_, err := db.PGExec(ctx, `
		UPDATE helpdesk_calls
		   SET answered_at        = COALESCE($2, answered_at),
		       wait_sec           = COALESCE($3, wait_sec),
		       disconnected_by    = COALESCE(NULLIF($4,''), disconnected_by),
		       hangup_cause       = COALESCE(NULLIF($5,''), hangup_cause),
		       queue_name         = COALESCE(NULLIF($6,''), queue_name),
		       abandoned          = COALESCE($7, abandoned),
		       telephony_provider = COALESCE(NULLIF($8,''), telephony_provider)
		 WHERE id = $1`,
		callID, t.AnsweredAt, t.WaitSec, normDisconnectedBy(t.DisconnectedBy),
		strings.TrimSpace(t.HangupCause), strings.TrimSpace(t.QueueName), t.Abandoned, t.Provider)
	return err
}

// upsertRingLegs records the per-agent ring sequence of one call.
//
// The producer passes the COMPLETE sequence for the call; this makes the stored
// legs match it exactly. Three things that matters for:
//
//   - Rename safety. The unique key is (call_id, position, agent_name), so a
//     provider that renames an agent between ingests does NOT update the existing
//     leg — it inserts a second one at the same position. The prune at the end
//     removes any stored leg the producer no longer claims, so a rename ends up
//     as one corrected leg rather than two contradictory ones.
//   - One round-trip, not one per leg. A queued call rings several agents, and
//     the old shape issued a separate statement (plus an agent lookup) for each.
//   - Errors reach the caller instead of vanishing. Silently losing the ring
//     sequence is exactly the kind of gap the inbound page exists to close.
//
// Deliberately provider-agnostic: an agent name is resolved to a workspace user
// in SQL, by a full-name match that is only trusted when it hits exactly ONE
// active user (a shared/ambiguous name resolves to NULL rather than to an
// arbitrary person). No provider's crosswalk is consulted, so a new producer
// needs nothing added here.
func upsertRingLegs(ctx context.Context, db *core.DB, callID int64, provider, queue, strategy string, legs []RingLeg) error {
	// Dedupe on the storage key: one payload listing the same agent twice at the
	// same position would otherwise abort the upsert ("cannot affect row a second
	// time"). A leg with no agent name is not a leg anyone can act on — drop it.
	seen := make(map[string]bool, len(legs))
	vals := make([]string, 0, len(legs))
	args := []any{callID, provider, strings.TrimSpace(queue), strings.TrimSpace(strategy)}
	for _, leg := range legs {
		name := strings.TrimSpace(leg.AgentName)
		if name == "" {
			continue
		}
		key := strconv.Itoa(leg.Position) + "|" + strings.ToLower(name)
		if seen[key] {
			continue
		}
		seen[key] = true
		n := len(args)
		if len(vals) == 0 {
			// The first row carries the casts that fix the column types for the rest.
			vals = append(vals, fmt.Sprintf("($%d::int,$%d::text,$%d::timestamptz,$%d::int,$%d::text)",
				n+1, n+2, n+3, n+4, n+5))
		} else {
			vals = append(vals, fmt.Sprintf("($%d,$%d,$%d,$%d,$%d)", n+1, n+2, n+3, n+4, n+5))
		}
		args = append(args, leg.Position, name, leg.RangAt, leg.RingSec, normLegOutcome(leg.Outcome))
	}
	if len(vals) == 0 {
		return nil
	}

	// The DELETE sees the pre-statement snapshot, so it can only remove legs that
	// already existed and are absent from `supplied` — never a row the upsert just
	// wrote, and never one the upsert is updating (those are in `supplied`). The
	// two arms are therefore disjoint by construction.
	_, err := db.PGExec(ctx, `
		WITH supplied(position, agent_name, rang_at, ring_sec, outcome) AS (
		  VALUES `+strings.Join(vals, ",")+`
		),
		up AS (
		  INSERT INTO call_ring_legs
		    (call_id, provider, queue_name, strategy, position, agent_name, agent_id, rang_at, ring_sec, outcome)
		  SELECT $1, $2, $3, $4, s.position, s.agent_name,
		         (SELECT MIN(u.id) FROM o3c_users u
		           WHERE lower(trim(u.full_name)) = lower(trim(s.agent_name))
		             AND u.deleted_at IS NULL
		          HAVING COUNT(*) = 1),
		         s.rang_at, s.ring_sec, s.outcome
		    FROM supplied s
		  ON CONFLICT (call_id, position, agent_name) DO UPDATE
		    SET provider   = EXCLUDED.provider,
		        queue_name = EXCLUDED.queue_name,
		        strategy   = EXCLUDED.strategy,
		        agent_id   = COALESCE(EXCLUDED.agent_id, call_ring_legs.agent_id),
		        rang_at    = COALESCE(EXCLUDED.rang_at, call_ring_legs.rang_at),
		        ring_sec   = COALESCE(EXCLUDED.ring_sec, call_ring_legs.ring_sec),
		        outcome    = COALESCE(NULLIF(EXCLUDED.outcome,''), call_ring_legs.outcome)
		  RETURNING 1
		)
		DELETE FROM call_ring_legs l
		 WHERE l.call_id = $1
		   AND NOT EXISTS (
		     SELECT 1 FROM supplied s
		      WHERE s.position = l.position AND s.agent_name = l.agent_name)`, args...)
	return err
}
