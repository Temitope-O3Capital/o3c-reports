-- 259_recovery_card_recovered_backfill.sql
-- Card recovery cases were left with recovered_kobo = 0 despite holding approved
-- recovery_payments. Those card payments were seeded/imported directly as
-- status='approved' and so bypassed recovery_ops.go's approval path — the ONLY code
-- that credits recovered_kobo (and total_recovered_kobo) when a payment reaches final
-- (CFO) approval. Loan cases were seeded with their case totals already correct; only
-- card cases diverged, which is why the recovery KPIs (Success Rate, Recovered
-- All-Time) and the by-product split read as if only loans were ever recovered.
--
-- Backfill recovered_kobo / total_recovered_kobo to the sum of each case's
-- approved/posted payments, but ONLY where the stored figure is LOWER than the ledger,
-- so this can only ever RAISE a case's recovered figure to match money actually
-- received — never lower one credited by another path (debt sale, historical
-- total_recovered_kobo). Verified against current data: 86 card cases affected,
-- +NGN 36,658,435.55 total; zero cases have recovered_kobo above their ledger, so
-- nothing is reduced. Idempotent: a second run matches nothing.
--
-- Forward-only, like 091_db_fixes_batch2.sql (which backfilled this same column): there
-- is no rollback file — you would not un-credit received money.
UPDATE app.recovery_cases rc
SET recovered_kobo       = p.paid,
    total_recovered_kobo = GREATEST(COALESCE(rc.total_recovered_kobo, 0), p.paid),
    updated_at           = NOW()
FROM (
    SELECT case_id, SUM(amount_kobo) AS paid
    FROM app.recovery_payments
    WHERE status IN ('approved', 'posted')
    GROUP BY case_id
) p
WHERE rc.id = p.case_id
  AND COALESCE(rc.recovered_kobo, 0) < p.paid;
