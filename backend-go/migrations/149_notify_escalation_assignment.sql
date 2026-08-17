-- Notifications, escalation, assignment and resolution.
--
-- Measured state before this migration (2026-08-13):
--   * resolved_at NULL on all 30,993 closed tickets — no resolution time existed
--     anywhere, so every "time to resolve" metric was computing over an empty set.
--   * helpdesk_events held 119 rows for 35,035 tickets, with exactly ONE
--     status_changed — there was no record of who resolved anything.
--   * 3,863 of 4,040 open tickets had no owner in the workspace OR in Zoho.
--   * Escalation existed as a status string with no record of who escalated,
--     to whom, why, or whether it was ever picked up.
--   * 4,133 of 4,455 notifications were one event type sent to two people.
--
-- Idempotent throughout: every ADD is IF NOT EXISTS and the backfills are
-- guarded so re-running cannot double-apply.

-- ── Resolution: who closed it, and when ──────────────────────────────────────
ALTER TABLE helpdesk_tickets
  ADD COLUMN IF NOT EXISTS resolved_by bigint,
  ADD COLUMN IF NOT EXISTS closed_by   bigint;

-- Zoho has no separate "resolved" state — a ticket goes straight to closed, and
-- exactly one ticket in 35,035 ever carried status='resolved'. So for imported
-- history closed_at IS the resolution moment; treating it as such recovers the
-- resolution timeline instead of leaving 31k rows permanently NULL.
-- Guarded on resolved_at IS NULL so a re-run never overwrites a real value.
UPDATE helpdesk_tickets
   SET resolved_at = closed_at
 WHERE status = 'closed' AND closed_at IS NOT NULL AND resolved_at IS NULL;

-- ── Escalation: a real workflow, not a status string ─────────────────────────
ALTER TABLE helpdesk_tickets
  ADD COLUMN IF NOT EXISTS escalated_at          timestamptz,
  ADD COLUMN IF NOT EXISTS escalated_by          bigint,
  ADD COLUMN IF NOT EXISTS escalated_to          bigint,
  ADD COLUMN IF NOT EXISTS escalation_reason     text,
  ADD COLUMN IF NOT EXISTS escalation_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalation_resolved_by bigint;

-- Open escalations are the supervisor's worklist, so they get their own index.
CREATE INDEX IF NOT EXISTS idx_tickets_open_escalations
  ON helpdesk_tickets (escalated_to, escalated_at DESC)
  WHERE escalated_at IS NOT NULL AND escalation_resolved_at IS NULL;

-- ── Cross-team assist ────────────────────────────────────────────────────────
-- An agent helping on someone else's ticket must leave a trace, so the owner
-- keeps accountability and the helper gets credit. This is the ledger behind
-- "assist freely, owner stays".
CREATE TABLE IF NOT EXISTS ticket_assists (
    id             bigserial PRIMARY KEY,
    ticket_id      bigint      NOT NULL,
    helper_user_id bigint      NOT NULL,
    owner_user_id  bigint,
    action         text        NOT NULL,   -- viewed | replied | noted | resolved | took_over | escalated
    detail         text,
    created_at     timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_assists_ticket ON ticket_assists (ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_assists_helper ON ticket_assists (helper_user_id, created_at DESC);
-- One 'viewed' row per helper per ticket per day keeps the ledger about real
-- help rather than filling up with every page load. The timezone must be named
-- explicitly — a bare created_at::date is not IMMUTABLE and Postgres rejects it
-- in an index expression.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_assists_view_daily
  ON ticket_assists (ticket_id, helper_user_id, ((created_at AT TIME ZONE 'Africa/Lagos')::date))
  WHERE action = 'viewed';

-- ── Notification de-duplication ──────────────────────────────────────────────
-- The unassigned-ticket alert fired once per ticket and produced 4,133 rows for
-- two people. group_key lets a sender collapse a class of events into one live
-- notification (digest), and dedupe_until suppresses re-sends inside a window.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS group_key    text,
  ADD COLUMN IF NOT EXISTS group_count  integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS priority     text    NOT NULL DEFAULT 'normal';

-- Partial unique index: at most ONE unread notification per user per group_key.
-- The digest sender upserts onto this, so a thousand unassigned tickets become a
-- single "1,000 tickets unassigned" row that updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_group_unread
  ON notifications (user_id, group_key)
  WHERE group_key IS NOT NULL AND is_read = FALSE;

-- The bell reads unread-by-user constantly; make that an index-only scan.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread_created
  ON notifications (user_id, created_at DESC) WHERE is_read = FALSE;

-- ── Outbound queue ownership ─────────────────────────────────────────────────
-- assigned_to already exists but is NULL on all 14,709 rows; index it so an
-- agent's "my queue" is cheap once ownership starts being written.
CREATE INDEX IF NOT EXISTS idx_cc_contacts_assigned
  ON call_center_contacts (assigned_to, status)
  WHERE assigned_to IS NOT NULL;

-- ── Retire the per-ticket unassigned alert backlog ───────────────────────────
-- These 4,133 rows are pure noise from the old per-ticket alert and drown the
-- two people who received them. Mark them read rather than deleting, so the
-- history stays auditable but the bell is usable again.
UPDATE notifications
   SET is_read = TRUE, read_at = COALESCE(read_at, NOW())
 WHERE type = 'ticket_unassigned_alert' AND is_read = FALSE;
