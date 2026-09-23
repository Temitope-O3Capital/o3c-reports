-- 291 — Continuity checking for the transaction feed.
--
-- WHY. app.v_pipeline_freshness answers "is data arriving?" and reports
-- feed_transactions as ok, four minutes old, while 12 September 2026 holds no rows
-- at all and the 9th, 10th and 13th hold two, two and three against a typical 97.
-- Nothing raised a hand, because the feed resumed the next day and recency was
-- never in question. Recency and continuity are different properties and only one
-- of them was being measured.
--
-- WHAT IT COST. The 14 September card cycle was derived from this feed and checked
-- against the uploaded reports. Interest reconciled on 883 of 883 accounts, exact to
-- the kobo, because it posts as a single cycle-close entry on a day the feed has.
-- Cash advance reached 87.1%, which is 12.9% short — and four of the window's 31
-- days are empty, which is 12.9% of the window. The missing days ARE the gap.
--
-- Those days are silently wrong in everything built on app.transactions, not just
-- cards: spend analysis, customer activity, the churn snapshot, income.
--
-- DELIBERATELY A SEPARATE VIEW. app.v_pipeline_freshness is not touched. Migration
-- 285, written the same day as this one, exists because 257 did a CREATE OR REPLACE
-- on that view from a stale copy of its body and silently undid 239 six days after
-- it shipped. Adding a second view costs nothing and cannot repeat that.

CREATE OR REPLACE VIEW app.v_feed_continuity AS
WITH days AS (
    SELECT generate_series(CURRENT_DATE - 60, CURRENT_DATE - 1, '1 day')::date AS day
),
counted AS (
    SELECT d.day, COALESCE(c.n, 0) AS rows
      FROM days d
      LEFT JOIN (
          SELECT txn_date, count(*) AS n
            FROM app.transactions
           WHERE txn_date >= CURRENT_DATE - 60
           GROUP BY txn_date
      ) c ON c.txn_date = d.day
),
-- The median of days that carried anything. A mean would be dragged down by the
-- very gaps being looked for.
baseline AS (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY rows) AS typical
      FROM counted WHERE rows > 0
)
SELECT 'feed_transactions'::text AS source_key,
       c.day,
       c.rows,
       round(b.typical)::int AS typical_day,
       CASE
           WHEN c.rows = 0                 THEN 'missing'
           WHEN c.rows < b.typical * 0.20  THEN 'thin'
           ELSE 'ok'
       END AS state
  FROM counted c CROSS JOIN baseline b;

COMMENT ON VIEW app.v_feed_continuity IS
  'Per-day row counts for the transaction feed over the last 60 days, against the '
  'median of days that carried data. state=missing means the day has no rows at all; '
  'thin means under a fifth of a typical day. Answers the question v_pipeline_freshness '
  'does not ask: was a day skipped, even though data is arriving now?';
