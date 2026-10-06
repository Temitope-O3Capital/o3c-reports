-- 345 — A segment can keep itself current, a list can say how it may be contacted, and
-- "reachable" has one definition instead of three. @nonblocking: additive only.
--
-- No \set or \echo in this file. Migrations are //go:embed-ed and run by the Go runner,
-- which speaks SQL and not psql's meta-command language: a leading backslash is a server
-- syntax error (42601), and a failed migration exits the process into a restart loop.
-- The BEGIN/COMMIT below already makes this all-or-nothing.
BEGIN;

-- ── 1. Segments that keep themselves current ──────────────────────────────────
--
-- A segment was a stored query plus a MANUAL snapshot: nothing refreshed it, so "all
-- active customers" was only true as at whenever somebody last pressed the button. That
-- is survivable for a one-off blast and wrong for the audiences people actually want —
-- "customers who have not transacted in 90 days" is a moving population, and a stale
-- copy of it quietly messages the wrong people.
--
-- Off by default and per-segment, because a refresh REPLACES the list's members in place
-- and the list may be wired to a campaign. Nobody should discover that their audience
-- changed under them because a default said so.
ALTER TABLE app.contact_segments
  ADD COLUMN IF NOT EXISTS auto_refresh           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS refresh_interval_hours integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS last_auto_refresh_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_refresh_error     text;

-- An hour is the floor. Rebuilding a 17,890-row list is not free, and the underlying
-- customer_lifecycle table is itself only recomputed once a night by retention_lifecycle
-- at 03:30 — so refreshing more often than hourly cannot make the answer any fresher,
-- it just costs more.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_segments_interval_chk') THEN
    ALTER TABLE app.contact_segments
      ADD CONSTRAINT contact_segments_interval_chk
      CHECK (refresh_interval_hours BETWEEN 1 AND 720);
  END IF;
END $$;

COMMENT ON COLUMN app.contact_segments.auto_refresh IS
  'When true the contact_segments worker rebuilds this segment every refresh_interval_hours. A refresh REPLACES the linked list''s members in place, so this is opt-in per segment.';
COMMENT ON COLUMN app.contact_segments.last_refresh_error IS
  'Why the last automatic refresh failed, kept so a silently stale segment is visible on the page rather than only in the log.';

-- ── 2. How a LIST may be contacted ────────────────────────────────────────────
--
-- This is the question I declined to answer in code, written down so a person can answer
-- it once. app.party_contact_consent is keyed on party_id, and the 28,529 bought-in CRC
-- contacts are not parties — so no consent row can exist for them either way. The sender
-- therefore had no basis to consult and let them through with a note, which is a decision
-- made by default rather than by anybody.
--
-- Now a list states its own basis. NULL still means "nobody has said", and the sender
-- treats that as the strict case for marketing; a recorded basis names who decided and on
-- what evidence, the same shape app.party_contact_consent uses for a known customer.
ALTER TABLE app.contact_lists
  ADD COLUMN IF NOT EXISTS consent_basis       text,
  ADD COLUMN IF NOT EXISTS consent_note        text,
  ADD COLUMN IF NOT EXISTS consent_recorded_by bigint,
  ADD COLUMN IF NOT EXISTS consent_recorded_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_lists_consent_basis_chk') THEN
    ALTER TABLE app.contact_lists
      ADD CONSTRAINT contact_lists_consent_basis_chk CHECK (
        consent_basis IS NULL OR consent_basis IN (
          -- They asked us to contact them: a web form, an event sign-up, an inbound enquiry.
          'opt_in_collected',
          -- Bought or sourced from a third party who asserts consent. Weaker, and named
          -- as what it is rather than dressed up as an opt-in.
          'third_party_asserted',
          -- Existing customers, contacted about something related to what they hold. The
          -- same reasoning migration 290 wrote down for servicing.
          'legitimate_interest',
          -- Explicitly decided that this list may NOT be marketed to.
          'not_for_marketing'
        ));
  END IF;
END $$;

COMMENT ON COLUMN app.contact_lists.consent_basis IS
  'How the people on this list may be contacted for MARKETING, for contacts who are not parties and so cannot have a party_contact_consent row. NULL = nobody has decided, which the sender treats as the strict case.';

-- ── 3. One definition of "can we actually reach this customer" ─────────────────
--
-- Three places were about to grow their own copy of this: the segment builder, the
-- contact-data checker, and anything that later wants to count reachability. The rule is
-- not obvious — a stored phone can be well-formed and still be 08012345678, which sat
-- against 4,073 active customers on 2026-10-06 — so it belongs in one place.
--
-- Carries the RAW value alongside the validated one on purpose: the checker needs to show
-- somebody what is actually in the field before they can fix it.
CREATE OR REPLACE VIEW app.v_customer_contactability AS
SELECT cl.party_id,
       cl.open_products,
       cl.bucket,
       cl.value_tier,
       cl.days_since_txn,
       cl.has_open_recovery,
       v.cust_id,
       v.full_name,
       NULLIF(btrim(COALESCE(v.email, '')), '') AS email_raw,
       NULLIF(btrim(COALESCE(v.phone, '')), '') AS phone_raw,
       CASE WHEN app.is_emailable(v.email) THEN btrim(v.email) END AS email,
       CASE WHEN app.is_dialable_ng_phone(v.phone)
            THEN app.normalise_ng_phone(v.phone) END               AS phone,
       -- "Present but unusable" is the actionable category: a blank field is a gap,
       -- a field holding "00" is somebody's data-entry habit and can be corrected.
       (NULLIF(btrim(COALESCE(v.email, '')), '') IS NOT NULL
        AND NOT app.is_emailable(v.email))                         AS email_unusable,
       (NULLIF(btrim(COALESCE(v.phone, '')), '') IS NOT NULL
        AND NOT app.is_dialable_ng_phone(v.phone))                 AS phone_unusable
  FROM app.customer_lifecycle cl
  LEFT JOIN app.v_contact_identity v ON v.party_id = cl.party_id;

COMMENT ON VIEW app.v_customer_contactability IS
  'Every customer with their contact details both as stored and as validated. email/phone are NULL unless usable; *_unusable flags the ones holding a value that cannot be used, which is the fixable kind. Shared by the segment builder and the contact-data checker so they cannot disagree.';

-- Reviewable under psql, discarded by the Go runner. Plain SQL for the reason at the top.
SELECT 'active customers'                                    AS population,
       COUNT(*)                                              AS people,
       COUNT(email)                                          AS emailable,
       COUNT(phone)                                          AS dialable,
       COUNT(*) FILTER (WHERE email_unusable)                 AS email_needs_fixing,
       COUNT(*) FILTER (WHERE phone_unusable)                 AS phone_needs_fixing,
       COUNT(*) FILTER (WHERE email IS NULL AND phone IS NULL) AS unreachable
  FROM app.v_customer_contactability
 WHERE open_products > 0;

COMMIT;
