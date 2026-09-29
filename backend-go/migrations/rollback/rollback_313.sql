-- Rollback 313: clear the forwarding agent names that were recovered from forwarded_by.
--
-- Only clears names that MATCH their forwarded_by user, which is exactly the set 313
-- wrote. A name that disagrees with the id was put there by the application after the
-- backfill and is left alone.

UPDATE app.call_center_lead_forwards f
   SET forwarded_by_name = NULL
  FROM app.o3c_users u
 WHERE u.id = f.forwarded_by
   AND f.forwarded_by_name = u.full_name;
