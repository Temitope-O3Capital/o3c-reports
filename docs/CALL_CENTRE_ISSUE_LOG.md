# Call Centre — issue log

Every issue raised on 2026-08-18, with what was actually done. Kept so nothing
raised verbally is lost between sessions.

Status: **DONE** = fixed and deployed · **PARTIAL** = improved, gap remains ·
**OPEN** = understood, not yet built.

---

## DONE — deployed and verified

| # | Issue | What it was | Fix |
|---|---|---|---|
| 1 | Call log not realtime | There was no `calls` topic in the change-feed at all. The page only refreshed on a *ticket* change or window focus. | Added the topic (4s poll on `MAX(started_at)`); Call Log, My Dashboard, Leads and Queue subscribe. |
| 2 | Duration wrong | Zoho derives duration as `completedTime − startTime` on the RECORD. For a missed call that is how long the record stayed open (~1s), stored in the column every talk-time figure reads — so **43,025 missed calls showed as one-second conversations**. | `duration_sec` now means talk time only. Nulled for missed/no-answer/voicemail, 0–14400 CHECK, importer no longer writes it for unanswered calls. Voice duration (the real measurement) now corrects the row. |
| 3 | Duration/recording not auto-populated | The form asked agents to type seconds, so nobody did — all 14 manual logs had NULL duration. | `/api/helpdesk/calls/latest` finds the real call and fills it; live start/stop timer as fallback; the source is labelled in the UI. |
| 4 | Leads log-call ≠ Log-a-Call modal | Leads had a private 4-field form on its own endpoint. A lead call captured no CIF, no disposition, no purpose, no ticket. | One `CallLogForm` component. Modal wraps it; Leads renders it inline. Old form and `POST /leads/{id}/disposition` deleted. |
| 5 | "Internal server error" logging a call | Three UI-vs-DB vocabulary mismatches: `purpose='sales'`, `priority='medium'`, and a `ticket_type` enum nothing used. **Every sales call and every call raising a ticket failed.** | Constraints aligned; priority normalised; violations now return 422 naming the field, not a bare 500. Tests pin Go↔SQL. |
| 6 | Upload leads: remove paste | — | Paste box removed; file upload replaces rather than appends and shows the filename. |
| 7 | Lead template had CIF | A CIF is the card book's identity key, issued on conversion — a lead has none. | Template is now `phone,name,email,address`. Phone is the only required field; rows without one are rejected and counted separately. |
| 8 | Phone formatting on upload | Numbers stored in four shapes. | Canonical `0` + last 10 digits, in Go **and** SQL, with a test pinning them equal. |
| 9 | Name not addable when blank | A linked caller with no name rendered dead text "Unknown customer". | Inline name field whenever the name is empty. |
| 10 | Zoho ticket import dropping tickets | Zoho `"escalated"` mapped to a status the column rejects (escalation is a **flag** here, not a status). Failed silently as a WARN, retried forever. | Maps to `in_progress`; status/priority/channel now validated against mirrors of the constraints and fall back rather than dropping. Test reads the constraints from the live DB. |
| 11 | Recordings on the wrong call | Pairing was time-only. Agents redial, so one conversation leaves several rows seconds apart and a 1-second blip could take the slot. | Pairs on **duration first**, time second. Verified against a real 6-dial sequence. |
| 12 | "Missed" shown on outbound calls | "Missed" is about us; an unanswered outbound is **No Answer**. Zoho stores one value for both. | `callOutcomeLabel()` derives the wording from direction. |
| 13 | UI flaky / deleting typed text | `CallLogForm` reseeded whenever `initial` changed *identity* — a new object every parent render. Any background refresh **wiped what the agent was typing**. | Keyed on values, not the object. Plus localStorage draft autosave (per lead, restored on reopen, cleared on submit). |
| 14 | Make the whole app refresh silently | 118 of 130 pages showed skeletons on every background tick. | Codemod across **124 pages**: `load(silent)` → live ticks no longer blank the screen. tsc caught 3 pages passing a click event as the silent flag. |
| 15 | Not Eligible / Not Ready missing | Both were forced into "Not Interested", which **closes** the lead — losing every not-yet lead. | Added to the queue vocabulary, the modal, and the lead-status mapping (`not_eligible` → closed, `not_ready` → callback). |
| 16 | Wrong call getting the write-up | My own matcher: 120-minute window ranked by longest duration. Measured reaching back 21 and 55 minutes, so a second attempt inherited the first's outcome. | 15-minute window, most recent, same agent, and the target must not already carry a write-up. Removed the "last call on any number" fallback, which could put one customer's notes on another's call. |
| 17 | Duplicate rows per conversation | Zoho arrives 35–186s after the call, so agents log **before** the row exists and a standalone row is created. | `absorbPendingManualLog()` folds the manual log into the Zoho call when it lands. Verified working at 13:27. |
| 18 | Names not matched | Zoho only names its own contacts — **8,614 of 9,181 calls arrived anonymous**. | Resolved at import from customers → leads → CRM, inbound and outbound, only ever filling a blank. |
| 19 | Bad name matches (self-caught) | The backfill used `LIMIT 1`, but `08012345678` maps to **4,008 customers** and `07017323707` is two family members. | Resolution now requires exactly one distinct name. Names asserted on numbers with 10+ people cleared. |

---

## PARTIAL / OPEN

| # | Issue | Status |
|---|---|---|
| A | Writing up a call later than the auto-match window got no duration/recording. | **DONE.** `GET /api/helpdesk/calls/candidates` lists the day's un-written-up calls on that number; the form auto-selects only when unambiguous (one connected call, under 15 min old) and otherwise shows a **"Which call is this?"** picker. Selecting adopts that call's duration, direction and recording, and the write-up lands on it. |
| B | Write-ups filed before 13:22 reached the lead but never the call ledger. | **DONE.** Migration 166 reattached 93 of 105 to the connected call closest in time. Runs once by design — an earlier draft was not idempotent and briefly put one write-up on two calls; caught, reverted, and guarded. The remaining 12 had no qualifying call and stay on the lead only. |
| C | Names on numbers shared by 2–9 people (216 numbers). | **PARTIAL.** Left as-is: many are one person under two CIFs, or a household, and blanking would also destroy correct Zoho names. Review via `app.calls_on_shared_numbers`. |
| D | Name coverage is 14%, not higher. | Ceiling is the data — the rest are numbers we hold no record of. |
| E | Zoho category → `ticket_type` is free text. | Currently always NULL for this org, so safe; would break the import if Zoho starts sending categories. |
| F | "Query failed" 500s at a low background rate. | Pre-existing (67 before any of today's work). Cause is stripped by the 500 handler; needs its own pass. |
| G | Three long calls today have no recording. | Recordings pair forward-only; existing attachments are not moved. |
| H | Nothing is committed. | This, the call-centre work and Reports & BI are all uncommitted in the tree. |

## 2026-08-19 — recordings latency, and write-ups on the wrong call (second pass)

**Calls were already realtime; recordings were not.** Measured ingest lag on 447
of today's calls: mean 1 minute, max 7. The Desk rows arrive on the 60-second
fast poll as designed. Recordings did not: `runZohoVoiceSyncCycle` gated the
Voice import on `cap >= 1000`, so it ran only on the hourly deep cycle. Since the
recording is what distinguishes a real conversation from a dial that never
connected — playback, call history, QA and the write-up matcher all read it — a
call spent its first hour looking unanswered. Agents write up their calls inside
that hour. The fast cycle now sweeps a today-only window, gated on
`zohoRecordingsPending` so it makes no API call in the many minutes with nothing
to collect.

**Write-ups on the wrong call: the path was `absorbPendingManualLog`, not the
matcher.** All 65 of today's write-ups sitting on a no-duration call arrived
there via absorb, which folds a manual log into whichever Zoho row syncs first on
that agent+number within ±15 minutes. It had no notion of what the write-up says.

The correction is that **the disposition states which kind of call it describes**:
"Not Interested" is only reachable by speaking to someone; "Unreachable / No
Answer" is only reachable by not speaking to someone. `dispositionExpectsConversation`
encodes this, `sqlDispositionFitsCall` renders it for the absorb query, and
`TestDispositionVocabularyAgrees` keeps the two in step. "Wrong Number" is
deliberately treated as unknown — it is genuinely both.

This also showed **migration 170 (yesterday) was too crude**: it moved any
write-up off a dead dial onto a connected sibling, including 8 "Unreachable / No
Answer" write-ups that were correctly placed, producing recorded calls whose
stated outcome was that nobody answered. Migration 171 reverses those 8.

Of today's 65 absorbed write-ups, **58 were correctly placed** and 7 were not —
the crude "on a dial with no duration" heuristic used yesterday over-counted by
roughly ten to one. Any future repair must classify by disposition, not by the
shape of the call row.

**Not repaired, deliberately:** ~38 historic rows whose disposition contradicts
their call and which have no un-written-up counterpart to move to. There is
nothing to move them to, and rewriting the disposition to fit the call would
invent an outcome no agent chose.

## 2026-08-19 (later) — the lead book was never connected to Sales

The largest gap in the call centre was not in the call centre. There were **two
lead books with nothing between them**: the call centre dials
`app.call_center_leads`; Sales reads `app.crm_contacts.lead_stage`. Only **7 of
246** call-centre leads existed in the CRM book at all, and `lead_stage` held only
`new` (27,869) or `converted` (1,794) — the `contacted` and `qualified` stages the
Sales funnel is built on had **never once been used**, and `crm_lead_events` was
empty.

So an agent could reach a lead, qualify them and book a callback, and Sales would
still see `new`. That is why the Sales pipeline read zero, and why not one lead
has ever reached `converted` in the call-centre book: conversion had nowhere to
land.

Migration 174 gives `call_center_leads` a `contact_id`, creates a CRM contact for
any lead that has actually been worked (an untouched imported number is not a
prospect), and derives the stage from work already done — forward-only, so a
converted contact is never dragged back by a later dial. 203 leads linked, 197
stage moves recorded; the pipeline now shows 139 contacted / 54 qualified / 4
disqualified where it previously showed none.

`syncCRMContactStage` keeps it in step going forward, and `crmLinkLeadToContact`
gives a newly imported lead its CRM place the first time it is worked.

**All 7 numbers that overlapped between the two books matched TWO contacts each**,
so none of them auto-linked — the ambiguity guard working, not failing. A shared
number gets a fresh contact rather than attaching one person's progress to
another's record. Same lesson as CIF-is-not-a-person.

### Not a collapse: the Call Log keeps every row

One conversation still arrives as several rows. The leads panel groups them; the
Call Log deliberately does not, because it is the audit view and collapsing rows
there would hide records a supervisor is there to see — and an episode can
straddle a page boundary, where client-side grouping would group the wrong things.
`hdListCalls` now returns `episode_calls`, counted server-side (0.9ms, on the
phone-10 index), and the row says "one of N attempts".

### 500s that could not be diagnosed

271 "Query failed" and 84 "Lookup failed" 500s over two days, none of which logged
their cause — `respondErr(w, 500, "Query failed")` discards `err`. The call-centre
and helpdesk sites now use `respondErrLog`. 211 such sites remain across other
modules; worth the same treatment.

## 2026-08-19 (close-out) — the open items

**Silent 500s: all 239 sites now log their cause.** `respondErr(w, 500, "Query
failed")` discards `err`, so 271 "Query failed" and 84 "Lookup failed" 500s over
two days said nothing about what actually broke. Every site in `handlers/` now
uses `respondErrLog`. Zero silent sites remain.

**43 unlinked leads: not a defect.** All 43 have never been called. A lead earns
its CRM contact the first time it is worked; an untouched imported number is not
a sales prospect. They link on first call via `crmLinkLeadToContact`.

**Supervisor review had endpoints but no screen.** Flagging 11 contradictory
write-ups and giving nobody a way to see them would have been no better than
leaving them. `CallReviewPanel` shows the flagged logs with the reason stated and
a "Looks right" dismissal, plus every correction and withdrawal with BOTH sides of
each change — so a correction can be read against what it replaced rather than
taken on trust. Supervisors only; renders nothing when both lists are empty.

**CBS: I mischaracterised this as "failing".** It is not — 326 ok against 26
errors over six hours. What was actually wrong: 58 runs stuck in 'running' since
31 July. A run is marked 'running' at the start and closed at the end, so a
process killed in between never closes it, and this server restarts often. Any
"is a sync in flight?" check was permanently answered yes. Marked 'interrupted'
(not 'error' — it was killed, not failed, and conflating the two makes the failure
rate read far worse than it is), and `reconcileStrandedCBSRuns` now runs on every
tick, not just at boot: a run stranded at midday would otherwise sit until the
next restart, which is exactly how 58 accumulated.

Still open there, genuinely: ~13% of CBS runs fail, split between read timeouts on
`FixedDepositAccount/v1/Search` and **auth failures on `Product/v1/SearchProducts`**.
`CBS_SYNC_INTERVAL=1m` with runs taking ~30s is a 50% duty cycle against Udara,
which is worth questioning before tuning timeouts.
