-- Document storage table

CREATE TABLE IF NOT EXISTS documents (
    id               BIGSERIAL PRIMARY KEY,
    entity_type      TEXT   NOT NULL,
    entity_id        BIGINT NOT NULL,
    doc_type         TEXT   NOT NULL,
    filename         TEXT   NOT NULL,
    storage_key      TEXT   NOT NULL,
    storage_provider TEXT   NOT NULL DEFAULT 'r2',
    mime_type        TEXT,
    size_bytes       BIGINT,
    uploaded_by      BIGINT NOT NULL,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_docs_entity ON documents(entity_type, entity_id);
