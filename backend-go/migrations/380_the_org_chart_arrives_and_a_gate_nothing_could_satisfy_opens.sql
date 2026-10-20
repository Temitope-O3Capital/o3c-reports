-- 380: the org chart arrives, and a gate that nothing could satisfy opens.
--
-- Migration 374 added hire_date and manager_user_id and said plainly that a leave
-- request routes to "the person who should approve it". Not one of the 50 active
-- accounts had a manager, so every submission failed its own gate: the module was
-- deployed, reachable, and unusable. HR supplied the roster on 2026-10-19
-- ("Employee Information.xlsx", 53 rows: name, email, gender, department, team lead,
-- manager) and this loads it.
--
-- WHAT THE FILE SAYS, AND HOW IT MAPS.
--
--   TEAM LEAD is the person you report to day to day. That is the line manager, so it
--   becomes manager_user_id and it is where a leave request goes. Where somebody has no
--   team lead but does have a manager (Ayodeji Erinfolami), the manager is the line
--   manager; there is no sense in which such a person reports to nobody.
--
--   MANAGER is the level above the lead, and it is NOT derivable from the lead chain:
--   11 of the 50 rows disagree with "my lead's lead". Sales is the clearest case -- the
--   officers' leads report to Doris Nnakwe, whose own lead is the COO, yet HR names the
--   MD as the manager above her team. So it is stored, as escalation_manager_user_id,
--   and it answers a question the leave module could not: who may act when the person a
--   request is routed to is away. That approver is RECORDED BY HR, not invented by us,
--   which is the distinction migration 365 draws.
--
--   DEPARTMENT is loaded because the vocabulary had drifted into ten values for six
--   departments, and department is compared for equality in three places --
--   availability's mayRecordAbsenceFor, leave's department scoping, and the People
--   filter. A head in 'Sales & BD' therefore could not see an officer in 'Sales', and
--   HR's own head sat in 'Operations' while her one report sat in 'HR'. Twelve active
--   accounts had no department at all. Data access is NOT affected: report datasets are
--   reached by role, which report_access.go states explicitly ("their departments is
--   not a second list to keep in step with the roles").
--
--   GENDER is loaded because HR gave it and the staff register is the place it belongs.
--   It deliberately gates NOTHING: maternity and paternity leave are approved by a
--   human who knows the person, and an automatic refusal driven by a stored attribute
--   is wrong the moment the attribute is wrong.
--
-- WHAT THIS DOES NOT DO.
--
--   It creates no accounts and deactivates none. Nine people in the file have no account
--   at all (the whole of Information Technology among them) and six active accounts are
--   not in the file; both counts are reported by the assertions below and are the
--   business's to settle, not a migration's. Accounts are provisioned for real people
--   by a person.
--
--   hire_date stays empty: it is not in the file. app.leave_prorata_days therefore still
--   returns NULL for everyone, so a joiner's part-year entitlement remains unanswerable.
--
--   Only accounts named in the file are touched. The six that are not keep whatever
--   department they had.

ALTER TABLE app.o3c_users
  ADD COLUMN IF NOT EXISTS gender                     TEXT,
  ADD COLUMN IF NOT EXISTS escalation_manager_user_id BIGINT
    REFERENCES app.o3c_users(id) ON DELETE SET NULL;

COMMENT ON COLUMN app.o3c_users.gender IS
  'HR roster, 2026-10-19. Reported on; gates nothing.';
COMMENT ON COLUMN app.o3c_users.escalation_manager_user_id IS
  'The level above the line manager, as named by HR. Who may act when the routed approver is unavailable. NULL when HR names the same person as the line manager.';

DO $cols$
BEGIN
  -- Two values is what HR records. Widening this is a migration, which is the point:
  -- a free-text column collects F, female, M and Male and then nothing can group by it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'o3c_users_gender_vocab') THEN
    ALTER TABLE app.o3c_users
      ADD CONSTRAINT o3c_users_gender_vocab
      CHECK (gender IS NULL OR gender IN ('Female', 'Male'));
  END IF;
  -- Nobody escalates to themselves. There is deliberately no cross-column check against
  -- manager_user_id: equality is stored as NULL below, and a constraint spanning both
  -- columns would make an ordinary admin edit of the line manager fail obscurely.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'o3c_users_escalation_not_self') THEN
    ALTER TABLE app.o3c_users
      ADD CONSTRAINT o3c_users_escalation_not_self
      CHECK (escalation_manager_user_id IS NULL OR escalation_manager_user_id <> id);
  END IF;
END $cols$;

CREATE INDEX IF NOT EXISTS o3c_users_escalation_idx
  ON app.o3c_users (escalation_manager_user_id);

-- The roster, keyed on email, which matched 44 of the 53 rows exactly. Team lead and
-- manager are carried as emails resolved through the file's own NAME column, because the
-- names in those two columns do not always match the account's full_name (the file says
-- "Ikechukwu O. Okoro", the account says "Ikechukwu Okoro") while the emails are exact.
-- A lead with no account resolves to NULL and the row falls back to the manager.

WITH roster(email, gender, department, lead_email, manager_email) AS (VALUES
    ('aibrahim@o3cards.com', 'Female', 'Sales & Marketing', 'jigwilo@o3cards.com', 'dnnakwe@o3cards.com'),
    ('apinheiro@o3cards.com', 'Male', 'Operations', NULL, NULL),
    ('atinubu@o3cards.com', 'Male', 'Operations', 'knaibi@o3cards.com', 'tfalana@o3cards.com'),
    ('aatindi@o3cards.com', 'Male', 'Operations', 'knaibi@o3cards.com', 'tfalana@o3cards.com'),
    ('aomaga@o3cards.com', 'Male', 'Operations', 'knaibi@o3cards.com', 'tbalogun@o3cards.com'),
    ('aerinfolami@o3cards.com', 'Male', 'Sales & Marketing', NULL, 'dnnakwe@o3cards.com'),
    ('aodumoye@o3cards.com', 'Male', 'Finance', 'ostephen@o3cards.com', 'kadegbola@o3cards.com'),
    ('bobi@o3cards.com', 'Female', 'Sales & Marketing', 'jigwilo@o3cards.com', 'dnnakwe@o3cards.com'),
    ('cikegwuruka@o3cards.com', 'Female', 'Internal Control', 'faremu@o3cards.com', 'tfalana@o3cards.com'),
    ('cojo@o3cards.com', 'Female', 'Operations', 'knaibi@o3cards.com', 'tfalana@o3cards.com'),
    ('danthony@o3cards.com', 'Male', 'Operations', 'knaibi@o3cards.com', 'tbalogun@o3cards.com'),
    ('dnnakwe@o3cards.com', 'Female', 'Sales & Marketing', 'tfalana@o3cards.com', 'apinheiro@o3cards.com'),
    ('doluwole@o3cards.com', 'Female', 'Sales & Marketing', 'ookpara@o3cards.com', 'dnnakwe@o3cards.com'),
    ('emomoh@o3cards.com', 'Female', 'Operations', 'fatobatele@o3cards.com', 'tfalana@o3cards.com'),
    ('enwamiro@o3cards.com', 'Female', 'Operations', 'fatobatele@o3cards.com', 'tfalana@o3cards.com'),
    ('ealozieuwa@o3cards.com', 'Female', 'Operations', 'fatobatele@o3cards.com', 'tfalana@o3cards.com'),
    ('faremu@o3cards.com', 'Female', 'Internal Control', 'tfalana@o3cards.com', 'apinheiro@o3cards.com'),
    ('fpampam@o3cards.com', 'Male', 'Information Technology', NULL, NULL),
    ('fatobatele@o3cards.com', 'Male', 'Operations', 'tfalana@o3cards.com', 'apinheiro@o3cards.com'),
    ('faghanenu@o3cards.com', 'Male', 'Sales & Marketing', 'dnnakwe@o3cards.com', 'apinheiro@o3cards.com'),
    ('goyelana@o3cards.com', 'Male', 'Finance', 'ostephen@o3cards.com', 'kadegbola@o3cards.com'),
    ('gonwugbufor@o3cards.com', 'Female', 'Finance', 'ostephen@o3cards.com', 'kadegbola@o3cards.com'),
    ('hibrahim@o3cards.com', 'Female', 'Operations', 'fatobatele@o3cards.com', 'tfalana@o3cards.com'),
    ('iokoro@o3cards.com', 'Male', 'Sales & Marketing', 'dnnakwe@o3cards.com', 'apinheiro@o3cards.com'),
    ('iojiako@o3cards.com', 'Male', 'Sales & Marketing', 'dnnakwe@o3cards.com', 'apinheiro@o3cards.com'),
    ('jigwilo@o3cards.com', 'Female', 'Sales & Marketing', 'dnnakwe@o3cards.com', 'apinheiro@o3cards.com'),
    ('jsinebe@o3cards.com', 'Female', 'Human Resources', 'tbalogun@o3cards.com', 'tbalogun@o3cards.com'),
    ('jadejoh@o3cards.com', 'Female', 'Operations', 'fatobatele@o3cards.com', 'tfalana@o3cards.com'),
    ('jekomaru@o3cards.com', 'Female', 'Sales & Marketing', 'ookpara@o3cards.com', 'dnnakwe@o3cards.com'),
    ('kadegbola@o3cards.com', 'Male', 'Finance', 'apinheiro@o3cards.com', 'apinheiro@o3cards.com'),
    ('kajayi@o3cards.com', 'Male', 'Sales & Marketing', 'jigwilo@o3cards.com', 'dnnakwe@o3cards.com'),
    ('knaibi@o3cards.com', 'Male', 'Operations', 'tfalana@o3cards.com', 'apinheiro@o3cards.com'),
    ('kokoro@o3cards.com', 'Male', 'Operations', 'fatobatele@o3cards.com', 'tfalana@o3cards.com'),
    ('maisah@o3cards.com', 'Female', 'Sales & Marketing', 'ookpara@o3cards.com', 'dnnakwe@o3cards.com'),
    ('misah@o3cards.com', 'Female', 'Operations', 'soladokun@o3cards.com', 'tfalana@o3cards.com'),
    ('nnzewi@o3cards.com', 'Female', 'Sales & Marketing', 'iojiako@o3cards.com', 'dnnakwe@o3cards.com'),
    ('nebueku@o3cards.com', 'Male', 'Operations', 'oolatunji@o3cards.com', 'tfalana@o3cards.com'),
    ('ookpara@o3cards.com', 'Female', 'Sales & Marketing', 'dnnakwe@o3cards.com', 'apinheiro@o3cards.com'),
    ('oolatunji@o3cards.com', 'Male', 'Information Technology', 'tfalana@o3cards.com', 'apinheiro@o3cards.com'),
    ('oyusuf@o3cards.com', 'Male', 'Operations', 'fatobatele@o3cards.com', 'tfalana@o3cards.com'),
    ('oibrahim@o3cards.com', 'Male', 'Operations', 'knaibi@o3cards.com', 'tfalana@o3cards.com'),
    ('yakinbinu@o3cards.com', 'Female', 'Operations', 'knaibi@o3cards.com', 'tfalana@o3cards.com'),
    ('oasunomhe@o3cards.com', 'Female', 'Operations', 'fatobatele@o3cards.com', 'tfalana@o3cards.com'),
    ('ostephen@o3cards.com', 'Female', 'Finance', 'kadegbola@o3cards.com', 'apinheiro@o3cards.com'),
    ('oonifade@o3cards.com', 'Male', 'Information Technology', 'oolatunji@o3cards.com', 'tfalana@o3cards.com'),
    ('rsadiq@o3cards.com', 'Female', 'Operations', 'fatobatele@o3cards.com', 'tfalana@o3cards.com'),
    ('rorekoya@o3cards.com', 'Male', 'Sales & Marketing', 'ookpara@o3cards.com', 'dnnakwe@o3cards.com'),
    ('rlawal@o3cards.com', 'Male', 'Operations', 'knaibi@o3cards.com', 'tfalana@o3cards.com'),
    ('soladokun@o3cards.com', 'Male', 'Operations', 'tfalana@o3cards.com', 'tfalana@o3cards.com'),
    ('tfalana@o3cards.com', 'Male', 'Operations', 'apinheiro@o3cards.com', 'apinheiro@o3cards.com'),
    ('tbalogun@o3cards.com', 'Female', 'Human Resources', 'tfalana@o3cards.com', 'apinheiro@o3cards.com'),
    ('tbabatunde@o3cards.com', 'Male', 'Operations', 'tfalana@o3cards.com', 'apinheiro@o3cards.com'),
    ('uekpenyong@o3cards.com', 'Male', 'Operations', 'knaibi@o3cards.com', 'tfalana@o3cards.com')
),
resolved AS (
  SELECT u.id  AS user_id,
         r.gender,
         r.department,
         lu.id AS lead_id,
         mu.id AS manager_id
    FROM roster r
    JOIN      app.o3c_users u  ON lower(u.email)  = r.email         AND u.deleted_at  IS NULL
    LEFT JOIN app.o3c_users lu ON lower(lu.email) = r.lead_email    AND lu.deleted_at IS NULL
    LEFT JOIN app.o3c_users mu ON lower(mu.email) = r.manager_email AND mu.deleted_at IS NULL
)
UPDATE app.o3c_users u
   SET gender          = res.gender,
       department      = res.department,
       manager_user_id = COALESCE(res.lead_id, res.manager_id),
       -- Stored only when it adds a level. Where HR names the same person as both,
       -- there is one approver, not two.
       escalation_manager_user_id = CASE
         WHEN res.manager_id IS NOT NULL
          AND res.manager_id <> COALESCE(res.lead_id, res.manager_id)
         THEN res.manager_id
       END,
       updated_at = now()
  FROM resolved res
 WHERE u.id = res.user_id;

-- Three accounts carry a superseded spelling and are not in the HR file (sales officers
-- the roster does not name). Renaming a department is not assigning anybody to one, so
-- it is safe to do without HR: it is the same unit spelt the way everybody else now
-- spells it, and leaving them behind would preserve for them the exact defect this
-- closes for everyone else -- a head who cannot see their own officer.
UPDATE app.o3c_users
   SET department = CASE btrim(department)
         WHEN 'Sales'      THEN 'Sales & Marketing'
         WHEN 'Sales & BD' THEN 'Sales & Marketing'
         WHEN 'HR'         THEN 'Human Resources'
       END,
       updated_at = now()
 WHERE deleted_at IS NULL
   AND btrim(COALESCE(department, '')) IN ('Sales', 'Sales & BD', 'HR');

-- Assertions.
DO $assert$
DECLARE
  n_loaded     INT;
  n_no_manager INT;
  n_cycles     INT;
  n_split      INT;
  n_unrostered INT;
  who          TEXT;
BEGIN
  SELECT COUNT(*) INTO n_loaded
    FROM app.o3c_users
   WHERE deleted_at IS NULL AND gender IS NOT NULL AND department IS NOT NULL;
  IF n_loaded < 40 THEN
    RAISE EXCEPTION '380: only % accounts carry both a department and a gender; the email key did not match', n_loaded;
  END IF;

  -- The point of the migration. Everyone rostered may now be routed somewhere, except
  -- the one person at the top and anyone whose lead and manager both have no account.
  SELECT COUNT(*), string_agg(full_name, ', ' ORDER BY full_name)
    INTO n_no_manager, who
    FROM app.o3c_users
   WHERE is_active AND deleted_at IS NULL
     AND manager_user_id IS NULL
     AND gender IS NOT NULL;            -- gender is non-null exactly for rostered rows
  IF n_no_manager > 1 THEN
    RAISE EXCEPTION '380: % rostered active staff still have no line manager (%)', n_no_manager, who;
  END IF;
  RAISE NOTICE '380: rostered active staff with no line manager: % (%)', n_no_manager, COALESCE(who, 'none');

  -- A cycle makes every recursive query over the org chart hang. 374's trigger walks the
  -- chain as it stood row by row, so a bulk UPDATE could in principle slip one past it;
  -- this checks the finished state.
  WITH RECURSIVE chain(root, node, hops) AS (
      SELECT id, manager_user_id, 1 FROM app.o3c_users WHERE manager_user_id IS NOT NULL
      UNION ALL
      SELECT c.root, u.manager_user_id, c.hops + 1
        FROM chain c JOIN app.o3c_users u ON u.id = c.node
       WHERE u.manager_user_id IS NOT NULL AND c.hops < 32
  )
  SELECT COUNT(*) INTO n_cycles FROM chain WHERE node = root;
  IF n_cycles > 0 THEN
    RAISE EXCEPTION '380: the loaded org chart contains % reporting cycle(s)', n_cycles;
  END IF;

  -- The defect the department load exists to close: a head and their own officer sitting
  -- in differently-spelt versions of the same department.
  SELECT COUNT(*) INTO n_split
    FROM app.o3c_users
   WHERE deleted_at IS NULL AND btrim(COALESCE(department, '')) IN ('Sales', 'Sales & BD', 'HR');
  IF n_split > 0 THEN
    RAISE EXCEPTION '380: % accounts remain in a superseded department spelling', n_split;
  END IF;

  -- Every manager named must itself be a live account, or a request routes into a hole.
  IF EXISTS (
      SELECT 1 FROM app.o3c_users u
        JOIN app.o3c_users m ON m.id = u.manager_user_id
       WHERE u.is_active AND u.deleted_at IS NULL
         AND (m.deleted_at IS NOT NULL OR NOT m.is_active)
  ) THEN
    RAISE EXCEPTION '380: an active member of staff is routed to an account that is not live';
  END IF;

  -- Reported, not enforced: who the file and the account list disagree about.
  SELECT COUNT(*), string_agg(full_name, ', ' ORDER BY full_name)
    INTO n_unrostered, who
    FROM app.o3c_users
   WHERE is_active AND deleted_at IS NULL AND gender IS NULL;
  RAISE NOTICE '380: active accounts not named in the HR file: % (%)', n_unrostered, COALESCE(who, 'none');
END $assert$;
