-- Migration 040: Telemarketing module

CREATE TABLE IF NOT EXISTS telemarketing_campaigns (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',  -- active, paused, completed
  target_segment TEXT,
  start_date     DATE,
  end_date       DATE,
  created_by     BIGINT REFERENCES o3c_users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telemarketing_leads (
  id             BIGSERIAL PRIMARY KEY,
  campaign_id    BIGINT REFERENCES telemarketing_campaigns(id),
  customer_cif   TEXT,
  customer_name  TEXT NOT NULL,
  customer_phone TEXT,
  employer       TEXT,
  lead_score     INT DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending, called, callback, converted, dnc, no_answer
  assigned_to    BIGINT REFERENCES o3c_users(id),
  last_called_at TIMESTAMPTZ,
  callback_at    TIMESTAMPTZ,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telemarketing_dispositions (
  id           BIGSERIAL PRIMARY KEY,
  lead_id      BIGINT NOT NULL REFERENCES telemarketing_leads(id),
  agent_id     BIGINT NOT NULL REFERENCES o3c_users(id),
  outcome      TEXT NOT NULL, -- interested, not_interested, callback, no_answer, voicemail, dnc, converted
  notes        TEXT,
  duration_sec INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dnc_list (
  id       BIGSERIAL PRIMARY KEY,
  phone    TEXT NOT NULL UNIQUE,
  reason   TEXT,
  added_by BIGINT REFERENCES o3c_users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tm_leads_campaign ON telemarketing_leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_tm_leads_status   ON telemarketing_leads(status);
CREATE INDEX IF NOT EXISTS idx_tm_leads_assigned ON telemarketing_leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tm_disp_lead      ON telemarketing_dispositions(lead_id);
CREATE INDEX IF NOT EXISTS idx_tm_disp_agent     ON telemarketing_dispositions(agent_id, created_at);
