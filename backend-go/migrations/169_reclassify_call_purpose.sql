-- 169_reclassify_call_purpose.sql
--
-- Re-files calls that were labelled COLLECTIONS for no better reason than the
-- customer existing.
--
-- The import rule read: if this number belongs to a customer, it is collections.
-- Being a customer is not a debt. Measured on one day: 67 calls filed as
-- collections, of which only 6 had an actual collections assignment and 19 were
-- agents working a marketing lead list. The rule never consulted
-- call_center_leads at all, so a lead who also happened to hold a card was filed
-- as a debt chase.
--
-- That matters beyond tidiness: purpose drives the disposition list an agent is
-- offered, which queue the call belongs to, and the collections reporting. A
-- marketing call filed as collections is counted as debt-chasing work.
--
-- Order is by strength of evidence, matching the importer:
--   inbound                        -> support
--   on an active lead list         -> marketing   (what the agent is working)
--   has a collections assignment   -> collections (a real debt)
--   a known customer, no debt      -> support     (a service call)
--   otherwise                      -> marketing
--
-- Only rows the importer produced are touched. A purpose an agent chose by hand
-- in the Log-a-Call form is their judgement about their own call and is left
-- alone.
--
-- Idempotent: re-running lands on the same answer.

UPDATE app.helpdesk_calls h
   SET purpose = v.want
  FROM (
    SELECT c.id,
           CASE
             WHEN c.direction = 'inbound' THEN 'support'
             WHEN EXISTS (SELECT 1 FROM app.call_center_leads d
                           WHERE app.norm_phone(d.customer_phone) = app.norm_phone(c.customer_phone)
                             AND app.norm_phone(c.customer_phone) <> '') THEN 'marketing'
             WHEN EXISTS (SELECT 1 FROM app.collection_assignments ca
                           WHERE NULLIF(c.customer_cif,'') IS NOT NULL
                             AND ca.cif_number = c.customer_cif) THEN 'collections'
             WHEN EXISTS (SELECT 1 FROM app.customers m
                           WHERE app.norm_phone(m.phone) = app.norm_phone(c.customer_phone)
                             AND app.norm_phone(c.customer_phone) <> '') THEN 'support'
             ELSE 'marketing'
           END AS want
      FROM app.helpdesk_calls c
     WHERE c.source_system = 'zoho_desk'
  ) v
 WHERE h.id = v.id AND h.purpose IS DISTINCT FROM v.want;
