package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFallbackIsOffUnlessNamed(t *testing.T) {
	t.Setenv("ASSISTANT_MODEL", "gpt-oss:20b")
	t.Setenv("OLLAMA_URL", "http://10.0.0.1:11434")
	t.Setenv("ASSISTANT_FALLBACK_MODEL", "")
	t.Setenv("ASSISTANT_FALLBACK_URL", "")

	// A silent downgrade is its own failure: an answer from the 4B looks exactly
	// like one from the 20B. Opting in is the acknowledgement.
	if got := assistantTargets(); len(got) != 1 {
		t.Fatalf("expected primary only, got %d targets", len(got))
	}

	t.Setenv("ASSISTANT_FALLBACK_MODEL", "qwen3:4b-instruct")
	tg := assistantTargets()
	if len(tg) != 2 {
		t.Fatalf("expected a fallback, got %d targets", len(tg))
	}
	if tg[1].url != "http://127.0.0.1:11434" {
		t.Errorf("fallback should default to this host, got %q", tg[1].url)
	}
	// The whole point of per-target think: qwen3 must not receive the field,
	// and it is the fallback precisely when nothing else is working.
	if tg[1].think != nil {
		t.Errorf("fallback qwen3 must get no think field, got %v", tg[1].think)
	}
	if tg[0].think != "low" {
		t.Errorf("primary gpt-oss must get think=low, got %v", tg[0].think)
	}
}

func TestFallbackIdenticalToPrimaryIsNotAFallback(t *testing.T) {
	t.Setenv("OLLAMA_URL", "http://127.0.0.1:11434")
	t.Setenv("ASSISTANT_MODEL", "qwen3:4b-instruct")
	t.Setenv("ASSISTANT_FALLBACK_URL", "http://127.0.0.1:11434")
	t.Setenv("ASSISTANT_FALLBACK_MODEL", "qwen3:4b-instruct")
	// Retrying the same dead host only doubles the time before the user is told.
	if got := assistantTargets(); len(got) != 1 {
		t.Fatalf("a duplicate target should be dropped, got %d", len(got))
	}
}

// The behaviour that matters: the VM is down and staff still get an answer.
func TestStreamFallsBackWhenThePrimaryIsUnreachable(t *testing.T) {
	var fallbackHits int
	fb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackHits++
		_, _ = w.Write([]byte(`{"message":{"role":"assistant","content":"Collections stand at 41.2m."},"done":true}` + "\n"))
	}))
	defer fb.Close()

	// A port nothing listens on, which is what a dead VM looks like from here.
	t.Setenv("OLLAMA_URL", "http://127.0.0.1:1")
	t.Setenv("ASSISTANT_MODEL", "gpt-oss:20b")
	t.Setenv("ASSISTANT_FALLBACK_URL", fb.URL)
	t.Setenv("ASSISTANT_FALLBACK_MODEL", "qwen3:4b-instruct")

	var got []string
	resp, err := ollamaChatStream(context.Background(),
		[]ollamaMessage{{Role: "user", Content: "where are collections?"}}, nil,
		func(frag string) { got = append(got, frag) })
	if err != nil {
		t.Fatalf("should have fallen back, got error: %v", err)
	}
	if fallbackHits != 1 {
		t.Fatalf("fallback hit %d times", fallbackHits)
	}
	if strings.Join(got, "") != "Collections stand at 41.2m." {
		t.Fatalf("wrong text streamed: %q", strings.Join(got, ""))
	}
	// The answer must be attributed to the model that actually gave it.
	if resp.Model != "qwen3:4b-instruct" {
		t.Errorf("response should name the fallback model, got %q", resp.Model)
	}
}

// And the rule the blocking path does not need. Once a fragment has reached the
// browser the answer is public; restarting elsewhere would show half of one
// model's answer followed by all of another's, and in a tool that reports
// balances those halves can carry different figures.
func TestStreamDoesNotRestartOnAnotherModelMidAnswer(t *testing.T) {
	var fallbackHits int
	fb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackHits++
		_, _ = w.Write([]byte(`{"message":{"role":"assistant","content":"different answer"},"done":true}` + "\n"))
	}))
	defer fb.Close()

	// Emits a fragment, then dies without ever sending done.
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"message":{"role":"assistant","content":"Collections stand at "}}` + "\n"))
		w.(http.Flusher).Flush()
		_, _ = w.Write([]byte(`{"error":"the runner died"}` + "\n"))
	}))
	defer primary.Close()

	t.Setenv("OLLAMA_URL", primary.URL)
	t.Setenv("ASSISTANT_MODEL", "gpt-oss:20b")
	t.Setenv("ASSISTANT_FALLBACK_URL", fb.URL)
	t.Setenv("ASSISTANT_FALLBACK_MODEL", "qwen3:4b-instruct")

	var got []string
	_, err := ollamaChatStream(context.Background(),
		[]ollamaMessage{{Role: "user", Content: "where are collections?"}}, nil,
		func(frag string) { got = append(got, frag) })
	if err == nil {
		t.Fatal("a failure after text was already shown must be reported, not retried")
	}
	if fallbackHits != 0 {
		t.Fatalf("fallback was used after the answer had started: %d hits", fallbackHits)
	}
	if strings.Join(got, "") != "Collections stand at " {
		t.Fatalf("unexpected streamed text: %q", strings.Join(got, ""))
	}
}

func TestSlotsAreBounded(t *testing.T) {
	for _, c := range []struct {
		env  string
		want int
	}{
		{"", 1}, {"1", 1}, {"4", 4}, {"8", 8},
		{"0", 1},   // nonsense, and a zero-capacity channel would deadlock every turn
		{"99", 1},  // more slots than the host has is a queue nobody can see
		{"two", 1}, // unparseable
		{"-3", 1},
	} {
		t.Setenv("ASSISTANT_SLOTS", c.env)
		if got := assistantSlots(); got != c.want {
			t.Errorf("ASSISTANT_SLOTS=%q gave %d, want %d", c.env, got, c.want)
		}
	}
}

// Queue arithmetic stops being position-1 the moment turns can overlap. Telling
// the fourth person in a two-slot queue that three are ahead doubles the wait
// they expect, and someone who distrusts the estimate stops waiting.
func TestQueueDepthAccountsForParallelSlots(t *testing.T) {
	cases := []struct {
		position int64
		slots    int
		ahead    int64
		eta      time.Duration
	}{
		{1, 1, 0, 0},                     // straight in
		{2, 1, 1, assistantTurnEstimate}, // one turn to sit through
		{1, 2, 0, 0},
		{2, 2, 0, 0},                         // both slots free
		{3, 2, 1, assistantTurnEstimate},     // waits for one turn, not two
		{5, 2, 3, 2 * assistantTurnEstimate}, // three ahead over two slots: two rounds
		{7, 3, 4, 2 * assistantTurnEstimate},
		{2, 0, 1, assistantTurnEstimate}, // a bad slot count must not divide by zero
	}
	for _, c := range cases {
		if got := assistantAhead(c.position, c.slots); got != c.ahead {
			t.Errorf("assistantAhead(%d, %d) = %d, want %d", c.position, c.slots, got, c.ahead)
		}
		if got := assistantETA(c.ahead, c.slots); got != c.eta {
			t.Errorf("assistantETA(%d, %d) = %v, want %v", c.ahead, c.slots, got, c.eta)
		}
	}
}
