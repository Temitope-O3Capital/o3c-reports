package handlers

import (
	"encoding/json"
	"testing"

	"github.com/o3c/workspace/core"
)

// What the model reads BEFORE it reads the question.
//
// This is the cached prefix, so its size is paid once per restart rather than per
// question — but it is also what a cold question pays, and on this box prefill
// runs at ~47 tok/s, so 2,500 tokens is 53 seconds for the first person to ask
// after a deploy. Every tool added grows it, which is the real cost of coverage
// and the reason tool descriptions are kept to a few lines.
//
// Logged rather than asserted at a fixed number: the point is to notice growth,
// and a hard limit would just get raised. The one assertion is a ceiling loose
// enough to only fire if something has gone badly wrong.
func TestPreambleSize(t *testing.T) {
	admin := &core.Claims{ID: 1, Role: "admin", FullName: "Test Admin"}
	wire, byName := toolsForUser(admin)

	names := make([]string, 0, len(byName))
	for n := range byName {
		names = append(names, n)
	}
	prompt := assistantSystemPrompt(names)
	schemas, _ := json.Marshal(wire)

	total := len(prompt) + len(schemas)
	t.Logf("tools           %d", len(wire))
	t.Logf("system prompt   %6d B  ~%5d tok", len(prompt), len(prompt)/4)
	t.Logf("tool schemas    %6d B  ~%5d tok", len(schemas), len(schemas)/4)
	t.Logf("PREFIX TOTAL    %6d B  ~%5d tok  = ~%.0fs of cold prefill at 47 tok/s",
		total, total/4, float64(total/4)/47.0)

	if tok := total / 4; tok > 6000 {
		t.Errorf("prefix is ~%d tokens; a cold question would wait over two minutes before a word appears", tok)
	}
}
