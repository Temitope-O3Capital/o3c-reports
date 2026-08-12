-- 144: Close the loop between the outbound queue and the call ledger.
--
-- Problem: call_center_contacts carried last_called_at/last_disposition, but the only
-- writer was ccLogCall (the in-app "log a call" action). O3 agents dial through the
-- carrier, so real calls arrive via the Zoho Desk importer and land in helpdesk_calls
-- only. Result: all 14,709 queued contacts reported "pending / never called" while
-- 13,669 of them had in fact been dialled 97,938 times. The queue's own
-- "ORDER BY last_called_at NULLS FIRST" was therefore a no-op (the column was NULL
-- everywhere) and the summary chips read "Uncalled 14,708 / Contacted 0".
--
-- Measured before this migration: of the top 200 contacts an agent is served,
-- 176 had been called before (mean 6.2 attempts, worst 37), 6 within the last 48h.
--
-- This adds the call-derived counters, backfills them from helpdesk_calls, and indexes
-- the phone match so the Zoho importer can stamp them on every subsequent call.
-- Counters are DERIVED state (a cache of helpdesk_calls), never a second source of truth.

ALTER TABLE call_center_contacts
  ADD COLUMN IF NOT EXISTS attempts          integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS connects          integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_call_outcome text;

COMMENT ON COLUMN call_center_contacts.attempts IS
  'Total calls to this phone in helpdesk_calls (derived cache; see migration 144).';
COMMENT ON COLUMN call_center_contacts.connects IS
  'Calls with outcome=completed. attempts high + connects 0 = an exhausted number.';

-- The importer stamps by last-10-digits, so the match must be indexed on both sides.
-- helpdesk_calls already has idx_helpdesk_calls_normphone (migration 128).
CREATE INDEX IF NOT EXISTS idx_cc_contacts_normphone
  ON call_center_contacts (norm_phone(phone));

-- Serving order is "never called first, then longest-since-last-attempt", with
-- recently-dialled contacts pushed down. This index backs that scan.
CREATE INDEX IF NOT EXISTS idx_cc_contacts_serving
  ON call_center_contacts (status, last_called_at NULLS FIRST, priority, dpd DESC);

-- Backfill. Two aggregates over helpdesk_calls: totals per phone, and the most
-- recent call's timestamp+outcome. Only rows the queue has never stamped itself are
-- touched, so any disposition an agent already logged via ccLogCall survives.
WITH totals AS (
    SELECT norm_phone(customer_phone) AS np,
           COUNT(*)                                        AS n,
           COUNT(*) FILTER (WHERE outcome = 'completed')    AS conn
      FROM helpdesk_calls
     WHERE COALESCE(customer_phone, '') <> ''
     GROUP BY 1
), latest AS (
    SELECT DISTINCT ON (norm_phone(customer_phone))
           norm_phone(customer_phone) AS np,
           started_at                 AS last_at,
           NULLIF(outcome, '')        AS last_outcome
      FROM helpdesk_calls
     WHERE COALESCE(customer_phone, '') <> ''
     ORDER BY norm_phone(customer_phone), started_at DESC
)
UPDATE call_center_contacts c
   SET attempts          = t.n,
       connects          = t.conn,
       last_called_at    = l.last_at,
       last_call_outcome = l.last_outcome,
       updated_at        = NOW()
  FROM totals t
  JOIN latest l ON l.np = t.np
 WHERE t.np = norm_phone(c.phone)
   AND c.last_called_at IS NULL;   -- never clobber an agent-logged disposition
