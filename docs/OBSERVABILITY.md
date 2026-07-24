# O3 Capital Workspace — Observability Guide

Covers distributed tracing (OTel), metrics (Prometheus), and how to run the
full monitoring stack on your own on-prem server.

---

## What is already built into the backend

The Go backend ships with three observability layers out of the box:

| Layer | What it gives you | Endpoint |
|---|---|---|
| **Prometheus metrics** | Request counts, latency histograms, error rates | `GET /metrics` |
| **OpenTelemetry traces** | Per-request trace showing exactly which code ran and how long each step took | Pushed to your collector |
| **Structured logs** | JSON logs on Railway (text locally) with `slog` — every significant event is logged | Railway log stream |

None of these require any paid service. Prometheus and OTel traces are collected
by software you run yourself on your own server.

---

## Part 1 — Prometheus metrics (already working)

The `/metrics` endpoint is live right now. You can scrape it from any Prometheus
instance without any additional env vars.

To verify locally:
```bash
curl http://localhost:8000/metrics
```

Key metrics exposed:

| Metric | Type | What it measures |
|---|---|---|
| `o3c_http_requests_total` | Counter | Request count, broken out by method / route group / status code |
| `o3c_http_request_duration_seconds` | Histogram | Request latency percentiles (p50, p95, p99) by method and route |

---

## Part 2 — OpenTelemetry traces

### What a trace is

Every HTTP request to the backend gets a **trace ID** (a random 128-bit hex
string) stamped into its context. As the request flows through handlers,
database calls, and any sub-calls, OTel records **spans** — timed segments
that together form a waterfall diagram.

Example: a loan disbursement call might produce:

```
POST /api/loans/disburse                           1 234 ms
  ├─ Auth middleware                                   3 ms
  ├─ complianceCheck()                               145 ms
  │    └─ db: SELECT FROM loan_applications           143 ms  ← slow query
  ├─ postJournal()                                    12 ms
  └─ respondJSON()                                     1 ms
```

Without traces you see "disbursement is slow." With traces you see "the
compliance check is doing a sequential scan on loan_applications."

### How the OTel code works

`core/otel.go` runs at startup:

- If `OTEL_EXPORTER_OTLP_ENDPOINT` **is not set** → strict no-op, zero overhead,
  nothing changes
- If the env var **is set** → creates an OTLP/HTTP exporter, 20% sampling
  (1 in 5 requests traced — enough signal without flooding storage), W3C
  `traceparent` header propagation so traces span service boundaries

The `otelhttp` middleware in `main.go` wraps every chi route so each request
automatically gets a root span. You do not need to annotate individual handlers.

---

## Part 3 — Self-hosted monitoring stack on your server

This is the recommended setup for O3 Capital. Everything runs on your existing
on-prem server. No external accounts needed.

### What you need on the server

- Docker and Docker Compose (one-time install)
- Port 3000 open internally (Grafana UI)
- Port 9090 open internally (Prometheus)
- Port 4318 reachable from Railway (OTel collector OTLP/HTTP receiver)
- Port 3100 internally (Loki log ingestion)

### Step 1 — Create the Docker Compose file

Create `/opt/o3c-monitoring/docker-compose.yml` on your server:

```yaml
version: "3.8"

volumes:
  prometheus_data:
  grafana_data:
  tempo_data:
  loki_data:

networks:
  monitoring:

services:

  # ── Prometheus — scrapes /metrics from the Railway backend ──────────────────
  prometheus:
    image: prom/prometheus:latest
    restart: unless-stopped
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
      - "--storage.tsdb.retention.time=90d"
    ports:
      - "9090:9090"
    networks: [monitoring]

  # ── Tempo — stores distributed traces ───────────────────────────────────────
  tempo:
    image: grafana/tempo:latest
    restart: unless-stopped
    command: ["-config.file=/etc/tempo.yaml"]
    volumes:
      - ./tempo.yaml:/etc/tempo.yaml:ro
      - tempo_data:/var/tempo
    ports:
      - "4318:4318"   # OTLP/HTTP receiver (Railway → this port)
      - "3200:3200"   # Tempo query API (used by Grafana)
    networks: [monitoring]

  # ── Loki — stores logs ──────────────────────────────────────────────────────
  loki:
    image: grafana/loki:latest
    restart: unless-stopped
    volumes:
      - ./loki.yaml:/etc/loki/loki.yaml:ro
      - loki_data:/loki
    ports:
      - "3100:3100"
    networks: [monitoring]

  # ── Alloy — forwards Railway logs to Loki ───────────────────────────────────
  alloy:
    image: grafana/alloy:latest
    restart: unless-stopped
    volumes:
      - ./alloy.river:/etc/alloy/config.river:ro
    ports:
      - "12345:12345"  # Alloy UI
    networks: [monitoring]

  # ── Grafana — unified dashboard UI ──────────────────────────────────────────
  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=false
      - GF_SECURITY_ADMIN_USER=admin
      - GF_SECURITY_ADMIN_PASSWORD=change_this_password   # CHANGE THIS
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana-datasources.yaml:/etc/grafana/provisioning/datasources/datasources.yaml:ro
    ports:
      - "3000:3000"
    depends_on: [prometheus, tempo, loki]
    networks: [monitoring]
```

### Step 2 — Config files

**`prometheus.yml`** — tells Prometheus where to scrape metrics from:

```yaml
global:
  scrape_interval: 30s
  evaluation_interval: 30s

scrape_configs:
  - job_name: o3c-api
    # Replace with your Railway backend public URL
    static_configs:
      - targets: ["your-backend.railway.app:443"]
    scheme: https
    metrics_path: /metrics
```

**`tempo.yaml`** — minimal Tempo config:

```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: 0.0.0.0:4318

storage:
  trace:
    backend: local
    local:
      path: /var/tempo/blocks

compactor:
  compaction:
    block_retention: 720h   # 30 days
```

**`loki.yaml`** — minimal Loki config:

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  ring:
    instance_addr: 127.0.0.1
    kvstore:
      store: inmemory
  replication_factor: 1

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h
```

**`alloy.river`** — forwards Railway log drain to Loki (optional but useful):

```river
loki.write "default" {
  endpoint {
    url = "http://loki:3100/loki/api/v1/push"
  }
}

loki.source.api "railway" {
  http {
    listen_address = "0.0.0.0"
    listen_port    = 4040
  }
  forward_to = [loki.write.default.receiver]
  labels = { service = "o3c-api", env = "production" }
}
```

**`grafana-datasources.yaml`** — auto-wires all three data sources into Grafana:

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    url: http://prometheus:9090
    isDefault: true

  - name: Tempo
    type: tempo
    url: http://tempo:3200
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
      serviceMap:
        datasourceUid: prometheus

  - name: Loki
    type: loki
    url: http://loki:3100
```

### Step 3 — Start the stack

```bash
cd /opt/o3c-monitoring
docker compose up -d
```

Check everything started:
```bash
docker compose ps
```

Grafana is now at `http://your-server-ip:3000`. Log in with the admin password
you set in `docker-compose.yml`.

### Step 4 — Configure Railway to send traces

In your Railway backend service, add two environment variables:

| Variable | Value |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://your-server-ip:4318` |

That is the only change needed. The backend will start exporting traces on the
next deploy. Verify it's working by checking the Tempo data source in Grafana
(`Explore → Tempo → Search`).

> **Firewall note:** Port 4318 on your server must accept inbound connections
> from Railway's outbound IPs. If your server is behind a firewall, open that
> port for `0.0.0.0/0` or restrict to Railway's IP range
> (check Railway docs for the current egress CIDR).

### Step 5 — Import dashboards into Grafana

Once data is flowing, import these community dashboards by ID in Grafana
(`Dashboards → Import → Grafana.com ID`):

| Dashboard | ID | What it shows |
|---|---|---|
| Go runtime metrics | `14797` | Goroutines, GC pauses, heap usage |
| HTTP request overview | `19924` | Request rate, error rate, p95 latency by route |
| Loki logs | `12019` | Searchable log viewer |

For traces, use `Explore → Tempo` directly — no import needed.

---

## Part 4 — Alternative: Grafana Cloud (if you prefer zero server management)

If running a server is too much overhead, Grafana Cloud has a free tier:
- 50 GB logs / month
- 50 GB metrics / month  
- 50 GB traces / month

Sign up at grafana.com/auth/sign-up, create a stack, then get your OTLP endpoint
and API key. Replace the Railway env vars:

| Variable | Value |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `https://otlp-gateway-prod-eu-west-0.grafana.net/otlp` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Basic <base64(instanceId:apiKey)>` |

Everything else is identical — Grafana Cloud uses the same OTLP protocol.

---

## Part 5 — Alerting (once data is flowing)

Set up these alerts in Grafana (`Alerting → Alert rules`):

| Alert | Query | Threshold | Notify |
|---|---|---|---|
| High error rate | `rate(o3c_http_requests_total{status=~"5.."}[5m])` | > 5% of requests | IT Admin + CTO |
| Slow API | `histogram_quantile(0.95, o3c_http_request_duration_seconds_bucket)` | > 3 seconds | IT Admin |
| Backend down | `up{job="o3c-api"} == 0` | Missing for 2 min | IT Admin + CTO |

Notification channels (set in `Alerting → Contact points`):
- Email via SendGrid SMTP
- Webhook to the backend's own `POST /api/notifications/...` if you want in-app alerts

---

## Summary — what to do and when

| When | What to do |
|---|---|
| **Now (nothing)** | Instrumentation is deployed. No config needed. |
| **When you want to see metrics** | Set up Prometheus on your server (Step 2 only, skip Tempo/Loki) |
| **When you're debugging a live issue** | Set `OTEL_EXPORTER_OTLP_ENDPOINT` on Railway — traces start flowing immediately |
| **Long term** | Full stack on your server (Parts 3 + 5) |
