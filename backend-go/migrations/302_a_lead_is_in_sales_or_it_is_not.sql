-- 302 — A lead is in Sales, or it is not. Say which, in one column, and stop showing
-- the sales floor 15,146 helpdesk tickets.
--
-- WHY. The Leads queue asks "who owns this lead?" and answers it with crm_contacts
-- .lead_owner_id. Measured 28 Sept 2026, that column tells Sales nothing:
--
--     lead_owner_id set          15,349 rows — every one a call_center_agent
--     lead_owner_id set to sales      0 rows
--
-- So applyLeadScope's officer branch, `lead_owner_id = me OR lead_owner_id IS NULL`,
-- resolves for a sales officer to "nothing of mine, plus everything unowned". The
-- unowned rows are not leads:
--
--     unowned, stage<>converted, not already a customer   15,146 rows
--       of which source='zoho_desk'                       15,146 rows  (100%)
--       of which source='call_centre'                          0 rows
--
-- Every row in the claimable pool is a person who emailed the help desk. Sales has
-- been prospecting the support inbox, and two of those contacts have already been
-- claimed as leads. Meanwhile the 185 leads the call centre genuinely DID hand over
-- are invisible, because a hand-off writes call_center_lead_forwards and nothing on
-- the contact itself — sales_owner_id is NULL on all 214 ledger rows, and all 214
-- contacts are still owned by the call-centre agent who forwarded them.
--
-- Migration 298 was right that the hand-off works. The ledger is the hand-off. The
-- Leads page just never read it.
--
-- WHY A SEPARATE OWNER COLUMN, rather than writing lead_owner_id when Sales claims a
-- lead. lead_owner_id is the CALL CENTRE's book: it is how an agent finds the leads
-- they are dialling, and every one of the 15,349 is theirs. If claiming a lead in
-- Sales overwrote it, the agent who sourced the lead would lose it from their own
-- queue the moment Sales picked it up, and call-centre productivity reporting would
-- silently reassign itself. The two teams work the same contact at different stages,
-- so they get one owner column each. The ledger keeps its own sales_owner_id as the
-- audit record of who accepted the hand-off; crm_contacts.sales_owner_id is current
-- state. Same split as recovery_cases.source_assignment_id — history in the ledger,
-- state on the row.
--
-- sales_entered_at is the gate, and it is what makes the pool honest: NULL means the
-- contact is not a sales lead at all and no amount of scoping will surface it. A
-- helpdesk contact can therefore never appear in the queue again, whoever owns it.
--
-- ALSO REPAIRED HERE, both integrity faults in the same book:
--   • 127 of 177 qualified leads carry no qualified_at, so time-to-qualify cannot be
--     computed and any "qualified since <date>" filter silently drops them.
--   • 10 leads reached lead_stage='converted' while status stayed 'lead'.
--
-- REVERSIBLE. The three columns are additive and rollback/rollback_302.sql drops them;
-- the two repairs record themselves as crm_lead_events rows ('qualified_at_backfilled',
-- 'status_reconciled') carrying what they changed.

-- ---------------------------------------------------------------------------
-- Part one: give Sales its own ownership, separate from the call centre's.
-- ---------------------------------------------------------------------------

ALTER TABLE app.crm_contacts
    ADD COLUMN IF NOT EXISTS sales_owner_id   bigint REFERENCES app.o3c_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS sales_entered_at timestamptz,
    ADD COLUMN IF NOT EXISTS sales_source     text;

COMMENT ON COLUMN app.crm_contacts.sales_entered_at IS
  'When this contact became a Sales lead. NULL means it is not one: helpdesk and '
  'un-forwarded call-centre contacts never appear in the Sales Leads queue, whoever '
  'owns them. This column is the gate — scope predicates narrow within it, never past it.';

COMMENT ON COLUMN app.crm_contacts.sales_owner_id IS
  'The sales officer working this lead; NULL means forwarded to Sales but unclaimed '
  '(the claimable pool). Deliberately NOT lead_owner_id, which is the call centre''s '
  'own book — both teams work the same contact at different stages and each keeps its '
  'own owner. Transfers between officers are logged to crm_lead_events(from_owner,to_owner).';

COMMENT ON COLUMN app.crm_contacts.sales_source IS
  'How the lead reached Sales: call_centre (hand-off ledger), business_dev, or self '
  '(an officer entered it). Drives the source filter on the Leads page.';

-- An owner without an entry date is nonsense — it would be a lead assigned to an officer
-- that the queue cannot show them. Stating it here as a constraint rather than trusting
-- ~20 call sites to remember means `sales_owner_id IS NOT NULL` is a SUFFICIENT gate on
-- its own, and a future write that sets an owner without admitting the lead fails loudly
-- at the insert instead of quietly creating a lead nobody can see.
ALTER TABLE app.crm_contacts
    DROP CONSTRAINT IF EXISTS crm_contacts_sales_owner_needs_entry;
ALTER TABLE app.crm_contacts
    ADD CONSTRAINT crm_contacts_sales_owner_needs_entry
    CHECK (sales_owner_id IS NULL OR sales_entered_at IS NOT NULL);

-- The two queries the Leads page runs on every load: the officer's own book, and the
-- unclaimed pool. Both are gated on sales_entered_at, so both are partial.
CREATE INDEX IF NOT EXISTS idx_crm_contacts_sales_owner
    ON app.crm_contacts (sales_owner_id, lead_stage)
    WHERE sales_entered_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_contacts_sales_pool
    ON app.crm_contacts (sales_entered_at DESC)
    WHERE sales_entered_at IS NOT NULL AND sales_owner_id IS NULL;

-- ---------------------------------------------------------------------------
-- Part two: admit the leads that were already handed over.
--
-- Only OPEN forwards. A rejected or closed hand-off is not a sales lead, and the 29
-- rejected rows must not reappear in the queue. Stamped with forwarded_at, not NOW(),
-- so a lead that has sat unclaimed since 15 September reads its true age — migration
-- 298 deliberately back-dated its 128 backlog forwards for exactly this reason, and
-- taking NOW() here would throw that away.
-- ---------------------------------------------------------------------------

WITH handed_over AS (
    SELECT f.contact_id,
           min(f.forwarded_at) AS entered_at
      FROM app.call_center_lead_forwards f
     WHERE f.contact_id IS NOT NULL
       AND f.status IN ('forwarded', 'accepted', 'assigned')
     GROUP BY f.contact_id
)
UPDATE app.crm_contacts c
   SET sales_entered_at = h.entered_at,
       sales_source     = 'call_centre',
       -- An accepted/assigned forward already names its taker; a bare 'forwarded' row
       -- does not, and stays unclaimed in the pool.
       sales_owner_id   = (SELECT f.sales_owner_id
                             FROM app.call_center_lead_forwards f
                            WHERE f.contact_id = c.id
                              AND f.status IN ('accepted', 'assigned')
                              AND f.sales_owner_id IS NOT NULL
                            ORDER BY f.forwarded_at DESC
                            LIMIT 1),
       updated_at       = NOW()
  FROM handed_over h
 WHERE h.contact_id = c.id
   AND c.sales_entered_at IS NULL;

-- ---------------------------------------------------------------------------
-- Part three: the two integrity repairs.
-- ---------------------------------------------------------------------------

-- qualified_at, from the event that actually moved the lead to qualified. Falling back
-- to stage_changed_at and then updated_at keeps the column monotonic with the timeline
-- rather than inventing NOW(), which would read as "qualified this morning" for leads
-- that qualified in August.
WITH recovered AS (
    SELECT c.id,
           COALESCE(
             (SELECT max(e.created_at) FROM app.crm_lead_events e
               WHERE e.contact_id = c.id AND e.to_stage = 'qualified'),
             c.stage_changed_at,
             c.updated_at
           ) AS at
      FROM app.crm_contacts c
     WHERE c.lead_stage = 'qualified' AND c.qualified_at IS NULL
),
fixed AS (
    UPDATE app.crm_contacts c
       SET qualified_at = r.at, updated_at = NOW()
      FROM recovered r WHERE r.id = c.id
    RETURNING c.id, c.qualified_at
)
INSERT INTO app.crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
SELECT f.id, 'qualified_at_backfilled', 'qualified', 'qualified',
       'qualified_at was never written when this lead was qualified. Recovered as '
         || to_char(f.qualified_at, 'FMDD FMMonth YYYY')
         || ' from its own stage history, so time-to-qualify reads truthfully.',
       NULL
  FROM fixed f;

-- A converted lead is a customer. 10 rows reached lead_stage='converted' with status
-- left at 'lead', so they count as open leads and as customers at the same time.
WITH reconciled AS (
    UPDATE app.crm_contacts
       SET status = 'customer', updated_at = NOW()
     WHERE lead_stage = 'converted' AND status <> 'customer'
    RETURNING id, status
)
INSERT INTO app.crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
SELECT r.id, 'status_reconciled', 'converted', 'converted',
       'Lead had converted but status stayed ''lead'', so it counted as both an open '
         || 'lead and a customer. Status set to ''customer'' to match its stage.',
       NULL
  FROM reconciled r;

-- ---------------------------------------------------------------------------
-- Guards. Each one fails the deploy rather than leaving the book half-fixed.
-- ---------------------------------------------------------------------------

DO $m302$
DECLARE
    v_helpdesk_in_pool bigint;
    v_missed_handoff   bigint;
    v_qual_no_ts       bigint;
    v_conv_not_cust    bigint;
    v_pool             bigint;
BEGIN
    -- The whole point of the migration: no helpdesk contact may be reachable as a lead.
    SELECT count(*) INTO v_helpdesk_in_pool
      FROM app.crm_contacts
     WHERE sales_entered_at IS NOT NULL AND source = 'zoho_desk';
    IF v_helpdesk_in_pool > 0 THEN
        RAISE EXCEPTION
          '302: % helpdesk contacts are still reachable as sales leads. The pool must '
          'hold only forwarded or sales-sourced leads.', v_helpdesk_in_pool;
    END IF;

    -- Every open hand-off must now be visible to Sales, or the ledger is still write-only.
    SELECT count(*) INTO v_missed_handoff
      FROM app.call_center_lead_forwards f
      JOIN app.crm_contacts c ON c.id = f.contact_id
     WHERE f.status IN ('forwarded', 'accepted', 'assigned')
       AND c.sales_entered_at IS NULL;
    IF v_missed_handoff > 0 THEN
        RAISE EXCEPTION
          '302: % open hand-offs did not reach the Sales queue.', v_missed_handoff;
    END IF;

    SELECT count(*) INTO v_qual_no_ts
      FROM app.crm_contacts WHERE lead_stage = 'qualified' AND qualified_at IS NULL;
    IF v_qual_no_ts > 0 THEN
        RAISE EXCEPTION '302: % qualified leads still have no qualified_at.', v_qual_no_ts;
    END IF;

    SELECT count(*) INTO v_conv_not_cust
      FROM app.crm_contacts WHERE lead_stage = 'converted' AND status <> 'customer';
    IF v_conv_not_cust > 0 THEN
        RAISE EXCEPTION '302: % converted leads still are not customers.', v_conv_not_cust;
    END IF;

    -- Not a failure, but the number worth reading in the deploy log: what Sales can
    -- now actually see, where before it saw 15,146 helpdesk tickets and no leads.
    SELECT count(*) INTO v_pool
      FROM app.crm_contacts WHERE sales_entered_at IS NOT NULL AND sales_owner_id IS NULL;
    RAISE NOTICE '302: Sales lead pool is now % genuinely forwarded leads.', v_pool;
END
$m302$;
