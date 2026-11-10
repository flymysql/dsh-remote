-- dsh-remote heartbeat backend (Cloudflare Workers + D1)
-- One row per (day, install pseudonym): the PRIMARY KEY is the dedupe —
-- a client may retry freely, the day count cannot inflate.
CREATE TABLE IF NOT EXISTS pings (
  day      TEXT NOT NULL,            -- YYYY-MM-DD in Asia/Shanghai
  id_hash  TEXT NOT NULL,            -- 32-hex HMAC pseudonym (never the raw id)
  version  TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  arch     TEXT NOT NULL DEFAULT '',
  node     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (day, id_hash)
);
CREATE INDEX IF NOT EXISTS idx_pings_day ON pings(day);
