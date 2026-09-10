package handlers

import (
	"context"
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

// upsertRingLegs records the per-agent ring sequence of one call. Idempotent on
// (call_id, position, agent_name), so the producer can re-ingest without duplicating.
// Agent names are resolved to a workspace user best-effort (nil when unknown).
func upsertRingLegs(ctx context.Context, db *core.DB, callID int64, provider, queue, strategy string, legs []RingLeg) {
	for _, leg := range legs {
		name := strings.TrimSpace(leg.AgentName)
		var agentID *int64
		if name != "" {
			agentID = zohoResolveAgent(ctx, db, "", "", name) // name-only match; provider-agnostic
		}
		db.PGExec(ctx, //nolint:errcheck
			`INSERT INTO call_ring_legs
			   (call_id, provider, queue_name, strategy, position, agent_name, agent_id, rang_at, ring_sec, outcome)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
			 ON CONFLICT (call_id, position, agent_name) DO UPDATE
			   SET provider   = EXCLUDED.provider,
			       queue_name = EXCLUDED.queue_name,
			       strategy   = EXCLUDED.strategy,
			       agent_id   = COALESCE(EXCLUDED.agent_id, call_ring_legs.agent_id),
			       rang_at    = COALESCE(EXCLUDED.rang_at, call_ring_legs.rang_at),
			       ring_sec   = COALESCE(EXCLUDED.ring_sec, call_ring_legs.ring_sec),
			       outcome    = COALESCE(NULLIF(EXCLUDED.outcome,''), call_ring_legs.outcome)`,
			callID, provider, strings.TrimSpace(queue), strings.TrimSpace(strategy),
			leg.Position, name, agentID, leg.RangAt, leg.RingSec, normLegOutcome(leg.Outcome))
	}
}
