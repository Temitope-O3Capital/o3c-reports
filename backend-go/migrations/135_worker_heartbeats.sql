-- 135: Heartbeats for background workers that keep no run table of their own
-- (pollers, scheduled jobs, worker pools). The data syncs (CBS, customer feed,
-- Paystack, Zoho) already persist run history; this covers everything else so the
-- Sync & Workers hub can show a real last-run/status for the whole fleet.

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_key        text PRIMARY KEY,
  status            text NOT NULL DEFAULT 'idle',   -- running | ok | error | idle
  last_started_at   timestamptz,
  last_finished_at  timestamptz,
  last_ok_at        timestamptz,
  last_error        text,
  detail            text,
  runs_total        bigint NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT NOW()
);
