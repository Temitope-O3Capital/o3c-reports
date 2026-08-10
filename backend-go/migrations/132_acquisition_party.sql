-- 132: Add party_id to app.customer_acquisition so the Sales acquisition module
-- can count PEOPLE, not cards (a CIF is a card; one person holds many). Additive:
-- CREATE OR REPLACE appends party_id at the end, so existing SELECTs are unaffected.

CREATE OR REPLACE VIEW app.customer_acquisition AS
SELECT
    c.contact_id,
    c.cif,
    c.full_name,
    c.first_name,
    c.last_name,
    c.email,
    c.phone,
    c.state,
    c.city,
    c.account_status,
    c.source,
    c.first_seen_at,
    c.last_seen,
    c.account_created,
    a.first_account_opened,
    a.account_count,
    COALESCE(c.account_created, a.first_account_opened, c.first_seen_at) AS acquired_on,
    CASE
        WHEN c.account_created      IS NOT NULL THEN 'account_created'
        WHEN a.first_account_opened IS NOT NULL THEN 'first_account'
        WHEN c.first_seen_at        IS NOT NULL THEN 'first_seen'
        ELSE 'unknown'
    END AS acquired_on_source,
    o.officer_id,
    o.assigned_at AS officer_assigned_at,
    -- person identity: a stable per-person key (party_id when linked, else the
    -- contact_id) so acquisition reporting can COUNT DISTINCT people.
    c.party_id,
    COALESCE('p'||c.party_id, 'c'||c.contact_id) AS person_key
FROM app.customers c
LEFT JOIN (
    SELECT cif,
           MIN(opened_date) AS first_account_opened,
           COUNT(*)         AS account_count
    FROM app.accounts
    WHERE opened_date IS NOT NULL
      AND cif IS NOT NULL AND cif <> ''
      AND opened_date <= CURRENT_DATE
    GROUP BY cif
) a ON a.cif = c.cif
LEFT JOIN customer_officers o ON o.cif = c.cif
WHERE c.cif IS NOT NULL AND c.cif <> '';
