CREATE TABLE vault (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CONSTRAINT valid_revision CHECK (revision > 0),
  data TEXT NOT NULL CHECK (json_valid(data))
);

CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  name TEXT GENERATED ALWAYS AS (json_extract(data, '$.name')) STORED NOT NULL UNIQUE
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  access_client_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.access_client_id')) STORED UNIQUE
);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  name TEXT GENERATED ALWAYS AS (json_extract(data, '$.name')) STORED NOT NULL UNIQUE
);

-- Keep used nonces after edits/deletes to reject reuse under the same VEK.
CREATE TABLE secret_nonces (
  vek_version INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  PRIMARY KEY (vek_version, nonce)
);

CREATE TABLE audit_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_role TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE master_nonces (
  salt TEXT NOT NULL,
  nonce TEXT NOT NULL,
  PRIMARY KEY (salt, nonce)
);

CREATE TABLE device_activity (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  last_seen_at TEXT NOT NULL
);
