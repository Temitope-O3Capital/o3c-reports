package handlers

import (
	"testing"

	"github.com/o3c/workspace/core"
)

// The six collections templates as they are actually named in app.message_templates,
// lowest id first — so rows[0] here is the same gentlest template the old fallback
// returned in production.
func dunningBandTemplates() []core.Row {
	return []core.Row{
		{"id": int64(7), "name": "Arrears Reminder · 1-30 Days"},
		{"id": int64(18), "name": "Arrears Reminder · 31-60 Days"},
		{"id": int64(19), "name": "Arrears Reminder · 61-90 Days"},
		{"id": int64(20), "name": "Arrears Reminder · 91-180 Days"},
		{"id": int64(21), "name": "Arrears Reminder · 181-360 Days"},
		{"id": int64(22), "name": "Arrears Reminder · 360+ Days"},
	}
}

// TestDunningTemplateForReportsAnExactBand pins the second return value. Every band has
// its own wording today, so nothing should be substituted — and a run that silently
// substitutes is the failure this flag exists to surface.
func TestDunningTemplateForReportsAnExactBand(t *testing.T) {
	rows := dunningBandTemplates()
	for _, c := range []struct {
		bucket string
		wantID int64
	}{
		{"1-30", 7}, {"31-60", 18}, {"61-90", 19},
		{"91-180", 20}, {"181-360", 21}, {"360+", 22},
	} {
		tpl, exact := dunningTemplateFor(rows, c.bucket)
		if !exact {
			t.Errorf("bucket %q reported as substituted, but a template names it", c.bucket)
		}
		if got := toInt64(tpl["id"]); got != c.wantID {
			t.Errorf("bucket %q → template %d, want %d (%q)", c.bucket, got, c.wantID, tpl["name"])
		}
	}
}

// TestDunningSubstitutesDownwardsNotByID is the fix.
//
// The fallback was `rows[0]` — the lowest-numbered collections template, which on
// 2026-10-06 was id 7, "Arrears Reminder · 1-30 Days", the SOFTEST of the six. Ordering by
// id is ordering by when someone happened to create a row; it bore no relationship to
// severity, so renaming the 360+ template sent the 401 facilities over a year overdue the
// 1-30 Days courtesy wording.
//
// Note what is NOT changed here: the facility is still written to. That is deliberate and
// predates this change — TestDunningTemplateForFallsBackToFirst records it, and a band with
// no wording of its own is a gap in the template set rather than a reason to leave a
// delinquent borrower uncontacted. Only the DIRECTION of the substitution is fixed.
func TestDunningSubstitutesDownwardsNotByID(t *testing.T) {
	// The exact production failure: the oldest band's template gets renamed.
	renamed := dunningBandTemplates()
	renamed[5] = core.Row{"id": int64(22), "name": "Final Demand Before Solicitors"}

	tpl, exact := dunningTemplateFor(renamed, "360+")
	if exact {
		t.Fatal("a renamed 360+ template should not count as an exact band match")
	}
	if tpl == nil {
		t.Fatal("the facility must still be written to — substituting, not skipping, is " +
			"the behaviour TestDunningTemplateForFallsBackToFirst records as deliberate")
	}
	if got := toInt64(tpl["id"]); got == 7 {
		t.Error("band 360+ fell back to template 7 (1-30 Days) — this is the bug: a " +
			"borrower a year overdue receiving the gentlest courtesy reminder")
	} else if got != 21 {
		t.Errorf("band 360+ substituted template %d (%q), want 21 (181-360, the firmest "+
			"wording at or below it)", got, tpl["name"])
	}

	// Generalised: removing any band's own template must substitute the band immediately
	// below it, never the lowest id. This is the property that makes the error one step of
	// leniency instead of up to five.
	wantBelow := map[string]int64{
		"31-60": 7, "61-90": 18, "91-180": 19, "181-360": 20, "360+": 21,
	}
	for bucket, wantID := range wantBelow {
		rows := make([]core.Row, 0, 5)
		for _, r := range dunningBandTemplates() {
			if dunningTemplateMatches(str(r["name"]), bucket) {
				continue // the band's own template is missing
			}
			rows = append(rows, r)
		}
		tpl, exact := dunningTemplateFor(rows, bucket)
		if exact {
			t.Errorf("bucket %q reported exact with its own template removed", bucket)
		}
		if got := toInt64(tpl["id"]); got != wantID {
			t.Errorf("bucket %q with no template of its own substituted %d (%q), want %d",
				bucket, got, tpl["name"], wantID)
		}
	}

	// The gentlest band has nothing below it, and an unknown band cannot be placed at all.
	// Both land on the lowest-numbered template: being too gentle with a facility we
	// cannot classify is the safe direction for a demand for money.
	for _, bucket := range []string{"1-30", "721+", "unknown", ""} {
		rows := dunningBandTemplates()
		if bucket == "1-30" {
			rows = rows[1:] // its own template missing, nothing below it
		}
		if tpl, _ := dunningTemplateFor(rows, bucket); tpl == nil {
			t.Errorf("bucket %q returned no template at all", bucket)
		}
	}
}

// TestLeadDeclinedOnCallReadsCodeAndLabelAlike closes the asymmetry the old substring
// test had.
//
// It lowercased the input and replaced underscores with spaces so that, in its own words,
// "the CODE and the LABEL are matched by the same words". That held for two of the three
// declining dispositions and failed for the third: "winback_declined" becomes "winback
// declined", which contains neither "not interested" nor "do not call", while its label
// "Not Interested in Returning" matched. Callers differ in which form they send, so the
// same refusal could or could not un-qualify a lead depending on the screen.
func TestLeadDeclinedOnCallReadsCodeAndLabelAlike(t *testing.T) {
	for _, d := range ccDispositions {
		code, label := d.Code, d.Label
		byCode := leadDeclinedOnCall("completed", &code)
		byLabel := leadDeclinedOnCall("completed", &label)
		if byCode != byLabel {
			t.Errorf("%q: code says declined=%v but label %q says %v — the same outcome "+
				"must read the same whichever form the screen sent", code, byCode, label, byLabel)
		}
		if want := ccDecliningDispositionCodes[code]; byCode != want {
			t.Errorf("%q: declined=%v, want %v", code, byCode, want)
		}
	}
}

// TestLeadDeclinedOnCallStaysNarrow guards the other direction. This is the ONE thing
// allowed to overturn an earned 'interested', so a false positive silently un-qualifies a
// warm lead — and the reasons each of these is excluded are recorded beside the function.
func TestLeadDeclinedOnCallStaysNarrow(t *testing.T) {
	for _, s := range []string{
		"Unreachable / No Answer",  // establishes nothing about whether they still want it
		"Not Ready Yet",            // a timing objection; its hint reads "Interested but not now"
		"Not Eligible",             // OUR decline, not theirs
		"Rate or Charges Too High", // open question, §14.9 — deliberately not here yet
		"Callback Scheduled",
		"Other — Describe What Happened",
		"", "completed", "answered",
	} {
		d := s
		if leadDeclinedOnCall("completed", &d) {
			t.Errorf("%q must not count as the customer declining", s)
		}
	}
	// Free text that predates the catalogue still has to work: ccDispositionCode resolves
	// it, which is the whole reason this reads codes rather than substrings.
	for _, s := range []string{"not interested", "Customer is not interested", "do not call"} {
		d := s
		if !leadDeclinedOnCall("completed", &d) {
			t.Errorf("%q should count as the customer declining", s)
		}
	}
	// Falls back to the outcome when no disposition was sent.
	if leadDeclinedOnCall("missed", nil) {
		t.Error("a missed call is not a decline")
	}
}
