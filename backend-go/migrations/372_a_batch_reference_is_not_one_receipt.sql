-- A posting reference can cover several borrowers at once, so it cannot link a receipt
-- to its application on its own.
--
-- Migration 371 joined app.v_loan_receipts on posting_reference alone. That is right for
-- a single-customer posting and WRONG for a batch: Udara posts a day's collections under
-- one reference, so BA2610030023 carries Odometa, GOKE DOUBLE AUTOS, Edgewood College and
-- a card repayment together. 91 receipts share only 73 references, up to 4 per reference.
--
-- The join therefore matched every application under a reference against every receipt
-- under it, and the view reported an arithmetic impossibility: 842,839,820.35 applied
-- against 479,560,454.22 received, a retained figure of MINUS 363,279,366.13. A receipt
-- cannot have more applied than arrived, which is what made the error obvious.
--
-- The fix is the borrower's own account, which both sides already carry:
-- app.loan_repayments.cbs_casa_account is populated on all 88 legs and is the same
-- account the journal credit lands in. Keying on (posting_reference, casa_account)
-- narrows a batch to one borrower without inventing anything.
--
-- Corrected, and the arithmetic now holds:
--
--   48 linked receipts   received 467,154,620.89   applied 430,773,154.67   retained 36,381,466.22
--   43 unlinked          received 562,810,451.66   applied         0.00     retained 562,810,451.66
--   receipts where applied > received: 0
--
-- The retained figure is the one worth reading: 36.4m arrived against facilities and was
-- not applied to them, and NASSCOOP alone is 26,888,000.89 of it.

CREATE OR REPLACE VIEW app.v_loan_receipts AS
SELECT r.id,
       r.posting_reference,
       r.financial_date,
       r.casa_account,
       r.account_name,
       r.narration,
       r.amount_kobo                                   AS received_kobo,
       COALESCE(a.applied_kobo, 0)                     AS applied_kobo,
       r.amount_kobo - COALESCE(a.applied_kobo, 0)     AS retained_kobo,
       a.loan_accounts,
       (a.applied_kobo IS NOT NULL)                    AS linked_to_a_loan
  FROM app.cbs_journal_receipts r
  LEFT JOIN LATERAL (
       SELECT SUM(lr.amount_kobo)                              AS applied_kobo,
              string_agg(DISTINCT lr.cbs_loan_account, ', ')   AS loan_accounts
         FROM app.loan_repayments lr
        WHERE lr.source_posting_reference = r.posting_reference
          -- The borrower's own account, so a batch reference resolves to one customer.
          AND lr.cbs_casa_account         = r.casa_account
  ) a ON true;

COMMENT ON VIEW app.v_loan_receipts IS
  'Per receipt: what arrived, what Udara applied to a facility, and what stayed in the borrower''s account. Linked on posting reference AND the borrower''s CASA account, because one reference can cover a whole batch of borrowers. linked_to_a_loan false means no loan leg cites this receipt for this account — money received that Udara has not applied, reported rather than guessed at.';

-- The arithmetic the join must satisfy. Asserted here so a future change to the linkage
-- cannot quietly reintroduce the over-match that this migration exists to fix.
DO $$
DECLARE
  bad bigint;
  worst numeric;
BEGIN
  SELECT COUNT(*), COALESCE(MIN(retained_kobo), 0) INTO bad, worst
    FROM app.v_loan_receipts WHERE applied_kobo > received_kobo;

  IF bad > 0 THEN
    RAISE EXCEPTION
      '% receipt(s) report more applied than received (worst retained % kobo) — the receipt-to-application linkage is over-matching again',
      bad, worst;
  END IF;

  RAISE NOTICE 'receipt linkage holds: no receipt has more applied than it received';
END $$;
