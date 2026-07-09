CREATE TABLE IF NOT EXISTS fx_parallel_rates (
  id         BIGSERIAL PRIMARY KEY,
  source     TEXT        NOT NULL,
  currency   TEXT        NOT NULL,
  buy        NUMERIC(12,2),
  sell       NUMERIC(12,2),
  scraped_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fx_currency_scraped ON fx_parallel_rates (currency, scraped_at DESC);

CREATE TABLE IF NOT EXISTS fx_api_clients (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT        NOT NULL,
  api_key    TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
