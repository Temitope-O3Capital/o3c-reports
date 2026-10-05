-- A supervisor asked to listen for unprofessional or error-prone calls and flag
-- them, department by department, from a BI point of view. Piloted by hand first
-- (see the "O3C call QA pilot" write-up) because the naive version --
-- whisper's small.en model + a bare rubric -- flagged 10/10 of a random sample,
-- almost entirely by putting words in agents' mouths: "O3 Capital" misheard as
-- four different fake company names, "Sabo" (a real Lagos area) misheard as
-- "Sabah" (a Malaysian state), "spend" misheard as "send" turning a normal
-- multi-currency Mastercard feature into a fabricated compliance error. Moving
-- to the large-v3-turbo model and a rubric that states the ground truth (company
-- name, regulator, common Nigerian place names, "snap" = photograph) cut the
-- flag rate to 6/10, and the remaining flags had specific, checkable reasons
-- instead of invented ones.
--
-- Still not a verdict machine: a flag here means "a specific reason a human
-- should look," never "this agent did something wrong." review_status starts
-- 'pending' and stays there until a supervisor reads the transcript and the
-- reason, listens if the reason isn't self-evident, and marks it themselves.
--
-- Kept as a log, not an upsert: a call can be re-run (e.g. after a model
-- upgrade) and both runs stay, so nothing about a later re-score silently
-- erases what an earlier pass found.
CREATE TABLE IF NOT EXISTS app.call_qa_flags (
    id                    BIGSERIAL PRIMARY KEY,
    call_id               BIGINT NOT NULL REFERENCES app.helpdesk_calls(id),
    model                 TEXT NOT NULL,
    transcript            TEXT NOT NULL,
    professionalism_score SMALLINT NOT NULL CHECK (professionalism_score BETWEEN 1 AND 5),
    clarity_score         SMALLINT NOT NULL CHECK (clarity_score BETWEEN 1 AND 5),
    errors_noted          JSONB NOT NULL DEFAULT '[]'::jsonb,
    flag_for_review       BOOLEAN NOT NULL,
    reason                TEXT NOT NULL DEFAULT '',
    review_status         TEXT NOT NULL DEFAULT 'pending'
                              CHECK (review_status IN ('pending', 'reviewed', 'dismissed', 'actioned')),
    review_notes          TEXT,
    reviewed_by           BIGINT,
    reviewed_at           TIMESTAMPTZ,
    requested_by          BIGINT NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_qa_flags_call_id ON app.call_qa_flags(call_id);
CREATE INDEX IF NOT EXISTS idx_call_qa_flags_queue    ON app.call_qa_flags(flag_for_review, review_status, created_at DESC);
