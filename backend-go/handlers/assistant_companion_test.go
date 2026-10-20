package handlers

import (
	"strings"
	"testing"
)

// The persona is a tone instruction and nothing else. These tests exist because
// the failure mode is silent: a manner line that quietly tells the model to round,
// summarise or skip a lookup would make the answer depend on which face the person
// picked, and nobody would notice until two colleagues brought different numbers to
// the same meeting.
func TestCompanionMannerCannotTouchTheNumbers(t *testing.T) {
	// Words that would change WHAT is answered rather than HOW it is said.
	forbidden := []string{
		"round", "estimate", "approximate", "roughly", "guess",
		"skip", "without calling", "do not call", "from memory", "recall",
		"summarise the figure", "adjust",
	}
	for _, id := range []string{"esther", "temitope"} {
		m := strings.ToLower(assistantCompanionManner(id))
		if m == "" {
			t.Fatalf("%s has no manner, so the persona does nothing at all", id)
		}
		for _, bad := range forbidden {
			if strings.Contains(m, bad) {
				t.Errorf("%s manner contains %q, which could change the answer and not just its tone", id, bad)
			}
		}
	}
}

func TestUnknownCompanionIsSilentRatherThanDefaulted(t *testing.T) {
	// An unrecognised id must add nothing. Falling back to a default would give
	// someone a personality they never chose, and worse, would mean a typo in the
	// request silently changed how answers read.
	for _, id := range []string{"", "ada", "femi", "Esther", "nonsense", "'; drop table"} {
		if got := assistantCompanionManner(id); got != "" {
			t.Errorf("assistantCompanionManner(%q) = %q, want empty", id, got)
		}
	}
}

func TestTheTwoPersonasAreActuallyDifferent(t *testing.T) {
	esther := assistantCompanionManner("esther")
	temitope := assistantCompanionManner("temitope")
	if esther == temitope {
		t.Fatal("both personas carry the same instruction, so the choice is decorative")
	}
}

// The whole reason the manner lives in the turn context: the system prompt must
// stay byte-identical across users or the KV prefix cache is discarded, which
// measured at 28s of re-prefill against 0.12s when reused.
func TestSystemPromptDoesNotVaryWithTheCompanion(t *testing.T) {
	tools := []string{"get_collections_summary", "find_staff"}
	base := assistantSystemPrompt(tools)
	for _, id := range []string{"esther", "temitope", "", "whatever"} {
		if got := assistantSystemPrompt(tools); got != base {
			t.Fatalf("system prompt changed for companion %q; the prefix cache would be thrown away every alternate request", id)
		}
	}
	for _, id := range []string{"esther", "temitope"} {
		if strings.Contains(base, assistantCompanionManner(id)) {
			t.Errorf("the %s manner has leaked into the system prompt", id)
		}
	}
}
