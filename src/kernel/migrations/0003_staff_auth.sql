-- First module-owned tables. The kernel owns the runner, not the schema.

CREATE TABLE IF NOT EXISTS staff_operators (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE, -- pii
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- token_hash, not token: the browser holds the only copy of the secret, so
-- reading this table gives an attacker nothing to ride.
CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash text PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES staff_operators (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS staff_sessions_expires_at
  ON staff_sessions (expires_at);

-- One row per failed login. Counted over a rolling window, cleared on success.
CREATE TABLE IF NOT EXISTS staff_login_attempts (
  id uuid PRIMARY KEY,
  email text NOT NULL, -- pii
  at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS staff_login_attempts_email_at
  ON staff_login_attempts (email, at DESC);
