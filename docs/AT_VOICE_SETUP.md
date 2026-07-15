# Africa's Talking Voice — Setup Guide

Everything is already built. The only things left for you to do are:
1. Create an AT account and buy a Nigerian number
2. Set four environment variables on the server

---

## Step 1 — Create an Africa's Talking Account

1. Go to **africastalking.com** → click **Get Started**
2. Register with your O3 Capital business email
3. Once logged in, navigate to **Settings → API Key** and copy your API key

---

## Step 2 — Buy a Nigerian +234 Virtual Number

1. In the AT dashboard, go to **Voice → Phone Numbers**
2. Click **Buy Number** → select **Nigeria** → choose a number
3. Nigeria virtual numbers look like `+23417006XXX`
4. Copy the number — this is your `AT_PHONE_NUMBER`

> **Note:** AT Nigeria virtual numbers are landline-type (+234170XXXXXX format).
> They can receive inbound calls from any Nigerian mobile or landline.

---

## Step 3 — Create a Voice Application

1. Go to **Voice → Voice Apps** → click **New App**
2. Name it `O3 Capital Call Center`
3. Set the **Callback URL** (called on every inbound call):
   ```
   https://your-backend-domain.com/api/voice/at-inbound
   ```
4. Leave **Recording** disabled for now (enable later if needed)
5. Click **Create**
6. Go back to **Voice → Phone Numbers**, find your number, click the arrow and assign it to this Voice App

---

## Step 4 — Set Environment Variables on the Server

Add these four variables to your backend server's environment:

| Variable | Value | Example |
|---|---|---|
| `AT_API_KEY` | From AT dashboard → Settings → API Key | `atsk_abc123...` |
| `AT_USERNAME` | Your AT account username (usually the email you signed up with, or `sandbox` for testing) | `babatundeopemiposi@gmail.com` |
| `AT_PHONE_NUMBER` | The +234 number you bought in Step 2 | `+23417006001` |
| `AT_AGENT_MOBILE` | A real Nigerian mobile number for bridging inbound calls to. Inbound calls from customers will ring this number. Use the team lead's or supervisor's mobile initially. | `+2348012345678` |

**On your server**, add these to your environment file or service configuration. Example:
```bash
AT_API_KEY=atsk_abc123...
AT_USERNAME=babatundeopemiposi@gmail.com
AT_PHONE_NUMBER=+23417006001
AT_AGENT_MOBILE=+2348012345678
```

Restart the backend after setting these.

---

## Step 5 — Install the Frontend SDK

From the `frontend/` directory:
```bash
npm install
```

This runs `postinstall` automatically, which copies the AT WebRTC SDK to
`public/vendor/africastalking.js`. Verify the file exists:
```bash
ls frontend/public/vendor/africastalking.js
```

If it's missing (e.g. in CI), run:
```bash
npm run copy-at-sdk
```

---

## What Happens After Setup

### Inbound calls (customer calls your +234 number)

```
Customer dials +23417006001
  → Africa's Talking receives call
  → AT posts to POST /api/voice/at-inbound
  → Backend creates a helpdesk ticket (visible in Helpdesk → Tickets)
  → Backend logs the call (visible in Helpdesk → Calls)
  → AT bridges audio to AT_AGENT_MOBILE
  → Agent answers on their mobile, speaks with customer
  → When call ends, AT posts isActive=0 → backend updates duration + outcome
```

### Outbound calls (agent calls customer from browser)

```
Agent opens Helpdesk → Call Log
  → Live Dialer panel appears at top (green "Ready" dot)
  → Agent types customer phone number → clicks Call
  → useATVoice hook → backend GET /api/voice/at-token → AT issues capability token
  → Browser AT SDK places call via AT PSTN infrastructure
  → Agent speaks in browser (no phone handset needed)
  → When done → Hang up → Log Call modal opens for notes
```

---

## Testing Without a Real Number (Sandbox)

AT provides a sandbox environment for development:
1. Set `AT_USERNAME=sandbox` in the environment
2. Use the AT sandbox simulator to trigger test calls:
   https://developers.africastalking.com/simulator/voice
3. Sandbox calls do not cost anything and do not touch real PSTN

---

## Phase 2 — Per-Agent Routing (Future)

Currently, all inbound calls bridge to `AT_AGENT_MOBILE` (one number).
To route to specific available agents:

1. Add `at_mobile_number TEXT` column to `o3c_users` via a migration
2. Build a simple agent availability status (online/offline toggle in the header)
3. Update `VoiceATInbound` in `voice.go` to:
   - Query available agents from `o3c_users WHERE at_mobile_number IS NOT NULL AND status='available'`
   - Pick the agent with the fewest active calls
   - Bridge to their mobile

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Live Dialer doesn't appear in the browser | `AT_API_KEY` or `AT_USERNAME` not set on backend | Set env vars, restart backend |
| Dialer shows "Reconnecting…" on load | `/vendor/africastalking.js` missing | Run `npm run copy-at-sdk` |
| Inbound call rings agent mobile but customer hears nothing | `AT_AGENT_MOBILE` not set | Set the env var, restart backend |
| `AT token returned HTTP 401` in backend logs | Wrong `AT_API_KEY` | Copy the key again from AT dashboard |
| Call goes through but ticket not created | DB error — check backend logs | Verify DB connection and helpdesk_tickets table exists |
| Console shows `AfricasTalking is not defined` | Wrong global name from AT SDK version | Open `public/vendor/africastalking.js`, search for `window.` to find the actual global name, update `atVoice.ts` line with `AT.Client ?? AT` |

---

## Files Changed by This Feature

```
backend-go/
  handlers/voice.go          — Rewritten: AT capability token + full inbound webhook
  main.go                    — Added GET /api/voice/at-token route

frontend/
  src/lib/atVoice.ts         — AT WebRTC client wrapper (zombie-fix auto-reconnect)
  src/hooks/useATVoice.ts    — React hook for AT voice state
  src/pages/helpdesk/Calls.tsx — Added LiveDialer panel (inbound ring + outbound dial)
  scripts/copy-at-sdk.mjs    — Postinstall: copies AT SDK to public/vendor/
  package.json               — Added africastalking-client dep + postinstall script
  public/vendor/africastalking.js  — AT browser SDK (auto-generated by postinstall)
```
