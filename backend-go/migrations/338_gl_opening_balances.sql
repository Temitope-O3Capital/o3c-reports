-- 338: a frozen, one-time opening-balance fact per branch as of 2026-01-01, for the
-- branch-split finance model's Equity line. A TABLE, never a view -- see below for why
-- that distinction is load-bearing here, not stylistic.
--
-- THE DATES, VERIFIED LIVE AGAINST UDARA (not our DB mirror) on 2026-10-06:
--   Loans: MIN(startDate)=MIN(approvedDate)=2026-02-09. After 2026-01-01 -- opening
--          balance is a real, exact zero, both branches.
--   Cards: no non-test activity before mid-2026 (app.card_cycle_data, a separate feed
--          entirely) -- also a real zero at 2026-01-01, both branches.
--   Fixed Deposits: MIN(commencementDate)=2025-07-09 -- real money existed before the
--          opening date. Confirmed live: exactly 13 FDs opened before 2026-01-01 are
--          still Active today (11 Head Office Branch summing 299,500,000,000 kobo =
--          N2.995bn; 2 Abuja Branch summing 1,157,369,609 kobo = N11.57m). The live API
--          total agrees with app.cbs_fixed_deposits to the kobo on both count and sum --
--          the mirror is not stale here, a DIFFERENT status filter in an earlier,
--          DB-only check had simply counted 28 by including rows Udara's own
--          accountStatus does not call still-open.
--
-- WHY THIS IS AN ESTIMATE, AND WHY THAT IS ACCEPTED RATHER THAN FIXED
-- ---------------------------------------------------------------------
-- There is no point-in-time balance for 2026-01-01 anywhere: no daily/monthly snapshot
-- table reaches back that far (the earliest, app.portfolio_daily_snapshot, starts
-- 2026-07-15), and Udara's own ledger (app.cbs_gl_postings, migration 337) only reaches
-- back to 2026-07-01 -- its own ceiling, not a filter this product applies. So "the FD
-- opening balance" here is TODAY's live principal for the 13 FDs that happen to predate
-- the opening date and remain open -- it does not account for any top-up or partial
-- liquidation between 2026-01-01 and today, because nothing records that history. This
-- was discussed explicitly and accepted: use it, flagged, rather than push the whole
-- model's start date to mid-2026 where real snapshots exist.
--
-- WHY A TABLE AND NOT A VIEW
-- ---------------------------
-- A view computing "today's principal for FDs opened before 2026-01-01" would silently
-- change the moment one of those 13 FDs matures, rolls over, or partially liquidates --
-- and a frozen historical fact that moves every time the underlying book changes is not
-- a historical fact at all, it is today's number wearing a label from the past. Seeded
-- once via ON CONFLICT DO NOTHING so re-running this migration (or a future one touching
-- the same table) can never overwrite what should never change.
--
-- WHY OPENING EQUITY IS A PLUG, NOT A REAL CAPITAL FIGURE
-- ----------------------------------------------------------
-- No share capital, reserves, or retained-earnings figure exists anywhere in this system
-- (see docs/CALL_CENTRE_HANDOVER.md-adjacent findings on app.financial_position, which
-- reports net position for the same reason). Per branch, Opening Equity here is defined
-- as that branch's own (Assets - Liabilities) at 2026-01-01 -- i.e. it exists purely so
-- Assets = Liabilities + Equity holds from day one, not because O3 actually injected that
-- amount of capital into either branch. Loans and Cards are zero at this date, so the
-- identity reduces to Equity = -(FD principal) per branch: Equity absorbs the deposit
-- liability since there is no asset yet to set it against. Every row this produces is
-- explicitly flagged is_estimated/note so nothing downstream can present it as audited.

CREATE TABLE IF NOT EXISTS gl_opening_balances (
    id              BIGSERIAL PRIMARY KEY,
    branch_name     TEXT        NOT NULL,   -- 'Head Office Branch' | 'Abuja Branch' (Udara's
                                              -- own values -- translated to Lagos/Abuja only
                                              -- at the display layer, never here)
    as_of_date      DATE        NOT NULL,
    line            TEXT        NOT NULL,   -- 'Loan Receivable' | 'Fixed Deposit Principal'
                                              -- | 'Card Receivable' | 'Opening Equity'
    side            TEXT        NOT NULL CHECK (side IN ('Asset','Liability','Equity')),
    amount_kobo     BIGINT      NOT NULL,
    is_estimated    BOOLEAN     NOT NULL DEFAULT false,
    note            TEXT        NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (branch_name, as_of_date, line)
);

COMMENT ON TABLE gl_opening_balances IS
    'Frozen per-branch opening Balance Sheet facts, seeded once by migration 338. Never '
    'written to by a live sync job -- a later maturity/rollover of the FDs behind the '
    '2026-01-01 row must NOT change it. is_estimated/note must be surfaced wherever this '
    'table is read.';

DO $$
DECLARE
    fd_rows int;
BEGIN
    IF EXISTS (SELECT 1 FROM gl_opening_balances WHERE as_of_date = DATE '2026-01-01') THEN
        RAISE NOTICE '338: 2026-01-01 opening balances already seeded, skipping (frozen fact)';
        RETURN;
    END IF;

    INSERT INTO gl_opening_balances (branch_name, as_of_date, line, side, amount_kobo, is_estimated, note)
    SELECT branch_name, DATE '2026-01-01', 'Fixed Deposit Principal', 'Liability',
           SUM(principal_kobo), true,
           'Estimated: today''s live principal_kobo for the ' || COUNT(*) ||
           ' FD(s) at this branch commenced before 2026-01-01 and still Active as of ' ||
           CURRENT_DATE || '. Udara has no ledger/snapshot history reaching back to ' ||
           '2026-01-01 (earliest: app.portfolio_daily_snapshot from 2026-07-15, ' ||
           'app.cbs_gl_postings from 2026-07-01), so this does not account for any top-up '||
           'or partial liquidation between 2026-01-01 and today. Frozen at capture time -- '||
           'this row must not be recomputed when these FDs later mature or roll over.'
      FROM cbs_fixed_deposits
     WHERE commencement_date < DATE '2026-01-01' AND status = 'Active'
     GROUP BY branch_name;

    GET DIAGNOSTICS fd_rows = ROW_COUNT;
    IF fd_rows = 0 THEN
        RAISE EXCEPTION '338: expected FD opening-balance rows (live-verified 2026-10-06: '
            '11 Head Office + 2 Abuja FDs predate 2026-01-01 and are still Active) but '
            'found none -- cbs_fixed_deposits may be empty or the sync has not run; '
            'refusing to seed a zero that would silently understate branch liabilities';
    END IF;

    -- Loans and Cards: real zero at 2026-01-01 (live-verified start dates both fall
    -- after this date). Inserted explicitly, not left absent, so a reader summing this
    -- table sees a stated zero rather than mistaking "no row" for "not yet measured".
    INSERT INTO gl_opening_balances (branch_name, as_of_date, line, side, amount_kobo, is_estimated, note)
    VALUES
        ('Head Office Branch', '2026-01-01', 'Loan Receivable', 'Asset', 0, false,
         'Real zero: live MIN(startDate)=MIN(approvedDate) across the whole loan book is 2026-02-09.'),
        ('Abuja Branch',       '2026-01-01', 'Loan Receivable', 'Asset', 0, false,
         'Real zero: live MIN(startDate)=MIN(approvedDate) across the whole loan book is 2026-02-09.'),
        ('Head Office Branch', '2026-01-01', 'Card Receivable', 'Asset', 0, false,
         'Real zero: no non-test card activity before mid-2026 (app.card_cycle_data).'),
        ('Abuja Branch',       '2026-01-01', 'Card Receivable', 'Asset', 0, false,
         'Real zero: no non-test card activity before mid-2026 (app.card_cycle_data).');

    -- Opening Equity plug per branch = that branch's own (Assets - Liabilities) at
    -- 2026-01-01, computed from the rows just inserted in this same transaction.
    INSERT INTO gl_opening_balances (branch_name, as_of_date, line, side, amount_kobo, is_estimated, note)
    SELECT branch_name, DATE '2026-01-01', 'Opening Equity', 'Equity',
           SUM(CASE WHEN side = 'Asset' THEN amount_kobo ELSE -amount_kobo END),
           true,
           'Plug, not real injected capital: branch Assets minus Liabilities at '
           '2026-01-01. No share capital/reserves figure exists anywhere in this system '
           '(see app.financial_position''s own net-position framing) -- this exists so '
           'Assets = Liabilities + Equity holds from day one per branch, nothing more. '
           'See migration 338.'
      FROM gl_opening_balances
     WHERE as_of_date = DATE '2026-01-01'
     GROUP BY branch_name;
END $$;
