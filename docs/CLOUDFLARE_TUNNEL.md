# Cloudflare Tunnel — expose the on-prem workspace's public endpoints

**What this is for now:** letting external services (SendGrid, Zoho, Phoenix, email
recipients, the customer mobile app) reach the on-prem workspace's **inbound webhooks and
tracking URLs** over the internet **without opening any firewall ports**.

> ### ⚠️ This document was rewritten — the old version is obsolete
> The previous version documented tunnelling on-site **MSSQL (:1433) to Railway**. That is
> retired:
> - **MSSQL/Sage was removed** — PostgreSQL is now the sole datastore; card data is loaded
>   via the CSV data feed (`docs/DATA_FEED_INGESTION.md`), not a live MSSQL sync.
> - The app **runs on-prem** (native `o3c-backend.exe` + `tlsproxy`, deployed by SSH), not on
>   Railway.
>
> There is no MSSQL tunnel to maintain anymore. If a `cloudflared` connector is still running
> the old `o3c-mssql` tunnel on the office PC, it can be repurposed (see Option A) or retired.

---

## Current topology (measured on the server)

| Piece | Where |
|---|---|
| Backend API | native `o3c-backend.exe` on **`10.1.2.30:8000`** (HTTP, Postgres) |
| TLS reverse proxy | `tlsproxy.exe` on **`10.1.2.30:8443`** → forwards to `:8000` |
| Proxy cert | **self-signed** `CN=crm.o3cards.pri` (SANs: `crm.o3cards.pri`, `localhost`, `10.1.2.30`) |
| Network reach | staff VLAN → server VLAN permitted **only on 8443** |
| Internet egress from the backend box | **none** — the box cannot reach the internet outbound |

The last row is the key constraint below.

---

## What actually needs to be publicly reachable

These are the **public** (no-JWT) routes external systems call. A tunnel should expose **only
these**, never the whole app/login:

| Path | Who calls it | Notes |
|---|---|---|
| `POST /api/mail/events` | SendGrid **Event Webhook** | opens / delivered / bounce / spam — the one you're setting up |
| `POST /api/mail/inbound` | SendGrid **Inbound Parse** | inbound mail → tickets |
| `GET  /api/mail/unsubscribe` | email recipients | one-click unsubscribe links |
| `POST /api/campaign-webhooks/*` | Termii / SendGrid | campaign SMS/email events |
| `GET  /t/o/*`, `GET /t/c/*` | email recipients | open-pixel + click-redirect tracking |
| `POST /api/zoho/webhook` | Zoho Desk/Voice | dormant until `ZOHO_WEBHOOK_SECRET` + ingress set |
| `POST /api/phoenix/webhook` | Phoenix | HMAC-signed; 503 until `PHOENIX_WEBHOOK_SECRET` set |
| `POST /api/care/inbound` | SendGrid Inbound Parse (care@) | dormant until configured |
| `GET  /api/public/fx-rates` | customer mobile app | public FX rates |

> Whatever hostname the tunnel uses must also be the base URL the app **emits** in emails for
> the `/t/o`, `/t/c`, and `/api/mail/unsubscribe` links, or recipients will hit an unreachable
> host. Check `APP_BASE_URL` / the tracking-link base once the hostname is chosen.

---

## Why Cloudflare Tunnel fits

It removes the three blockers of the direct-NAT route:
- **No inbound port-forward** — `cloudflared` dials *out* to Cloudflare's edge.
- **No public cert to buy/install** — Cloudflare terminates TLS at its edge with a trusted
  cert automatically. The self-signed `.pri` origin cert is fine (we skip verifying the last
  internal hop).
- **Path-scoped ingress** — expose only the routes above, not the login/app.

---

## The one prerequisite: where `cloudflared` runs

`cloudflared` needs a host with **outbound internet** *and* a network path to the backend.
The backend box has **no egress**, so pick one:

- **Option A — run it on a host that already has egress + LAN reach to `10.1.2.30:8443`**
  (e.g. reuse the office PC that ran the old MSSQL tunnel, *if* it can reach the server VLAN on
  8443). One `cloudflared` can serve many ingress rules — just add the workspace hostname to
  its existing config. Origin: `https://10.1.2.30:8443` with `noTLSVerify: true`.
  **Confirm:** does that host reach `10.1.2.30:8443`?
- **Option B — run it on the backend box** (`10.1.2.30`). Cleanest origin (`http://localhost:8000`,
  no VLAN hop, no cert quirk), but **requires IT to allow outbound** from `10.1.2.30` to
  Cloudflare's edge: **TCP 443** and **UDP 7844** to Cloudflare (`*.cloudflare.com` / Argo).

---

## Prerequisites checklist

1. **Cloudflare account** with the target **domain on Cloudflare DNS** (nameservers delegated to
   Cloudflare).
   - ⚠️ **Resolve the domain first.** The old tunnel used `o3ccards.com` (**double-c**); the
     SendGrid URL you set uses `crm.o3cards.com` (**single-c**); the internal cert is
     `crm.o3cards.pri`. The tunnel hostname **must** be under whichever domain Cloudflare
     actually manages. Pick a dedicated hostname such as **`hooks.<your-cloudflare-domain>`**
     and update SendGrid to match — don't assume `crm.o3cards.com` works.
2. A **connector host** per Option A or B, with the network path confirmed.
3. `cloudflared` installed on that host + admin rights to run it as a service.

---

## Setup (run on the connector host)

Replace `hooks.example.com` with your chosen hostname and the origin with your Option (A or B).

```powershell
# 1. install + authenticate (opens a browser to your Cloudflare account)
winget install Cloudflare.cloudflared
cloudflared tunnel login

# 2. create the tunnel (note the printed Tunnel ID)
cloudflared tunnel create o3c-workspace
```

Config file `C:\Users\<USER>\.cloudflared\config.yml` — **path-scoped to the public routes only**:

```yaml
tunnel: o3c-workspace
credentials-file: C:\Users\<USER>\.cloudflared\<TUNNEL_ID>.json

ingress:
  # ---- only the public integration/tracking routes are published ----
  - hostname: hooks.example.com
    path: ^/(api/mail/(events|inbound|unsubscribe)|api/campaign-webhooks/.*|api/zoho/webhook|api/phoenix/webhook|api/care/inbound|api/public/fx-rates|t/[oc]/.*)$
    service: https://10.1.2.30:8443     # Option A. For Option B use: http://localhost:8000
    originRequest:
      noTLSVerify: true                 # origin cert is self-signed .pri — CF↔origin is the LAN/tunnel
  # ---- everything else on this hostname is refused ----
  - hostname: hooks.example.com
    service: http_status:404
  - service: http_status:404
```

```powershell
# 3. public DNS + trusted cert (auto-created by Cloudflare)
cloudflared tunnel route dns o3c-workspace hooks.example.com

# 4. run, then install as a boot service
cloudflared tunnel run o3c-workspace
cloudflared service install
```

**Harden it (recommended):** in the Cloudflare dashboard add a WAF/IP rule on
`hooks.example.com` allowing only **SendGrid's published outbound IP ranges** (and any other
callers you add), so the exposed paths aren't open to the whole internet.

---

## Point the integrations at the tunnel

- **SendGrid → Settings → Mail Settings → Event Webhook → HTTP Post URL** =
  `https://hooks.example.com/api/mail/events`
- SendGrid **Inbound Parse** (if used) = `https://hooks.example.com/api/mail/inbound`
- Zoho / Phoenix / Termii webhook URLs, and the app's tracking/unsubscribe base URL, likewise.

---

## Verify

```bash
# from any machine on the internet — 401 = reachable & the endpoint enforces signatures (good)
curl -sk -X POST -d '[]' https://hooks.example.com/api/mail/events
```
Then use SendGrid's **Event Webhook → "Test Your Integration"** — it posts a signed sample from
SendGrid's servers. A **200** means end-to-end success and mail will move off `queued`.

> The backend must be running the build that verifies SendGrid's **ECDSA** signature
> (`verifySendGridSignature` on `/api/mail/events`). An older build verified with HMAC and 401'd
> every genuine event. Confirm the backend has been restarted onto the fixed build before the
> final test.

---

## Still to confirm before running (owner: IT / Temitope)

- [ ] Which domain is actually on Cloudflare (single-c `o3cards.com` vs double-c `o3ccards.com`),
      and the exact hostname (`hooks.<domain>`).
- [ ] Connector placement — **Option A** (host that reaches `10.1.2.30:8443`) or **Option B**
      (allow egress from the backend box).
- [ ] Whether the old `o3c-mssql` tunnel/host still exists to reuse or should be retired.

## Troubleshooting

- **`cloudflared` won't connect** → the connector host has no outbound to Cloudflare (Option B
  needs TCP 443 + UDP 7844 egress allowed).
- **502 from the tunnel** → the connector can't reach the origin (`10.1.2.30:8443` blocked by the
  VLAN, or `tlsproxy` down). Test from the connector: `curl -sk https://10.1.2.30:8443/api/health`.
- **TLS error at the origin** → you omitted `noTLSVerify: true` while pointing at the self-signed
  `:8443`; add it, or use Option B's `http://localhost:8000`.
- **401 on a real SendGrid test** → backend not on the ECDSA-fix build (see note above).
</content>
