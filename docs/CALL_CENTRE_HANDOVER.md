# Call centre, collections and identity — handover

What a developer picking this up needs to know and cannot get from the code. Written
2026-09-29 after two days of work across the call centre, collections, recovery, risk and
identity layers. Every figure here was measured against the live `o3_workspace` database on
the date given, not estimated.

Sections marked **Left as-is** were deliberate. The reason is recorded so nobody rediscovers
them and wonders whether anyone looked — same convention as
[DATA_QUALITY_KNOWN_ISSUES.md](DATA_QUALITY_KNOWN_ISSUES.md).

---

## 1. The one pattern behind almost every bug

Four separate defects were reported over two days by a user clicking around. Not one was a
logic error. **Every one was a rule enforced in one place and not the other:**

| Reported as | Actually was |
|---|---|
| "C360 shows someone else's name" | A Udara id joined against `app.customers.cif` |
| "Collections shows 0.00 but C360 shows the real profile" | The identity resolver handled cards keys only |
| "Why is Forward to Sales on a callback?" | The API refused it; the UI never got the same fix |
| "The disposition needs an Others" | A vocabulary with no escape hatch, so agents used a destructive neighbour |

Four read-only audits then found roughly 25 more of the same shape. The copies of a rule live
in five predictable places:

1. a Go handler,
2. **a sibling handler that writes the same column** (this is the one everyone forgets),
3. a SQL function, view or CHECK constraint,
4. a TypeScript constant,
5. the UI gate that decides whether the control even renders.

**When you change a business rule, assume there are other copies and go find them.** A rule
enforced on three of four write paths is not enforced.

Worked example: the "Other needs a written explanation" rule had to be added to `hdLogCall`,
`hdEditCall`, `collectionsOpsContact` **and** `ccLogCall`. The fourth was found only by
auditing, after I had already claimed the rule held "on both write paths".

A second, sharper one — because here the person fixing it counted the copies and still missed
two. The test-card name regex decides what is held out of `income_daily`, `income_by_currency`
and `card_balances`. Migration 312 removed the token `fastest` from it (that token was matching
six real 2018 race-prize cardholders who carried balances and used ATMs), updated the SQL
function and all four Go copies, and wrote in its own header: *"there are five including this
function. Keep all five in step."* **There were seven.** Two views, `app."Accounts"` and
`app."Products"`, had the pattern inlined by migrations 213 and 214 — the second of which is
named `214_views_test_filter_fastest.sql` — and went untouched, so for two weeks the function
called those six people customers while the reporting views still called them test data.
Migration 316 fixed it, and the lesson is in the arithmetic: **counting the copies is not the
same as finding them.** Query the catalogue (`pg_get_viewdef`, `pg_proc.prosrc`,
`pg_get_constraintdef`) rather than trusting a count written in a comment.

---

## 2. Identity — three namespaces that look joinable and are not

**This is the most expensive trap in the codebase.** The full reasoning is in the header of
`backend-go/migrations/299_delinquency_view_names_its_namespace.sql`.

| Id | What it is | Where it lives |
|---|---|---|
| `party_id` | The canonical customer | `app.parties` |
| **CIF** | A **cards-only** id from CCS/Sage | `app.customers.cif`, `app."Accounts"."CIF Number"` |
| Udara `customerID` | Core banking's own id | `cbs_loans.cbs_customer_id`, `cbs_customers` |

**271 of 295 Udara ids also exist as a card CIF, and 100% of those are a different real
person.** Udara `00000432` is GLISTER HOME APPLIANCES; card CIF `00000432` is Onafowokan
Olayiwola.

- The **only** correct bridge is `app.cbs_links` (`entity_type='party'`).
- Storable Udara keys carry the `UD-` prefix (migration 267). Cards CIFs are always exactly
  8 digits, so the prefix can never collide.
- `idCaption()` in `components/CreditFile.tsx` renders a key honestly. Use it rather than
  printing "CIF" next to something you have not verified is one.
- Never write `c.cif = d.cif` against the delinquency view. Migration 299 **deleted** the
  column called `cif` precisely so that statement fails loudly instead of returning a
  stranger; the view publishes `arm` / `raw_cif` / `key_cif` instead.

A party legitimately holding two names is **not** an error — party 708802 holds both
HARRIET ODOMETA and ODOMETA ONOME. Do not make "one party, one name" an invariant; it was
nearly encoded as a startup guard, which would have been an outage.

### Switching an account off is two separate things

`is_active = FALSE` decides the **next** sign-in. It does nothing to the session the person is
already in: `core.AuthMiddleware` rejects a token only for being denylisted, expired, or minted
before that user's `o3c_users.tokens_valid_from`. Until migration 319 nothing in the deactivate
path moved that watermark, so a deactivated user kept working off the token already in their
browser until it aged out — the opposite of what anyone clicking "Deactivate" believes.

Both halves happen together now: `core.InvalidateUserTokens(ctx, userID)` advances the
watermark, and every route that withdraws access calls it. If you add another such route, call
it there too — the flag alone is not a revocation.

Suspension (`handlers/admin_suspend.go`) is the emergency version of the same thing and reuses
`is_active` deliberately. The `suspended_*` columns record why, by whom, and hold the
reinstatement code; they gate nothing on their own, so there is no second "switched off" flag
to keep in step. The 4/6-digit code lifts the suspension and issues no session — the person
still needs their own password — which is what makes six digits defensible at all, alongside a
30-minute expiry and a five-attempt cap enforced in the database rather than in memory.

---

## 3. Query traps that will cost you a day

**Counting calls without both filters.** A Zoho dialling episode lands as several legs with
the write-up merged onto one:

```sql
WHERE voided_at IS NULL AND merged_into_call_id IS NULL
```

Omitting `merged_into_call_id` double-counts. On 2026-09-29 this made 11 `Other` uses read as
20 — and the duplicate rows looked *convincingly* like agents logging the same call twice. I
nearly reported a data-quality problem that did not exist.

**`app.norm_phone` returns `''`, never NULL.** So `norm_phone(a) = norm_phone(b)` is TRUE when
both sides are blank. Guard with `length(...) = 10` on **both** sides. Unguarded, this once
suppressed 14,965 of 14,965 queue contacts. Placeholder numbers are 10 real digits and sail
through the length guard too — `8012345678` sits on 4,113 parties — so pair it with a
placeholder blocklist for anything identity-related.

**A phone does not identify one relationship.** `call_center_contacts` holds a row per
campaign: 44 phones carry a pending acquisition contact *and* a pending collections or
support one. A write keyed on phone alone crosses them. Prefer an explicit row id; scope to
the purpose that owns the action.

**NPL is `app.is_npl`, by value.** `DPD > 90 OR status IN ('Defaulting','Expired')`, and the
ratio is value over value — never a count of loans, which is what a regulator means. A
count-weighted DPD-only version in `risk.go` was publishing **9.8% where the canonical rule
says 79.1%**, while a sibling handler 90 lines below had it right.

---

## 4. Three guards will fail your deploy. That is them working

**Migration 308** refuses to apply if any disposition code in use has no label in
`app.cc_disposition_label`. Add a disposition to Go's `ccDispositions` and you **must** add it
there too. It caught its own author within 24 hours (migration 311) — the alternative was a
supervisor's screen quietly printing `payment_to_verify` as a label for three weeks.

**Migration 316** refuses to apply if the test-card name pattern is inlined in any view,
materialized view or function other than `app.is_test_card_name` itself — it queries
`pg_get_viewdef` and `pg_proc.prosrc` and names the culprit. Write `app.is_test_card_name(col)`
in new SQL; do not paste the regex. Seven copies of it had already drifted once (§1), and the
Go side is now a single source in `core/testcards.go` rendering both the Go regexp and the SQL
predicate from one token list. `core.TestSQLFunctionMatchesGo` compares the deployed SQL
function against the Go pattern over a corpus when `DATABASE_URL` is set — including the
`FASTEST MALE`/`FEMALE` cases, so a return of that token fails loudly.

**`TestDNCExprShapeStillShadows`** is a canary: it fails when the suppression expression stops
reading `dnc_list`, to force a review of the argument-qualification rule that depended on it.
It fired correctly when the expression was changed to delegate to `app.is_suppressed`.

When a test like that fails, **rewrite it to assert what it caught.** Do not delete it, and do
not "fix" the code to make it pass. Two tests were rewritten this way on 2026-09-29; both now
say where the guarantee moved to.

---

## 5. Deploying, and the shared working tree

**`main` is not what is live.** Production is this Windows host, built **by hand from this
working tree**. See [DEPLOYMENT.md](DEPLOYMENT.md) for the path; what follows is what that
document cannot tell you.

- **`/api/health` returning 200 is not proof your deploy landed.** `Stop-ScheduledTask` ends
  the *wrapper*; `o3c-backend.exe` can survive as an orphan still serving the old binary and
  answering health instantly. Verify by the file system: `RESTART.flag` gone **and**
  `o3c-backend-new.exe` gone, then check `schema_migrations`.
- **`migrations/rollback/rollback_<n>.sql` is a convention, not a rule — 12 of the last 19
  migrations have one.** Write one where it restores a *previous intention*. Do not write one
  where the only thing to restore is a defect: **316 deliberately has none**, because reversing
  it would re-hide the six real customers and seven accounts that migration 312 missed, and a
  script whose sole function is to reintroduce a known customer-facing bug is worse than its
  absence. `rollback_318.sql` is the borderline case — it says so in its own header — and is
  justified only because 318 rewrote data rather than logic.
- **Verify the *served* bundle, not the one you copied.** `cp -r` leaves every build's hashed
  chunks in `assets/`, so finding your string in *some* chunk proves nothing. Fetch `/`, follow
  `index.html` to the chunk it actually references, grep that one. A live behaviour fix was
  silently reverted by another session's deploy on 2026-09-29 and this is the only thing that
  caught it — nothing errored, and `git status` was clean because source and bundle are
  separate artefacts.
- **Look at what is PENDING before you restart.** Migrations are `//go:embed`-ed, so a restart
  applies every unapplied file in `migrations/` — including other sessions'. One restart
  applied a colleague's untracked migration that changed lead ownership for the whole sales
  floor. Diff `ls migrations/` against `schema_migrations`, read anything you did not write,
  and say what else went out under your restart.

**Several sessions edit this tree at once.** In three hours on 2026-09-29 that meant: a stolen
migration number, a deploy race costing ~70s of extra downtime, two `tsc`/`go build` breaks in
files that were not mine, and the silent frontend revert above. Practical rules:

- A build break is often not yours. Check `git status` for the file first. **Wait rather than
  fix** — both breaks cleared within a minute.
- Never `git add -A`. Use `git commit <paths> -F msg`; the index is shared.
- Expect your migration number to be stolen *while you wait for approval*, not just while you
  write. Re-check in the same breath as placing the file.
- To push when the tree is dirty with someone else's work, **do not stash**. Use an isolated
  worktree:

  ```sh
  git worktree add --detach /tmp/wt HEAD
  cd /tmp/wt && git rebase origin/main && git push origin HEAD:main
  cd - && git worktree remove --force /tmp/wt
  ```

  Check for file overlap between your commit and theirs first. This was used on 2026-09-29 and
  the other session's uncommitted work was untouched.

---

## 6. The `Other` disposition is a backlog. Please read it

`Other — Describe What Happened` exists because a vocabulary with no escape hatch does not
produce blank fields — it produces agents picking the nearest **wrong option that does
something**. That is how `Not Interested`, which *closes a lead*, came to absorb roughly 130
of 466 notes describing something else entirely: 28 customers who said they would come back,
17 who had asked for information, 16 objecting to the rate.

Three properties make it safe: it carries **no consequence**, it **demands a written
explanation** (enforced on all four write paths), and it sorts **last**.

**The whole justification is that what agents write there becomes the next named
disposition.** That only holds if somebody reads it. It is now on the call-centre Performance
page (`GET /api/call-center/other-review`) showing the rate, the notes, and a per-agent split —
the last of which separates "the list is missing an outcome" from "one person reaches for Other
instead of reading it". Different fixes entirely.

It has paid out once already. Eleven notes in the first two days produced
`registration_incomplete`, `payment_to_verify` and `not_yet_due`, plus the discovery that a
**support** call had recorded *"PAYING IN 2WEEKS TIME"* with nowhere to put it — which is why
Promise to Pay is now offered on support calls.

**Rate as at 2026-09-29: 12 of 18,765 dispositioned calls (0.1%), across four agents with none
dominating.** High is bad. A climbing rate is the earliest possible warning that an outcome is
missing.

---

## 7. Left as-is, with reasons

**Go↔TypeScript vocabulary pairs.** Collections payment channels, collections/recovery step
types and call-centre lead statuses are each declared once in Go and once in TypeScript, and
each file's comment names the other as its mirror. Unifying them needs a **serving endpoint**,
not another shared TS constant — a different job, not a smaller one. Contrast
`lib/ticketTypes.ts` and `lib/leadStages.ts`, which were TS-to-TS duplicates and *were*
consolidated, and `customerSteps`, which is served from Go and fetched.

But **do not unify the recovery payment channels until someone decides what they are** — and
this is the cautionary tale for the whole exercise. `RECOVERY_PAYMENT_CHANNELS` offers six
options (`Bank Transfer`, `Cash`, `Cheque`, `TPA`, `Legal Settlement`, `Self-Cure`) on three
live screens. `recovery_payments` holds 269 rows worth **₦921m**, and **not one row carries any
of those six values**:

| Actual value | Rows | Naira |
|---|---|---|
| `loan repayment` | 89 | 878,621,735 |
| `TRANSFER` | 99 | 29,204,616 |
| `REMITA` | 41 | 2,418,277 |
| `NDD` | 25 | 1,623,952 |
| `ZENITH` | 6 | 2,301,890 |
| `legal` | 5 | 5,943,111 |
| `TRANSFER/NDD` | 3 | 1,005,200 |
| `recovery` | 1 | 104,500 |

`recoveryOpsPayment` checks only that `channel` is non-empty — there is **no Go whitelist and no
CHECK constraint**, unlike collections. So history speaks one vocabulary, every new UI entry
speaks another, and nothing reconciles them. Publishing the TS list from Go would *codify the
fiction*: it would make six labels look authoritative while 100% of the data disagrees. The
prerequisite is a business decision — is `loan repayment` (95% of the value) a channel at all,
and do `TRANSFER`/`REMITA`/`NDD` collapse into `Bank Transfer`? Reconcile first, then enforce in
one place. Collections is the counter-example of a vocabulary that *is* real: the whitelist is
enforced by `collectionsPaymentChannels`, though note it only ever saw 11 of 1,812 rows — the
other 1,801 arrived as `historical import` and `crm_import` through bulk paths that bypass the
API entirely.

**`handlers/loans.go` — deleted 2026-09-30.** It was an unmounted loan router whose `loanStages`
vocabulary shared exactly **one** value (`submitted`) with the LOS pipeline in `los.go` that
actually owns `loan_applications.stage`, with no CHECK on the column. Mounting it would have let
a PATCH set a stage `allowedTransitions` cannot advance, `losFlow.ts` renders through its Draft
fallback with no action bar, and `risk.go`'s pending predicate never sees — so the file would
vanish from Risk's inbox while still counting as open.

It survived that long only because it also defined `jsonRows`, which 22 other files call, so
deleting it broke the build in a dozen places. `jsonRows` and `toInt64FromStr` now live in
`handlers/helpers.go` and the router is gone. Nothing referenced the routes: `RegisterLoans` had
no callers, so none of those 12 endpoints existed at runtime, and the only frontend hits for
`/api/loans` are fake strings in `mocks/handlers.ts` sample data. If you need what it did, use
the LOS handlers.

**Three phone normalisers, two conventions — and they are not interchangeable.** A catalogue
sweep on 2026-09-29 (the method from §1) found:

| Function | Returns | Used by |
|---|---|---|
| `app.norm_phone` | last **10** digits, `''` when blank | 80 Go sites — the match key |
| `app.normalise_ng_phone` | `0` + last 10 = **11** digits, **raw text when too short** | 7 Go sites + a Go twin, `normaliseNGPhone` |
| `core.norm_phone` | 11 digits, NULL when invalid | **nothing** |

`app.norm_phone(x) = core.norm_phone(y)` can never be true for a valid number — one has the
leading zero, the other does not. The first two conventions are deliberate (a match key versus
a dialable number) and every comparison found uses one convention on *both* sides, so they are
correct today. **`core.norm_phone` is an orphan in the `core` schema with no caller anywhere**;
it was left in place rather than dropped, because dropping it needs a migration and it is
harmless while unreferenced. If you reach for it, don't — use `app.norm_phone`.

The trap worth internalising: `normalise_ng_phone` returning the raw string for short input
means `IS NOT NULL` does **not** mean "is a phone number", and a well-formed number is not
evidence of identity either — `08012345678` is held by **4,113 distinct CIFs** and
`08000000000` by 2,234. Any identity match on a phone needs *both* a shape check and a
uniqueness check at the person level. See `rescanCustomerLeads` in `sales_leads.go` for the
shape of it.

**And "one person" is not "one party" — two more corrections that only appeared on re-asking.**
The first pass at that guard counted distinct `party_id`, which was wrong twice, and both errors
are instructive:

- **`app.parties.party_type` separates `person` (21,406) from `organization` (236),** and a sole
  proprietor's personal and business records share a phone. Five flagged leads resolved to
  exactly that, and lowest-CIF picked the **company** every time — lead 11960 `ODIBO AMOS` was
  attributed to *Bryams Limited*, 8742 `ADESOLA ADESANYA` to *A Global Enterprise*. The lead's
  own name is the person in every case, which is what made it a correction rather than a guess;
  migration 318 repointed them. So the earlier note that these were "two different people
  sharing a number, not knowable from the phone" was **wrong** — it was knowable, and there are
  **zero** genuine person-versus-person collisions among the 166 flagged leads.
- **Only a row that could BE the answer gets a vote: `cif IS NOT NULL`.** The 271 `udara_cbs`
  customer rows carry no CIF and store the phone as `234…`, which `normalise_ng_phone` maps onto
  the same key. Each was the *same human* under a second `party_id`, so counting them vetoed
  matches that were never ambiguous — and because they have no CIF, `min(cif)` returned NULL, so
  8 leads were flagged `already_customer = true` carrying no identity at all.

The general lesson, and it is the §1 pattern again from the other direction: it is not enough to
ask "is this unique?" — you have to ask "unique *in what*, and can every candidate even be the
answer?" A count over the wrong grain looks exactly like a count over the right one.

**`app.calls_on_shared_numbers` inlines `norm_phone`'s body and has no blank guard — and is
read by nothing.** It computes `people_on_this_number` with `right(regexp_replace(…),10)`
written out longhand instead of calling `app.norm_phone`, and without the `length(…) = 10`
guard from §3, so on the 44 calls with a blank or short phone it compares `'' = ''` and counts
strangers. Its maximum reported figure is 4,855 people on one number, which is the
`08012345678` placeholder rather than a finding. Left as-is because **no Go or TypeScript file
references it** — fixing it would cost a migration and a deploy for zero current readers. If
you ever surface it on a screen, make it call `app.norm_phone` and add the length guard first.

**`app.contact_suppressions` is empty.** `ccNotOnDNCExpr` now delegates to `app.is_suppressed`,
so the dialler, the SMS/WhatsApp sender and dunning share one definition of "must not contact".
Behaviour is unchanged today only because nothing in Go writes that table — the moment
something does, that unification is what stops the dialler ringing someone dunning has
suppressed.

**Retention is unblocked but idle.** All seven win-back dispositions are reachable and are the
only churn-reason capture in the schema (of 6,539 churned customers we can explain 347). But
`call_center_contacts` has **0 pending retention rows** — nobody has loaded a win-back
campaign. Business action, not a bug.

**55 recovery cases, ₦638,599,606.56, with no `account_cif` and no `party_id`.**
Spreadsheet-loaded; `cif_number` holds account numbers slash-concatenated
(`2114-9465-7407/1914-9541-5883`) and two customer names in one field. Nothing joins to them.
`openRecoveryCase` now refuses to create a 56th; the existing 55 were with another session as
at 2026-09-29 and need a data decision, not code.

### Business Development is built, wired, and has never been used

Do not "fix" the BD pipeline for being empty, and do not build into it. Verified 2026-09-30:

| Table | Rows |
|---|---|
| `employers` | 0 |
| `employer_staff` | 0 |
| `bd_leads` | 0 |
| `bd_assignments` | 0 |
| `bd_assignment_staff` | 0 |
| `bd_activities` | 0 |

Every part of it exists and is correctly connected: `handlers/business_dev.go` defines 18 routes
and **is** mounted (`main.go`, `RegisterBusinessDev`), five pages are lazy-loaded in `App.tsx`,
and the sidebar carries six BD entries. Nothing is broken. There is simply no BD data of any
kind, and no BD staff — the whole function sits inside the "Sales & BD" department under
`sales_head` / `sales_officer`. Exactly one person holds a BD role at all: **Doris Nnakwe**
(`cmo`, with `bd_head` in `extra_roles`).

This is NOT the same situation Sales was in, and conflating them wastes a day. Sales looked
empty because 185 real leads were hidden by a missing `sales_entered_at` gate and an absent
owner scope — the data was there. BD has no data. There is nothing to reveal.

Two specifics worth knowing before anyone starts:

- **BD does not live in `crm_contacts`.** It has its own `bd_leads` table with its own shape
  (`company_name`, `employer_id`, `potential_value_kobo`, `expected_close_date`, `lead_score`).
  `crm_contacts.lead_source` holds only `call_centre` and NULL — `business_dev` has never been a
  value in it, so a predicate looking for it there is searching the wrong table, not finding
  zero rows.
- **Two of the five pages are invisible to everybody.** `Sidebar.tsx` gates `/bd/my-dashboard`
  on `vis: ['bd_officer']` and `/bd/assignments` on `vis: ['bd_officer','bd_head']`, and there
  are **zero** `bd_officer` accounts. This is the same defect that hid the Sales supervisor page
  (a screen gated behind a role nobody holds). It is deliberately left alone: correcting the
  gate would surface empty screens to people who have not asked for them. Fix it at the point
  someone is actually made a BD officer, and fix it then in the same three places page access
  is decided — `Sidebar.tsx`, `core/auth.go buildRolePages()`, and `hooks/useAuth.ts`.

---

## 9. "Is Udara realtime?" — no, and the limit is not our poller

Asked 2026-09-30. There are two different clocks here, and conflating them is how someone reads a
quiet week as "nobody paid".

| What | Cadence | Where |
|---|---|---|
| Loans, FDs, customers (the book) | polled every **3 minutes** (`CBS_SYNC_INTERVAL=3m`) | `cbssync/sync.go` |
| Repayments — money actually received | captured **hourly**, re-walking a **120-day** window | `cbssync/repayments.go` |

Udara's API is **GET-only with no webhooks**, so all of it is polling. "Live" on the Core Banking
page means "synced minutes ago", never pushed.

**The payment lag is Udara's, not ours.** A posting does not appear in the call-over report on its
value date. Across all 52 legs captured so far, the gap between value date and our capture averages
**12 days** and the worst is **38** — and none of that is backfill artefact: every leg came from
the hourly job. So the newest rows on any repayment screen are always incomplete, and the most
recent week keeps filling in for a month afterwards. The register at `/core-banking` →
**Repayments Received** prints the median lag on screen for exactly this reason.

**Why the window went 45 → 120 days.** A 38-day observed worst case left only 7 days of headroom,
and a posting published past the window is missed **permanently and silently**: `guardLegCount`
only fires when the window returns *fewer* legs than are already stored, so a leg that never enters
the window at all is invisible to it. The cost is pages, not risk — `walkWindow` stops as soon as a
page falls entirely past the cutoff, and the ceiling is 30,000 rows against a ledger about a fifth
of that.

**What is NOT worth worrying about:** `cbs_sync_runs` carries `interrupted` rows ("Process
restarted while this run was in flight") and occasional `error` rows reading
`/api/FixedDepositAccount/v1/Search: context deadline exceeded`. The first are deploys restarting
the service mid-sync; the second is Udara's own FD endpoint timing out. Both self-heal on the next
3-minute tick — 48,303 runs have succeeded against 1,125 errors.

**Read repaid off the ledger, never off a balance.** `loan_amount - outstanding_principal` counts a
write-off or restructure as a payment and an interest-only payment as nothing; measured, one
facility showed NGN 44,443,556 "paid" against NGN 888 actually posted. And the join key is
`cbs_loan_account` — these rows carry no `application_id` and no `loan_id`, so a reader joining on
either returns zero for them **without erroring**. Eight handlers do join that way and are right
to: they are scoped to workspace-originated applications, and a Udara facility is not one.

---

## 10. "In legal" now has one definition, and it is a function

`app.is_in_legal(legal_stage, status)` — migration 322. Call it; never inline the rule.

`recovery_cases.legal_stage` runs recovery → legal → court → judgment, and **`recovery` is the
PRE-legal stage**: ordinary chasing, no lawyer. Three readers tested `legal_stage IS NOT NULL`
instead, which answers a different question and is true for cases explicitly not in legal:

| Reader | Test | Reported |
|---|---|---|
| `recovery.go` `accounts_in_legal` | `legal_stage IS NOT NULL` | 526 cases, ₦1,466,169,599 |
| `recovery.go` `legal-kpis` CTE | same | 526 |
| `recovery.go` legal tracker list | same, no status filter | 526 rows **listed as live legal matters** |
| `executive.go` legal funnel | `+ status IN ('active','legal')` | 420, ₦1,213,527,192 |
| **`app.is_in_legal`** | past `recovery`, not closed | **275, ₦873,666,833** |

Overstated by **251 cases and ₦592,502,766** — 145 sitting at the pre-legal milestone and 106
closed. The clinching evidence is that **no Go code has ever written `'recovery'`**: the only
writer sets `legal_stage` together with `status='legal'`, so the application's own write path
already treats a stage as meaning "a proceeding was filed". The 251 came from an import.

The Executive funnel is deliberately left alone: it groups BY stage and prints the stage on each
row, so a `recovery` bucket there states a fact. **A breakdown that names each stage may show all
stages; a single number labelled "in legal" may not.**

And the Legal Tracker's own filter was decoration. `MILESTONE_COLORS`/`MILESTONE_ORDER` in
`Legal.tsx` held a **seventh** vocabulary for this column — `Demand Letter`, `Pre-Litigation`,
`Hearing`… — matching nothing the database has ever stored. Every pill fell through to the grey
default and every filter option showed count 0 and returned nothing when clicked. Now keyed on the
four stored values with display labels, so `FilterOption.value` is the stored stage and `.label` is
what the user reads.

---

## 11. Card balances on Customer 360, and the sign that flips meaning

`c360Profile` publishes `card_balances` (per card) and `card_balance_summary`, from
`app.card_balances`.

It already published `card_position`/`card_accounts` and **nothing rendered either** — same shape
as the Udara repayments. But do not just surface those: they read `card_cycle_data`, a monthly
**billing cycle** import restricted to `category='credit'` — 4,841 customers, cycle up to a
fortnight old. `app.card_balances` is the canonical source (never `SUM(current_dr_balance)` by
hand), covers **21,126** customers across prepaid, credit and blink, and is current to today.

**The sign is the trap.** Everything derives from `current_dr_balance`, a **debit** balance:

- `receivable_kobo` = `max(dr, 0)` — what the customer **owes**
- `float_kobo` = `max(-dr, 0)` — the customer's **own money** we hold

Prepaid runs net **−₦178m** across 13,516 open cards precisely because that is customer funds.
Render `net_dr` as "balance" and a prepaid customer's savings appear as a debt, so owed and held
are published separately and the UI picks by `family`. Utilisation is shown **uncapped**: one live
card sits at **4,709%** (₦61.2m owed on a ₦1.3m limit), and clamping to 100% would hide exactly
the cards worth looking at.

`app.card_balances` carries **no test-card filter** of its own — verified against the view
definition — so the C360 queries apply `core.SQLIsNotTestCardName` themselves.

---

## 12. The 78 unreachable recovery cases — and a correction about them

78 rows had `account_cif` NULL **and** `party_id` NULL, worth ₦946,994,206: unreachable from
Customer 360, the delinquency book, the party layer, everything.

**First, the correction, because it is this codebase's signature mistake and I made it.** These
were reported as "55 cases, ₦638,599,606.56 — now 78, so it is still growing". **They are not
growing.** The newest is from 2026-08-24 16:40:48 and nothing has inserted into `recovery_cases`
since 2026-09-12. `status <> 'closed'` over these same rows returns 55 and ₦638,599,606.56 **to the
kobo** — the 55 figure is the hardcoded comment at `collections_ops.go:1116` counting the non-closed
subset. A filtered count was compared against a total and the difference read as growth. Check the
predicate before believing a trend.

**Where they came from:** two ad-hoc SQL runs on 2026-08-24, one transaction, `data_source='manual'`
— 24 Country Hill legal rows whose `cif_number` holds spreadsheet ROW NUMBERS (`CH#1`…`CH#32`), and
54 loan rows holding raw sheet text including `NO MANDATE` and `IAGREE`. **No Go code can produce
them**: all three INSERT sites leave `data_source` at its `'core'` default.

**migration 324 reunited 52** (₦835,805,723.80) with their party. The same loan book was re-loaded
*correctly* on 2026-09-07 into `collection_assignments` with `party_id` resolved, so matching on the
normalised customer name gives exactly one party and one key for 52, zero ambiguous. The other
**26 are deliberately left unidentified** — 24 Country Hill defendants whose only identifying text
is a court note, where trigram similarity offers candidates. Name similarity is a guess, and the
rule from migration 318 holds: do not invent an identity.

**Two guards, because a Go guard could not have stopped this.** `requireRecoveryCaseKey` is now the
single copy of the rule and `collectionsOpsSendToRecovery` calls it — that handler had its own
inline INSERT and inherited neither guard, while `openRecoveryCase`'s comment claimed *"All six
funnel through THIS helper"*. It did not. The comment is corrected and the duplicate check added
there too. But these 78 came from hand-run SQL, which no Go guard intercepts, so 324 also adds
`recovery_cases_has_identity_chk` — **`NOT VALID`** on purpose, since 26 rows cannot satisfy it
without guessing. `VALIDATE CONSTRAINT` once they are resolved; until then its failure *is* the
outstanding work.

---

## 13. One word for one thing, fixed while it was still free

Migration 326 + `handlers/contact_vocab.go` + `lib/contactVocab.ts`.

`recovery_field_visits` and `collection_contacts` held **0 rows** while their screens were built
and mounted, so three vocabularies were queued up to start writing to two columns:

| Endpoint / column | Screen | Sent |
|---|---|---|
| visit `visit_type` | recovery/Cases, recovery/CaseDetail | `Physical Visit` `Phone Call` `Legal Notice` … |
| visit `visit_type` | recovery-ops/Agent | `field` `phone` `letter` `legal` |
| contact `contact_type` | collections/AccountDetail | `phone` `sms` `whatsapp` `email` `field_visit` |
| contact `contact_type` | collections-ops/AgentDashboard | `call` `sms` `email` `visit` |
| contact `contact_type` | collections/Queue | hardcoded `call` |

None of those values is *wrong*, which is why nothing flagged it. But two screens calling one
physical act `Physical Visit` and `field` would have put two rows per real category into every
`GROUP BY`, permanently and invisibly. **Empty tables are the cheapest possible moment to settle a
vocabulary** — no migration, no restatement, and the CHECK constraints validate for free.

Stored codes, displayed labels, as for `legal_stage` and `customerSteps`. `paid` and
`promised_to_pay` stay distinct because money received and money promised are different events,
and only one of the three screens could previously tell them apart. Watch for stale defaults when
doing this: `useState('call')`, `useState('reached')` and `useState('Physical Visit')` were all
initial values that the new CHECK would have rejected on first submit.

**`collection_contacts.outcome` is deliberately left unconstrained**, and this is the open
question, not an oversight. Two screens put two different *kinds* of fact in it:
collections/AccountDetail sends a reachability outcome (`answered`, `no_answer`, …), while
collections/Queue sends a **call disposition** — one of ~45 strings from the shared list
(`Promise to Pay`, `Issue Resolved`, `Other — Describe What Happened`) enforced elsewhere as
`ccDispositions`. Constrain to reachability and the disposition is lost; constrain to dispositions
and an SMS has no outcome to give. The honest model is probably a second `disposition` column —
still free, while the table is empty — but **which fact collections wants to measure is a business
decision**, so it is written down rather than settled by whoever edits last.

## 14. The three open decisions, settled (2026-10-05)

§12 and §13 each ended with a question for the business. All three are now answered and shipped
in commit `2401811` (migrations 329–331).

### 14.1 A court case is known by the defendant, not a CIF it never had

§12 left 26 recovery cases with no `account_cif` and no `party_id`, and called them
unresolvable. **Half of that was wrong.** The names were never missing — they were in
`legal_proceedings.notes` the whole time, as `03 CAPITAL .V. DANLADI JIYA AND CRUSH CAFÉ LTD` —
while `customer_name` sat blank, so the Legal Tracker showed an **empty name against
₦23,996,690.04**. Migration 329 backfills all 24 from the court record.

What stays true is that **no `party_id` can be assigned.** Four attempts, every one a guess:

| Match | Result |
|---|---|
| Exact token-set vs `app.parties` | 1 of 24 |
| vs `app.customers` (the CIF namespace, where card customers live) | 1 of 24 |
| vs `accounts.name_on_card` | 1 of 24 |
| Loose two-token overlap vs `app.customers` | 14 matched **nothing**; the other 10 matched 1–5 candidates |

`OKE STEPHEN` (cases 2170, 2185) settles it: `app.parties` holds **two distinct parties with
exactly that name** plus a `STEPHEN OKE`, and the account number `0928650/1674/0020347869`
appears in no other table — not `cbs_links`, not `collection_assignments`, not
`loan_repayments`. Picking one attaches a debt to someone who may not owe it.

**So the definition of identity widened rather than being invented.** A named defendant plus the
solicitor holding the court file *is* reachable; `CH#6` is not, and the predicate still rejects
exactly that:

```sql
   COALESCE(btrim(account_cif),'') <> ''        -- by CIF
OR party_id IS NOT NULL                          -- by party
OR (COALESCE(btrim(customer_name),'') <> ''      -- by name, held by a solicitor
    AND (COALESCE(btrim(solicitor),'') <> ''     --   or tied to an account
      OR COALESCE(btrim(account_number),'') <> ''))
```

`recovery_cases_has_identity_chk` is now **VALIDATED** (`convalidated = t`), so it is enforced
against history for the first time rather than only guarding new rows. 0 rows fail it.

> **A trap worth knowing before your next backfill.** The first run of migration 329 failed, and
> it taught me something the `NOT VALID` convention in §5 does not spell out: a `NOT VALID`
> constraint still guards every row that is **UPDATEd**, not only inserted — it merely skips rows
> already sitting in the table. Setting `customer_name` on a case with no CIF and no `party_id`
> re-presents that row to the old predicate, which rejects it. **The `DROP CONSTRAINT` has to come
> before the backfill.** The migration is one transaction, so the failed attempt changed nothing.

### 14.2 "loan repayment" was never a channel — these were bank transfers

§13 left 90 rows / **₦878,726,235.37** (95% of the recovery payment book) under `Unspecified`,
because migration 321 would not guess. The answer: it is not a channel, it is what the money was
*for*; the channel was bank transfer, and no channel was captured because the rows were
**uploaded** rather than keyed by an officer.

The single `recovery` row goes the same way — same day, same poster, `payment_method` NULL on all
90, so it is one upload and the same kind of mislabel. `channel_raw` keeps every original
verbatim, so the fact that this is a **business decision taken on 2026-10-05** stays auditable.

Recovery payments now read: Bank Transfer 198 / ₦911,237,941.46 · Remita 41 / ₦2,418,277.06 ·
Direct Debit 25 / ₦1,623,952.40 · Legal Settlement 5 / ₦5,943,111.00. Table total
`92122328192` kobo, **unchanged** — measured, not typed, because migration 321 caught two
hand-added totals.

`Unspecified` stays in the vocabulary. It is right for a future payment whose channel genuinely
is not known; it was only wrong as a resting place for these 90.

### 14.3 Reachability and result are two facts, so two columns

`collection_contacts.outcome` was taking both, from two screens, in two vocabularies — the open
question at the end of §13. **Two separate defects, not one:**

- `not_reachable` and `Unreachable / No Answer` are **one fact in two spellings**, which would
  have split every `GROUP BY` on the column in half, for ever and invisibly.
- `answered` and `Promise to Pay` are **two different facts**. A customer who answered *and*
  promised to pay could only ever be recorded as one of them.

I checked the cheaper option first — drop the disposition, since the call log surely has it. **It
does not:** `Queue.tsx` posts to `/api/collections-ops/{id}/contact`, not the call-log endpoint,
and says so in its own comment. That disposition exists nowhere else.

Migration 331 adds `disposition`, relaxes `outcome` to nullable, and adds **4 validated CHECKs**,
one of them requiring at least one of the two — a contact recording neither fact is not a
contact. Done while the table still held **0 rows**, the same reason migration 326 was worth
doing when it was.

`collectionContactDispositions()` **derives** from `ccDispositionsForPurpose("collections")`
rather than being a sixteenth hand-typed copy: 15 codes, a clean superset of the screen's 12.
`collection_contact_vocabulary_test.go` asserts Go, TypeScript and the CHECK constraints all
agree, so none of the three can move alone again.

Two labels changed wording to match what the call-centre screen shows for the same outcome
(`Callback Requested`, `No Answer`). **Now that the database stores a code, reverting that wording
costs nothing** — which was never true while the label itself was the stored value.

### 14.4 A correction: there was no 201,000-row problem

**What this section said before was wrong, and the wrong version is worth keeping visible.** It
claimed `app.helpdesk_calls.disposition` held "201,000+ rows of the LABEL form" against
`call_center_contacts.disposition_code`'s codes, and called it "the same defect at real scale."
Migration 331's own header says the same thing. Both were written from reading two column names
and inferring a conflict, without checking how the column is actually fed.

What is actually true:

- **That table stores labels by design, and consistently** — 40,896 label-form rows against 2 in
  code form, with label-form rows still arriving (5,570 in the last seven days). Migration 145's
  own column comment says it outright: `disposition_code` holds the code, `last_disposition`
  holds the label.
- **`ccDispositionCode` is the normaliser for exactly this**, and it already resolves every one
  of the five screen labels that has no matching Go label — `Unreachable / No Answer`,
  `Not Interested`, `Callback Scheduled`, `Interested`, `Issue Resolved` — with
  `TestSimilarLabelsDoNotCaptureEachOther` pinning the substring order.
- **`hdLogCall` routes through it** before `ccDispositionByCode`, so the historical silent
  failure (a disposition resolving to nothing, so no close, no DNC, no callback, HTTP 201) is
  already fixed. The comment at `call_center_dispositions.go:146` describes that bug and its fix.

So the real finding was **four rows**, not 201,000: the same outcome stored under two spellings,
which splits a `GROUP BY` on the raw column. Migration 334 normalised them —
`Resolved` to `Issue Resolved` (2), `interested` to `Interested` (1), `wrong_number` to
`Wrong Number` (1). The bare `Resolved` pair mattered slightly more than its count:
`isRawCallOutcome` treats "resolved" as a raw telephony outcome, so today's code **blanks or
422-rejects** that value. Those two rows held something the current code would refuse to write.

### 14.5 What the audit found instead — an unverified payment marking a lead converted

Mapping the disposition consumers properly turned up a real defect, and not where I was looking.

`leadStatusFromCall` (`call_center_outbound.go`) is a **second, independent** substring matcher
alongside `ccDispositionCode`, and it was missing a guard the other one has:

```go
case strings.Contains(d, "paid"):
    return "converted"        // "Says They Have Paid — To Verify" CONTAINS "paid"
```

`ccDispositionCode` tests `"to verify"` **before** its generic `paid` case, with the reason
written beside it: *"treating it as Paid would close a contact on an unverified claim."*
`leadStatusFromCall` had no such test, so `Says They Have Paid — To Verify` set the lead to
**`converted`** — a terminal, positive status (rank 5) that nothing later can move — on the
customer's word alone, while `ccApplyDisposition` correctly left the contact open for someone
to check.

**It had not fired yet.** Zero calls carry that disposition and zero converted leads carry a
paid-ish one, measured 2026-10-05. But the option is live on the collections disposition list,
so it was one click from happening, and the effect is unrecoverable. It now returns `callback`
— it needs a follow-up call, the same as a promise or a dispute — pinned by three cases in
`TestLeadStatusFromCall`.

### 14.6 Employment type was deciding which scoring model ran

Two forms held two lists for `app.loan_applications.employment_type`, neither validated. The
name clash (`permanent` vs `salaried`) was the cosmetic half. The expensive half was that
`phoenixSubmitOne` forwarded the value **raw** to Phoenix, whose `resolveEmploymentType` accepts
exactly four words — `employed`, `self_employed`, `business_owner`, `unemployed` — and we send no
`borrower_category` for it to fall back on. Everything else arrived as `not_specified`, and the
scorer picks an income-variance threshold by that word:

| word sent | variance threshold |
|---|---|
| `employed` | **0.15** — "salaried, very predictable" |
| `self_employed` | 0.25 |
| `business_owner` | 0.30 |
| `contract` | 0.25 |
| unknown | 0.20 |

So every salaried borrower submitted as `salaried` or `permanent` was scored at the 0.20 unknown
default instead of 0.15 — their income judged less predictable than the model intends, on the
commonest borrower type in the book. `phoenixProductName` already existed for precisely this kind
of boundary translation; `employment_type` simply never got one.

`phoenixEmploymentType` now translates at the wire while the database keeps our own word, so
`contract` and `retired` stay available for our reporting even though Phoenix cannot score them
separately. `contract` is deliberately **not** mapped to `employed`: the scorer rates a contractor
at 0.25, looser than employed's 0.15, so claiming `employed` would score them as more predictable
than the model believes — wrong in the risky direction. Passed through it lands on 0.20, nearer
the intended 0.25. The honest fix is for Phoenix to accept `contract`, which its own scorer
already has a threshold for; that is a Phoenix-side change.

`business_owner` is newly expressible — Phoenix scores it differently from a self-employed trader,
and until now every one of them went across as `self_employed`.

### 14.7 A template filed where nothing reads it

`createTemplate` validated `category`; `updateTemplate` built its `SET` clause straight from
`templateUpdateCols` — which includes `category` — and validated **nothing**. The same rule on one
of two write paths, again.

It is not cosmetic: `collections_dunning.go` selects `WHERE category = 'collections'` and reports
"no collections template configured" when it finds none. A template re-categorised by an edit
stops being sent to delinquent customers, and the only symptom is a worker heartbeat saying idle.
`updateTemplate` now returns 422, and migration 333's CHECK means neither path can drift again.

My earlier note called this "three conflicting category lists". That was wrong — the Go whitelist
and both screens already agreed on the same five values. Checking it was the fix for the claim,
not for the code.

### 14.8 The four that were open, and what closing them actually found

All four items this section used to list are now fixed. Each one was smaller or differently
shaped than I had written it, and two of the four write-ups were wrong about the mechanism —
worth keeping visible, because the pattern is the same one §14.4 records: a defect inferred
from one code path without looking for the second.

**1. The do-not-call gap was real, and keyed on the wrong thing.**

I wrote that a `Do Not Call` "logged outside the Outbound Queue never reaches `dnc_list`".
Wrong: there were *two* writers, not one, each keyed on a different id.

| Writer | Keyed on | Covered |
|---|---|---|
| `ccApplyDisposition` | `contact_id` | the Outbound Queue |
| `syncLeadFromCall` | `lead_id` | Leads, and a lead-sourced callback |

So Leads *was* covered, which my note denied. `syncLeadFromCall` even states the principle
the rest of the code did not follow: *"that obligation does not depend on which screen
logged the call."* What actually fell through was a call carrying **neither** id — Helpdesk
Calls, My Dashboard, Inbound, a non-lead callback reminder — where "Do Not Call" was written
onto the call row and suppressed nothing. The Collections queue missed it a third way: it
posts to `collectionsOpsContact`, which had no DNC handling at all, while its disposition
list derives from the same catalogue where `do_not_call` carries `AddToDNC: true`.

The fix is `ccEnsureDNC` (`dnc_write.go`): one writer, keyed on the **phone**, which every
one of those paths has. `dnc_list` is a list of numbers — the id was never the right key,
it was just the key each path happened to be holding. It is idempotent, so the lead and
contact paths calling it too cost one no-op statement and stay correct on their own. The
collections path logs a credit event when the number on file is unusable, rather than
returning a clean 201 on a suppression that did not happen. The admin endpoint is
deliberately *not* merged in: it uses `DO UPDATE` and answers 422 on a bad number, because
a person typing into a form should be told, where a disposition's side-effect cannot be.

**2. The lead/contact disagreement was nine dispositions, not eight.**

`leadStatusFromCall` is answered from `ccLeadStatusByDisposition` (`lead_status_vocab.go`)
after one pass through `ccDispositionCode`. The substring switch stays as the fallback for
free text that predates the catalogue. The table is read off each entry's own Hint:
"stays in the queue" / "stays open until…" means the lead must not be terminal;
"closes the contact" means it may be.

The nine that used to collapse into a bare `called`: `info_sent`, `call_rejected`,
`registration_incomplete`, `not_yet_due`, `escalated`, `complaint_logged`,
`pending_followup` → non-terminal; `wrong_product`, `info_provided` → `closed`.

**`price_objection` was deliberately left at `called`**, which is the one place I changed my
mind while writing it. Closing the contact but keeping the lead workable is the established
precedent, not an oversight: "Answered — Not Interested" has always worked that way and
`leadDeclinedOnCall` exists to handle the consequence. "Rate or Charges Too High" is the
same kind of fact — the customer saying no, for a reason that can change — and making it
terminal would have permanently closed leads that may buy next quarter. Terminal is
unrecoverable (rank 5, forward-only), which is the same property that made the
`payment_to_verify` bug in §14.5 worth fixing; it is not a knob to turn casually in the
other direction. `TestLeadStatusMatchesContactStatus` pins the invariant that *does* hold:
a disposition leaving the contact open must never give the lead a terminal status.

Note for whoever picks this up: another session converged on the same design independently
and spotted something this write-up had wrong — `ccDispositionCode`'s legacy-label lookup is
**case-sensitive**, so it must be handed the original casing, not a lowercased string. Their
version is what is in the tree.

**3. The deny-lists are allow-lists, and derived.**

`dispositionExpectsConversation` used to end on `return true, true`: anything it had not
been told about meant "a human spoke". That default is what let "Customer Rejected the Call"
pull write-ups off zero-second rejected calls onto answered ones — caused by the
fall-through, not by a decision. It now reads `ccDisposition.Connected`, the field whose
entire job is that fact, and answers `known=false` for wording it cannot place. Every caller
already treats `known=false` as "no preference", so the unknown case got *safer*, not
weaker.

The SQL twins are generated from the same source (`disposition_connect_vocab.go`), and
`sqlDispositionFitsCall` now names its "yes" branch with `sqlConversationDispositions()`
instead of reaching it through `ELSE connected`. `TestSQLDispositionListsAreExhaustive`
asserts every catalogue code and label sits in exactly one of the three lists, so the ELSE
is reachable only by genuinely unrecognised text.

One thing the new test caught immediately, which is the best argument for having written it:
`other` carries `Connected: true`, so SQL called it a conversation while Go called it
unknown. Its whole meaning is "I cannot tell you from the dropdown" and the note behind it
may equally say the line was engaged — so it is now declared as no evidence in both readers,
via one map.

**4. `repayment_reminder` is not dead, and my note said it was.**

I wrote it as "a valid template category the dunning worker never reads", implying nothing
could use it. In fact a campaign journey picks templates **by id** (`campaign_steps.go`), so
category is only a label there — and its three starter templates are genuine *pre-due*
reminders ("your repayment is due on {{due_date}}"), properly distinct from an arrears
demand. It is un-automated, not dead, which is a different thing.

The real hazard is the reverse of what I wrote: `collections` is the only category that is
also a **switch**. `collections_dunning.go` selects `WHERE category = 'collections'` and,
finding nothing, reports "no collections template configured" through a worker heartbeat —
no error, no alert, no bounce. And "Repayment Reminder" is the obvious-looking place to file
arrears copy. So:

- `templateCategoryAutomation` records which categories a worker reads and what stops.
- `updateTemplate` and `deleteTemplate` both refuse with 409 when the change would leave an
  automated category empty, naming what would stop. The same guard on both routes, because
  a rule on one of two routes is not a rule — which is how this item started.
- The editor labels them at the point of choice: "Collections — Sent Automatically" and
  "Repayment Reminder — Campaigns Only".
- `TestDunningReadsAnAutomatedCategory` reads the worker's source, so moving the query's
  category without declaring it fails loudly.

### 14.9 The last two code items, and a decision that is not mine

**`leadDeclinedOnCall` reads codes now, and that closed an asymmetry I had not spotted.**

The function is the ONE thing allowed to overturn an earned `interested`, and it was the
last reader in this group still matching substrings. Its own comment said it lowercased the
input and swapped underscores for spaces so that *"the CODE and the LABEL are matched by
the same words"*. That held for two of the three declining dispositions and failed for the
third:

```
winback_declined              → "winback declined"            → NO MATCH
"Not Interested in Returning" → the same disposition, as a label → MATCHES
```

So whether a customer's refusal to come back could un-qualify their lead depended on which
form the screen sent — and the function's own comment notes that callers differ, the
outbound queue passing the label while the call-log endpoints pass whatever the client sent.
Latent when found: measured 2026-10-06, **zero calls and zero leads carry any winback
disposition in either form**, so nothing had been mis-handled. Same shape as the
`payment_to_verify` bug in §14.5 — a real defect that had not fired yet.

It now reads `ccDecliningDispositionCodes` after one pass through `ccDispositionCode`.
`price_objection` is still deliberately absent: see the open item below.

**The dunning fallback was wrong in its DIRECTION, not in existing — and I nearly broke
something real by not checking.**

My first attempt made `dunningTemplateFor` refuse when no template names the facility's
band, so the caller would skip it. Then I found `TestDunningTemplateForFallsBackToFirst`,
which already asserted the opposite, with the reason written in it:

> `// 31-60 has no template of its own: it must still be written to, not skipped.`

That is a deliberate decision and it is the right one — a band with no wording of its own is
a gap in the template set, not a reason to leave a delinquent borrower uncontacted. Skipping
would have silently stopped contacting people in order to fix a cosmetic routing fault. This
is the second time in two days the lesson has been the same one: **check whether an
inconsistency is a documented decision before "fixing" it.**

What was genuinely wrong is that the fallback was `rows[0]`. Ordering by id is ordering by
the accident of when someone created a row — it bore no relationship to severity at all. On
2026-10-06 `rows[0]` was id 7, *"Arrears Reminder · 1-30 Days"*, the **softest of the six**.
Because bands are matched by NAME, renaming the 360+ template sent the 401 facilities over a
year overdue the 1-30 Days courtesy wording. No error, heartbeat ok, letter wrong in the
lenient direction by five bands.

`dunningTemplateFor` now walks DOWN `dunningBandOrder` and takes the firmest wording at or
below the facility's own band. A 360+ facility whose template was renamed gets 181-360 — the
next-harshest — instead of the gentlest. Leniency remains the direction of any error, which
is right for a demand for money, but it is now **one step of leniency rather than up to
five**. The second return value says whether the band matched exactly, and the worker counts
every substitution and names the bands in its heartbeat detail, so a renamed template shows
up as a number someone can read.

Status stays `ok` when substituting. A worker that reads `error` while doing exactly what it
was told to do is a worker people stop reading.

### 14.9b A regression I shipped, and the test that let it through

Worth more than the fixes above, because the fix was the thing that broke it.

Converting `sqlDispositionFitsCall` to an allow-list, I built the three SQL lists from
catalogue **codes and labels** and changed the `ELSE` from `connected` to `TRUE`. The Call
Log form's own wording is in the catalogue in neither form, so it fell straight through to
that `ELSE`. Measured in `app.helpdesk_calls` on 2026-10-06:

| stored wording | rows | rank in the table |
|---|---|---|
| `not interested` | 3,768 | 2nd most common |
| `interested` | 696 | 6th |
| `issue resolved` | 11 | — |

All three still arriving that day. "Not Interested" and "Interested" are conclusions you can
only reach by speaking to someone, so requiring a connect was **correct**; `ELSE TRUE`
stopped the absorb query distinguishing them from a no-answer, for 4,475 rows of write-up
attachment. `ccDispositionCode` has always normalised these — that is the §14.4 finding — so
**Go was right the whole time and only the SQL lost the fact.**

**My own test passed, and that is the real lesson.**
`TestSQLDispositionListsAreExhaustive` walked the catalogue, which is the same mistake the
bug was: the catalogue is not the set of things in the column. A test that derives its
inputs from the same place the code does cannot catch the code looking in the wrong place.

Fixed by construction rather than by patching the lists. `ccClassifyWording` is now the one
judgement; the three SQL lists are rendered by running every known wording through it; and
`ccLegacyDispositionWordings` carries the stored forms that are neither code nor label. Go
and SQL can no longer disagree about a wording. Two new tests walk the **column**:
`TestEveryLiveDispositionIsClassified` holds all 25 distinct live values with their row
counts, and `TestTheCallLogFormsOwnWordingIsCovered` pins the three by name.

One deliberate live change survives, and it is the intended half: `other — describe what
happened` (113 rows) moves from requiring a connect to carrying no evidence either way. Its
whole meaning is "I cannot tell you from the dropdown".

**A third do-not-call path.** `hdEditCall` was the one I had not checked. Correcting a call's
disposition to Do Not Call reached `dnc_list` only when the call carried a `lead_id`, or a
phone matching exactly one lead; with neither it suppressed nothing. Now keyed on the phone
before any lead resolution. `customer_phone` had to be added to that handler's SELECT —
without it the first attempt was a **silent no-op**, the exact failure mode being fixed — and
the first insert landed inside the auto-link branch, so it would have fired only when a lead
WAS found, the opposite of the intent. Both caught before shipping, by reading the diff.

### 14.10 Open, and genuinely not mine to close

1. **Phoenix should accept `contract`.** `resolveEmploymentType`
   (`core-api/internal/httpapi/portal_handlers.go`) takes four words; `contract` becomes
   `not_specified` and scores at the 0.20 unknown variance threshold instead of the 0.25 its
   own scorer already has for contractors. **But 0.25 is LOOSER than 0.20** — it tolerates
   more income variance and so approves more contractors. That is a credit-policy decision
   in a different system, not a bug fix. Theoretical today: `app.loan_applications` holds
   8 rows — 7 null, 1 salaried, **zero `contract`**.
2. **Should `price_objection` count as a customer decline?** "Rate or Charges Too High" is
   the customer saying no, so it arguably belongs in `ccDecliningDispositionCodes` — and for
   the same reason it is the one disposition left mapping to `called` rather than `closed` in
   `ccLeadStatusByDisposition`. Both choices follow the "Answered — Not Interested"
   precedent. Adding it changes when an earned `interested` is withdrawn, which moves the
   qualified count and what reaches Sales. A judgement with numbers attached, not a tidy-up.
3. **`COLLECTIONS_DUNNING_SKIP_RECOVERY=off` is closer to a floodgate than a filter** —
   another session's finding, documented in `dunningTemplateCoverage`. Turning it off
   releases roughly 460 borrowers whose cases are already with recovery, some with
   solicitors instructed, into automated demands. Recorded here because it is live risk, not
   because it is mine.
