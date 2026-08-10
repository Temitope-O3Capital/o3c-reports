-- 132: Finance is now a read-only *reporting* module — its write features
-- (Budget and Cost Tracking) were retired along with P&L, Manual Posting and
-- Chart of Accounts. budget_lines and cost_entries were used only by those two
-- removed pages (created in migration 044) and are referenced nowhere else, so
-- they are dropped here.
--
-- NOTE — deliberately NOT dropped (shared infrastructure, still in active use):
--   * gl_accounts     — backs the double-entry GL engine (loans, FDs, cards,
--                       collections, recovery, settlements all post journals).
--   * manual_postings — owned by the Settlements module (/settlements/manual-postings).
--   * fd_transactions — source for finance FD reporting (treasury, accrual, KPIs).

DROP TABLE IF EXISTS budget_lines CASCADE;
DROP TABLE IF EXISTS cost_entries CASCADE;
