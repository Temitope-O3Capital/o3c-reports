package handlers

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/o3c/workspace/core"
)

// End-to-end: real preamble -> model picks a tool -> real tool runs against the
// live DB -> model answers. Verifies the two tools that were dead (SQLSTATE
// 42883) now work through the whole path.
func TestAssistantEndToEnd(t *testing.T) {
	url := os.Getenv("PGURL")
	if url == "" {
		t.Skip("set PGURL")
	}
	db, err := core.Open(&core.Config{PGURL: url, DirectPGURL: url})
	if err != nil {
		t.Fatal(err)
	}
	u := &core.Claims{ID: 1, Role: "admin", FullName: "Test Admin"}
	wire, byName := toolsForUser(u)
	names := make([]string, 0, len(byName))
	for n := range byName {
		names = append(names, n)
	}
	sort.Strings(names)

	for _, q := range []string{
		"What revenue did we earn in the last 30 days?",
		"What was our transaction volume over the last 90 days?",
	} {
		msgs := []ollamaMessage{
			{Role: "system", Content: assistantSystemPrompt(names)},
			{Role: "user", Content: assistantTurnContext(u) + q},
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		t0 := time.Now()
		r1, err := ollamaChat(ctx, msgs, wire)
		if err != nil {
			cancel()
			t.Fatalf("round 1: %v", err)
		}
		if len(r1.Message.ToolCalls) == 0 {
			cancel()
			t.Errorf("Q=%q -> NO TOOL CALL, model answered from nothing: %s", q, r1.Message.Content)
			continue
		}
		tc := r1.Message.ToolCalls[0]
		tool := byName[tc.Function.Name]
		res, terr := tool.Run(ctx, db, u, tc.Function.Arguments)
		if terr != nil {
			cancel()
			t.Errorf("Q=%q -> tool %s FAILED: %v", q, tc.Function.Name, terr)
			continue
		}
		rb, _ := json.Marshal(res)
		msgs = append(msgs,
			ollamaMessage{Role: "assistant", ToolCalls: r1.Message.ToolCalls},
			ollamaMessage{Role: "tool", Content: string(rb)})
		r2, err := ollamaChat(ctx, msgs, wire)
		cancel()
		if err != nil {
			t.Fatalf("round 2: %v", err)
		}
		t.Logf("Q: %s\n  tool: %s(%v)  result %d B\n  answer (%.1fs): %s",
			q, tc.Function.Name, tc.Function.Arguments, len(rb),
			time.Since(t0).Seconds(), strings.TrimSpace(r2.Message.Content))
	}
}
