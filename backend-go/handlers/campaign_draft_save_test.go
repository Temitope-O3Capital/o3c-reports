package handlers

import "testing"

// A schedule is only real if the STATUS moves with it. The scheduler looks for
// `status='scheduled' AND scheduled_at <= NOW()`, so a date written against a
// 'draft' row is inert — the campaign page showed a send time that would never
// fire. And a 'scheduled' row whose date is cleared matches no query at all, so it
// used to be stuck pending with no way back to draft.
func TestSettingAScheduleMovesADraftToScheduled(t *testing.T) {
	if got := campaignStatusForSchedule("draft", "2026-11-01T09:00:00Z"); got != "scheduled" {
		t.Fatalf("draft + date = %q, want scheduled", got)
	}
}

func TestClearingTheScheduleReturnsItToDraft(t *testing.T) {
	for _, cleared := range []any{nil, "", "   "} {
		if got := campaignStatusForSchedule("scheduled", cleared); got != "draft" {
			t.Errorf("scheduled + %#v = %q, want draft", cleared, got)
		}
	}
}

func TestNoPointlessStatusChurn(t *testing.T) {
	// Already in the right state: leave it alone rather than rewriting the status.
	if got := campaignStatusForSchedule("scheduled", "2026-11-01T09:00:00Z"); got != "" {
		t.Errorf("scheduled + date = %q, want no change", got)
	}
	if got := campaignStatusForSchedule("draft", nil); got != "" {
		t.Errorf("draft + no date = %q, want no change", got)
	}
}

// Only draft <-> scheduled may move. Inferring a status for a running or finished
// campaign from a date would be a far worse bug than the one being fixed — it could
// restart a completed send or un-cancel a cancelled one.
func TestALiveOrFinishedCampaignIsNeverRestatusedByADate(t *testing.T) {
	for _, st := range []string{"active", "paused", "completed", "cancelled", "sending", ""} {
		if got := campaignStatusForSchedule(st, "2026-11-01T09:00:00Z"); got != "" {
			t.Errorf("%q + date = %q, want no change", st, got)
		}
		if got := campaignStatusForSchedule(st, nil); got != "" {
			t.Errorf("%q + cleared = %q, want no change", st, got)
		}
	}
}

// A non-string scheduled_at (a number from a sloppy client, say) must read as
// "no date" rather than panic or be treated as a valid time.
func TestAnUnusableScheduleValueCountsAsCleared(t *testing.T) {
	if got := campaignStatusForSchedule("scheduled", 12345); got != "draft" {
		t.Fatalf("scheduled + non-string = %q, want draft", got)
	}
	if got := campaignStatusForSchedule("draft", 12345); got != "" {
		t.Fatalf("draft + non-string = %q, want no change", got)
	}
}

// purpose is the gate that decides whether consent is required at all, so the
// writable set must contain it — it was readable in four places and writable in
// none, pinning every campaign to 'marketing' for life.
func TestPurposeIsWritable(t *testing.T) {
	found := false
	for _, c := range campaignUpdateCols {
		if c == "purpose" {
			found = true
		}
	}
	if !found {
		t.Fatal("purpose is not in campaignUpdateCols, so it cannot be changed")
	}
}

// The update whitelist must not grow to include things that would let a client
// drive the send machinery through an ordinary draft save.
func TestUpdateWhitelistExcludesTheSendMachinery(t *testing.T) {
	forbidden := map[string]string{
		"status":         "status moves only through start/pause/cancel and the schedule rule",
		"type":           "changing the channel after contacts are snapshotted would orphan them",
		"total_contacts": "derived from the list, not client input",
		"sent_count":     "a counter the dispatcher owns",
		"emails_sent":    "a counter the dispatcher owns",
		"sms_sent":       "a counter the dispatcher owns",
		"started_at":     "set by the dispatcher",
		"completed_at":   "set by the dispatcher",
		"created_by":     "authorship is not editable",
	}
	for _, c := range campaignUpdateCols {
		if why, bad := forbidden[c]; bad {
			t.Errorf("campaignUpdateCols must not contain %q: %s", c, why)
		}
	}
}
