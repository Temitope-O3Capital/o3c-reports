-- 104: credit_activity_log — structured audit trail for collections, recovery, and risk modules

CREATE TABLE IF NOT EXISTS credit_activity_log (
    id              BIGSERIAL    PRIMARY KEY,
    ts              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    module          TEXT         NOT NULL CHECK (module IN ('collections','recovery','risk')),
    actor_id        BIGINT       REFERENCES o3c_users(id) ON DELETE SET NULL,
    actor_name      TEXT         NOT NULL DEFAULT '',
    actor_role      TEXT         NOT NULL DEFAULT '',
    entity_type     TEXT         NOT NULL,
    entity_id       TEXT         NOT NULL,
    account_cif     TEXT,
    action          TEXT         NOT NULL,
    description     TEXT         NOT NULL,
    previous_state  JSONB,
    new_state       JSONB,
    ip_address      TEXT
);

CREATE INDEX IF NOT EXISTS idx_cal_cif      ON credit_activity_log (account_cif, ts DESC);
CREATE INDEX IF NOT EXISTS idx_cal_actor    ON credit_activity_log (actor_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_cal_module   ON credit_activity_log (module, ts DESC);
CREATE INDEX IF NOT EXISTS idx_cal_entity   ON credit_activity_log (entity_type, entity_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_cal_action   ON credit_activity_log (action, ts DESC);
CREATE INDEX IF NOT EXISTS idx_cal_ts       ON credit_activity_log (ts DESC);
