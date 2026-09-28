package handlers

import (
	"strings"
	"testing"
)

// The step list is a vocabulary an agent picks from, and it is served to the form rather
// than duplicated in it. These pin the properties the form and the reports rely on.
func TestCustomerStepVocabularyIsWellFormed(t *testing.T) {
	if len(customerSteps) == 0 {
		t.Fatal("no steps defined")
	}
	seen := map[string]bool{}
	labels := map[string]bool{}
	for _, st := range customerSteps {
		if st.Code == "" || st.Label == "" || st.Hint == "" {
			t.Errorf("step %+v is missing a code, label or hint — the hint is what stops an "+
				"agent guessing what a step commits them to", st)
		}
		if seen[st.Code] {
			t.Errorf("duplicate step code %q", st.Code)
		}
		seen[st.Code] = true
		if labels[strings.ToLower(st.Label)] {
			t.Errorf("duplicate step label %q — customerStepByCode matches on label too, so "+
				"two steps sharing one would be indistinguishable", st.Label)
		}
		labels[strings.ToLower(st.Label)] = true
		if st.Won && !st.Terminal {
			t.Errorf("step %q is a win but not terminal", st.Code)
		}
	}
	// Exactly one won-terminal step, or a conversion rate has no denominator to sit on.
	won := 0
	for _, st := range customerSteps {
		if st.Won {
			won++
		}
	}
	if won != 1 {
		t.Errorf("%d steps are marked Won; there must be exactly one so a conversion rate "+
			"is computable without hardcoding a label somewhere else", won)
	}
}

// The journey has to hand over to LOS rather than duplicate it: these steps cover the
// stretch BEFORE an application exists, and 'application_started' is the seam.
func TestTheJourneyHandsOverToLos(t *testing.T) {
	if _, ok := customerStepByCode("application_started"); !ok {
		t.Error("no application_started step, so nothing marks where LOS takes over and " +
			"agents will reach for the LOS stages they cannot authorise")
	}
	// The LOS stage names must NOT appear here — a second copy of that pipeline is the
	// thing this vocabulary exists to avoid.
	for _, losOnly := range []string{"risk_head_review", "pending_conditions",
		"finance_approval", "booking", "document_collection"} {
		if _, ok := customerStepByCode(losOnly); ok {
			t.Errorf("%q is an LOS stage owned by Risk/Finance/Ops — a call-centre step "+
				"list must not shadow it", losOnly)
		}
	}
}

// A drop-off with no reason records that we lost somebody and teaches us nothing. It is
// the one step where the prose IS the value, so it is the one that demands it.
func TestOnlyDropOffDemandsAReason(t *testing.T) {
	for _, junk := range []string{"", " ", "-", "n/a", "left", "no"} {
		if !customerStepNoteMissing("dropped_off", junk) {
			t.Errorf("Dropped Off accepted %q as a reason", junk)
		}
	}
	if customerStepNoteMissing("dropped_off", "Took a facility from his own bank instead") {
		t.Error("a genuine drop-off reason was rejected")
	}
	for _, st := range customerSteps {
		if st.Code == "dropped_off" {
			continue
		}
		if customerStepNoteMissing(st.Code, "") {
			t.Errorf("%q demands a note; only Dropped Off should, or agents stop recording "+
				"steps at all", st.Code)
		}
	}
	// An unknown code must never be treated as needing one — the type check catches it
	// first, and reporting "needs a note" for a nonexistent step is a confusing error.
	if customerStepNoteMissing("not_a_step", "") {
		t.Error("an unrecognised step code was reported as needing a note")
	}
}

// The code is authoritative; the label is accepted as a convenience for a client that
// sends what it displayed. Both must resolve to the same step.
func TestStepsResolveByCodeOrLabel(t *testing.T) {
	for _, st := range customerSteps {
		byCode, ok1 := customerStepByCode(st.Code)
		byLabel, ok2 := customerStepByCode(st.Label)
		if !ok1 || !ok2 || byCode.Code != st.Code || byLabel.Code != st.Code {
			t.Errorf("step %q does not resolve by both code and label", st.Code)
		}
	}
	if _, ok := customerStepByCode("  CONVERTED  "); !ok {
		t.Error("step lookup should tolerate surrounding space and case, as the disposition " +
			"lookup beside it does")
	}
	if _, ok := customerStepByCode(""); ok {
		t.Error("an empty code resolved to a step")
	}
}

// A step that ends the journey must stop the dialling. This is the property that keeps
// the step vocabulary from repeating the defect the disposition vocabulary had until
// 2026-09-28: Converted and Paid resolved to nothing, so a lead we had already won stayed
// 'pending' and kept being called.
//
// The test is on the vocabulary rather than the UPDATE, because applyTerminalStep's only
// decision is which steps it acts on — the SQL itself is one guarded statement.
func TestEveryTerminalStepStopsTheDialling(t *testing.T) {
	terminal := 0
	for _, st := range customerSteps {
		if !st.Terminal {
			continue
		}
		terminal++
		// applyTerminalStep keys on Terminal, so this is the whole contract: a step that
		// ends the relationship is terminal, and a terminal step closes the contact.
		switch st.Code {
		case "converted", "dropped_off", "declined_not_eligible":
		default:
			t.Errorf("step %q is terminal — confirm it should close the outbound contact, "+
				"because applyTerminalStep will", st.Code)
		}
	}
	if terminal == 0 {
		t.Fatal("no terminal steps, so nothing ever stops the dialling")
	}
	// And the converse: a step that is mid-journey must NOT close anything. Closing on
	// "Documents Requested" would silently end the relationship we are in the middle of.
	for _, code := range []string{
		"information_sent", "customer_reviewing", "documents_requested",
		"documents_received", "met_customer", "application_started", "sent_to_risk",
		"customer_went_quiet",
	} {
		st, ok := customerStepByCode(code)
		if !ok {
			t.Errorf("step %q has gone missing from the vocabulary", code)
			continue
		}
		if st.Terminal {
			t.Errorf("step %q is mid-journey but marked terminal — it would close the "+
				"contact and stop the calls we are still making", code)
		}
	}
}

// 'converted' exists in BOTH vocabularies — as a call disposition (what the agent
// concluded on a call) and as a step (the customer took the product, on a date that is
// usually not the call's). That overlap is deliberate, but the two must stay distinct
// objects, because conflating them is what made agents rewrite the call in the first
// place.
func TestConvertedIsBothADispositionAndAStepWithoutCollision(t *testing.T) {
	d, okD := ccDispositionByCode("converted")
	s, okS := customerStepByCode("converted")
	if !okD || !okS {
		t.Fatal("converted must exist as both a disposition and a step")
	}
	if d.Status != "closed" {
		t.Errorf("the converted DISPOSITION should close the queue contact, got %q", d.Status)
	}
	if !s.Terminal || !s.Won {
		t.Error("the converted STEP should be terminal and a win")
	}
	// The step's hint has to tell the agent to date it honestly, which is the entire
	// reason the step exists rather than an edit to the old call.
	if !strings.Contains(strings.ToLower(s.Hint), "date") {
		t.Errorf("the converted step's hint does not mention the date: %q", s.Hint)
	}
}
