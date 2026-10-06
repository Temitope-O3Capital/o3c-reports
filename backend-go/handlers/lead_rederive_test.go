package handlers

import (
	"testing"

	"github.com/o3c/workspace/core"
)

func call(disposition, outcome string) core.Row {
	return core.Row{"disposition": disposition, "outcome": outcome}
}

// TestLeadStatusFromSurvivingCallsReplaysLead13080 is the case this exists for, with the
// real call history.
//
// On 2026-10-02 an agent logged "Converted" against lead 13080 (Crowning Products) at
// 11:06:02, realised, re-logged "Interested" at 11:07:31 and 11:11:26 — both refused by
// the forward-only guard, because 'interested' is rank 4 and 'converted' is rank 5 — and
// then voided all three calls. Nothing re-derived the lead, so a withdrawn call still
// owned its status four days later.
func TestLeadStatusFromSurvivingCallsReplaysLead13080(t *testing.T) {
	// What the lead actually held: one live call from 28 Sep, three voided from 2 Oct.
	// Only the survivor counts.
	survivors := []core.Row{call("Interested", "completed")}
	status, disposition := ccLeadStatusFromSurvivingCalls(survivors)
	if status != "interested" {
		t.Errorf("after voiding the Converted call, lead 13080 should read interested, got %q", status)
	}
	if disposition != "Interested" {
		t.Errorf("last_disposition should follow the call that set the status, got %q", disposition)
	}

	// Before the void, with the mistaken Converted still live, converted is correct —
	// the void is what changes the answer, not this function second-guessing the agent.
	all := []core.Row{
		call("Interested", "completed"),
		call("Converted", "completed"),
		call("Interested", "completed"),
	}
	if status, _ := ccLeadStatusFromSurvivingCalls(all); status != "converted" {
		t.Errorf("while the Converted call is live the lead is converted, got %q", status)
	}
}

// TestLeadStatusFromSurvivingCallsTakesTheHighestRank pins the rule itself: the same
// forward-only semantics as syncLeadFromCall, recomputed over a smaller set. Order must
// not matter — a lead keeps the best outcome it earned, not the last one recorded.
func TestLeadStatusFromSurvivingCallsTakesTheHighestRank(t *testing.T) {
	cases := []struct {
		name  string
		calls []core.Row
		want  string
	}{
		{"nothing left at all", nil, "pending"},
		{"only a no-answer", []core.Row{call("Unreachable / No Answer", "missed")}, "no_answer"},
		{"interested then a later no-answer", []core.Row{
			call("Interested", "completed"), call("Unreachable / No Answer", "missed"),
		}, "interested"},
		{"no-answer then interested — order must not matter", []core.Row{
			call("Unreachable / No Answer", "missed"), call("Interested", "completed"),
		}, "interested"},
		{"interested outranks not-ready", []core.Row{
			call("Interested", "completed"), call("Not Ready Yet", "completed"),
		}, "interested"},
		{"lead 13101: interested outranks information sent", []core.Row{
			call("Interested", "completed"), call("Information Sent — Awaiting Reply", "completed"),
		}, "interested"},
		{"lead 6655: a dropped call cannot lower an earned interested", []core.Row{
			call("Interested", "completed"), call("Call Dropped", "completed"), call("Call Dropped", "completed"),
		}, "interested"},
		{"only a dropped call keeps the lead pending for a retry", []core.Row{
			call("Call Dropped", "completed"),
		}, "pending"},
		{"a real conversion still wins", []core.Row{
			call("Interested", "completed"), call("Converted", "completed"),
		}, "converted"},
		{"do-not-call is terminal", []core.Row{
			call("Interested", "completed"), call("Do Not Call", "completed"),
		}, "dnc"},
		{"a call with no disposition falls back to its outcome", []core.Row{
			call("", "missed"),
		}, "no_answer"},
	}
	for _, c := range cases {
		if got, _ := ccLeadStatusFromSurvivingCalls(c.calls); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

// TestLeadStatusFromSurvivingCallsStaysInsideTheVocabulary guards the write: whatever this
// returns goes straight into call_center_leads.status, which has a CHECK constraint. A
// value outside it would reach the agent as a 500 on an unrelated action.
func TestLeadStatusFromSurvivingCallsStaysInsideTheVocabulary(t *testing.T) {
	for _, d := range ccDispositions {
		status, _ := ccLeadStatusFromSurvivingCalls([]core.Row{call(d.Label, "completed")})
		if !ccLeadStatuses[status] {
			t.Errorf("disposition %q produced status %q, which call_center_leads_status_chk "+
				"does not allow", d.Label, status)
		}
	}
	// And for the empty case, which is what a fully-voided lead hits.
	if status, _ := ccLeadStatusFromSurvivingCalls(nil); !ccLeadStatuses[status] {
		t.Errorf("a lead with no surviving calls produced invalid status %q", status)
	}
}
