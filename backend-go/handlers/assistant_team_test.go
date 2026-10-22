package handlers

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/o3c/workspace/core"
)

// These run against the live database, because the thing being tested is a
// claim about OUR data: that manager_user_id describes real teams and that
// activities records real outreach. A fixture would only prove the SQL parses.

func teamTestDB(t *testing.T) *core.DB {
	t.Helper()
	url := os.Getenv("PGURL")
	if url == "" {
		t.Skip("set PGURL")
	}
	db, err := core.Open(&core.Config{PGURL: url, DirectPGURL: url})
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	return db
}

func runTeamTool(t *testing.T, db *core.DB, name string, args map[string]any) map[string]any {
	t.Helper()
	var tl *assistantTool
	for _, c := range assistantTools() {
		if c.Name == name {
			cp := c
			tl = &cp
			break
		}
	}
	if tl == nil {
		t.Fatalf("%s is not registered as a tool", name)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := tl.Run(ctx, db, &core.Claims{ID: 1, Role: "admin", FullName: "Test Admin"}, args)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	m, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("%s returned %T, wanted a map", name, out)
	}
	return m
}

// The question that started this: "team Jennifer" must resolve to the Jennifer
// who heads a team, and bring her officers with her.
func TestTeamResolvesToTheColleagueWhoHeadsIt(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "get_team", map[string]any{"team": "Jennifer"})

	head, _ := out["head"].(map[string]any)
	if head == nil {
		t.Fatalf("no head resolved: %v", out)
	}
	if got := strings.ToLower(asString(head["full_name"])); !strings.Contains(got, "jennifer") {
		t.Errorf("head is %q, wanted a Jennifer", got)
	}
	members, _ := out["members"].([]map[string]any)
	if len(members) == 0 {
		t.Fatalf("Jennifer heads nobody, but manager_user_id says otherwise: %v", out)
	}
	t.Logf("%s (%s) heads %d", asString(head["full_name"]), asString(head["role"]), len(members))
	for _, m := range members {
		t.Logf("   %s  %s", asString(m["full_name"]), asString(m["role"]))
	}
}

// A colleague with nobody under them does not head a team, and the tool must say
// so rather than returning an empty list that reads like missing data.
func TestAColleagueWhoHeadsNobodySaysSo(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "get_team", map[string]any{"team": "Kehinde"})
	members, _ := out["members"].([]map[string]any)
	if len(members) != 0 {
		t.Skipf("Kehinde now heads %d people; nothing to assert", len(members))
	}
	note := asString(out["note"])
	if !strings.Contains(strings.ToLower(note), "do not head a team") {
		t.Errorf("note does not explain the empty team: %q", note)
	}
}

// The outreach figure is the whole point. It must cover the head AND the reports,
// and the total must never be the sum of the rows.
func TestOutreachCoversTheWholeTeamAndCountsEachCustomerOnce(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "get_outreach_activity",
		map[string]any{"team": "Jennifer", "days": 7})

	members, _ := out["team_members"].([]map[string]any)
	if len(members) == 0 {
		t.Fatal("team_members is empty, so the scope was never expanded to the team")
	}
	total, _ := out["team_total"].(map[string]any)
	if total == nil {
		t.Fatal("no team_total, so the model would have to add the rows up itself")
	}

	rows, _ := out["by_colleague"].([]map[string]any)
	var sum int64
	for _, r := range rows {
		sum += asInt(r["customers_contacted"])
		t.Logf("   %-22s calls=%d customers=%d",
			asString(r["colleague"]), asInt(r["calls"]), asInt(r["customers_contacted"]))
	}
	got := asInt(total["customers_contacted"])
	t.Logf("team total: %d customers, %d calls, last activity %s",
		got, asInt(total["calls"]), asString(total["last_activity"]))

	// Distinct-counted across the team, so it can equal the sum but never exceed it.
	if got > sum {
		t.Errorf("team total %d exceeds the sum of the rows %d, which is impossible for a distinct count", got, sum)
	}
}

// A stage change written by the lead router is not a colleague reaching out, and
// actor_user_id 0 is a sentinel rather than a person. Neither may appear.
func TestOutreachReportsOnlyRealColleagues(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "get_outreach_activity", map[string]any{"days": 30})
	rows, _ := out["by_colleague"].([]map[string]any)
	if len(rows) == 0 {
		t.Skip("no activity logged in 30 days")
	}
	for _, r := range rows {
		name := asString(r["colleague"])
		switch strings.ToLower(name) {
		case "system rule", "lead router", "unattributed", "":
			t.Errorf("%q is not a colleague and must not be reported as one", name)
		}
	}
}

// The honesty requirement. These counts are a floor -- sales logged 21 calls in
// October against the call centre's 10,329 in September -- so the tool must tell
// the model to say "logged", not state the figure as everything that happened.
func TestOutreachTellsTheModelTheFigureIsOnlyWhatWasLogged(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "get_outreach_activity", map[string]any{"days": 7})
	note := strings.ToLower(asString(out["note"]))
	for _, want := range []string{"recorded", "floor", "logged"} {
		if !strings.Contains(note, want) {
			t.Errorf("note is missing %q, so nothing stops the answer being overstated: %q", want, note)
		}
	}
}

// A name nobody has must not come back as an empty report that reads like a
// quiet week.
func TestAnUnknownTeamIsNotReportedAsSilence(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "get_outreach_activity",
		map[string]any{"team": "Zephaniah Quillbottom"})
	if found, ok := out["found"].(bool); !ok || found {
		t.Errorf("an unknown name should report found=false, got %v", out["found"])
	}
	if _, ok := out["by_colleague"]; ok {
		t.Error("an unknown name returned activity rows, which would read as a real report")
	}
}


// Two colleagues answer to "Kehinde": Kehinde Naibi heads operations, Kehinde
// Ajayi is one of Jennifer's sales officers. Reporting one of them as "Kehinde"
// with no further word would put the wrong person's work under their name.
func TestTwoColleaguesWithTheSameNameAreBothNamed(t *testing.T) {
	db := teamTestDB(t)
	out := runTeamTool(t, db, "get_outreach_activity",
		map[string]any{"person": "Kehinde", "days": 30})

	scope := asString(out["scope"])
	if !strings.Contains(scope, "(") {
		t.Errorf("scope %q does not say which Kehinde, by role", scope)
	}
	others, _ := out["other_people_with_that_name"].([]string)
	if len(others) == 0 {
		t.Fatalf("the second Kehinde was dropped silently; scope was %q", scope)
	}
	note := asString(out["note"])
	if !strings.Contains(note, "More than one colleague") {
		t.Errorf("note does not warn about the ambiguity: %q", note)
	}
	t.Logf("reported on %s; could also have been %v", scope, others)
}
func asString(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := json.Marshal(v)
	return strings.Trim(string(b), `"`)
}

func asInt(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case int:
		return int64(t)
	case float64:
		return int64(t)
	case json.Number:
		n, _ := t.Int64()
		return n
	}
	return 0
}
