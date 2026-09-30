-- Rollback 318: put the five leads back on the organization CIF they named before.
--
-- This is the borderline case the handover doc names. 318 is a correction, so this restores a
-- state that was WRONG on purpose: ODIBO AMOS and ADESOLA ADESANYA pointed at their own
-- companies rather than at themselves. The reason it exists anyway — where rollback_316
-- deliberately does not — is that 318 rewrote DATA, not logic. The Go guard that stops new
-- rows being written this way is unaffected by running this, so reversing the data does not
-- reintroduce the defect; it only returns five rows to their prior value.
--
-- The mapping is spelled out per person rather than recomputed, because the computation 318
-- ran is exactly the thing being undone — re-deriving it would just reproduce the fix.
--
-- Guarded twice so this can never touch a row somebody has since corrected by hand: the lead
-- must still be flagged, and it must still hold the precise person CIF that 318 wrote.

UPDATE app.crm_contacts c
   SET matched_customer_cif = m.org_cif
  FROM (VALUES ('00039227', '00039226'),   -- Amos Odibo        -> Bryams Limited
               ('00039191', '00039190')    -- Adesola Adesanya  -> A Global Enterprise
       ) AS m(person_cif, org_cif)
 WHERE c.already_customer = true
   AND c.matched_customer_cif = m.person_cif;

DO $r318$
DECLARE
    v_persons int;
BEGIN
    SELECT count(*) INTO v_persons
      FROM app.crm_contacts
     WHERE already_customer = true
       AND matched_customer_cif IN ('00039227', '00039191');

    IF v_persons > 0 THEN
        RAISE EXCEPTION 'rollback_318: % lead(s) still name the person CIF', v_persons;
    END IF;

    RAISE NOTICE 'rollback_318: the five leads name their companies again.';
END
$r318$;
