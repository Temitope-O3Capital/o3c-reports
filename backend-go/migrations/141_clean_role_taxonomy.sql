-- 141_clean_role_taxonomy.sql
-- Retire legacy/duplicate roles in favour of the clean Head+Agent-per-module
-- taxonomy. Remap any users still on a retired role (primary role AND secondary
-- extra_roles) so nobody is left on a role that no longer resolves to pages.

-- Primary role remap.
UPDATE o3c_users SET role = CASE role
  WHEN 'head_ops'               THEN 'coo'
  WHEN 'head_it'                THEN 'it_admin'
  WHEN 'head_sales'            THEN 'sales_head'
  WHEN 'head_collections'      THEN 'collections_head'
  WHEN 'head_recovery'         THEN 'recovery_head'
  WHEN 'head_of_reconciliation' THEN 'finance_head'
  WHEN 'internal_control_head' THEN 'compliance_head'
  WHEN 'management'            THEN 'coo'
  WHEN 'executive'            THEN 'coo'
  WHEN 'sales'                THEN 'sales_officer'
  WHEN 'collections'         THEN 'collections_agent'
  WHEN 'recovery'            THEN 'recovery_agent'
  WHEN 'cards_ops'           THEN 'cards_agent'
  WHEN 'cards_ops_head'      THEN 'cards_head'
  WHEN 'cards_ops_officer'   THEN 'cards_agent'
  WHEN 'customer_service'    THEN 'call_center_agent'
  ELSE role END
WHERE role IN ('head_ops','head_it','head_sales','head_collections','head_recovery',
  'head_of_reconciliation','internal_control_head','management','executive','sales',
  'collections','recovery','cards_ops','cards_ops_head','cards_ops_officer','customer_service');

-- Secondary roles (jsonb array) — rewrite retired slugs to their replacement.
UPDATE o3c_users SET extra_roles = (
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
    extra_roles::text,
    '"head_ops"','"coo"'),
    '"head_it"','"it_admin"'),
    '"head_sales"','"sales_head"'),
    '"head_collections"','"collections_head"'),
    '"head_recovery"','"recovery_head"'),
    '"head_of_reconciliation"','"finance_head"'),
    '"internal_control_head"','"compliance_head"'),
    '"management"','"coo"'),
    '"executive"','"coo"'),
    '"sales"','"sales_officer"'),
    '"collections"','"collections_agent"'),
    '"recovery"','"recovery_agent"'),
    '"cards_ops_head"','"cards_head"'),
    '"cards_ops_officer"','"cards_agent"'),
    '"cards_ops"','"cards_agent"'),
    '"customer_service"','"call_center_agent"')
)::jsonb
WHERE extra_roles::text ~ '(head_ops|head_it|head_sales|head_collections|head_recovery|head_of_reconciliation|internal_control_head|"management"|"executive"|"sales"|"collections"|"recovery"|cards_ops|customer_service)';
