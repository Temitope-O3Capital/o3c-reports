package handlers

import (
	"strings"
	"testing"
	"time"
)

const hour = time.Hour

// The real edit patterns on helpdesk_call_edits as at 2026-09-28, with the average delay
// each was actually made at. If this guard does not classify these correctly it is not
// solving the problem it was written for.
func TestTheRealEditPatternsAreClassifiedCorrectly(t *testing.T) {
	for _, tc := range []struct {
		name     string
		from, to string
		age      time.Duration
		want     callEditKind
		whyItsSo string
	}{
		// 188 of 280 edits. Two thirds. Must never be impeded.
		{"filling in a blank, minutes later", "", "Unreachable / No Answer", 1 * hour,
			editFillingBlank, "completing a log, not rewriting one"},
		{"filling in a blank, days later", "", "Not Eligible", 14 * hour,
			editFillingBlank, "still just completing it — lateness alone is not an offence"},

		// The user's own example, and the pattern with the longest delays.
		{"interested becomes converted", "Interested", "Converted", 72 * hour,
			editLaterDevelopment, "they converted later; the call still recorded Interested"},
		{"interested becomes not interested", "Interested", "Not Interested", 104 * hour,
			editLaterDevelopment, "nobody learns 4 days later what was said on the call"},
		{"interested becomes not eligible", "Interested", "Not Eligible", 132 * hour,
			editLaterDevelopment, "eligibility was checked afterwards"},
		{"not ready becomes not interested", "Not Ready Yet", "Not Interested", 27 * hour,
			editLaterDevelopment, "the customer moved; the call did not"},

		// 13 edits. The second dial disappears completely.
		{"callback becomes unreachable", "Callback Scheduled", "Unreachable / No Answer", 17 * hour,
			editNewAttempt, "they made the callback and overwrote the conversation"},

		// Genuine same-shift corrections. All of these really happened, all within the hour.
		{"mis-picked no answer on a call that connected", "Unreachable / No Answer", "Interested", 30 * time.Minute,
			editCorrection, "agent fixing their own mis-click"},
		{"dropped relabelled as no answer", "Call Dropped", "Unreachable / No Answer", 0,
			editCorrection, "same dialling episode, seconds later"},
		{"not interested to do not call", "Not Interested", "Do Not Call", 0,
			editCorrection, "sharpening the outcome immediately"},

		// Inside the window, any shape is treated as a plausible mis-pick — the agent is
		// still in the same shift as the call.
		{"interested to converted, same shift", "Interested", "Converted", 2 * hour,
			editCorrection, "recent enough to be a mis-pick"},

		// Late, but from a no-contact outcome: almost always an agent who forgot to write
		// up the dial that did connect. Allowed, with a reason.
		{"late write-up of a call that did connect", "Unreachable / No Answer", "Promise to Pay", 40 * hour,
			editLateCorrection, "the conversation happened; it was logged on the wrong row"},

		// Wrong Number is genuinely ambiguous — a dead number, or a person telling you so.
		// Never refuse on an ambiguity.
		{"wrong number, late", "Wrong Number", "Not Interested", 50 * hour,
			editLateCorrection, "ambiguous by nature; a wrong refusal costs a real correction"},

		// A synonym is not a change at all.
		{"ptp relabelled to its long form", "PTP", "Promise to Pay", 200 * hour,
			editCorrection, "same code — nothing actually changed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyDispositionEdit(tc.from, tc.to, tc.age)
			if got != tc.want {
				t.Errorf("%q → %q at %.0fh = %v, want %v (%s)",
					tc.from, tc.to, tc.age.Hours(), got, tc.want, tc.whyItsSo)
			}
		})
	}
}

// Filling in a blank is two thirds of all edits. If this guard ever asks those agents
// for a reason, it has made the common case worse to fix the rare one.
func TestFillingInABlankIsNeverImpeded(t *testing.T) {
	for _, age := range []time.Duration{0, 1 * hour, 100 * hour, 1000 * hour} {
		kind := classifyDispositionEdit("", "Not Interested", age)
		if kind != editFillingBlank {
			t.Fatalf("blank → value at %.0fh classified %v", age.Hours(), kind)
		}
		if msg := callEditRefusal(kind, "", "Not Interested", ""); msg != "" {
			t.Errorf("at %.0fh an agent completing their own log was refused: %s", age.Hours(), msg)
		}
		if callEditNeedsReason(kind) {
			t.Errorf("at %.0fh an agent completing their own log was asked for a reason", age.Hours())
		}
	}
}

// A refusal that does not tell the agent what to do instead does not prevent the bad
// record — the agent finds another way to write the same thing.
func TestEveryRefusalNamesTheControlToUseInstead(t *testing.T) {
	cases := []struct {
		kind             callEditKind
		wantSuggest      string
		mustMentionOneOf []string
	}{
		{editLaterDevelopment, "record_step", []string{"Record an Update"}},
		{editNewAttempt, "log_new_call", []string{"own call", "log that attempt", "Log that attempt"}},
	}
	for _, c := range cases {
		msg := callEditRefusal(c.kind, "Interested", "Converted", "")
		if msg == "" {
			t.Errorf("kind %v did not refuse at all", c.kind)
			continue
		}
		if got := editSuggestion(c.kind); got != c.wantSuggest {
			t.Errorf("kind %v suggests %q, want %q", c.kind, got, c.wantSuggest)
		}
		found := false
		for _, phrase := range c.mustMentionOneOf {
			if strings.Contains(msg, phrase) {
				found = true
			}
		}
		if !found {
			t.Errorf("kind %v refusal never names an alternative: %q", c.kind, msg)
		}
		// It must also quote both outcomes, or the agent cannot tell which call it means.
		if !strings.Contains(msg, "Interested") || !strings.Contains(msg, "Converted") {
			t.Errorf("kind %v refusal does not say which outcomes it is about: %q", c.kind, msg)
		}
	}
}

// A late correction is allowed, but 278 of 280 edits recorded no reason — so the reason
// has to be demanded, and it has to be real prose.
func TestALateCorrectionDemandsRealProse(t *testing.T) {
	kind := classifyDispositionEdit("Unreachable / No Answer", "Promise to Pay", 40*hour)
	if kind != editLateCorrection {
		t.Fatalf("expected editLateCorrection, got %v", kind)
	}
	for _, junk := range []string{"", " ", "fix", "-", "n/a", "typo", "mistake"} {
		if callEditRefusal(kind, "Unreachable / No Answer", "Promise to Pay", junk) == "" {
			t.Errorf("reason %q was accepted for a late correction", junk)
		}
	}
	real := "He rang back on my mobile and agreed 50k on Friday"
	if msg := callEditRefusal(kind, "Unreachable / No Answer", "Promise to Pay", real); msg != "" {
		t.Errorf("a real explanation was still refused: %s", msg)
	}
	// And inside the window, no reason is required at all.
	early := classifyDispositionEdit("Unreachable / No Answer", "Promise to Pay", 10*time.Minute)
	if msg := callEditRefusal(early, "Unreachable / No Answer", "Promise to Pay", ""); msg != "" {
		t.Errorf("a same-shift correction was refused: %s", msg)
	}
}

// A missing or skewed started_at must not block real work. Refusing an agent's
// correction because of a bad timestamp trades a bookkeeping problem for a work stoppage.
func TestABadTimestampFailsOpen(t *testing.T) {
	for _, age := range []time.Duration{0, -5 * hour, -1000 * hour} {
		if got := classifyDispositionEdit("Interested", "Converted", age); got != editCorrection {
			t.Errorf("age %v classified %v, want editCorrection (fail open)", age, got)
		}
	}
}

// The window has to sit in the gap between the two populations: corrections landed at
// 0.1–0.6h, developments at 17h and up. A window outside that range would either refuse
// real corrections or wave developments through.
func TestTheCorrectionWindowSitsBetweenTheTwoPopulations(t *testing.T) {
	if callCorrectionWindow <= 1*hour {
		t.Errorf("window %v is inside the correction population (up to ~0.6h observed, "+
			"but agents notice things later in the same shift)", callCorrectionWindow)
	}
	if callCorrectionWindow >= 17*hour {
		t.Errorf("window %v reaches the development population — Callback → Unreachable "+
			"was observed at 16.8h and must still be caught", callCorrectionWindow)
	}
}
