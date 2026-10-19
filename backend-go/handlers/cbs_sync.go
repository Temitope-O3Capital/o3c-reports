package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/cbssync"
	"github.com/o3c/workspace/core"
	"github.com/o3c/workspace/udara"
)

// cbsSyncInterval reads CBS_SYNC_INTERVAL (a Go duration, e.g. "30m", "1h").
// Defaults to 1h; a value <= 0 disables scheduled syncing (manual trigger only).
func cbsSyncInterval() time.Duration {
	if v := os.Getenv("CBS_SYNC_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		slog.Warn("invalid CBS_SYNC_INTERVAL, using default 1h", "value", v)
	}
	return time.Hour
}

// StartCBSSyncWorker periodically spools the Udara360 book into the snapshot tables.
// No-op if the CBS client is not configured. Runs one sync shortly after boot, then
// on the configured interval.
func StartCBSSyncWorker(c *udara.Client, db *core.DB) {
	if c == nil || !c.IsConfigured() {
		slog.Info("CBS sync worker disabled (Udara360 not configured)")
		return
	}
	interval := cbsSyncInterval()
	if interval <= 0 {
		slog.Info("CBS scheduled sync disabled (CBS_SYNC_INTERVAL <= 0); manual trigger only")
		return
	}

	runOnce := func() {
		// 20 minutes, not 5. The loan-schedule walk inside doSync is allowed up to ten
		// minutes of its own (cbssync.loanScheduleTimeout) because it issues one serial
		// GET per open loan, and the parent has to be able to COVER that child rather
		// than expire underneath it.
		//
		// The first attempt at that gave the child its own context from
		// context.Background(), detached from this one. That is a worse bug than the
		// one it fixed, by inspection rather than by observation: doSync is sequential,
		// so a walk running past the parent's deadline leaves everything after it — the
		// reconcile, and SyncAll's own closing UPDATE of cbs_sync_runs — executing on an
		// already-cancelled context. Those writes fail, and the run row then sits at
		// 'running' until the 30-minute stranded sweep relabels it 'interrupted'. Every
		// slow run would have looked interrupted while actually having succeeded.
		//
		// Trading a mid-walk timeout for silently broken bookkeeping is not a fix. So
		// the budget covers the work, and the child derives from this context (see
		// sync.go) — one cancellation tree, with the child still bounded.
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
		defer cancel()
		if _, err := cbssync.SyncAll(ctx, c, db, "scheduled", sql.NullInt64{}); err != nil {
			slog.Error("scheduled CBS sync failed", "err", err)
		}
	}

	// Close out any run this process's predecessor was in the middle of.
	//
	// A run is marked 'running' at the start and updated at the end, so a process
	// killed in between leaves the row 'running' forever. On this server that is
	// every deploy restart, and 58 such rows had accumulated since 31 July —
	// enough that "is a sync in flight?" was permanently answered yes. Nothing
	// that started before this process booted can still be running.
	reconcileStrandedCBSRuns(db)

	// Let the server settle before the first pull.
	time.Sleep(30 * time.Second)
	runOnce()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		// Also on every tick, not only at boot. A run stranded by a crash at
		// midday would otherwise sit 'running' until the next restart — which is
		// how 58 of them accumulated. The query is a cheap indexed no-op when
		// there is nothing to close.
		reconcileStrandedCBSRuns(db)
		runOnce()
	}
}

// RegisterCBSSync mounts the READ-ONLY core-banking endpoints under /api/cbs.
//
// There is no sync trigger here any more, and that is the design: the book is polled
// every three minutes by StartCBSSyncWorker and there is no manual path into Udara at
// all. See the note above cbsSyncStatus for why the trigger and the probes went.
func RegisterCBSSync(r chi.Router, c *udara.Client, db *core.DB) {
	r.Get("/sync/status", cbsSyncStatus(db))
	// Live core-banking account activity for Customer 360 — the real posting ledger
	// (disbursements, repayments, interest, fees) that the card feed never carries.
	r.Get("/customer/{cif}/statement", cbsCustomerStatement(c, db))
}

// cbsInnerRows unwraps a Udara envelope {"data": <inner>} where inner is either
// {"data":[...]} / {"items":[...]} (search + report shapes) or a bare array.
func cbsInnerRows(raw json.RawMessage) []map[string]any {
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &env) != nil {
		return nil
	}
	var inner struct {
		Data  []map[string]any `json:"data"`
		Items []map[string]any `json:"items"`
	}
	if json.Unmarshal(env.Data, &inner) == nil {
		if len(inner.Data) > 0 {
			return inner.Data
		}
		if len(inner.Items) > 0 {
			return inner.Items
		}
	}
	var arr []map[string]any
	if json.Unmarshal(env.Data, &arr) == nil {
		return arr
	}
	return nil
}

// cbsCustomerStatement resolves a customer's Udara accounts (SearchAccount by CustomerId
// + our synced loan/FD/linked accounts) and merges each account's RequestCustomerAccountStatement
// into one date-sorted posting ledger for the selected window. Read-only; network calls are
// bounded (≤6 accounts, 60s) so a customer with a fat book can't hang the request. Period is
// keyed on financialDate (the value date), never the entry time.
func cbsCustomerStatement(c *udara.Client, db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !c.IsConfigured() {
			cbsWriteJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "CBS not configured"})
			return
		}
		cif := chi.URLParam(r, "cif")
		from, to := qstr(r, "from"), qstr(r, "to")
		if !dateRE.MatchString(from) || !dateRE.MatchString(to) {
			now := time.Now()
			to = now.Format("2006-01-02")
			from = now.AddDate(0, 0, -90).Format("2006-01-02")
		}
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()

		// Resolve the customer's account numbers: Udara's live account list first, then
		// any loan/FD/linked accounts we've already synced (belt and braces).
		acctName := map[string]string{}
		if raw, code, err := c.Do(ctx, "GET", "/api/account/v1/SearchAccount", nil, urlValues("CustomerId", cif)); err == nil && code == 200 {
			for _, a := range cbsInnerRows(raw) {
				if an := str(a["accountNumber"]); an != "" {
					acctName[an] = str(a["accountName"])
				}
			}
		}
		for _, row := range queryRows(ctx, db, `
			SELECT cbs_account_number AS an FROM app.cbs_loans WHERE cbs_customer_id=$1 AND cbs_account_number<>''
			UNION SELECT linked_account FROM app.cbs_loans WHERE cbs_customer_id=$1 AND COALESCE(linked_account,'')<>''
			UNION SELECT cbs_account_number FROM app.cbs_fixed_deposits WHERE cbs_customer_id=$1 AND cbs_account_number<>''`, cif) {
			if an := str(row["an"]); an != "" {
				if _, ok := acctName[an]; !ok {
					acctName[an] = ""
				}
			}
		}

		accounts := make([]map[string]any, 0, len(acctName))
		postings := make([]map[string]any, 0, 64)
		n := 0
		for an, nm := range acctName {
			if n >= 6 {
				break
			}
			n++
			accounts = append(accounts, map[string]any{"account": an, "name": nm})
			raw, code, err := c.Do(ctx, "GET", "/api/Report/v1/RequestCustomerAccountStatement", nil,
				urlValues("AccountNumber", an, "FinancialDateFrom", from, "FinancialDateTo", to))
			if err != nil || code != 200 {
				continue
			}
			for _, p := range cbsInnerRows(raw) {
				postings = append(postings, map[string]any{
					"account":        an,
					"financial_date": str(p["financialDate"]),
					"posted_at":      str(p["transactionDate"]),
					"reference":      str(p["postingReferenceNumber"]),
					"debit_kobo":     int64(toFloat(p["debit"])),
					"credit_kobo":    int64(toFloat(p["credit"])),
					"balance_kobo":   int64(toFloat(p["balance"])),
					"narration":      str(p["narration"]),
				})
			}
		}
		// Newest first, by value date. String compare is safe — dates are YYYY-MM-DD.
		sort.Slice(postings, func(i, j int) bool {
			return str(postings[i]["financial_date"]) > str(postings[j]["financial_date"])
		})
		if len(postings) > 300 {
			postings = postings[:300]
		}
		cbsWriteJSON(w, http.StatusOK, map[string]any{
			"accounts": accounts, "postings": postings, "from": from, "to": to, "count": len(postings),
		})
	}
}

// urlValues builds url.Values from alternating key,value pairs.
func urlValues(kv ...string) url.Values {
	v := url.Values{}
	for i := 0; i+1 < len(kv); i += 2 {
		v.Set(kv[i], kv[i+1])
	}
	return v
}

// THE MANUAL SYNC TRIGGER AND THE THREE PROBE ENDPOINTS WERE REMOVED, DELIBERATELY.
//
// The trigger (POST /api/cbs/sync) ran the same SyncAll the scheduler runs, sharing no
// lock with it, and both do DELETE-then-INSERT on cbs_loans and cbs_fixed_deposits —
// so a click during a scheduled run left only the database transaction standing between
// two writers of the same tables. With the book polled every three minutes there was
// nothing a manual run could achieve except that race: the worst case for "I need fresh
// data now" is a 180-second wait, and the Worker Hub already shows when the last run
// finished. Removing the button fixes the concurrency hazard without needing a lock,
// which is the cheaper half of the same repair.
//
// The probes (GET /probe, /probe-all, /probe-detail) enumerated a 24-endpoint candidate
// list of which 21 do not exist — guesses from before the real surface was found. They
// were admin-only and read-only, so they were harmless, but they advertised an API that
// is not there and invited somebody to build on it. The same capability survives as a
// read-only developer CLI, `go run ./cmd/probe`, which is where a one-off diagnostic
// belongs rather than mounted in the product.
//
// Nothing in the product triggers a Udara read by hand any more. Every path is a worker.

func cbsSyncStatus(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var (
			id                                       sql.NullInt64
			kind, status, errMsg                     sql.NullString
			startedAt, finishedAt                    sql.NullTime
			productsN, loansN, fdsN, matchedN, unmat sql.NullInt64
		)
		err := db.PG.QueryRowContext(ctx, `
			SELECT id, kind, started_at, finished_at, status, products_n, loans_n, fds_n,
			       matched_n, unmatched_n, error
			FROM cbs_sync_runs ORDER BY started_at DESC LIMIT 1`).
			Scan(&id, &kind, &startedAt, &finishedAt, &status, &productsN, &loansN, &fdsN,
				&matchedN, &unmat, &errMsg)

		last := map[string]any{}
		if err == nil {
			last = map[string]any{
				"id":          id.Int64,
				"kind":        kind.String,
				"status":      status.String,
				"started_at":  nullTimeStr(startedAt),
				"finished_at": nullTimeStr(finishedAt),
				"products":    productsN.Int64,
				"loans":       loansN.Int64,
				"fds":         fdsN.Int64,
				"matched":     matchedN.Int64,
				"unmatched":   unmat.Int64,
				"error":       errMsg.String,
			}
		}

		// Current snapshot row counts (independent of last run record).
		counts := map[string]any{
			"products":       scalarCount(ctx, db, "cbs_products"),
			"loans":          scalarCount(ctx, db, "cbs_loans"),
			"fixed_deposits": scalarCount(ctx, db, "cbs_fixed_deposits"),
			"linked":         scalarCount(ctx, db, "cbs_links"),
		}
		cbsWriteJSON(w, http.StatusOK, map[string]any{"last_run": last, "snapshot": counts})
	}
}

func scalarCount(ctx context.Context, db *core.DB, table string) int64 {
	var n sql.NullInt64
	// table is a fixed literal from this file, not user input.
	if err := db.PG.QueryRowContext(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil {
		return 0
	}
	return n.Int64
}

func nullTimeStr(t sql.NullTime) any {
	if !t.Valid {
		return nil
	}
	return t.Time.Format(time.RFC3339)
}

func cbsWriteJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// reconcileStrandedCBSRuns closes runs left open when the process was killed.
//
// 'interrupted' rather than 'error': the sync did not fail, it was stopped, and
// conflating the two would make the failure rate read far worse than it is.
// Scoped to runs older than 30 minutes, which is the per-run context (20 minutes) plus
// half of it again, so a genuinely in-flight run is never reaped as merely slow. There
// is at most one in flight: the loop is sequential and, since the manual trigger was
// removed, nothing else starts a run.
//
// Keep this comfortably ABOVE the run budget in StartCBSSyncWorker. It previously said
// the scope WAS the 5-minute timeout while the query has always said 30 minutes — and
// the margin is what makes the sweep safe, because a run killed by a host outage must
// not be confused with one that is still working.
func reconcileStrandedCBSRuns(db *core.DB) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	rows, err := db.PGQuery(ctx, `
		UPDATE cbs_sync_runs
		   SET status = 'interrupted',
		       finished_at = COALESCE(finished_at, started_at),
		       error = COALESCE(NULLIF(error,''),
		                        'Process restarted while this run was in flight; never completed')
		 WHERE status = 'running' AND started_at < NOW() - interval '30 minutes'
		 RETURNING id`)
	if err != nil {
		slog.Warn("could not reconcile stranded CBS runs", "err", err)
		return
	}
	if len(rows) > 0 {
		slog.Info("closed CBS sync runs stranded by a restart", "count", len(rows))
	}
}
