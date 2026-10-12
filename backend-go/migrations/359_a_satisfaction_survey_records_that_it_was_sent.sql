-- Record that a satisfaction survey was SENT, so it can only be sent once.
--
-- THE GAP. app.helpdesk_tickets tracks csat_token, csat_score, csat_comment and
-- csat_submitted_at — everything about the ANSWER, and nothing about the ASK. The only
-- sender today is the in-app resolve button, which a human presses once, so nothing
-- needed a guard. The moment anything automatic sends these — a batch step over recently
-- resolved tickets, which is what this migration exists to enable — "have we already
-- asked this customer?" becomes a question the data cannot answer, and the batch would
-- re-ask on every pass.
--
-- SO THE COLUMN IS THE GUARD, not a log. The sender claims a ticket by setting
-- csat_sent_at in the same statement that checks it is NULL, which is what makes the
-- send idempotent under a worker that runs every few minutes.
--
-- WHY THIS IS SAFE TO APPLY NOW, with nothing else changing: adding a nullable column
-- alters no behaviour. The existing in-app path starts recording its sends, and the
-- batch step is separately gated on the survey link being publicly resolvable — which
-- today it is not (app_base_url is https://crm.o3cards.pri:8443, a private host no
-- customer's browser can reach). Measured 2026-10-12: 46 CSAT emails have ever been
-- sent against 29,240 resolved tickets, and every one of those 46 carried a link that
-- could not be opened.

BEGIN;

ALTER TABLE app.helpdesk_tickets
    ADD COLUMN IF NOT EXISTS csat_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN app.helpdesk_tickets.csat_sent_at IS
    'When the satisfaction survey was emailed. NULL means not yet asked. Set by the '
    'sender in the same statement that checks it, so a survey cannot be sent twice.';

-- The sender looks for "resolved recently, never asked", so the index matches that shape
-- rather than indexing the whole column. Partial, because the rows that matter are the
-- unsent ones and they are the minority.
CREATE INDEX IF NOT EXISTS helpdesk_tickets_csat_unsent_idx
    ON app.helpdesk_tickets (resolved_at DESC)
 WHERE csat_sent_at IS NULL AND resolved_at IS NOT NULL;

COMMIT;
