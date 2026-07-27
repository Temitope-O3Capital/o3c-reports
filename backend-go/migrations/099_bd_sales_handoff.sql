-- 099: BD → Sales handoff — staff roster, assignment tracking, CRM source tagging.
--
-- Workflow: BD officer wins an employer → adds staff roster → assigns staff
-- (full company or specific individuals) to a Sales agent → CRM contacts are
-- auto-created tagged as 'bd_assigned' → BD tracks progress per assignment.

-- ── 1. Individual staff roster under an employer ─────────────────────────────
CREATE TABLE IF NOT EXISTS employer_staff (
  id            BIGSERIAL PRIMARY KEY,
  employer_id   BIGINT NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  full_name     TEXT   NOT NULL,
  job_title     TEXT,
  department    TEXT,
  phone         TEXT,
  email         TEXT,
  created_by    BIGINT REFERENCES o3c_users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_employer_staff_employer ON employer_staff(employer_id);

-- ── 2. BD → Sales assignment ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bd_assignments (
  id                        BIGSERIAL PRIMARY KEY,
  employer_id               BIGINT NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  bd_officer_id             BIGINT NOT NULL REFERENCES o3c_users(id),
  sales_agent_id            BIGINT NOT NULL REFERENCES o3c_users(id),
  assignment_type           TEXT   NOT NULL CHECK (assignment_type IN ('full_company', 'specific_staff')),
  status                    TEXT   NOT NULL DEFAULT 'assigned'
                              CHECK (status IN ('assigned', 'in_progress', 'converted', 'lost')),
  staff_count_at_assignment INTEGER NOT NULL DEFAULT 0,
  notes                     TEXT,
  assigned_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bd_assignments_employer    ON bd_assignments(employer_id);
CREATE INDEX IF NOT EXISTS idx_bd_assignments_bd_officer  ON bd_assignments(bd_officer_id);
CREATE INDEX IF NOT EXISTS idx_bd_assignments_sales_agent ON bd_assignments(sales_agent_id);

-- ── 3. Junction: which staff were included in a specific_staff assignment ─────
CREATE TABLE IF NOT EXISTS bd_assignment_staff (
  assignment_id BIGINT NOT NULL REFERENCES bd_assignments(id) ON DELETE CASCADE,
  staff_id      BIGINT NOT NULL REFERENCES employer_staff(id) ON DELETE CASCADE,
  PRIMARY KEY (assignment_id, staff_id)
);

-- ── 4. Extend crm_contacts with BD source tracking ───────────────────────────
ALTER TABLE crm_contacts
  ADD COLUMN IF NOT EXISTS source_type      TEXT DEFAULT 'self_sourced'
    CHECK (source_type IN ('bd_assigned', 'self_sourced')),
  ADD COLUMN IF NOT EXISTS bd_assignment_id BIGINT REFERENCES bd_assignments(id),
  ADD COLUMN IF NOT EXISTS employer_id      BIGINT REFERENCES employers(id);

CREATE INDEX IF NOT EXISTS idx_crm_contacts_bd_assignment ON crm_contacts(bd_assignment_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_employer      ON crm_contacts(employer_id);
