-- Undo 376: remove the canonical-state function.
--
-- 376 is purely additive -- it creates one STABLE function and changes no data, no
-- column and no row -- so there is nothing to restore and this rollback cannot lose
-- anything.
--
-- WHAT IT DOES NOT UNDO, AND THE ORDER THAT MATTERS: the lead_handoffs export column
-- "State" calls app.canon_state, so dropping the function while that binary is serving
-- makes every Lead Hand-offs report fail with "function app.canon_state(text) does not
-- exist". Roll the BINARY back first, then run this. On its own it is not a safe
-- forward step.
--
-- Note also that app.sales_hub_for_state still carries its own inline copy of these
-- folding rules and is untouched by either direction, so hub lookups keep working.

BEGIN;

DROP FUNCTION IF EXISTS app.canon_state(text);

COMMIT;
