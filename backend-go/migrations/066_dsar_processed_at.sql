-- Track when an approved erasure DSAR has been executed by the background worker.
ALTER TABLE data_subject_requests
    ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_dsar_erasure_pending
    ON data_subject_requests(request_type, status, processed_at)
    WHERE request_type = 'erasure' AND status = 'resolved' AND processed_at IS NULL;
