-- 110_helpdesk_source_tagging.sql
-- Zoho Desk migration groundwork: tag every helpdesk record with the system it
-- came from (source_system) and widen the channel vocabulary so imported Zoho
-- interactions (call, web, social, ...) satisfy the CHECK constraint.
--
-- source_system: 'o3_crm' (native, default) | 'zoho_desk' | future systems.
-- Existing rows are native, so the DEFAULT backfills them as 'o3_crm'.

-- ── Tickets ─────────────────────────────────────────────────────────────────
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS source_system TEXT NOT NULL DEFAULT 'o3_crm';

-- Widen the channel CHECK: keep the original 5, add call/mobile/web/social/chat.
DO $$ BEGIN
    ALTER TABLE helpdesk_tickets DROP CONSTRAINT IF EXISTS helpdesk_tickets_channel_check;
    ALTER TABLE helpdesk_tickets ADD CONSTRAINT helpdesk_tickets_channel_check CHECK (
        channel IN ('email','sms','whatsapp','phone','in_app','call','mobile','web','social','chat')
    );
END $$;

CREATE INDEX IF NOT EXISTS idx_tickets_source_system ON helpdesk_tickets(source_system);

-- ── Messages (conversation threads) ─────────────────────────────────────────
ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS source_system TEXT NOT NULL DEFAULT 'o3_crm';
-- Dedup key for re-runnable thread imports: Zoho thread/comment id.
ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_messages_external
    ON helpdesk_messages(external_id) WHERE external_id IS NOT NULL;

-- ── Calls ───────────────────────────────────────────────────────────────────
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS source_system TEXT NOT NULL DEFAULT 'o3_crm';
