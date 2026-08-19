-- Migration 161: Cards as a first-class Sales target, and the commission-rate config.
--
-- Sales works three product lines; targets covered only Loans and Fixed Deposit
-- (loan_count/disbursement_kobo, fd_count/fd_amount_kobo). Cards had no target.
-- Cards are counted (issuance count) rather than valued, so a single count target.
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS card_count INT NOT NULL DEFAULT 0;

-- Commission rates, set by Finance. Decision (2026-08-18): % per product line, with
-- cards paid as a fixed amount per card issued (prepaid cards carry no booked value).
--   loans / fixed_deposit -> basis 'percent', rate_bps in basis points (150 = 1.50%)
--   cards                 -> basis 'per_card', amount_kobo per activated card
CREATE TABLE IF NOT EXISTS sales_commission_rates (
    line        TEXT PRIMARY KEY,          -- 'loans' | 'fixed_deposit' | 'cards'
    basis       TEXT   NOT NULL,           -- 'percent' | 'per_card'
    rate_bps    INT    NOT NULL DEFAULT 0, -- basis points, for basis='percent'
    amount_kobo BIGINT NOT NULL DEFAULT 0, -- kobo per card, for basis='per_card'
    updated_by  BIGINT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the three lines with zero rates so Finance just edits values (no inserts).
INSERT INTO sales_commission_rates (line, basis) VALUES
    ('loans',         'percent'),
    ('fixed_deposit', 'percent'),
    ('cards',         'per_card')
ON CONFLICT (line) DO NOTHING;
