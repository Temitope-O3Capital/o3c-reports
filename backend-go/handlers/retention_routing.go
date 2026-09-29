package handlers

// Retention routing — turning a lifecycle bucket into a call.
//
// app.customer_lifecycle has scored every party nightly since migration 289, and the
// worker's own summary says so in plain numbers: "4615 workable for win-back (NGN
// 2.62bn)". Nothing consumed that. The bucket could be looked at on a page and nowhere
// else, so a customer identified as lapsed on Monday was still lapsed, unbothered, in
// December.
//
// This is the piece that lets it act, and it deliberately reuses the mechanism that
// already works rather than inventing one: batchSyncCollectionsToDialler has been
// queueing the delinquency book into call_center_contacts every night for months. This
// is the same insert with a different purpose and an eligibility check in front of it.
//
// WHY IT WILL QUEUE NOBODY TODAY, AND WHY THAT IS CORRECT. A win-back call is an offer,
// so its purpose is marketing, and marketing is opt-in (see consentIsOptIn in
// audience.go). app.party_contact_consent currently holds 35,780 rows and every one is
// purpose='servicing' on channel 'email' or 'sms'. There is no marketing consent for
// anybody and none at all on 'call'. ResolveAudience therefore refuses, and this logs
// the refusal instead of queueing anyone.
//
// That is the whole value of building it this way round. The alternative — writing the
// insert first and adding consent "later" — is how 4,615 people get called about an
// offer they never agreed to hear.
//
// OFF BY DEFAULT. Even once consent exists, queueing someone for a call is a decision
// about how the contact centre spends its day. RETENTION_CALL_QUEUE must be set to
// 'on' before a single row is written; until then the run resolves the audience, writes
// a heartbeat saying what it WOULD have queued, and stops. Same shape as the arrears
// reminder's staff_preview, for the same reason.

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/o3c/workspace/core"
)

const retentionQueueWorkerKey = "retention_call_queue"

// The buckets worth a win-back call, and the order is the priority. 'churned' is
// deliberately absent: 6,517 parties sit there, it is the largest measured bucket by
// far, and a call to someone who left long ago is a different conversation from a nudge
// to someone drifting. Start where the relationship is still warm.
var retentionCallBuckets = []string{"at_risk", "cooling", "dormant"}

// retentionQueueOn is the gate, kept pure so it can be tested without a database.
//
// Only the exact word 'on' enables writing. Not "true", not "yes", not "1" — a setting
// that turns on a thing which rings customers should be unambiguous to whoever reads it
// in the credentials table, and a typo must fail closed.
func retentionQueueOn(raw string) bool {
	return strings.EqualFold(strings.TrimSpace(raw), "on")
}

// retentionQueueEnabled gates the write. Anything but 'on' means resolve and report.
func retentionQueueEnabled(ctx context.Context, db *core.DB) bool {
	return retentionQueueOn(resolveCredKey(ctx, db, "RETENTION_CALL_QUEUE"))
}

// retentionParseMax caps a night's queueing so a first live run cannot flood the floor.
// An unreadable value falls back to the default rather than to "no cap".
func retentionParseMax(raw string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && n > 0 {
		return n
	}
	return def
}

func retentionQueueMax(ctx context.Context, db *core.DB) int {
	return retentionParseMax(resolveCredKey(ctx, db, "RETENTION_CALL_QUEUE_MAX"), 50)
}

// batchQueueRetentionCalls resolves the win-back audience and, when enabled, queues it.
//
// Returns the number of rows actually written — zero while the audience is refused or
// the gate is off, which is the expected state until marketing consent exists.
func batchQueueRetentionCalls(ctx context.Context, db *core.DB) (int64, error) {
	WorkerBeat(ctx, db, retentionQueueWorkerKey, "running", "", "")

	res, err := ResolveAudience(ctx, db, AudienceSpec{
		Purpose: purposeMarketing,
		Channel: "call",
		Buckets: retentionCallBuckets,
		// Never target someone we have never measured: bucket='unknown' means we hold
		// no transaction history, not that they are inactive.
		RequireMeasured: true,
		// A person who owes us money gets the collections call, not an offer. This is
		// the guard that keeps the two queues from talking over each other.
		ExcludeInCollections: true,
		Limit:                retentionQueueMax(ctx, db),
	})
	if err != nil {
		WorkerBeat(ctx, db, retentionQueueWorkerKey, "error", "", err.Error())
		return 0, fmt.Errorf("resolve retention audience: %w", err)
	}
	if res.Refusal != "" {
		// Not an error: the system is working. Say so in the words the resolver used,
		// so the heartbeat on the Sync Status page explains itself without a lookup.
		WorkerBeat(ctx, db, retentionQueueWorkerKey, "idle", res.Refusal, "")
		return 0, nil
	}

	summary := fmt.Sprintf("%d examined, %d eligible%s",
		res.Examined, res.Eligible, retentionExclusionSummary(res))

	if !retentionQueueEnabled(ctx, db) {
		WorkerBeat(ctx, db, retentionQueueWorkerKey, "idle",
			"RETENTION_CALL_QUEUE is off — "+summary+"; nothing queued", "")
		return 0, nil
	}
	if len(res.Members) == 0 {
		WorkerBeat(ctx, db, retentionQueueWorkerKey, "idle", summary+"; nobody to queue", "")
		return 0, nil
	}

	var queued int64
	for _, m := range res.Members {
		// One open retention call per person. Without this a nightly run re-queues
		// anyone the floor has not got to yet, and the queue grows faster than it is
		// worked — the failure the collections feed already guards against.
		r, execErr := db.PGExec(ctx, `
			INSERT INTO call_center_contacts
			  (customer_name, phone, party_id, priority, is_existing_customer,
			   status, purpose, source)
			SELECT $1, $2, $3, $4, true, 'pending', 'retention', 'retention'
			 WHERE NOT EXISTS (
			   SELECT 1 FROM call_center_contacts t
			    WHERE t.party_id = $3 AND t.purpose = 'retention' AND t.status = 'pending'
			 )`,
			m.Name, m.Address, m.PartyID, retentionPriority(m.Tier))
		if execErr != nil {
			WorkerBeat(ctx, db, retentionQueueWorkerKey, "error", summary, execErr.Error())
			return queued, fmt.Errorf("queue retention call: %w", execErr)
		}
		if n, _ := r.RowsAffected(); n > 0 {
			queued += n
		}
	}
	WorkerBeat(ctx, db, retentionQueueWorkerKey, "ok",
		fmt.Sprintf("%s; %d queued for calling", summary, queued), "")
	return queued, nil
}

// retentionPriority maps value tier to the dialler's priority vocabulary, matching the
// values batchSyncCollectionsToDialler already writes.
func retentionPriority(tier string) string {
	switch tier {
	case "vip", "gold":
		return "High"
	case "silver":
		return "Medium"
	default:
		return "Low"
	}
}

// retentionExclusionSummary renders the exclusion counts in a stable order, so the
// heartbeat reads the same way every night and a change in it means a change in the
// data rather than in map iteration.
func retentionExclusionSummary(res AudienceResult) string {
	order := []string{
		exNoMoneyHistory, exNoContact, exInCollections,
		exNoAddress, exNoConsent, exConsentWithdrawn, exSuppressed,
	}
	parts := make([]string, 0, len(order))
	for _, k := range order {
		if n := res.ExcludedBy[k]; n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", n, k))
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, ", ") + ")"
}
