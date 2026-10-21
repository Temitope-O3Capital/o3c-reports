package handlers

import (
	"os"
	"strings"
	"testing"

	"github.com/o3c/workspace/core"
)

// A way to ask the live assistant one question through the REAL path -- the
// production system prompt, the full tool set, the configured model -- and see
// the answer and which tools it reached for.
//
// This exists because "what can it answer?" is a question about behaviour, and
// behaviour is cheaper to observe than to reason about from the prompt. It also
// warms the same prefix a real turn uses rather than evicting it, which an
// ad-hoc curl against the VM does not.
//
//	PGURL=... ASK="who was the first accountant?" go test -run TestAsk -v
func TestAsk(t *testing.T) {
	url := os.Getenv("PGURL")
	qs := strings.Split(os.Getenv("ASK"), "|")
	if url == "" || qs[0] == "" {
		t.Skip("set PGURL and ASK")
	}
	db, err := core.Open(&core.Config{PGURL: url, DirectPGURL: url})
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range qs {
		q = strings.TrimSpace(q)
		if q == "" {
			continue
		}
		ans, tools, secs := runTurn(t, db, assistantModel(), q)
		t.Logf("\nQ: %s\n   tools: %v   %.1fs\nA: %s", q, tools, secs,
			strings.ReplaceAll(ans, "\n", "\n   "))
	}
}
