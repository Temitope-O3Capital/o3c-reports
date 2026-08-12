-- 143: Converge the call stores onto helpdesk_calls as the single call ledger.
--
-- Background: the workspace accumulated several parallel "call" stores. In practice
-- only helpdesk_calls holds real telephony (Zoho Desk import, AT inbound, and the
-- manual log-call endpoints). The rest were empty or superseded:
--
--   * dialer_* (campaigns/queue/sessions/call_logs) — a predictive dialer whose UI
--     was retired ("agents dial via the carrier"); all four tables were empty and
--     the background dial engine ran on every boot doing nothing. The handler and
--     its route registration are removed in the same change.
--   * cs_interactions — created by migration 013, never read or written by any Go
--     code (customer-service was repointed to helpdesk_calls long ago).
--   * call_center_call_logs — the outbound queue's own sparse call log (0 rows). Its
--     one writer (ccLogCall) now records the call in helpdesk_calls, and its readers
--     (ccContactCalls, hdMyDashboard) now read helpdesk_calls, so it is redundant.
--
-- All three groups were confirmed empty before this drop. call_center_contacts (the
-- outbound worklist), call_center_leads and call_center_dispositions (lead-funnel
-- analytics) are intentionally KEPT — they are queue/overlay state, not call logs.

DROP TABLE IF EXISTS dialer_call_logs   CASCADE;
DROP TABLE IF EXISTS dialer_queue        CASCADE;
DROP TABLE IF EXISTS dialer_sessions     CASCADE;
DROP TABLE IF EXISTS dialer_campaigns    CASCADE;

DROP TABLE IF EXISTS cs_interactions     CASCADE;

DROP TABLE IF EXISTS call_center_call_logs CASCADE;
