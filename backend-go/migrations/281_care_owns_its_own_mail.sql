-- 281: hand the open customer mail to Care, which is the team that works it.
--
-- Care and the Call Center are separate teams sharing one ticket table, split by
-- channel: Care answers the customer mailbox, the Call Center works the phone
-- queues. core/auth.go has enforced that split for a while — a call-centre agent
-- cannot open Care and a care agent cannot open Call Center — but no ticket ever
-- moved across with it. Measured immediately before running:
--
--     open email tickets            680
--       assigned to call_center_agent   568
--       assigned to call_center_head    111
--       assigned to a finance_officer     1
--       assigned to Care                  0
--
-- So Care's two agents owned none of the 680 emails they are responsible for,
-- while the phone floor carried all of them — and, because the SLA alerting keyed
-- off assigned_to, every one of the 2,108 SLA-breach and 2,107 SLA-warning
-- notifications ever sent went to the call centre. The companion code change
-- routes alerts by channel; this moves the work itself.
--
-- WHAT MOVES: open, non-deleted, channel='email' tickets currently held by a
-- call_center_agent or call_center_head — 679 of the 680.
--
-- WHAT DOES NOT:
--   - the 1 email deliberately handed to Gloria Onwugbufor (finance_officer).
--     Finance holds the ticketWorker pages precisely so a billing question can be
--     routed to the person who can answer it; that is a real handoff, not a
--     mis-assignment, and undoing it would strand the customer.
--   - all 610 open phone/call/web/social tickets. They stay exactly where they are.
--   - resolved and closed mail. History is not rewritten; only live work moves.
--
-- HOW IT SPLITS: round-robin across the ACTIVE care_agents (Elizabeth Momoh and
-- Janet Ogboru today), ordered by sla_due_at so the overdue mail is interleaved
-- evenly instead of one agent inheriting every breach. Dry-run on the live
-- database inside a rolled-back transaction:
--     Elizabeth Momoh  340 tickets (322 past SLA)
--     Janet Ogboru     339 tickets (321 past SLA)
--
-- care_head is deliberately NOT in the rotation: Olere Asunomhe supervises the
-- floor and now receives the floor digests; she is not a queue.
--
-- SAFE IF CARE IS EMPTY: with no active care_agent the modulo is NULL, the join
-- matches nothing and this is a no-op rather than an UPDATE that nulls ownership.
--
-- This deliberately sends NO notifications — 679 individual "ticket assigned"
-- alerts would bury the very digests this work exists to make readable. The next
-- SLA sweep tells each agent what they now hold, in one grouped row.
WITH care AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY id) - 1 AS slot,
         COUNT(*)     OVER ()               AS n
    FROM o3c_users
   WHERE role = 'care_agent' AND is_active = TRUE AND deleted_at IS NULL
),
targets AS (
  SELECT t.id           AS ticket_id,
         t.assigned_to  AS old_owner,
         (ROW_NUMBER() OVER (ORDER BY t.sla_due_at NULLS LAST, t.id) - 1)
           % NULLIF((SELECT n FROM care LIMIT 1), 0) AS slot
    FROM helpdesk_tickets t
    JOIN o3c_users u ON u.id = t.assigned_to
   WHERE t.channel = 'email'
     AND t.status NOT IN ('resolved','closed')
     AND t.deleted_at IS NULL
     AND u.role IN ('call_center_agent','call_center_head')
),
moved AS (
  UPDATE helpdesk_tickets t
     SET assigned_to = care.id,
         updated_at  = NOW()
    FROM targets
    JOIN care ON care.slot = targets.slot
   WHERE t.id = targets.ticket_id
  RETURNING t.id AS ticket_id, targets.old_owner, care.id AS new_owner
)
-- One audit row per ticket. A bulk move of 679 tickets with no history would be a
-- real gap for a CBN-regulated contact centre; user_id is NULL because the actor
-- is this migration, not a person.
INSERT INTO helpdesk_events (ticket_id, user_id, event_type, old_value, new_value)
SELECT m.ticket_id, NULL, 'assigned', m.old_owner::text, m.new_owner::text
  FROM moved m;
