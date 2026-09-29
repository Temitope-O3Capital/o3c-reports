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
types and call-centre lead statuses are each declared once in Go and once in TypeScript. All
verified in agreement 2026-09-29, and each file's comment names the other as its mirror.
Unifying them needs a **serving endpoint**, not another shared TS constant — a different job,
not a smaller one. Contrast `lib/ticketTypes.ts` and `lib/leadStages.ts`, which were TS-to-TS
duplicates and *were* consolidated, and `customerSteps`, which is served from Go and fetched.

**`handlers/loans.go` — unmounted, and must stay that way.** Its `loanStages` vocabulary shares
exactly **one** value (`submitted`) with the LOS pipeline in `los.go` that actually owns
`loan_applications.stage`, and there is no CHECK on the column. Mounting it would let a PATCH
set a stage `allowedTransitions` cannot advance, `losFlow.ts` renders through its Draft
fallback with no action bar, and `risk.go`'s pending predicate never sees — so the file vanishes
from Risk's inbox while still counting as open.

It was **not** deleted: the file also defines `jsonRows`, used across the package, and deleting
it broke the build in a dozen places. It now carries a header saying so. If you are cleaning
up, move `jsonRows` to a shared file **first**.

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
