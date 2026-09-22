-- 264 — Correct migration 262: it netted the uploaded loan book against UNAPPROVED money.
--
-- MY ERROR, recorded plainly. Migration 262 reproduced migration 222's netting formula
-- verbatim, including its `SELECT account_cif, SUM(amount_kobo) FROM app.collection_payments`
-- with **no status filter**. That was correct in 222's day but is not correct now:
-- app.collection_payments carries an approval chain (HOP -> COO -> CFO) and the GL post
-- happens only at final approval. Today the ledger holds
--     approved     1801 rows  N1,094,578,699.07
--     pending_hop    11 rows  N  106,393,555.56
-- so 262 credited borrowers with N106.4m that finance has not signed off, writing their
-- outstanding balances DOWN.
--
-- Measured effect of 262 (applied 2026-09-21 12:09:06):
--     10 active uploaded-loan rows written down
--     book N857,500,134.66 -> N755,706,579.10, understated by N101,793,555.56
--     e.g. W000000000000022 N60m -> N19m, W000000000000041 N60m -> N34m
-- (The remaining N4.6m of the N106.4m lands on superseded or non-active rows.)
--
-- This migration re-nets using approved receipts only. It now matches the handler:
-- handlers/collections.go:183 filters `SUM(amount_kobo) FILTER (WHERE status='approved')`,
-- so the recurring refresh and this correction converge rather than fight — the same
-- discipline migration 258 used. Unapproved money is not discarded; it is surfaced
-- separately as pending across the collections surfaces, and never nets a balance.
--
-- `status = 'approved'` deliberately, not `!= 'pending_hop'`: a future 'rejected' row must
-- count as neither paid nor pending.
--
-- Idempotent: running it twice changes nothing.
-- Expected: 10 rows change; active uploaded book N755,706,579.10 -> N857,500,134.66.

BEGIN;

-- Capture the rows 262 closed BEFORE the netting below rewrites their updated_at —
-- otherwise the timestamp window can no longer identify them. Verified: exactly one row,
-- id 1747 (W000000000000022, approved N80,000,000), closed because unapproved money took
-- it to zero. Under approved-only netting it carries N4,600,000 again, so a live debt is
-- currently sitting closed in the collections queue.
CREATE TEMP TABLE closed_by_262 ON COMMIT DROP AS
SELECT id
  FROM app.collection_assignments
 WHERE data_source = 'manual' AND product_type = 'loan'
   AND status = 'closed'
   AND updated_at >= TIMESTAMPTZ '2026-09-21 12:09:00+01'
   AND updated_at <  TIMESTAMPTZ '2026-09-21 12:10:00+01';

WITH cif_paid AS (
    SELECT account_cif, SUM(amount_kobo) AS paid
      FROM app.collection_payments
     WHERE status = 'approved'
     GROUP BY 1
), al AS (
    SELECT a.id,
           COALESCE(a.target_amount_kobo, a.original_outstanding_kobo, 0) AS approved,
           COALESCE(p.paid, 0) AS pool,
           COALESCE(SUM(COALESCE(a.target_amount_kobo, a.original_outstanding_kobo, 0)) OVER (
               PARTITION BY a.account_cif
               ORDER BY a.disbursement_date ASC NULLS LAST, a.id ASC
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS claimed_before
      FROM app.collection_assignments a
      LEFT JOIN cif_paid p ON p.account_cif = a.account_cif
     WHERE a.data_source = 'manual' AND a.product_type = 'loan'
), netted AS (
    SELECT id,
           GREATEST(approved - LEAST(approved, GREATEST(pool - claimed_before, 0)), 0) AS outstanding
      FROM al
)
UPDATE app.collection_assignments a
   SET outstanding_kobo = n.outstanding, updated_at = NOW()
  FROM netted n
 WHERE a.id = n.id
   AND a.outstanding_kobo IS DISTINCT FROM n.outstanding;

-- 262's close rule fired on a facility that only reached zero because unapproved money was
-- counted. Reopen any row 262 closed that now carries a balance again, so a live debt is not
-- left closed on the strength of an unapproved receipt. Driven off the captured id list,
-- because the netting above has already rewritten updated_at.
UPDATE app.collection_assignments a
   SET status = 'active', updated_at = NOW()
  FROM closed_by_262 c
 WHERE a.id = c.id
   AND a.status = 'closed'
   AND a.outstanding_kobo > 0;

COMMIT;
