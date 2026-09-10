package handlers

import (
	"context"
	"log/slog"
	"sort"
	"time"

	"github.com/o3c/workspace/core"
)

// assistantWarmDelay holds the first warm-up back until the boot storm has
// passed. Startup already runs the CBS sync, the Zoho pulls and the FX scrape,
// and a warm-up is ~21s of prefill across 7 of 8 vCPUs — enough that the first
// deploy of this worker starved Postgres and tripped a health-check DB ping
// timeout. Nobody is asking the assistant questions in the first minute after a
// restart, so there is nothing to gain by racing them.
const assistantWarmDelay = 90 * time.Second

// assistantWarmInterval re-primes well inside the 4h OLLAMA_KEEP_ALIVE so the
// model is never evicted for idleness. Cheap: a warm cycle that hits the cache
// costs about a tenth of a second.
const assistantWarmInterval = 30 * time.Minute

// StartAssistantWarmer removes the cold-start penalty from the first person to
// use the assistant after a restart.
//
// Two separate costs are being avoided, and keep_alive addresses neither:
//
//   - loading qwen3:4b-instruct off disk, measured at 17.0s
//   - prefilling the ~1,850-token preamble, measured at 28s
//
// keep_alive only holds a model that has ALREADY been loaded once; it never
// loads one. So after every reboot /api/ps was empty and whoever asked the first
// question paid both costs on top of their answer. That is the single worst
// experience the assistant offers, and it lands disproportionately on whoever
// starts earliest.
//
// The warm-up deliberately sends the REAL preamble — the same system prompt and
// the full tool schema set a live turn sends — so the KV cache ends up holding
// the exact prefix those turns reuse. Warming with a toy prompt would load the
// model but leave the 28s prefill in place, which is most of the problem.
func StartAssistantWarmer() {
	go func() {
		time.Sleep(assistantWarmDelay)

		// Ollama is started by its own scheduled task and may still be binding
		// its port when the API comes up; the retry loop covers that race.
		for attempt := 0; attempt < 10; attempt++ {
			if assistantWarmOnce() {
				break
			}
			time.Sleep(30 * time.Second)
		}
		for {
			time.Sleep(assistantWarmInterval)
			assistantWarmOnce()
		}
	}()
}

// assistantWarmOnce primes the model and prefix cache. It reports whether the
// model answered, so startup can retry while Ollama is still coming up.
func assistantWarmOnce() bool {
	// Never contend with a real user. Ollama runs one slot, so a warm-up racing
	// a live turn would evict that user's cached prefix and make their question
	// slower — the exact opposite of the point. If the slot is taken someone is
	// already using it, which means the model is warm anyway.
	select {
	case assistantSlot <- struct{}{}:
		defer func() { <-assistantSlot }()
	default:
		return true
	}

	// The most privileged tool set, so the cached prefix is the longest one any
	// turn can reuse. Roles with fewer tools get a shorter, different preamble
	// and will still prefill once — but they never pay the model load.
	admin := &core.Claims{Role: "admin"}
	wireTools, byName := toolsForUser(admin)
	names := make([]string, 0, len(byName))
	for n := range byName {
		names = append(names, n)
	}
	sort.Strings(names)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	started := time.Now()
	_, err := ollamaChatWarm(ctx, []ollamaMessage{
		{Role: "system", Content: assistantSystemPrompt(names)},
		{Role: "user", Content: "ready"},
	}, wireTools)
	if err != nil {
		slog.Warn("assistant warm-up failed", "err", err, "after", time.Since(started).Round(time.Millisecond))
		return false
	}
	slog.Info("assistant warm", "took", time.Since(started).Round(time.Millisecond))
	return true
}
