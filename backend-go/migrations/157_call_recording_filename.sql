-- 157_call_recording_filename.sql
--
-- Stream-on-demand call recordings from Zoho Voice.
--
-- The Zoho Voice call log carries a `call_recording.recording_filename` for every
-- answered call. We do NOT store the audio — we store only the filename, and the
-- streaming proxy (GET /api/helpdesk/calls/{id}/recording) fetches the .wav from
-- Zoho on demand with the Voice token. So this column is the pointer that says
-- "this call has audio, here's the key to fetch it".
--
-- Kept separate from the legacy `recording_url` (which was never written): a
-- filename is what the Voice recording endpoint wants
-- (/rest/json/zv/logs/recording?recording_filename=...), not a URL.
--
-- Idempotent.

ALTER TABLE app.helpdesk_calls
  ADD COLUMN IF NOT EXISTS recording_filename text;

-- Partial index: the call log's "has a recording" filter and the play-button
-- lookups only ever care about rows that actually carry one.
CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_recording_filename
  ON app.helpdesk_calls (recording_filename)
  WHERE recording_filename IS NOT NULL;
