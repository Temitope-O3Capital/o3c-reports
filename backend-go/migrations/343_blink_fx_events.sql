-- 343: Blink's FX pipeline — a place to record a funding/fee/sale event with the rate
-- it actually happened at, since Udara stores no such number anywhere structurally.
--
-- The only place a rate exists at all is free-text GL narration on the BlueSalt/DT&T
-- wallet accounts (10204032 BLUSALT NGN WALLET, 10204033 BLUSALT USD WALLET, 10204045
-- BLUSALT BLINK WALLET, 10103005 DT AND T WALLET - POUNDS), and it is genuinely messy:
-- "Mastercard Funding: $600 at N1,400: Ayodele Abiola", "Masfercard Funding: $5 at
-- N1,400: Nosakhare Ebueku" (typo, in production), "Wallet funding 40,000GBP at
-- N1,890: HUNTZBERGER SYNERGY LTD", alongside internal transfers with no rate at all
-- ("GT Current to Blink Wallet", "Fidelity Project to Blusalt") and debit/credit sides
-- that do NOT reliably mean funding-in vs sale-out (a "Blink Wallet Funding" debit is
-- O3's own internal top-up, not a customer event). The only reliable signal is whether
-- the narration contains a parseable "$X at/@ NY" (or GBP equivalent) pattern at all —
-- see cbssync/blink_fx_parse.go. A row without one is left uncaptured, never guessed.
CREATE TABLE IF NOT EXISTS blink_fx_events (
    id              BIGSERIAL PRIMARY KEY,
    event_type      TEXT NOT NULL CHECK (event_type IN ('funding','sale','fee')),
    currency        TEXT NOT NULL,
    fx_amount       NUMERIC(18,2) NOT NULL,
    ngn_amount_kobo BIGINT NOT NULL,
    rate            NUMERIC(14,4) NOT NULL,
    rate_source     TEXT NOT NULL CHECK (rate_source IN ('narration','parallel_market','manual')),
    branch_name     TEXT,
    gl_posting_id   BIGINT REFERENCES cbs_gl_postings(id),
    occurred_at     TIMESTAMPTZ NOT NULL,
    notes           TEXT,
    status          TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected')),
    initiated_by    BIGINT REFERENCES o3c_users(id),
    initiated_by_name TEXT,
    approved_by     BIGINT REFERENCES o3c_users(id),
    approved_by_name  TEXT,
    rejection_reason  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- A parsed row is keyed to the exact posting it came from, so re-running the parser
    -- over an overlapping window is a no-op rather than a duplicate. A manual entry
    -- (gl_posting_id NULL) has no such natural key and is simply never deduped.
    UNIQUE (gl_posting_id)
);

CREATE INDEX IF NOT EXISTS idx_blink_fx_events_type     ON blink_fx_events(event_type);
CREATE INDEX IF NOT EXISTS idx_blink_fx_events_currency ON blink_fx_events(currency, occurred_at);
CREATE INDEX IF NOT EXISTS idx_blink_fx_events_status   ON blink_fx_events(status);

COMMENT ON TABLE blink_fx_events IS
    'Blink FX funding/fee/sale events with the rate each happened at. Parsed, best-effort, '
    'from GL narration (rate_source=narration) where cbssync/blink_fx_parse.go finds a '
    'genuine $X-at-NY pattern; everything else is a manual entry (rate_source=manual) or a '
    'recorded sale using the parallel-market reference rate (rate_source=parallel_market). '
    'Realized gain/loss on a sale is computed against the weighted-average booking rate of '
    'unsold funding events for that currency — see blink_finance.go.';
