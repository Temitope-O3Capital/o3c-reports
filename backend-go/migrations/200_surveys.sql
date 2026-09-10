-- Customer feedback & surveys module.
--
-- A survey is a reusable questionnaire (rating / NPS / choice / free-text
-- questions). It is distributed to customers by branded email; each recipient
-- gets an unguessable token (survey_sends.token) that opens a public, no-auth
-- response page (mirrors the existing per-ticket CSAT flow, but multi-question
-- and keyed to a CIF rather than living on a ticket). Responses land in
-- survey_responses/survey_answers and are surfaced back on Customer 360's
-- Activity timeline (see c360Activity) so the CRM "sees" every response.
--
-- All DDL is idempotent; the seed is guarded so re-running is a no-op.

-- ── Module registration ────────────────────────────────────────────────────
INSERT INTO module_config (key, label, enabled, sort_order)
VALUES ('feedback', 'Customer Feedback', true, 9)
ON CONFLICT (key) DO NOTHING;

-- ── Surveys ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surveys (
  id              BIGSERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL DEFAULT '',          -- e.g. card_services, collections
  department      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft',      -- draft | active | closed
  accent_color    TEXT NOT NULL DEFAULT '#C00000',
  intro           TEXT NOT NULL DEFAULT '',
  thank_you       TEXT NOT NULL DEFAULT '',
  signoff_name    TEXT NOT NULL DEFAULT '',
  signoff_title   TEXT NOT NULL DEFAULT '',
  is_anonymous    BOOLEAN NOT NULL DEFAULT false,
  created_by      BIGINT REFERENCES o3c_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Questions ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS survey_questions (
  id              BIGSERIAL PRIMARY KEY,
  survey_id       BIGINT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  position        INT NOT NULL DEFAULT 0,
  qtype           TEXT NOT NULL,                      -- section | rating | nps | single_choice | multi_choice | short_text | long_text
  label           TEXT NOT NULL DEFAULT '',
  help_text       TEXT NOT NULL DEFAULT '',
  required        BOOLEAN NOT NULL DEFAULT false,
  scale_min       INT NOT NULL DEFAULT 1,
  scale_max       INT NOT NULL DEFAULT 10,
  scale_min_label TEXT NOT NULL DEFAULT '',
  scale_max_label TEXT NOT NULL DEFAULT '',
  options         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_survey_questions_survey ON survey_questions(survey_id, position);

-- ── Sends (per-recipient invitations, one token each) ──────────────────────
CREATE TABLE IF NOT EXISTS survey_sends (
  id              BIGSERIAL PRIMARY KEY,
  survey_id       BIGINT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  token           TEXT NOT NULL UNIQUE,
  customer_cif    TEXT NOT NULL DEFAULT '',
  recipient_name  TEXT NOT NULL DEFAULT '',
  recipient_email TEXT NOT NULL DEFAULT '',
  channel         TEXT NOT NULL DEFAULT 'email',
  status          TEXT NOT NULL DEFAULT 'draft',      -- draft | queued | sent | opened | responded | bounced | failed | cancelled
  batch_id        TEXT NOT NULL DEFAULT '',
  mail_id         BIGINT,
  error_text      TEXT NOT NULL DEFAULT '',
  created_by      BIGINT REFERENCES o3c_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  opened_at       TIMESTAMPTZ,
  responded_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_survey_sends_survey ON survey_sends(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_sends_status ON survey_sends(status);
CREATE INDEX IF NOT EXISTS idx_survey_sends_cif    ON survey_sends(customer_cif);

-- ── Responses ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS survey_responses (
  id              BIGSERIAL PRIMARY KEY,
  survey_id       BIGINT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  send_id         BIGINT REFERENCES survey_sends(id) ON DELETE SET NULL,
  customer_cif    TEXT NOT NULL DEFAULT '',
  customer_name   TEXT NOT NULL DEFAULT '',
  customer_email  TEXT NOT NULL DEFAULT '',
  customer_phone  TEXT NOT NULL DEFAULT '',
  nps_score       INT,
  overall_score   NUMERIC(5,2),
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip              TEXT NOT NULL DEFAULT '',
  user_agent      TEXT NOT NULL DEFAULT '',
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON survey_responses(survey_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_survey_responses_cif    ON survey_responses(customer_cif);

-- ── Answers (one row per answered question) ────────────────────────────────
CREATE TABLE IF NOT EXISTS survey_answers (
  id              BIGSERIAL PRIMARY KEY,
  response_id     BIGINT NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
  question_id     BIGINT NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
  rating_value    INT,
  text_value      TEXT NOT NULL DEFAULT '',
  choice_value    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_survey_answers_response ON survey_answers(response_id);
CREATE INDEX IF NOT EXISTS idx_survey_answers_question ON survey_answers(question_id);

-- ── Seed: Card Services Customer Satisfaction Survey ───────────────────────
-- From the Card Services team's questionnaire. Guarded so the seed runs once.
DO $$
DECLARE
  sid BIGINT;
  areas TEXT[] := ARRAY[
    'Ease of card application process',
    'Speed of card issuance and delivery',
    'Quality of customer service support',
    'Professionalism and courtesy of staff',
    'Responsiveness to inquiries and complaints',
    'Reliability of card transactions',
    'Ease of using digital / card management services',
    'Security and fraud protection services',
    'Clarity of communications and account information',
    'Value and benefits provided by your card',
    'Overall satisfaction with O3 Capital Card Services'
  ];
  a TEXT;
  pos INT := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM surveys WHERE category = 'card_services' AND title = 'Card Services Customer Satisfaction Survey') THEN
    INSERT INTO surveys (title, description, category, department, status, accent_color, intro, thank_you, signoff_name, signoff_title)
    VALUES (
      'Card Services Customer Satisfaction Survey',
      'Help us improve your card experience — a few minutes of your time.',
      'card_services', 'Card Services', 'active', '#C00000',
      'Thank you for choosing O3 Capital. We are committed to providing exceptional card services and continuously improving your experience. Please rate each aspect of our service — your feedback helps us serve you better.',
      'Thank you for taking the time to complete this survey. Your feedback helps us improve our services and better meet your needs.',
      'Folusho Atobatele', 'Head, Card Services'
    ) RETURNING id INTO sid;

    -- Section: Service Evaluation
    INSERT INTO survey_questions (survey_id, position, qtype, label, help_text)
    VALUES (sid, pos, 'section', 'Service Evaluation', 'Rate each aspect from 1 (Very Poor) to 10 (Excellent).');
    pos := pos + 1;

    FOREACH a IN ARRAY areas LOOP
      INSERT INTO survey_questions (survey_id, position, qtype, label, required, scale_min, scale_max, scale_min_label, scale_max_label)
      VALUES (sid, pos, 'rating', a, true, 1, 10, 'Very Poor', 'Excellent');
      pos := pos + 1;
    END LOOP;

    -- Section: Overall Assessment
    INSERT INTO survey_questions (survey_id, position, qtype, label, help_text)
    VALUES (sid, pos, 'section', 'Overall Assessment', '');
    pos := pos + 1;

    INSERT INTO survey_questions (survey_id, position, qtype, label, required, scale_min, scale_max, scale_min_label, scale_max_label)
    VALUES (sid, pos, 'nps', 'How likely are you to recommend O3 Capital Card Services to a friend, family member, or colleague?', true, 0, 10, 'Not at all likely', 'Extremely likely');
    pos := pos + 1;

    INSERT INTO survey_questions (survey_id, position, qtype, label)
    VALUES (sid, pos, 'long_text', 'What do you like most about our card services?'); pos := pos + 1;
    INSERT INTO survey_questions (survey_id, position, qtype, label)
    VALUES (sid, pos, 'long_text', 'What areas of our service need improvement?'); pos := pos + 1;
    INSERT INTO survey_questions (survey_id, position, qtype, label)
    VALUES (sid, pos, 'long_text', 'Any comments, suggestions, or recommendations that would help us improve?'); pos := pos + 1;
    INSERT INTO survey_questions (survey_id, position, qtype, label)
    VALUES (sid, pos, 'long_text', 'Is there any new feature, benefit, or service you would like O3 Capital to offer?'); pos := pos + 1;
  END IF;
END $$;
