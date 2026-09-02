package handlers

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/o3c/reports/core"
)

// Exercises the assistant the way staff would actually use it: reporting,
// summarising and drafting. Logs the real answer and the real wall clock.
func TestAssistantCapabilities(t *testing.T) {
	url := os.Getenv("PGURL")
	if url == "" {
		t.Skip("set PGURL")
	}
	db, err := core.Open(&core.Config{PGURL: url, DirectPGURL: url})
	if err != nil {
		t.Fatal(err)
	}
	u := &core.Claims{ID: 1, Role: "admin", FullName: "Temitope"}
	wire, byName := toolsForUser(u)
	names := make([]string, 0, len(byName))
	for n := range byName {
		names = append(names, n)
	}
	sort.Strings(names)

	for _, q := range strings.Split(os.Getenv("QS"), "|") {
		if strings.TrimSpace(q) == "" {
			continue
		}
		msgs := []ollamaMessage{
			{Role: "system", Content: assistantSystemPrompt(names)},
			{Role: "user", Content: assistantTurnContext(u) + q},
		}
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
		t0 := time.Now()
		var used []string
		var answer string
		for round := 0; round < 4; round++ {
			r, err := ollamaChat(ctx, msgs, wire)
			if err != nil {
				t.Fatalf("%v", err)
			}
			if len(r.Message.ToolCalls) == 0 {
				answer = strings.TrimSpace(r.Message.Content)
				break
			}
			msgs = append(msgs, ollamaMessage{Role: "assistant", ToolCalls: r.Message.ToolCalls})
			for _, tc := range r.Message.ToolCalls {
				used = append(used, tc.Function.Name)
				tool, ok := byName[tc.Function.Name]
				if !ok {
					msgs = append(msgs, ollamaMessage{Role: "tool", Content: `{"error":"no such tool"}`})
					continue
				}
				res, terr := tool.Run(ctx, db, u, tc.Function.Arguments)
				if terr != nil {
					msgs = append(msgs, ollamaMessage{Role: "tool", Content: `{"error":"` + terr.Error() + `"}`})
					continue
				}
				b, _ := json.Marshal(res)
				msgs = append(msgs, ollamaMessage{Role: "tool", Content: string(b)})
			}
		}
		cancel()
		t.Logf("\n=== Q: %s\n--- tools: %v   wall: %.1fs\n%s\n", q, used, time.Since(t0).Seconds(), answer)
	}
}
