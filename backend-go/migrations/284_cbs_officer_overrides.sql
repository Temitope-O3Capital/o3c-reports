-- 284 — make the loan/FD account officer correctable.
--
-- ── THE GAP ──────────────────────────────────────────────────────────────────
--
-- Two different things are called "the account officer" in this workspace and only
-- one of them could be fixed.
--
--   Cards / relationship book — app.customer_officers. Editable from the CRM via
--   /api/sales/book/assign, with history. Migration 283 stopped the CBS sync from
--   overwriting a manual correction there.
--
--   Loan and FD book — NOT editable at all. Every officer figure on the deposit and
--   loan side resolves through app.cbs_officer_map: Udara's accountOfficerName on
--   the record, crosswalked to a workspace user. That drives Top Performers, the FD
--   book's by-officer split, executive deposit concentration, account alerts, the
--   CBS reports and sales targets — i.e. commission.
--
-- If Udara has a deposit on the wrong officer there is no way to correct it:
--   * Udara's API cannot change it. Probed 2026-09-23 — the officer lives on the
--     loan/FD ACCOUNT as accountOfficerCode/accountOfficerName, the customer record
--     has no officer field at all, and the only write endpoints that exist are
--     createcustomeraccount, updatecustomeraccount, loanaccount/add,
--     loanaccount/disburseloan and fixeddepositaccount/add. There is no update
--     endpoint for a loan or FD account.
--   * Editing app.cbs_officer_map is not a fix — it is a NAME crosswalk, so
--     repointing a name moves every one of that officer's records at once.
--
-- ── WHAT THIS ADDS ───────────────────────────────────────────────────────────
--
-- app.cbs_officer_overrides — a workspace-side correction, at one of two grains:
--     scope='fd'    / scope='loan'  → one account, keyed on cbs_account_number
--     scope='party' → every loan and FD of one customer, keyed on party_id
--
-- and two resolver views, app.v_loan_officer / app.v_fd_officer, which apply the
-- precedence in ONE place so no caller can implement it differently:
--
--     account override  >  party override  >  Udara's own name via cbs_officer_map
--
-- The override is deliberately NOT written back to Udara — the API cannot accept it
-- (above), and a workspace correction that silently diverged from the core banking
-- record would be worse than a visible one. officer_source on the view says which
-- rule fired, so a screen can show that a figure has been corrected and by whom.
--
-- Nothing is destroyed: removing an override restores Udara's own answer exactly.

BEGIN;

CREATE TABLE IF NOT EXISTS app.cbs_officer_overrides (
    id              bigserial PRIMARY KEY,
    -- 'loan' and 'fd' key on cbs_account_number (unique on both tables: 52/52 and
    -- 383/383). 'party' keys on app.customers.party_id as text — the workspace
    -- customer id, resolved through app.cbs_links, which is 1:1 on
    -- (entity_type='party', cbs_customer_id) across all 295 rows so it cannot fan out.
    scope           text   NOT NULL CHECK (scope IN ('loan', 'fd', 'party')),
    scope_key       text   NOT NULL CHECK (btrim(scope_key) <> ''),
    officer_user_id bigint NOT NULL REFERENCES app.o3c_users(id),
    -- Required, not optional. An officer correction moves commission; "who changed
    -- this and why" must be answerable a year later without asking anyone.
    reason          text   NOT NULL CHECK (btrim(reason) <> ''),
    created_by      bigint REFERENCES app.o3c_users(id),
    created_at      timestamptz NOT NULL DEFAULT NOW(),
    updated_at      timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE (scope, scope_key)
);

COMMENT ON TABLE app.cbs_officer_overrides IS
    'Workspace-side correction of the account officer on a Udara loan/FD record. Udara''s '
    'API cannot change an account officer, so this is the only place a wrong one can be '
    'fixed. Read it through app.v_loan_officer / app.v_fd_officer, never directly — those '
    'views own the precedence (account > party > Udara).';

CREATE INDEX IF NOT EXISTS idx_cbs_officer_overrides_officer
    ON app.cbs_officer_overrides (officer_user_id);

-- Every change kept, including removals, because this moves commission.
CREATE TABLE IF NOT EXISTS app.cbs_officer_override_history (
    id              bigserial PRIMARY KEY,
    scope           text NOT NULL,
    scope_key       text NOT NULL,
    from_officer_id bigint,
    to_officer_id   bigint,          -- NULL = override removed, back to Udara's answer
    reason          text,
    changed_by      bigint REFERENCES app.o3c_users(id),
    changed_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cbs_officer_override_hist_key
    ON app.cbs_officer_override_history (scope, scope_key, changed_at DESC);

-- ── Resolvers ────────────────────────────────────────────────────────────────
--
-- officer_name is now a real column on both tables and is populated on every row
-- (52/52 loans, 383/383 FDs) and agrees with raw->>'accountOfficerName' on every
-- one — this is the switch point fd_book.go anticipated, so the views read the
-- column rather than digging into raw.
--
-- btrim on BOTH sides of the crosswalk, deliberately: Udara pads 7 of the 21
-- officer names with a trailing space and app.cbs_officer_map was hand-seeded from
-- those exact strings. Trimming one side only silently drops 173 of 380 deposits
-- (₦11.03bn) out of officer attribution. Trimming both is identical today and
-- survives a later normalisation.
--
-- The party lookup is a scalar subquery, not a join, so it cannot duplicate a row
-- even if app.cbs_links ever stops being 1:1.

CREATE OR REPLACE VIEW app.v_fd_officer AS
SELECT f.cbs_id,
       f.cbs_account_number,
       f.cbs_customer_id,
       btrim(f.officer_name)                                   AS udara_officer_name,
       COALESCE(oa.officer_user_id, op.officer_user_id, m.officer_user_id) AS officer_user_id,
       COALESCE(NULLIF(btrim(u.full_name), ''),
                NULLIF(btrim(f.officer_name), ''), 'Unassigned') AS officer_label,
       CASE WHEN oa.officer_user_id IS NOT NULL THEN 'override_account'
            WHEN op.officer_user_id IS NOT NULL THEN 'override_party'
            WHEN m.officer_user_id  IS NOT NULL THEN 'udara'
            ELSE 'unmapped' END                                AS officer_source,
       COALESCE(oa.reason, op.reason)                          AS override_reason
  FROM app.cbs_fixed_deposits f
  LEFT JOIN app.cbs_officer_overrides oa
         ON oa.scope = 'fd' AND oa.scope_key = f.cbs_account_number
  LEFT JOIN app.cbs_officer_overrides op
         ON op.scope = 'party'
        AND op.scope_key = (SELECT k.entity_id::text FROM app.cbs_links k
                             WHERE k.entity_type = 'party'
                               AND k.cbs_customer_id = f.cbs_customer_id LIMIT 1)
  LEFT JOIN app.cbs_officer_map m ON btrim(m.udara_name) = btrim(f.officer_name)
  LEFT JOIN app.o3c_users u
         ON u.id = COALESCE(oa.officer_user_id, op.officer_user_id, m.officer_user_id);

COMMENT ON VIEW app.v_fd_officer IS
    'Resolved account officer for every Udara fixed deposit: account override > party '
    'override > Udara''s own accountOfficerName via app.cbs_officer_map. officer_source '
    'says which rule fired. Join on cbs_id (or cbs_account_number) — one row per deposit.';

CREATE OR REPLACE VIEW app.v_loan_officer AS
SELECT l.cbs_id,
       l.cbs_account_number,
       l.cbs_customer_id,
       btrim(l.officer_name)                                   AS udara_officer_name,
       COALESCE(oa.officer_user_id, op.officer_user_id, m.officer_user_id) AS officer_user_id,
       COALESCE(NULLIF(btrim(u.full_name), ''),
                NULLIF(btrim(l.officer_name), ''), 'Unassigned') AS officer_label,
       CASE WHEN oa.officer_user_id IS NOT NULL THEN 'override_account'
            WHEN op.officer_user_id IS NOT NULL THEN 'override_party'
            WHEN m.officer_user_id  IS NOT NULL THEN 'udara'
            ELSE 'unmapped' END                                AS officer_source,
       COALESCE(oa.reason, op.reason)                          AS override_reason
  FROM app.cbs_loans l
  LEFT JOIN app.cbs_officer_overrides oa
         ON oa.scope = 'loan' AND oa.scope_key = l.cbs_account_number
  LEFT JOIN app.cbs_officer_overrides op
         ON op.scope = 'party'
        AND op.scope_key = (SELECT k.entity_id::text FROM app.cbs_links k
                             WHERE k.entity_type = 'party'
                               AND k.cbs_customer_id = l.cbs_customer_id LIMIT 1)
  LEFT JOIN app.cbs_officer_map m ON btrim(m.udara_name) = btrim(l.officer_name)
  LEFT JOIN app.o3c_users u
         ON u.id = COALESCE(oa.officer_user_id, op.officer_user_id, m.officer_user_id);

COMMENT ON VIEW app.v_loan_officer IS
    'Resolved account officer for every Udara loan: account override > party override > '
    'Udara''s own accountOfficerName via app.cbs_officer_map. officer_source says which '
    'rule fired. Join on cbs_id (or cbs_account_number) — one row per loan.';

COMMIT;
