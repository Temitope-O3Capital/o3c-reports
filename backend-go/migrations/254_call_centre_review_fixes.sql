-- 254: schema half of the September 2026 call-centre review fixes.
--
-- Five independent changes, each idempotent so a re-run is a no-op:
--   1. dnc_list stores one canonical phone form, with a unique index on it.
--   2. call_center_contacts gains lead_id, so a queue call can qualify a lead.
--   3. call_center_leads gains the attempt counters the queue already has.
--   4. helpdesk_calls loses three indexes that exactly duplicate another.
--   5. helpdesk_calls.session_id becomes a real, unique column.
--
-- The code half lands with it: the Go handlers compare phones through
-- app.norm_phone() on BOTH sides from now on, which only works because of (1).
--
-- NOTE on app.norm_phone (migration 128): it is `right(digits_only, 10)` — the
-- LAST TEN DIGITS, and it returns '' (never NULL) for input it cannot parse.
-- So validity is tested as `length(app.norm_phone(x)) = 10`, never `IS NOT NULL`,
-- which would be true for every row and would happily match one blank phone to
-- another. Migration 252 uses the same `<> ''` convention.

-- ── 1. Do Not Call: one canonical form ───────────────────────────────────────
-- The list has never suppressed anything reliably. Numbers were stored exactly as
-- typed ('+2348033153664', '08033153664') while three of the queue filters compared
-- the bare 10-digit form and two compared raw text, so a listed number stayed
-- dialable. Normalising the column is what makes the filters able to match at all.
--
-- Order matters: dedupe BEFORE normalising, or two rows that normalise to the same
-- number would collide on the existing unique constraint mid-statement.

-- Drop rows that would become duplicates once normalised, keeping the earliest
-- (its added_by/reason/added_at is the original opt-out record).
DELETE FROM app.dnc_list d
 WHERE length(app.norm_phone(d.phone)) = 10
   AND EXISTS (
     SELECT 1 FROM app.dnc_list k
      WHERE app.norm_phone(k.phone) = app.norm_phone(d.phone)
        AND length(app.norm_phone(k.phone)) = 10
        AND (k.added_at < d.added_at OR (k.added_at = d.added_at AND k.id < d.id))
   );

-- Normalise what remains. A number norm_phone cannot parse is left exactly as it
-- was rather than blanked — it is still somebody's opt-out, and the raw-equality
-- path can still match it.
UPDATE app.dnc_list
   SET phone = app.norm_phone(phone)
 WHERE length(app.norm_phone(phone)) = 10
   AND phone IS DISTINCT FROM app.norm_phone(phone);

-- Match the way every reader now queries it, and stop the same number being listed
-- twice in two formats. Partial, so unparseable entries (all of which normalise to
-- the same empty string) cannot collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dnc_list_norm_phone
    ON app.dnc_list (app.norm_phone(phone))
 WHERE length(app.norm_phone(phone)) = 10;

-- Suppression checks join dnc_list per candidate; without this they seq-scan.
CREATE INDEX IF NOT EXISTS idx_dnc_list_norm_phone
    ON app.dnc_list (app.norm_phone(phone));

-- ── 2. The queue can finally qualify a lead ──────────────────────────────────
-- call_center_contacts (the dialler queue, ~14.9k rows) and call_center_leads (the
-- lead book, ~13k) were separate books with no link: contacts carried no lead_id and
-- leads.contact_id points at crm_contacts, not here. So an agent marking "Interested"
-- in the queue changed nothing downstream — no stage move, no hand-off, no party.
ALTER TABLE app.call_center_contacts
  ADD COLUMN IF NOT EXISTS lead_id bigint REFERENCES app.call_center_leads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cc_contacts_lead
    ON app.call_center_contacts (lead_id) WHERE lead_id IS NOT NULL;

-- Backfill only where the phone match is UNAMBIGUOUS — exactly one lead on that
-- number, and the number is parseable. The same guard crmLinkLeadToContact applies:
-- a wrong link here would attribute a call, and a qualification, to the wrong person.
WITH one_lead AS (
  SELECT app.norm_phone(customer_phone) AS ph, min(id) AS lead_id
    FROM app.call_center_leads
   WHERE length(app.norm_phone(customer_phone)) = 10
   GROUP BY 1
  HAVING count(*) = 1
)
UPDATE app.call_center_contacts c
   SET lead_id = o.lead_id
  FROM one_lead o
 WHERE c.lead_id IS NULL
   AND length(app.norm_phone(c.phone)) = 10
   AND app.norm_phone(c.phone) = o.ph;

-- ── 3. Leads get the attempt discipline the queue already has ────────────────
-- The queue protects agent time and customer goodwill with a 7-day cooldown and a
-- 6-attempt cap (ccCooldownDays / ccExhaustedAttempts). The lead book had neither
-- and no counters to build them from, so a lead could be dialled without limit while
-- an unreached lead could never be redistributed.
ALTER TABLE app.call_center_leads
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS connects integer NOT NULL DEFAULT 0;

-- Seed from the call ledger, which is the record of what actually happened.
-- Recomputed (not incremented) so re-running can't inflate it — the same approach
-- ccStampQueueForPhone takes for the queue.
WITH tally AS (
  SELECT l.id,
         count(*)                                         AS attempts,
         count(*) FILTER (WHERE hc.outcome = 'completed') AS connects
    FROM app.call_center_leads l
    JOIN app.helpdesk_calls hc
      ON app.norm_phone(hc.customer_phone) = app.norm_phone(l.customer_phone)
     AND length(app.norm_phone(hc.customer_phone)) = 10
     AND hc.direction = 'outbound'
     AND hc.voided_at IS NULL
     AND hc.merged_into_call_id IS NULL
   WHERE length(app.norm_phone(l.customer_phone)) = 10
   GROUP BY l.id
)
UPDATE app.call_center_leads l
   SET attempts = t.attempts, connects = t.connects
  FROM tally t
 WHERE l.id = t.id
   AND (l.attempts, l.connects) IS DISTINCT FROM (t.attempts, t.connects);

-- A status nothing recognises makes a lead vanish from every filter and count while
-- still sitting in an agent's book. ccUpdateLead writes this column straight from the
-- request body, so the constraint is the only thing that can stop a typo.
-- Coerce anything unexpected first, then constrain.
UPDATE app.call_center_leads
   SET status = 'pending'
 WHERE status IS NULL
    OR status NOT IN ('pending','called','interested','not_ready','callback',
                      'no_answer','converted','closed','invalid','dnc');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_center_leads_status_chk') THEN
    ALTER TABLE app.call_center_leads
      ADD CONSTRAINT call_center_leads_status_chk CHECK (status IN (
        'pending','called','interested','not_ready','callback',
        'no_answer','converted','closed','invalid','dnc'));
  END IF;
END $$;

-- ── 4. Duplicate indexes on the busiest table ────────────────────────────────
-- helpdesk_calls (171k rows, growing ~1.6k/day) carried three pairs of identical
-- indexes — each pair costing a second write on every insert and update for no read
-- benefit. Keeping the later, better-named one of each pair:
--   idx_hd_calls_zoho_id       == idx_hd_calls_zoho_call          (unique, zoho_call_id)
--   idx_helpdesk_calls_agent   == idx_helpdesk_calls_agent_started
--   idx_helpdesk_calls_started == idx_helpdesk_calls_started_at
DROP INDEX IF EXISTS app.idx_hd_calls_zoho_id;
DROP INDEX IF EXISTS app.idx_helpdesk_calls_agent;
DROP INDEX IF EXISTS app.idx_helpdesk_calls_started;

-- ── 5. session_id becomes real ───────────────────────────────────────────────
-- The Africa's Talking webhook created this column at runtime, on the hot path of
-- every inbound call (an ACCESS EXCLUSIVE lock on this table per call), and nothing
-- enforced uniqueness — so a webhook retry inserted a second ticket and a second call
-- row, and the later call-end update then matched both.
ALTER TABLE app.helpdesk_calls ADD COLUMN IF NOT EXISTS session_id text;

-- Clear duplicates before the unique index, keeping the earliest row per session.
UPDATE app.helpdesk_calls d
   SET session_id = NULL
 WHERE d.session_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM app.helpdesk_calls k
                WHERE k.session_id = d.session_id AND k.id < d.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_helpdesk_calls_session
    ON app.helpdesk_calls (session_id) WHERE session_id IS NOT NULL;

-- ── 6. A queue call can record its disposition even with no lead ─────────────
-- call_center_dispositions.lead_id has been NOT NULL since migration 040, when this
-- table only ever described lead calls. The Performance screens read it exclusively,
-- so making the queue write dispositions only half-works: a contact that happens to
-- be linked to a lead is recorded, and every other queue call stays invisible —
-- which is the "Performance and the Call Log can't reconcile" defect, one layer down.
-- The queue's own identity is the contact, so the row must be able to hang off either.
ALTER TABLE app.call_center_dispositions ALTER COLUMN lead_id DROP NOT NULL;

ALTER TABLE app.call_center_dispositions
  ADD COLUMN IF NOT EXISTS contact_id bigint REFERENCES app.call_center_contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cc_dispositions_contact
    ON app.call_center_dispositions (contact_id) WHERE contact_id IS NOT NULL;

-- A disposition naming neither a lead nor a contact is unattributable — it would
-- count towards an agent's figures while belonging to nobody. Every existing row has
-- a lead_id, so this is satisfied from the moment it is added.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_center_dispositions_subject_chk') THEN
    ALTER TABLE app.call_center_dispositions
      ADD CONSTRAINT call_center_dispositions_subject_chk
      CHECK (lead_id IS NOT NULL OR contact_id IS NOT NULL);
  END IF;
END $$;
