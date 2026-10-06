-- Fill in the customer behind every conversion that has one, and leave the rest visibly
-- unverified.
--
-- THE GAP. app.call_center_leads.customer_cif has existed all along and was blank on ALL
-- 20,587 leads — never filled once, by any code path. So a conversion was a status with no
-- identity attached. Measured 2026-10-06, every one of the nine call-centre conversions on
-- the book had a NULL CIF, which meant:
--
--   * six real conversions, with real cards issued, were invisible as revenue — nothing
--     tied them to a customer, a card or a naira figure; and
--   * three claimed conversions with nothing behind them looked exactly the same.
--
-- Worth stating plainly because it was briefly got wrong: the 1,447 OTHER contacts sitting
-- at lead_stage 'converted' are NOT call-centre conversions. Every one is source
-- 'zoho_desk' and exactly one of them has a call-centre lead at all; their stage reads
-- converted because they ARE customers, pulled in from the customer book. The call centre's
-- own conversions are the nine, all tied to the CRC July Campaign (Lagos Individuals) 1-3.
--
-- THE RULE: EXACTLY ONE MATCH, OR NONE. It is the only thing that makes phone matching
-- usable against this book. app.customers holds 8,739 customers on a SHARED number against
-- 7,159 on a unique one, because the book is full of placeholders — 8012345678 carries
-- 4,113 customers, 8000000000 another 2,235, 0000000000 and 0812000000 dozens more. A
-- first-match-wins lookup would attach a conversion, and a person's identity, to whichever
-- of four thousand people sorted first. Requiring a single match makes every placeholder
-- resolve to nothing, which is the right answer, with no list of placeholders to maintain.
--
-- The length() = 10 guard is the other half: app.norm_phone returns '' rather than NULL for
-- anything it cannot parse, so without it a blank lead phone matches every blank customer
-- phone.
--
-- IT IS THE SAME RULE THE CODE USES. ccResolveCustomerCIF in handlers/lead_cif_resolve.go
-- runs this lookup on every future conversion. One rule, deliberately not two: a SQL twin
-- of a Go predicate that drifts is the defect this codebase keeps paying for.
--
-- WHAT IT RESOLVES, verified before writing: the six that hold a card — Umerah (00041214),
-- Ozakpo (00041226), Ojo (00041228), Oshin (00042036), Okunade (00042037) and Amos
-- (00041969) — and nothing for the three that do not: Chukwuka Orodu (5060) and
-- Oluwatomisin Owolabi (6297), whose claimed conversions have no card anywhere under their
-- number or name, and Omolaja (8880), whose agent edited her own "Converted" to "Not
-- Interested" 54 seconds later and whose stage was corrected by migration 344.
--
-- Those three are deliberately LEFT as unverified conversions rather than altered. The
-- decision taken was to put them in front of the agents who logged them — Joy Adejoh and
-- Elizabeth Nwamiro — because a customer may hold a card under a name or number we cannot
-- match, and only they know. "status = 'converted' AND customer_cif IS blank" is the whole
-- definition of an unverified conversion: it needs no column of its own, it lists exactly
-- these three today, and it clears itself the moment a CIF can be matched.
--
-- ALSO FOUND, not fixed here: Ayodeji Amos has TWO parties — the synthetic prospect
-- 'LEAD:36869' his contact points at, and his real customer party 'p:Z000000000041969'
-- with the card on it. Setting the CIF gives the conversion its identity; merging duplicate
-- parties is identity surgery that would move what Customer 360, card balances and
-- net-position all read, and it needs its own change.

BEGIN;

-- Backfill the lead side.
WITH resolved AS (
    SELECT l.id AS lead_id,
           (SELECT min(cu.cif)
              FROM app.customers cu
             WHERE length(app.norm_phone(cu.phone)) = 10
               AND app.norm_phone(cu.phone) = app.norm_phone(l.customer_phone)
             -- One match or none. min() with HAVING count(*) = 1 IS the one-match rule:
             -- the aggregate makes it a single row, and the HAVING throws the row away
             -- entirely when the number is shared, so an ambiguous phone yields NULL
             -- rather than an arbitrary winner.
             HAVING count(*) = 1) AS cif
      FROM app.call_center_leads l
     WHERE l.status = 'converted'
       AND COALESCE(btrim(l.customer_cif), '') = ''
)
UPDATE app.call_center_leads l
   SET customer_cif = r.cif,
       updated_at   = NOW()
  FROM resolved r
 WHERE l.id = r.lead_id
   AND r.cif IS NOT NULL;

-- And the contact side, which is what the Sales pipeline reads.
UPDATE app.crm_contacts c
   SET converted_cif = l.customer_cif,
       updated_at    = NOW()
  FROM app.call_center_leads l
 WHERE c.id = l.contact_id
   AND l.status = 'converted'
   AND COALESCE(btrim(l.customer_cif), '') <> ''
   AND COALESCE(btrim(c.converted_cif), '') = '';

DO $$
DECLARE
    v_filled     int;
    v_unverified int;
    v_bad        int;
BEGIN
    SELECT count(*) FILTER (WHERE COALESCE(btrim(customer_cif), '') <> ''),
           count(*) FILTER (WHERE COALESCE(btrim(customer_cif), '') = '')
      INTO v_filled, v_unverified
      FROM app.call_center_leads WHERE status = 'converted';

    IF v_filled <> 6 THEN
        RAISE EXCEPTION 'expected 6 conversions to resolve to a customer, got % — the book '
                        'has changed since 2026-10-06; re-measure before applying', v_filled;
    END IF;
    IF v_unverified <> 2 THEN
        RAISE EXCEPTION 'expected 2 unverified conversions left (Orodu and Owolabi), got %',
                        v_unverified;
    END IF;

    -- No CIF written may be one the book does not actually hold.
    SELECT count(*) INTO v_bad
      FROM app.call_center_leads l
     WHERE l.status = 'converted'
       AND COALESCE(btrim(l.customer_cif), '') <> ''
       AND NOT EXISTS (SELECT 1 FROM app.customers cu WHERE cu.cif = l.customer_cif);
    IF v_bad <> 0 THEN
        RAISE EXCEPTION '% conversions carry a CIF that is not in the customer book', v_bad;
    END IF;

    RAISE NOTICE 'migration 346: % conversions now name their customer, % left unverified '
                 'for the agents to confirm', v_filled, v_unverified;
END $$;

COMMIT;
