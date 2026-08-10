# In-App Calling Plan (Workspace Softphone)

**Status:** Planned / not started. Blocked on carrier + IT (see Critical Path).
**Goal:** Agents make and receive calls entirely inside the O3C Workspace — dial, screen-pop, disposition, presence, logging — instead of dialing in Zoho. Zoho drops to a data source.

## Decision summary

- **Carrier:** Use the **existing Nigerian BYOC SIP trunk** (already owned, currently pointed at Zoho). Do **not** buy Africa's Talking/Twilio — that would pay twice for connectivity we already have.
- **The gap BYOC does not close:** the trunk speaks **SIP**; browsers speak **WebRTC**. A softswitch **we run** must bridge SIP ↔ WebRTC.
- **Softswitch:** **FreeSWITCH** recommended (Asterisk acceptable if IT already knows it — familiarity breaks the tie). Skip LiveKit — PSTN/call-center maturity trails FreeSWITCH.
- **Agents are mixed in-office + remote** → must design for remote: a **public, TLS-secured SBC + Coturn (TURN)** on a **separate Linux host**, not the Windows app server. Keeps the media plane off the private application box.
- **Trunk control is currently unknown** → resolving it is the critical path (see below).

## 3-layer stack

```
[ Browser softphone (JsSIP/SIP.js over WSS) ]      layer 1  — Me (code)
        | WebRTC / SRTP
[ FreeSWITCH + Coturn on Linux VM (public IP, TLS) ] layer 2  — IT + carrier
        | ESL / ARI call events
[ Go backend + Postgres + Zoho Desk data ]          layer 3  — Me (code)
```

## Division of labor

| Layer | What | Who |
|---|---|---|
| Media/SBC | Linux VM (public IP) running **FreeSWITCH + Coturn + TLS cert**; BYOC trunk re-pointed here | **IT + carrier** |
| Softphone UI | Browser SIP client (**JsSIP/SIP.js** over WSS): dialpad, accept/reject, mute/hold/transfer/hangup, disposition, presence auto-flip | **Me** |
| Orchestration | Go consumes call events (FreeSWITCH **ESL** / Asterisk **ARI**) → screen-pop via caller-360 lookup, auto-log to `helpdesk_calls`, presence | **Me** |

Pieces that already exist and carry over unchanged: **caller-360 lookup** (`GET /api/helpdesk/caller-lookup?phone=`), **call logging** (`POST /api/helpdesk/calls`), dashboards, presence.

## Critical path — questions for the BYOC carrier / whoever configured Zoho BYOC

1. **Auth type:** Is the trunk **registration-based** (SIP user/pass) or **IP-authenticated** (they whitelist our IP)? If IP-auth, what static IP do they need from us?
2. **Second/parallel trunk:** Can they issue a **second trunk (or forked endpoint)** pointed at an IP/host **we** specify, running **alongside** the live Zoho trunk? (Enables build + pilot without breaking live Zoho calling.)
3. **Trunk parameters:** SIP host/domain, port, **transport (UDP/TCP/TLS)**, supported **codecs** (G.711 a-law/µ-law? Opus?), **SIP-over-TLS + SRTP** support (needed for browser audio).
4. **DID routing:** How do our Nigerian numbers map to the trunk (all DIDs one trunk vs per-number)? How is **inbound** delivered?
5. **Channel limit:** Max **concurrent calls** on the trunk.

## Migration strategy

Stand the new stack up on the **second trunk** → pilot with a handful of agents → prove it → cut over. **Zoho keeps running untouched** until confident. Never cut over cold. (This is why carrier question #2 matters most.)

## What can be built now (no carrier dependency)

The softphone UI and the Go ESL/ARI glue don't depend on the carrier or trunk config — a SIP client is a SIP client. Both can be built and tested against a throwaway test SIP server, ready to point at the real SBC once IT stands it up.

## Scope reality

This is a **multi-week, cross-team project**, not a weekend feature. Layers 1 and 3 are on Claude; the real gate is **IT + carrier standing up layer 2**.

## Rejected alternatives

- **Africa's Talking / Twilio / Telnyx:** redundant given BYOC; Twilio/Telnyx also bill +234 as international egress.
- **On-prem Asterisk without the existing trunk:** earlier considered a "trap" only because it required procuring a trunk — moot now that BYOC provides one.
- **Zoho embedded softphone:** lives in Zoho, not the workspace — fails the "everything in the workspace" goal.
