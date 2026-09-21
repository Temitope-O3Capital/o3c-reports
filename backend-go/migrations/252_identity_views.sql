-- 242: a canonical contact view (single source of truth for PII) and a duplicate/overlap
-- REVIEW list — both non-destructive (no row is merged or rewritten here).
--
-- Investigation 2026-09-14: name/phone/email are copied into ~9 tables and diverge (35%
-- phone mismatch between parties and customers). Rather than destructively drop those
-- columns from a live system (which would break dozens of read paths), this establishes
-- a canonical read: v_contact_identity resolves the best contact detail per party, so
-- readers can converge on ONE answer over time. It also surfaces the identity duplicates
-- the investigation found — as a list for a human to action, never an automatic merge
-- (a shared/family phone must not silently fuse two people).

-- ── Canonical contact per party (freshest source wins) ──────────────────────────────
-- Phone/email prefer the card-feed customer record (kept current by the 15-min feed),
-- then the party's own fields, then the Udara/CBS customer master. Name stays the party's
-- canonical full_name. This is the value every module should show for a person.
CREATE OR REPLACE VIEW app.v_contact_identity AS
SELECT p.party_id,
       'CUST-' || lpad(p.party_id::text, 6, '0')                              AS cust_id,
       p.party_type,
       p.full_name,
       COALESCE(NULLIF(cust.phone,''), NULLIF(p.primary_phone,''), NULLIF(cbs.phone,'')) AS phone,
       COALESCE(NULLIF(cust.email,''), NULLIF(p.primary_email,''), NULLIF(cbs.email,'')) AS email,
       COALESCE(NULLIF(p.bvn,''), NULLIF(cbs.bvn,''))                          AS bvn,
       CASE WHEN NULLIF(cust.phone,'') IS NOT NULL THEN 'card_feed'
            WHEN NULLIF(p.primary_phone,'') IS NOT NULL THEN 'party'
            WHEN NULLIF(cbs.phone,'') IS NOT NULL THEN 'cbs' ELSE 'none' END   AS phone_source
  FROM app.parties p
  LEFT JOIN LATERAL (
        SELECT c.phone, c.email FROM app.customers c
         WHERE c.party_id = p.party_id
           AND (NULLIF(c.phone,'') IS NOT NULL OR NULLIF(c.email,'') IS NOT NULL)
         ORDER BY c.last_seen DESC NULLS LAST LIMIT 1) cust ON true
  LEFT JOIN LATERAL (
        SELECT cc.phone, cc.email, cc.bvn FROM app.cbs_customers cc
          JOIN app.cbs_links l ON l.cbs_customer_id = cc.cbs_customer_id
         WHERE l.entity_type = 'party' AND l.entity_id = p.party_id
         LIMIT 1) cbs ON true;

COMMENT ON VIEW app.v_contact_identity IS
  'One canonical contact row per party: freshest phone/email (card feed > party > CBS) and canonical name/BVN. The single value modules should show for a person, instead of each table''s own diverging copy.';

-- ── Duplicate / overlap REVIEW list (human-actioned, never auto-merged) ──────────────
CREATE OR REPLACE VIEW app.v_duplicate_identities AS
-- (a) parties that share a phone number — candidate merges (294 groups at 2026-09-14).
SELECT 'party_phone_dup'::text                              AS kind,
       app.norm_phone(p.primary_phone)                      AS match_key,
       p.party_id,
       'CUST-' || lpad(p.party_id::text, 6, '0')            AS cust_id,
       NULLIF(btrim(p.full_name),'')                        AS name,
       p.primary_phone                                      AS phone,
       p.primary_email                                      AS email,
       NULL::text                                           AS lead_ref
  FROM app.parties p
 WHERE app.norm_phone(p.primary_phone) <> ''
   AND app.norm_phone(p.primary_phone) IN (
         SELECT app.norm_phone(primary_phone) FROM app.parties
          WHERE app.norm_phone(primary_phone) <> ''
          GROUP BY 1 HAVING count(*) > 1)
UNION ALL
-- (b) leads not linked to a party whose phone matches an existing customer — candidate
--     links a human should confirm (ambiguous/shared numbers the safe backfill skipped).
SELECT 'lead_customer_overlap',
       app.norm_phone(c.phone),
       NULL::bigint,
       NULL::text,
       NULLIF(btrim(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')),''),
       c.phone,
       c.email,
       'crm_contact:' || c.id
  FROM crm_contacts c
 WHERE c.party_id IS NULL AND app.norm_phone(c.phone) <> ''
   AND EXISTS (SELECT 1 FROM app.customers cu
                WHERE cu.party_id IS NOT NULL AND app.norm_phone(cu.phone) = app.norm_phone(c.phone));

COMMENT ON VIEW app.v_duplicate_identities IS
  'Review list for identity cleanup: parties sharing a phone (candidate merges) and unlinked leads matching an existing customer by phone (candidate links). For human action only — nothing here is merged automatically, because a shared/family phone must not fuse two people.';
