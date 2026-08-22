CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('running', 'done')),
  result jsonb,
  claimed_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY,
  at timestamptz NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('tenant', 'staff', 'agent', 'system')),
  actor_id text,
  action text NOT NULL,
  subject_id text,
  inputs jsonb NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'error')),
  error_code text,
  error_message text
);

CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_subject ON audit_log (subject_id, at DESC);

CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  subject_id text NOT NULL,
  payload jsonb NOT NULL,
  at timestamptz NOT NULL,
  handled_at timestamptz,
  last_error text
);

CREATE INDEX IF NOT EXISTS outbox_unhandled ON outbox (at) WHERE handled_at IS NULL;

CREATE TABLE IF NOT EXISTS scheduled_work (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  run_at timestamptz NOT NULL,
  intent_key text UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  done_at timestamptz,
  last_error text
);

CREATE INDEX IF NOT EXISTS scheduled_work_due ON scheduled_work (run_at) WHERE done_at IS NULL;
