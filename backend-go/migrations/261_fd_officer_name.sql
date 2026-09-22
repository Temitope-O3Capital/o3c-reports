-- 261 — Give fixed deposits an account officer.
--
-- Udara sends `accountOfficerName` on all 380 deposits (20 distinct officers). The loan
-- sync maps it to cbs_loans.officer_name (cbssync/sync.go:1026); the FD sync drops it, so
-- cbs_fixed_deposits has no officer column and the value survives only inside `raw`.
--
-- Consequences today:
--   • handlers/fd_book.go contains the word "officer" zero times — no officer on the
--     Deposits page, its list, its KPIs or any filter.
--   • The FD Book export has no officer column, while the loan export has `cl.officer_name`.
--   • handlers/sales.go:283 DOES attribute FD volume per officer — by reaching into
--     `f.raw->>'accountOfficerName'` directly. Someone hit this wall and dug through the
--     JSON instead of adding the column.
--
-- Officer *matching* is sound and is NOT what this fixes: app.cbs_officer_map maps all 21
-- Udara officer names to workspace users, with 100% coverage on both books (0 unmapped
-- across 52 loans and 380 deposits). This only stops the FD book throwing the name away.
--
-- Additive and reversible: one nullable column, backfilled from data already held in `raw`.
-- No row is created, deleted or otherwise altered. To undo: DROP COLUMN.

BEGIN;

ALTER TABLE app.cbs_fixed_deposits
    ADD COLUMN IF NOT EXISTS officer_name text;

COMMENT ON COLUMN app.cbs_fixed_deposits.officer_name IS
    'Udara accountOfficerName. Join app.cbs_officer_map.udara_name to reach the workspace '
    'user. Mirrors cbs_loans.officer_name. Matching is by NAME STRING: an officer renamed '
    'in Udara, or one absent from cbs_officer_map, silently drops off the book rather than '
    'erroring. Udara publishes a proper officer master at /api/account/v1/SearchAccountOfficers '
    '(staffID, linkedUser) if this ever needs to be made robust.';

CREATE INDEX IF NOT EXISTS idx_cbs_fd_officer
    ON app.cbs_fixed_deposits (officer_name);

-- Backfill from the payload already stored. The sync is a full DELETE+reload each run, so
-- this only bridges the gap until the matching sync.go change ships; after that the column
-- is populated on insert like the loan book's.
--
-- STORED VERBATIM — do NOT btrim here. 7 of the 21 app.cbs_officer_map rows carry a
-- TRAILING SPACE ('Ojiako Ikechukwu ', 'Pinheiro Abimbola ', …) because Udara sends them
-- that way and the map was hand-seeded from those exact strings. cbs_loans.officer_name is
-- likewise verbatim (23 of its 52 rows keep the trailing space), so this matches its
-- sibling. An earlier draft of this migration DID btrim, which would have written names
-- that no longer matched the map: 98 active deposits / 6 officers / ₦11.03bn would have
-- dropped out of officer attribution silently. Joins were made trim-insensitive on both
-- sides first (sales.go, overview.go, executive.go) precisely so that a future
-- normalisation of these names is a safe, separate step rather than a silent loss.
UPDATE app.cbs_fixed_deposits
   SET officer_name = NULLIF(raw->>'accountOfficerName', '')
 WHERE officer_name IS NULL
   AND NULLIF(raw->>'accountOfficerName', '') IS NOT NULL;

COMMIT;
