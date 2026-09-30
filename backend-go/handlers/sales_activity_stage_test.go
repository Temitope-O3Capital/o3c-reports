package handlers

import "testing"

// Every stage a disposition claims to advance to must be a real stage. A typo here would fail
// silently at runtime: advanceLeadStage logs and gives up, the officer sees the activity save,
// and the lead never moves — which is exactly the failure this whole change is fixing.
func TestDispositionsAdvanceToRealStages(t *testing.T) {
	for kind, list := range salesDispositions {
		for _, d := range list {
			if d.Advances == "" {
				continue
			}
			if !leadStages[d.Advances] {
				t.Errorf("%s/%s advances to %q, which is not a lead stage", kind, d.Code, d.Advances)
			}
			if _, ok := leadStageOrder[d.Advances]; !ok {
				t.Errorf("%s/%s advances to %q, which has no rank in leadStageOrder", kind, d.Code, d.Advances)
			}
		}
	}
}

// A closing outcome must never move the lead. Disqualification is irreversible from the
// officer's side, so it stays an explicit act with a stated reason — never a side effect of
// choosing an option in a dropdown.
func TestClosingDispositionsAdvanceNothing(t *testing.T) {
	for kind, list := range salesDispositions {
		for _, d := range list {
			if d.Closes && d.Advances != "" {
				t.Errorf("%s/%s closes the pursuit but also advances to %q — closing outcomes must not move a lead",
					kind, d.Code, d.Advances)
			}
		}
	}
}

// The bug this replaced, pinned so it cannot return. Leads arrive from the call centre already
// at 'qualified', so any outcome targeting 'qualified' or earlier is a guaranteed no-op: the
// forward-only check refuses it and the officer sees nothing happen. An advancing disposition
// has to aim PAST where leads start.
func TestAdvancingDispositionsOutrankWhereLeadsArrive(t *testing.T) {
	arrival := leadStageOrder["qualified"]
	advancing := 0
	for kind, list := range salesDispositions {
		for _, d := range list {
			if d.Advances == "" {
				continue
			}
			advancing++
			if leadStageOrder[d.Advances] <= arrival {
				t.Errorf("%s/%s advances to %q (rank %d), which does not outrank 'qualified' (rank %d) — "+
					"leads arrive already qualified, so this outcome could never move one",
					kind, d.Code, d.Advances, leadStageOrder[d.Advances], arrival)
			}
		}
	}
	if advancing == 0 {
		t.Fatal("no disposition advances any lead — the pipeline is unreachable again")
	}
}

// Every stage an officer is expected to reach must be reachable by logging something. This is
// the test that would have caught the original defect: documents_requested had no route into it
// from any activity or any button, so it sat empty forever while the funnel drew it.
func TestOfficerReachableStagesHaveARoute(t *testing.T) {
	// approved and application_submitted are driven by the application flow
	// (advanceLeadOnApplication and the LOS decision), not by an activity. converted and
	// disqualified have their own endpoints, which do more than move a stage.
	wantReachable := []string{"handed_to_sales", "documents_requested"}

	reachable := map[string]bool{}
	for _, list := range salesDispositions {
		for _, d := range list {
			if d.Advances != "" {
				reachable[d.Advances] = true
			}
		}
	}
	for _, s := range wantReachable {
		if !reachable[s] {
			t.Errorf("no disposition advances a lead to %q — that stage is unreachable and the funnel "+
				"will draw it empty forever", s)
		}
	}
}

// Whatever a disposition asks for, it must be describable as forward motion on the one ladder
// the rest of the module measures against. A stage missing from leadStageOrder would compare as
// rank 0 and let an activity drag a lead back to the start.
func TestEveryStageHasARank(t *testing.T) {
	for stage := range leadStages {
		if _, ok := leadStageOrder[stage]; !ok {
			t.Errorf("stage %q has no entry in leadStageOrder, so it would compare as rank 0", stage)
		}
	}
}
