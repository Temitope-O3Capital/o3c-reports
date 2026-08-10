# DB Consolidation — Finish Runbook

**State at time of writing (2026-08-06):** the DB is consolidated to one clean set
(`app.customers` / `app.accounts` / `app.transactions`); `feed`/`src`/`raw`/`hist` are
dropped; MSSQL code is removed; **all 26 handlers + the recon engine** are repointed off the
4 compatibility views onto the clean tables (build green, `go vet` clean). The 4 views + a
thin `core.transaction` bridge are still in place **only so the currently-deployed old binary
keeps working until the new binary ships.**

Execute the phases **in order**. Do not skip ahead — the ordering is what keeps prod live.

---

## Preconditions
- [ ] The **other session has committed** its in-flight work (`main.go`, `helpdesk.go`,
      `care_mail.go`, settlement handlers, frontend). Confirm: `git status --short` shows no
      unexpected `M`/`??` on files you're about to commit.
- [ ] You have a **deploy window** (brief backend restart).
- [ ] Backups exist: `scratchpad/backup_pipeline_20260806.sql` (552 MB, core/src/raw/hist) and
      `backup_predrop_20260806.sql`. Keep until Phase 5 passes.

---

## Phase 1 — Commit the remaining repoint + MSSQL removal
**Already committed** (safe, non-co-mingled): 23 of 26 handler repoints —
`7138da4` (10 handlers + docs + tools) and `a2a8f54` (13 handlers: overview,
executive, sales, cards, card_trends, cohort, transactions, stubs, cbs_reports,
contacts, crm, customer360, statement_emails).

**Remaining to commit** (held only because they're co-mingled with the other
session's in-flight work): the MSSQL removal + recon + 3 handlers. Stage **only**
these explicit paths (`git commit` commits the whole index — check the diff first):

```bash
cd /c/Users/tbabatunde/o3c-reports
git add \
  backend-go/core/config.go backend-go/core/db.go backend-go/main.go \
  backend-go/.env.example backend-go/recon/engine.go \
  backend-go/handlers/care_mail.go backend-go/handlers/paystack_ops.go backend-go/handlers/helpdesk.go
git status --short                # confirm ONLY the intended files are staged
git diff --cached --stat          # sanity-check: only repoint + MSSQL-removal hunks
```
> These files carry the other session's changes too. Do this **after** they commit,
> or use `git add -p <file>` to stage only the repoint / MSSQL-removal hunks.
> `main.go`/`db.go`/`config.go` must ship together (build-coupled).
Then commit (bash heredoc — avoids PowerShell mangling):
```bash
git commit -F - <<'EOF'
Consolidate onto app.* clean tables; remove MSSQL; repoint remaining handlers + recon

Completes the DB consolidation: all handlers and the recon engine now read
app.customers/accounts/transactions directly instead of the app."Accounts"/
"Products"/"Transactions"/"CIF Table" compatibility views (JSON output keys
preserved via aliases, so the frontend is unchanged). Removes the dormant
MSSQL/Sage connector (config/db/main) — Postgres is the sole datastore.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```
> If any staged file has co-mingled changes from the other session, either wait for them to
> commit first, or use `git add -p <file>` to stage only the repoint hunks.

---

## Phase 2 — Build & deploy the new backend
```bash
export PATH="/c/Users/tbabatunde/go-sdk/go/bin:$PATH"
cd /c/Users/tbabatunde/o3c-reports/backend-go
go build ./... && go build -o o3c-backend.new.exe .
```
Swap the binary under the scheduled task (PowerShell):
```powershell
Stop-ScheduledTask -TaskName "O3C-Backend"
Move-Item -Force o3c-backend.new.exe o3c-backend.exe
Start-ScheduledTask -TaskName "O3C-Backend"
```
Verify healthy (should return `{"status":"ok","mssql":"removed"}`):
```bash
curl -s http://localhost:8000/api/health
```

---

## Phase 3 — Smoke-test the coupled dashboards (the real last-mile check)
Open the running app and confirm each renders data (these are the queries whose JSON shape
must match the frontend):
- [ ] **Overview / Executive** (KPIs, trends, top states, product mix)
- [ ] **Cards** (overview, by-status, product performance, cardholders)
- [ ] **Sales** (KPIs, geographic, product performance)
- [ ] **CRM** customer panel · **Customer-360** (identity, products, transactions)
- [ ] **Customer statements** (statement generation for a CIF)
- [ ] **Helpdesk** (customer context lookup on a ticket)

If any is empty/wrong, check the backend log for a Postgres column error, fix the query,
rebuild + redeploy (Phase 2). **Do not proceed to Phase 4 until these pass.**

---

## Phase 4 — Drop the views + `core` bridge
Only after Phase 3 is green (nothing reads the views anymore):
```bash
PSQL=$(ls "/c/Program Files/PostgreSQL/"*/bin/psql.exe | head -1)
CONN=$(grep -oP 'DATABASE_URL=\K.*' backend-go/.env | head -1)
"$PSQL" "$CONN" -v ON_ERROR_STOP=1 -f tools/feed-backfill/drop_views.sql
```
(The script runs the dependency safety-check note first; it drops the 4 views, the
`core.transaction` bridge, and the now-empty `core` schema. It leaves `Collections Log` /
`Recovery Master Sheet` / `interswitch_*` alone.)

---

## Phase 5 — Frontend mocks + close-out
- [ ] Remove dev mocks once the other session is clear: delete `frontend/src/mocks/` and the
      `VITE_MOCK` bootstrap in `frontend/src/main.tsx`; rebuild the SPA
      (`VITE_API_URL=https://crm.o3cards.pri:8443 npm run build`) and `robocopy` to
      `frontend-dist`.
- [ ] Watch one full day of dashboards + logs.
- [ ] Delete the scratchpad backups once satisfied.

---

## Rollback
- **Bad deploy (Phase 2/3):** restore the previous `o3c-backend.exe` and restart the task. The
  views still exist (not yet dropped), so the old binary works immediately.
- **After Phase 4 (views dropped) something breaks:** recreate the 4 views + bridge from
  `scratchpad/backup_views_20260806.sql`, or restore `core` from
  `scratchpad/backup_pipeline_20260806.sql`, then redeploy the old binary. This is why the
  view-drop is the **last** step and gated on Phase 3.

---

## Still open (separate tracks, not blockers)
- The **repo → `app.*` 15-minute sync** must be (re)built — the old external `raw→src→core`
  ingest is retired, so `app.*` won't get new rows until this is set up. See
  `docs/DATA_FEED_INGESTION.md`.
- The **Paystack↔ledger matcher** (customer crosswalk → `422` tiers → settlement backstop) per
  `docs/DATA_FEED_INGESTION.md` §9.
