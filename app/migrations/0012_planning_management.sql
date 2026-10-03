ALTER TABLE availability_blocks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fixed_events ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE planning_state ADD COLUMN buffer_percent INTEGER NOT NULL DEFAULT 20 CHECK (buffer_percent BETWEEN 0 AND 80);
ALTER TABLE tasks ADD COLUMN planning_override_reason TEXT;
ALTER TABLE tasks ADD COLUMN reminder_lead_minutes INTEGER;
CREATE TABLE fixed_event_exceptions (
  event_id TEXT NOT NULL REFERENCES fixed_events(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0,1)),
  local_start TEXT,
  local_end TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (event_id, local_date)
);
