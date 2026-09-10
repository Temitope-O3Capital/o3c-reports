# Predictive / Automatic Dialer — Research & Options

**Question:** *"How can we run an automatic predictive dialer with ZDialer?"*

**Short answer, up front:**

> **ZDialer cannot do predictive dialing — and neither does anything else in the Zoho stack.** ZDialer is a **click-to-call browser extension** (it detects numbers on a page and gives you a dialpad). The closest Zoho product is **Zoho Voice Power Dialer**, which is a **power/progressive** dialer (dial-one-when-the-agent-is-ready), **not predictive** (dial-many-ahead-of-agents). A *true predictive dialer* — one that over-dials multiple lines per agent, screens out machines/no-answers, and connects only live humans — is a different class of system. For O3C it means one of: **buy Zoho Voice Power Dialer (progressive, quickest)**, **bolt on a third-party predictive dialer**, or **self-host VICIdial/Asterisk on the BYOC trunk we already own (the only path to true predictive, and the biggest build).**

This doc explains the difference that matters, what each option actually is, how it plugs into what we already have (`call_center_contacts`, `dnc_list`, `helpdesk_calls`, the BYOC Nigerian trunk), the Nigerian regulatory constraints, and a recommendation.

---

## 1. First, the vocabulary — because the whole decision hinges on it

"Auto dialer" is an umbrella term. There are **four** distinct machines under it, and they are not interchangeable. Ordered from safest/slowest to fastest/riskiest:

| Mode | How it dials | Calls per agent | Abandoned calls | Needs AMD? | Best for |
|---|---|---|---|---|---|
| **Preview / Click-to-call** | Agent sees the record, clicks to dial | < 1 (agent-paced) | Zero | No | Complex/high-value calls, collections on named accounts. **This is ZDialer + our current `tel:` links.** |
| **Power dialer** | Auto-dials the next number the instant the agent is free, one at a time | 1:1 | Zero (an agent is always waiting) | Optional | Warm lists, mid-volume outbound. **This is Zoho Voice Power Dialer.** |
| **Progressive dialer** | Like power, but adds answering-machine detection so machines never reach an agent | ~1:1 | Very low | Yes | Volume outbound where you want to skip voicemails |
| **Predictive dialer** | Dials **several lines per agent ahead of time**, using a pacing algorithm that predicts when agents free up; drops machines/no-answers, routes live humans | 1.5:1 – 5:1 | **Deliberately non-zero** (the price of the speed) | Yes (mandatory) | Large cold lists, maximum agent talk-time |

The single most important sentence in this whole document:

> **Predictive dialing buys you agent talk-time by accepting that some answered calls will have no agent free and get dropped (dead air / abandoned).** Every predictive dialer is a knob between *agent utilization* and *abandonment rate*. That trade-off — not the software — is the real decision.

**Why over-dial at all?** If your list has a 25% answer rate, and you dial one-per-agent, an agent spends most of the shift listening to ring-out and voicemail. A predictive dialer places ~4 calls to keep 1 agent talking. When the math is right, agents talk ~50 min/hour instead of ~15. When the math is wrong (dirty list, bad pacing), customers pick up to silence and hang up — and you burn the number's reputation and risk regulatory penalties.

---

## 2. What "ZDialer" actually is (and isn't)

From Zoho's own docs and our prior `ZOHO_CLICK_TO_CALL_RESEARCH.md`:

- **ZDialer** = a **Chrome/Firefox/Edge browser extension** (and mobile app) for **Zoho Voice**. It auto-detects phone numbers on any webpage and shows a dialpad + incoming-call pop-ups. It is **click-to-call**. There is **no campaign engine, no list pacing, no over-dial, no AMD.** ([Zoho ZDialer](https://www.zoho.com/voice/zdialer.html), [Functions in ZDialer](https://www.zoho.com/voice/help/functions-in-zdialer.html))
- It also **requires a Zoho Voice subscription** — which **this org does not currently have** (our grant is `Desk.calls.ALL` + `PhoneBridge.call.log`, a *logging* scope; the Voice API returns `ZVT022 "Invalid OAuth scope"`).

So "predictive dialer with ZDialer" is a category error: ZDialer is the *manual* end of the spectrum. The Zoho product that automates outbound is **Power Dialer**, covered next.

---

## 3. Option A — Zoho Voice Power Dialer (progressive-style, quickest to stand up)

Zoho Voice added **Power Dialer** — a campaign tool that auto-dials a contact list and hands connected calls to agents. ([Power Dialer](https://www.zoho.com/voice/power-dialer.html), [multi-agent campaigns KB](https://help.zoho.com/portal/en/kb/zoho-voice/power-dialer/articles/multi-agent-power-dialer-campaign-in-zoho-voice))

**What it gives us:**
- **Multi-agent campaigns** — up to **40 agents** in one campaign, **1,000 contacts per dial group**.
- **Voicemail drop** — pre-recorded message dropped on machines.
- **Live monitoring / whisper / barge** for supervisors.
- **Native logging** into Zoho Desk/CRM → flows into our existing `helpdesk_calls` sync with **no new code**.
- **BYOC support** — *importantly*, **Zoho Voice now supports Bring-Your-Own-Carrier**: you connect your existing carrier's SIP trunk (TCP/UDP/TLS) and keep your numbers. ([BYOC](https://www.zoho.com/voice/help/byoc.html), [Create & configure BYOC](https://www.zoho.com/voice/help/create-and-configure-byoc.html)) That means **the Nigerian trunk we already own could feed the Power Dialer** rather than buying Zoho Nigerian DIDs.

**What it is NOT:**
- **Not predictive.** Zoho markets it as automating outbound and "removing wait time between calls," i.e. **power/progressive** pacing (dial as the agent frees up). There is **no published over-dial ratio, no predictive pacing algorithm, and no documented AMD-with-abandonment-control.** If the requirement is literally *predictive over-dialing*, Power Dialer does not meet it.

**Gating items:**
1. **Buy Zoho Voice** (Business Phone / Enterprise Telephony edition) + licensed telephony users — a procurement decision, not a build. Confirm **Nigeria data-center + BYOC availability** and whether **Power Dialer runs over a BYOC trunk** (Zoho's BYOC is newer than Power Dialer; verify the combination with Zoho sales before committing).
2. Connect our BYOC trunk (carrier questions from `IN_APP_CALLING_PLAN.md` §Critical Path apply verbatim — auth type, transport, codecs, channel limit).
3. Point our existing outbound queue (`call_center_contacts`) into campaigns of ≤1,000, honoring `dnc_list`.

**Effort:** Low-to-medium. Mostly procurement + config + a CSV/API bridge from `call_center_contacts` to Zoho campaigns. Logging is already solved.

---

## 4. Option B — Third-party predictive dialer that integrates with Zoho

If we want **true predictive** but don't want to run telephony infrastructure, several vendors do predictive dialing and integrate with Zoho CRM/Desk for screen-pop + logging: **VoiceSpin, Voiso, AutoReach, interCloud9**, etc. ([Auto dialers for Zoho — GetApp](https://www.getapp.com/it-communications-software/auto-dialer/w/zoho-crm/), [VoiceSpin Zoho](https://www.voicespin.com/integration-with-zoho/), [Voiso](https://voiso.com/articles/zoho-dialer-integration/))

- **Pros:** real predictive pacing + AMD out of the box; managed service; fast to pilot.
- **Cons:** a **new vendor + per-seat/per-minute cost**; most are US/EU-centric — **confirm Nigerian termination and whether they accept our BYOC trunk** (otherwise calls to +234 bill as international egress, the same trap we flagged against Twilio/Telnyx). Data leaves our perimeter to their cloud (NDPR consideration).

**Effort:** Low to integrate, but recurring cost + vendor due diligence (Nigeria routing, data residency).

---

## 5. Option C — Self-host VICIdial / Asterisk on our BYOC trunk (true predictive, fully owned)

This is the **only path to a genuine predictive dialer we control end-to-end**, and it lives in the **same infrastructure box as our already-chosen `IN_APP_CALLING_PLAN.md` (Option D)**.

**VICIdial** is the mature open-source predictive dialer (Asterisk-based). It does the real thing: multi-line over-dial, configurable pacing (e.g. adaptive/predictive), AMD, abandonment tracking, agent screens, dispositions, recordings, DNC. It authenticates to a SIP trunk by IP or digest, exactly like our BYOC trunk. ([VICIdial setup guide](https://vicistack.com/blog/vicidial-setup-guide/), [SIP trunk guide](https://www.sipnex.ca/blog/vicidial-sip-trunk-setup-guide), [Asterisk config](https://vicistack.com/blog/vicidial-asterisk-configuration/))

**Architecture (reuses the FreeSWITCH plan's Layer 2 box):**
```
[ call_center_contacts (our list) ]  --load-->  [ VICIdial lists + DNC ]
[ VICIdial/Asterisk on Linux VM (public IP, TLS) ]  --SIP-->  [ BYOC Nigerian trunk ]
        |  pacing engine over-dials, AMD screens, live answers routed to agents
[ Agent screen (VICIdial webphone, or our own WebRTC softphone) ]
[ Dispositions/recordings ]  --sync-->  [ helpdesk_calls / disposition ]
```

- **Capacity note:** a 5:1 ratio with 50 agents needs **~250 concurrent channels** on the trunk — our carrier's **channel limit** (`IN_APP_CALLING_PLAN.md` question #5) directly caps how aggressive predictive can be.
- **Pros:** true predictive; **cheapest per-minute** (our own Nigerian trunk, no Zoho/vendor markup); fully owned data (NDPR-friendly); one box also unlocks the in-app softphone we already want.
- **Cons:** **largest build + real ops burden** — a Linux/Asterisk stack, dial-plan, AMD tuning, pacing tuning, SBC/NAT, recordings storage, and 24/7 telephony ops. Same **IT + carrier gate** that currently blocks Option D. AMD is imperfect and mis-tuned AMD is itself a compliance risk.

**Effort:** High. This is a multi-week, cross-team telephony project — but it's the strategic endgame we've already scoped, with predictive dialing added on top.

> **FreeSWITCH note:** our `IN_APP_CALLING_PLAN.md` prefers FreeSWITCH for the softphone. FreeSWITCH *can* do predictive pacing (`mod_callcenter` + custom origination logic), but it's **not turnkey** — you build the pacing/AMD/abandonment engine yourself. **VICIdial ships that engine.** If predictive dialing is a hard requirement, VICIdial (or GOautodial) is the lower-risk core; the FreeSWITCH softphone and VICIdial dialer can even coexist on the same trunk.

---

## 6. How it plugs into what we already have

We are further along than a greenfield shop — the **list and the ledger already exist**:

| We already have | Role in a dialer | Reuse |
|---|---|---|
| `call_center_contacts` (14.7k rows: `attempts`, `connects`, `last_called_at`, `disposition_code`, `callback_at`, `priority`, `purpose`) | The **dial list** + pacing signal | Feed campaigns; the `ready`/`cooling`/`exhausted` buckets we just built already encode "who to dial next" |
| `dnc_list` | **DNC suppression** — legally required | Any dialer must import/honor this before every dial |
| `helpdesk_calls` + Zoho Desk `/calls` sync + `POST /api/helpdesk/calls` | **Call logging / disposition** | Already idempotent; a dialer's completed calls reconcile here |
| Disposition vocabulary (`dispositionsFor`, purpose-scoped) | **Outcome capture** | Maps 1:1 to a dialer's disposition list |
| BYOC Nigerian SIP trunk | **The carrier** for A (via Zoho BYOC) or C (via Asterisk) | Avoids paying twice for connectivity |
| `IN_APP_CALLING_PLAN.md` Layer-2 Linux/SBC design | **The box** a self-hosted dialer runs on | Option C is Option D + a pacing engine |

**The most valuable thing we already own is the `attempts`/`connects` history.** The #1 cause of predictive-dialer failure is **dirty lists**: if 40% of numbers are wrong/stale, the pacing model reads the low connect rate as "dial harder," and abandonment spikes. We already track per-number connect success — so we can **rank and suppress before we ever over-dial** (skip `exhausted`, deprioritize never-connected, prioritize prior connects/callbacks). That single practice does more for a healthy dialer than any pacing setting.

---

## 7. Nigerian regulatory constraints (do not skip)

Automated outbound calling in Nigeria is regulated, and financial-services marketing is squarely in scope:

- **NCC DND 2442** — subscribers can register **full or partial Do-Not-Disturb** to block promotional calls/SMS. Calling DND-registered numbers on promotional campaigns is a violation. ([NCC DND](https://consumer.ncc.gov.ng/articles/111-do-not-disturb-dnd-service-in-nigeria), [Rules on unsolicited calls](https://consumer.ncc.gov.ng/articles/33-rules-on-unsolicited-calls-and-sms)) → **Our `dnc_list` must be authoritative and honored on every dial; treat DND like a hard gate, not a filter.**
- **NDPR / consent** — personal data (phone numbers) requires a lawful basis; consumers must be able to opt out. Harvesting/using numbers without approval is explicitly warned against. ([NCC notice](https://www.ncc.gov.ng/media-center/public-notices/unauthorised-use-telecom-subscribers-phone-numbers-and-other-personal)) → our dialing population should be **our own customers/consented leads**, not bought lists.
- **Penalties** — non-compliance can reach **₦10m or 2% of annual gross revenue**, plus criminal liability for serious cases. ([Bulk SMS compliance NG](https://www.bulksmsnigeria.com/resources/sms-compliance-nigeria))
- **No explicit Nigerian predictive-dialer abandonment cap** exists the way the **US FCC caps abandoned calls at 3%** of live-answered calls per campaign over 30 days ([pacing/compliance](https://www.ictbroadcast.com/how-predictive-dialers-work-2026-pacing-abandonment-compliance/)). **Recommendation: adopt the 3% abandonment ceiling voluntarily** as an internal SLA — it's the global norm, protects our number reputation, and is trivial to defend to a regulator.

**Practical guardrails to bake in regardless of option:** honor DND/`dnc_list` on every dial · cap abandonment ≤3% · restrict calling hours · present a consistent, registered caller ID · log consent basis per contact · hard-stop on repeated no-answers (we already have `ccExhaustedAttempts`).

---

## 8. Recommendation

**Match the option to what "predictive" is really worth to us right now:**

1. **If the goal is "automate outbound so agents stop hand-dialing," and true over-dialing isn't essential →** start with **Option A (Zoho Voice Power Dialer over our BYOC trunk).** It's the shortest path (procurement + config, logging already solved), 40 agents/1,000-contact campaigns, voicemail drop. Confirm with Zoho: **Nigeria + BYOC + Power-Dialer-over-BYOC** actually compose. This gets 80% of the productivity benefit with ~10% of the risk, and no telephony ops.

2. **If true predictive over-dialing is a hard requirement and we want to own it →** it belongs on **Option C (VICIdial/Asterisk on the BYOC trunk)**, folded into the **existing `IN_APP_CALLING_PLAN.md` build**. Same Linux/SBC box, same carrier questions; VICIdial adds the pacing/AMD engine FreeSWITCH would make us build. This is the strategic answer but a multi-week, IT-gated project.

3. **If we want predictive *fast* without running infrastructure →** pilot **Option B (a third-party predictive dialer)** — but only after confirming **Nigerian termination on our BYOC trunk** and **NDPR-acceptable data handling**; otherwise it re-introduces the international-egress cost trap and a data-residency question.

**Whichever path:** the win or loss is decided by **list hygiene and abandonment discipline, not the dialer brand.** We already have the `attempts`/`connects`/`dnc_list` data to do that well — use it to rank and suppress before dialing, and cap abandonment at 3%.

### Decisions needed
1. Is **progressive** (power dialer) enough, or is **predictive over-dialing** a hard requirement? *(Drives A vs B/C.)*
2. **Willing to buy Zoho Voice?** If yes and progressive is enough → **A** is quick. If no, or predictive is required → **B** (managed, recurring cost) or **C** (owned, big build).
3. Are we ready to unblock the **IT + carrier critical path** (`IN_APP_CALLING_PLAN.md`)? That gate governs both C and the in-app softphone.

---

## Sources

**Zoho (official):**
- ZDialer — https://www.zoho.com/voice/zdialer.html · https://www.zoho.com/voice/help/functions-in-zdialer.html
- Power Dialer — https://www.zoho.com/voice/power-dialer.html
- Power Dialer multi-agent campaigns — https://help.zoho.com/portal/en/kb/zoho-voice/power-dialer/articles/multi-agent-power-dialer-campaign-in-zoho-voice · https://help.zoho.com/portal/en/kb/zoho-voice/power-dialer/articles/how-to-launch-power-auto-dialer-campaigns-in-zoho-voice
- Bring Your Own Carrier (BYOC) — https://www.zoho.com/voice/help/byoc.html · https://www.zoho.com/voice/help/create-and-configure-byoc.html · https://www.zoho.com/blog/voice/bring-your-own-carrier-in-voice.html
- What's new in Zoho Voice — https://www.zoho.com/voice/whats-new.html

**Dialer concepts / predictive mechanics:**
- Power vs predictive vs progressive — https://aloware.com/blog/auto-dialer-vs-power-dialer-vs-predictive-dialer · https://www.dialpad.com/blog/predictive-vs-power-dialer/ · https://www.nexdial.com/predictive-dialer-vs-power-dialer-vs-progressive-dialer-the-2026-comparison-guide/
- Pacing, abandonment, AMD, compliance — https://www.ictbroadcast.com/how-predictive-dialers-work-2026-pacing-abandonment-compliance/ · https://www.retellai.com/blog/what-is-predictive-dialing

**Self-hosted (VICIdial/Asterisk):**
- VICIdial setup — https://vicistack.com/blog/vicidial-setup-guide/ · https://www.sipnex.ca/blog/vicidial-sip-trunk-setup-guide · https://vicistack.com/blog/vicidial-asterisk-configuration/

**Third-party predictive dialers for Zoho:**
- https://www.getapp.com/it-communications-software/auto-dialer/w/zoho-crm/ · https://www.voicespin.com/integration-with-zoho/ · https://voiso.com/articles/zoho-dialer-integration/ · https://www.autoreach.io/integrations/zoho

**Nigeria regulation:**
- NCC DND 2442 — https://consumer.ncc.gov.ng/articles/111-do-not-disturb-dnd-service-in-nigeria · https://consumer.ncc.gov.ng/articles/33-rules-on-unsolicited-calls-and-sms
- NCC notice on unauthorised use of subscriber data — https://www.ncc.gov.ng/media-center/public-notices/unauthorised-use-telecom-subscribers-phone-numbers-and-other-personal
- NDPR / SMS compliance & penalties — https://www.bulksmsnigeria.com/resources/sms-compliance-nigeria

*Related internal docs: `ZOHO_CLICK_TO_CALL_RESEARCH.md`, `IN_APP_CALLING_PLAN.md`, `AT_VOICE_SETUP.md`.*
