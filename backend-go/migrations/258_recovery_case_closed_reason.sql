-- 258: record WHY a recovery case was closed.
--
-- recovery_cases carries closed_at but no reason and no notes column, so a closed case
-- says when it ended and nothing about why. That is tolerable while the only exit is a
-- write-off approval (there is an approval trail elsewhere), but it blocks the fix that
-- matters: nothing currently closes a case when the debt is CURED.
--
-- Why that matters. The nightly escalation moves an account out of the collections queue
-- whenever an open recovery case exists. Because no cure ever closes a case, that exit
-- was permanent — 558 open cases belong to customers with no delinquency at all, and
-- 581 assignments sit in sent_to_recovery below 90 DPD. Migration 257 and the DPD guard
-- in escalateSevereToRecovery stop the queue draining further; closing cured cases is
-- what lets those accounts come BACK. A status flip with no stated reason would be
-- indistinguishable from a human closing the case, so give it somewhere to say so first.
--
-- Additive and nullable: no existing row changes, no reader breaks.

ALTER TABLE app.recovery_cases
  ADD COLUMN IF NOT EXISTS closed_reason TEXT;

COMMENT ON COLUMN app.recovery_cases.closed_reason IS
  'Why the case was closed: ''cured'' (no delinquency remains), ''written_off'', ''recovered'', or free text for a manual closure. NULL for cases closed before migration 258.';

-- Partial index for the cure sweep and for "how did cases end" reporting, both of which
-- filter on open-vs-closed rather than scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_recovery_cases_open_cif
  ON app.recovery_cases (account_cif)
  WHERE status NOT IN ('closed', 'recovered', 'written_off');
