-- 107: Interswitch transaction table for persisting EODTXN CCS Report 620 imports.
CREATE TABLE IF NOT EXISTS interswitch_txns (
    id             BIGSERIAL PRIMARY KEY,
    trace_num      TEXT        NOT NULL DEFAULT '',
    auth_num       TEXT        NOT NULL DEFAULT '',
    card_num       TEXT        NOT NULL DEFAULT '',
    txn_code       TEXT        NOT NULL DEFAULT '',
    txn_date       DATE        NOT NULL,
    merchant_id    TEXT        NOT NULL DEFAULT '',
    amount_kobo    BIGINT      NOT NULL DEFAULT 0,
    sign           TEXT        NOT NULL DEFAULT '',   -- DR or CR
    currency       TEXT        NOT NULL DEFAULT '',
    merchant_name  TEXT        NOT NULL DEFAULT '',
    description    TEXT        NOT NULL DEFAULT '',
    account_no     TEXT        NOT NULL DEFAULT '',
    cif            TEXT        NOT NULL DEFAULT '',
    product_code   TEXT        NOT NULL DEFAULT '',
    product_name   TEXT        NOT NULL DEFAULT '',
    branch_code    TEXT        NOT NULL DEFAULT '',
    branch_name    TEXT        NOT NULL DEFAULT '',
    imported_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_is_txns_date    ON interswitch_txns(txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_is_txns_branch  ON interswitch_txns(branch_code, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_is_txns_product ON interswitch_txns(product_code, txn_date DESC);
