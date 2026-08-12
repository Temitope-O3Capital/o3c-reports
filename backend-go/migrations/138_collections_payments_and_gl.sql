-- 138_collections_payments_and_gl.sql
-- Phase 2 of Collections go-live: a CIF-keyed payments ledger (so collections
-- payments no longer depend on the empty native loan_applications book) plus a
-- minimal chart of accounts so GL postings resolve to named accounts, plus
-- Paystack reconciliation fields.

-- Chart of accounts for the codes the collections GL postings use.
-- (gl_accounts already has UNIQUE(code); normal_balance must be 'Dr'/'Cr'.)
INSERT INTO app.gl_accounts (code, name, class, normal_balance, currency, is_active) VALUES
  ('1001', 'Cash / Bank',          'Asset',   'Dr', 'NGN', true),
  ('1100', 'Loan Receivable',      'Asset',   'Dr', 'NGN', true),
  ('4000', 'Interest Income',      'Income',  'Cr', 'NGN', true),
  ('5200', 'Loan Loss Provision',  'Expense', 'Dr', 'NGN', true)
ON CONFLICT (code) DO NOTHING;

-- CIF-keyed collections payments ledger. assignment_id is optional (a payment may
-- be logged straight against a CIF). paystack_reference/reconciled tie a logged
-- payment to a settled Paystack transaction so the money is provable.
CREATE TABLE IF NOT EXISTS app.collection_payments (
  id                 bigserial PRIMARY KEY,
  assignment_id      bigint,
  account_cif        text NOT NULL,
  amount_kobo        bigint NOT NULL,
  payment_date       date NOT NULL DEFAULT CURRENT_DATE,
  channel            text,
  reference          text,
  paystack_reference text,
  reconciled         boolean NOT NULL DEFAULT false,
  reconciled_at      timestamptz,
  gl_reference       text,
  received_by        bigint,
  created_at         timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collection_payments_cif ON app.collection_payments (account_cif);
CREATE INDEX IF NOT EXISTS idx_collection_payments_ref ON app.collection_payments (reference);
CREATE INDEX IF NOT EXISTS idx_collection_payments_unrec ON app.collection_payments (reconciled) WHERE reconciled = false;
