-- 313: recover the forwarding agent's name on the 95 forwards that know their id.
--
-- call_center_lead_forwards carries both forwarded_by (the user id) and
-- forwarded_by_name (a denormalised copy for display). Every one of the 223 rows has a
-- NULL name, so "who forwarded this lead?" reads blank in the UI — including on the 95
-- rows where forwarded_by IS set and resolves to a real, present user.
--
-- The write path is NOT at fault and is not changed here: forwardLead already fills the
-- name with (SELECT full_name FROM o3c_users WHERE id=$3). These 223 rows predate it.
--
-- All 95 resolve; none points at a deleted user. The attribution recovered:
--     Elizabeth Nwamiro     47
--     Emmanuella Alozieuwa  25
--     Joy Adejoh            16
--     Olakunle Yusuf         6
--     Ramat Sadiq            1
--
-- The other 128 rows have no forwarded_by at all. They are left NULL rather than filled
-- with a guess or a placeholder: "we do not know who forwarded this" is a true statement,
-- and 'Unknown' written into the column would be indistinguishable from an agent actually
-- named that. The read path COALESCEs to the joined user name, so a name never has to be
-- stored to be shown.

UPDATE app.call_center_lead_forwards f
   SET forwarded_by_name = u.full_name,
       updated_at        = f.updated_at   -- deliberately NOT touched: this is a backfill
                                          -- of a display column, not activity on the lead
  FROM app.o3c_users u
 WHERE u.id = f.forwarded_by
   AND f.forwarded_by_name IS DISTINCT FROM u.full_name
   AND NULLIF(btrim(u.full_name), '') IS NOT NULL;

DO $m313$
DECLARE
    v_named     bigint;
    v_recover   bigint;
    v_no_id     bigint;
    v_mismatch  bigint;
BEGIN
    -- Every row that CAN be named now is.
    SELECT count(*) INTO v_recover
      FROM app.call_center_lead_forwards f
      JOIN app.o3c_users u ON u.id = f.forwarded_by
     WHERE NULLIF(btrim(u.full_name),'') IS NOT NULL
       AND f.forwarded_by_name IS NULL;
    IF v_recover > 0 THEN
        RAISE EXCEPTION '313: % forwards still have no name despite a resolvable id.', v_recover;
    END IF;

    -- No name may disagree with the id it was taken from.
    SELECT count(*) INTO v_mismatch
      FROM app.call_center_lead_forwards f
      JOIN app.o3c_users u ON u.id = f.forwarded_by
     WHERE f.forwarded_by_name IS NOT NULL
       AND f.forwarded_by_name <> u.full_name;
    IF v_mismatch > 0 THEN
        RAISE EXCEPTION '313: % forwards name someone other than their forwarded_by user.', v_mismatch;
    END IF;

    -- Rows with no id must stay unnamed — an invented forwarder is worse than a blank.
    SELECT count(*) INTO v_no_id
      FROM app.call_center_lead_forwards
     WHERE forwarded_by IS NULL AND forwarded_by_name IS NOT NULL;
    IF v_no_id > 0 THEN
        RAISE EXCEPTION '313: % forwards carry a name with no id to justify it.', v_no_id;
    END IF;

    SELECT count(*) INTO v_named
      FROM app.call_center_lead_forwards WHERE forwarded_by_name IS NOT NULL;
    RAISE NOTICE '313: % forwards now name their agent; % remain genuinely unattributed '
                 '(no forwarded_by recorded).', v_named,
                 (SELECT count(*) FROM app.call_center_lead_forwards WHERE forwarded_by IS NULL);
END
$m313$;
