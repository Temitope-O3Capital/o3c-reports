package handlers

// assistant_stream.go — server-sent-events transport for the assistant.
//
// The non-streaming /chat endpoint stays exactly as it was; this adds a second
// route that emits the same turn incrementally. Nothing here makes the model
// faster. A warm turn is ~23s on this CPU-only box and that is the floor: 73% of
// it is token generation, which is memory-bandwidth-bound, and every alternative
// model measured either quoted a money figure wrongly or failed to call tools.
//
// What it fixes is the part staff actually experience. Before, a question meant
// a blank box for 23 seconds with no sign the thing was alive, and a second
// person asking at the same time got a silent failure at 45s. Now the first
// words appear in a couple of seconds, the tool lookup is named while it runs,
// and anyone queued is told their position instead of being left guessing.
//
// Event stream:
//
//	event: queued   {"ahead":1,"eta_seconds":25}
//	event: tool     {"name":"get_collections_summary"}
//	event: token    {"t":"984 "}
//	event: done     {"conversation_id":12,...}
//	event: error    {"detail":"..."}
//
// Auth is the ordinary cookie/JWT middleware: this is a POST read with fetch(),
// not an EventSource, so it needs none of the single-use ticket machinery the
// notifications SSE uses to work around EventSource's inability to send headers.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/o3c/workspace/core"
)

// assistantWaiting counts requests either holding or waiting for the inference
// slot, so a queued caller can be told how many are ahead. Inference is
// serialised deliberately: the CPU is already saturated by one turn, so a second
// concurrent slot would not add throughput, it would just make both people wait
// longer. Honest queue reporting is the fix actually available to us.
var assistantWaiting int64

// assistantTurnEstimate is the per-turn figure used for queue ETAs, taken from
// the measured warm-turn range of 23-26s. Deliberately a plain constant: a
// rolling average would be poisoned by the first cold turn of the day and then
// quote nonsense to everyone behind it.
const assistantTurnEstimate = 25 * time.Second

// assistantStreamQueueWait is longer than the 45s the blocking endpoint allows,
// because someone who can see "2 ahead of you, about 50 seconds" will wait,
// where someone staring at a frozen box will not.
const assistantStreamQueueWait = 4 * time.Minute

// ── streaming Ollama client ─────────────────────────────────────────────────

type ollamaStreamChunk struct {
	Message         ollamaMessage `json:"message"`
	Done            bool          `json:"done"`
	PromptEvalCount int           `json:"prompt_eval_count"`
	EvalCount       int           `json:"eval_count"`
	Error           string        `json:"error,omitempty"`
}

// ollamaChatStream runs one model round with stream:true, invoking onToken for
// each text fragment as it arrives, and returns the same aggregated shape the
// blocking client returns so the caller's tool loop is unchanged.
//
// A tool-calling round emits no text — the model returns tool_calls with empty
// content — so forwarding every fragment straight through is safe and never
// leaks a half-formed tool call into the user's answer.
func ollamaChatStream(
	ctx context.Context,
	msgs []ollamaMessage,
	tools []any,
	onToken func(string),
) (*ollamaChatResponse, error) {
	body := ollamaChatRequest{
		Model:     assistantModel(),
		Messages:  msgs,
		Tools:     tools,
		Stream:    true,
		KeepAlive: assistantKeepAlive(),
		Options: map[string]any{
			"num_thread":  assistantThreads(),
			"temperature": 0.2,
			"num_ctx":     assistantNumCtx,
		},
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, assistantBaseURL()+"/api/chat", bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := assistantHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("assistant model unreachable: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("assistant model returned %d", resp.StatusCode)
	}

	// A chunk carrying tool_calls can exceed bufio's default 64 KB line budget,
	// so read with an explicit large buffer rather than a Scanner.
	rd := bufio.NewReaderSize(resp.Body, 1<<20)
	out := &ollamaChatResponse{}
	var text strings.Builder

	for {
		line, readErr := rd.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			var c ollamaStreamChunk
			if err := json.Unmarshal(trimmed, &c); err != nil {
				slog.Warn("assistant: unreadable stream chunk", "err", err)
			} else {
				if c.Error != "" {
					return nil, fmt.Errorf("assistant model error: %s", c.Error)
				}
				if c.Message.Content != "" {
					text.WriteString(c.Message.Content)
					if onToken != nil {
						onToken(c.Message.Content)
					}
				}
				if len(c.Message.ToolCalls) > 0 {
					out.Message.ToolCalls = append(out.Message.ToolCalls, c.Message.ToolCalls...)
				}
				if c.Done {
					out.PromptEvalCount = c.PromptEvalCount
					out.EvalCount = c.EvalCount
				}
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				return nil, fmt.Errorf("assistant stream ended early: %w", readErr)
			}
			break
		}
	}

	out.Model = assistantModel()
	out.Message.Role = "assistant"
	out.Message.Content = text.String()
	return out, nil
}

// ── SSE handler ─────────────────────────────────────────────────────────────

func assistantChatStream(db *core.DB) http.HandlerFunc {
	type chatReq struct {
		ConversationID int64  `json:"conversation_id"`
		Message        string `json:"message"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		var req chatReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		question := strings.TrimSpace(req.Message)
		if question == "" {
			respondErr(w, 422, "Message cannot be empty")
			return
		}
		if len(question) > 4000 {
			respondErr(w, 422, "Message is too long — please shorten it")
			return
		}
		ctx := r.Context()

		// Resolve the conversation BEFORE any SSE byte is written, so a failure
		// here can still be a normal JSON error the client understands.
		convID := req.ConversationID
		if convID > 0 {
			owned, err := db.PGQuery(ctx,
				"SELECT id FROM assistant_conversations WHERE id = $1 AND user_id = $2", convID, user.ID)
			if err != nil {
				respondErrLog(w, 500, "Could not load conversation", err)
				return
			}
			if len(owned) == 0 {
				respondErr(w, 404, "Conversation not found")
				return
			}
		} else {
			rows, err := db.PGQuery(ctx,
				"INSERT INTO assistant_conversations (user_id, title) VALUES ($1, $2) RETURNING id",
				user.ID, assistantTitle(question))
			if err != nil || len(rows) == 0 {
				respondErrLog(w, 500, "Could not start a conversation", err)
				return
			}
			convID = toInt64(rows[0]["id"])
		}

		// ── switch to SSE ────────────────────────────────────────────────────
		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")
		h.Set("X-Accel-Buffering", "no") // nginx must not buffer this response
		w.WriteHeader(http.StatusOK)

		rc := http.NewResponseController(w)
		// Generous: covers a cold model load (measured up to 80s), plus a full
		// queue wait, plus the turn itself.
		if err := rc.SetWriteDeadline(time.Now().Add(15 * time.Minute)); err != nil {
			slog.Warn("assistant: could not extend write deadline", "err", err)
		}

		send := func(event string, payload any) {
			b, err := json.Marshal(payload)
			if err != nil {
				return
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
			if err := rc.Flush(); err != nil {
				slog.Debug("assistant: flush failed, client likely gone", "err", err)
			}
		}

		logAssistantMessage(ctx, db, convID, user, assistantLogEntry{Role: "user", Content: question})

		// ── queue for the single inference slot ──────────────────────────────
		position := atomic.AddInt64(&assistantWaiting, 1)
		defer atomic.AddInt64(&assistantWaiting, -1)
		announce := func(ahead int64) {
			send("queued", map[string]any{
				"ahead":       ahead,
				"eta_seconds": int((time.Duration(ahead) * assistantTurnEstimate).Seconds()),
			})
		}
		if ahead := position - 1; ahead > 0 {
			announce(ahead)
		}

		acquired := false
		deadline := time.After(assistantStreamQueueWait)
		tick := time.NewTicker(5 * time.Second)
		defer tick.Stop()
		for !acquired {
			select {
			case assistantSlot <- struct{}{}:
				acquired = true
				defer func() { <-assistantSlot }()
			case <-tick.C:
				if ahead := atomic.LoadInt64(&assistantWaiting) - 1; ahead > 0 {
					announce(ahead)
				}
			case <-deadline:
				send("error", map[string]any{"detail": "The assistant is still busy. Please try again in a moment."})
				return
			case <-ctx.Done():
				return
			}
		}

		// ── run the turn ─────────────────────────────────────────────────────
		wireTools, byName := toolsForUser(user)
		names := make([]string, 0, len(byName))
		for n := range byName {
			names = append(names, n)
		}

		// Map iteration order is randomised by Go, and this list is printed into the
		// system prompt. Unsorted it made the preamble differ on every single request,
		// so the KV prefix cache never hit and every turn paid ~28s of re-prefill.
		sort.Strings(names)

		msgs := []ollamaMessage{{Role: "system", Content: assistantSystemPrompt(names)}}
		msgs = append(msgs, assistantHistory(ctx, db, convID)...)
		msgs = append(msgs, ollamaMessage{Role: "user", Content: assistantTurnContext(user) + question})

		started := time.Now()
		used := make([]string, 0, 2)
		var answer string
		var promptTok, outputTok int

		for round := 0; round < assistantMaxToolRounds; round++ {
			resp, err := ollamaChatStream(ctx, msgs, wireTools, func(frag string) {
				send("token", map[string]any{"t": frag})
			})
			if err != nil {
				slog.Error("assistant: model call failed", "conversation", convID, "err", err)
				logAssistantMessage(ctx, db, convID, user, assistantLogEntry{
					Role: "assistant", Err: err.Error(), Model: assistantModel(),
					LatencyMS: int(time.Since(started).Milliseconds())})
				send("error", map[string]any{"detail": "The assistant is unavailable right now. Please try again shortly."})
				return
			}
			promptTok += resp.PromptEvalCount
			outputTok += resp.EvalCount

			if len(resp.Message.ToolCalls) == 0 {
				answer = strings.TrimSpace(resp.Message.Content)
				break
			}

			// Echo the assistant's tool-call turn back before the results, or the
			// model loses track of what it asked for.
			msgs = append(msgs, resp.Message)

			for _, tc := range resp.Message.ToolCalls {
				name := tc.Function.Name
				tool, ok := byName[name]
				send("tool", map[string]any{"name": name})

				var payload any
				switch {
				case !ok, !userCanUseTool(user, tool):
					// Hallucinated name, or one this user may not use. Identical
					// reply either way: never reveal that a tool exists but is
					// barred, which would leak the shape of other teams' data.
					payload = map[string]any{"error": "That information is not available to you."}
				default:
					result, runErr := tool.Run(ctx, db, user, tc.Function.Arguments)
					if runErr != nil {
						slog.Error("assistant: tool failed", "tool", name, "err", runErr)
						payload = map[string]any{"error": "That lookup failed."}
					} else {
						payload = result
						used = append(used, name)
						// Chart straight off the tool's rows, before the model sees
						// them. Nothing the model writes can change the picture, so a
						// chart can never disagree with the answer printed beside it.
						if ch := assistantChartFrom(name, result); ch != nil {
							send("chart", ch)
						}
					}
				}

				logAssistantMessage(ctx, db, convID, user, assistantLogEntry{
					Role: "tool", ToolName: name,
					ToolArgs: tc.Function.Arguments, ToolResult: payload,
				})

				encoded, err := json.Marshal(payload)
				if err != nil {
					encoded = []byte(`{"error":"result could not be encoded"}`)
				}
				msgs = append(msgs, ollamaMessage{Role: "tool", ToolName: name, Content: string(encoded)})
			}
		}

		if answer == "" {
			answer = "I could not put together an answer for that. Please try rephrasing it, or ask for one thing at a time."
			send("token", map[string]any{"t": answer})
		}

		latency := int(time.Since(started).Milliseconds())
		logAssistantMessage(ctx, db, convID, user, assistantLogEntry{
			Role: "assistant", Content: answer, Model: assistantModel(),
			PromptTok: promptTok, OutputTok: outputTok, LatencyMS: latency,
		})
		if _, err := db.PGExec(ctx,
			"UPDATE assistant_conversations SET updated_at = now() WHERE id = $1", convID); err != nil {
			slog.Warn("assistant: could not touch conversation", "id", convID, "err", err)
		}

		send("done", map[string]any{
			"conversation_id": convID,
			"answer":          answer,
			"tools_used":      used,
			"latency_ms":      latency,
			"model":           assistantModel(),
		})
	}
}
