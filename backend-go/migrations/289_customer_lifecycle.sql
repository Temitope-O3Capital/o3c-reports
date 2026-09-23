-- 289: make a customer's lifecycle a STORED FACT, so something can act on it.
--
-- The workspace already computes a lifecycle taxonomy — active / lapsing / dormant /
-- never — inside customer360.go and growth.go, and renders it in six screens. But it
-- is recomputed on every query and stored nowhere, so nothing can trigger on it, no
-- customer record carries it, and no queue can be built from it. The business can SEE
-- churn in aggregate and cannot ACT on one customer. This closes that gap.
--
-- Measured on 2026-09-23, which is what this table exists to make actionable:
--     6,504 parties last transacted over a year ago
--     NGN 3.60bn of spend stopped with them (their final active twelve months)
--     84.7% of that sits with the top decile; the top 500 hold 80%
--
--
-- WHAT "VALUE" MEANS HERE, AND WHY IT IS NOT TRAILING-12-MONTH SPEND
--
-- The obvious definition — spend in the last 12 months — is useless for exactly the
-- customers this table is for: a lapsed customer's trailing 12 months is zero, so
-- every churned customer would tier identically and the ranking would carry no
-- information. value_kobo is instead spend in the twelve months BEFORE that
-- customer's OWN last transaction: their final active year, the run-rate that
-- stopped. That is the number that makes "NGN 3.6bn walked out" meaningful, and it
-- ranks a lapsed whale above a lapsed dabbler, which is the entire point.
--
-- For a still-active customer the two definitions converge, because their last
-- transaction is recent.
--
--
-- HONESTY ABOUT COVERAGE — READ BEFORE TRUSTING A BUCKET
--
-- app.transactions is CARD-ONLY. There is no savings/current-account ledger in this
-- database at all, and Udara is a full-refresh snapshot that keeps no history. Of
-- 21,534 parties only ~7,900 have any money row. Transaction coverage by line is
-- card 72%, prepaid 33%, deposit 15%.
--
-- So "no transactions" does NOT mean "never transacted" — for most of the base it
-- means "we did not capture it". Those parties get bucket='unknown', never 'never'.
-- A retention queue built on 'unknown' would be calling people about activity we
-- simply failed to record. The `measured` column carries that distinction explicitly
-- so every reader has to confront it rather than inherit a silent zero.
--
-- The ledger also has holes INSIDE the last twelve months (2025-11 and 2025-12 hold
-- 3 rows each, 2026-05 holds 7, against ~4,500 in a normal month). That is why this
-- table scores RECENCY and VALUE — both robust to a missing month — and deliberately
-- does NOT score transaction frequency or trend, which those gaps would read as
-- mass churn.
--
--
-- IDENTITY. Every join here is cards-to-cards or through a native party_id. Bare
-- Udara customer ids are never compared to card CIFs: they are separate namespaces
-- that collide (migration 267), and app.cbs_links is the only bridge used.

CREATE TABLE IF NOT EXISTS app.customer_lifecycle (
    party_id            BIGINT PRIMARY KEY REFERENCES app.parties(party_id) ON DELETE CASCADE,

    -- Where they are in the dormancy clock. 'unknown' means we hold no money history
    -- for them, which is most of the base — see the coverage note above.
    bucket              TEXT        NOT NULL,
    -- Worth, banded. 'unclassified' when unmeasured.
    value_tier          TEXT        NOT NULL,

    last_txn_at         TIMESTAMPTZ,
    days_since_txn      INTEGER,
    -- Final-active-12-month NGN spend, in kobo. app.transactions.amount is in NAIRA
    -- (its debits sum to NGN 20.95bn), so it is scaled by 100 on the way in to match
    -- the kobo convention used everywhere else in this schema.
    value_kobo          BIGINT      NOT NULL DEFAULT 0,
    lifetime_value_kobo BIGINT      NOT NULL DEFAULT 0,

    open_products       INTEGER     NOT NULL DEFAULT 0,
    -- TRUE when any money row was found at all. FALSE means the bucket is 'unknown'
    -- and no retention decision should be taken from this row.
    measured            BOOLEAN     NOT NULL DEFAULT FALSE,
    -- An open recovery case makes this a COLLECTIONS conversation, not a win-back
    -- one. 152 of the top 500 lapsed customers by value are in recovery; putting
    -- them in a win-back queue would have an agent offering a fresh product while a
    -- colleague chases the same person's debt.
    has_open_recovery   BOOLEAN     NOT NULL DEFAULT FALSE,
    -- A usable phone not on the do-not-call list, or a usable email not suppressed.
    contactable         BOOLEAN     NOT NULL DEFAULT FALSE,

    computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT customer_lifecycle_bucket_check CHECK (bucket IN
        ('active','cooling','at_risk','dormant','lapsed','churned','never','unknown')),
    CONSTRAINT customer_lifecycle_tier_check CHECK (value_tier IN
        ('vip','gold','silver','mass','unclassified'))
);

-- The three access patterns: "show me the at-risk pile", "rank the lapsed by worth",
-- and "who is workable" (measured, reachable, not already in recovery).
CREATE INDEX IF NOT EXISTS idx_customer_lifecycle_bucket    ON app.customer_lifecycle (bucket);
CREATE INDEX IF NOT EXISTS idx_customer_lifecycle_tier_val  ON app.customer_lifecycle (value_tier, value_kobo DESC);
CREATE INDEX IF NOT EXISTS idx_customer_lifecycle_workable  ON app.customer_lifecycle (bucket, value_kobo DESC)
    WHERE measured AND contactable AND NOT has_open_recovery;

COMMENT ON TABLE app.customer_lifecycle IS
  'One row per party: dormancy bucket, value tier and the evidence behind them. Recomputed nightly by app.compute_customer_lifecycle() (StartRetentionWorker). bucket=''unknown'' means no money history was found for that party - most of the base - and NO retention decision should be taken from such a row; see the coverage note in migration 289.';


-- ── The engine ───────────────────────────────────────────────────────────────
--
-- A full recompute, not an incremental one: it runs in seconds over ~1M rows, and a
-- full rebuild cannot drift the way an incremental one silently does. Returns the
-- number of rows written so the worker can log something truthful.
CREATE OR REPLACE FUNCTION app.compute_customer_lifecycle()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    written integer;
BEGIN
    WITH
    -- Card transactions, rolled to the canonical customer. Cards-to-cards join only.
    -- Currency is pinned to NGN (566): 99.5% of rows are NGN and the lapsed value is
    -- effectively 100% NGN today, but mixing USD into a naira total is exactly the
    -- bug migration 281_income_by_currency had to undo elsewhere.
    txn AS (
        SELECT c.party_id,
               MAX(t.txn_date)::timestamptz AS last_txn_at,
               SUM(CASE WHEN NOT COALESCE(t.money_in, FALSE)
                        THEN ABS(t.amount) ELSE 0 END)          AS lifetime_spend
          FROM app.transactions t
          JOIN app.customers c ON c.cif = t.cif
         WHERE c.party_id IS NOT NULL
           AND COALESCE(t.currency_code, '566') = '566'
         GROUP BY c.party_id
    ),
    -- Spend in the twelve months preceding that customer's OWN last transaction.
    final12 AS (
        SELECT x.party_id,
               SUM(CASE WHEN NOT COALESCE(t.money_in, FALSE)
                        THEN ABS(t.amount) ELSE 0 END) AS spend
          FROM txn x
          JOIN app.customers c ON c.party_id = x.party_id
          JOIN app.transactions t ON t.cif = c.cif
         WHERE COALESCE(t.currency_code, '566') = '566'
           AND t.txn_date <= x.last_txn_at
           AND t.txn_date >  x.last_txn_at - INTERVAL '12 months'
         GROUP BY x.party_id
    ),
    prod AS (
        SELECT c.party_id, COUNT(*) FILTER (
                   WHERE UPPER(COALESCE(a.status,'')) IN ('OPEN','ACTIVE')) AS open_products
          FROM app.accounts a
          JOIN app.customers c ON c.cif = a.cif
         WHERE c.party_id IS NOT NULL
         GROUP BY c.party_id
    ),
    -- Native party_id on recovery_cases, so no namespace bridge is needed.
    rec AS (
        SELECT DISTINCT party_id
          FROM app.recovery_cases
         WHERE party_id IS NOT NULL AND COALESCE(status,'') <> 'closed'
    ),
    -- Udara deposit and loan holders reach a party ONLY through app.cbs_links.
    -- A big deposit or loan makes someone premium regardless of card spend: the
    -- median FD principal is an order of magnitude above the VIP card threshold.
    cbs AS (
        SELECT l.entity_id AS party_id,
               COALESCE(MAX(f.principal_kobo), 0) AS fd_kobo,
               COALESCE(MAX(ln.loan_amount_kobo), 0) AS loan_kobo
          FROM app.cbs_links l
          LEFT JOIN app.cbs_fixed_deposits f ON f.cbs_customer_id = l.cbs_customer_id
          LEFT JOIN app.cbs_loans ln          ON ln.cbs_customer_id = l.cbs_customer_id
         WHERE l.entity_type = 'party' AND l.entity_id IS NOT NULL
         GROUP BY l.entity_id
    ),
    -- Reachable at all. app.norm_phone returns '' (never NULL) for anything it cannot
    -- parse, so the length()=10 guard is load-bearing: without it a blank number
    -- matches a blank number and everyone looks contactable.
    reach AS (
        SELECT p.party_id,
               (EXISTS (
                   SELECT 1 FROM app.customers c
                    WHERE c.party_id = p.party_id
                      AND length(app.norm_phone(COALESCE(NULLIF(c.phone,''), p.primary_phone))) = 10
                      AND NOT EXISTS (
                          SELECT 1 FROM app.dnc_list d
                           WHERE app.norm_phone(d.phone)
                                 = app.norm_phone(COALESCE(NULLIF(c.phone,''), p.primary_phone))
                             AND length(app.norm_phone(d.phone)) = 10))
                OR (length(app.norm_phone(p.primary_phone)) = 10
                    AND NOT EXISTS (
                        SELECT 1 FROM app.dnc_list d
                         WHERE app.norm_phone(d.phone) = app.norm_phone(p.primary_phone)
                           AND length(app.norm_phone(d.phone)) = 10))
                OR (COALESCE(p.primary_email,'') ~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'
                    AND NOT EXISTS (
                        SELECT 1 FROM app.mail_suppressions s
                         WHERE s.is_active
                           AND LOWER(TRIM(s.email)) = LOWER(TRIM(p.primary_email))))
               ) AS contactable
          FROM app.parties p
    ),
    scored AS (
        SELECT p.party_id,
               x.last_txn_at,
               CASE WHEN x.last_txn_at IS NOT NULL
                    THEN GREATEST(0, (CURRENT_DATE - x.last_txn_at::date)) END AS days_since,
               ROUND(COALESCE(f.spend, 0) * 100)::bigint            AS value_kobo,
               ROUND(COALESCE(x.lifetime_spend, 0) * 100)::bigint   AS lifetime_kobo,
               COALESCE(pr.open_products, 0)                        AS open_products,
               (x.party_id IS NOT NULL)                             AS measured,
               (r.party_id IS NOT NULL)                             AS has_open_recovery,
               COALESCE(rc.contactable, FALSE)                      AS contactable,
               COALESCE(cb.fd_kobo, 0)                              AS fd_kobo,
               COALESCE(cb.loan_kobo, 0)                            AS loan_kobo
          FROM app.parties p
          LEFT JOIN txn     x  ON x.party_id  = p.party_id
          LEFT JOIN final12 f  ON f.party_id  = p.party_id
          LEFT JOIN prod    pr ON pr.party_id = p.party_id
          LEFT JOIN rec     r  ON r.party_id  = p.party_id
          LEFT JOIN reach   rc ON rc.party_id = p.party_id
          LEFT JOIN cbs     cb ON cb.party_id = p.party_id
         -- Prospect parties minted for leads (migration 253) are not customers and
         -- are excluded from customer counts everywhere else; they are excluded here
         -- too, or the dormant count fills with people who never bought anything.
         WHERE COALESCE(p.party_key,'') NOT LIKE 'LEAD:%'
    )
    INSERT INTO app.customer_lifecycle AS cl (
        party_id, bucket, value_tier, last_txn_at, days_since_txn,
        value_kobo, lifetime_value_kobo, open_products, measured,
        has_open_recovery, contactable, computed_at)
    SELECT s.party_id,
           -- The dormancy clock. Thresholds are the ones agreed on 2026-09-15.
           CASE
             WHEN NOT s.measured      THEN 'unknown'
             -- 'never' is unreachable while `measured` means "has a transaction row":
             -- a party holding products but carrying no rows is honestly 'unknown',
             -- not 'never'. The value stays in the CHECK for the day coverage is good
             -- enough to tell genuine non-activation from missing history. Not today.
             WHEN s.days_since IS NULL THEN 'never'
             WHEN s.days_since <=  30 THEN 'active'
             WHEN s.days_since <=  60 THEN 'cooling'
             WHEN s.days_since <=  90 THEN 'at_risk'
             WHEN s.days_since <= 180 THEN 'dormant'
             WHEN s.days_since <= 365 THEN 'lapsed'
             ELSE                          'churned'
           END,
           -- Value bands, in kobo. A large deposit or loan escalates to VIP on its
           -- own: those customers are premium whatever their card does.
           CASE
             WHEN NOT s.measured AND s.fd_kobo < 300000000 AND s.loan_kobo < 500000000
                                              THEN 'unclassified'
             WHEN s.fd_kobo   >= 300000000    THEN 'vip'   -- FD   >= NGN 3m
             WHEN s.loan_kobo >= 500000000    THEN 'vip'   -- loan >= NGN 5m
             WHEN s.value_kobo >= 500000000   THEN 'vip'   -- spend>= NGN 5m
             WHEN s.value_kobo >= 100000000   THEN 'gold'  --       >= NGN 1m
             WHEN s.value_kobo >=  25000000   THEN 'silver'--       >= NGN 250k
             WHEN s.value_kobo >           0  THEN 'mass'
             ELSE                                  'unclassified'
           END,
           s.last_txn_at, s.days_since, s.value_kobo, s.lifetime_kobo,
           s.open_products, s.measured, s.has_open_recovery, s.contactable, NOW()
      FROM scored s
    ON CONFLICT (party_id) DO UPDATE SET
        bucket              = EXCLUDED.bucket,
        value_tier          = EXCLUDED.value_tier,
        last_txn_at         = EXCLUDED.last_txn_at,
        days_since_txn      = EXCLUDED.days_since_txn,
        value_kobo          = EXCLUDED.value_kobo,
        lifetime_value_kobo = EXCLUDED.lifetime_value_kobo,
        open_products       = EXCLUDED.open_products,
        measured            = EXCLUDED.measured,
        has_open_recovery   = EXCLUDED.has_open_recovery,
        contactable         = EXCLUDED.contactable,
        computed_at         = NOW();

    GET DIAGNOSTICS written = ROW_COUNT;

    -- A party deleted upstream should not leave a stale bucket behind. The FK is ON
    -- DELETE CASCADE, so this only catches rows whose party stopped qualifying.
    DELETE FROM app.customer_lifecycle cl
     WHERE cl.computed_at < NOW() - INTERVAL '1 minute';

    RETURN written;
END;
$$;

COMMENT ON FUNCTION app.compute_customer_lifecycle() IS
  'Full nightly recompute of app.customer_lifecycle. Returns rows written. Scores RECENCY and VALUE only - deliberately not frequency or trend, which the gaps in app.transactions (two near-empty months inside the last twelve) would read as mass churn.';

-- Seed immediately so the table is never empty between deploy and the first
-- overnight run — an empty lifecycle table would render every customer as having no
-- bucket at all, which reads as a bug rather than as "not computed yet".
SELECT app.compute_customer_lifecycle();
