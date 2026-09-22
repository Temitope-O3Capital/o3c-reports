package handlers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func mrAt(y int, mo time.Month, d, h, mi int) time.Time {
	return time.Date(y, mo, d, h, mi, 0, 0, mrWAT)
}

// 14 September 2026 is a Monday.
func TestMRNextDue(t *testing.T) {
	cases := []struct {
		name    string
		rule    string
		now     time.Time
		handled bool
		want    time.Time
	}{
		{"daily report on a Monday waits for Tuesday", "tue_to_sat", mrAt(2026, 9, 14, 8, 0), false, mrAt(2026, 9, 15, 9, 0)},
		{"due later this morning", "tue_to_sat", mrAt(2026, 9, 15, 8, 0), false, mrAt(2026, 9, 15, 9, 0)},
		{"late but inside the catch-up window stays today", "tue_to_sat", mrAt(2026, 9, 15, 10, 30), false, mrAt(2026, 9, 15, 9, 0)},
		{"past the catch-up window moves to the next day", "tue_to_sat", mrAt(2026, 9, 15, 13, 0), false, mrAt(2026, 9, 16, 9, 0)},
		{"already sent today moves on", "tue_to_sat", mrAt(2026, 9, 15, 9, 5), true, mrAt(2026, 9, 16, 9, 0)},
		{"Saturday after sending skips Sunday and Monday", "tue_to_sat", mrAt(2026, 9, 19, 10, 0), true, mrAt(2026, 9, 22, 9, 0)},
		{"weekly due this Monday morning", "monday", mrAt(2026, 9, 14, 8, 0), false, mrAt(2026, 9, 14, 9, 0)},
		{"weekly after sending moves a week", "monday", mrAt(2026, 9, 14, 9, 30), true, mrAt(2026, 9, 21, 9, 0)},
		{"monthly waits for the 1st", "first_of_month", mrAt(2026, 9, 14, 8, 0), false, mrAt(2026, 10, 1, 9, 0)},
		{"monthly across a year end", "first_of_month", mrAt(2026, 12, 2, 9, 0), false, mrAt(2027, 1, 1, 9, 0)},
		{"an unknown rule is never due", "hourly", mrAt(2026, 9, 14, 8, 0), false, time.Time{}},
	}
	for _, c := range cases {
		got := mrNextDue(c.rule, "09:00", c.now, c.handled)
		if !got.Equal(c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestMRNextDueUsesWATWhateverTheServerClock(t *testing.T) {
	// 07:30 UTC on Tuesday is 08:30 WAT: the daily report is still due at 09:00 WAT today.
	now := time.Date(2026, 9, 15, 7, 30, 0, 0, time.UTC)
	if got, want := mrNextDue("tue_to_sat", "09:00", now, false), mrAt(2026, 9, 15, 9, 0); !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestMRDueOnSundayNeverSends(t *testing.T) {
	sunday := mrAt(2026, 9, 20, 9, 0)
	for _, rule := range []string{"tue_to_sat", "monday", "first_of_month"} {
		if mrDueOn(rule, sunday) {
			t.Errorf("%s should not be due on a Sunday", rule)
		}
	}
}

func TestMRSendAtFallsBackToNine(t *testing.T) {
	got := mrSendAt(mrAt(2026, 9, 15, 0, 0), "not a time")
	if want := mrAt(2026, 9, 15, 9, 0); !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestMRCleanRecipients(t *testing.T) {
	clean, bad := mrCleanRecipients([]string{
		" MD@O3Cards.com ", "md@o3cards.com", "", "not-an-email", "Temi <temi@o3cards.com>", "nodot@localhost",
	})
	if want := []string{"md@o3cards.com", "temi@o3cards.com"}; !reflect.DeepEqual(clean, want) {
		t.Errorf("clean: got %v, want %v", clean, want)
	}
	if want := []string{"not-an-email", "nodot@localhost"}; !reflect.DeepEqual(bad, want) {
		t.Errorf("bad: got %v, want %v", bad, want)
	}
}

// A full week, 14 (Monday) to 20 (Sunday) September 2026, for every rule, plus the 1st.
func TestMRDueOnEveryRuleAcrossAWeek(t *testing.T) {
	days := []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
	want := map[string][7]bool{
		"tue_to_sat":     {false, true, true, true, true, true, false},
		"weekdays":       {true, true, true, true, true, false, false},
		"every_day":      {true, true, true, true, true, true, true},
		"monday":         {true, false, false, false, false, false, false},
		"tuesday":        {false, true, false, false, false, false, false},
		"wednesday":      {false, false, true, false, false, false, false},
		"thursday":       {false, false, false, true, false, false, false},
		"friday":         {false, false, false, false, true, false, false},
		"first_of_month": {false, false, false, false, false, false, false},
		"hourly":         {false, false, false, false, false, false, false},
	}
	for rule, week := range want {
		for i := 0; i < 7; i++ {
			day := mrAt(2026, 9, 14+i, 9, 0)
			if day.Weekday().String()[:3] != days[i] {
				t.Fatalf("calendar assumption wrong: %v is not a %s", day, days[i])
			}
			if got := mrDueOn(rule, day); got != week[i] {
				t.Errorf("%s on %s %v: got %v, want %v", rule, days[i], day.Format("2 Jan"), got, week[i])
			}
		}
	}
	// 1 October 2026 is a Thursday.
	first := mrAt(2026, 10, 1, 9, 0)
	for rule, due := range map[string]bool{"first_of_month": true, "thursday": true, "weekdays": true, "monday": false} {
		if got := mrDueOn(rule, first); got != due {
			t.Errorf("%s on 1 Oct: got %v, want %v", rule, got, due)
		}
	}
	// Every rule in the catalogue list is one mrDueOn knows: each is due at least once in 40 days.
	for _, d := range mrDueRules {
		if mrNextDue(d.ID, "09:00", mrAt(2026, 9, 14, 0, 0), false).IsZero() {
			t.Errorf("rule %s is never due", d.ID)
		}
	}
}

func TestMRNextDueNewRules(t *testing.T) {
	cases := []struct {
		name    string
		rule    string
		now     time.Time
		handled bool
		want    time.Time
	}{
		{"weekdays due Friday morning", "weekdays", mrAt(2026, 9, 18, 8, 0), false, mrAt(2026, 9, 18, 9, 0)},
		{"weekdays after Friday's send skips the weekend", "weekdays", mrAt(2026, 9, 18, 9, 30), true, mrAt(2026, 9, 21, 9, 0)},
		{"weekdays on a Saturday waits for Monday", "weekdays", mrAt(2026, 9, 19, 10, 0), false, mrAt(2026, 9, 21, 9, 0)},
		{"every day includes Sunday", "every_day", mrAt(2026, 9, 19, 9, 30), true, mrAt(2026, 9, 20, 9, 0)},
		{"every day due later today", "every_day", mrAt(2026, 9, 20, 8, 0), false, mrAt(2026, 9, 20, 9, 0)},
		{"tuesday from a Monday", "tuesday", mrAt(2026, 9, 14, 8, 0), false, mrAt(2026, 9, 15, 9, 0)},
		{"tuesday past the catch-up window moves a week", "tuesday", mrAt(2026, 9, 15, 13, 0), false, mrAt(2026, 9, 22, 9, 0)},
		{"friday from a Monday", "friday", mrAt(2026, 9, 14, 8, 0), false, mrAt(2026, 9, 18, 9, 0)},
		{"friday after sending moves a week", "friday", mrAt(2026, 9, 18, 9, 10), true, mrAt(2026, 9, 25, 9, 0)},
	}
	for _, c := range cases {
		if got := mrNextDue(c.rule, "09:00", c.now, c.handled); !got.Equal(c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestMRSlug(t *testing.T) {
	cases := map[string]string{
		"Collections Weekly":        "collections-weekly",
		"  Cards & Risk — Daily!  ": "cards-risk-daily",
		"Sales: Lagos (Team 2)":     "sales-lagos-team-2",
		"---":                       "report",
		"":                          "report",
		"Ọja Ọ̀sẹ̀":                 "ja-s",
		"A very long report name that goes on and on past forty": "a-very-long-report-name-that-goes-on-and",
		"abcdefghijklmnopqrstuvwxyz0123456789abc d":              "abcdefghijklmnopqrstuvwxyz0123456789abc",
	}
	for in, want := range cases {
		got := mrSlug(in)
		if got != want {
			t.Errorf("mrSlug(%q) = %q, want %q", in, got, want)
		}
		if len(got) > 40 {
			t.Errorf("mrSlug(%q) is %d characters", in, len(got))
		}
	}
}

func TestMRUniqueKey(t *testing.T) {
	taken := map[string]bool{"collections": true, "collections-2": true}
	if got := mrUniqueKey("collections", taken); got != "collections-3" {
		t.Errorf("got %q, want collections-3", got)
	}
	if got := mrUniqueKey("fresh", taken); got != "fresh" {
		t.Errorf("got %q, want fresh", got)
	}
	// The built-in keys and route words are never handed out, even when no row holds them.
	for _, k := range []string{"daily", "sales-weekly", "summary", "catalogue", "runs", "preview"} {
		if got := mrUniqueKey(k, map[string]bool{}); got != k+"-2" {
			t.Errorf("mrUniqueKey(%q) = %q, want %q", k, got, k+"-2")
		}
	}
	long := "a-very-long-report-name-that-goes-on-and" // 40 characters
	if got := mrUniqueKey(long, map[string]bool{long: true}); got != "a-very-long-report-name-that-goes-on-a-2" || len(got) > 40 {
		t.Errorf("long key: got %q (%d)", got, len(got))
	}
	// A cut that would end on a hyphen drops it rather than making "--2".
	hy := "abcdefghijklmnopqrstuvwxyz-abcdefghij-mn" // 40, a hyphen at 38
	if len(hy) != 40 {
		t.Fatalf("fixture is %d characters", len(hy))
	}
	if got := mrUniqueKey(hy, map[string]bool{hy: true}); got != "abcdefghijklmnopqrstuvwxyz-abcdefghij-2" {
		t.Errorf("hyphen cut: got %q", got)
	}
}

func TestMRCheckSchedule(t *testing.T) {
	fits := map[string][]string{
		"daily":   {"tue_to_sat", "weekdays", "every_day"},
		"weekly":  {"monday", "tuesday", "wednesday", "thursday", "friday"},
		"monthly": {"first_of_month"},
	}
	for cadence, rules := range fits {
		for _, d := range mrDueRules {
			msg := mrCheckSchedule(cadence, d.ID)
			if ok := mrIn(d.ID, rules); ok != (msg == "") {
				t.Errorf("%s + %s: message %q, should fit = %v", cadence, d.ID, msg, ok)
			}
		}
	}
	if msg := mrCheckSchedule("weekly", "every_day"); msg != `A weekly report cannot go out "Every Day". Choose one of: Every Monday, Every Tuesday, Every Wednesday, Every Thursday, Every Friday.` {
		t.Errorf("mismatch message: %q", msg)
	}
	if msg := mrCheckSchedule("daily", "saturday"); msg == "" {
		t.Error("an unknown rule was accepted")
	}
	if msg := mrCheckSchedule("hourly", "every_day"); msg != `The cadence must be "daily", "weekly" or "monthly".` {
		t.Errorf("bad cadence message: %q", msg)
	}
}

func TestMRCheckSections(t *testing.T) {
	known := map[string]bool{"headline": true, "cards": true, "overview": true}
	if msg := mrCheckSections([]string{"headline", "cards"}, known); msg != "" {
		t.Errorf("valid list rejected: %s", msg)
	}
	if msg := mrCheckSections(nil, known); msg != "Choose at least one section for the report." {
		t.Errorf("empty: %q", msg)
	}
	if msg := mrCheckSections([]string{"headline", "cards", "headline"}, known); msg != `The section "headline" is included more than once.` {
		t.Errorf("duplicate: %q", msg)
	}
	if msg := mrCheckSections([]string{"headline", "nope", "gone"}, known); msg != "Not a section in the catalogue: nope, gone." {
		t.Errorf("unknown: %q", msg)
	}
	many := make([]string, 41)
	for i := range many {
		many[i] = "headline"
	}
	if msg := mrCheckSections(many, known); msg != "A report can have at most 40 sections." {
		t.Errorf("too many: %q", msg)
	}
}

func TestMRCheckSendTime(t *testing.T) {
	ok := map[string]string{"09:00": "09:00", "9:30": "09:30", " 23:59 ": "23:59", "00:00": "00:00"}
	for in, want := range ok {
		if got, msg := mrCheckSendTime(in); msg != "" || got != want {
			t.Errorf("mrCheckSendTime(%q) = %q, %q; want %q", in, got, msg, want)
		}
	}
	for _, in := range []string{"24:00", "9", "09:60", "9am", "09:00:00", "+9:00", "", "0900", "09:5"} {
		if _, msg := mrCheckSendTime(in); msg == "" {
			t.Errorf("mrCheckSendTime(%q) accepted", in)
		}
	}
}

func TestMRValidateCreate(t *testing.T) {
	s := func(v string) *string { return &v }
	known := map[string]bool{"headline": true, "cards": true}
	secs := []string{"headline", "cards"}
	base := func() mrReportInput {
		return mrReportInput{
			Name: s("  Cards Weekly "), Template: s("custom"), Audience: s("cards"),
			Cadence: s("weekly"), DueRule: s("friday"), Sections: &secs,
		}
	}
	rep, msg := mrValidateCreate(base(), known)
	if msg != "" {
		t.Fatalf("valid body rejected: %s", msg)
	}
	if rep.Name != "Cards Weekly" || rep.SendTime != "09:00" || rep.IsActive || len(rep.Recipients) != 0 {
		t.Errorf("defaults: %+v", rep)
	}

	bad := []struct {
		name string
		edit func(*mrReportInput)
		want string
	}{
		{"short name", func(in *mrReportInput) { in.Name = s(" ab ") }, "The report name must be between 3 and 80 characters."},
		{"missing template", func(in *mrReportInput) { in.Template = nil }, "Unknown template. Choose one of: management, sales, custom, executive_briefing, sales_products, collections_recovery, leads_contact_centre, customers_demographics."},
		{"audience", func(in *mrReportInput) { in.Audience = s("everyone") }, "The audience must be one of: management, sales, collections, cards, risk, operations, other."},
		{"rule for another cadence", func(in *mrReportInput) { in.DueRule = s("first_of_month") }, `A weekly report cannot go out "1st of Each Month". Choose one of: Every Monday, Every Tuesday, Every Wednesday, Every Thursday, Every Friday.`},
		{"send time", func(in *mrReportInput) { in.SendTime = s("25:00") }, "The send time must be a 24-hour time such as 09:00."},
		{"no sections", func(in *mrReportInput) { in.Sections = &[]string{} }, "Choose at least one section for the report."},
		{"bad recipient", func(in *mrReportInput) { in.Recipients = &[]string{"md@o3cards.com", "nope"} }, "not a valid email address: nope"},
	}
	for _, c := range bad {
		in := base()
		c.edit(&in)
		if _, msg := mrValidateCreate(in, known); msg != c.want {
			t.Errorf("%s: got %q, want %q", c.name, msg, c.want)
		}
	}
}

func TestMRValidateDraftIgnoresScheduleAndRecipients(t *testing.T) {
	s := func(v string) *string { return &v }
	secs := []string{"headline"}
	cfg, msg := mrValidateDraft(mrReportInput{
		Name: s("Draft"), Template: s("management"), Cadence: s("daily"), Sections: &secs,
		DueRule: s("nonsense"), Recipients: &[]string{"not an email"},
	}, map[string]bool{"headline": true})
	if msg != "" || cfg.Name != "Draft" || cfg.Cadence != "daily" {
		t.Errorf("got %+v, %q", cfg, msg)
	}
}

func TestMRCopyName(t *testing.T) {
	if got := mrCopyName("Daily Operations"); got != "Copy of Daily Operations" {
		t.Errorf("got %q", got)
	}
	long := "Report name that is exactly long enough to be trimmed when the copy prefix goes on"
	if got := mrCopyName(long); len([]rune(got)) > 80 {
		t.Errorf("copy name is %d characters", len([]rune(got)))
	}
}

// The catalogue the backend validates against is the generator's own file, and every
// section a template names must be in it.
func TestMRCatalogueFile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "scripts", "management-reports", "sections.json"))
	if err != nil {
		t.Skipf("sections.json not found: %v", err)
	}
	cat, err := mrParseCatalogue(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.ids) == 0 {
		t.Fatal("no sections parsed")
	}
	var templates map[string]map[string]any
	if err := json.Unmarshal(cat.Templates, &templates); err != nil {
		t.Fatal(err)
	}
	for name, tpl := range templates {
		if !mrIn(name, mrTemplates) {
			t.Errorf("template %q is not a template the API accepts", name)
		}
		for _, cadence := range mrCadences {
			list, _ := tpl[cadence].([]any)
			ids := make([]string, 0, len(list))
			for _, v := range list {
				ids = append(ids, v.(string))
			}
			if msg := mrCheckSections(ids, cat.ids); msg != "" {
				t.Errorf("template %s/%s: %s", name, cadence, msg)
			}
		}
	}
}
