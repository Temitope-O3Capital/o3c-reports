package handlers

// Keeping the assistant answering when the model host is not.
//
// The assistant used to run on this box, so "Ollama is down" and "the API is
// down" were the same event and there was nothing to fall back to. Moving the
// model to apssvr-cred bought a 20B model and a 5x speed-up, and introduced a
// new way to fail: the API is perfectly healthy and the answer is on another
// machine. A staff member asking about a balance then sees "assistant model
// unreachable", which reads as the whole workspace being broken.
//
// So there are two targets. The 20B on the VM answers normally; the 4B still
// installed here answers when the VM does not. It is a worse model -- that is
// the entire reason it was replaced -- but a worse answer that cites a tool
// beats no answer, and the tools are the same either way, so figures still come
// from the database rather than from either model's imagination.

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
)

// assistantTarget is one model on one host, with the reasoning effort that
// model understands. think travels WITH the target because it is a property of
// the model, not of the request: gpt-oss needs "low" and qwen3 must not be sent
// the field at all.
type assistantTarget struct {
	url   string
	model string
	think any
	label string // "primary" | "fallback", for logs only
}

// assistantTargets lists where a turn may be sent, in order of preference.
//
// The fallback is OFF unless ASSISTANT_FALLBACK_MODEL names a model, because a
// silent downgrade is its own kind of failure: if the VM is down, somebody
// should find out, and an answer that quietly came from the 4B looks exactly
// like one that came from the 20B. Naming the model is the acknowledgement that
// a worse answer is preferable to none.
func assistantTargets() []assistantTarget {
	primary := assistantTarget{
		url:   assistantBaseURL(),
		model: assistantModel(),
		think: assistantThinkFor(assistantModel()),
		label: "primary",
	}
	out := []assistantTarget{primary}

	model := strings.TrimSpace(os.Getenv("ASSISTANT_FALLBACK_MODEL"))
	if model == "" {
		return out
	}
	url := strings.TrimRight(strings.TrimSpace(os.Getenv("ASSISTANT_FALLBACK_URL")), "/")
	if url == "" {
		url = "http://127.0.0.1:11434"
	}
	// A fallback identical to the primary is not a fallback. Retrying the same
	// dead host twice only doubles the time before the user is told.
	if url == primary.url && model == primary.model {
		return out
	}
	out = append(out, assistantTarget{
		url:   url,
		model: model,
		think: assistantThinkFor(model),
		label: "fallback",
	})
	return out
}

// assistantSlots is how many turns may be in flight at once, and it MUST match
// OLLAMA_NUM_PARALLEL on the model host.
//
// Queueing here rather than inside Ollama is what lets a waiting person be told
// "2 ahead of you" instead of watching a dead-looking spinner. But if this is
// larger than the host's parallelism the queue moves into Ollama where nothing
// can see it, and if it is smaller the host sits idle while people wait. One is
// the safe default because it is what a single-slot host does.
//
// Raising it trades latency for throughput, and the trade is good on this
// hardware: generation is memory-bandwidth-bound rather than core-bound, so two
// turns on six threads each run close to the speed of one turn on twelve. That
// is a claim to MEASURE on the box before raising it in production, not to take
// on faith from this comment.
func assistantSlots() int {
	if v := strings.TrimSpace(os.Getenv("ASSISTANT_SLOTS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 8 {
			return n
		}
	}
	return 1
}

// The slot channel is built on first use, NOT in a package initialiser.
// core.Config calls godotenv.Load() from main, so at package-init time the
// environment does not yet carry anything from .env and ASSISTANT_SLOTS would
// read as unset however it was configured.
var (
	assistantSlotOnce sync.Once
	assistantSlotCh   chan struct{}
)

func assistantSlot() chan struct{} {
	assistantSlotOnce.Do(func() {
		assistantSlotCh = make(chan struct{}, assistantSlots())
	})
	return assistantSlotCh
}

// ollamaChatOpts sends a turn to the first target that answers.
//
// Any failure from the primary is worth a second attempt elsewhere, including a
// non-200: the useful distinction is not WHY the VM refused but whether another
// host can answer. A cancelled or timed-out context is the exception — the
// person has already stopped waiting, and a second attempt only delays telling
// them so.
func ollamaChatOpts(ctx context.Context, msgs []ollamaMessage, tools []any, extra map[string]any) (*ollamaChatResponse, error) {
	targets := assistantTargets()
	var firstErr error
	for i, tgt := range targets {
		resp, err := ollamaChatTo(ctx, tgt, msgs, tools, extra)
		if err == nil {
			if i > 0 {
				slog.Warn("assistant answered from the fallback model",
					"model", tgt.model, "url", tgt.url, "primary_err", firstErr)
			}
			return resp, nil
		}
		if firstErr == nil {
			firstErr = err
		}
		if ctx.Err() != nil {
			return nil, firstErr
		}
	}
	return nil, firstErr
}

// ollamaChatStream is the streaming form, with one rule the blocking form does
// not need: a target is only abandoned BEFORE it has emitted anything.
//
// Once a fragment has reached the browser the answer is public. Restarting on
// another model would show the first half of one answer followed by the whole
// of a different one, and in a tool that reports balances those two halves can
// carry different figures. A failure mid-stream is therefore reported as a
// failure, not silently retried.
func ollamaChatStream(
	ctx context.Context,
	msgs []ollamaMessage,
	tools []any,
	onToken func(string),
) (*ollamaChatResponse, error) {
	targets := assistantTargets()
	var firstErr error
	for i, tgt := range targets {
		spoke := false
		resp, err := ollamaChatStreamTo(ctx, tgt, msgs, tools, func(frag string) {
			spoke = true
			if onToken != nil {
				onToken(frag)
			}
		})
		if err == nil {
			if i > 0 {
				slog.Warn("assistant streamed from the fallback model",
					"model", tgt.model, "url", tgt.url, "primary_err", firstErr)
			}
			return resp, nil
		}
		if firstErr == nil {
			firstErr = err
		}
		if spoke || ctx.Err() != nil {
			return nil, firstErr
		}
	}
	return nil, firstErr
}
