-- Anonymous usage events. Lifetime retention (D1), unlike Analytics Engine's 90 days.
-- No IPs, no device keys, no filenames. daily_id is a random UUID that rotates every UTC day.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  ev          TEXT    NOT NULL,
  outcome     TEXT,
  error_code  TEXT,
  files       INTEGER,
  bytes       INTEGER,
  ms          INTEGER,
  type        TEXT,
  channels    INTEGER,
  chunk_size  INTEGER,
  connect_ms  INTEGER,
  discover_ms INTEGER,
  ok          INTEGER,
  browser     TEXT    NOT NULL,
  os          TEXT    NOT NULL,
  device_kind TEXT    NOT NULL,
  daily_id    TEXT    NOT NULL,
  app_version TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ev_ts ON events (ev, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
