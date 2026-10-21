package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/o3c/workspace/core"
)

// Compares candidate models on the REAL tool set against live database truth,
// so the choice is made on evidence rather than reputation.
//
// Run with:
//
//	PGURL=... BENCH_MODELS=qwen3:4b-instruct,qwen3:8b go test -run TestModelBench -v -timeout 60m
//
// Each case states what a correct answer must contain, computed from the
// database at run time — hardcoding figures would rot within the hour, since the
// feed lands every 15 minutes.
type benchCase struct {
	q        string
	wantTool string // tool that must be called, "" if none required
	// truthPath reads the expected figure out of wantTool's OWN result, rather
	// than a hand-written query. Re-deriving it in SQL got this wrong first time:
	// get_call_centre_stats collapses duplicate call legs through the episode CTE,
	// so a plain COUNT(*) said 13,513 where the tool says 4,613, and the benchmark
	// failed a model that had answered correctly. Reading the tool's own output
	// tests the thing that matters — did the model faithfully repeat it.
	truthPath []string
	truthSQL  string   // only where the figure is not a scalar in the tool result
	mustHave  []string // literal strings the answer must contain
	mustNot   []string // fabrication tells: unsupported judgement
}

// digPath walks a tool result down a key path and formats the leaf with commas.
func digPath(res any, path []string) string {
	cur := res
	for _, k := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		cur, ok = m[k]
		if !ok {
			return ""
		}
	}
	if f, ok := asFloat(cur); ok {
		return withCommas(int64(f))
	}
	return fmt.Sprint(cur)
}

func TestModelBench(t *testing.T) {
	url := os.Getenv("PGURL")
	models := strings.Split(os.Getenv("BENCH_MODELS"), ",")
	if url == "" || len(models) == 0 || models[0] == "" {
		t.Skip("set PGURL and BENCH_MODELS")
	}
	db, err := core.Open(&core.Config{PGURL: url, DirectPGURL: url})
	if err != nil {
		t.Fatal(err)
	}

	cases := []benchCase{
		{
			q:         "How many calls did we handle in the last 7 days?",
			wantTool:  "get_call_centre_stats",
			truthPath: []string{"totals", "total_calls"},
		},
		{
			q:         "What is our card portfolio delinquency?",
			wantTool:  "get_card_portfolio_summary",
			truthPath: []string{"summary", "delinquent_accounts"},
		},
		{
			// get_lead_ownership answers from the SALES book, so the truth joins
			// sales_owner_id — the column applyLeadScope scopes on since migration 302.
			// It previously joined lead_owner_id, which is the CALL CENTRE's own owner
			// column, so the tool and its own truth query measured two different books.
			//
			// Worth knowing when reading a failure here: Ramat Sadiq is a call-centre
			// agent, so the sales-scoped answer is legitimately 0 and this case currently
			// asserts agreement at zero. It checks that the tool is SELECTED and that its
			// number matches the sales book; it does not exercise a populated book. A case
			// with real volume needs a sales officer who owns leads, and on 28 Sept 2026
			// no officer does — all 185 forwarded leads are still unclaimed.
			q:        "How many leads does Ramat have?",
			wantTool: "get_lead_ownership",
			truthSQL: `SELECT COUNT(*) FROM crm_contacts c JOIN o3c_users u ON u.id=c.sales_owner_id WHERE u.full_name ILIKE '%Ramat%' AND c.lead_stage <> 'converted' AND COALESCE(c.already_customer,false)=false`,
		},
		{
			q:        "Who is Esther?",
			wantTool: "find_staff",
			mustHave: []string{"Adebowale"},
		},
		{
			q:        "Write a two-paragraph summary of our card portfolio for the board pack.",
			wantTool: "get_card_portfolio_summary",
			// Judgement no tool supplied. These are the exact phrases the 4b model
			// invented before the prompt rules were tightened.
			mustNot: []string{"no further action", "within the bank", "acceptable risk",
				"consistent with recent trends", "healthy", "well within"},
		},
		{
			q:        "Draft a short email to my manager saying I am unwell and will not be in tomorrow.",
			wantTool: "",
		},
	}

	type score struct{ passed, total int }
	results := map[string]*score{}

	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		t.Setenv("ASSISTANT_MODEL", model)
		results[model] = &score{}
		t.Logf("\n================ %s ================", model)

		// Warm: the first call pays a model load plus a full preamble prefill and
		// would otherwise be reported as this model's turn time.
		warmCtx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		_, _ = ollamaChatWarm(warmCtx, []ollamaMessage{{Role: "user", Content: "ready"}}, nil)
		cancel()

		for _, c := range cases {
			// Truth is read BOTH before and after the model's turn, and either
			// reading is accepted.
			//
			// The call feed lands continuously -- ~3-4 legs a minute -- and the
			// episode CTE collapses legs inside a 15-minute window, so the
			// figure genuinely MOVES, and can move DOWN as legs merge into one
			// episode. A turn takes up to a minute on this hardware, so a single
			// pre-turn reading failed gpt-oss:20b for answering 2,534 against a
			// truth of 2,532 that was already a minute stale. Measured idle:
			// 2,538 -> 2,537 across 60 seconds. That is the clock, not the
			// model, and a benchmark that rejects a correct answer is worse than
			// no benchmark at all.
			readTruth := func() string {
				switch {
				case len(c.truthPath) > 0:
					var tool assistantTool
					for _, tl := range assistantTools() {
						if tl.Name == c.wantTool {
							tool = tl
						}
					}
					ctx, cn := context.WithTimeout(context.Background(), 60*time.Second)
					res, terr := tool.Run(ctx, db, &core.Claims{ID: 1, Role: "admin"}, map[string]any{})
					cn()
					if terr != nil {
						t.Fatalf("%s: %v", c.wantTool, terr)
					}
					v := digPath(res, c.truthPath)
					if v == "" {
						t.Fatalf("%s: no value at %v", c.wantTool, c.truthPath)
					}
					return v
				case c.truthSQL != "":
					var n int64
					ctx, cn := context.WithTimeout(context.Background(), 60*time.Second)
					if err := db.PG.QueryRowContext(ctx, c.truthSQL).Scan(&n); err != nil {
						cn()
						t.Fatalf("truth query failed: %v", err)
					}
					cn()
					return withCommas(n)
				}
				return ""
			}

			var wants []string
			if before := readTruth(); before != "" {
				wants = append(wants, before)
			}
			ans, tools, secs := runTurn(t, db, model, c.q)
			if after := readTruth(); after != "" && (len(wants) == 0 || after != wants[0]) {
				wants = append(wants, after)
			}
			ok, why := judge(c, ans, tools, wants)
			results[model].total++
			if ok {
				results[model].passed++
			}
			mark := "FAIL"
			if ok {
				mark = "pass"
			}
			t.Logf("[%s] %-62s %5.1fs tools=%v", mark, benchTrunc(c.q, 62), secs, tools)
			if !ok {
				t.Logf("       why: %s", why)
			}
			t.Logf("       answer: %s", benchTrunc(strings.ReplaceAll(ans, "\n", " "), 220))
		}
	}

	t.Log("\n================ SCORES ================")
	names := make([]string, 0, len(results))
	for m := range results {
		names = append(names, m)
	}
	sort.Strings(names)
	for _, m := range names {
		t.Logf("%-24s %d/%d", m, results[m].passed, results[m].total)
	}
}

func runTurn(t *testing.T, db *core.DB, model, q string) (string, []string, float64) {
	t.Helper()
	u := &core.Claims{ID: 1, Role: "admin", FullName: "Temitope"}
	wire, byName := toolsForUser(u)
	names := make([]string, 0, len(byName))
	for n := range byName {
		names = append(names, n)
	}
	sort.Strings(names)

	msgs := []ollamaMessage{
		{Role: "system", Content: assistantSystemPrompt(names)},
		{Role: "user", Content: assistantTurnContext(u, "") + q},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	var used []string
	start := time.Now()
	for round := 0; round < 4; round++ {
		r, err := ollamaChat(ctx, msgs, wire)
		if err != nil {
			return "ERROR: " + err.Error(), used, time.Since(start).Seconds()
		}
		if len(r.Message.ToolCalls) == 0 {
			return strings.TrimSpace(r.Message.Content), used, time.Since(start).Seconds()
		}
		msgs = append(msgs, r.Message)
		for _, tc := range r.Message.ToolCalls {
			used = append(used, tc.Function.Name)
			tool, ok := byName[tc.Function.Name]
			if !ok {
				msgs = append(msgs, ollamaMessage{Role: "tool", Content: `{"error":"no such tool"}`})
				continue
			}
			res, rerr := tool.Run(ctx, db, u, tc.Function.Arguments)
			if rerr != nil {
				msgs = append(msgs, ollamaMessage{Role: "tool", Content: `{"error":"lookup failed"}`})
				continue
			}
			b, _ := json.Marshal(res)
			msgs = append(msgs, ollamaMessage{Role: "tool", Content: string(b)})
		}
	}
	return "ERROR: exceeded tool rounds", used, time.Since(start).Seconds()
}

// quotesFigure looks for want as a whole number, not as a substring.
//
// strings.Contains was awarding marks it could not justify. A truth of "0" is
// satisfied by any answer containing a zero anywhere: the "How many leads does
// Ramat have?" case passed for dumping the entire owner list — "leads_owned:10"
// — without mentioning Ramat at all. The same run FAILED the identical case on
// the previous harness for answering "Ramat does not appear in the list", which
// is at least true. Both verdicts were noise.
//
// A narrow no-break space is accepted as a thousands separator because gpt-oss
// emits U+202F there, writing 1,124 as "1 124". That is a formatting fault, not
// a wrong figure; it is corrected by a prompt rule and by speech.ts, and failing
// the model here would hide a real pass behind a cosmetic one.
func quotesFigure(ans, want string) bool {
	variants := []string{
		want,
		strings.ReplaceAll(want, ",", "\u202f"), // narrow no-break space
		strings.ReplaceAll(want, ",", "\u00a0"), // non-breaking space
		strings.ReplaceAll(want, ",", ""),       // unseparated, e.g. 1124
	}
	for _, w := range variants {
		if w == "" {
			continue
		}
		// Not flanked by another digit, so "0" does not match inside "10".
		re := regexp.MustCompile(`(^|[^0-9])` + regexp.QuoteMeta(w) + `($|[^0-9])`)
		if re.MatchString(ans) {
			return true
		}
	}
	return false
}

func judge(c benchCase, ans string, tools []string, wants []string) (bool, string) {
	low := strings.ToLower(ans)
	if c.wantTool != "" {
		found := false
		for _, tl := range tools {
			if tl == c.wantTool {
				found = true
			}
		}
		if !found {
			return false, "did not call " + c.wantTool
		}
	}
	// Any of the acceptable readings will do. See the readTruth comment: on a
	// live feed the correct answer is a small range, not a point.
	if len(wants) > 0 {
		hit := false
		for _, w := range wants {
			if quotesFigure(ans, w) {
				hit = true
			}
		}
		if !hit {
			return false, fmt.Sprintf("answer does not quote the true figure (%s)",
				strings.Join(wants, " or "))
		}
	}
	for _, m := range c.mustHave {
		if !strings.Contains(ans, m) {
			return false, "missing " + m
		}
	}
	for _, m := range c.mustNot {
		if strings.Contains(low, strings.ToLower(m)) {
			return false, "invented judgement: " + m
		}
	}
	if strings.HasPrefix(ans, "ERROR:") {
		return false, ans
	}
	return true, ""
}

func withCommas(n int64) string {
	s := fmt.Sprint(n)
	if len(s) <= 3 {
		return s
	}
	var out []byte
	for i, ch := range []byte(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, ch)
	}
	return string(out)
}

// benchTrunc, not truncate: phoenix.go already owns that name in this package.
func benchTrunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

// Guards the benchmark against awarding marks it cannot justify. A scoring bug
// is worse than a model bug: it sends you off tuning prompts against noise.
func TestQuotesFigureIsNotASubstringMatch(t *testing.T) {
	cases := []struct {
		ans, want string
		ok        bool
		why       string
	}{
		{"Ramat owns 0 leads.", "0", true, "the plain case"},
		{"by_owner: leads_owned:10 owner:Nkem", "0", false,
			"a zero inside 10 is not an answer of zero"},
		{"Ramat does not appear in the list.", "0", false,
			"true, but it never gives the figure"},
		{"Total calls: 2,541.", "2,541", true, "comma separated, as the tools format it"},
		{"1 124 delinquent", "1,124", true,
			"narrow no-break space is a formatting fault, not a wrong number"},
		{"1124 delinquent", "1,124", true, "unseparated but correct"},
		{"balance 12,541", "2,541", false, "must not match inside a longer number"},
		{"account 11240", "1,124", false, "nor as a prefix of one"},
	}
	for _, c := range cases {
		// The narrow space has to be a real U+202F, not a typed space.
		ans := strings.ReplaceAll(c.ans, "1 124", "1\u202f124")
		if got := quotesFigure(ans, c.want); got != c.ok {
			t.Errorf("quotesFigure(%q, %q) = %v, want %v — %s", ans, c.want, got, c.ok, c.why)
		}
	}
}
