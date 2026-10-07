-- Manual postings: say WHY the entry exists, and what a reversal reverses.
--
-- app.manual_postings has never held a row. The workflow around it is real —
-- initiate, approve or return or reject, post, with a full audit column set — but
-- there was no path into it from the work that would produce one. A settlement
-- break that needs a correcting entry is a recon exception, and nothing connected
-- the two, so raising a posting meant retyping an account pair and a narrative
-- from a different screen and leaving no trace of which break it answered.
--
-- recon_exception_id closes that loop: a posting can be raised FROM an exception,
-- and the exception can then show the posting that corrects it.
ALTER TABLE app.manual_postings
  ADD COLUMN IF NOT EXISTS recon_exception_id bigint
    REFERENCES app.recon_exceptions(id) ON DELETE SET NULL;

-- reverses_posting_id is the other missing half. The table already carried
-- reversal_requested_by / reversal_requested_at / reversal_reason, so a reversal
-- was clearly intended, but no endpoint ever wrote them and nothing recorded WHICH
-- entry a reversal cancels. A reversal is itself a posting — same maker-checker
-- path, DR and CR swapped — and this is the link back to the entry it undoes.
ALTER TABLE app.manual_postings
  ADD COLUMN IF NOT EXISTS reverses_posting_id bigint
    REFERENCES app.manual_postings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_manual_postings_exception
  ON app.manual_postings (recon_exception_id)
  WHERE recon_exception_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_manual_postings_reverses
  ON app.manual_postings (reverses_posting_id)
  WHERE reverses_posting_id IS NOT NULL;

-- An entry may be reversed once. Without this, two approvers racing the same
-- posted entry both create a reversal and the account pair is corrected twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_postings_one_reversal
  ON app.manual_postings (reverses_posting_id)
  WHERE reverses_posting_id IS NOT NULL;

COMMENT ON COLUMN app.manual_postings.recon_exception_id IS
  'The reconciliation exception this entry corrects, when it was raised from one.';
COMMENT ON COLUMN app.manual_postings.reverses_posting_id IS
  'The posted entry this entry reverses. Unique: an entry can be reversed once.';
