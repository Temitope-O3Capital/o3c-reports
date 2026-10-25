package handlers

import (
	"testing"
	"time"

	"github.com/o3c/workspace/core"
)

// The management desk's access model and its verbs, tested at the level they are decided.
//
// These exist because the desk shipped with an "Ask — and get an answer" button that called
// the same handler as Comment and did nothing, and with escalation offered to people who
// should only be able to read. Both were decided by small pure functions, and neither was
// covered — so the behaviour drifted from the copy describing it without anything failing.

func deskClaims(id int64, role string, extra, pages []string) *core.Claims {
	return &core.Claims{ID: id, Role: role, ExtraRoles: extra, Pages: pages}
}

// mustDay parses a bare date in LOCAL time, which is what weekOf works in. time.Parse
// would give UTC and shift the day boundary for Lagos.
func mustDay(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := time.ParseInLocation("2006-01-02", s, time.Local)
	if err != nil {
		t.Fatalf("bad test date %q: %v", s, err)
	}
	return d
}

func TestCanSeeSubjectTypeIsPageHeld(t *testing.T) {
	st := subjectTypeRow{
		SubjectType: "sales_officer_week",
		PageKeys:    []string{"sales", "sales_team"},
	}

	// Holding EITHER key is enough: the registry's page_keys are any-of, which is what
	// lets a sales head and an officer reading their own week both reach it.
	for _, pages := range [][]string{{"sales"}, {"sales_team"}, {"sales", "sales_team"}} {
		if !canSeeSubjectType(deskClaims(30, "sales_officer", nil, pages), st) {
			t.Errorf("holding %v must open the subject", pages)
		}
	}

	// Holding neither is a refusal, and that is the whole access model — there is no
	// per-note access list to fall back on, by design.
	if canSeeSubjectType(deskClaims(99, "care_agent", nil, []string{"helpdesk", "care"}), st) {
		t.Error("a care agent holding neither key must not open a sales subject")
	}
	if canSeeSubjectType(nil, st) {
		t.Error("an absent user must never open a subject")
	}

	// A type with no page keys is visible to nobody rather than to everybody. The
	// migration's CHECK refuses an empty array, so this is the belt to that braces: if a
	// row ever arrives empty, it must fail closed.
	if canSeeSubjectType(deskClaims(1, "admin", nil, []string{"sales"}),
		subjectTypeRow{SubjectType: "x"}) {
		t.Error("a subject type with no page keys must be visible to nobody")
	}
}

func TestEscalateIsManagementsAlone(t *testing.T) {
	st := subjectTypeRow{
		SubjectType: "sales_officer_week",
		PageKeys:    []string{"sales", "sales_team"},
		Verbs:       []string{"comment", "acknowledge", "ask", "escalate"},
	}
	has := func(vs []string, v string) bool {
		for _, x := range vs {
			if x == v {
				return true
			}
		}
		return false
	}

	// Everyone who can see a subject may comment and acknowledge. Comment especially: it is
	// how a head ANSWERS the MD, so restricting it to management would make the thread
	// one-sided and the 'answered' state unreachable.
	officer := deskClaims(30, "sales_officer", nil, []string{"sales"})
	ov := verbsFor(officer, st)
	for _, v := range []string{"comment", "acknowledge", "ask"} {
		if !has(ov, v) {
			t.Errorf("an officer who can see a subject must be able to %q", v)
		}
	}
	if has(ov, "escalate") {
		t.Error("an officer must not be able to escalate — escalating to yourself is not a thing")
	}

	for _, role := range []string{"md", "coo", "cmo"} {
		v := verbsFor(deskClaims(1, role, nil, []string{"sales", "sales_team"}), st)
		if !has(v, "escalate") {
			t.Errorf("%s must be able to escalate", role)
		}
	}

	// A head whose ROLE is sales_officer still cannot escalate, which is correct: they
	// supervise their team's work, and escalation goes UP from them.
	teamHead := deskClaims(44, "sales_officer", nil, []string{"sales", "sales_team"})
	if has(verbsFor(teamHead, st), "escalate") {
		t.Error("a team head is not management; escalation goes up from them")
	}

	// verbsFor only ever narrows. A verb the registry does not list can never appear,
	// so turning one off in the table is sufficient to remove it from the UI.
	narrow := subjectTypeRow{Verbs: []string{"comment"}}
	if got := verbsFor(deskClaims(1, "md", nil, nil), narrow); len(got) != 1 || got[0] != "comment" {
		t.Errorf("verbsFor must never add a verb the registry omits; got %v", got)
	}
}

// weekOf and lastCompleteWeek decide which week the desk judges, and getting them wrong
// means judging a week that is still running — an officer looks idle for the ordinary
// reason that the week is not over.
func TestTheWeekUnderReviewIsAlreadyFinished(t *testing.T) {
	// A Wednesday.
	wed := mustDay(t, "2026-10-21")
	from, to := weekOf(wed)
	if got := from.Format("2006-01-02"); got != "2026-10-19" {
		t.Errorf("week should start Monday 19 Oct, got %s", got)
	}
	if got := to.Format("2006-01-02"); got != "2026-10-25" {
		t.Errorf("week should end Sunday 25 Oct, got %s", got)
	}

	// Sunday CLOSES a week rather than opening one — the bug a naive Weekday() check makes,
	// which would put Sunday 25 Oct into the week beginning 26 Oct.
	sun := mustDay(t, "2026-10-25")
	sfrom, _ := weekOf(sun)
	if got := sfrom.Format("2006-01-02"); got != "2026-10-19" {
		t.Errorf("Sunday must close the week beginning 19 Oct, got %s", got)
	}

	// And the week under review is the one BEFORE the week in progress.
	lf, lt := lastCompleteWeek(wed)
	if got := lf.Format("2006-01-02"); got != "2026-10-12" {
		t.Errorf("last complete week should start 12 Oct, got %s", got)
	}
	if !lt.Before(wed) {
		t.Error("the week under review must have finished before today")
	}
}

func TestNoteFirstLineIsOneLine(t *testing.T) {
	if got := noteFirstLine("first\nsecond", 100); got != "first" {
		t.Errorf("a notification body must not carry the second line; got %q", got)
	}
	if got := noteFirstLine("短", 100); got != "短" {
		t.Errorf("multibyte text must survive; got %q", got)
	}
	// Truncation counts RUNES, not bytes — slicing a multibyte string by byte index
	// produces a replacement character in the notification.
	long := "ααααααααα"
	got := noteFirstLine(long, 4)
	if got != "αααα..." {
		t.Errorf("truncation must count runes; got %q", got)
	}
}
