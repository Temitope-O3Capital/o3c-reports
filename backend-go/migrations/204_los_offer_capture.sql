-- Offer & acceptance CAPTURE.
--
-- Phoenix is the system of record for the offer/acceptance step; the workspace (CRM)
-- can ALSO capture it. This is capture-only: these columns record the offer and its
-- acceptance but do NOT add a pipeline stage and do NOT gate booking. `offer_source`
-- says who captured it ('crm' when recorded in the workspace, 'phoenix' when mirrored
-- from Phoenix), so both paths land in the same place and neither overwrites the other
-- blindly.

ALTER TABLE app.loan_applications
    ADD COLUMN IF NOT EXISTS offer_status         TEXT NOT NULL DEFAULT 'none',  -- none|issued|accepted|declined|expired
    ADD COLUMN IF NOT EXISTS offered_amount_kobo  BIGINT,
    ADD COLUMN IF NOT EXISTS offered_rate_bps     INTEGER,
    ADD COLUMN IF NOT EXISTS offered_tenor_months INTEGER,
    ADD COLUMN IF NOT EXISTS offer_issued_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS offer_accepted_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS offer_expires_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS offer_source         TEXT,                          -- crm|phoenix
    ADD COLUMN IF NOT EXISTS offer_ref            TEXT,
    ADD COLUMN IF NOT EXISTS offer_note           TEXT;
