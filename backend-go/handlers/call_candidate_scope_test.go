package handlers

import "testing"

// Reported by the call centre: an agent was seeing other people's calls.
//
// The cause was GET /api/helpdesk/calls/candidates — the lookup behind the Log Call
// form. It filtered on the phone number and a time window and had NO row scope, so
// any agent typing a number saw the legs her colleagues had handled on it, with the
// customer name, the CIF and the handling agent. Worse, the modal auto-selects the
// most recent connected leg and adopts its duration, direction, customer name and
// CIF, so a colleague's call could become the basis of someone else's write-up.
//
// Measured over 72 hours before the fix: 40 phone numbers carried candidate legs
// from more than one agent. On one number, 8 legs across three other agents were
// visible to an agent who had handled none of them.
//
// The scope branch is taken when the viewer lacks call_center_stats, so these tests
// pin exactly that: an agent must not hold it, a head must. If a future change ever
// grants agents that page, the scope silently disappears everywhere it is used —
// the call list, recordings, stats and now this endpoint.

func TestCallCentreAgentCannotSeeTheWholeTeamsCalls(t *testing.T) {
	agent := reportClaims("call_center_agent")
	if agent.HasPage("call_center_stats") {
		t.Fatal("call_center_agent holds call_center_stats, which removes the row scope " +
			"from the call log, recordings, call stats and the candidate lookup")
	}
	if agent.CanSeeAllRows() {
		t.Fatal("call_center_agent can see all rows, which bypasses the candidate scope")
	}
}

func TestCallCentreHeadStillSeesTheWholeTeam(t *testing.T) {
	head := reportClaims("call_center_head")
	if !head.HasPage("call_center_stats") {
		t.Fatal("call_center_head lost call_center_stats — supervisors would be scoped " +
			"to their own calls and lose oversight")
	}
}

// Oversight is granted by the page, not by the role name, so a plain agent given
// that page deliberately becomes a supervisor. Worth asserting, because it is the
// documented mechanism in call_center_forwards.go and the scope depends on it.
func TestOversightTravelsWithThePageNotTheRoleName(t *testing.T) {
	promoted := reportClaims("call_center_agent", "call_center_head")
	if !promoted.HasPage("call_center_stats") {
		t.Fatal("an agent granted the head extra-role should gain call_center_stats")
	}
}
