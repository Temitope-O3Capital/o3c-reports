-- 336 — A contact can be tied back to the customer it is, and a campaign says what it is FOR.
-- @nonblocking: additive columns and indexes only, safe to retry.
--
-- No \set or \echo anywhere in this file. Migrations are //go:embed-ed and executed by the
-- Go runner, which speaks SQL to the server and not psql's meta-command language: a leading
-- backslash is a syntax error (SQLSTATE 42601) at the SERVER, and a failed migration exits
-- the process into a restart loop. The BEGIN/COMMIT below already makes this all-or-nothing.
--
-- WHY party_id. app.contact_list_members and app.campaign_contacts carry a name, a phone, an
-- email and a CIF, and no way to say WHICH CUSTOMER this is. So nothing in the campaign path
-- could consult app.party_contact_consent or app.is_suppressed, both of which are keyed on
-- party_id — and in fact nothing does: on 2026-10-06 campaigns.go contained no reference to
-- consent at all. A marketing blast to the customer base would have gone out with no opt-in
-- recorded for anybody, which is the single thing app.party_contact_consent exists to stop
-- (see the seeding comment in 290_customer_messaging_foundations.sql).
--
-- Nullable on purpose. The eight CRC lists are bought-in PROSPECTS, 28,529 people who are not
-- parties and never will be until they transact; a NOT NULL here would make them unloadable.
-- NULL therefore means "not a known customer", which the sender reads as "no consent record
-- can exist for this person" rather than as "cleared to send".
BEGIN;

ALTER TABLE app.contact_list_members ADD COLUMN IF NOT EXISTS party_id bigint;
ALTER TABLE app.campaign_contacts    ADD COLUMN IF NOT EXISTS party_id bigint;

-- Partial: the prospect rows are the majority and are all NULL, so indexing them is dead weight.
CREATE INDEX IF NOT EXISTS idx_contact_list_members_party
    ON app.contact_list_members (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_party
    ON app.campaign_contacts (party_id) WHERE party_id IS NOT NULL;

COMMENT ON COLUMN app.contact_list_members.party_id IS
  'The customer this contact IS, when they are one. NULL = a prospect with no party record, so no consent row can exist for them. Required for any consent or suppression check.';
COMMENT ON COLUMN app.campaign_contacts.party_id IS
  'Snapshotted from contact_list_members at campaign start. NULL = prospect.';

-- WHY purpose. Marketing is OPT-IN and servicing is OPT-OUT — handlers/audience.go draws
-- exactly that line in consentIsOptIn — and a campaign row carried nothing to tell the two
-- apart, so the sender could not apply either rule. 'type' is the CHANNEL mix (multi/sms/
-- email), not the lawful basis, and reusing it would conflate the two.
--
-- Defaulted to 'marketing' because that is the STRICT side. The seven existing drafts become
-- marketing, which is what they are (bought-in prospect lists for the CRC July campaign), and
-- anything genuinely servicing has to be said out loud rather than assumed. Getting this
-- default wrong in the other direction would quietly grant a lawful basis nobody agreed to.
ALTER TABLE app.campaigns ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'marketing';

-- Validated, not NOT VALID: every existing row takes the default and is therefore already
-- legal, and a NOT VALID check would still reject later UPDATEs while pretending to be
-- advisory (see the NOT VALID trap recorded for this codebase).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_purpose_chk'
  ) THEN
    ALTER TABLE app.campaigns
      ADD CONSTRAINT campaigns_purpose_chk CHECK (purpose IN ('marketing','servicing'));
  END IF;
END $$;

COMMENT ON COLUMN app.campaigns.purpose IS
  'Lawful basis for this send. marketing = opt-in: a known customer needs a granted marketing consent row or they are skipped. servicing = opt-out: only an actual withdrawal stops it. Defaults to marketing, the strict side.';

-- WHY a plausibility test. app.normalise_ng_phone fixes the FORMAT of a number and says
-- nothing about whether it is real, by design — its own comment says it keeps a short
-- value so the row is "visibly wrong rather than silently blanked". Nothing then checked.
--
-- Measured on the active customer base 2026-10-06, that is not a small gap:
--   08012345678  4,073 parties     8000000000  823     08000000000  699
--   800000         294             80000       139     8000000      133
--   80000000       101             00           63
-- So of 13,158 active customers who appear to have a phone, only 6,485 have a number
-- anyone could dial. A live SMS campaign would have sent 4,073 separate messages to
-- 08012345678 — one number, one bill, and whoever actually owns it on the other end.
--
-- Deliberately a DATABASE function rather than Go: the segment builder, the arrears
-- reminder and the dialler all want the same answer, and three copies of this rule would
-- drift apart. IMMUTABLE so it can be indexed if it ever needs to be.
CREATE OR REPLACE FUNCTION app.is_dialable_ng_phone(p_raw text) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $fn$
  WITH n AS (SELECT app.normalise_ng_phone(p_raw) AS p)
  SELECT CASE
    -- A Nigerian mobile: 11 digits, 070/071/080/081/090/091.
    WHEN (SELECT p FROM n) IS NULL                   THEN false
    WHEN (SELECT p FROM n) !~ '^0[789][01][0-9]{8}$' THEN false
    -- Fewer than four distinct digits is filler, not a number: 08000000000, 08111111111.
    WHEN (SELECT count(DISTINCT ch)
            FROM regexp_split_to_table((SELECT p FROM n), '') ch) < 4
                                                     THEN false
    -- Observed placeholders. Named rather than guessed: every one of these is a real
    -- value sitting against live customers on this book today.
    WHEN (SELECT p FROM n) IN ('08012345678','08098765432','08000000000',
                               '07000000000','09000000000','08123456789')
                                                     THEN false
    ELSE true
  END
$fn$;

COMMENT ON FUNCTION app.is_dialable_ng_phone(text) IS
  'True when a stored phone could actually be dialled. normalise_ng_phone fixes format only; this rejects placeholders (08012345678 sat against 4,073 active customers on 2026-10-06) and low-entropy filler.';

-- The same problem, smaller: "00" is recorded as the email address of 65 active customers.
CREATE OR REPLACE FUNCTION app.is_emailable(p_raw text) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $fn$
  SELECT COALESCE(btrim(p_raw), '') ~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$'
$fn$;

COMMENT ON FUNCTION app.is_emailable(text) IS
  'True when a stored email is shaped like a deliverable address. Not a bounce check — mail_suppressions is that.';

-- Reviewable under psql, discarded by the Go runner. Kept as plain SQL for the reason at the top.
SELECT 'campaigns' AS table_name, purpose, COUNT(*) AS rows
  FROM app.campaigns GROUP BY purpose
UNION ALL
SELECT 'contact_list_members', CASE WHEN party_id IS NULL THEN 'prospect' ELSE 'customer' END,
       COUNT(*) FROM app.contact_list_members GROUP BY 2
UNION ALL
SELECT 'campaign_contacts', CASE WHEN party_id IS NULL THEN 'prospect' ELSE 'customer' END,
       COUNT(*) FROM app.campaign_contacts GROUP BY 2
ORDER BY 1, 2;

COMMIT;
