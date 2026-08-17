-- A free-text note on a queue contact — used when an agent schedules a callback
-- ("ask for Mr X after 3pm", "promised to pay Friday") so the context rides with the
-- contact into the agent's queue. Nullable; existing rows keep NULL.
ALTER TABLE call_center_contacts ADD COLUMN IF NOT EXISTS notes text;
