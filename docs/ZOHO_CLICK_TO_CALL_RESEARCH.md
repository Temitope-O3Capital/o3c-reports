# Click-to-Call Through Zoho — Research & Options

**Question:** *"Click Call in the workspace → it goes to Zoho and calls that number instantly and seamlessly → after the call, it comes back to the workspace and logs the call."*

**Short answer:** The **log-the-call-back half is already solved** (Zoho Desk `/calls` sync, ≤60 s; a webhook can make it near-instant). The **place-the-call half is the real work**, and it hinges on one hard architectural fact:

> **Zoho PhoneBridge cannot be told to dial by an outside app.** In PhoneBridge the *click must originate inside a Zoho screen*; Zoho then hands the number to a connected telephony provider, which dials. The only Zoho product that exposes a real "make a call" primitive an app can trigger is **Zoho Voice** — which this org does **not** have. The org's grant is `Desk.calls.ALL` + `PhoneBridge.call.log` (a *logging* scope, not a call-origination scope).

So "click in our app → **Zoho** dials" is only literally true with **Zoho Voice**. Everything else is "click in our app → **a carrier** dials, and Zoho/our-app logs it."

The good news: **the backend is already ~80% built for the Zoho Voice path**, and a full carrier softphone (Telnyx) is already built too — both just aren't wired up.

---

## 1. What happens when you click "Call" today

Traced end-to-end in code:

- The only live "Call" button (`TicketDetail.tsx` → `CallButton`) POSTs `/api/zoho/voice/call`. The handler `zohoInitiateCall` (`handlers/zoho.go:1904`) **does not place a call** — it inserts a `helpdesk_calls` row with `outcome='in_progress'` and returns a Zoho Voice token `{access_token, agent_id, dc, phone_number}`. **The frontend discards the token** and shows a "Calling…" toast. Net effect: one placeholder log row, no dial, nothing leaves the server.
- Its own comment says the truth: *"the actual call is placed browser-side by the Zoho Voice WebSDK — the Desk REST API is a call-log endpoint only and cannot initiate a dial."* There is **no Zoho Voice WebSDK in the frontend**, so nothing dials.
- Everywhere else ("Call" in the Call-Center Queue, Customer 360, contact/sales profiles) is a native **`tel:` link** — it hands off to the agent's OS/desk phone. This is the de-facto calling mechanism in use today.
- **Zoho Voice API is blocked** for this org: the token lacks the Voice scope, so `voice.zoho.com/.../logs` returns `ZVT022 "Invalid OAuth scope."` Calls are logged in **Zoho Desk** (PhoneBridge logs) and imported by the Desk sync.

**Two complete in-browser softphones already exist but are never mounted:**
- **Telnyx WebRTC** — `components/CallWidget.tsx` (full dial-pad, mute, timer, inbound panel) + `voice.go` Telnyx SIP-credential endpoints + migration `068_telnyx_sip_credentials.sql`. Labeled "legacy," not imported anywhere.
- **Africa's Talking WebRTC** — `lib/atVoice.ts` + `hooks/useATVoice.ts` + `/api/voice/at-token`. The hook is never called.
- AT's **inbound** webhook (`VoiceATInbound`) is the only path that can move real audio today (it bridges an inbound call to `AT_AGENT_MOBILE`); needs AT creds.

---

## 2. The "log the call back" half — already built

`helpdesk_calls` is the single call ledger (migration 143 converged all others into it). A call that happens in Zoho lands here via:

- **Zoho Desk `/calls` importer** (`runZohoDeskCallImportJob`) — the primary path. Idempotent upsert on `zoho_call_id`; derives direction/outcome/duration/agent/customer/purpose. **This is where a real Zoho call actually appears.**
- **Cadence:** a **60 s fast poll** (`ZOHO_POLL_INTERVAL`, default 60, clamped 30–3600) over a 3-day window, plus an **hourly deep reconcile**. So steady-state log-back latency is **≤ ~60 s** (plus Zoho's own delay exposing the call).
- **Webhook (built, dormant):** `POST /api/zoho/webhook` records the raw event and fires a debounced (8 s) bounded sync — collapsing latency to **seconds**. It's **fail-closed** (503 without `ZOHO_WEBHOOK_SECRET`) and **receives no traffic** until a public ingress (`crm.o3cards.com`) is stood up.
- **Attribution:** the durable `zoho_agent_map` crosswalk (`zohoResolveAgent`: manual → email → name) maps the Zoho agent to a workspace user; mapping an agent back-fills all historical rows.

**Conclusion:** whichever way the call is *placed*, the logging is a solved, idempotent pipeline. Making it instant is a config task (webhook secret + public ingress), not a build.

---

## 3. How Zoho click-to-call actually works (the constraint)

### Zoho PhoneBridge — *cannot be triggered by an external app*
PhoneBridge is the framework that plugs a telephony **provider** into Zoho Desk/CRM. When a user clicks dial **inside a Zoho screen**, Zoho POSTs the number to the **provider's** `clicktodial` endpoint and the provider dials. The direction is **Zoho → provider**; there is no PhoneBridge endpoint an outside app can hit to make Zoho dial. Its APIs are for (a) receiving click-to-dial *from* Zoho and (b) provider → Zoho **call-state notifications** (`calldialed`, answered/ended) used for logging. The two PhoneBridge scopes (`PhoneBridge.call.log`, `PhoneBridge.zohoone.search`) are **logging/search — there is no "place a call" scope.** The org's `PhoneBridge.call.log` can push/handle call logs but cannot originate a call.

### Zoho Voice / ZDialer — *the only Zoho "make a call" primitive*
Zoho's own cloud carrier (WebRTC + TURN + SRTP). It exposes:
- **Zoho Voice WebSDK** — an embeddable JS SDK (`makeCall()` / `answerCall()`, hold/mute/transfer/DTMF/recording) you drop into any web app so a click places the call in the agent's **browser softphone**. **This is exactly what `zohoInitiateCall` was written to feed** (it returns the WebSDK token).
- **ZDialer** — a browser extension that number-detects any webpage + a dial pad; the extension-based alternative to embedding the SDK.
- Requires: a **Zoho Voice subscription** (Business Phone / Enterprise Telephony edition), licensed telephony users, and purchased Zoho numbers. Call logs auto-write to Desk/CRM and are also readable via the Voice Call Logs API (polling, `ZohoVoice.call.READ`).

### Zoho Desk telephony
Desk's "call" button is mediated by whatever telephony is connected (PhoneBridge provider or Zoho Voice). **No plain deep-link / REST "dial for the logged-in agent"** exists for outsiders.

---

## 4. The viable architectures

| # | Approach | Who dials | "Zoho dials"? | Seamless click-in-app? | Log-back | Build gap | New cost |
|---|---|---|---|---|---|---|---|
| **A** | **Zoho Voice WebSDK** (embed in workspace) | Agent's browser softphone via **Zoho Voice** | **Yes** | **Yes** — click → dials, no tab switch | Auto to Desk → existing sync (or Voice Call-Logs API) | **Frontend WebSDK only** (backend already returns the token) | **Zoho Voice subscription + numbers + licensed users** |
| **B** | **Keep carrier, trigger via carrier API, log into Zoho via a custom PhoneBridge connector** | Carrier (e.g. Telnyx) bridges agent ↔ customer | No (carrier dials; Zoho logs) | Yes — click → carrier dials the agent then customer | **Instant** — carrier's completion webhook hits us directly; connector also posts to Zoho | Build the PhoneBridge connector + wire carrier origination (Telnyx softphone `CallWidget` already built) | Carrier per-minute (Telnyx bills +234 as international) |
| **C** | Deep-link into Zoho and click there | Zoho's connected telephony | Sort-of | **No** — extra clicks, leaves the app | Zoho logs → sync | — | — |
| **D** | **BYOC SIP trunk + self-run FreeSWITCH** (the existing `IN_APP_CALLING_PLAN.md`) | Own carrier via own softswitch, in-browser WebRTC softphone | No (bypasses Zoho) | Yes — fully in-app | Direct to `helpdesk_calls` (no Zoho) | Large: FreeSWITCH + SBC/Coturn + browser softphone | Reuses **already-owned** Nigerian trunk (cheapest calls); needs a Linux box |

**C is a non-starter** for a genuine in-app click. **D** is the org's *already-chosen strategic direction* for owning calling outright, but it **bypasses Zoho** — so it doesn't match the literal "goes to Zoho" ask (it's the right long-term answer to "call from the workspace," a superset goal).

---

## 5. Recommendation

**If the requirement is literally "click → *Zoho* dials → seamless → auto-log," the answer is Option A (Zoho Voice WebSDK), and it is the shortest path — because the workspace is already built for it.**

What already exists for A:
- `POST /api/zoho/voice/call` (`zohoInitiateCall`) that mints/refreshes a **per-user Zoho Voice token** and returns it.
- A **per-user Zoho Voice OAuth "connect your account" flow** in Settings (`/api/settings/zoho-voice`, `voice_oauth_states`).
- The placeholder `helpdesk_calls` row + the Desk `/calls` sync that reconciles the completed call.

What's missing for A (in order):
1. **Provision Zoho Voice** for the org (subscription + numbers + licensed users) — a **procurement/admin decision, not a build.** *This is the gating item.*
2. **Embed the Zoho Voice WebSDK** in the frontend: load the SDK, take the `access_token` that `zohoInitiateCall` already returns, call `makeCall(phone_number)`, and render a minimal in-call widget (mute/hangup/timer). The `CallButton` currently throws that token away — wiring it is the core frontend task.
3. On call end, keep the placeholder row's `zoho_call_id` reconcilable, and **turn on the webhook** (`ZOHO_WEBHOOK_SECRET` + public ingress) so the completed call logs in seconds instead of ≤60 s.

**If keeping the current carrier matters more than Zoho placing the call, Option B** delivers the *same agent UX* (click → phone rings → talk → auto-logged) with **faster** log-back, and the **Telnyx softphone is already built** (`CallWidget.tsx`) — the remaining work is mounting it, provisioning Telnyx SIP, and building a PhoneBridge connector so calls still appear in Zoho. Trade-off: Telnyx bills Nigerian numbers as international egress, and "Zoho dials" becomes "carrier dials, Zoho logs."

**Longer term, Option D** (BYOC + FreeSWITCH) is the cheapest-per-minute, fully-owned path already scoped in `IN_APP_CALLING_PLAN.md`, but it's a larger build blocked on the carrier + IT, and it drops Zoho from the call path.

### Decision the user needs to make
1. **Must Zoho place the call** (Option A), or is "click in app → phone rings → auto-logged" enough regardless of who carries it (Option B/D)?
2. **Willing to buy Zoho Voice?** If yes → A is quick (mostly a frontend WebSDK embed on top of existing backend). If no → B (keep carrier, build connector) or D (own softswitch).

---

## 6. Open questions to confirm with Zoho / IT before committing
- Zoho Voice **edition + number pricing in Nigeria**, and whether Voice can be added to the existing Zoho plan.
- Whether Zoho Voice exposes a **pure server-side "dial" REST** endpoint or is **WebSDK/ZDialer-only** for initiation (affects whether any agent-side session is required).
- For B: the carrier's **call-origination API** + reachable agent endpoint (SIP/softphone/mobile), and building the **custom PhoneBridge connector** (uses the `PhoneBridge.call.log` scope the org already has).
- For instant logging (any option): stand up the **public ingress + `ZOHO_WEBHOOK_SECRET`** so `POST /api/zoho/webhook` goes live.

---

## Sources (Zoho official docs)
- PhoneBridge Click-to-Dial (Zoho→provider) — https://www.zoho.com/phonebridge/developer/v3/clicktodial.html
- PhoneBridge Call Control / Notify (provider→Zoho logging) — https://www.zoho.com/phonebridge/developer/v3/call-control.html · https://www.zoho.com/phonebridge/developer/v3/outgoing-answered.html
- PhoneBridge API v1 (scopes) — https://www.zoho.com/desk/help/api/phonebridge/v1/
- Zoho Voice ZDialer — https://www.zoho.com/voice/zdialer.html
- Zoho Voice WebSDK (`makeCall`) — https://help.zoho.com/portal/en/kb/zoho-voice/zoho-voice-sdk/articles/zoho-voice-sdk
- Zoho Voice native integrations (CRM/Desk, plans) — https://www.zoho.com/voice/native-integrations.html
- Zoho Voice Call Logs API — https://help.zoho.com/portal/en/kb/zoho-voice/zoho-voice-apis/common-apis/articles/call-logs-api
- Catalyst Dialer App tutorial (carrier-bridge pattern) — https://docs.catalyst.zoho.com/en/tutorials/dialer-app/nodejs/introduction/

*Related internal docs: `IN_APP_CALLING_PLAN.md` (Option D), `AT_VOICE_SETUP.md` (dormant Africa's Talking path).*
