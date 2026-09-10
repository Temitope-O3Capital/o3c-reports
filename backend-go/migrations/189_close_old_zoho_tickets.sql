-- 189: Close the backlog of Zoho-sourced helpdesk tickets older than 14 days.
--
-- Requested by Temitope: keep only the last 14 days open; close the rest. The workspace's
-- tickets all originate from the Zoho Desk sync. At migration time ~3,403 tickets were
-- created more than 14 days ago and still not closed.
--
-- SAFE FROM RE-OPEN: the hourly Zoho Desk sync only reconciles the newest ~2000 tickets
-- (its window reaches back ~5-6 days — well inside the 14-day line), so these older tickets
-- sit outside the sync's reach and it will not flip them back to open. Only a deliberate
-- full manual re-import (/import?max=… order=desc/asc) would, which is an explicit action.
--
-- Runs through the DB directly, so NO CSAT emails, notifications, or Zoho write-backs fire
-- — it is purely a local queue cleanup. `helpdesk_tickets_status_check` allows 'closed'.
-- Idempotent: re-running matches nothing (the rows are already closed).

UPDATE helpdesk_tickets
   SET status    = 'closed',
       closed_at = COALESCE(closed_at, NOW())
 WHERE created_at < NOW() - INTERVAL '14 days'
   AND COALESCE(status, '') <> 'closed';
