-- Track linkage between O3C workspace records and Udara360 CBS account numbers.
-- Each row maps a local entity (loan, customer, FD, card) to its CBS counterpart
-- so O3C can look up the CBS account number for real-time syncs without re-querying.
CREATE TABLE IF NOT EXISTS cbs_links (
    id               BIGSERIAL PRIMARY KEY,
    entity_type      TEXT NOT NULL,                   -- 'loan' | 'customer' | 'fd' | 'card' | 'savings'
    entity_id        BIGINT NOT NULL,                 -- o3c_* table row id
    cbs_account_number TEXT NOT NULL,                 -- Udara360 account/loan number
    cbs_customer_id  TEXT,                            -- Udara360 customerID (nullable)
    linked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    linked_by        BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
    notes            TEXT,
    UNIQUE (entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_cbs_links_entity ON cbs_links (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_cbs_links_account ON cbs_links (cbs_account_number);
