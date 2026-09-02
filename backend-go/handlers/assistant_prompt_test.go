package handlers

import (
	"sort"
	"strings"
	"testing"

	"github.com/o3c/reports/core"
)

// The map-order bug this guards against is invisible in code review and cost
// ~28s of re-prefill on every request. Keep this test.
func TestPreambleIsStable(t *testing.T) {
	build := func(who, role string) string {
		u := &core.Claims{FullName: who, Role: role}
		_, byName := toolsForUser(u)
		names := make([]string, 0, len(byName))
		for n := range byName {
			names = append(names, n)
		}
		sort.Strings(names)
		return assistantSystemPrompt(names)
	}
	a, b := build("Amaka Obi", "admin"), build("Bello Sadiq", "admin")
	if a != b {
		t.Fatalf("preamble differs between users of the same role")
	}
	// 20 rebuilds must be byte-identical: catches map-order regressions.
	for i := 0; i < 20; i++ {
		if build("Amaka Obi", "admin") != a {
			t.Fatalf("preamble not stable across rebuilds (run %d)", i)
		}
	}
	if strings.Contains(a, "You are speaking with") || strings.Contains(a, "Today is") {
		t.Fatalf("volatile identity/date leaked back into the system prompt")
	}
	ctxA := assistantTurnContext(&core.Claims{FullName: "Amaka Obi", Role: "admin"})
	if !strings.Contains(ctxA, "Amaka Obi") || !strings.Contains(ctxA, "Today is") {
		t.Fatalf("turn context lost the identity/date: %q", ctxA)
	}
	t.Logf("stable preamble %d bytes; turn context %q", len(a), strings.TrimSpace(ctxA))
}
