-- 255: Make CCS EODTXN (Interswitch card transaction) imports idempotent.
--
-- interswitch_txns is a 1:1 view over app.ccs_transactions, whose only unique key was
-- the surrogate id (a sequence). So the import's `INSERT ... ON CONFLICT DO NOTHING`
-- could never fire, and every re-upload of a CCS Report 620 -- a normal recovery action
-- after a partial import -- duplicated every row, silently doubling volumes, counts and
-- every channel/merchant breakdown.
--
-- The natural key that identifies one transaction is the full tuple below; it is unique
-- across the whole book today. (trace_num, txn_date, branch_code) alone is NOT unique --
-- trace numbers recycle within a day/branch -- so enforcing that smaller key would drop
-- legitimate transactions instead. All seven columns are NOT NULL with '' / 0 defaults,
-- so plain NULL-distinct semantics are fine (no NULLS NOT DISTINCT needed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ccs_txn_natural
  ON app.ccs_transactions (trace_num, txn_date, branch_code, account_no, amount_kobo, sign, txn_code);
