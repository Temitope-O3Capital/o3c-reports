package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The reasoning effort is a correctness setting, not a preference. At the
// default effort gpt-oss sat silent for 17.7 seconds before its first visible
// word; at "low" it answered in 3.9 with the same arithmetic. A companion that
// is meant to speak cannot afford the former, so this is pinned by a test.
func TestAssistantThinkIsLowOnlyForReasoningModels(t *testing.T) {
	t.Setenv("ASSISTANT_THINK", "")

	t.Setenv("ASSISTANT_MODEL", "gpt-oss:20b")
	if got := assistantThink(); got != "low" {
		t.Fatalf("gpt-oss must reason at low effort, got %v", got)
	}

	// The fallback model does not understand the field. Sending it anything at
	// all risks a rejected request on the model we fall back TO when the VM is
	// unreachable, which is exactly when we cannot afford a second failure.
	t.Setenv("ASSISTANT_MODEL", "qwen3:4b-instruct")
	if got := assistantThink(); got != nil {
		t.Fatalf("non-reasoning model must send no think field, got %v", got)
	}
}

func TestAssistantThinkEnvOverride(t *testing.T) {
	t.Setenv("ASSISTANT_MODEL", "gpt-oss:20b")

	t.Setenv("ASSISTANT_THINK", "high")
	if got := assistantThink(); got != "high" {
		t.Fatalf("env should set the effort, got %v", got)
	}

	// An escape hatch that actually removes the field, for a model that errors
	// on it. "off" has to mean absent, not the string "off".
	t.Setenv("ASSISTANT_THINK", "off")
	if got := assistantThink(); got != nil {
		t.Fatalf(`ASSISTANT_THINK=off must omit the field, got %v`, got)
	}
}

// The request must actually carry what assistantThink decided. A field added to
// the struct but never populated is the kind of change that looks done, reviews
// clean, and silently leaves 14 seconds of silence in production.
func TestStreamRequestCarriesThink(t *testing.T) {
	var seen ollamaChatRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &seen)
		_, _ = w.Write([]byte(`{"message":{"role":"assistant","content":"ok"},"done":true}` + "\n"))
	}))
	defer srv.Close()

	t.Setenv("OLLAMA_URL", srv.URL)
	t.Setenv("ASSISTANT_MODEL", "gpt-oss:20b")
	t.Setenv("ASSISTANT_THINK", "")

	if _, err := ollamaChatStream(context.Background(),
		[]ollamaMessage{{Role: "user", Content: "hello"}}, nil, nil); err != nil {
		t.Fatalf("stream: %v", err)
	}
	if seen.Think != "low" {
		t.Fatalf("request did not carry think=low, got %#v", seen.Think)
	}
}

// Reasoning must never reach a person. It is not merely untidy: these tokens
// are the model arguing with itself about figures ("so they are 8.8 million
// short, or is it..."), and a half-formed number read aloud by a companion in a
// tool that reports balances is worse than no answer at all.
func TestThinkingNeverReachesTheUser(t *testing.T) {
	const thinking = "The target is 50 and they have 41.2, so maybe 9 million short, no, 8.8"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, line := range []string{
			`{"message":{"role":"assistant","thinking":"` + thinking + `"}}`,
			`{"message":{"role":"assistant","content":"They are "}}`,
			`{"message":{"role":"assistant","thinking":"double-checking: 8.8"}}`,
			`{"message":{"role":"assistant","content":"8.8 million short."},"done":true}`,
		} {
			_, _ = w.Write([]byte(line + "\n"))
			w.(http.Flusher).Flush()
		}
	}))
	defer srv.Close()

	t.Setenv("OLLAMA_URL", srv.URL)
	t.Setenv("ASSISTANT_MODEL", "gpt-oss:20b")

	var spoken []string
	resp, err := ollamaChatStream(context.Background(),
		[]ollamaMessage{{Role: "user", Content: "where do they stand?"}}, nil,
		func(frag string) { spoken = append(spoken, frag) })
	if err != nil {
		t.Fatalf("stream: %v", err)
	}

	// What was streamed to the browser, which is also what gets spoken.
	joined := strings.Join(spoken, "")
	if joined != "They are 8.8 million short." {
		t.Fatalf("streamed text wrong: %q", joined)
	}
	for _, frag := range spoken {
		if strings.Contains(frag, "maybe") || strings.Contains(frag, "double-checking") {
			t.Fatalf("reasoning was streamed to the user: %q", frag)
		}
	}

	// And what is persisted as the assistant's turn.
	if resp.Message.Content != "They are 8.8 million short." {
		t.Fatalf("stored content wrong: %q", resp.Message.Content)
	}
	if strings.Contains(resp.Message.Content, "no, 8.8") {
		t.Fatal("reasoning leaked into the stored answer")
	}
	if resp.Message.Thinking != "" {
		t.Fatalf("reasoning was carried on the outgoing message, which would be "+
			"replayed to the model as history: %q", resp.Message.Thinking)
	}
}
