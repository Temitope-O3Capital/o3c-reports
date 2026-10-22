package handlers

import (
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

// There is one assistant now, and its tone lives in the SYSTEM PROMPT rather than
// on each question.
//
// These tests used to guard a choice between two personas: that neither manner
// quietly told the model to round or skip a lookup, that an unknown id added
// nothing, and that the manner never leaked into the system prompt — because a
// prompt that varied per person would throw away the KV prefix cache, measured at
// 28s of re-prefill against 0.12s when reused.
//
// With one assistant that last constraint inverts. One tone is the same for
// everybody, so the prompt stays byte-identical with the tone INSIDE it, and the
// ~65 tokens it used to cost on every single question are now cached. What still
// has to hold is that the tone cannot change an answer, and that the turn context
// carries nothing but who is asking and when.

// Words that would change WHAT is answered rather than HOW it is said.
var mannerForbidden = []string{
	"round", "estimate", "approximate", "roughly", "guess",
	"skip", "without calling", "do not call", "from memory", "recall",
	"summarise the figure", "adjust",
}

func TestToneCannotTouchTheNumbers(t *testing.T) {
	p := assistantSystemPrompt([]string{"get_collections_summary", "find_staff"})
	i := strings.Index(p, "HOW YOU ANSWER")
	if i < 0 {
		t.Fatal("the tone block is missing, so the assistant has no manner at all")
	}
	tone := strings.ToLower(p[i:])
	// Stop at the tool list, which is not tone.
	if j := strings.Index(tone, "tools available to this user"); j > 0 {
		tone = tone[:j]
	}
	for _, bad := range mannerForbidden {
		if strings.Contains(tone, bad) {
			t.Errorf("the tone block contains %q, which could change the answer and not just its tone", bad)
		}
	}
}

// The careful half of the assistant that was removed was folded in rather than
// deleted. If these go missing the assistant gets quietly worse in a way no test
// would otherwise catch: it would still answer, just without saying what the
// figure excludes.
func TestToneKeepsTheCarefulInstructions(t *testing.T) {
	p := assistantSystemPrompt([]string{"get_collections_summary"})
	for _, want := range []string{
		"does not cover", // say what is excluded
		"looks unusual",  // flag a figure that does not fit
		"could mean two", // ask rather than choose
		"first sentence", // answer up front
	} {
		if !strings.Contains(p, want) {
			t.Errorf("the tone block has lost %q", want)
		}
	}
}

// The prompt is the cached prefix. It must not vary for any reason, and now that
// the tone is inside it, that includes the tone.
func TestSystemPromptIsByteIdenticalAcrossRebuilds(t *testing.T) {
	tools := []string{"get_collections_summary", "find_staff"}
	base := assistantSystemPrompt(tools)
	for i := 0; i < 5; i++ {
		if got := assistantSystemPrompt(tools); got != base {
			t.Fatalf("system prompt changed between rebuilds (run %d); the prefix cache would be discarded every alternate request", i)
		}
	}
}

// Tone used to ride here, costing prefill on every question. It must not come
// back: the turn context is appended to the user's own message, which is never
// cached, so anything added here is paid for again and again.
func TestTurnContextCarriesOnlyWhoAndWhen(t *testing.T) {
	got := assistantTurnContext(&core.Claims{FullName: "Amaka Obi", Role: "admin"})
	if !strings.Contains(got, "Amaka Obi") || !strings.Contains(got, "Today is") {
		t.Fatalf("turn context lost the identity or the date: %q", got)
	}
	// A tone instruction is long; who-and-when is one short line.
	if len(got) > 160 {
		t.Errorf("turn context is %d bytes, which is too long to be just who and when: %q", len(got), got)
	}
	for _, bad := range []string{"Keep it short", "does not cover", "You are Temitope"} {
		if strings.Contains(got, bad) {
			t.Errorf("tone has crept back into the per-question context: found %q", bad)
		}
	}
}
