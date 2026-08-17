-- 154: Party-level ownership.
--
-- A CIF is a card, not a person (docs/CUSTOMER_DATA_MODEL.md; the party layer in
-- migration 130). Ownership, however, is recorded per-CIF in customer_officers, so one
-- person's several CIFs could be assigned to different officers — the book fragments a
-- single relationship across desks.
--
-- We keep customer_officers keyed on CIF (every module joins on CIF, and it survives
-- feed re-ingest — see migration 127), but add a function that assigns a whole PERSON:
-- it expands a party to all its CIFs and assigns them together, in one transaction, with
-- history. customer_officers stays the single record of ownership; this just guarantees
-- a person is owned as a unit. Assigning at the party level is the intended entry point;
-- the existing per-CIF assign remains for edge cases.
--
-- Mirrors the customer_officers / customer_officer_history writes in sales_leads.go
-- convertLead. Returns the number of CIFs (re)assigned. Idempotent: a CIF already owned
-- by the target officer is skipped, so re-running assigns nothing and writes no history.

CREATE OR REPLACE FUNCTION assign_party_officer(
    p_party_id bigint,
    p_officer  bigint,
    p_by       bigint,
    p_reason   text DEFAULT 'Party-level assignment'
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    r      record;
    n      integer := 0;
    v_prev bigint;
BEGIN
    IF p_officer IS NULL THEN
        RAISE EXCEPTION 'assign_party_officer: officer id is required';
    END IF;
    FOR r IN
        SELECT cif FROM app.customers
        WHERE party_id = p_party_id AND cif IS NOT NULL AND cif <> ''
    LOOP
        SELECT officer_id INTO v_prev FROM customer_officers WHERE cif = r.cif;
        IF v_prev IS DISTINCT FROM p_officer THEN
            INSERT INTO customer_officers (cif, officer_id, assigned_by, source, note)
            VALUES (r.cif, p_officer, p_by, 'manual', p_reason)
            ON CONFLICT (cif) DO UPDATE
              SET officer_id  = EXCLUDED.officer_id,
                  assigned_by = EXCLUDED.assigned_by,
                  assigned_at = NOW(),
                  source      = 'manual',
                  note        = EXCLUDED.note;
            INSERT INTO customer_officer_history (cif, from_officer_id, to_officer_id, changed_by, reason)
            VALUES (r.cif, v_prev, p_officer, p_by, p_reason);
            n := n + 1;
        END IF;
    END LOOP;
    RETURN n;
END;
$$;
