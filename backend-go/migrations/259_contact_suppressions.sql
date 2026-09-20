-- 259: per-channel contact suppression, so a customer can be left alone.
--
-- Today the only opt-out in the system is dnc_list: a bare phone list (40 rows) that
-- the outbound dialler honours. There is no suppression for email or WhatsApp at all —
-- the sole trace of consent anywhere else is a campaigns.unsubscribe_count integer.
-- That is acceptable while nothing automated contacts a customer. It stops being
-- acceptable the moment we send automated arrears reminders, which is what the
-- collections dunning work does: telling someone they are in debt, repeatedly, over
-- channels they never agreed to and cannot switch off.
--
-- Design notes:
--   * Keyed on party_id FIRST (the customer), with phone/email kept as a fallback for
--     suppressions that arrive before we know who the person is — a STOP reply or a
--     SendGrid unsubscribe webhook carries an address, not a party.
--   * Per channel, because these are genuinely different consents: a customer may
--     accept an email reminder and refuse a phone call. 'all' is an explicit
--     everything-off row rather than five separate inserts.
--   * removed_at rather than DELETE: an opt-out that silently disappears is worse than
--     no opt-out, and we need to prove when suppression applied if a customer complains.
--   * dnc_list is NOT migrated or dropped. It stays the operator-facing Do Not Call
--     list; app.is_suppressed() consults both, so honouring one honours the other.

CREATE TABLE IF NOT EXISTS app.contact_suppressions (
    id          BIGSERIAL PRIMARY KEY,
    party_id    BIGINT      REFERENCES app.parties(party_id) ON DELETE CASCADE,
    phone       TEXT,
    email       TEXT,
    channel     TEXT        NOT NULL CHECK (channel IN ('call','sms','whatsapp','email','all')),
    reason      TEXT,
    source      TEXT        NOT NULL DEFAULT 'manual'
                            CHECK (source IN ('manual','customer_request','sms_stop','email_unsubscribe','bounce','complaint','dnc_list','regulatory')),
    created_by  BIGINT      REFERENCES o3c_users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at  TIMESTAMPTZ,
    removed_by  BIGINT      REFERENCES o3c_users(id),
    -- A row must identify SOMEBODY, or it suppresses nothing and hides a bug.
    CONSTRAINT contact_suppressions_identifies_someone
      CHECK (party_id IS NOT NULL OR NULLIF(TRIM(phone),'') IS NOT NULL OR NULLIF(TRIM(email),'') IS NOT NULL)
);

COMMENT ON TABLE app.contact_suppressions IS
  'Per-channel opt-out. A live row (removed_at IS NULL) means do not contact that party/phone/email on that channel. Consult via app.is_suppressed(); never query this table directly from a send path, so dnc_list stays honoured too.';

-- Lookup paths used by the send guard: by party, by normalised phone, by lowercased email.
CREATE INDEX IF NOT EXISTS idx_contact_suppressions_party
  ON app.contact_suppressions (party_id, channel) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contact_suppressions_phone
  ON app.contact_suppressions (app.norm_phone(phone), channel) WHERE removed_at IS NULL AND phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contact_suppressions_email
  ON app.contact_suppressions (lower(TRIM(email)), channel) WHERE removed_at IS NULL AND email IS NOT NULL;

-- ── The guard every send path must call ──────────────────────────────────────────────
-- Returns TRUE when this customer must NOT be contacted on this channel. Deliberately
-- permissive about its inputs (any of party/phone/email may be NULL) and deliberately
-- strict about its answer: it errs towards suppression.
--
-- app.norm_phone returns '' rather than NULL for unusable input, so a blank would match
-- every other blank; the length guard is what prevents "no phone" suppressing everyone.
CREATE OR REPLACE FUNCTION app.is_suppressed(
    p_party_id BIGINT,
    p_phone    TEXT,
    p_email    TEXT,
    p_channel  TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM app.contact_suppressions s
         WHERE s.removed_at IS NULL
           AND (s.channel = p_channel OR s.channel = 'all')
           AND (
                 (p_party_id IS NOT NULL AND s.party_id = p_party_id)
              OR (length(app.norm_phone(p_phone)) = 10 AND app.norm_phone(s.phone) = app.norm_phone(p_phone))
              OR (NULLIF(TRIM(p_email),'') IS NOT NULL AND lower(TRIM(s.email)) = lower(TRIM(p_email)))
               )
    )
    -- Legacy Do Not Call still applies to every voice-adjacent channel.
    OR (p_channel IN ('call','sms','whatsapp')
        AND length(app.norm_phone(p_phone)) = 10
        AND EXISTS (SELECT 1 FROM dnc_list d
                     WHERE app.norm_phone(d.phone) = app.norm_phone(p_phone)));
$$;

COMMENT ON FUNCTION app.is_suppressed(BIGINT, TEXT, TEXT, TEXT) IS
  'TRUE when this customer must not be contacted on this channel. Checks contact_suppressions (by party, phone or email, honouring channel=''all'') and, for call/sms/whatsapp, the legacy dnc_list. Every automated send path must gate on this.';
