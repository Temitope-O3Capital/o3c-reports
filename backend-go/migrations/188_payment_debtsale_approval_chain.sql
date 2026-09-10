-- 188: Bring collection payments and debt sales into the HOP → COO → CFO approval chain.
--
-- Both flows posted their GL immediately on creation. They now enter the same multi-stage
-- chain as recovery write-offs/payments: created as 'pending_hop', advanced HOP → COO → CFO,
-- and the GL is posted only at the final (CFO) approval. These columns track that.
--
-- Status vocabulary (shared with recovery_ops.go stageProgressions):
--   pending_hop → pending_coo → pending_cfo → approved   (or → rejected)
--
-- Existing rows are historical and have ALREADY posted their GL, so they are stamped
-- 'approved' — they must never re-enter the chain or double-post.

-- ── Collection payments (app.collection_payments) ──────────────────────────────
ALTER TABLE app.collection_payments ADD COLUMN IF NOT EXISTS status           TEXT NOT NULL DEFAULT 'pending_hop';
ALTER TABLE app.collection_payments ADD COLUMN IF NOT EXISTS approved_by       BIGINT;
ALTER TABLE app.collection_payments ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMPTZ;
ALTER TABLE app.collection_payments ADD COLUMN IF NOT EXISTS rejection_reason  TEXT;

-- Everything already in the table predates the chain and has posted GL — stamp approved.
UPDATE app.collection_payments SET status = 'approved' WHERE status = 'pending_hop' AND created_at < NOW();

CREATE INDEX IF NOT EXISTS idx_collection_payments_pending
  ON app.collection_payments (status) WHERE status NOT IN ('approved','rejected');

-- ── Debt sales (public.debt_sales) ─────────────────────────────────────────────
ALTER TABLE debt_sales ADD COLUMN IF NOT EXISTS status           TEXT NOT NULL DEFAULT 'pending_hop';
ALTER TABLE debt_sales ADD COLUMN IF NOT EXISTS requested_by      BIGINT;
ALTER TABLE debt_sales ADD COLUMN IF NOT EXISTS approved_by       BIGINT;
ALTER TABLE debt_sales ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMPTZ;
ALTER TABLE debt_sales ADD COLUMN IF NOT EXISTS rejection_reason  TEXT;

UPDATE debt_sales SET status = 'approved' WHERE status = 'pending_hop' AND created_at < NOW();

CREATE INDEX IF NOT EXISTS idx_debt_sales_pending
  ON debt_sales (status) WHERE status NOT IN ('approved','rejected');
