-- Make settled exception work attributable, backwards as well as forwards.
--
-- app.recon_exceptions carried assigned_to NULL on all 24,100 rows. The queue is
-- worked by whoever opens it, and only an explicit assignment ever wrote the column,
-- which nobody had used. The staff performance survey therefore reported Settlement
-- as unmeasurable — not because nothing was done there, but because nothing recorded
-- who did it.
--
-- handlers/recon_ops.go now sets assigned_to from the resolver when nobody held the
-- item, so this gap closes going forward. This migration closes it backwards, for the
-- rows that already carry a resolver.
--
-- IT DOES NOT INVENT AN OWNER. Only rows with a real resolved_by are touched: that
-- person demonstrably did the work, so crediting them is recording a fact rather than
-- guessing. The 12,363 exceptions closed by the supersede sweep carry no resolved_by
-- and are deliberately LEFT unassigned — a batch job is not a person, and attributing
-- its output to somebody would put thousands of items of fictional credit into the
-- first performance figure anyone reads.

DO $$
DECLARE
  eligible bigint;
  updated  bigint;
  machine  bigint;
BEGIN
  SELECT COUNT(*) INTO eligible
    FROM app.recon_exceptions
   WHERE assigned_to IS NULL AND resolved_by IS NOT NULL;

  SELECT COUNT(*) INTO machine
    FROM app.recon_exceptions
   WHERE assigned_to IS NULL AND resolved_by IS NULL AND resolved_at IS NOT NULL;

  UPDATE app.recon_exceptions
     SET assigned_to = resolved_by
   WHERE assigned_to IS NULL AND resolved_by IS NOT NULL;

  GET DIAGNOSTICS updated = ROW_COUNT;

  IF updated <> eligible THEN
    RAISE EXCEPTION
      'backfill touched % rows but % were eligible — refusing to leave settlement attribution half-written',
      updated, eligible;
  END IF;

  RAISE NOTICE
    'settlement attribution: % exception(s) credited to their resolver; % closed without a person left unassigned on purpose',
    updated, machine;
END $$;

-- Reading "who worked this queue" is now a real query, so give it an index. Partial,
-- because the rows that matter are the ones with an owner.
CREATE INDEX IF NOT EXISTS idx_recon_exceptions_assigned
  ON app.recon_exceptions (assigned_to, resolved_at DESC)
  WHERE assigned_to IS NOT NULL;

COMMENT ON COLUMN app.recon_exceptions.assigned_to IS
  'Who owns the item. Set explicitly on assignment, or filled in from resolved_by when an unassigned item is resolved. NULL means nobody held it — including the supersede sweep''s output, which has no person behind it.';
