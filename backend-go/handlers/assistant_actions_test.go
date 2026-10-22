package handlers

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/o3c/workspace/core"
)

// The write path. A bug here puts a false record into a system of record, which
// is a different class of failure from a wrong answer, so these test the refusals
// as hard as the success.

func runActionTool(t *testing.T, db *core.DB, u *core.Claims, name string, args map[string]any) map[string]any {
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
		t.Fatalf("%s is not registered", name)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := tl.Run(ctx, db, u, args)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	m, _ := out.(map[string]any)
	return m
}

// Nobody of that name: nothing may be written, and the model must be told the
// note was NOT saved. Silently writing an unattached note would be worse.
func TestANoteAboutNobodyIsNotWritten(t *testing.T) {
	db := teamTestDB(t)
	u := &core.Claims{ID: 1, Role: "admin", FullName: "Test Admin"}
	out := runActionTool(t, db, u, "add_customer_note", map[string]any{
		"about": "Zephaniah Quillbottom", "note": "Said he would call back.",
	})
	if w, _ := out["written"].(bool); w {
		t.Error("wrote a note for a name nobody has")
	}
	if !strings.Contains(asString(out["note"]), "NOT been saved") {
		t.Errorf("the model is not told the note was not saved: %q", asString(out["note"]))
	}
}

// An ambiguous name must stop, not pick. Putting a note on the wrong customer's
// file is the failure this guards.
func TestAnAmbiguousNameStopsRatherThanGuessing(t *testing.T) {
	db := teamTestDB(t)
	u := &core.Claims{ID: 1, Role: "admin", FullName: "Test Admin"}
	// A single common first name; if the book holds one of these, the test is
	// vacuous and says so rather than asserting something untrue.
	out := runActionTool(t, db, u, "add_customer_note", map[string]any{
		"about": "Ajayi", "note": "Test note that must not be written.",
	})
	if w, _ := out["written"].(bool); w {
		t.Skip("only one person matches 'Ajayi'; nothing to assert about ambiguity")
	}
	if _, ok := out["several_people_match"]; !ok {
		t.Logf("not written, and not ambiguous either: %v", out["note"])
		return
	}
	if !strings.Contains(asString(out["note"]), "NOT been saved") {
		t.Errorf("ambiguity did not say the note was unsaved: %q", asString(out["note"]))
	}
}

// Attribution is the safety story. With no signed-in user there is no actor, and
// an anonymous row in a system of record is not acceptable.
func TestANoteWithoutASignedInUserIsRefused(t *testing.T) {
	db := teamTestDB(t)
	var tl *assistantTool
	for _, c := range assistantTools() {
		if c.Name == "add_customer_note" {
			cp := c
			tl = &cp
		}
	}
	if tl == nil {
		t.Fatal("add_customer_note is not registered")
	}
	_, err := tl.Run(context.Background(), db, nil, map[string]any{
		"about": "anyone", "note": "should never be written",
	})
	if err == nil {
		t.Error("an unauthenticated call was accepted")
	}
}

// Writing, then proving the three properties that make it safe: it is attributed
// to the caller, it is marked as the assistant's, and it does NOT raise anybody's
// customer-contact figure.
func TestAWrittenNoteIsAttributedMarkedAndUncounted(t *testing.T) {
	db := teamTestDB(t)
	if testing.Short() {
		t.Skip("writes to the live activity ledger")
	}
	ctx := context.Background()

	// Someone who definitely exists exactly once in the contact book.
	var who string
	rows, err := db.PGQuery(ctx, `
		SELECT btrim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS full_name
		FROM crm_contacts
		WHERE btrim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) <> ''
		GROUP BY 1 HAVING COUNT(*) = 1
		ORDER BY 1 LIMIT 1`)
	if err != nil || len(rows) == 0 {
		t.Skip("no unambiguous contact to test against")
	}
	who = asString(rows[0]["full_name"])

	u := &core.Claims{ID: 1, Role: "admin", FullName: "Test Admin"}
	body := "Automated test note, safe to delete. " + time.Now().Format(time.RFC3339)
	out := runActionTool(t, db, u, "add_customer_note", map[string]any{
		"about": who, "note": body,
	})
	if w, _ := out["written"].(bool); !w {
		t.Fatalf("nothing written for %q: %v", who, out)
	}
	id := asInt(out["activity_id"])
	if id == 0 {
		t.Fatal("no activity id returned, so nothing can be verified or undone")
	}
	t.Logf("wrote activity %d about %s", id, who)

	back, err := db.PGQuery(ctx, `
		SELECT type, source, actor_user_id, actor_name, body
		FROM activities WHERE id = $1`, id)
	if err != nil || len(back) == 0 {
		t.Fatalf("could not read the row back: %v", err)
	}
	r := back[0]
	if asString(r["type"]) != "note" {
		t.Errorf("type is %q, want note", asString(r["type"]))
	}
	if asString(r["source"]) != "assistant" {
		t.Errorf("source is %q, want assistant — without this it inflates contact figures", asString(r["source"]))
	}
	if asInt(r["actor_user_id"]) != 1 {
		t.Errorf("actor_user_id is %d, want 1; the note is not attributed to the caller", asInt(r["actor_user_id"]))
	}
	if asString(r["body"]) != body {
		t.Error("the stored note is not the text that was passed")
	}

	// THE ONE THAT MATTERS: it must not count as customer contact.
	cnt, err := db.PGQuery(ctx, `
		SELECT COUNT(DISTINCT COALESCE(a.party_id::text, a.contact_id::text, NULLIF(a.phone, '')))
		         FILTER (WHERE a.type IN ('call','visit','note') AND COALESCE(a.source,'') <> 'assistant')
		       AS counted
		FROM activities a WHERE a.id = $1`, id)
	if err != nil {
		t.Fatalf("contact count: %v", err)
	}
	if n := asInt(cnt[0]["counted"]); n != 0 {
		t.Errorf("the note counts as %d customer contact(s); it must count as none", n)
	}

	// Leave the ledger as it was found.
	if _, err := db.PGQuery(ctx, `DELETE FROM activities WHERE id = $1 AND source = 'assistant'`, id); err != nil {
		t.Logf("could not clean up activity %d: %v", id, err)
	}
}
